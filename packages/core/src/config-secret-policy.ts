import { createHash } from "node:crypto";
import { ConfigError, stableSerialize } from "./config-format.js";
import { deepMergeAnalysis } from "./config-compiler.js";
import { LITERAL_SECRET_FIELDS, SEALED_LITERAL_SECRET_FIELDS } from "./config-secret-sealing.js";
import { isPlainObject } from "./utils.js";

export interface ConfigSecretGrant {
  readonly env: string;
  /** Config path tokens; collection entries use stable names, never indices. */
  readonly target: readonly string[];
  /** Exact destination context reported by collectConfigSecretReferences. */
  readonly destinations: Readonly<Record<string, unknown>>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DESTINATION_KEYS = new Set(["kind", "base_url", "url", "endpoint", "endpoint_url", "http_proxy", "repository_url",
  "port", "host", "trigger", "owner", "repo", "project_id", "projectId", "aws_region", "vertex_project", "vertex_location", "region", "aws_endpoint", "azure_endpoint",
  "webhook_url_env", "endpoint_url_env", "app_id", "client_id", "installation_id"]);

function channelTriggers(channel: Record<string, unknown>, triggers: readonly unknown[]): Record<string, unknown>[] {
  const kind = String(channel.kind ?? "");
  const kinds = kind.startsWith("gitea_") ? ["gitea", "forgejo"] : kind.startsWith("github_") ? ["github"] : kind.startsWith("gitlab_") ? ["gitlab"] : [];
  return triggers.filter((t): t is Record<string, unknown> => isPlainObject(t) && kinds.includes(String(t.kind)) && (channel.trigger === undefined || t.name === channel.trigger));
}

function destinationContext(owner: Record<string, unknown>, triggers: readonly unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(owner)) {
    if (DESTINATION_KEYS.has(key)) result[key] = value;
    if ((key === "app" || key === "searxng") && isPlainObject(value)) result[key] = destinationContext(value, []);
  }
  if (typeof owner.trigger === "string") {
    const trigger = triggers.find(t => isPlainObject(t) && t.name === owner.trigger);
    if (isPlainObject(trigger)) result.trigger_destination = destinationContext(trigger, []);
  }
  return result;
}

/** Includes inherited outbound credentials, which must not follow a changed URL. */
export function collectConfigSecretReferences(config: unknown): readonly ConfigSecretGrant[] {
  if (!isPlainObject(config)) return [];
  const triggers = Array.isArray(config.triggers) ? config.triggers : [];
  const references: ConfigSecretGrant[] = [];
  const visit = (value: unknown, path: string[], owner: Record<string, unknown>): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const entity = isPlainObject(entry) ? entry : undefined;
        visit(entry, [...path, entity ? String(entity.id ?? entity.name ?? entity.alias ?? index) : String(index)],
          entity ?? owner);
      });
      return;
    }
    if (!isPlainObject(value)) return;
    if (path[0] === "llm" && path[1] === "model_chain" && path.length === 4 && isPlainObject(value.overrides)) {
      const llm = isPlainObject(config.llm) ? config.llm : {};
      const providerId = value.provider;
      const provider = Array.isArray(llm.providers) ? llm.providers.find(p => isPlainObject(p) && p.id === providerId) : undefined;
      if (isPlainObject(provider)) {
        const effective = { ...provider, ...value.overrides };
        const changedDestination = Object.keys(value.overrides).some(key => DESTINATION_KEYS.has(key));
        for (const [key, env] of Object.entries(effective)) if (key.endsWith("_env") && typeof env === "string" && changedDestination
          && value.overrides[key] === undefined) references.push({ env, target: [...path, "overrides", key], destinations: destinationContext(effective, triggers) });
        visit(value.overrides, [...path, "overrides"], effective);
        // Other entry fields cannot contain credential references.
        return;
      }
    }
    if (path[0] === "outputs" && path[1] === "channels" && path.length === 3) {
      if (value.trigger === undefined) {
        // The runtime selects the accepting event's compatible trigger. An
        // unpinned channel can therefore inherit any compatible profile, not
        // just the first one. Authorize every endpoint/credential combination.
        const candidates = channelTriggers(value, triggers);
        if (candidates.length > 0) {
          for (const trigger of candidates) {
            const variant = { ...value, trigger: trigger.name };
            visit(variant, path, variant);
          }
          return;
        }
      }
    }
    if (!isPlainObject(value)) return;
    const credentialMap = path.at(-1) === "credentials" && path.includes("web_search");
    for (const [key, child] of Object.entries(value)) {
      if (path.length === 0 && ["config_sources", "admin", "server", "storage"].includes(key)) continue;
      if ((key.endsWith("_env") || credentialMap) && typeof child === "string") {
        if (!ENV_NAME.test(child)) throw new ConfigError("invalid_secret_env", "Invalid environment reference.", { path: [...path, key] });
        references.push({ env: child, target: [...path, key], destinations: destinationContext(owner, triggers) });
      }
      const newOwner = key === "web_search" || key === "source_repo" || key === "notify_feishu";
      visit(child, [...path, key], newOwner && isPlainObject(child) ? child : owner);
    }
    // Channel-level endpoints can override a file trigger endpoint while
    // silently inheriting that trigger's token. Treat that as a distinct use.
    if (path[0] === "outputs" && path[1] === "channels" && path.length === 3 && value.token_env === undefined && value.token === undefined && typeof value.trigger === "string") {
      const trigger = triggers.find(t => isPlainObject(t) && t.name === value.trigger);
      if (isPlainObject(trigger) && typeof trigger.token_env === "string") {
        references.push({ env: trigger.token_env, target: [...path, "token_env"], destinations: destinationContext(value, triggers) });
      } else if (isPlainObject(trigger) && isPlainObject(trigger.app) && typeof trigger.app.private_key_env === "string") {
        references.push({ env: trigger.app.private_key_env, target: [...path, "private_key_env"], destinations: destinationContext(value, triggers) });
      }
    }
  };
  visit(config, [], config);
  // Validate the same inherited search destination used by the agent builder.
  // A new layer with no destination change can keep its inherited credential;
  // changing the destination requires a grant at that layer's stable path.
  const search = (layer: unknown): Record<string, unknown> => isPlainObject(layer) && isPlainObject(layer.agent)
    && isPlainObject(layer.agent.web_search) ? layer.agent.web_search : {};
  const layerSearch = (base: Record<string, unknown>, layer: unknown, path: string[]): Record<string, unknown> => {
    const override = search(layer);
    const effective = deepMergeAnalysis(base, override) as Record<string, unknown>;
    const prefix = [...path, "agent", "web_search"];
    for (let index = references.length - 1; index >= 0; index--) {
      if (prefix.every((token, at) => references[index]?.target[at] === token)) references.splice(index, 1);
    }
    const inheritedCredentials = isPlainObject(base.credentials) ? base.credentials : {};
    const explicitCredentials = isPlainObject(override.credentials) ? override.credentials : {};
    const credentials = isPlainObject(effective.credentials) ? effective.credentials : {};
    const destinations = destinationContext(effective, []);
    const changedDestination = stableSerialize(destinations) !== stableSerialize(destinationContext(base, []));
    for (const [key, env] of Object.entries(credentials)) {
      if (typeof env === "string" && (explicitCredentials[key] !== undefined || inheritedCredentials[key] !== env || changedDestination)) {
        references.push({ env, target: [...prefix, "credentials", key], destinations });
      }
    }
    return effective;
  };
  const workspaces = isPlainObject(config.workspaces) ? config.workspaces : {};
  const defaults = layerSearch(search(config), workspaces.defaults, ["workspaces", "defaults"]);
  const instances = isPlainObject(workspaces.instances) ? workspaces.instances : {};
  const resolved = new Map<string, Record<string, unknown>>();
  for (const [name, instance] of Object.entries(instances)) {
    resolved.set(name, layerSearch(defaults, instance, ["workspaces", "instances", name]));
  }
  const routing = isPlainObject(config.routing) ? config.routing : {};
  if (Array.isArray(routing.rules)) for (const [index, rule] of routing.rules.entries()) {
    if (isPlainObject(rule)) layerSearch(resolved.get(String(rule.workspace)) ?? defaults, rule.analysis,
      ["routing", "rules", String(rule.id ?? rule.name ?? index), "analysis"]);
  }
  return references;
}

/**
 * Rejects unregistered credential material before it reaches revisions,
 * snapshots or audits. Registered literal fields (LITERAL_SECRET_FIELDS —
 * `api_key`, `token`, `webhook_secret`, …) are allowed: they are sealed at
 * every persistence boundary and masked on read APIs. Credential-bearing
 * URLs, credential-file paths and arbitrary credential-named keys remain
 * rejected — secrets outside the registry still require an env reference.
 */
export function assertNoConfigCredentialLiterals(value: unknown, path: readonly string[] = []): void {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.username || url.password || [...url.searchParams.keys()].some(key => /^(token|api[_-]?key|secret|password|sig|signature)$/i.test(key))) {
        throw new ConfigError("invalid_secret_env", "Credential-bearing URLs require a deployment-owned reference.", { path });
      }
    } catch (error) { if (error instanceof ConfigError) throw error; }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const searchCredential = path.at(-1) === "credentials" && path.includes("web_search");
    if (searchCredential && typeof child === "string" && ENV_NAME.test(child)) continue;
    // web_search credentials { value } entries are registered literals.
    if (searchCredential && isPlainObject(child) && typeof child.value === "string") continue;
    // Registered literal fields are sealed/masked downstream; recurse so a
    // credential-bearing URL inside them is still rejected.
    if (LITERAL_SECRET_FIELDS.has(key)) {
      assertNoConfigCredentialLiterals(child, [...path, key]);
      continue;
    }
    if (key === "private_key_path" || /Env$/.test(key) ||
        (!key.endsWith("_env") && /(^|[_-])(api[_-]?key|token|secret|password|authorization|cookie|credential)($|[_-])/i.test(key) &&
         child !== undefined && child !== null && typeof child !== "number" && typeof child !== "boolean")) {
      throw new ConfigError("invalid_secret_env", "Unregistered credential fields and credential-file paths cannot be stored in database configuration; use a registered literal field or an environment reference.", { path: [...path, key] });
    }
    assertNoConfigCredentialLiterals(child, [...path, key]);
  }
}

/** Pure, fail-closed service boundary shared by publish, validate and restore. */
export function assertConfigSecretPolicy(file: unknown, database: unknown, effective: unknown): void {
  assertNoConfigCredentialLiterals(database);
  const explicit = isPlainObject(file) && isPlainObject(file.config_sources) && Array.isArray(file.config_sources.secret_refs)
    ? file.config_sources.secret_refs as ConfigSecretGrant[] : [];
  const grants = [...collectConfigSecretReferences(file), ...explicit];
  const signatures = new Set(grants.map(grant => stableSerialize(grant)));
  for (const reference of collectConfigSecretReferences(effective)) {
    if (!signatures.has(stableSerialize(reference))) {
      throw new ConfigError("invalid_secret_env", "Environment reference or destination is not authorized by config_sources.secret_refs.", { path: reference.target });
    }
  }
  // File-owned literals have the same destination boundary as file env refs.
  // Project them to private fingerprints to reuse the inheritance traversal;
  // these names never reach env lookup, public grants, snapshots or responses.
  const literalGrants = collectConfigSecretReferences(projectLiteralReferences(file));
  const literalNames = new Set(literalGrants.filter(grant => grant.env.startsWith("AICR_LITERAL_")).map(grant => grant.env));
  const literalSignatures = new Set(literalGrants.map(grant => stableSerialize(grant)));
  for (const reference of collectConfigSecretReferences(projectLiteralReferences(effective))) {
    if (literalNames.has(reference.env) && !literalSignatures.has(stableSerialize(reference))) {
      throw new ConfigError("invalid_secret_env", "A file-owned literal credential cannot be reused at a different path or destination; configure a credential for that destination.", { path: reference.target });
    }
  }
}

function projectLiteralReferences(root: unknown, path: readonly string[] = []): unknown {
  if (Array.isArray(root)) return root.map(entry => projectLiteralReferences(entry, path));
  if (!isPlainObject(root)) return root;
  const fingerprint = (value: string): string => `AICR_LITERAL_${createHash("sha256").update(value).digest("hex")}`;
  return Object.fromEntries(Object.entries(root).map(([key, value]) => {
    if (path.at(-1) === "credentials" && path.includes("web_search") && isPlainObject(value) && typeof value.value === "string") {
      return [key, fingerprint(value.value)];
    }
    if (SEALED_LITERAL_SECRET_FIELDS.has(key) && typeof value === "string") return [`${key}_env`, fingerprint(value)];
    return [key, projectLiteralReferences(value, [...path, key])];
  }));
}
