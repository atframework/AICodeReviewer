/**
 * ConfigUiSpec runtime protocol (architecture §3.16, P6). Serializable description of the
 * config management UI plus the five pure function families that operate on it:
 * validateUiSpec, decodeDraft, encodeChanges, resolveFieldState, resolveOptions.
 *
 * Browser-safety contract: ZERO runtime imports. `import type` only (erased at
 * compile). The compiled file is copied into the server dashboard assets and
 * served verbatim to the browser; it must not reference zod, node, or any
 * sibling module at runtime.
 *
 * Conventions (frozen with CoreSpec/CoreFormState):
 * - Globals-scope field ids are "<firstPathToken>:<rest>" with FULL path tokens
 *   from the document root; entity-scope field ids are "<entityKind>:<relPath>"
 *   with record-relative tokens. A field belongs to the entity scope iff the
 *   page has an entity and the id starts with "<entityKind>:".
 * - Map collections (model_group, workspace) carry a synthetic name field
 *   "<kind>:$name" with path []; model_group's array value is carried by a
 *   single ordered-list field with path [].
 * - Entity drafts always contain a synthetic "$extras" draft field holding the
 *   record-value keys not covered by any spec field (U17 passthrough).
 * - Path tokens are raw keys when they match PATH_TOKEN_RE, otherwise the
 *   encodeMapKey escape form ("~" + 4 uppercase hex digits per unsafe UTF-16
 *   code unit). Tokens are unescaped before addressing raw record values.
 */

import type { ConfigUiControlKind } from "./config-components.js";

// ---------------------------------------------------------------------------
// Controls and values
// ---------------------------------------------------------------------------

/**
 * The control union is owned by the field inventory (config-components.ts);
 * re-exported here type-only so the paradigm protocol reads as one module.
 * Type-only re-export is erased at compile — the zero-runtime-import contract
 * above still holds for the browser-served artifact.
 */
export type { ConfigUiControlKind };

export type ConfigUiValueKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "string[]"
  | "number[]"
  | "enum[]"
  | "record"
  | "union"
  | "never";

export interface ConfigUiOption {
  /** Trusted completion text for path-template variables. */
  readonly insertText?: string;
  readonly value: string;
  readonly label?: string;
  readonly disabled?: boolean;
}

export interface ConfigUiVisibleWhen {
  /** Field id within the same page. */
  readonly field: string;
  /** Boolean equality, or array-contains semantics for multiselect fields. */
  readonly equals: string | boolean;
}

export interface ConfigUiField {
  /** Unique within the spec: "<scope>:<path>", e.g. "provider:kind". */
  readonly id: string;
  /** Tokens relative to the editor scope root (entity record or global doc). */
  readonly path: readonly string[];
  readonly control: ConfigUiControlKind;
  readonly valueKind: ConfigUiValueKind;
  readonly labelKey: string;
  readonly label: string;
  /** Section id within the page. */
  readonly section: string;
  /** True when absent is valid (schema default or optional field). */
  readonly optional: boolean;
  readonly binding: "value" | "inherit-or-override";
  readonly hasDefault: boolean;
  readonly defaultValue?: unknown;
  readonly options?: readonly ConfigUiOption[];
  /** Dynamic options source id (served by GET /options/:source). */
  readonly optionsSource?: string;
  readonly visibleWhen?: ConfigUiVisibleWhen;
  /** Entity `kind` values this field applies to (capability matrix). */
  readonly kinds?: readonly string[];
  /** Human explanation of capability limits. */
  readonly capability?: string;
  /** Set when never editable (bootstrap-owned, schema-only, removed alias). */
  readonly readonlyReason?: string;
  /** Ordered-list row object fields. */
  readonly itemFields?: readonly ConfigUiField[];
  /** Map control value type. */
  readonly mapValueKind?: "string" | "number" | "record" | "credential";
}

export interface ConfigUiSection {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly ConfigUiField[];
  readonly collapsed?: boolean;
}

export type ConfigUiEntityKind = "provider" | "model_group" | "trigger" | "channel" | "workspace" | "route" | "template" | "prompt";

export interface ConfigUiPage {
  readonly id: string;
  readonly label: string;
  readonly entity?: {
    readonly kind: ConfigUiEntityKind;
    /** Database collection key (plural). */
    readonly collection: string;
    /** Field holding the entity id for array collections; null for maps. */
    readonly idField: string | null;
    readonly valueShape: "object" | "array" | "string";
    readonly kindField?: string;
    readonly kindOptions?: readonly string[];
  };
  /** Page also edits global document paths (set/unset scope). */
  readonly globals?: boolean;
  readonly sections: readonly ConfigUiSection[];
}

export interface ConfigUiSpec {
  readonly protocolVersion: 1;
  readonly pages: readonly ConfigUiPage[];
  readonly optionsSources: readonly { readonly id: string; readonly label: string }[];
}

// ---------------------------------------------------------------------------
// Draft model
// ---------------------------------------------------------------------------

export interface ConfigDraftField {
  readonly id: string;
  /** Entity fields: present-in-record vs absent (schema default applies). */
  readonly mode: "present" | "absent";
  /** inherit-or-override binding: true = inherit (encode absent/unset). */
  readonly inherit: boolean;
  /** Current edited value in control shape (see module docs in tests). */
  readonly value: unknown;
  /** Server-provided effective value for display. */
  readonly effectiveValue: unknown;
  readonly provenance: "file" | "database" | "default" | "none";
  readonly overriddenValues: readonly { readonly source: "file" | "database"; readonly value: unknown }[];
  /**
   * Server-side write permission from the fields view; only set on globals
   * drafts. File-provenance globals under database-priority prefixes stay
   * editable (§3.15 exception) because the database wins there.
   */
  readonly editable?: boolean | undefined;
  /** Unknown passthrough keys preserved losslessly (entity drafts). */
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface ConfigDraft {
  readonly scope:
    | { readonly kind: "entity"; readonly collection: string; readonly recordId: string | null }
    | { readonly kind: "globals"; readonly prefix: readonly string[] };
  readonly fields: Readonly<Record<string, ConfigDraftField>>;
  readonly baseRevision: number | null;
  readonly fileDigest: string;
}

export interface ConfigFieldViewEntry {
  readonly path: string;
  readonly source: "file" | "database" | "default";
  readonly editable: boolean;
  readonly effectiveValue: unknown;
  readonly overriddenValues: readonly { readonly source: "file" | "database"; readonly value: unknown }[];
}

export interface ConfigEntityRecordView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly note?: string;
  readonly value: unknown;
  readonly source: "file" | "database";
  readonly readonly: boolean;
  readonly shadowedByFile: boolean;
  readonly effectiveValue: unknown;
}

export interface ConfigDecodeInput {
  /** Present on entity pages; null when creating a new record. */
  readonly record?: ConfigEntityRecordView | null;
  /** Present on globals pages: flattened field views (formatted paths). */
  readonly fields?: readonly ConfigFieldViewEntry[];
  readonly baseRevision: number | null;
  readonly fileDigest: string;
}

export type ConfigUiOperation =
  | { readonly op: "rename"; readonly collection: string; readonly recordId: string; readonly newName: string }
  | { readonly op: "create"; readonly collection: string; readonly record: unknown }
  | { readonly op: "update"; readonly collection: string; readonly recordId: string; readonly value: unknown; readonly note?: string }
  | { readonly op: "set"; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: "unset"; readonly path: readonly string[] };

export interface ConfigUiIssue {
  readonly code:
    | "duplicate_field_id"
    | "missing_section"
    | "missing_label"
    | "unknown_path"
    | "prototype_key"
    | "incompatible_control"
    | "unknown_options_source"
    | "unknown_visible_when"
    | "visible_when_cycle"
    | "invalid_spec";
  readonly message: string;
  readonly fieldId?: string;
}

export interface ConfigFieldState {
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly options: readonly ConfigUiOption[];
  readonly optionsError?: string;
  readonly error?: string;
}

export interface ConfigReferenceData {
  readonly source: string;
  readonly options: readonly ConfigUiOption[];
  readonly error?: string;
}

export interface ConfigApiFieldError {
  readonly code?: string;
  readonly message: string;
  readonly path?: readonly string[];
  readonly entity?: { readonly kind: string; readonly id: string };
}

// ---------------------------------------------------------------------------
// Internal helpers (module-private; zero-import rule)
// ---------------------------------------------------------------------------

type ConfigUiPageEntity = NonNullable<ConfigUiPage["entity"]>;

/** Spec path token: raw key form (dots allowed inside a single token). */
const PATH_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** Characters carried verbatim by encodeMapKey. */
const MAP_KEY_SAFE_RE = /^[A-Za-z0-9_-]$/u;
/** config-matcher draft control shape. */
interface MatcherDraftValue {
  readonly mode: "exact" | "glob" | "regex";
  readonly pattern: string;
  readonly ignore_case: boolean;
}

const SECRET_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** Redaction masks produced by the server; never legitimate values (U10). */
const SECRET_MASK_VALUES: readonly string[] = ["configured", "•••"];
const PROTOTYPE_KEYS: Readonly<Record<string, true>> = Object.fromEntries(
  ["__proto__", "prototype", "constructor"].map((key) => [key, true]),
);

/** Sentinel returned by encodeFieldValue for "treat as absent" (secret-ref ""). */
const SKIP = Symbol("config-ui-runtime.skip");

/** U03 control/valueKind compatibility matrix. */
const CONTROL_VALUE_KINDS: Readonly<Record<string, readonly ConfigUiValueKind[]>> = {
  text: ["string", "union"],
  document: ["string"],
  number: ["number"],
  toggle: ["boolean"],
  select: ["enum", "string", "union"],
  multiselect: ["string[]", "enum[]", "number[]"],
  "ordered-list": ["record"],
  map: ["record"],
  "secret-ref": ["string"],
  "secret-value": ["string"],
  matcher: ["union", "record"],
  "path-template": ["string"],
};

function isPrototypeKeyExact(segment: string): boolean {
  return Object.hasOwn(PROTOTYPE_KEYS, segment);
}

function isPrototypeKeyCaseInsensitive(segment: string): boolean {
  return isPrototypeKeyExact(segment.toLowerCase());
}

/** Raw record keys for a spec path (unescapes encodeMapKey tokens). */
function fieldPathKeys(field: ConfigUiField): readonly string[] {
  return field.path.map((token) => (token.includes("~") ? decodeMapKey(token) : token));
}

function isNameField(entity: ConfigUiPageEntity, field: ConfigUiField): boolean {
  return field.id === `${entity.kind}:$name`;
}

function collectPageFields(page: ConfigUiPage): ConfigUiField[] {
  const fields: ConfigUiField[] = [];
  for (const section of page.sections) {
    fields.push(...section.fields);
  }
  return fields;
}

function scopedEntityFields(page: ConfigUiPage, entity: ConfigUiPageEntity): ConfigUiField[] {
  const prefix = `${entity.kind}:`;
  return collectPageFields(page).filter((field) => field.id.startsWith(prefix));
}

function scopedGlobalFields(page: ConfigUiPage): ConfigUiField[] {
  const fields = collectPageFields(page);
  const entity = page.entity;
  if (entity === undefined) {
    return fields;
  }
  const prefix = `${entity.kind}:`;
  return fields.filter((field) => !field.id.startsWith(prefix));
}

/**
 * Raw config-path keys of a page's globals-scope fields (fieldPathKeys over
 * scopedGlobalFields). The config API uses them as the GET /fields?page=
 * filter set; empty paths (document-value fields) never scope globals and are
 * dropped.
 */
export function pageGlobalsFieldPaths(page: ConfigUiPage): readonly (readonly string[])[] {
  return scopedGlobalFields(page)
    .map((field) => fieldPathKeys(field))
    .filter((keys) => keys.length > 0);
}

function findField(page: ConfigUiPage, fieldId: string): ConfigUiField | undefined {
  for (const section of page.sections) {
    for (const field of section.fields) {
      if (field.id === fieldId) {
        return field;
      }
      for (const item of field.itemFields ?? []) {
        if (item.id === fieldId) {
          return item;
        }
      }
    }
  }
  return undefined;
}

/** Sets an own property without triggering the "__proto__" setter. */
function defineValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  target[key] = value;
}

function deepCloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepCloneValue);
  }
  if (isPlainRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      defineValue(clone, key, deepCloneValue(entry));
    }
    return clone;
  }
  return value;
}

/** Reads a value by raw key tokens; found tracks key EXISTENCE (null/0/false count). */
function getIn(container: unknown, path: readonly string[]): { found: boolean; value: unknown } {
  let current = container;
  for (const token of path) {
    if (isPlainRecord(current)) {
      if (!Object.hasOwn(current, token)) {
        return { found: false, value: undefined };
      }
      current = current[token];
      continue;
    }
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    return { found: false, value: undefined };
  }
  return { found: true, value: current };
}

/** Immutable set-in; creates plain objects for missing containers. */
function setIn(container: unknown, path: readonly string[], value: unknown): unknown {
  const head = path[0];
  if (head === undefined) {
    return value;
  }
  if (isPrototypeKeyExact(head)) {
    throw new TypeError(`encodeChanges: refusing prototype path token "${head}".`);
  }
  if (Array.isArray(container)) {
    // Only reachable for paths that traverse existing arrays (nested rows).
    const next = container.slice();
    next[Number(head)] = setIn(container[Number(head)], path.slice(1), value);
    return next;
  }
  const base: Record<string, unknown> = {};
  if (isPlainRecord(container)) {
    for (const [key, entry] of Object.entries(container)) {
      defineValue(base, key, entry);
    }
  }
  defineValue(base, head, setIn(base[head], path.slice(1), value));
  return base;
}

/**
 * Shared deep equality for plain config data: null/undefined are distinct,
 * arrays are ordered, object key order is ignored, NaN is never equal (U05
 * diffing). Exported for config-form-state; the only sanctioned implementation
 * in the UI paradigm modules.
 */
export function deepConfigEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!deepConfigEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key) || !deepConfigEqual(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function assertNoPrototypeKeysDeep(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoPrototypeKeysDeep(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isPrototypeKeyExact(key)) {
      throw new TypeError(`encodeChanges: refusing prototype key "${key}" at ${path}.`);
    }
    assertNoPrototypeKeysDeep(entry, `${path}.${key}`);
  }
}

// ---------- matcher control shape (configMatcherSchema parity) ----------

function decodeMatcherValue(raw: unknown): MatcherDraftValue | null {
  if (!isPlainRecord(raw)) {
    return null;
  }
  const keys = Object.keys(raw);
  const modes = keys.filter((key): key is "exact" | "glob" | "regex" => key === "exact" || key === "glob" || key === "regex");
  if (modes.length !== 1) {
    return null;
  }
  const mode = modes[0]!;
  if (!keys.every((key) => key === mode || key === "ignore_case")) {
    return null;
  }
  const pattern = raw[mode];
  if (typeof pattern !== "string") {
    return null;
  }
  const ignoreCase = raw["ignore_case"];
  if (ignoreCase !== undefined && typeof ignoreCase !== "boolean") {
    return null;
  }
  if (mode === "exact" && keys.length !== 1) {
    return null;
  }
  return { mode, pattern, ignore_case: ignoreCase === true };
}

function isMatcherControlValue(value: unknown): value is MatcherDraftValue {
  if (!isPlainRecord(value)) {
    return false;
  }
  const mode = value["mode"];
  if (mode !== "exact" && mode !== "glob" && mode !== "regex") {
    return false;
  }
  if (typeof value["pattern"] !== "string") {
    return false;
  }
  const ignoreCase = value["ignore_case"];
  return ignoreCase === undefined || typeof ignoreCase === "boolean";
}

function encodeMatcherValue(value: MatcherDraftValue): Record<string, unknown> {
  if (value.mode === "exact") {
    return { exact: value.pattern };
  }
  if (value.ignore_case) {
    return { [value.mode]: value.pattern, ignore_case: true };
  }
  return { [value.mode]: value.pattern };
}

// ---------- control shapes ----------

/** Control-empty value used when a field is absent and has no static default. */
function controlEmptyValue(field: ConfigUiField): unknown {
  switch (field.control) {
    case "text":
    case "document":
    case "secret-ref":
    case "secret-value":
    case "path-template":
      return "";
    case "multiselect":
    case "ordered-list":
    case "map":
      return [];
    case "matcher":
      return { mode: "exact", pattern: "", ignore_case: false };
    case "number":
    case "toggle":
    case "select":
      return undefined;
  }
}

/** Internal key sheltering a row's own literal `_rowId` data key (U17). */
const ROW_ID_DATA_KEY = "\0_rowId";

function toRowShape(itemFields: readonly ConfigUiField[], row: unknown, index: number): Record<string, unknown> {
  let shaped: Record<string, unknown> = {};
  if (isPlainRecord(row)) {
    for (const [key, entry] of Object.entries(row)) {
      defineValue(shaped, key === "_rowId" ? ROW_ID_DATA_KEY : key, deepCloneValue(entry));
    }
  }
  shaped["_rowId"] = `r${index + 1}`;
  for (const itemField of itemFields) {
    const keys = fieldPathKeys(itemField);
    const found = getIn(shaped, keys);
    if (!found.found) {
      continue;
    }
    shaped = setIn(shaped, keys, toControlShape(itemField, found.value).value) as Record<string, unknown>;
  }
  return shaped;
}

/**
 * Converts a raw record/effective value into the draft control shape. `ok` is
 * false only for malformed matcher values; the raw value is then preserved so
 * resolveFieldState can surface "unrecognized matcher shape" (U11).
 */
function toControlShape(field: ConfigUiField, raw: unknown): { ok: boolean; value: unknown } {
  if (field.control === "matcher") {
    const decoded = decodeMatcherValue(raw);
    return decoded === null ? { ok: false, value: raw } : { ok: true, value: decoded };
  }
  if (field.control === "ordered-list") {
    if (!Array.isArray(raw)) {
      return { ok: true, value: [] };
    }
    const itemFields = field.itemFields;
    if (itemFields === undefined || itemFields.length === 0) {
      return { ok: true, value: raw.map(deepCloneValue) };
    }
    return { ok: true, value: raw.map((row, index) => toRowShape(itemFields, row, index)) };
  }
  if (field.control === "map") {
    if (!isPlainRecord(raw)) {
      return { ok: true, value: [] };
    }
    return {
      ok: true,
      value: Object.entries(raw).map(([key, entry], index) => ({
        _rowId: `r${index + 1}`,
        key,
        value: field.itemFields ? toRowShape(field.itemFields, entry, index) : deepCloneValue(entry),
      })),
    };
  }
  if (field.control === "multiselect") {
    if (!Array.isArray(raw)) {
      return { ok: true, value: [] };
    }
    return { ok: true, value: Array.from(new Set(raw)) };
  }
  return { ok: true, value: deepCloneValue(raw) };
}

function encodeRow(itemFields: readonly ConfigUiField[], row: unknown): unknown {
  if (!isPlainRecord(row)) {
    return deepCloneValue(row);
  }
  let encoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(row)) {
    if (key === "_rowId") {
      continue;
    }
    defineValue(encoded, key === ROW_ID_DATA_KEY ? "_rowId" : key, deepCloneValue(entry));
  }
  for (const itemField of itemFields) {
    const keys = fieldPathKeys(itemField);
    const found = getIn(encoded, keys);
    if (!found.found) {
      continue;
    }
    const value = encodeFieldValue(itemField, found.value);
    encoded = setIn(encoded, keys, value === SKIP ? undefined : value) as Record<string, unknown>;
  }
  return encoded;
}

function materializeMapValue(field: ConfigUiField, entries: readonly unknown[], previous?: unknown): Record<string, unknown> {
  const materialized: Record<string, unknown> = {};
  for (const entry of entries) {
    if (!isPlainRecord(entry) || typeof entry["key"] !== "string") {
      throw new TypeError(`encodeChanges: map field "${field.id}" rows must be objects with a string key.`);
    }
    const key = entry["key"];
    if (isPrototypeKeyExact(key)) {
      throw new TypeError(`encodeChanges: map field "${field.id}" uses prototype key "${key}".`);
    }
    if (Object.hasOwn(materialized, key)) {
      throw new TypeError(`encodeChanges: map field "${field.id}" has duplicate key "${key}".`);
    }
    let value = field.itemFields ? encodeRow(field.itemFields, entry["value"]) : deepCloneValue(entry["value"]);
    if (field.mapValueKind === "credential") {
      if (isPlainRecord(value)) {
        const literal = encodeFieldValue({ ...field, control: "secret-value" }, value.value);
        value = literal === SKIP ? {} : literal === null ? null : { value: literal };
      } else {
        const ref = encodeFieldValue({ ...field, control: "secret-ref" }, value);
        value = ref === SKIP ? null : ref;
      }
    }
    defineValue(materialized, key, value);
  }
  if (field.mapValueKind === "credential" && isPlainRecord(previous)) {
    for (const key of Object.keys(previous)) if (!Object.hasOwn(materialized, key)) defineValue(materialized, key, null);
  }
  return materialized;
}

/**
 * Converts a draft control-shaped value back to the raw record shape. Returns
 * SKIP for values that encode as absent (empty secret-ref). Throws TypeError
 * on credential-mask leakage, invalid secret env names, prototype keys, and
 * duplicate map keys — the draft is assumed valid, these are defensive.
 */
function encodeFieldValue(field: ConfigUiField, value: unknown, previous?: unknown): unknown {
  if (field.control === "secret-ref") {
    if (value === undefined || value === null || value === "") {
      return SKIP;
    }
    if (typeof value !== "string") {
      throw new TypeError(`encodeChanges: secret-ref field "${field.id}" value must be a string.`);
    }
    if (SECRET_MASK_VALUES.includes(value)) {
      throw new TypeError(
        `encodeChanges: secret-ref field "${field.id}" holds the credential mask "${value}"; masks are never persisted as secret references.`,
      );
    }
    if (!SECRET_ENV_NAME_RE.test(value)) {
      throw new TypeError(
        `encodeChanges: secret-ref field "${field.id}" value "${value}" is not an environment variable name matching ${SECRET_ENV_NAME_RE.source}.`,
      );
    }
    return value;
  }
  if (field.control === "secret-value") {
    // Literal credential semantics (server-side carry-over): an untouched
    // masked value encodes as ABSENT so the stored secret survives the
    // wholesale entity update; "" encodes as JSON null = explicit clear;
    // anything else is the new literal.
    if (value === undefined || value === null) {
      return SKIP;
    }
    if (typeof value !== "string") {
      throw new TypeError(`encodeChanges: secret-value field "${field.id}" value must be a string.`);
    }
    if (value === "") {
      return null;
    }
    if (SECRET_MASK_VALUES.includes(value) || /<redacted>/iu.test(value)) {
      return SKIP;
    }
    return value;
  }
  if (field.control === "matcher") {
    return isMatcherControlValue(value) ? encodeMatcherValue(value) : deepCloneValue(value);
  }
  if (field.control === "multiselect") {
    return Array.isArray(value) ? Array.from(new Set(value)) : deepCloneValue(value);
  }
  if (field.control === "ordered-list") {
    if (!Array.isArray(value)) {
      return deepCloneValue(value);
    }
    const itemFields = field.itemFields;
    if (itemFields === undefined || itemFields.length === 0) {
      return value.map(deepCloneValue);
    }
    return value.map((row) => encodeRow(itemFields, row));
  }
  if (field.control === "map") {
    if (!Array.isArray(value)) {
      return deepCloneValue(value);
    }
    return materializeMapValue(field, value, previous);
  }
  return deepCloneValue(value);
}

// ---------- formatted path parsing (formatConfigPath inverse, non-throwing) ----------

/** Non-throwing inverse of formatConfigPath; null on malformed input. */
function parseFormattedConfigPath(text: string): readonly string[] | null {
  const segments: string[] = [];
  let index = 0;
  if (text.length === 0) {
    return [];
  }
  while (index < text.length) {
    let segment: string;
    if (text[index] === "[") {
      const quoted = /^\[("(?:[^"\\]|\\.)*")\]/u.exec(text.slice(index));
      if (quoted === null) {
        return null;
      }
      try {
        segment = JSON.parse(quoted[1]!) as string;
      } catch {
        return null;
      }
      index += quoted[0].length;
    } else {
      if (index > 0) {
        if (text[index] !== ".") {
          return null;
        }
        index += 1;
      }
      const match = /^[A-Za-z0-9][A-Za-z0-9_-]*/u.exec(text.slice(index));
      if (match === null) {
        return null;
      }
      segment = match[0];
      index += match[0].length;
    }
    segments.push(segment);
  }
  return segments;
}

function tokensEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function tokensPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((token, index) => token === path[index]);
}

/**
 * True when a formatted field-view path (formatConfigPath form) equals one of
 * the key token arrays or sits below it — the same exact-or-descendant rule
 * lookupFieldEntry applies. Malformed paths never match.
 */
export function fieldViewEntryInScope(path: string, keys: readonly (readonly string[])[]): boolean {
  const segments = parseFormattedConfigPath(path);
  if (segments === null) return false;
  return keys.some((key) => key.length > 0 && segments.length >= key.length && tokensPrefix(key, segments));
}

function commonPathPrefix(paths: readonly (readonly string[])[]): readonly string[] {
  const first = paths[0];
  if (first === undefined) {
    return [];
  }
  let length = first.length;
  for (const path of paths.slice(1)) {
    let index = 0;
    while (index < length && index < path.length && path[index] === first[index]) {
      index += 1;
    }
    length = index;
  }
  return first.slice(0, length);
}

// ---------- globals fields view lookup ----------

interface ParsedFieldEntry {
  readonly entry: ConfigFieldViewEntry;
  readonly segments: readonly string[];
}

interface FieldEntryInfo {
  readonly source: "file" | "database" | "default" | "none";
  readonly effectiveValue: unknown;
  readonly overriddenValues: readonly { readonly source: "file" | "database"; readonly value: unknown }[];
  /** Server-side write permission; absent when no view entry exists. */
  readonly editable?: boolean | undefined;
}

function indexFieldEntries(entries: readonly ConfigFieldViewEntry[] | undefined): ParsedFieldEntry[] {
  const index: ParsedFieldEntry[] = [];
  if (entries === undefined) {
    return index;
  }
  for (const entry of entries) {
    const segments = parseFormattedConfigPath(entry.path);
    if (segments === null) {
      continue;
    }
    index.push({ entry, segments });
  }
  return index;
}

/**
 * Locates a globals field in the flattened fields view. Leaf fields match an
 * entry exactly; composite (map/record) fields are rebuilt from descendant
 * leaf entries (the view recurses into non-empty plain objects). Descendant
 * source aggregation is any-database > any-file > default.
 */
function lookupFieldEntry(index: readonly ParsedFieldEntry[], keys: readonly string[]): FieldEntryInfo {
  for (const item of index) {
    if (tokensEqual(item.segments, keys)) {
      return {
        source: item.entry.source,
        effectiveValue: item.entry.effectiveValue,
        overriddenValues: item.entry.overriddenValues,
        editable: item.entry.editable,
      };
    }
  }
  const descendants: { readonly relative: readonly string[]; readonly entry: ConfigFieldViewEntry }[] = [];
  for (const item of index) {
    if (item.segments.length <= keys.length || !tokensPrefix(keys, item.segments)) {
      continue;
    }
    const relative = item.segments.slice(keys.length);
    if (relative.some(isPrototypeKeyExact)) {
      continue;
    }
    descendants.push({ relative, entry: item.entry });
  }
  if (descendants.length === 0) {
    return { source: "none", effectiveValue: undefined, overriddenValues: [] };
  }
  let source: "file" | "database" | "default" = "default";
  for (const descendant of descendants) {
    if (descendant.entry.source === "database") {
      source = "database";
      break;
    }
    if (descendant.entry.source === "file") {
      source = "file";
    }
  }
  let composite: unknown;
  for (const descendant of descendants) {
    composite = setIn(composite, descendant.relative, deepCloneValue(descendant.entry.effectiveValue));
  }
  return { source, effectiveValue: composite, overriddenValues: [], editable: descendants.some((descendant) => descendant.entry.editable) };
}

// ---------- spec validation internals ----------

/** U02 token classification: raw form, escape form, or invalid/prototype. */
function classifyPathToken(token: string): "ok" | "prototype" | "invalid" {
  if (token.length === 0) {
    return "invalid";
  }
  if (isPrototypeKeyCaseInsensitive(token)) {
    return "prototype";
  }
  if (PATH_TOKEN_RE.test(token)) {
    return "ok";
  }
  let decoded: string;
  try {
    decoded = decodeMapKey(token);
  } catch {
    return "invalid";
  }
  if (isPrototypeKeyCaseInsensitive(decoded)) {
    return "prototype";
  }
  return encodeMapKey(decoded) === token ? "ok" : "invalid";
}

/** U03 control/valueKind compatibility; returns the issue message or null. */
function checkControlCompatibility(field: ConfigUiField): string | null {
  if (field.valueKind === "never") {
    return field.readonlyReason === undefined
      ? `field "${field.id}" uses valueKind "never" (removed alias) without readonlyReason.`
      : null;
  }
  const allowed = CONTROL_VALUE_KINDS[field.control];
  if (allowed === undefined) {
    return `field "${field.id}" has unknown control "${String(field.control)}".`;
  }
  if (!allowed.includes(field.valueKind)) {
    return `field "${field.id}" control "${field.control}" is incompatible with valueKind "${field.valueKind}".`;
  }
  if (field.control === "ordered-list" && (field.itemFields === undefined || field.itemFields.length === 0)) {
    return `field "${field.id}" ordered-list control requires non-empty itemFields.`;
  }
  if (field.control === "map" && field.mapValueKind === undefined) {
    return `field "${field.id}" map control requires mapValueKind.`;
  }
  return null;
}

function validateSpecPage(
  page: ConfigUiPage,
  optionsSourceIds: ReadonlySet<string>,
  seenFieldIds: Set<string>,
  issues: ConfigUiIssue[],
): void {
  const sectionIds = new Set<string>();
  const topLevel: ConfigUiField[] = [];
  for (const section of page.sections) {
    if (!isPlainRecord(section) || !Array.isArray(section.fields)) {
      issues.push({ code: "invalid_spec", message: `section on page "${page.id}" must be an object with a fields array.` });
      continue;
    }
    if (sectionIds.has(section.id)) {
      issues.push({ code: "duplicate_field_id", message: `duplicate section id "${section.id}" on page "${page.id}".` });
    } else {
      sectionIds.add(section.id);
    }
    if (section.fields.length === 0) {
      issues.push({ code: "missing_section", message: `section "${section.id}" on page "${page.id}" has no fields.` });
    }
    topLevel.push(...section.fields);
  }

  const allFields: ConfigUiField[] = [];
  const validateField = (field: ConfigUiField, topLevelField: boolean): void => {
    if (!isPlainRecord(field)) {
      issues.push({ code: "invalid_spec", message: `field on page "${page.id}" must be an object.` });
      return;
    }
    allFields.push(field);
    if (seenFieldIds.has(field.id)) {
      issues.push({ code: "duplicate_field_id", fieldId: field.id, message: `duplicate field id "${field.id}".` });
    } else {
      seenFieldIds.add(field.id);
    }
    if (topLevelField && !sectionIds.has(field.section)) {
      issues.push({
        code: "missing_section",
        fieldId: field.id,
        message: `field "${field.id}" references unknown section "${field.section}" on page "${page.id}".`,
      });
    }
    if (typeof field.label !== "string" || field.label.trim() === "" || typeof field.labelKey !== "string" || field.labelKey.trim() === "") {
      issues.push({ code: "missing_label", fieldId: field.id, message: `field "${field.id}" must have a non-empty label and labelKey.` });
    }
    if (!Array.isArray(field.path)) {
      issues.push({ code: "unknown_path", fieldId: field.id, message: `field "${field.id}" path must be an array of tokens.` });
    } else {
      for (const token of field.path) {
        if (typeof token !== "string") {
          issues.push({ code: "unknown_path", fieldId: field.id, message: `field "${field.id}" path tokens must be strings.` });
          continue;
        }
        const classification = classifyPathToken(token);
        if (classification === "prototype") {
          issues.push({ code: "prototype_key", fieldId: field.id, message: `field "${field.id}" path token "${token}" is a prototype key.` });
        } else if (classification === "invalid") {
          issues.push({ code: "unknown_path", fieldId: field.id, message: `field "${field.id}" path token "${token}" is not a valid path token.` });
        }
      }
    }
    const controlIssue = checkControlCompatibility(field);
    if (controlIssue !== null) {
      issues.push({ code: "incompatible_control", fieldId: field.id, message: controlIssue });
    }
    if (field.optionsSource !== undefined && !optionsSourceIds.has(field.optionsSource)) {
      issues.push({
        code: "unknown_options_source",
        fieldId: field.id,
        message: `field "${field.id}" references unknown options source "${field.optionsSource}".`,
      });
    }
    if (field.binding === "inherit-or-override" && !field.optional) {
      issues.push({
        code: "invalid_spec",
        fieldId: field.id,
        message: `field "${field.id}" uses inherit-or-override binding and must be optional.`,
      });
    }
    if (Array.isArray(field.itemFields)) {
      for (const item of field.itemFields) {
        validateField(item, false);
      }
    }
  };
  for (const field of topLevel) {
    validateField(field, true);
  }

  const topLevelIds = new Set(topLevel.map((field) => field.id));
  const byId = new Map(allFields.map((field) => [field.id, field]));
  for (const field of allFields) {
    const visibleWhen = field.visibleWhen;
    if (visibleWhen === undefined) {
      continue;
    }
    if (!topLevelIds.has(visibleWhen.field)) {
      issues.push({
        code: "unknown_visible_when",
        fieldId: field.id,
        message: `field "${field.id}" visibleWhen references unknown field "${visibleWhen.field}" on page "${page.id}".`,
      });
    }
  }
  const reportedCycleMembers = new Set<string>();
  for (const field of allFields) {
    if (field.visibleWhen === undefined) {
      continue;
    }
    const chain = new Map<string, number>();
    let current: ConfigUiField | undefined = field;
    while (current !== undefined && current.visibleWhen !== undefined) {
      const seenAt = chain.get(current.id);
      if (seenAt !== undefined) {
        const members = [...chain.keys()].slice(seenAt);
        for (const member of members) {
          if (reportedCycleMembers.has(member)) {
            continue;
          }
          reportedCycleMembers.add(member);
          issues.push({
            code: "visible_when_cycle",
            fieldId: member,
            message: `field "${member}" participates in a visibleWhen cycle on page "${page.id}".`,
          });
        }
        break;
      }
      chain.set(current.id, chain.size);
      current = byId.get(current.visibleWhen.field);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure function families (implemented in this module; bodies below)
// ---------------------------------------------------------------------------

/** U01–U03/U13: structural validation of a spec. Returns all issues found. */
export function validateUiSpec(spec: ConfigUiSpec): readonly ConfigUiIssue[] {
  if (!isPlainRecord(spec) || !Array.isArray(spec.pages)) {
    return [{ code: "invalid_spec", message: "ConfigUiSpec must be an object with a pages array." }];
  }
  const issues: ConfigUiIssue[] = [];
  if (spec.protocolVersion !== 1) {
    issues.push({ code: "invalid_spec", message: `ConfigUiSpec protocolVersion must be 1, got ${String(spec.protocolVersion)}.` });
  }
  const optionsSourceIds = new Set<string>();
  if (Array.isArray(spec.optionsSources)) {
    for (const source of spec.optionsSources) {
      optionsSourceIds.add(source.id);
    }
  }
  const seenFieldIds = new Set<string>();
  const seenPageIds = new Set<string>();
  for (const page of spec.pages) {
    if (!isPlainRecord(page) || !Array.isArray(page.sections)) {
      issues.push({ code: "invalid_spec", message: "ConfigUiPage must be an object with a sections array." });
      continue;
    }
    if (typeof page.id === "string") {
      if (seenPageIds.has(page.id)) {
        issues.push({ code: "duplicate_field_id", message: `duplicate page id "${page.id}".` });
      } else {
        seenPageIds.add(page.id);
      }
    }
    // isPlainRecord narrows away the static page type; the guard above already
    // established the runtime shape the validator requires.
    validateSpecPage(page as unknown as ConfigUiPage, optionsSourceIds, seenFieldIds, issues);
  }
  return issues;
}

/** U04/U05/U16/U17: build a draft from a server config view slice. */
export function decodeDraft(page: ConfigUiPage, input: ConfigDecodeInput): ConfigDraft {
  const entity = page.entity;
  if (entity !== undefined && input.record !== undefined) {
    return decodeEntityDraft(page, entity, input.record, input);
  }
  return decodeGlobalsDraft(page, input);
}

function decodeEntityDraft(
  page: ConfigUiPage,
  entity: ConfigUiPageEntity,
  record: ConfigEntityRecordView | null,
  input: ConfigDecodeInput,
): ConfigDraft {
  const specFields = scopedEntityFields(page, entity);
  const draftFields: Record<string, ConfigDraftField> = {};
  if (record === null) {
    for (const field of specFields) {
      const fallback = field.hasDefault ? field.defaultValue : controlEmptyValue(field);
      draftFields[field.id] = {
        id: field.id,
        mode: "absent",
        // inherit only exists on inherit-or-override bindings; on plain value
        // bindings it would render the control disabled with no way out.
        inherit: field.binding === "inherit-or-override",
        value: isNameField(entity, field) ? "" : fallback,
        effectiveValue: field.hasDefault ? field.defaultValue : undefined,
        provenance: "none",
        overriddenValues: [],
      };
    }
    draftFields["$extras"] = {
      id: "$extras",
      mode: "absent",
      inherit: false,
      value: {},
      effectiveValue: undefined,
      provenance: "none",
      overriddenValues: [],
      extras: {},
    };
    return {
      scope: { kind: "entity", collection: entity.collection, recordId: null },
      fields: draftFields,
      baseRevision: input.baseRevision,
      fileDigest: input.fileDigest,
    };
  }
  const provenance = record.source;
  const covered: (readonly string[])[] = [];
  for (const field of specFields) {
    if (isNameField(entity, field)) {
      draftFields[field.id] = {
        id: field.id,
        mode: "present",
        inherit: false,
        value: record.name,
        effectiveValue: record.name,
        provenance,
        overriddenValues: [],
      };
      continue;
    }
    const keys = fieldPathKeys(field);
    if (keys.length > 0) covered.push(keys);
    const raw = getIn(record.value, keys);
    const effective = getIn(record.effectiveValue, keys);
    const effectiveValue = effective.found ? effective.value : undefined;
    if (!raw.found) {
      draftFields[field.id] = {
        id: field.id,
        mode: "absent",
        inherit: field.binding === "inherit-or-override",
        value: field.hasDefault ? field.defaultValue : controlEmptyValue(field),
        effectiveValue,
        provenance,
        overriddenValues: [],
      };
      continue;
    }
    const shaped = toControlShape(field, raw.value);
    if (!shaped.ok) {
      // Malformed matcher: treated as absent; raw preserved for error surfacing.
      draftFields[field.id] = {
        id: field.id,
        mode: "absent",
        inherit: field.binding === "inherit-or-override",
        value: shaped.value,
        effectiveValue,
        provenance,
        overriddenValues: [],
      };
      continue;
    }
    draftFields[field.id] = {
      id: field.id,
      mode: "present",
      inherit: false,
      value: shaped.value,
      effectiveValue,
      provenance,
      overriddenValues: [],
    };
  }
  const extras = collectExtras(record.value, covered);
  const extrasEffective = collectExtras(record.effectiveValue, covered);
  draftFields["$extras"] = {
    id: "$extras",
    mode: Object.keys(extras).length > 0 ? "present" : "absent",
    inherit: false,
    value: extras,
    effectiveValue: extrasEffective,
    provenance,
    overriddenValues: [],
    extras,
  };
  return {
    scope: { kind: "entity", collection: entity.collection, recordId: record.id },
    fields: draftFields,
    baseRevision: input.baseRevision,
    fileDigest: input.fileDigest,
  };
}

/** Preserve unknown descendants and explicit empty objects (U17). */
function collectExtras(value: unknown, covered: readonly (readonly string[])[]): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (!isPlainRecord(value)) {
    return extras;
  }
  for (const [key, entry] of Object.entries(value)) {
    const paths = covered.filter(path => path[0] === key);
    if (paths.length === 0) {
      defineValue(extras, key, deepCloneValue(entry));
    } else if (!paths.some(path => path.length === 1) && isPlainRecord(entry)) {
      const nested = collectExtras(entry, paths.map(path => path.slice(1)));
      if (Object.keys(nested).length > 0 || Object.keys(entry).length === 0) defineValue(extras, key, nested);
    }
  }
  return extras;
}

/** Row fields use config-relative paths; UI ids are never stored as config keys. */
export function readRowField(row: unknown, field: ConfigUiField): unknown {
  return getIn(row, fieldPathKeys(field)).value;
}

export function writeRowField(row: Record<string, unknown>, parent: ConfigUiField, id: string, value: unknown): Record<string, unknown> {
  const field = parent.itemFields?.find(item => item.id === id);
  const keys = field ? fieldPathKeys(field) : [id];
  assertNoPrototypeKeysDeep(Object.fromEntries(keys.map(key => [key, true])), id);
  return setIn(row, keys, value) as Record<string, unknown>;
}

function decodeGlobalsDraft(page: ConfigUiPage, input: ConfigDecodeInput): ConfigDraft {
  const specFields = scopedGlobalFields(page);
  const index = indexFieldEntries(input.fields);
  const draftFields: Record<string, ConfigDraftField> = {};
  for (const field of specFields) {
    const info = lookupFieldEntry(index, fieldPathKeys(field));
    const present = info.source === "file" || info.source === "database";
    let mode: "present" | "absent" = present ? "present" : "absent";
    let value: unknown;
    if (present) {
      const shaped = toControlShape(field, info.effectiveValue);
      if (shaped.ok) {
        value = shaped.value;
      } else {
        mode = "absent";
        value = shaped.value;
      }
    } else {
      value = field.hasDefault ? field.defaultValue : controlEmptyValue(field);
    }
    draftFields[field.id] = {
      id: field.id,
      mode,
      // inherit means "no DB override": file shows the effective value locked.
      // Only inherit-or-override bindings carry the flag; on plain value
      // bindings it would lock the control with no override toggle.
      inherit: field.binding === "inherit-or-override" && info.source !== "database",
      value,
      effectiveValue: info.effectiveValue,
      provenance: info.source,
      overriddenValues: info.overriddenValues,
      ...(info.editable !== undefined ? { editable: info.editable } : {}),
    };
  }
  return {
    scope: { kind: "globals", prefix: commonPathPrefix(specFields.map((field) => field.path)) },
    fields: draftFields,
    baseRevision: input.baseRevision,
    fileDigest: input.fileDigest,
  };
}

/** U05/U10/U17/U18: encode a draft into changeset operations. */
export function encodeChanges(
  page: ConfigUiPage,
  draft: ConfigDraft,
  base: ConfigDecodeInput,
): readonly ConfigUiOperation[] {
  const scope = draft.scope;
  if (scope.kind === "entity") {
    const entity = page.entity;
    if (entity === undefined) {
      throw new TypeError("encodeChanges: entity draft requires an entity page.");
    }
    return encodeEntityChanges(page, entity, scope, draft, base);
  }
  return encodeGlobalsChanges(page, draft, base);
}

function encodeEntityChanges(
  page: ConfigUiPage,
  entity: ConfigUiPageEntity,
  scope: { readonly kind: "entity"; readonly collection: string; readonly recordId: string | null },
  draft: ConfigDraft,
  base: ConfigDecodeInput,
): readonly ConfigUiOperation[] {
  const specFields = scopedEntityFields(page, entity);
  let value: unknown;
  if (entity.valueShape === "string") {
    // template/prompt: the single path-[] textarea field IS the document.
    const docField = specFields.find((field) => field.path.length === 0 && !isNameField(entity, field));
    if (docField === undefined) throw new TypeError(`encodeChanges: document field is missing on page "${page.id}".`);
    let document = "";
    const draftField = draft.fields[docField.id];
    if (draftField !== undefined && draftField.mode === "present" && !draftField.inherit) {
      document = encodeFieldValue(docField, draftField.value) as string;
    }
    value = document;
  } else if (entity.valueShape === "array") {
    // model_group: the single path-[] ordered-list field IS the record value.
    const listField = specFields.find((field) => field.path.length === 0 && !isNameField(entity, field));
    let rows: unknown = [];
    if (listField !== undefined) {
      const draftField = draft.fields[listField.id];
      if (draftField !== undefined && draftField.mode === "present" && !draftField.inherit) {
        const encoded = encodeFieldValue(listField, draftField.value);
        rows = encoded === SKIP ? [] : encoded;
      }
    }
    value = rows;
  } else {
    const extrasRaw = draft.fields["$extras"]?.value;
    let record: Record<string, unknown> = {};
    if (extrasRaw !== undefined) {
      if (!isPlainRecord(extrasRaw)) {
        throw new TypeError("encodeChanges: entity draft $extras must be a plain object.");
      }
      assertNoPrototypeKeysDeep(extrasRaw, "$extras");
      record = deepCloneValue(extrasRaw) as Record<string, unknown>;
    }
    for (const field of specFields) {
      if (isNameField(entity, field) || field.path.length === 0) {
        continue;
      }
      const draftField = draft.fields[field.id];
      if (draftField === undefined || draftField.mode !== "present" || draftField.inherit) {
        if (field.control === "secret-value" && getIn(base.record?.value, fieldPathKeys(field)).found) {
          record = setIn(record, fieldPathKeys(field), null) as Record<string, unknown>;
        }
        continue;
      }
      const encoded = encodeFieldValue(field, draftField.value, draftField.effectiveValue);
      if (encoded === SKIP) {
        // Keep an empty parent for a masked nested secret; the server carries
        // its stored leaf over only when that parent remains in the update.
        const parent = fieldPathKeys(field).slice(0, -1);
        if (field.control === "secret-value" && parent.length > 0 && !getIn(record, parent).found) {
          record = setIn(record, parent, {}) as Record<string, unknown>;
        }
        continue;
      }
      record = setIn(record, fieldPathKeys(field), encoded) as Record<string, unknown>;
    }
    value = record;
  }
  if (scope.recordId === null) {
    const name = entityCreateName(entity, specFields, draft);
    return [{ op: "create", collection: entity.collection, record: { id: name, name, enabled: true, value } }];
  }
  return [{ op: "update", collection: entity.collection, recordId: scope.recordId, value }];
}

function entityCreateName(entity: ConfigUiPageEntity, specFields: readonly ConfigUiField[], draft: ConfigDraft): string {
  let value: unknown;
  if (entity.idField === null) {
    const nameField = specFields.find((field) => isNameField(entity, field));
    value = nameField === undefined ? undefined : draft.fields[nameField.id]?.value;
  } else {
    const idField = entity.idField;
    const idSpecField = specFields.find((field) => field.path.length === 1 && fieldPathKeys(field)[0] === idField);
    value = idSpecField === undefined ? undefined : draft.fields[idSpecField.id]?.value;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`encodeChanges: cannot create a ${entity.kind} record without a non-empty ${entity.idField ?? "name"} value.`);
  }
  return value;
}

function encodeGlobalsChanges(page: ConfigUiPage, draft: ConfigDraft, base: ConfigDecodeInput): readonly ConfigUiOperation[] {
  const baseIndex = indexFieldEntries(base.fields);
  const operations: ConfigUiOperation[] = [];
  for (const field of scopedGlobalFields(page)) {
    if (field.readonlyReason !== undefined) continue;
    const draftField = draft.fields[field.id];
    if (draftField === undefined) {
      continue;
    }
    const keys = fieldPathKeys(field);
    const baseInfo = lookupFieldEntry(baseIndex, keys);
    if (baseInfo.editable === false) continue;
    let wantsOverride = draftField.mode === "present" && !draftField.inherit;
    let encoded: unknown;
    if (wantsOverride) {
      encoded = encodeFieldValue(field, draftField.value, baseInfo.effectiveValue);
      if (encoded === SKIP) {
        if (field.control === "secret-value") continue;
        wantsOverride = false;
      } else if (field.control === "secret-value" && encoded === null) {
        wantsOverride = false;
      } else if (encoded === undefined) {
        // A cleared optional scalar must never become a `set` without a
        // value (the DTO requires one). Inherit-or-override: an empty
        // override is not an implicit inherit (§8.1) — fail locally so the
        // form shows a field-level message instead of a server 400.
        if (field.binding === "inherit-or-override") {
          throw new TypeError(`encodeChanges: field "${field.id}" override requires a value; switch to inherit or enter one.`);
        }
        // Value binding: empty means absent — fall through to unset a DB
        // override (no op for file/default-sourced values).
        wantsOverride = false;
      }
    }
    if (wantsOverride) {
      // Deep-equal against the base DB value with same presence means no op.
      // Value bindings have no explicit override gesture, so an unchanged
      // draft equals the effective baseline and must not write a redundant
      // override; inherit-or-override keeps the pin-an-override flow.
      if (
        deepConfigEqual(encoded, baseInfo.effectiveValue)
        && (baseInfo.source === "database" || field.binding === "value")
      ) {
        continue;
      }
      operations.push({ op: "set", path: keys, value: encoded });
    } else if (baseInfo.source === "database") {
      // unset only removes DB overrides; file/default-sourced paths never unset.
      operations.push({ op: "unset", path: keys });
    }
  }
  return operations;
}

/** U06/U07/U11/U13/U15/U19/U20: computed field state for rendering. */
export function resolveFieldState(
  page: ConfigUiPage,
  fieldId: string,
  draft: ConfigDraft,
  references: Readonly<Record<string, ConfigReferenceData>>,
  errors: readonly ConfigApiFieldError[] = [],
): ConfigFieldState {
  const field = findField(page, fieldId);
  const draftField = draft.fields[fieldId];
  let visible = true;
  if (field !== undefined && field.visibleWhen !== undefined) {
    visible = evaluateVisibleWhen(page, field.visibleWhen, draft);
  }
  let disabled = false;
  let disabledReason: string | undefined;
  if (field?.readonlyReason !== undefined) {
    disabled = true;
    disabledReason = field.readonlyReason;
  } else if (draftField !== undefined && draftField.provenance === "file" && draftField.editable !== true) {
    disabled = true;
    disabledReason = "owned by the config file";
  }
  // Applicability is independent of edit permission: file-owned and other
  // read-only records must hide the same fields as editable records.
  if (field !== undefined && field.kinds !== undefined) {
    const kindValue = entityKindDraftValue(page, draft);
    if (typeof kindValue === "string" && !field.kinds.includes(kindValue)) {
      visible = false;
      disabled = true;
      disabledReason ??= `kind "${kindValue}" does not use this field`;
    }
  }
  if (!disabled && !visible) {
    disabled = true;
  }
  const resolved = resolveOptions(page, fieldId, draft, references);
  let error = matcherShapeError(field, draftField);
  if (error === undefined) {
    error = firstApiFieldError(page, field, draft, errors);
  }
  return {
    visible,
    disabled,
    ...(disabledReason !== undefined ? { disabledReason } : {}),
    options: resolved.options,
    ...(resolved.error !== undefined ? { optionsError: resolved.error } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function entityKindDraftValue(page: ConfigUiPage, draft: ConfigDraft): unknown {
  const entity = page.entity;
  if (entity === undefined || entity.kindField === undefined) {
    return undefined;
  }
  const kindFieldName = entity.kindField;
  const kindField = scopedEntityFields(page, entity).find(
    (field) => field.path.length === 1 && fieldPathKeys(field)[0] === kindFieldName,
  );
  if (kindField === undefined) {
    return undefined;
  }
  return draft.fields[kindField.id]?.value;
}

/** visibleWhen: boolean equality, or array-contains for multiselect refs. */
function evaluateVisibleWhen(page: ConfigUiPage, visibleWhen: ConfigUiVisibleWhen, draft: ConfigDraft): boolean {
  const refField = collectPageFields(page).find((field) => field.id === visibleWhen.field);
  if (refField === undefined) {
    return false;
  }
  const refValue = draft.fields[refField.id]?.value;
  if (refValue === undefined) {
    return false;
  }
  if (Array.isArray(refValue)) {
    return refValue.includes(visibleWhen.equals);
  }
  return refValue === visibleWhen.equals;
}

function matcherShapeError(field: ConfigUiField | undefined, draftField: ConfigDraftField | undefined): string | undefined {
  if (field === undefined || field.control !== "matcher" || draftField === undefined) {
    return undefined;
  }
  const value = draftField.value;
  if (value === undefined || isMatcherControlValue(value)) {
    return undefined;
  }
  return `unrecognized matcher shape for field "${field.id}"`;
}

/** U20: first API error mapped to this field by entity + path suffix. */
function firstApiFieldError(
  page: ConfigUiPage,
  field: ConfigUiField | undefined,
  draft: ConfigDraft,
  errors: readonly ConfigApiFieldError[],
): string | undefined {
  if (field === undefined) {
    return undefined;
  }
  const keys = fieldPathKeys(field);
  for (const apiError of errors) {
    if (!apiErrorMatchesField(apiError, page, draft, keys)) {
      continue;
    }
    return apiError.code !== undefined ? `${apiError.code}: ${apiError.message}` : apiError.message;
  }
  return undefined;
}

function apiErrorMatchesField(
  apiError: ConfigApiFieldError,
  page: ConfigUiPage,
  draft: ConfigDraft,
  fieldKeys: readonly string[],
): boolean {
  if (apiError.entity !== undefined) {
    const entity = page.entity;
    if (entity === undefined || apiError.entity.kind !== entity.kind) {
      return false;
    }
    const scope = draft.scope;
    if (scope.kind !== "entity") {
      return false;
    }
    if (scope.recordId === null) {
      // Create drafts have no recordId yet; the new record's id lives in the
      // id field's draft value, so entity errors from a failed create still
      // land on the drawer that produced them.
      const idField = entity.idField;
      const idDraftField = scopedEntityFields(page, entity).find(
        (candidate) => idField === null ? isNameField(entity, candidate)
          : candidate.path.length === 1 && fieldPathKeys(candidate)[0] === idField,
      );
      const draftId = idDraftField === undefined ? undefined : draft.fields[idDraftField.id]?.value;
      if (typeof draftId !== "string" || draftId !== apiError.entity.id) return false;
    } else if (scope.recordId !== apiError.entity.id) {
      return false;
    }
  }
  if (apiError.path === undefined) {
    return false;
  }
  if (fieldKeys.length === 0) {
    return apiError.path.length === 0;
  }
  // Schema validators report the failing LEAF (e.g. a matcher's inner
  // `exact` token), while the field owns the parent object. Trim trailing
  // tokens until the field path suffix-matches so leaf errors land on the
  // field that edits them.
  for (let end = apiError.path.length; end >= fieldKeys.length; end -= 1) {
    const candidate = end === apiError.path.length ? apiError.path : apiError.path.slice(0, end);
    // Dual-domain pages (entity + globals): an untagged error whose path is
    // exactly a globals field path belongs to the defaults domain — never
    // suffix-match it onto an entity field with the same relative shape.
    if (draft.scope.kind === "entity" && apiError.entity === undefined) {
      let hitsGlobals = false;
      for (const globalField of scopedGlobalFields(page)) {
        if (tokensEqual(fieldPathKeys(globalField), candidate)) {
          hitsGlobals = true;
          break;
        }
      }
      if (hitsGlobals) return false;
    }
    if (tokensEqual(fieldKeys, candidate.slice(candidate.length - fieldKeys.length))) {
      return true;
    }
  }
  return false;
}

/** U19: options for one field; never silently defaults to the first option. */
export function resolveOptions(
  page: ConfigUiPage,
  fieldId: string,
  draft: ConfigDraft,
  references: Readonly<Record<string, ConfigReferenceData>>,
): { readonly options: readonly ConfigUiOption[]; readonly error?: string } {
  const field = findField(page, fieldId);
  if (field === undefined) {
    return { options: [] };
  }
  return resolveItemOptions(field, draft.fields[fieldId]?.value, references);
}

/**
 * U19 for ordered-list row item fields (e.g. model group entry provider):
 * the same dynamic-source resolution as top-level fields, driven by the
 * row's current value instead of a session draft entry.
 */
export function resolveItemOptions(
  field: ConfigUiField,
  value: unknown,
  references: Readonly<Record<string, ConfigReferenceData>>,
): { readonly options: readonly ConfigUiOption[]; readonly error?: string } {
  if (field.options !== undefined) {
    return { options: field.options };
  }
  const source = field.optionsSource;
  if (source === undefined) {
    return { options: [] };
  }
  const reference = Object.hasOwn(references, source) ? references[source] : undefined;
  if (reference === undefined) {
    return { options: [], error: `options source "${source}" not loaded` };
  }
  if (reference.error !== undefined) {
    return { options: reference.options, error: reference.error };
  }
  if (field.control === "path-template") return { options: reference.options };
  const options = [...reference.options];
  const known = new Set(options.map((option) => option.value));
  const values = Array.isArray(value) ? value : [value];
  const missing: string[] = [];
  for (const entry of values) {
    if (typeof entry !== "string" || entry === "" || known.has(entry)) {
      continue;
    }
    known.add(entry);
    missing.push(entry);
    // A vanished option stays visible as a disabled row; never auto-select.
    options.push({ value: entry, label: `${entry} (missing)`, disabled: true });
  }
  if (missing.length > 0) {
    const listed = missing.map((entry) => `"${entry}"`).join(", ");
    return {
      options,
      error: `referenced option${missing.length === 1 ? "" : "s"} no longer available: ${listed}`,
    };
  }
  return { options };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** U06: "" is empty (absent), never 0; NaN/Infinity rejected. */
export function parseNumberInput(
  raw: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: "empty" | "nan" | "non-finite" } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }
  const value = Number(trimmed);
  if (Number.isNaN(value)) {
    return { ok: false, reason: "nan" };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, reason: "non-finite" };
  }
  return { ok: true, value };
}

/** U09: reversible escaping for arbitrary map keys inside path tokens. */
export function encodeMapKey(key: string): string {
  if (isPrototypeKeyExact(key)) {
    throw new TypeError(`encodeMapKey: refusing prototype key "${key}".`);
  }
  let token = "";
  for (const char of key) {
    if (MAP_KEY_SAFE_RE.test(char)) {
      token += char;
      continue;
    }
    for (let index = 0; index < char.length; index += 1) {
      token += `~${char.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return token;
}

export function decodeMapKey(token: string): string {
  let key = "";
  let index = 0;
  while (index < token.length) {
    if (token[index] !== "~") {
      key += token[index];
      index += 1;
      continue;
    }
    const hex = token.slice(index + 1, index + 5);
    if (!/^[0-9A-F]{4}$/u.test(hex)) {
      throw new TypeError(`decodeMapKey: malformed escape sequence in token "${token}".`);
    }
    key += String.fromCharCode(Number.parseInt(hex, 16));
    index += 5;
  }
  return key;
}

/** Local plain-object check (zero-import rule; do not import utils). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
