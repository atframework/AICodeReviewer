import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * Forward configuration contracts for the workspace/dynamic-config roadmap.
 *
 * This module pins the pure, storage-agnostic contracts defined in
 * docs/superpowers/specs/2026-09-11-workspace-config-management.md:
 * format versions, revision metadata, error codes, the matcher and path
 * template language limits, and the workspace instance identity function.
 * Runtime wiring (storage, publish, routing) is delivered by later phases;
 * nothing here reads the filesystem, environment, or network.
 */

// ---------------------------------------------------------------------------
// Format versions (spec §9.1)
// ---------------------------------------------------------------------------

/** Current on-disk format: no `config_version` key, named model-chain groups. */
export const CONFIG_FORMAT_VERSION_LEGACY = 1;
/** Highest format this build can load. */
export const CONFIG_FORMAT_VERSION_CURRENT = 1;
/** Planned multi-project/dynamic-config format; not accepted yet. */
export const CONFIG_FORMAT_VERSION_PLANNED = 2;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const CONFIG_ERROR_CODES = [
  // raw source stage
  "malformed_yaml",
  "config_too_large",
  "root_not_mapping",
  "prototype_key",
  "unsupported_config_version",
  "conversion_conflict",
  // validation
  "duplicate_entity",
  "invalid_secret_env",
  "entity_id_mismatch",
  "config_path_invalid",
  // changeset / publish
  "entity_not_found",
  "entity_exists",
  "file_owned",
  "bootstrap_readonly",
  "entity_collection_misplaced",
  "invalid_reference",
  "path_not_overridden",
  "revision_conflict",
  "committed_activating",
  "file_config_mismatch",
  // matcher / template / identity
  "matcher_invalid",
  "template_invalid",
  "definition_id_invalid",
  "revision_invalid",
  "snapshot_invalid",
  // routing outcomes (P3+)
  "ambiguous_route",
  "repository_not_configured",
  "no_route",
] as const;

export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number];
export interface ConfigErrorDetails {
  readonly path?: readonly string[] | undefined;
  readonly entity?: ConfigEntityRef | undefined;
  readonly cause?: unknown;
}

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly path?: readonly string[] | undefined;
  readonly entity?: ConfigEntityRef | undefined;

  constructor(code: ConfigErrorCode, message: string, details: ConfigErrorDetails = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "ConfigError";
    this.code = code;
    this.path = details.path;
    this.entity = details.entity;
  }
}

export function isConfigError(error: unknown, code?: ConfigErrorCode): error is ConfigError {
  return error instanceof ConfigError && (code === undefined || error.code === code);
}

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

/**
 * A config path addresses a value inside the raw config object. Array
 * indices are decimal strings; entity collections are addressed by their
 * entity id (see CONFIG_ENTITY_COLLECTIONS), never by array position, so
 * paths stay stable across reordering.
 */
export type ConfigPath = readonly string[];

const PROTOTYPE_KEYS: Record<string, true> = Object.fromEntries(
  ["__proto__", "prototype", "constructor"].map((key) => [key, true]),
);
const PLAIN_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export function isPrototypeKey(segment: string): boolean {
  return PROTOTYPE_KEYS[segment] === true;
}

/** `["llm","providers","openai-main","base_url"]` → `llm.providers.openai-main.base_url`. */
export function formatConfigPath(path: ConfigPath): string {
  return path
    .map((segment) => {
      if (PLAIN_SEGMENT_RE.test(segment)) {
        return `.${segment}`;
      }
      return `[${JSON.stringify(segment)}]`;
    })
    .join("")
    .replace(/^\./u, "");
}

/** Inverse of formatConfigPath; rejects prototype keys and malformed quoting. */
export function parseConfigPath(text: string): ConfigPath {
  const segments: string[] = [];
  let index = 0;

  if (text.length === 0) {
    return [];
  }
  while (index < text.length) {
    let segment: string;
    if (text[index] === "[") {
      // Find the closing JSON quote, respecting escapes and literal brackets.
      const quoted = /^\[("(?:[^"\\]|\\.)*")\]/u.exec(text.slice(index));
      if (quoted === null) {
        throw new ConfigError("template_invalid", `Unterminated quoted segment in config path "${text}".`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(quoted[1]!) as unknown;
      } catch {
        throw new ConfigError("template_invalid", `Invalid quoted segment in config path "${text}".`);
      }
      if (typeof parsed !== "string") {
        throw new ConfigError("template_invalid", `Quoted config path segment must be a string in "${text}".`);
      }
      segment = parsed;
      index += quoted[0].length;
    } else {
      if (index > 0) {
        if (text[index] !== ".") {
          throw new ConfigError("template_invalid", `Invalid config path "${text}".`);
        }
        index += 1;
      }
      const match = /^[A-Za-z0-9][A-Za-z0-9_-]*/u.exec(text.slice(index));
      if (!match) {
        throw new ConfigError("template_invalid", `Invalid config path segment at offset ${index} in "${text}".`);
      }
      segment = match[0];
      index += match[0].length;
    }
    if (isPrototypeKey(segment)) {
      throw new ConfigError("prototype_key", `Config path segment "${segment}" is a prototype key.`, {
        path: [...segments, segment],
      });
    }
    segments.push(segment);
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Entity collections (spec §4.2 rule 2)
// ---------------------------------------------------------------------------

export type ConfigEntityKind = "provider" | "model_group" | "trigger" | "channel" | "workspace" | "route";

export interface ConfigEntityCollection {
  readonly kind: ConfigEntityKind;
  /** Location of the collection inside the raw config document. */
  readonly path: ConfigPath;
  readonly shape: "array" | "map";
  /** Field holding the entity id for array collections; null for map collections. */
  readonly idField: string | null;
  /** First config format version accepting the collection. */
  readonly since: number;
}

export const CONFIG_ENTITY_COLLECTIONS: Readonly<Record<ConfigEntityKind, ConfigEntityCollection>> = {
  provider: { kind: "provider", path: ["llm", "providers"], shape: "array", idField: "id", since: 1 },
  model_group: { kind: "model_group", path: ["llm", "model_chain"], shape: "map", idField: null, since: 1 },
  trigger: { kind: "trigger", path: ["triggers"], shape: "array", idField: "name", since: 1 },
  channel: { kind: "channel", path: ["outputs", "channels"], shape: "array", idField: "name", since: 1 },
  workspace: { kind: "workspace", path: ["workspaces", "instances"], shape: "map", idField: null, since: 1 },
  // Reserved for the v2 routing format (spec §6); rejected by the v1 schema.
  route: { kind: "route", path: ["routing", "rules"], shape: "array", idField: "id", since: 2 },
};

export interface ConfigEntityRef {
  readonly kind: ConfigEntityKind;
  readonly id: string;
}

export function entityPath(ref: ConfigEntityRef): ConfigPath {
  return [...CONFIG_ENTITY_COLLECTIONS[ref.kind].path, ref.id];
}

export function formatEntityRef(ref: ConfigEntityRef): string {
  return formatConfigPath(entityPath(ref));
}

/** Collections accepted by a given config format version, in registry order. */
export function entityCollectionsForVersion(formatVersion: number): readonly ConfigEntityCollection[] {
  return Object.values(CONFIG_ENTITY_COLLECTIONS).filter((collection) => collection.since <= formatVersion);
}

// ---------------------------------------------------------------------------
// Revision and head contracts (spec §4.3)
// ---------------------------------------------------------------------------

export interface ConfigRevisionMetadata {
  readonly namespace: string;
  /** Positive safe integer, strictly increasing per namespace. */
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly formatVersion: number;
  /** SHA-256 hex of the stable-serialized revision document. */
  readonly contentHash: string;
  /** SHA-256 hex of the exact config file bytes this revision merged against. */
  readonly fileDigest: string;
  /** UTC ISO-8601 timestamp. */
  readonly createdAt: string;
  readonly actor: string;
  /** Idempotency key supplied by the caller; unique per namespace. */
  readonly operationId: string;
}

export interface ConfigHead {
  readonly namespace: string;
  readonly activeRevision: number;
  /**
   * CAS counter as a decimal string: JS-safe-integer backends increment a
   * number, but the API contract is textual so Redis/SQLite BIGINT never
   * lose precision (spec §4.3).
   */
  readonly generation: string;
}

const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function validateConfigNamespace(value: unknown): string {
  if (typeof value !== "string" || !NAMESPACE_RE.test(value)) {
    throw new ConfigError("revision_invalid", `Invalid config namespace; expected ${NAMESPACE_RE.source}.`);
  }
  return value;
}

export function validateConfigRevisionNumber(value: unknown, field = "revision"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError("revision_invalid", `Config ${field} must be a positive safe integer.`);
  }
  return value;
}

export function parseConfigGeneration(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    throw new ConfigError("revision_invalid", "Config generation must be a decimal string.");
  }
  return BigInt(value);
}

export function formatConfigGeneration(generation: bigint): string {
  if (generation < 0n) {
    throw new ConfigError("revision_invalid", "Config generation must not be negative.");
  }
  return generation.toString(10);
}

// ---------------------------------------------------------------------------
// Deterministic hashing
// ---------------------------------------------------------------------------

function stableSerializeInto(value: unknown, out: string[], ancestors: Set<object>): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(JSON.stringify(value));
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("stableConfigHash requires finite numbers.");
      }
      out.push(JSON.stringify(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("stableConfigHash cannot serialize cyclic values.");
      }
      ancestors.add(value);
      if (Array.isArray(value)) {
        out.push("[");
        for (const entry of value) {
          stableSerializeInto(entry, out, ancestors);
          out.push(",");
        }
        out.push("]");
        ancestors.delete(value);
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError("stableConfigHash only accepts plain objects, arrays, and primitives.");
      }
      out.push("{");
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry === undefined) {
          continue;
        }
        out.push(JSON.stringify(key), ":");
        stableSerializeInto(entry, out, ancestors);
        out.push(",");
      }
      out.push("}");
      ancestors.delete(value);
      return;
    }
    default:
      throw new TypeError(`stableConfigHash cannot serialize ${typeof value}.`);
  }
}

/** Deterministic serialization: sorted object keys, no insignificant whitespace. */
export function stableSerialize(value: unknown): string {
  const out: string[] = [];
  stableSerializeInto(value, out, new Set());
  return out.join("");
}

/** SHA-256 hex of the stable serialization; fixed 64-char output. */
export function stableConfigHash(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value), "utf8").digest("hex");
}


// ---------------------------------------------------------------------------
// Matcher contract (spec §5.1); RE2/glob compilation lands with the P1 matcher
// ---------------------------------------------------------------------------

export const CONFIG_MATCHER_LIMITS = {
  maxRulesPerGroup: 128,
  maxExpressionBytes: 1024,
  maxFieldBytes: 4096,
  maxTotalBytes: 64 * 1024,
} as const;

export type ConfigMatcher =
  | { readonly exact: string }
  | { readonly glob: string; readonly ignore_case?: boolean | undefined }
  | { readonly regex: string; readonly ignore_case?: boolean | undefined };

export const configMatcherSchema: z.ZodType<ConfigMatcher> = z.union([
  z.object({ exact: z.string().min(1) }).strict(),
  z.object({ glob: z.string().min(1), ignore_case: z.boolean().optional() }).strict(),
  z.object({ regex: z.string().min(1), ignore_case: z.boolean().optional() }).strict(),
]);

export function validateConfigMatcher(value: unknown, path?: ConfigPath): ConfigMatcher {
  const parsed = configMatcherSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      "matcher_invalid",
      `Matcher must set exactly one of exact/glob/regex: ${parsed.error.issues[0]?.message ?? "invalid value"}`,
      { path },
    );
  }
  const expression = "exact" in parsed.data ? parsed.data.exact : "glob" in parsed.data ? parsed.data.glob : parsed.data.regex;
  if (Buffer.byteLength(expression, "utf8") > CONFIG_MATCHER_LIMITS.maxExpressionBytes) {
    throw new ConfigError(
      "matcher_invalid",
      `Matcher expression exceeds ${CONFIG_MATCHER_LIMITS.maxExpressionBytes} bytes.`,
      { path },
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Path template contract (spec §5.4); Handlebars AST validation lands with P1
// ---------------------------------------------------------------------------

export const PATH_TEMPLATE_HELPERS = ["segment", "default", "hash", "lower"] as const;
export type PathTemplateHelper = (typeof PATH_TEMPLATE_HELPERS)[number];

export const PATH_TEMPLATE_LIMITS = {
  maxLengthBytes: 4096,
  maxAstNodes: 256,
  maxAstDepth: 8,
} as const;

// ---------------------------------------------------------------------------
// Workspace identity (spec §5.1/§5.5)
// ---------------------------------------------------------------------------

/** Reserved root keys of the `workspaces` section; shared with config.ts. */
export const workspaceRootKeys = ["cache", "defaults", "instances"] as const;

const reservedWorkspaceIds: Record<string, true> = { cache: true, defaults: true, instances: true };

/** v2 definition id contract; v1 ids are not renamed automatically. */
export const WORKSPACE_DEFINITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function validateWorkspaceDefinitionId(id: string): string {
  if (!WORKSPACE_DEFINITION_ID_PATTERN.test(id)) {
    throw new ConfigError(
      "definition_id_invalid",
      `Workspace definition id "${id}" must match ${WORKSPACE_DEFINITION_ID_PATTERN.source}.`,
    );
  }
  if (reservedWorkspaceIds[id] === true) {
    throw new ConfigError(
      "definition_id_invalid",
      `Workspace definition id "${id}" collides with reserved keys (${workspaceRootKeys.join(", ")}).`,
    );
  }
  return id;
}

export const WORKSPACE_INSTANCE_ID_DOMAIN = "workspace-instance";
export const WORKSPACE_INSTANCE_ID_VERSION = 1;

export interface WorkspaceInstanceIdentityInput {
  readonly definitionId: string;
  readonly triggerName: string;
  readonly vcs: string;
  readonly canonicalProjectKey: string;
}

/**
 * Stable per-project workspace instance identity (spec §5.5). The full
 * SHA-256 hex is the identity; templates never shorten it.
 */
export function computeWorkspaceInstanceId(input: WorkspaceInstanceIdentityInput): string {
  return stableConfigHash([
    WORKSPACE_INSTANCE_ID_DOMAIN,
    WORKSPACE_INSTANCE_ID_VERSION,
    input.definitionId,
    input.triggerName,
    input.vcs,
    input.canonicalProjectKey,
  ]);
}

// ---------------------------------------------------------------------------
// Runtime snapshot reference (spec §4.3 config_runtime_snapshots)
// ---------------------------------------------------------------------------

export const CONFIG_RUNTIME_SNAPSHOT_FORMAT = 1;
/** Marker for receipts/snapshots that predate config revisions (spec §7.2). */
export const LEGACY_SNAPSHOT_IMPORT = "legacy_import";

export interface ConfigRuntimeSnapshotRef {
  readonly snapshotFormat: number;
  readonly fileDigest: string;
  /** Explicit marker for legacy imports that predate database revisions. */
  readonly databaseRevision: number | typeof LEGACY_SNAPSHOT_IMPORT;
  readonly resolverVersion: string;
  readonly contentHash: string;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

/**
 * Classifies a persisted snapshot reference. Snapshots written before config
 * revisions existed have no revision fields and are reported as "legacy";
 * a revision is never fabricated for them (test B05).
 */
export function parseConfigRuntimeSnapshotRef(
  raw: unknown,
): { readonly kind: "legacy" } | { readonly kind: "current"; readonly ref: ConfigRuntimeSnapshotRef } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("snapshot_invalid", "Runtime snapshot reference must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const hasRevisionFields =
    ["snapshotFormat", "fileDigest", "databaseRevision", "resolverVersion", "contentHash"].some((key) => Object.hasOwn(record, key));
  if (!hasRevisionFields) {
    return { kind: "legacy" };
  }
  const { fileDigest, databaseRevision, resolverVersion, contentHash } = record;
  if (typeof fileDigest !== "string" || !SHA256_HEX_RE.test(fileDigest)) {
    throw new ConfigError("snapshot_invalid", "Runtime snapshot fileDigest must be a SHA-256 hex string.");
  }
  if (databaseRevision !== LEGACY_SNAPSHOT_IMPORT) {
    validateConfigRevisionNumber(databaseRevision, "databaseRevision");
  }
  if (typeof resolverVersion !== "string" || resolverVersion.length === 0) {
    throw new ConfigError("snapshot_invalid", "Runtime snapshot resolverVersion must be a non-empty string.");
  }
  if (typeof contentHash !== "string" || !SHA256_HEX_RE.test(contentHash)) {
    throw new ConfigError("snapshot_invalid", "Runtime snapshot contentHash must be a SHA-256 hex string.");
  }
  const snapshotFormat = record.snapshotFormat ?? CONFIG_RUNTIME_SNAPSHOT_FORMAT;
  if (snapshotFormat !== CONFIG_RUNTIME_SNAPSHOT_FORMAT) {
    throw new ConfigError("snapshot_invalid", `Unsupported runtime snapshot format ${String(snapshotFormat)}.`);
  }
  return {
    kind: "current",
    ref: {
      snapshotFormat: CONFIG_RUNTIME_SNAPSHOT_FORMAT,
      fileDigest,
      databaseRevision: databaseRevision as number | typeof LEGACY_SNAPSHOT_IMPORT,
      resolverVersion,
      contentHash,
    },
  };
}
