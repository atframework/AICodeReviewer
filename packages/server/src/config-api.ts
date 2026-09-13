/**
 * Config admin API (spec §8.4, P5). Mounted at `/api/admin/config`, guarded
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
  assertNoConfigCredentialLiterals,
  collectConfigSecretReferences,
  getConfigOperation,
  isConfigError,
  mergeConfigSources,
  parseEffectiveConfig,
  prepareConfigPublication,
  prepareConfigRestore,
  previewConfigChangeset,
  previewConfigRoute,
  publishConfig,
  scrubText,
  validateDatabaseDocument,
  validateConfigNamespace,
  type AppConfigInput,
  type ConfigChangesetOperation,
  type ConfigRoutePreviewEvent,
  type ConfigStore,
  type DatabaseConfigDocument,
  type EffectiveConfigV2,
} from "@aicr/core";
import { createAdminAuthMiddleware, type AdminAuthConfig, type AdminSessionStore } from "./admin-auth.js";
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

const previewRouteRequestSchema = z.object({ event: routePreviewEventSchema }).strict();

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
    }, error.code === "store_unavailable" ? 503 : error.code === "file_config_mismatch" ? 409 : 400);
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

/**
 * Deep response redaction (A05): config surfaces carry env var *names* by
 * contract, but passthrough values could hold literal credentials. Keys that
 * name secrets (without the `_env` reference suffix) have their values
 * replaced; hashes/ids/urls survive because they do not match the name rule.
 */
function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === "string") {
    // URL credentials and signed query parameters are secrets even when the
    // surrounding key is merely base_url/url. Strip all query values.
    try {
      const url = new URL(value);
      if (url.username) url.username = "<redacted>";
      if (url.password) url.password = "<redacted>";
      for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, "<redacted>");
      if (url.hash) url.hash = "<redacted>";
      return scrubMessage(url.toString());
    } catch { return scrubMessage(value); }
  }
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PROTOTYPE_TOKENS.has(key.toLowerCase())) continue;
    if ((SENSITIVE_NAME_SUFFIX_FREE.test(key) || /^(authorization|proxy-authorization|cookie|set-cookie|headers)$/i.test(key)) && !key.endsWith("_env") && typeof entry !== "number" && typeof entry !== "boolean") {
      output[key] = "<redacted>";
    } else {
      output[key] = redactDeep(entry);
    }
  }
  return output;
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

async function loadEffective(options: ConfigApiOptions): Promise<EffectiveConfigV2> {
  return (await loadConfigView(options)).effective;
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
      const origin = c.req.header("origin");
      if (c.req.header("sec-fetch-site") === "cross-site" || (origin !== undefined && origin !== new URL(c.req.url).origin)) {
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
        fileDigest: options.fileDigest, globals, provenance: Object.fromEntries(merged.provenance), collections });
      return c.json({ ...(view as Record<string, unknown>), secretEnvs: secretEnvStatus(effective, options.envLookup, options.fileConfig) });
    } catch (error) {
      return configErrorResponse(c, error);
    }
  });

  // ----------------------------------------------------------- GET /schema
  app.get("/schema", (c) => {
    return c.json({
      protocolVersion: 1,
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
      const effective = await loadEffective(options);
      const preview = previewConfigRoute(effective, body.value.event);
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
