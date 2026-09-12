/**
 * Runtime workspace resolution (spec §5.1/§5.2/§5.5, P1b).
 *
 * Turns an authenticated source description (trigger profile + extracted
 * source fields) into a workspace resolution: a legacy `source_repo`
 * binding, a `match`-rule hit with its binding, an ambiguity report, or a
 * strict no-match. Resolution is a pure function of the validated config and
 * the source values, so the receive path (webhook translation) and the
 * execution path (directory derivation, auto-commit adapters) always agree
 * without persisting paths.
 */

import { createHash } from "node:crypto";

import { CONFIG_MATCHER_LIMITS, ConfigError, computeWorkspaceInstanceId } from "./config-format.js";
import { WORK_PATH_TEMPLATE_VARIABLES, type PathTemplateVariables } from "./config-path-template.js";
import {
  buildWorkspaceBinding,
  DEFAULT_WORK_PATH_TEMPLATE,
  type ValidatedWorkspaceDefinition,
  type WorkspaceBinding,
  type WorkspaceDefinitionInput,
} from "./config-workspace.js";

// ---------------------------------------------------------------------------
// Source values + trigger profiles
// ---------------------------------------------------------------------------

/**
 * Source fields available for rule evaluation. Every value comes from the
 * authenticated payload or the configured trigger profile — never from
 * unverified metadata (spec §5.2). `branch`/`ref` are null when the event
 * kind has none (issue events, tag pushes).
 */
export interface WorkspaceSourceValues {
  readonly vcs: string;
  readonly repo_ref: string;
  readonly repository?: string | null | undefined;
  readonly namespace?: string | null | undefined;
  readonly project_key?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly ref?: string | null | undefined;
}

export interface WorkspaceTriggerProfile {
  readonly enabled?: boolean | undefined;
  readonly name: string;
  readonly kind: string;
  readonly base_url?: string | undefined;
  readonly repository_url?: string | undefined;
  readonly port?: string | undefined;
}

/** Maps a trigger kind to the `source.vcs` match value (spec §5.3). */
export function triggerKindToVcs(kind: string): string | undefined {
  switch (kind) {
    case "github":
    case "gitea":
    case "forgejo":
    case "gitlab":
      return "git";
    case "p4":
      return "p4";
    case "svn":
      return "svn";
    default:
      return undefined;
  }
}

const DEFAULT_TRIGGER_HOSTS: Readonly<Record<string, string>> = {
  github: "github.com",
  gitlab: "gitlab.com",
};

/**
 * Normalized trigger host (lowercase, no credentials/path). Undefined when
 * the profile has no usable base_url — self-hosted kinds should configure
 * one; the project key stays deterministic either way.
 */
export function triggerProfileHost(profile: WorkspaceTriggerProfile): string | undefined {
  const endpoint = profile.base_url ?? (profile.kind === "svn" ? profile.repository_url : undefined) ??
    (profile.kind === "p4" && profile.port ? `p4://${profile.port.replace(/^(?:ssl|tcp)[46]?:/u, "")}` : undefined);
  if (endpoint !== undefined && endpoint.length > 0) {
    try {
      const host = new URL(endpoint).host;
      if (host.length > 0) {
        return host.toLowerCase();
      }
    } catch {
      // Fall through to the provider default.
    }
  }
  return DEFAULT_TRIGGER_HOSTS[profile.kind];
}

/**
 * Stable canonical project key (spec §5.5). Git keys contain the source
 * instance (host) and the target repository; host is case-folded, repo_ref
 * keeps its original case (identity never rewrites case, spec §5.1).
 */
export function canonicalProjectKey(input: {
  readonly vcs: string;
  readonly host?: string | undefined;
  readonly repoRef: string;
}): string {
  return `${input.vcs}:${input.host ?? ""}:${input.repoRef}`;
}

/** Splits a repo_ref into namespace/repository at the last `/`. */
export function deriveRepositoryParts(repoRef: string): {
  readonly repository: string;
  readonly namespace?: string | undefined;
} {
  const slash = repoRef.lastIndexOf("/");
  if (slash < 0) {
    return { repository: repoRef };
  }
  return { repository: repoRef.slice(slash + 1), namespace: repoRef.slice(0, slash) };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type WorkspaceResolution =
  | { readonly kind: "legacy_binding"; readonly definitionId: string }
  | {
      readonly kind: "match";
      readonly definitionId: string;
      readonly ruleId?: string | undefined;
      readonly binding: WorkspaceBinding;
      readonly variables: PathTemplateVariables;
      readonly provenance?: Readonly<Record<string, "verified_payload" | "configured" | "vcs_verified" | "unavailable" | "conflicted">> | undefined;
    }
  | { readonly kind: "ambiguous"; readonly definitionIds: readonly string[] }
  | { readonly kind: "no_match" }
  | { readonly kind: "unbound" }
  | {
      readonly kind: "route_denied";
      readonly definitionId: string;
      readonly reason: "unknown_definition" | "source_not_permitted";
    };

export interface WorkspaceResolutionConfigInput {
  readonly triggers: readonly WorkspaceTriggerProfile[];
  readonly workspaces: {
    readonly instances: Readonly<Record<string, WorkspaceDefinitionInput>>;
  };
}

export interface WorkspaceResolutionEventContext {
  /** Whitelisted provider facts from authenticated payloads or verified VCS metadata. */
  readonly provider_fields?: Readonly<Record<string, string | null>> | undefined;
  readonly default_branch?: string | null | undefined;
  /** Base (target) branch of a PR/MR; null for push/issue events. */
  readonly base_branch?: string | null | undefined;
  /** Head branch of a PR/MR; equals the push branch for push events. */
  readonly head_branch?: string | null | undefined;
  /**
   * Fork PR evidence: head repository full name and owner when the head
   * lives outside the target repository; null for same-repo PRs and every
   * non-PR event (V02 — identity stays with the target repository).
   */
  readonly head_repository?: string | null | undefined;
  readonly head_owner?: string | null | undefined;
  /**
   * Trusted manual-entry fields (authenticated request/CLI structured
   * input, spec §5.3). Never populated from host cwd, arbitrary env, or
   * free-form argument text by adapters.
   */
  readonly manual?: {
    readonly request_id?: string | null | undefined;
    readonly requested_workspace?: string | null | undefined;
    readonly requested_by?: string | null | undefined;
  } | undefined;
}

/** Explicit route selection from a trusted manual entry (W08/W09). */
export interface WorkspaceResolutionRequest {
  /** Definition the operator explicitly selected. */
  readonly workspaceId: string;
}

/**
 * Builds the template variables for one matched project (spec §5.3 extracted
 * subset). Re-derivable from the trigger profile plus the ReviewEvent
 * (repoRef, branch, targetBranch), which is what the execution path does —
 * keeping receive-time and execution-time rendering identical.
 */
export function buildWorkspaceResolutionVariables(input: {
  readonly definitionId: string;
  readonly instanceId: string;
  readonly trigger: WorkspaceTriggerProfile;
  readonly source: WorkspaceSourceValues;
  readonly event?: WorkspaceResolutionEventContext | undefined;
}): PathTemplateVariables {
  const { repository, namespace } = input.source.repository !== undefined && input.source.repository !== null
    ? { repository: input.source.repository, namespace: input.source.namespace ?? undefined }
    : input.source.vcs === "git" ? deriveRepositoryParts(input.source.repo_ref) : { repository: null, namespace: undefined };
  const host = triggerProfileHost(input.trigger) ?? null;
  const branch = input.source.branch ?? null;
  const ref = input.source.ref ?? null;
  const baseBranch = input.event?.base_branch ?? null;
  const headBranch = input.event?.head_branch ?? (input.event?.base_branch != null ? branch : null);
  const headRepository = input.event?.head_repository ?? null;
  const headOwner = input.event?.head_owner ?? null;

  const gitNamespace = {
    owner: namespace ?? null,
    repository,
    full_name: input.source.repo_ref,
    namespace: namespace ?? null,
    branch,
    ref,
    base_branch: baseBranch,
    head_branch: headBranch,
    head_repository: headRepository,
    head_owner: headOwner,
    default_branch: input.event?.default_branch ?? null,
  };

  const variables: Record<string, unknown> = {
    trigger: { name: input.trigger.name, kind: input.trigger.kind, host },
    source: {
      vcs: input.source.vcs,
      repo_ref: input.source.repo_ref,
      repository,
      namespace: namespace ?? null,
      project_key:
        input.source.project_key ??
        canonicalProjectKey({ vcs: input.source.vcs, host: host ?? undefined, repoRef: input.source.repo_ref }),
      branch,
      ref,
    },
    workspace: { id: input.definitionId, instance_id: input.instanceId },
    ...(input.source.vcs === "git" ? { git: gitNamespace } : {}),
    // Trusted manual-entry fields only (spec §5.3); absent on every
    // non-manual admission and null when the request omitted them.
    manual: {
      request_id: input.event?.manual?.request_id ?? null,
      requested_workspace: input.event?.manual?.requested_workspace ?? null,
      requested_by: input.event?.manual?.requested_by ?? null,
    },
  };

  switch (input.trigger.kind) {
    case "github":
    case "gitea":
    case "forgejo":
      variables[input.trigger.kind] = {
        owner: namespace ?? null,
        repository,
        full_name: input.source.repo_ref,
        branch,
        base_branch: baseBranch,
        head_branch: headBranch,
        repository_id: input.event?.provider_fields?.repository_id ?? null,
        pull_number: input.event?.provider_fields?.pull_number ?? null,
        issue_number: input.event?.provider_fields?.issue_number ?? null,
        ...(input.trigger.kind === "github" ? { installation_id: input.event?.provider_fields?.installation_id ?? null } : {}),
      };
      break;
    case "gitlab":
      variables.gitlab = {
        namespace: namespace ?? null,
        project: repository,
        path_with_namespace: input.source.repo_ref,
        branch,
        source_branch: input.event?.head_branch ?? branch,
        target_branch: baseBranch,
        ...Object.fromEntries(["project_id", "source_project_id", "target_project_id", "merge_request_iid", "issue_iid"]
          .map((field) => [field, input.event?.provider_fields?.[field] ?? null])),
      };
      break;
    case "p4":
    case "svn": {
      const fields = input.trigger.kind === "p4"
        ? ["server", "depot", "depot_path", "stream", "stream_name", "client", "service_client", "user", "change", "scope"]
        : ["repository_url", "repository_root", "repository_uuid", "repository", "project_path", "branch", "revision", "author"];
      variables[input.trigger.kind] = Object.fromEntries(fields.map((field) => [field, input.event?.provider_fields?.[field] ?? null]));
      break;
    }
    default:
      break;
  }

  return variables;
}

type CompiledMatchRule = ValidatedWorkspaceDefinition["rules"][number];

/**
 * Resolves the workspace for one authenticated source. Precedence preserves
 * the legacy contract exactly:
 *
 * 1. A definition whose `source_repo.trigger` equals the trigger wins
 *    (first entry order, as `resolveWorkspaceIdFromTrigger` did).
 * 2. Otherwise match rules referencing this trigger are evaluated (OR-ed,
 *    rule-internal conditions AND-ed). Exactly one hit produces a binding;
 *    several hits report `ambiguous` with the conflicting definition ids —
 *    never a lexicographic pick (W07). Zero hits on a match-referenced
 *    trigger is `no_match` (never the first workspace, spec §6).
 * 3. A trigger no definition references stays `unbound`; the caller applies
 *    the legacy first-instance/"default" fallback.
 */
export function resolveWorkspaceForSource(
  config: WorkspaceResolutionConfigInput,
  validated: ReadonlyMap<string, ValidatedWorkspaceDefinition>,
  triggerName: string,
  source: WorkspaceSourceValues,
  event?: WorkspaceResolutionEventContext,
  request?: WorkspaceResolutionRequest,
): WorkspaceResolution {
  const requestedId = request?.workspaceId;
  if (config.triggers.find((entry) => entry.name === triggerName)?.enabled === false) return { kind: "no_match" };
  for (const [definitionId, definition] of Object.entries(config.workspaces.instances)) {
    if (definition.source_repo?.trigger === triggerName) {
      if (definition.enabled === false) return { kind: "no_match" };
      // An explicit route never widens a legacy binding (W09): only the
      // bound definition itself may be selected.
      if (requestedId !== undefined && requestedId !== definitionId) {
        return { kind: "route_denied", definitionId: requestedId, reason: "source_not_permitted" };
      }
      return { kind: "legacy_binding", definitionId };
    }
  }

  const trigger = config.triggers.find((entry) => entry.name === triggerName);
  if (trigger === undefined) {
    return { kind: "unbound" };
  }

  if (requestedId !== undefined && config.workspaces.instances[requestedId] === undefined) {
    return { kind: "route_denied", definitionId: requestedId, reason: "unknown_definition" };
  }

  let triggerMatchReferenced = false;
  const hits: { readonly definition: ValidatedWorkspaceDefinition; readonly rule: CompiledMatchRule }[] = [];
  const parts = source.vcs === "git" ? deriveRepositoryParts(source.repo_ref) : undefined;
  const sourceValues: Record<string, string | null | undefined> = {
    vcs: source.vcs,
    repo_ref: source.repo_ref,
    repository: source.repository ?? parts?.repository ?? null,
    namespace: source.namespace ?? parts?.namespace ?? null,
    project_key: source.project_key ?? canonicalProjectKey({ vcs: source.vcs, host: triggerProfileHost(trigger), repoRef: source.repo_ref }),
    branch: source.branch ?? null,
    ref: source.ref ?? null,
  };
  for (const [field, value] of Object.entries(sourceValues)) {
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > CONFIG_MATCHER_LIMITS.maxFieldBytes) {
      throw new ConfigError("matcher_invalid", `Source field ${field} exceeds the ${CONFIG_MATCHER_LIMITS.maxFieldBytes}-byte budget.`);
    }
  }

  for (const validatedDefinition of validated.values()) {
    for (const rule of validatedDefinition.rules) {
      const triggerApplies = rule.triggers === undefined || rule.triggers.includes(triggerName);
      if (!triggerApplies) {
        continue;
      }
      triggerMatchReferenced = true;
      if (config.workspaces.instances[validatedDefinition.definitionId]?.enabled === false) continue;
      const ruleMatches = rule.sourceTest === undefined || rule.sourceTest(sourceValues);
      if (ruleMatches) {
        hits.push({ definition: validatedDefinition, rule });
        break; // One hit per definition is enough (rules are OR-ed).
      }
    }
  }

  if (requestedId !== undefined) {
    const requestedHit = hits.find((hit) => hit.definition.definitionId === requestedId);
    if (requestedHit === undefined) {
      // The explicit route is outside what the rules permit for this source
      // (W09): a trusted request still cannot widen the trigger's scope.
      return triggerMatchReferenced
        ? { kind: "route_denied", definitionId: requestedId, reason: "source_not_permitted" }
        : { kind: "unbound" };
    }
    // W08: the explicit route selects one permitted candidate; it settles
    // an otherwise ambiguous rule set deterministically.
    return buildMatchResolution(config, trigger, requestedHit.definition, requestedHit.rule, source, event);
  }

  if (hits.length === 0) {
    return triggerMatchReferenced ? { kind: "no_match" } : { kind: "unbound" };
  }
  if (hits.length > 1) {
    const ids = hits.map((hit) => hit.definition.definitionId).sort();
    return { kind: "ambiguous", definitionIds: ids };
  }

  const hit = hits[0]!;
  return buildMatchResolution(config, trigger, hit.definition, hit.rule, source, event);
}

/** Shared match-result construction (project key, instance id, binding). */
function buildMatchResolution(
  config: WorkspaceResolutionConfigInput,
  trigger: WorkspaceTriggerProfile,
  definition: ValidatedWorkspaceDefinition,
  rule: CompiledMatchRule,
  source: WorkspaceSourceValues,
  event: WorkspaceResolutionEventContext | undefined,
): WorkspaceResolution {
  const hit = { definition, rule };
  const projectKey = source.project_key ?? canonicalProjectKey({
    vcs: source.vcs,
    host: triggerProfileHost(trigger),
    repoRef: source.repo_ref,
  });
  const instanceId = computeWorkspaceInstanceId({
    definitionId: hit.definition.definitionId,
    triggerName: trigger.name,
    vcs: source.vcs,
    canonicalProjectKey: projectKey,
  });
  const variables = buildWorkspaceResolutionVariables({
    definitionId: hit.definition.definitionId,
    instanceId,
    trigger,
    source,
    event,
  });
  const binding = buildWorkspaceBinding(
    {
      definitionId: hit.definition.definitionId,
      triggerName: trigger.name,
      vcs: source.vcs,
      canonicalProjectKey: projectKey,
      workPathTemplate:
        hit.definition.workPathTemplate === DEFAULT_WORK_PATH_TEMPLATE
          ? undefined
          : hit.definition.workPathTemplate,
    },
    variables,
  );

  return {
    kind: "match",
    definitionId: hit.definition.definitionId,
    ruleId: hit.rule.id ?? undefined,
    binding,
    variables,
    provenance: Object.fromEntries(WORK_PATH_TEMPLATE_VARIABLES.filter((entry) => {
      const [namespace] = entry.path.split(".");
      return Object.hasOwn(variables, namespace!);
    }).map((entry) => {
      const [namespace, field] = entry.path.split(".");
      const value = (variables[namespace!] as Record<string, unknown>)[field!];
      return [entry.path, value == null ? "unavailable" : entry.acquisitionStage];
    })),
  };
}

// ---------------------------------------------------------------------------
// Definition identity helpers
// ---------------------------------------------------------------------------

/** True when any match rule could apply to this trigger (strict-resolution scope). */
export function isTriggerMatchReferenced(
  validated: ReadonlyMap<string, ValidatedWorkspaceDefinition>,
  triggerName: string,
): boolean {
  for (const definition of validated.values()) {
    for (const rule of definition.rules) {
      if (rule.triggers === undefined || rule.triggers.includes(triggerName)) {
        return true;
      }
    }
  }
  return false;
}

/** Stable digest of the resolved definition set (diagnostics/tests). */
export function workspaceResolutionDigest(
  validated: ReadonlyMap<string, ValidatedWorkspaceDefinition>,
): string {
  const parts: string[] = [];
  for (const definition of [...validated.values()].sort((a, b) => a.definitionId.localeCompare(b.definitionId))) {
    parts.push(
      `${definition.definitionId}=${definition.rules
        .map((rule) => `${rule.id ?? ""}(${(rule.triggers ?? []).join(",")})`)
        .join("|")}@${definition.workPathTemplate}`,
    );
  }
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

/** Error raised when resolution is ambiguous (mapped to `ambiguous_route`). */
export function workspaceAmbiguityError(definitionIds: readonly string[], path?: readonly string[]): ConfigError {
  return new ConfigError(
    "ambiguous_route",
    `Source matches multiple workspace definitions with equal precedence: ${definitionIds.join(", ")}. Add an explicit routing rule or narrow the match rules.`,
    path !== undefined ? { path } : undefined,
  );
}
