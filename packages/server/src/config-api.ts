/**
 * Config admin API (architecture §3.16, P5). Mounted at `/api/admin/config`, guarded
 * by the admin Bearer session surface, and fully decoupled from the stats
 * store: admin auth plus a config store backend are the only prerequisites.
 *
 * Contract highlights:
 * - Every write path goes through prepareConfigPublication/publishConfig:
 *   server-side Zod validation, file locks, capability checks, reference
 *   integrity, CAS commit, audit, and the runtime generation install hook.
 *   Nothing here trusts client-side validation.
 * - Field-level errors surface as `{ error: code, message, entity?, path? }`
 *   (A20); revision races surface as 409 revision_conflict (A10); a commit
 *   whose activation failed surfaces committed_activating, never a fake
 *   rollback (A12/H14).
 * - Responses, diffs, audits, and errors are scrubbed; environment variable
 *   references are names only — the API never returns or accepts env values
 *   (A05/A06).
 * - Request bodies are size-capped (A08) and strictly typed DTOs.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  CHANNEL_KINDS,
  CONFIG_ENTITY_COLLECTIONS,
  CONFIG_FIELD_INVENTORY,
  DATABASE_ENTITY_COLLECTION_KEYS,
  DATABASE_KIND_COLLECTION,
  ConfigError,
  WORK_PATH_TEMPLATE_VARIABLES,
  assertNoConfigCredentialLiterals,
  buildConfigUiSpec,
  buildEffectiveConfigView,
  collectConfigSecretReferences,
  getConfigOperation,
  isConfigError,
  mergeConfigSources,
  parseConfigPath,
  parseEffectiveConfig,
  prepareConfigPublication,
  prepareConfigRestore,
  previewConfigChangeset,
  previewConfigRoute,
  publishConfig,
  scrubText,
  SEALED_LITERAL_SECRET_FIELDS,
  validateDatabaseDocument,
  validateConfigNamespace,
  type AppConfigInput,
  type ConfigChangesetOperation,
  type ConfigEntityKind,
  type ConfigFieldView,
  type ConfigRoutePreviewEvent,
  type ConfigSecretSealing,
  type ConfigStore,
  type ConfigUiOption,
  type ConfigUiSpec,
  type DatabaseConfigDocument,
} from "@aicr/core";
import { createAdminAuthMiddleware, type AdminAuthConfig, type AdminSessionStore } from "./admin-auth.js";
import { MODEL_PROVIDER_PRESETS } from "@aicr/llm";
import type { RuntimeConfigManager } from "./runtime-config.js";

/** Mirrors the config source cap: one MiB JSON bodies are already generous. */
const CONFIG_API_MAX_BODY_BYTES = 1024 * 1024;
const CONFIG_API_DEFAULT_LIMIT = 50;
const CONFIG_API_MAX_LIMIT = 200;

export interface ConfigApiOptions {
  readonly store: ConfigStore;
  readonly adminAuth: AdminAuthConfig;
  readonly sessionStore: AdminSessionStore;
  readonly namespace: string;
  /** Raw (legacy-converted) file document; may be empty when unknown. */
  readonly fileConfig: AppConfigInput;
  /** SHA-256 of the exact file bytes; empty when unknown. */
  readonly fileDigest: string;
  readonly formatVersion?: number | undefined;
  /** Runtime generation installer; when absent, publishes skip local install. */
  readonly manager?: RuntimeConfigManager | undefined;
  readonly envLookup?: ((name: string) => string | undefined) | undefined;
  readonly maxBodyBytes?: number | undefined;
  /**
   * Envelope encryption for literal credentials: publications are sealed
   * before they reach the store. Publishing literal credentials without it
   * fails closed with secrets_key_missing.
   */
  readonly secretSealing?: ConfigSecretSealing | undefined;
}

// ---------------------------------------------------------------------------
// DTOs (strict; prototype keys rejected at the boundary)
// ---------------------------------------------------------------------------

const PATH_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROTOTYPE_TOKENS = new Set(["__proto__", "prototype", "constructor"]);

const pathTokenSchema = z.string().min(1).max(128).refine(
  (token) => PATH_TOKEN_PATTERN.test(token) && !PROTOTYPE_TOKENS.has(token.toLowerCase()),
  { message: "path token must match [A-Za-z0-9][A-Za-z0-9._-]* and must not be a prototype key" },
);

const collectionSchema = z.enum(DATABASE_ENTITY_COLLECTION_KEYS);

const recordSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  note: z.string().max(1024).optional(),
  value: z.unknown().refine(value => value !== undefined, "A value is required."),
}).strict();

const changesetOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), collection: collectionSchema, record: recordSchema }).strict(),
  z.object({
    op: z.literal("update"),
    collection: collectionSchema,
    recordId: z.string().min(1).max(128),
    value: z.unknown().refine(value => value !== undefined, "A value is required."),
    note: z.string().max(1024).optional(),
  }).strict(),
  z.object({ op: z.literal("delete"), collection: collectionSchema, recordId: z.string().min(1).max(128) }).strict(),
  z.object({
    op: z.literal("rename"),
    collection: collectionSchema,
    recordId: z.string().min(1).max(128),
    newName: z.string().min(1).max(128),
  }).strict(),
  z.object({
    op: z.literal("set-enabled"),
    collection: collectionSchema,
    recordId: z.string().min(1).max(128),
    enabled: z.boolean(),
  }).strict(),
  z.object({ op: z.literal("set"), path: z.array(pathTokenSchema).min(1).max(16), value: z.unknown().refine(value => value !== undefined, "A value is required.") }).strict(),
  z.object({ op: z.literal("unset"), path: z.array(pathTokenSchema).min(1).max(16) }).strict(),
]);

const operationIdSchema = z.string().min(8).max(128);

const changesetRequestSchema = z.object({
  baseRevision: z.number().int().safe().positive().nullable(),
  fileDigest: z.string().regex(/^[0-9a-f]{64}$/),
  operationId: operationIdSchema,
  operations: z.array(changesetOperationSchema).min(1).max(200),
}).strict();

const validateRequestSchema = z.object({
  fileDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  operations: z.array(changesetOperationSchema).min(1).max(200),
}).strict();

const restoreRequestSchema = z.object({
  baseRevision: z.number().int().safe().positive().nullable(),
  fileDigest: z.string().regex(/^[0-9a-f]{64}$/),
  operationId: operationIdSchema,
}).strict();

const routePreviewEventSchema: z.ZodType<ConfigRoutePreviewEvent> = z.object({
  triggerName: z.string().min(1).max(128),
  targetKind: z.enum(["pull_request", "push", "commit", "issue", "manual", "scheduled"]),
  repoRef: z.string().min(1).max(512).optional(),
  branch: z.string().min(1).max(512).optional(),
  ref: z.string().min(1).max(512).optional(),
  baseBranch: z.string().min(1).max(512).optional(),
  headBranch: z.string().min(1).max(512).optional(),
  defaultBranch: z.string().min(1).max(512).optional(),
  providerFields: z.record(z.string().max(4096).nullable()).optional(),
}).strict();

const previewRouteRequestSchema = z.object({
  event: routePreviewEventSchema,
  draft: changesetRequestSchema.omit({ operationId: true }).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonBodyResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly response: Response;
    };

async function readJsonBody<T>(c: Context, schema: z.ZodType<T>, maxBodyBytes: number): Promise<JsonBodyResult<T>> {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    return { ok: false, response: c.json({ error: "request_too_large", message: `Request body exceeds ${maxBodyBytes} bytes.` }, 413) };
  }
  let parsed: unknown;
  const reader = c.req.raw.body?.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBodyBytes) {
          void reader.cancel().catch(() => {});
          return { ok: false, response: c.json({ error: "request_too_large", message: "Request body exceeds the byte limit." }, 413) };
        }
        chunks.push(value);
      }
    }
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assertJsonShape(parsed);
  } catch (error) {
    if (isConfigError(error)) return { ok: false, response: configErrorResponse(c, error) };
    return { ok: false, response: c.json({ error: "invalid_request", message: "Request body must be valid JSON." }, 400) };
  } finally {
    reader?.releaseLock();
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      response: c.json({
        error: "invalid_request",
        message: "Request body failed DTO validation.",
        issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: "Invalid field value." })),
      }, 400),
    };
  }
  return { ok: true, value: result.data };
}

function assertJsonShape(value: unknown, depth = 0): void {
  if (depth > 64) throw new ConfigError("config_path_invalid", "JSON nesting exceeds 64 levels.");
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PROTOTYPE_TOKENS.has(key.toLowerCase())) throw new ConfigError("prototype_key", "Prototype keys are not allowed.");
    assertJsonShape(child, depth + 1);
  }
}

/** New writes store credential references; legacy literal values remain readable only through redaction. */
function assertNoInlineCredentials(value: unknown): void {
  const visit = (entry: unknown): void => {
    if (typeof entry === "string" && /<redacted>|%3credacted%3e/iu.test(entry)) {
      throw new ConfigError("invalid_field_type", "Replace or clear redacted values before saving; placeholders cannot be persisted.");
    }
    if (entry !== null && typeof entry === "object") Object.values(entry).forEach(visit);
  };
  visit(value);
  assertNoConfigCredentialLiterals(value);
}

function scrubMessage(message: string): string {
  return scrubText(message).text;
}

function configErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof z.ZodError) {
    return c.json({
      error: "invalid_request",
      message: "DTO validation failed.",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: "Invalid field value." })),
    }, 400);
  }
  if (isConfigError(error)) {
    return c.json({
      error: error.code,
      code: error.code,
      message: error.code === "store_unavailable" ? "Configuration store is unavailable." : scrubMessage(error.message),
      ...(error.path !== undefined ? { path: error.path } : {}),
      ...(error.entity !== undefined ? { entity: error.entity } : {}),
    }, error.code === "store_unavailable" ? 503 : error.code === "file_config_mismatch" ? 409 : error.code === "entity_not_found" ? 404 : 400);
  }
  return c.json({ error: "internal_error", message: "Configuration operation failed." }, 500);
}

function limitOf(c: Context): number {
  const query = c.req.query("limit");
  if (query === undefined) return CONFIG_API_DEFAULT_LIMIT;
  const raw = Number(query);
  if (!Number.isSafeInteger(raw) || raw < 1) throw new ConfigError("invalid_field_type", "limit must be a positive integer.");
  return Math.min(raw, CONFIG_API_MAX_LIMIT);
}

const SENSITIVE_NAME_SUFFIX_FREE = /(api[_-]?key|token|secret|password|credential)/i;

/** Query keys whose values are credentials even under an innocuous field name
 * (superset of the write policy in assertNoConfigCredentialLiterals). */
const SENSITIVE_URL_QUERY_KEY = /(token|api[_-]?key|secret|password|credential|sig|signature|auth|(^|[-_])key([-_]|$))/i;

/**
 * Registered literal credential fields the name regex misses (architecture
 * §3.15 literal secrets). Their values are sealed at rest; read APIs never
 * expose even the ciphertext.
 */
const SENSITIVE_EXACT_KEYS: ReadonlySet<string> = new Set([
  ...SEALED_LITERAL_SECRET_FIELDS,
  "password_hash",
]);

function isSensitiveKey(key: string): boolean {
  return (SENSITIVE_NAME_SUFFIX_FREE.test(key) || SENSITIVE_EXACT_KEYS.has(key)
    || /^(authorization|proxy-authorization|cookie|set-cookie|headers)$/i.test(key)) && !key.endsWith("_env");
}

/**
 * Deep response redaction (A05): config surfaces carry env var *names* by
 * contract, but passthrough values could hold literal credentials. Keys that
 * name secrets (without the `_env` reference suffix) have their values
 * replaced; hashes/ids/urls survive because they do not match the name rule.
 */
function redactDeep(value: unknown, ancestors: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, ancestors));
  if (typeof value === "string") {
    // URL userinfo and credential-named query parameters are secrets even
    // when the surrounding key is merely base_url/url. Non-credential query
    // values (tenant, api-version, …) stay visible so the redacted view
    // round-trips through the editor without a save trap.
    try {
      const url = new URL(value);
      if (url.username) url.username = "<redacted>";
      if (url.password) url.password = "<redacted>";
      for (const key of new Set(url.searchParams.keys())) {
        if (SENSITIVE_URL_QUERY_KEY.test(key)) url.searchParams.set(key, "<redacted>");
      }
      if (url.hash) url.hash = "<redacted>";
      return scrubMessage(url.toString());
    } catch { return scrubMessage(value); }
  }
  if (value === null || typeof value !== "object") return value;
  const credentialMap = ancestors.at(-1) === "credentials" && ancestors.includes("web_search");
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PROTOTYPE_TOKENS.has(key.toLowerCase())) continue;
    if (key === "credentials" && ancestors.includes("web_search")) {
      output[key] = redactDeep(entry, [...ancestors, key]);
      continue;
    }
    // web_search credentials { value } literals mask like any other secret;
    // plain string entries are env var names and stay visible.
    if (credentialMap && entry !== null && typeof entry === "object" && !Array.isArray(entry)
        && typeof (entry as Record<string, unknown>).value === "string") {
      output[key] = { ...(entry as Record<string, unknown>), value: "<redacted>" };
      continue;
    }
    if (isSensitiveKey(key) && typeof entry !== "number" && typeof entry !== "boolean") {
      output[key] = "<redacted>";
    } else {
      output[key] = redactDeep(entry, [...ancestors, key]);
    }
  }
  return output;
}

/**
 * Fields-view redaction (A05): redactDeep matches on object keys, but field
 * values sit under `effectiveValue`/`value`, so sensitivity is derived from
 * the config path segments instead — any secret-named segment (without the
 * `_env` reference suffix) masks the whole subtree value, mirroring
 * redactDeep's key rule. Numbers/booleans survive, as in redactDeep.
 */
function redactFieldsView(fields: readonly ConfigFieldView[]): readonly ConfigFieldView[] {
  return fields.map((field) => {
    const segments = parseConfigPath(field.path);
    const sensitive = segments.some((segment) => isSensitiveKey(segment) && !(segment === "credentials" && segments.includes("web_search")))
      || (segments.at(-1) === "value" && segments.at(-2) !== undefined
        && segments.includes("credentials") && segments.includes("web_search"));
    if (!sensitive) return field;
    const mask = (value: unknown): unknown =>
      typeof value === "number" || typeof value === "boolean" ? value : "<redacted>";
    return {
      ...field,
      effectiveValue: mask(field.effectiveValue),
      overriddenValues: field.overriddenValues.map((entry) => ({ ...entry, value: mask(entry.value) })),
    };
  });
}

function revisionMetadata(revision: {
  readonly namespace: string;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly formatVersion: number;
  readonly contentHash: string;
  readonly fileDigest: string | null;
  readonly createdAt: number;
  readonly actor: string;
  readonly operationId: string;
}): Record<string, unknown> {
  return {
    namespace: revision.namespace,
    revision: revision.revision,
    parentRevision: revision.parentRevision,
    formatVersion: revision.formatVersion,
    contentHash: revision.contentHash,
    fileDigest: revision.fileDigest,
    createdAt: new Date(revision.createdAt).toISOString(),
    actor: revision.actor,
    operationId: revision.operationId,
  };
}

// ---------------------------------------------------------------------------
// Effective config loading (GET / and preview-route)
// ---------------------------------------------------------------------------

async function loadConfigView(options: ConfigApiOptions) {
  const head = await options.store.readHead(options.namespace);
  const record = head === null ? null : await options.store.readRevision(options.namespace, head.activeRevision);
  if (head !== null && record === null) throw new ConfigError("entity_not_found", "The active configuration revision is unreadable.");
  if (record && record.fileDigest !== options.fileDigest) throw new ConfigError("file_config_mismatch", "The active revision uses a different file configuration.");
  const database = record ? validateDatabaseDocument(record.document, record.formatVersion) : {};
  const merged = mergeConfigSources({ file: options.fileConfig, database, formatVersion: record?.formatVersion ?? 2 });
  const effective = parseEffectiveConfig(merged.document, options.formatVersion ?? 2);
  return { head, database, merged, effective };
}

function secretEnvStatus(config: unknown, envLookup: ((name: string) => string | undefined) | undefined, file: AppConfigInput): { name: string; present: boolean }[] {
  const allowed = new Set([...collectConfigSecretReferences(file).map(reference => reference.env),
    ...((file.config_sources as { secret_refs?: readonly { env: string }[] } | undefined)?.secret_refs ?? []).map(reference => reference.env)]);
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key.endsWith("_env") && typeof entry === "string" && entry.length > 0) {
        if (allowed.has(entry)) names.add(entry);
      }
      visit(entry);
    }
  };
  visit(config);
  for (const reference of collectConfigSecretReferences(config)) if (allowed.has(reference.env)) names.add(reference.env);
  if (envLookup === undefined) {
    return [...names].sort().map((name) => ({ name, present: false }));
  }
  return [...names].sort().map((name) => ({ name, present: envLookup(name) !== undefined }));
}


/** Config-shaped overlay lookup: entity ids at a schema path (bounded). */
function entityIdsAtPath(overlay: unknown, path: readonly string[], idField: string | null): string[] {
  let current: unknown = overlay;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return [];
    current = (current as Record<string, unknown>)[segment];
  }
  if (Array.isArray(current)) {
    return current
      .map((entry) => (entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)[idField ?? "id"] : undefined))
      .filter((value): value is string => typeof value === "string");
  }
  if (current !== null && typeof current === "object") {
    return Object.keys(current as Record<string, unknown>);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Options sources (GET /options/:source, architecture §3.16)
// ---------------------------------------------------------------------------

/** Lazily built UI spec: derived from the inventory, never per-request. */
let cachedConfigUiSpec: ConfigUiSpec | undefined;

function configUiSpec(): ConfigUiSpec {
  cachedConfigUiSpec ??= buildConfigUiSpec();
  return cachedConfigUiSpec;
}

/**
 * Entity id options: file entities plus every database record. Disabled
 * database records stay selectable-but-flagged so editors can reference an
 * entity before re-enabling it; records shadowed by a file entity are
 * effective, hence not disabled.
 */
async function entityOptions(options: ConfigApiOptions, kind: ConfigEntityKind): Promise<ConfigUiOption[]> {
  const collection = CONFIG_ENTITY_COLLECTIONS[kind];
  const { database } = await loadConfigView(options);
  const fileIds = entityIdsAtPath(options.fileConfig, collection.path, collection.idField);
  const byId = new Map<string, ConfigUiOption>();
  for (const id of fileIds) byId.set(id, { value: id, label: id });
  for (const record of Object.values(database.entities?.[DATABASE_KIND_COLLECTION[kind]] ?? {})) {
    byId.set(record.name, {
      value: record.name,
      label: record.name,
      ...(!record.enabled && !fileIds.includes(record.name) ? { disabled: true } : {}),
    });
  }
  return [...byId.values()].sort((left, right) => left.value.localeCompare(right.value));
}

/** Secret env options carry names only; absent envs are disabled, never valued (A05/A06). */
async function secretEnvOptions(options: ConfigApiOptions): Promise<ConfigUiOption[]> {
  const names = new Set(collectConfigSecretReferences(options.fileConfig).map(reference => reference.env));
  for (const reference of (options.fileConfig.config_sources as { secret_refs?: readonly { env: string }[] } | undefined)?.secret_refs ?? []) names.add(reference.env);
  return [...names].sort().map(name => ({ value: name, label: name,
    ...(options.envLookup?.(name) === undefined ? { disabled: true } : {}) }));
}

function pathTemplateVariableOptions(): ConfigUiOption[] {
  return WORK_PATH_TEMPLATE_VARIABLES.map((entry) => ({
    value: entry.path,
    label: entry.availability === "extracted" ? entry.path : `${entry.path} (${entry.availability})`,
    ...(entry.availability !== "extracted" ? { disabled: true } : {
      insertText: entry.nullable ? `{{segment (default ${entry.path} "unknown")}}` : `{{segment ${entry.path}}}`,
    }),
  }));
}

const CONFIG_OPTIONS_SOURCES: Readonly<Record<string, (options: ConfigApiOptions) => Promise<ConfigUiOption[]> | ConfigUiOption[]>> = {
  providers: (options) => entityOptions(options, "provider"),
  model_groups: (options) => entityOptions(options, "model_group"),
  triggers: (options) => entityOptions(options, "trigger"),
  channels: (options) => entityOptions(options, "channel"),
  workspaces: (options) => entityOptions(options, "workspace"),
  secret_envs: secretEnvOptions,
  path_template_variables: pathTemplateVariableOptions,
};

// ---------------------------------------------------------------------------
// API factory
// ---------------------------------------------------------------------------

export function createConfigApi(options: ConfigApiOptions): Hono {
  validateConfigNamespace(options.namespace);
  const maxBodyBytes = options.maxBodyBytes ?? CONFIG_API_MAX_BODY_BYTES;
  const authMiddleware = createAdminAuthMiddleware({
    config: options.adminAuth,
    sessions: options.sessionStore,
  });
  const app = new Hono();
  app.use("*", authMiddleware);
  app.use("*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      // CSRF guard: reject cross-site fetches outright, and when an Origin
      // header is present require its host to match the request Host header.
      // The Host header (not c.req.url) is the reliable reference: the server
      // fabricates req.url from its bind address, which need not carry the
      // port the browser actually dialed.
      const origin = c.req.header("origin");
      let originHost: string | undefined;
      if (origin !== undefined) {
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = undefined;
        }
      }
      // Host header first (browsers always send one); fall back to the
      // request URL host for non-browser/test contexts that omit it.
      let requestHost = c.req.header("host");
      if (requestHost === undefined) {
        try {
          requestHost = new URL(c.req.url).host;
        } catch {
          requestHost = undefined;
        }
      }
      if (
        c.req.header("sec-fetch-site") === "cross-site"
        || (origin !== undefined && (originHost === undefined || requestHost === undefined || originHost !== requestHost))
      ) {
        return c.json({ error: "forbidden_origin", message: "Cross-origin configuration writes are not allowed." }, 403);
      }
    }
    await next();
  });

  const fileDigestOf = (requestDigest: string | undefined): string => {
    if (!/^[0-9a-f]{64}$/.test(options.fileDigest) || (requestDigest !== undefined && requestDigest !== options.fileDigest)) {
      throw new ConfigError("file_config_mismatch", "The request file digest differs from this server's file configuration.");
    }
    return options.fileDigest;
  };

  // ------------------------------------------------------------------ GET /
  app.get("/", async (c) => {
    try {
      const { head, database, merged, effective } = await loadConfigView(options);
      const limit = limitOf(c);
      const offset = Number(c.req.query("offset") ?? "0");
      if (!Number.isSafeInteger(offset) || offset < 0) throw new ConfigError("invalid_field_type", "offset must be a nonnegative integer.");
      const collections: Record<string, unknown> = {};
      const globals = structuredClone(effective) as Record<string, unknown>;
      for (const kind of Object.values(CONFIG_ENTITY_COLLECTIONS)) {
        if (kind.since > (options.formatVersion ?? 2)) continue;
        const valueAt = (source: unknown, name: string): unknown => {
          let value: unknown = source;
          for (const segment of kind.path) value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined;
          return Array.isArray(value)
            ? value.find((entry: Record<string, unknown>) => entry[kind.idField ?? "id"] === name)
            : value !== null && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
        };
        const fileNames = entityIdsAtPath(options.fileConfig, kind.path, kind.idField);
        const records = [
          ...fileNames.map((name) => ({ id: name, name, source: "file", readonly: true, enabled: true,
            value: valueAt(options.fileConfig, name), effectiveValue: valueAt(effective, name), shadowedByFile: false })),
          ...Object.values(database.entities?.[DATABASE_KIND_COLLECTION[kind.kind]] ?? {}).map((record) => ({
            ...record, source: "database", readonly: false, shadowedByFile: fileNames.includes(record.name),
            effectiveValue: valueAt(effective, record.name),
          })),
        ];
        collections[kind.kind] = { count: records.length, records: records.slice(offset, offset + limit),
          nextOffset: offset + limit < records.length ? offset + limit : null };
        let parent: Record<string, unknown> | undefined = globals;
        for (const segment of kind.path.slice(0, -1)) parent = parent?.[segment] as Record<string, unknown> | undefined;
        if (parent) delete parent[kind.path.at(-1)!];
      }
      const view = redactDeep({ namespace: options.namespace, head,
        configSnapshotId: options.manager?.status().snapshotId ?? null,
        fileDigest: options.fileDigest, globals, provenance: Object.fromEntries(merged.provenance), collections,
        fields: redactFieldsView(buildEffectiveConfigView(merged, effective)) });
      return c.json({ ...(view as Record<string, unknown>), secretEnvs: secretEnvStatus(effective, options.envLookup, options.fileConfig) });
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  // ----------------------------------------------------------- GET /schema
  app.get("/schema", (c) => {
    return c.json({
      protocolVersion: 1,
      uiSpec: configUiSpec(),
      // Static LLM provider presets (curated in @aicr/llm; no credentials).
      // Consumed by the dashboard Providers page as draft prefill templates.
      providerPresets: MODEL_PROVIDER_PRESETS,
      formatVersion: options.formatVersion ?? 2,
      entityCollections: Object.values(CONFIG_ENTITY_COLLECTIONS).map((collection) => ({ kind: collection.kind, path: collection.path, idField: collection.idField, since: collection.since })),
      channelKinds: CHANNEL_KINDS,
      inventory: CONFIG_FIELD_INVENTORY.map((spec) => ({
        path: spec.path,
        valueKind: spec.valueKind,
        ownership: spec.ownership,
        inheritance: spec.inheritance,
        schemaStatus: spec.schemaStatus,
        capability: spec.capability ?? null,
        wired: spec.wired,
        status: spec.status ?? null,
        uiControl: spec.uiControl,
        testId: spec.testId ?? null,
      })),
    });
  });

  // ------------------------------------------------------ GET /options/:source
  app.get("/options/:source", async (c) => {
    const source = c.req.param("source");
    const handler = Object.hasOwn(CONFIG_OPTIONS_SOURCES, source) ? CONFIG_OPTIONS_SOURCES[source] : undefined;
    if (handler === undefined) {
      return c.json({ error: "invalid_request", message: `Unknown options source "${source}".` }, 400);
    }
    try {
      return c.json(redactDeep({ source, options: await handler(options) }));
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  // --------------------------------------------------------- POST /validate
  app.post("/validate", async (c) => {
    const body = await readJsonBody(c, validateRequestSchema, maxBodyBytes);
    if (!body.ok) return body.response;
    try {
      assertNoInlineCredentials(body.value.operations);
      const preview = await previewConfigChangeset({
        store: options.store,
        namespace: options.namespace,
        file: options.fileConfig,
        fileDigest: fileDigestOf(body.value.fileDigest),
        operations: body.value.operations as readonly ConfigChangesetOperation[],
        formatVersion: options.formatVersion ?? 2,
        secretSealing: options.secretSealing,
      });
      // A09: preview is side-effect free by contract; the preview service
      // itself never writes. Report shape only — no env values exist here.
      return c.json(redactDeep(preview));
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  // ---------------------------------------------------- POST /preview-route
  app.post("/preview-route", async (c) => {
    const body = await readJsonBody(c, previewRouteRequestSchema, maxBodyBytes);
    if (!body.ok) return body.response;
    try {
      const loaded = await loadConfigView(options);
      let effective = loaded.effective;
      const draft = body.value.draft;
      if (draft !== undefined) {
        if (draft.fileDigest !== options.fileDigest) throw new ConfigError("file_config_mismatch", "The draft uses a different file configuration.");
        if (draft.baseRevision !== (loaded.head?.activeRevision ?? null)) {
          return c.json({ error: "revision_conflict", headRevision: loaded.head?.activeRevision ?? null, message: "The staged draft is based on an older revision." }, 409);
        }
        assertNoInlineCredentials(draft.operations);
        effective = prepareConfigPublication({
          ...draft, operations: draft.operations as readonly ConfigChangesetOperation[],
          namespace: options.namespace, file: options.fileConfig, current: loaded.database,
          formatVersion: options.formatVersion ?? 2, operationId: "route-preview", actor: "preview",
        }).effective;
      }
      const preview = previewConfigRoute(effective, body.value.event);
      if (preview.status === "matched") {
        // Computed, validated workspace paths include a SHA-256 instance ID.
        // Entropy heuristics mistake these public identities for credentials;
        // keep the layout usable without relaxing redaction of source data.
        return c.json({ ...redactDeep(preview) as Record<string, unknown>,
          layout: preview.layout, workspaceInstanceId: preview.workspaceInstanceId });
      }
      return c.json(redactDeep(preview));
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  // ------------------------------------------------------ POST /changesets
  app.post("/changesets", async (c) => {
    const body = await readJsonBody(c, changesetRequestSchema, maxBodyBytes);
    if (!body.ok) return body.response;
    try {
      assertNoInlineCredentials(body.value.operations);
      const currentDocument = await currentDatabaseDocument(options, body.value.baseRevision);
      const prepared = prepareConfigPublication({
        namespace: options.namespace,
        baseRevision: body.value.baseRevision,
        operationId: body.value.operationId,
        actor: "admin-api",
        file: options.fileConfig,
        fileDigest: fileDigestOf(body.value.fileDigest),
        current: currentDocument,
        operations: body.value.operations as readonly ConfigChangesetOperation[],
        formatVersion: options.formatVersion ?? 2,
      });
      const result = await publishConfig(options.store, prepared, {
        secretSealing: options.secretSealing,
        ...(options.manager
          ? {
              install: async (preparedPublication, revision) => {
                await options.manager!.install({
                  effective: preparedPublication.effective,
                  revision: revision.revision,
                  revisionContentHash: revision.contentHash,
                  fileDigest: revision.fileDigest,
                  formatVersion: preparedPublication.formatVersion,
                });
              },
            }
          : {}),
      });
      if (result.status === "conflict") {
        return c.json({ error: "revision_conflict", headRevision: result.headRevision, message: scrubMessage(result.message) }, 409);
      }
      if (result.status === "committed_activating") {
        // A12: durable but not locally active — never reported as success.
        return c.json({
          status: "committed_activating",
          stage: result.stage,
          message: scrubMessage(result.message),
          revision: revisionMetadata(result.revision),
        }, 202);
      }
      return c.json({ status: "committed", snapshotId: result.snapshotId, revision: revisionMetadata(result.revision) });
    } catch (error) {
      if (isConfigError(error) && error.code === "operation_conflict") {
        return c.json({ error: "operation_conflict", message: scrubMessage(error.message) }, 409);
      }
      return configErrorResponse(c, error);
    }
  });

  // -------------------------------------------------- GET /operations/:id
  app.get("/operations/:operationId", async (c) => {
    const operationId = c.req.param("operationId");
    try {
      const status = await getConfigOperation(options.store, options.namespace, operationId);
      if (status.status === "not_found") {
        return c.json({ error: "not_found", message: `No operation "${operationId}" in namespace "${options.namespace}".` }, 404);
      }
      if (options.manager) {
        try {
          await options.manager.admission();
        } catch (error) {
          return c.json({ status: "committed_activating", revision: revisionMetadata(status.revision),
            message: isConfigError(error) ? scrubMessage(error.message) : "Runtime activation is unavailable." }, 202);
        }
      }
      return c.json({ status: "committed", revision: revisionMetadata(status.revision),
        ...(options.manager ? { runtime: options.manager.status() } : {}) });
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  // ------------------------------------------------------- GET /revisions
  app.get("/revisions", async (c) => {
    try {
      const beforeRaw = c.req.query("before");
      const before = beforeRaw !== undefined ? Number(beforeRaw) : undefined;
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
        return c.json({ error: "invalid_request", message: "Query 'before' must be a positive integer revision." }, 400);
      }
      const revisions = await options.store.listRevisions(options.namespace, {
        limit: limitOf(c),
        ...(before !== undefined ? { before } : {}),
      });
      return c.json({ revisions: revisions.map(revisionMetadata) });
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  // ------------------------------------------------ GET /revisions/:revision
  app.get("/revisions/:revision", async (c) => {
    const revisionNumber = Number(c.req.param("revision"));
    if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
      return c.json({ error: "invalid_request", message: "Revision must be a positive integer." }, 400);
    }
    try {
      const revision = await options.store.readRevision(options.namespace, revisionNumber);
      if (revision === null) {
        return c.json({ error: "not_found", message: `Revision ${revisionNumber} not found.` }, 404);
      }
      const audit = await options.store.readAudit(options.namespace, { operationId: revision.operationId, limit: 10 });
      return c.json(redactDeep({
        revision: revisionMetadata(revision),
        document: revision.document,
        audit: audit.map((entry) => ({
          id: entry.id,
          action: entry.action,
          entityRefs: entry.entityRefs,
          redactedDiff: entry.redactedDiff,
          actor: entry.actor,
          timestamp: new Date(entry.timestamp).toISOString(),
        })),
      }));
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  // ------------------------------------- POST /revisions/:revision/restore
  app.post("/revisions/:revision/restore", async (c) => {
    const revisionNumber = Number(c.req.param("revision"));
    if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
      return c.json({ error: "invalid_request", message: "Revision must be a positive integer." }, 400);
    }
    const body = await readJsonBody(c, restoreRequestSchema, maxBodyBytes);
    if (!body.ok) return body.response;
    try {
      const prepared = await prepareConfigRestore(options.store, {
        namespace: options.namespace,
        revision: revisionNumber,
        operationId: body.value.operationId,
        actor: "admin-api",
        file: options.fileConfig,
        fileDigest: fileDigestOf(body.value.fileDigest),
        baseRevision: body.value.baseRevision,
        formatVersion: options.formatVersion ?? 2,
      });
      assertNoInlineCredentials(prepared.document);
      const result = await publishConfig(options.store, prepared, {
        secretSealing: options.secretSealing,
        ...(options.manager
          ? {
              install: async (preparedPublication, revision) => {
                await options.manager!.install({
                  effective: preparedPublication.effective,
                  revision: revision.revision,
                  revisionContentHash: revision.contentHash,
                  fileDigest: revision.fileDigest,
                  formatVersion: preparedPublication.formatVersion,
                });
              },
            }
          : {}),
      });
      if (result.status === "conflict") {
        return c.json({ error: "revision_conflict", headRevision: result.headRevision, message: scrubMessage(result.message) }, 409);
      }
      if (result.status === "committed_activating") {
        return c.json({
          status: "committed_activating",
          stage: result.stage,
          message: scrubMessage(result.message),
          revision: revisionMetadata(result.revision),
        }, 202);
      }
      return c.json({ status: "committed", snapshotId: result.snapshotId, revision: revisionMetadata(result.revision), restoredFrom: revisionNumber });
    } catch (error) {
      if (isConfigError(error) && error.code === "operation_conflict") {
        return c.json({ error: "operation_conflict", message: scrubMessage(error.message) }, 409);
      }
      return configErrorResponse(c, error);
    }
  });

  // ----------------------------------------------------------- GET /status
  app.get("/status", async (c) => {
    try {
      const head = await options.store.readHead(options.namespace);
      try {
        const generation = await options.manager?.admission();
        await options.manager?.heartbeat();
        const instances = (await options.manager?.instanceStatuses() ?? []).map(record => ({
          instanceId: record.key.slice("instance/".length), updatedAt: record.updatedAt, snapshotId: record.snapshotId,
          ready: record.updatedAt > Date.now() - 300_000 && (record.value as { databaseRevision?: number }).databaseRevision === (head?.activeRevision ?? null),
          version: record.value,
        }));
        return c.json({ namespace: options.namespace, head, manager: options.manager?.status() ?? null,
          instances,
          admission: { available: true, snapshotId: generation?.snapshotId ?? null,
            databaseRevision: generation?.databaseRevision ?? head?.activeRevision ?? null } });
      } catch (error) {
        return c.json({ namespace: options.namespace, head, manager: options.manager?.status() ?? null,
          admission: { available: false, reason: isConfigError(error) ? error.code : "store_unavailable" } }, 503);
      }
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  return app;
}

async function currentDatabaseDocument(options: ConfigApiOptions, baseRevision: number | null): Promise<DatabaseConfigDocument> {
  if (baseRevision === null) return {};
  const revision = await options.store.readRevision(options.namespace, baseRevision);
  if (revision === null) {
    throw new ConfigError("entity_not_found", `Base revision ${baseRevision} not found in namespace "${options.namespace}".`);
  }
  return validateDatabaseDocument(revision.document, revision.formatVersion);
}
