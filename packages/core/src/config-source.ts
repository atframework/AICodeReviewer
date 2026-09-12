import { createHash } from "node:crypto";

import { LineCounter, isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";

import {
  CONFIG_ENTITY_COLLECTIONS,
  ConfigError,
  entityCollectionsForVersion,
  formatConfigPath,
  isPrototypeKey,
  parseConfigPath,
  stableSerialize,
  type ConfigEntityKind,
  type ConfigEntityRef,
  type ConfigPath,
} from "./config-format.js";
import { isPlainObject } from "./utils.js";
import type { AppConfigInput } from "./config.js";

/**
 * Raw config source model and the database/file merge machinery for the
 * workspace/dynamic-config roadmap. The pipeline stages are deliberately
 * separate (spec §4.2): raw YAML text with source locations → in-memory
 * legacy format conversion → source merge with per-field provenance → a
 * single schema parse (defaults applied exactly once, performed in
 * config.ts). Everything here is pure: no filesystem, env, or network.
 */

// ---------------------------------------------------------------------------
// Raw document parsing (stage 1)
// ---------------------------------------------------------------------------

export const CONFIG_SOURCE_MAX_BYTES = 1024 * 1024;

export interface ConfigSourceLocation {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** Structural-path → source position; array indices are decimal strings. */
export type ConfigSourceMap = ReadonlyMap<string, ConfigSourceLocation>;

export interface ParseRawConfigOptions {
  readonly maxBytes?: number;
  readonly fileName?: string;
}

export interface RawConfigDocument {
  /** Plain-object config root; `config_version` envelope metadata is stripped. */
  readonly root: AppConfigInput;
  readonly formatVersion: number;
  readonly sourceMap: ConfigSourceMap;
  /** SHA-256 hex of the exact input bytes. */
  readonly digest: string;
  readonly byteLength: number;
  readonly fileName?: string | undefined;
}

export function computeConfigDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildSourceMap(root: unknown, lineCounter: LineCounter): Map<string, ConfigSourceLocation> {
  const map = new Map<string, ConfigSourceLocation>();
  const visit = (node: unknown, path: string[]): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key;
        if (key == null || typeof key !== "object" || !("value" in key)) {
          continue;
        }
        const keyText = String((key as { value: unknown }).value);
        const childPath = [...path, keyText];
        const range = (key as { range?: [number, number, number] }).range;
        if (range) {
          const pos = lineCounter.linePos(range[0]);
          map.set(formatConfigPath(childPath), { offset: range[0], line: pos.line, column: pos.col });
        }
        visit(pair.value, childPath);
      }
      return;
    }
    if (isSeq(node)) {
      node.items.forEach((item, index) => {
        visit(item, [...path, String(index)]);
      });
    }
  };
  visit(root, []);
  return map;
}

function assertNoPrototypeKeys(value: unknown, path: string[], ancestors = new Set<object>()): void {
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) {
      throw new ConfigError("malformed_yaml", `Cyclic config value at ${formatConfigPath(path)}.`, { path });
    }
    ancestors.add(value);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrototypeKeys(entry, [...path, String(index)], ancestors));
    ancestors.delete(value);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (isPrototypeKey(key)) {
        throw new ConfigError("prototype_key", `Config key "${key}" at ${formatConfigPath(path)} is a prototype key.`, {
          path: [...path, key],
        });
      }
      assertNoPrototypeKeys(entry, [...path, key], ancestors);
    }
  }
  if (value !== null && typeof value === "object") {
    ancestors.delete(value);
  }
}

/**
 * Parses raw YAML text into a RawConfigDocument. Duplicate mapping keys and
 * malformed YAML are rejected with line/column; documents larger than
 * `maxBytes` and prototype keys anywhere in the tree are rejected before any
 * schema work. `config_version: 1` is accepted as envelope metadata and
 * stripped; higher versions are rejected as unsupported.
 */
export function parseRawConfigSource(text: string, options: ParseRawConfigOptions = {}): RawConfigDocument {
  const { maxBytes = CONFIG_SOURCE_MAX_BYTES, fileName } = options;
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maxBytes) {
    throw new ConfigError("config_too_large", `Config source exceeds ${maxBytes} bytes (${byteLength} bytes).`);
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, stringKeys: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    const pos = first.linePos?.[0];
    const where = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
    throw new ConfigError(
      "malformed_yaml",
      `Invalid YAML${fileName ? ` in ${fileName}` : ""}${where}: ${first.message.split("\n")[0]}`,
      { cause: first },
    );
  }

  const sourceMap = buildSourceMap(doc.contents, lineCounter);
  let parsed: unknown;
  if (doc.contents === null) {
    parsed = {};
  } else {
    if (!isMap(doc.contents)) {
      // Message kept identical to the historical loadConfigFile contract.
      throw new ConfigError("root_not_mapping", "Config file root must be a YAML mapping/object.");
    }
    try {
      parsed = doc.toJS() as unknown;
    } catch (error) {
      throw new ConfigError(
        "malformed_yaml",
        `Invalid YAML${fileName ? ` in ${fileName}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  assertNoPrototypeKeys(parsed, []);

  let root = parsed as AppConfigInput;
  if (Object.hasOwn(root, "config_version")) {
    const version = root.config_version;
    if (version !== 1) {
      throw new ConfigError(
        "unsupported_config_version",
        `config_version ${String(version)} is not supported by this build; supported versions: 1.`,
        { path: ["config_version"] },
      );
    }
    const { config_version: _stripped, ...rest } = root;
    root = rest;
  }

  return {
    root,
    formatVersion: 1,
    sourceMap,
    digest: computeConfigDigest(text),
    byteLength,
    fileName,
  };
}

// ---------------------------------------------------------------------------
// Legacy format conversion (stage 2, spec §9.4)
// ---------------------------------------------------------------------------

export interface ConfigConversionChange {
  readonly path: ConfigPath;
  readonly kind: "rename" | "transform";
  readonly message: string;
}

export interface ConfigConversionResult {
  /** Shares untouched subtrees with the input; identical reference when no-op. */
  readonly document: AppConfigInput;
  readonly changes: readonly ConfigConversionChange[];
}

function identicalContent(a: unknown, b: unknown): boolean {
  return stableSerialize(a) === stableSerialize(b);
}

/**
 * Converts historical llm shapes to the current named-group format, in
 * memory; the source file is never rewritten. Handles the array form of
 * `llm.model_chain` (→ group "default") and the `fallback_chain` /
 * `triage_fallback_chain` aliases (→ groups "default"/"triage" plus a
 * `triage_model_chain: triage` reference). Conflicting old/new keys fail;
 * identical duplicates collapse so repeated runs are no-ops (test C14).
 */
export function convertLegacyConfigDocument(root: AppConfigInput): ConfigConversionResult {
  const llm = root.llm;
  if (!isPlainObject(llm)) {
    return { document: root, changes: [] };
  }

  const changes: ConfigConversionChange[] = [];
  let modelChain: Record<string, unknown> | undefined;
  let modelChainChanged = false;
  let triageReference: string | undefined;

  const adoptGroup = (groupName: string, entries: unknown, legacyKey: string): void => {
    modelChain ??= {};
    const existing = modelChain[groupName];
    if (existing !== undefined) {
      if (!identicalContent(existing, entries)) {
        throw new ConfigError(
          "conversion_conflict",
          `llm.${legacyKey} conflicts with the existing llm.model_chain group "${groupName}"; remove one of them`,
          { path: ["llm", legacyKey] },
        );
      }
      changes.push({
        path: ["llm", legacyKey],
        kind: "rename",
        message: `llm.${legacyKey} duplicates llm.model_chain group "${groupName}" and was dropped`,
      });
      return;
    }
    modelChain[groupName] = entries;
    modelChainChanged = true;
    changes.push({
      path: ["llm", legacyKey],
      kind: "transform",
      message: `llm.${legacyKey} was converted to llm.model_chain group "${groupName}" preserving entry order`,
    });
  };

  let working: Record<string, unknown> = llm;
  const dropKey = (key: string): void => {
    if (working === llm) {
      working = { ...llm };
    }
    delete working[key];
  };

  const rawModelChain = llm.model_chain;
  if (Array.isArray(rawModelChain)) {
    adoptGroup("default", rawModelChain, "model_chain");
    dropKey("model_chain");
  } else if (isPlainObject(rawModelChain)) {
    modelChain = { ...rawModelChain };
  } else if (rawModelChain !== undefined) {
    // Preserve invalid current shapes for the final schema to reject.
    return { document: root, changes: [] };
  }

  const rawFallback = llm.fallback_chain;
  if (rawFallback !== undefined && Array.isArray(rawFallback)) {
    adoptGroup("default", rawFallback, "fallback_chain");
    dropKey("fallback_chain");
  }

  const legacyTriageArrays: [string, unknown][] = [];
  for (const key of ["triage_fallback_chain", "triage_model_chain"] as const) {
    const value = llm[key];
    if (Array.isArray(value)) {
      legacyTriageArrays.push([key, value]);
    }
  }
  if (legacyTriageArrays.length > 0) {
    const [, entries] = legacyTriageArrays[0]!;
    for (const [key, other] of legacyTriageArrays.slice(1)) {
      if (!identicalContent(entries, other)) {
        throw new ConfigError(
          "conversion_conflict",
          `llm.${key} and llm.${legacyTriageArrays[0]![0]} are both legacy triage arrays with different content`,
          { path: ["llm", key] },
        );
      }
    }
    adoptGroup("triage", entries, legacyTriageArrays[0]![0]);
    for (const [key] of legacyTriageArrays) {
      dropKey(key);
    }
    const existingReference = llm.triage_model_chain;
    if (existingReference === undefined || Array.isArray(existingReference)) {
      triageReference = "triage";
      changes.push({
        path: ["llm", "triage_model_chain"],
        kind: "transform",
        message: 'llm.triage_model_chain now references the converted "triage" group',
      });
    } else if (existingReference !== "triage") {
      throw new ConfigError(
        "conversion_conflict",
        `llm.triage_model_chain already references group "${String(existingReference)}" while a legacy triage array exists`,
        { path: ["llm", "triage_model_chain"] },
      );
    }
  }

  if (changes.length === 0) {
    return { document: root, changes: [] };
  }
  const newLlm: Record<string, unknown> = { ...working };
  if (modelChainChanged || modelChain !== rawModelChain) {
    newLlm.model_chain = modelChain ?? {};
  }
  if (triageReference !== undefined) {
    newLlm.triage_model_chain = triageReference;
  }
  return { document: { ...root, llm: newLlm }, changes };
}

// ---------------------------------------------------------------------------
// Secret env reference validation (test C04)
// ---------------------------------------------------------------------------

export const SECRET_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface ConfigIssue {
  readonly code: "invalid_secret_env";
  readonly path: string;
  readonly message: string;
}

/**
 * Every `*_env` key in the config names an environment variable by
 * convention; values are never read here, so error output cannot leak
 * secrets. Malformed names are rejected because process.env lookup would
 * silently yield undefined at runtime.
 */
export function collectSecretEnvIssues(config: unknown): readonly ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const visit = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        const childPath = [...path, key];
        if (key.endsWith("_env") && entry !== undefined && (typeof entry !== "string" || !SECRET_ENV_NAME_PATTERN.test(entry))) {
          issues.push({
            code: "invalid_secret_env",
            path: formatConfigPath(childPath),
            message: `${formatConfigPath(childPath)} must name an environment variable matching ${SECRET_ENV_NAME_PATTERN.source}`,
          });
        }
        visit(entry, childPath);
      }
    }
  };
  visit(config, []);
  return issues;
}

export function assertNoSecretEnvIssues(config: unknown): void {
  const issues = collectSecretEnvIssues(config);
  if (issues.length > 0) {
    throw new ConfigError(
      "invalid_secret_env",
      `Invalid secret env references: ${issues.map((issue) => issue.path).join(", ")}`,
      { path: parseConfigPath(issues[0]!.path) },
    );
  }
}

// ---------------------------------------------------------------------------
// Database document model (spec §4.3)
// ---------------------------------------------------------------------------

export const DATABASE_ENTITY_COLLECTION_KEYS = [
  "providers",
  "model_groups",
  "triggers",
  "channels",
  "workspaces",
  "routes",
] as const;

export type DatabaseEntityCollectionKey = (typeof DATABASE_ENTITY_COLLECTION_KEYS)[number];

export const DATABASE_COLLECTION_KIND: Record<DatabaseEntityCollectionKey, ConfigEntityKind> = {
  providers: "provider",
  model_groups: "model_group",
  triggers: "trigger",
  channels: "channel",
  workspaces: "workspace",
  routes: "route",
};

export const DATABASE_KIND_COLLECTION: Record<ConfigEntityKind, DatabaseEntityCollectionKey> = {
  provider: "providers",
  model_group: "model_groups",
  trigger: "triggers",
  channel: "channels",
  workspace: "workspaces",
  route: "routes",
};

export type DatabaseEntityValue = Record<string, unknown> | Record<string, unknown>[];

export interface DatabaseEntityRecord {
  /** Stable record id, immutable across renames. */
  readonly id: string;
  /** Config-facing entity id (provider id, trigger name, map key, …). */
  readonly name: string;
  readonly enabled: boolean;
  readonly note?: string | undefined;
  readonly value: DatabaseEntityValue;
}

export const databaseEntityRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    note: z.string().optional(),
    value: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]),
  })
  .strict();

export interface DatabaseConfigDocument {
  readonly globals?: Record<string, unknown> | undefined;
  readonly entities?:
    | {
        readonly [K in DatabaseEntityCollectionKey]?: Record<string, DatabaseEntityRecord> | undefined;
      }
    | undefined;
}

export const databaseConfigDocumentSchema: z.ZodType<DatabaseConfigDocument> = z
  .object({
    globals: z.record(z.string(), z.unknown()).optional(),
    entities: z
      .object({
        providers: z.record(z.string().min(1), databaseEntityRecordSchema).optional(),
        model_groups: z.record(z.string().min(1), databaseEntityRecordSchema).optional(),
        triggers: z.record(z.string().min(1), databaseEntityRecordSchema).optional(),
        channels: z.record(z.string().min(1), databaseEntityRecordSchema).optional(),
        workspaces: z.record(z.string().min(1), databaseEntityRecordSchema).optional(),
        routes: z.record(z.string().min(1), databaseEntityRecordSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Global leaf prefixes a database document may manage (spec §4.1). */
export const DATABASE_GLOBAL_PREFIXES: readonly ConfigPath[] = [
  ["llm", "default_model_chain"],
  ["llm", "triage_model_chain"],
  ["llm", "retry"],
  ["llm", "per_provider_overrides"],
  ["llm", "budget"],
  ["llm", "model_catalog"],
  ["review"],
  ["compression"],
  ["agent"],
  ["outputs", "template_engine"],
  ["outputs", "no_problems"],
  ["outputs", "author_resolution"],
  ["outputs", "routes"],
  ["queue", "workers"],
  ["queue", "rate_limit"],
  ["queue", "retry"],
  ["queue", "dead_letter"],
  ["workspaces", "cache"],
  ["workspaces", "defaults"],
];

/** Bootstrap trust-boundary prefixes; the database may never write them. */
export const BOOTSTRAP_CONFIG_PREFIXES: readonly ConfigPath[] = [
  ["server"],
  ["admin"],
  ["storage"],
  ["config_sources"],
  ["queue", "kind"],
  ["queue", "sqlite"],
  ["workspaces", "root"],
];

function isPathPrefix(prefix: ConfigPath, path: ConfigPath): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

/** Asserts a single path is a database-writable global leaf prefix. */
export function assertDatabasePathAllowed(path: ConfigPath): void {
  if (path.some(isPrototypeKey)) {
    throw new ConfigError("prototype_key", "Database config paths must not contain prototype keys.", { path });
  }
  for (const collection of entityCollectionsForVersion(2)) {
    if (isPathPrefix(collection.path, path) || isPathPrefix(path, collection.path)) {
      throw new ConfigError(
        "entity_collection_misplaced",
        `${formatConfigPath(path)} is inside the ${collection.kind} entity collection; use entity operations instead of global set`,
        { path },
      );
    }
  }
  for (const prefix of BOOTSTRAP_CONFIG_PREFIXES) {
    if (isPathPrefix(prefix, path) || isPathPrefix(path, prefix)) {
      throw new ConfigError(
        "bootstrap_readonly",
        `${formatConfigPath(path)} belongs to the bootstrap trust boundary and is file-only (spec §4.1)`,
        { path },
      );
    }
  }
  if (!DATABASE_GLOBAL_PREFIXES.some((prefix) => isPathPrefix(prefix, path))) {
    throw new ConfigError(
      "bootstrap_readonly",
      `${formatConfigPath(path)} is not a database-manageable config prefix`,
      { path },
    );
  }
}

/** Validates every leaf of a database `globals` object against the allowlist. */
export function assertDatabaseGlobalsAllowed(globals: Record<string, unknown>): void {
  const visit = (value: unknown, path: string[]): void => {
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      for (const [key, entry] of Object.entries(value)) {
        if (isPrototypeKey(key)) {
          throw new ConfigError("prototype_key", `Database globals key "${key}" is a prototype key.`, {
            path: [...path, key],
          });
        }
        visit(entry, [...path, key]);
      }
      return;
    }
    // Empty objects and scalars/arrays are leaves; an empty globals root
    // declares nothing and is always valid.
    if (path.length === 0) {
      return;
    }
    assertDatabasePathAllowed(path);
    if (isPlainObject(value)) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertNoPrototypeKeys(entry, [...path, String(index)]));
    } else {
      assertNoPrototypeKeys(value, path);
    }
  };
  visit(globals, []);
}

export function validateDatabaseDocument(
  raw: unknown,
  formatVersion = 1,
): DatabaseConfigDocument {
  assertNoPrototypeKeys(raw, []);
  const document = databaseConfigDocumentSchema.parse(raw);
  if (document.entities?.routes !== undefined && formatVersion < 2) {
    throw new ConfigError(
      "unsupported_config_version",
      "Database routing rule records require config format version 2.",
      { path: ["entities", "routes"] },
    );
  }
  if (document.globals !== undefined) {
    assertDatabaseGlobalsAllowed(document.globals);
  }
  for (const key of DATABASE_ENTITY_COLLECTION_KEYS) {
    const records = document.entities?.[key];
    if (records === undefined) {
      continue;
    }
    const kind = DATABASE_COLLECTION_KIND[key];
    const collection = CONFIG_ENTITY_COLLECTIONS[kind];
    const seenNames = new Map<string, string>();
    for (const [recordId, record] of Object.entries(records)) {
      if (recordId !== record.id || isPrototypeKey(record.id) || isPrototypeKey(record.name)) {
        throw new ConfigError("entity_id_mismatch", "Database record keys must match safe immutable record ids and entity names.", {
          entity: { kind, id: record.name },
        });
      }
      if (kind === "model_group" ? !Array.isArray(record.value) : !isPlainObject(record.value)) {
        throw new ConfigError("entity_id_mismatch", `Database ${kind} has an invalid value shape.`, {
          entity: { kind, id: record.name },
        });
      }
      const existing = seenNames.get(record.name);
      if (existing !== undefined) {
        throw new ConfigError(
          "duplicate_entity",
          `Database records "${existing}" and "${record.id}" share the ${kind} name "${record.name}".`,
          { entity: { kind, id: record.name } },
        );
      }
      seenNames.set(record.name, record.id);
      if (collection.shape === "array" && collection.idField !== null && isPlainObject(record.value) && record.value[collection.idField] !== record.name) {
        throw new ConfigError(
          "entity_id_mismatch",
          `Database ${kind} record "${record.id}" is named "${record.name}" but value.${collection.idField} is ${String(record.value[collection.idField])}.`,
          { entity: { kind, id: record.name } },
        );
      }
    }
  }
  return document;
}

// ---------------------------------------------------------------------------
// Projection + merge with provenance (spec §4.2 rules 1-6)
// ---------------------------------------------------------------------------

export interface ProjectedDatabaseConfig {
  /** Config-shaped overlay containing globals and enabled, non-shadowed entities. */
  readonly overlay: AppConfigInput;
  readonly shadowedEntities: readonly ConfigEntityRef[];
}

export type FileEntityIds = Readonly<Record<ConfigEntityKind, ReadonlySet<string>>>;

export function collectFileEntityIds(file: AppConfigInput): FileEntityIds {
  const result: Partial<Record<ConfigEntityKind, Set<string>>> = {};
  for (const collection of entityCollectionsForVersion(2)) {
    const ids = new Set<string>();
    const node = getPathValue(file, collection.path);
    if (collection.shape === "array" && Array.isArray(node)) {
      for (const entry of node) {
        if (isPlainObject(entry) && typeof entry[collection.idField!] === "string") {
          ids.add(entry[collection.idField!] as string);
        }
      }
    } else if (collection.shape === "map" && isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        ids.add(key);
      }
    }
    result[collection.kind] = ids;
  }
  return result as FileEntityIds;
}

export function projectDatabaseDocument(
  document: DatabaseConfigDocument,
  fileEntityIds?: FileEntityIds,
  formatVersion = 1,
): ProjectedDatabaseConfig {
  const overlay: Record<string, unknown> = document.globals !== undefined ? cloneConfigValue(document.globals) : {};
  const shadowed: ConfigEntityRef[] = [];
  for (const collection of entityCollectionsForVersion(formatVersion)) {
    const key = DATABASE_KIND_COLLECTION[collection.kind];
    const records = document.entities?.[key];
    if (records === undefined) {
      continue;
    }
    const fileIds = fileEntityIds?.[collection.kind];
    const kept: [string, DatabaseEntityValue][] = [];
    for (const record of Object.values(records)) {
      if (!record.enabled) {
        continue;
      }
      if (fileIds?.has(record.name)) {
        // Restart-time file addition shadows the database record (F09); the
        // record itself stays visible/exportable/deletable in the store.
        shadowed.push({ kind: collection.kind, id: record.name });
        continue;
      }
      kept.push([record.name, cloneConfigValue(record.value)]);
    }
    if (kept.length === 0) {
      continue;
    }
    if (collection.shape === "array") {
      setPathValue(overlay, collection.path, kept.map(([, value]) => value));
    } else {
      setPathValue(overlay, collection.path, Object.fromEntries(kept));
    }
  }
  return { overlay: overlay as AppConfigInput, shadowedEntities: shadowed };
}

export type ConfigFieldSource = "file" | "database" | "default";

export interface MergedConfig {
  /** Raw merged config, ready for a single schema parse. */
  readonly document: AppConfigInput;
  /** Decision path (entity or leaf) → winning source; longest-prefix lookup. */
  readonly provenance: ReadonlyMap<string, "file" | "database">;
  /** File-owned decision paths: entity ids and leaf/subtree roots. */
  readonly fileLocks: ReadonlySet<string>;
  readonly fileEntityIds: FileEntityIds;
  readonly shadowedEntities: readonly ConfigEntityRef[];
  /** Database overlay including shadowed entities, for diagnostics only. */
  readonly databaseOverlay: AppConfigInput;
}

function cloneConfigValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneConfigValue(entry)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneConfigValue(entry)])) as T;
  }
  return value;
}

export function getPathValue(root: unknown, path: ConfigPath): unknown {
  let current = root;
  for (const segment of path) {
    if (!isPlainObject(current) && !Array.isArray(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setPathValue(root: Record<string, unknown>, path: ConfigPath, value: unknown): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

const EMPTY_ENTITY_IDS: FileEntityIds = {
  provider: new Set(),
  model_group: new Set(),
  trigger: new Set(),
  channel: new Set(),
  workspace: new Set(),
  route: new Set(),
};

/**
 * Merges the file overlay (highest priority) over the projected database
 * overlay (middle) without applying any schema defaults (spec §4.2 rules
 * 1-4). Entity collections merge by entity id with whole-entity file locks;
 * global objects merge per leaf with explicit empty arrays/false/0 kept
 * distinct from missing values. JSON null is a value, never a delete
 * instruction.
 */
export function mergeConfigSources(input: {
  readonly file?: AppConfigInput | undefined;
  readonly database?: DatabaseConfigDocument | undefined;
  readonly formatVersion?: number;
}): MergedConfig {
  const { file, database, formatVersion = 1 } = input;
  assertNoPrototypeKeys(file, []);
  const validDatabase = database === undefined ? undefined : validateDatabaseDocument(database, formatVersion);
  const fileEntityIds = file !== undefined ? collectFileEntityIds(file) : EMPTY_ENTITY_IDS;
  const projected = validDatabase === undefined
    ? { overlay: {} as AppConfigInput, shadowedEntities: [] }
    : projectDatabaseDocument(validDatabase, fileEntityIds, formatVersion);
  const databaseOverlay = validDatabase === undefined
    ? {} as AppConfigInput
    : projectDatabaseDocument(validDatabase, undefined, formatVersion).overlay;

  const provenance = new Map<string, "file" | "database">();
  const fileLocks = new Set<string>();
  const collections = new Map(entityCollectionsForVersion(formatVersion).map((collection) => [formatConfigPath(collection.path), collection]));

  const recordSource = (path: string[], source: "file" | "database"): void => {
    const formatted = formatConfigPath(path);
    provenance.set(formatted, source);
    if (source === "file") {
      fileLocks.add(formatted);
    }
  };

  const merge = (dbValue: unknown, fileValue: unknown, path: string[]): unknown => {
    const source = fileValue === undefined ? "database" : "file";
    const winner = fileValue === undefined ? dbValue : fileValue;
    const collection = collections.get(formatConfigPath(path));
    if (collection !== undefined && winner !== undefined) {
      const entriesOf = (node: unknown): [string, unknown][] | undefined => {
        if (node === undefined) {
          return [];
        }
        if (collection.shape === "map") {
          return isPlainObject(node) ? Object.entries(node) : undefined;
        }
        if (!Array.isArray(node) || node.some((entry) => !isPlainObject(entry) || typeof entry[collection.idField!] !== "string")) {
          return undefined;
        }
        return node.map((entry: Record<string, unknown>) => [entry[collection.idField!] as string, entry]);
      };
      const fileEntries = entriesOf(fileValue);
      const dbEntries = entriesOf(dbValue);
      if (fileEntries === undefined || dbEntries === undefined) {
        // Keep malformed input visible to the final schema; never erase it.
        recordSource(path, source);
        return cloneConfigValue(winner);
      }
      const ordered: [string, unknown][] = [];
      for (const [entrySource, entries] of [["file", fileEntries], ["database", dbEntries]] as const) {
        for (const [id, entry] of entries) {
          if (entrySource === "database" && fileEntityIds[collection.kind].has(id)) {
            continue;
          }
          ordered.push([id, cloneConfigValue(entry)]);
          recordSource([...path, id], entrySource);
        }
      }
      return collection.shape === "array" ? ordered.map(([, value]) => value) : Object.fromEntries(ordered);
    }

    // An empty global file mapping declares no leaf, including when the
    // database explicitly supplies null/false/zero/an array at this path.
    if (isPlainObject(fileValue) && Object.keys(fileValue).length === 0 && dbValue !== undefined) {
      return merge(dbValue, undefined, path);
    }

    // Only recurse through an object winner. A file scalar/null/array must
    // remain intact even when the database has entities below that path.
    if (isPlainObject(winner)) {
      const dbObject = isPlainObject(dbValue) ? dbValue : {};
      const fileObject = isPlainObject(fileValue) ? fileValue : {};
      return Object.fromEntries([...new Set([...Object.keys(dbObject), ...Object.keys(fileObject)])].map((key) => [
        key,
        merge(getPathValue(dbObject, [key]), getPathValue(fileObject, [key]), [...path, key]),
      ]));
    }
    if (winner !== undefined) {
      recordSource(path, source);
    }
    return cloneConfigValue(winner);
  };

  const document = merge(projected.overlay, file ?? {}, []) as AppConfigInput;

  return {
    document,
    provenance,
    fileLocks,
    fileEntityIds,
    shadowedEntities: projected.shadowedEntities,
    databaseOverlay,
  };
}

// ---------------------------------------------------------------------------
// Effective config view (spec §4.2 rule 6)
// ---------------------------------------------------------------------------

export interface ConfigFieldView {
  readonly path: string;
  readonly source: ConfigFieldSource;
  readonly editable: boolean;
  readonly effectiveValue: unknown;
  readonly overriddenValues: readonly { readonly source: "file" | "database"; readonly value: unknown }[];
}

function longestPrefixSource(provenance: ReadonlyMap<string, "file" | "database">, path: string[]): "file" | "database" | undefined {
  for (let length = path.length; length >= 0; length -= 1) {
    const source = provenance.get(formatConfigPath(path.slice(0, length)));
    if (source !== undefined) {
      return source;
    }
  }
  return undefined;
}

/**
 * Builds the per-field effective view over a parsed AppConfig. Fields absent
 * from both sources report `default`; `editable` is false for file-owned and
 * bootstrap trust-boundary fields. Entity collections are walked by entity
 * id so views stay stable across reordering.
 */
export function buildEffectiveConfigView(merged: MergedConfig, parsed: unknown): readonly ConfigFieldView[] {
  const view: ConfigFieldView[] = [];
  const collections = entityCollectionsForVersion(1);

  const isBootstrapLeaf = (path: string[]): boolean =>
    BOOTSTRAP_CONFIG_PREFIXES.some((prefix) => isPathPrefix(prefix, path) || isPathPrefix(path, prefix));

  const databaseValueAt = (path: ConfigPath): unknown => {
    let value: unknown = merged.databaseOverlay;
    for (let index = 0; index < path.length; index += 1) {
      const collection = collections.find((candidate) => formatConfigPath(candidate.path) === formatConfigPath(path.slice(0, index)));
      value = collection?.shape === "array" && Array.isArray(value)
        ? value.find((entry) => isPlainObject(entry) && entry[collection.idField!] === path[index])
        : getPathValue(value, [path[index]!]);
    }
    return value;
  };

  const visit = (value: unknown, path: string[]): void => {
    const collection = collections.find((candidate) => formatConfigPath(candidate.path) === formatConfigPath(path));
    if (collection !== undefined && value !== undefined) {
      const entries: [string, unknown][] = [];
      if (collection.shape === "array" && Array.isArray(value)) {
        for (const entry of value) {
          if (isPlainObject(entry) && typeof entry[collection.idField!] === "string") {
            entries.push([entry[collection.idField!] as string, entry]);
          }
        }
      } else if (collection.shape === "map" && isPlainObject(value)) {
        entries.push(...Object.entries(value));
      }
      for (const [id, entry] of entries) {
        visit(entry, [...path, id]);
      }
      return;
    }

    if (isPlainObject(value) && Object.keys(value).length > 0) {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, [...path, key]);
      }
      return;
    }

    const source = longestPrefixSource(merged.provenance, path) ?? "default";
    const overridden: { source: "file" | "database"; value: unknown }[] = [];
    if (source === "file") {
      const dbValue = databaseValueAt(path);
      if (dbValue !== undefined && !identicalContent(dbValue, value)) {
        overridden.push({ source: "database", value: dbValue });
      }
    }
    view.push({
      path: formatConfigPath(path),
      source,
      editable: source !== "file" && !isBootstrapLeaf(path),
      effectiveValue: value,
      overriddenValues: overridden,
    });
  };
  visit(parsed, []);
  return view;
}

// ---------------------------------------------------------------------------
// Entity references (tests C02/C03, P3 changeset validation)
// ---------------------------------------------------------------------------

export interface ConfigEntityReference {
  /** Formatted path of the referring field. */
  readonly from: string;
  readonly to: ConfigEntityRef;
}

/**
 * Collects v1 cross-entity references from a raw config-shaped document:
 * model-chain entries → providers, chain references → model groups, trigger
 * bindings → workspaces, channel trigger bindings, output routes → channels,
 * channel_overrides map keys → channels, per-provider maps → providers.
 * v2 routing rules extend this collector in P3.
 */
export function collectEntityReferences(config: AppConfigInput): readonly ConfigEntityReference[] {
  const references: ConfigEntityReference[] = [];
  const add = (from: ConfigPath, to: ConfigEntityRef): void => {
    references.push({ from: formatConfigPath(from), to });
  };
  const addGroupRef = (value: unknown, path: ConfigPath): void => {
    if (typeof value === "string" && value.length > 0) {
      add(path, { kind: "model_group", id: value });
    }
  };
  const addChannelRefs = (value: unknown, path: ConfigPath): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (typeof entry === "string" && entry.length > 0) {
          add([...path, String(index)], { kind: "channel", id: entry });
        }
      });
    }
  };
  const addWorkspaceOutputsRefs = (outputs: unknown, path: ConfigPath): void => {
    if (!isPlainObject(outputs)) {
      return;
    }
    addChannelRefs(outputs.line_comments, [...path, "line_comments"]);
    addChannelRefs(outputs.summary, [...path, "summary"]);
    if (isPlainObject(outputs.channel_overrides)) {
      for (const name of Object.keys(outputs.channel_overrides)) {
        add([...path, "channel_overrides", name], { kind: "channel", id: name });
      }
    }
  };

  const llm = config.llm;
  if (isPlainObject(llm)) {
    if (isPlainObject(llm.model_chain)) {
      for (const [group, entries] of Object.entries(llm.model_chain)) {
        if (Array.isArray(entries)) {
          entries.forEach((entry, index) => {
            if (isPlainObject(entry) && typeof entry.provider === "string" && entry.provider.length > 0) {
              add(["llm", "model_chain", group, String(index), "provider"], { kind: "provider", id: entry.provider });
            }
          });
        }
      }
    }
    addGroupRef(llm.default_model_chain, ["llm", "default_model_chain"]);
    addGroupRef(llm.triage_model_chain, ["llm", "triage_model_chain"]);
    if (isPlainObject(llm.per_provider_overrides)) {
      for (const id of Object.keys(llm.per_provider_overrides)) {
        add(["llm", "per_provider_overrides", id], { kind: "provider", id });
      }
    }
  }

  if (Array.isArray(config.triggers)) {
    config.triggers.forEach((trigger, index) => {
      if (isPlainObject(trigger) && Array.isArray(trigger.repos)) {
        trigger.repos.forEach((mapping: unknown, mappingIndex: number) => {
          if (isPlainObject(mapping) && typeof mapping.workspace === "string" && mapping.workspace.length > 0) {
            add(["triggers", String(index), "repos", String(mappingIndex), "workspace"], {
              kind: "workspace",
              id: mapping.workspace,
            });
          }
        });
      }
    });
  }

  const outputs = config.outputs;
  if (isPlainObject(outputs)) {
    if (Array.isArray(outputs.channels)) {
      outputs.channels.forEach((channel, index) => {
        if (isPlainObject(channel) && typeof channel.trigger === "string" && channel.trigger.length > 0) {
          add(["outputs", "channels", String(index), "trigger"], { kind: "trigger", id: channel.trigger });
        }
      });
    }
    if (isPlainObject(outputs.routes)) {
      const routes: [ConfigPath, unknown][] = [];
      if (outputs.routes.default !== undefined) {
        routes.push([["default"], outputs.routes.default]);
      }
      if (Array.isArray(outputs.routes.rules)) {
        outputs.routes.rules.forEach((rule: unknown, index: number) => routes.push([["rules", String(index)], rule]));
      }
      for (const [segments, rule] of routes) {
        if (isPlainObject(rule)) {
          addChannelRefs(rule.line_comments, ["outputs", "routes", ...segments, "line_comments"]);
          addChannelRefs(rule.summary, ["outputs", "routes", ...segments, "summary"]);
        }
      }
    }
  }

  const workspaces = config.workspaces;
  if (isPlainObject(workspaces)) {
    if (isPlainObject(workspaces.defaults)) {
      addGroupRef(workspaces.defaults.model_chain, ["workspaces", "defaults", "model_chain"]);
      addGroupRef(workspaces.defaults.triage_model_chain, ["workspaces", "defaults", "triage_model_chain"]);
      addWorkspaceOutputsRefs(workspaces.defaults.outputs, ["workspaces", "defaults", "outputs"]);
    }
    if (isPlainObject(workspaces.instances)) {
      for (const [id, instance] of Object.entries(workspaces.instances)) {
        if (!isPlainObject(instance)) {
          continue;
        }
        addGroupRef(instance.model_chain, ["workspaces", "instances", id, "model_chain"]);
        addGroupRef(instance.triage_model_chain, ["workspaces", "instances", id, "triage_model_chain"]);
        if (isPlainObject(instance.source_repo) && typeof instance.source_repo.trigger === "string") {
          add(["workspaces", "instances", id, "source_repo", "trigger"], {
            kind: "trigger",
            id: instance.source_repo.trigger,
          });
        }
        addWorkspaceOutputsRefs(instance.outputs, ["workspaces", "instances", id, "outputs"]);
      }
    }
  }

  const queue = config.queue;
  if (isPlainObject(queue) && isPlainObject(queue.rate_limit) && isPlainObject(queue.rate_limit.per_provider_rps)) {
    for (const id of Object.keys(queue.rate_limit.per_provider_rps)) {
      add(["queue", "rate_limit", "per_provider_rps", id], { kind: "provider", id });
    }
  }

  return references;
}

export function findReferencesTo(config: AppConfigInput, target: ConfigEntityRef): readonly ConfigEntityReference[] {
  return collectEntityReferences(config).filter((reference) => reference.to.kind === target.kind && reference.to.id === target.id);
}

// ---------------------------------------------------------------------------
// Changeset operations on the database document (pure; CAS lives in P2/P3)
// ---------------------------------------------------------------------------

export type ConfigChangesetOperation =
  | { readonly op: "create"; readonly collection: DatabaseEntityCollectionKey; readonly record: DatabaseEntityRecord }
  | { readonly op: "update"; readonly collection: DatabaseEntityCollectionKey; readonly recordId: string; readonly value: DatabaseEntityValue; readonly note?: string }
  | { readonly op: "delete"; readonly collection: DatabaseEntityCollectionKey; readonly recordId: string }
  | { readonly op: "rename"; readonly collection: DatabaseEntityCollectionKey; readonly recordId: string; readonly newName: string }
  | { readonly op: "set-enabled"; readonly collection: DatabaseEntityCollectionKey; readonly recordId: string; readonly enabled: boolean }
  | { readonly op: "set"; readonly path: ConfigPath; readonly value: unknown }
  | { readonly op: "unset"; readonly path: ConfigPath };

export interface ApplyChangesetContext {
  /** File-owned entity ids; creating/updating/shadowed records is rejected. */
  readonly fileEntityIds?: FileEntityIds | undefined;
  /** File-locked global leaves (from mergeConfigSources.fileLocks). */
  readonly fileLocks?: ReadonlySet<string> | undefined;
  readonly formatVersion?: number;
}

/**
 * Applies an atomic changeset to a database document. Every operation is
 * validated against file ownership (file_owned), the bootstrap boundary
 * (bootstrap_readonly), and entity identity rules before any change is
 * returned; on error no document is produced (all-or-nothing, test C09).
 * Shadowed records may only be deleted, never edited while a file entity
 * owns the same id.
 */
export function applyConfigChangeset(
  base: DatabaseConfigDocument,
  operations: readonly ConfigChangesetOperation[],
  context: ApplyChangesetContext = {},
): DatabaseConfigDocument {
  const { fileEntityIds = EMPTY_ENTITY_IDS, fileLocks, formatVersion = 1 } = context;
  const validatedBase = validateDatabaseDocument(base, formatVersion);
  assertNoPrototypeKeys(operations, []);
  const entities: {
    [K in DatabaseEntityCollectionKey]?: Record<string, DatabaseEntityRecord> | undefined;
  } = { ...validatedBase.entities };
  let globals = validatedBase.globals;

  const recordsOf = (collection: DatabaseEntityCollectionKey): Record<string, DatabaseEntityRecord> =>
    entities[collection] ?? {};

  const writeRecord = (collection: DatabaseEntityCollectionKey, record: DatabaseEntityRecord): void => {
    entities[collection] = { ...recordsOf(collection), [record.id]: record };
  };

  const requireRecord = (collection: DatabaseEntityCollectionKey, recordId: string): DatabaseEntityRecord => {
    const records = recordsOf(collection);
    const record = Object.hasOwn(records, recordId) ? records[recordId] : undefined;
    if (record === undefined) {
      throw new ConfigError("entity_not_found", `No ${DATABASE_COLLECTION_KIND[collection]} record "${recordId}".`);
    }
    return record;
  };

  const assertNotFileOwned = (collection: DatabaseEntityCollectionKey, name: string): void => {
    const kind = DATABASE_COLLECTION_KIND[collection];
    if (fileEntityIds[kind].has(name)) {
      throw new ConfigError(
        "file_owned",
        `${kind} "${name}" is owned by the config file and is read-only (spec §4.2 rule 5)`,
        { entity: { kind, id: name } },
      );
    }
  };

  const assertNameAvailable = (collection: DatabaseEntityCollectionKey, name: string, exceptRecordId?: string): void => {
    assertNotFileOwned(collection, name);
    for (const record of Object.values(recordsOf(collection))) {
      if (record.name === name && record.id !== exceptRecordId) {
        throw new ConfigError(
          "entity_exists",
          `${DATABASE_COLLECTION_KIND[collection]} name "${name}" is already used by record "${record.id}".`,
          { entity: { kind: DATABASE_COLLECTION_KIND[collection], id: name } },
        );
      }
    }
  };

  const assertGlobalPath = (path: ConfigPath): void => {
    assertDatabasePathAllowed(path);
    for (let depth = 1; depth < path.length; depth += 1) {
      const parent = getPathValue(globals, path.slice(0, depth));
      if (parent !== undefined && !isPlainObject(parent)) {
        throw new ConfigError("config_path_invalid", "Global operations must replace arrays and scalars as a whole.", { path });
      }
    }
  };

  for (const operation of operations) {
    switch (operation.op) {
      case "create": {
        if (operation.collection === "routes" && formatVersion < 2) {
          throw new ConfigError("unsupported_config_version", "Routing rule records require config format version 2.");
        }
        const record = databaseEntityRecordSchema.parse(operation.record);
        if (Object.hasOwn(recordsOf(operation.collection), record.id)) {
          throw new ConfigError(
            "entity_exists",
            `Record id "${record.id}" already exists in ${operation.collection}.`,
            { entity: { kind: DATABASE_COLLECTION_KIND[operation.collection], id: record.name } },
          );
        }
        assertNameAvailable(operation.collection, record.name);
        writeRecord(operation.collection, record);
        break;
      }
      case "update": {
        const record = requireRecord(operation.collection, operation.recordId);
        assertNotFileOwned(operation.collection, record.name);
        writeRecord(operation.collection, {
          ...record,
          value: cloneConfigValue(operation.value),
          ...(operation.note !== undefined ? { note: operation.note } : {}),
        });
        break;
      }
      case "delete": {
        const record = requireRecord(operation.collection, operation.recordId);
        const rest = { ...recordsOf(operation.collection) };
        delete rest[record.id];
        entities[operation.collection] = rest;
        break;
      }
      case "rename": {
        const record = requireRecord(operation.collection, operation.recordId);
        if (operation.newName.length === 0) {
          throw new ConfigError("entity_id_mismatch", "New entity name must not be empty.");
        }
        assertNotFileOwned(operation.collection, record.name);
        assertNameAvailable(operation.collection, operation.newName, record.id);
        const collection = CONFIG_ENTITY_COLLECTIONS[DATABASE_COLLECTION_KIND[operation.collection]];
        const value = cloneConfigValue(record.value);
        if (collection.shape === "array" && collection.idField !== null && isPlainObject(value)) {
          value[collection.idField] = operation.newName;
        }
        writeRecord(operation.collection, { ...record, name: operation.newName, value });
        break;
      }
      case "set-enabled": {
        const record = requireRecord(operation.collection, operation.recordId);
        assertNotFileOwned(operation.collection, record.name);
        writeRecord(operation.collection, { ...record, enabled: operation.enabled });
        break;
      }
      case "set": {
        assertGlobalPath(operation.path);
        const formatted = formatConfigPath(operation.path);
        for (const lock of fileLocks ?? []) {
          const lockPath = parseConfigPath(lock);
          if (isPathPrefix(lockPath, operation.path) || isPathPrefix(operation.path, lockPath)) {
            throw new ConfigError(
              "file_owned",
              `${formatted} is locked by the config file at ${lock || "<root>"} (spec §4.2 rule 5)`,
              { path: operation.path },
            );
          }
        }
        const next = globals !== undefined ? cloneConfigValue(globals) : {};
        setPathValue(next, operation.path, cloneConfigValue(operation.value));
        globals = next;
        break;
      }
      case "unset": {
        assertGlobalPath(operation.path);
        if (globals === undefined || getPathValue(globals, operation.path) === undefined) {
          throw new ConfigError(
            "path_not_overridden",
            `${formatConfigPath(operation.path)} has no database override to remove.`,
            { path: operation.path },
          );
        }
        const next = cloneConfigValue(globals);
        const parent = getPathValue(next, operation.path.slice(0, -1));
        if (isPlainObject(parent)) {
          delete parent[operation.path[operation.path.length - 1]!];
        }
        // Prune emptied intermediate objects so the removal leaves no `{}`
        // residue that would re-materialize in the merged document.
        for (let depth = operation.path.length - 1; depth >= 1; depth -= 1) {
          const node = getPathValue(next, operation.path.slice(0, depth));
          if (!isPlainObject(node) || Object.keys(node).length > 0) {
            break;
          }
          const ancestor = getPathValue(next, operation.path.slice(0, depth - 1));
          if (isPlainObject(ancestor)) {
            delete ancestor[operation.path[depth - 1]!];
          }
        }
        globals = next;
        break;
      }
    }
  }

  const result: DatabaseConfigDocument = {
    ...(globals !== undefined ? { globals } : {}),
    ...(Object.keys(entities).length > 0 ? { entities } : {}),
  };
  // Structural validation of the outcome; callers still re-validate the
  // merged effective config (references, schema) before publishing.
  return validateDatabaseDocument(result, formatVersion);
}

/**
 * Copies a file-owned entity into a database draft with a new name (spec
 * §4.2 rule 7). Secret references (env names) are copied verbatim; the
 * returned references list every place still pointing at the original
 * entity so the caller can rewire them in the same changeset (test F11).
 */
export function copyFileEntityAsDatabaseDraft(
  file: AppConfigInput,
  target: ConfigEntityRef,
  newRecordId: string,
  newName: string,
): { readonly record: DatabaseEntityRecord; readonly references: readonly ConfigEntityReference[] } {
  const collection = CONFIG_ENTITY_COLLECTIONS[target.kind];
  const node = getPathValue(file, collection.path);
  let value: unknown;
  if (collection.shape === "array" && Array.isArray(node)) {
    value = node.find(
      (entry) => isPlainObject(entry) && entry[collection.idField!] === target.id,
    );
  } else if (collection.shape === "map" && isPlainObject(node)) {
    value = node[target.id];
  }
  if (value === undefined || (target.kind === "model_group" ? !Array.isArray(value) : !isPlainObject(value))) {
    throw new ConfigError("entity_not_found", `File ${target.kind} "${target.id}" does not exist.`, {
      entity: target,
    });
  }
  const cloned = cloneConfigValue(value) as DatabaseEntityValue;
  if (newName === target.id || newName.length === 0 || newRecordId.length === 0 || isPrototypeKey(newName) || isPrototypeKey(newRecordId)) {
    throw new ConfigError("entity_id_mismatch", "A file entity copy requires a new safe name and a non-empty safe record id.");
  }
  if (collectFileEntityIds(file)[target.kind].has(newName)) {
    throw new ConfigError("entity_exists", "The copied entity name already belongs to a file entity.");
  }
  if (collection.shape === "array" && collection.idField !== null && isPlainObject(cloned)) {
    cloned[collection.idField] = newName;
  }
  return {
    record: { id: newRecordId, name: newName, enabled: true, value: cloned },
    references: findReferencesTo(file, target),
  };
}
