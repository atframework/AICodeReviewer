/**
 * Config editor session state machine (spec §8.3, P6 form-state layer).
 *
 * Wraps the pure decode/encode protocol of config-ui-runtime.ts with the
 * stateful editing session the dashboard client drives:
 *
 * - Sessions are immutable: every mutator returns a NEW ConfigEditorSession
 *   and unchanged draft fields are shared structurally. Session objects stay
 *   JSON-serializable; the dirty-tracking baseline (the initial decode) lives
 *   in a module-local WeakMap keyed by session, never inside the session.
 * - dirty = any draft field whose value/mode/inherit differs from the initial
 *   decode, compared with the shared deepConfigEqual from config-ui-runtime.
 * - U05 inherit/override toggle keeps the last override value stored in the
 *   draft field so toggling back restores it; entering override with no stored
 *   value falls back to the schema default.
 * - U08 ordered-list rows carry stable `_rowId`s; the next id derives from the
 *   max numeric `r<N>` suffix among current rows (no per-session counter, so
 *   sessions remain serializable).
 * - U09 map entries keep duplicate keys visible via sessionMapIssues (never a
 *   silent overwrite) and reject prototype keys with TypeError.
 * - U14 kind switches stash kind-specific fields per kind, restore the target
 *   kind's stash, and list present-but-inapplicable fields in removedOnSave
 *   (the "will be removed" list). Inapplicable fields are also excluded from
 *   the encoded record by sessionEncode.
 * - U20 maps API field errors onto field ids ("$global" when unmappable),
 *   U21 rebases user edits onto a fresh server view, U22 assembles atomic
 *   multi-session changesets in session order.
 *
 * Runtime imports are limited to ./config-ui-runtime.js (browser-served, D2).
 */

import { decodeDraft, deepConfigEqual, encodeChanges, isPlainRecord, writeRowField } from "./config-ui-runtime.js";
import type {
  ConfigApiFieldError,
  ConfigDecodeInput,
  ConfigDraft,
  ConfigDraftField,
  ConfigUiField,
  ConfigUiOperation,
  ConfigUiPage,
} from "./config-ui-runtime.js";

// ---------------------------------------------------------------------------
// Operation and result types
// ---------------------------------------------------------------------------

/** U08: ordered-list row addressing is by stable row id, never by index. */
export type ConfigListOperation =
  | { readonly type: "insert"; readonly index?: number; readonly row?: Record<string, unknown> }
  | { readonly type: "remove"; readonly rowId: string }
  | { readonly type: "move"; readonly rowId: string; readonly toIndex: number }
  | { readonly type: "set"; readonly rowId: string; readonly itemFieldId: string; readonly value: unknown };

/** U09: map rows keep order and allow duplicate keys to be flagged, not merged. */
export type ConfigMapOperation =
  | { readonly type: "insert"; readonly key?: string }
  | { readonly type: "remove"; readonly rowId: string }
  | { readonly type: "setKey"; readonly rowId: string; readonly key: string }
  | { readonly type: "setValue"; readonly rowId: string; readonly value: unknown };

export interface ConfigDiffEntry {
  readonly path: string;
  readonly change: "added" | "removed" | "changed";
  readonly before: unknown;
  readonly after: unknown;
}

/** Explicit entity actions; emitted as-is alongside changeset operations. */
export type ConfigEntityAction =
  | { readonly type: "set-enabled"; readonly collection: string; readonly recordId: string; readonly enabled: boolean }
  | { readonly type: "delete"; readonly collection: string; readonly recordId: string }
  | { readonly type: "rename"; readonly collection: string; readonly recordId: string; readonly newName: string };

export type ConfigEntityActionOperation =
  | { readonly op: "set-enabled"; readonly collection: string; readonly recordId: string; readonly enabled: boolean }
  | { readonly op: "delete"; readonly collection: string; readonly recordId: string }
  | { readonly op: "rename"; readonly collection: string; readonly recordId: string; readonly newName: string };

export interface ConfigEditorSession {
  readonly page: ConfigUiPage;
  readonly draft: ConfigDraft;
  readonly dirty: boolean;
  /** Current entity kindField value; undefined when the page has no variants. */
  readonly kind: string | undefined;
  /** Field ids excluded by the last kind switch (the "will be removed" list). */
  readonly removedOnSave: readonly string[];
  /** Per-kind stash of kind-specific draft fields (U14). */
  readonly stashes: Readonly<Record<string, Readonly<Record<string, ConfigDraftField>>>>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Static lookup; computed keys are required so "__proto__" stays an own key.
const PROTOTYPE_KEYS: Readonly<Record<string, boolean>> = {
  ["__proto__"]: true,
  ["prototype"]: true,
  ["constructor"]: true,
};

function assertSafeKey(key: string): void {
  if (PROTOTYPE_KEYS[key] === true) {
    throw new TypeError(`prototype key is not allowed: ${key}`);
  }
}

/**
 * Baseline drafts for dirty tracking. Keeping them out of the session object
 * preserves serializability; every mutator re-registers the new session.
 */
const INITIAL = new WeakMap<ConfigEditorSession, ConfigDraft>();

/** Shared structural equality (single sanctioned implementation). */
const deepEqual: (a: unknown, b: unknown) => boolean = deepConfigEqual;

function pageFields(page: ConfigUiPage): readonly ConfigUiField[] {
  return page.sections.flatMap((section) => section.fields);
}

function findField(page: ConfigUiPage, fieldId: string): ConfigUiField {
  const field = pageFields(page).find((candidate) => candidate.id === fieldId);
  if (field === undefined) {
    throw new Error(`unknown field: ${fieldId}`);
  }
  return field;
}

/** The page field backing the entity kind discriminant, when one exists. */
function kindFieldOf(page: ConfigUiPage): ConfigUiField | undefined {
  const kindField = page.entity?.kindField;
  if (kindField === undefined) return undefined;
  return pageFields(page).find((field) => field.path.length === 1 && field.path[0] === kindField);
}

function requireDraftField(draft: ConfigDraft, fieldId: string): ConfigDraftField {
  const field = draft.fields[fieldId];
  if (field === undefined) {
    throw new Error(`unknown field: ${fieldId}`);
  }
  return field;
}

function initialDraftOf(session: ConfigEditorSession): ConfigDraft {
  const initial = INITIAL.get(session);
  if (initial !== undefined) return initial;
  // Defensive: a session built outside createEditorSession has no recorded
  // baseline; an empty baseline marks every current field user-owned so a
  // later rebase preserves rather than drops it.
  return { ...session.draft, fields: {} };
}

function fieldsDiffer(a: ConfigDraftField, b: ConfigDraftField): boolean {
  return a.mode !== b.mode || a.inherit !== b.inherit || !deepEqual(a.value, b.value);
}

/**
 * dirty = any draft field whose value/mode/inherit differs from the baseline.
 * Draft field ids never shrink across mutators, so baseline-only ids cannot
 * occur; unknown current ids (no baseline entry) count as dirty.
 */
function computeDirty(draft: ConfigDraft, initial: ConfigDraft): boolean {
  for (const [id, current] of Object.entries(draft.fields)) {
    const pristine = initial.fields[id];
    if (pristine === undefined) return true;
    if (fieldsDiffer(current, pristine)) return true;
  }
  return false;
}

function withField(draft: ConfigDraft, fieldId: string, field: ConfigDraftField): ConfigDraft {
  return { ...draft, fields: { ...draft.fields, [fieldId]: field } };
}

/** Derive the next session from a new draft, keeping kind/stash/removed state. */
function derive(session: ConfigEditorSession, draft: ConfigDraft): ConfigEditorSession {
  const initial = initialDraftOf(session);
  const next: ConfigEditorSession = {
    page: session.page,
    draft,
    dirty: computeDirty(draft, initial),
    kind: session.kind,
    removedOnSave: session.removedOnSave,
    stashes: session.stashes,
  };
  INITIAL.set(next, initial);
  return next;
}

/** Fields carrying a `kinds` applicability list, in page order. */
function kindSpecificFields(page: ConfigUiPage): readonly (ConfigUiField & { readonly kinds: readonly string[] })[] {
  return pageFields(page).filter(
    (field): field is ConfigUiField & { readonly kinds: readonly string[] } => field.kinds !== undefined,
  );
}

/**
 * Untouched state for a field: the baseline decode when available, otherwise a
 * synthesized absent field carrying the schema default.
 */
function pristineField(initial: ConfigDraft, field: ConfigUiField, current: ConfigDraftField): ConfigDraftField {
  const pristine = initial.fields[field.id];
  if (pristine !== undefined) return pristine;
  return {
    ...current,
    mode: "absent",
    inherit: true,
    value: field.hasDefault ? field.defaultValue : undefined,
  };
}

/** Next stable row id: max numeric `r<N>` suffix among current rows, plus one. */
function nextRowId(rows: readonly unknown[]): string {
  let max = 0;
  for (const row of rows) {
    const id = isPlainRecord(row) && typeof row._rowId === "string" ? row._rowId : undefined;
    if (id !== undefined) {
      const match = /^r(\d+)$/.exec(id);
      if (match !== null) {
        const n = Number(match[1]);
        if (n > max) max = n;
      }
    }
  }
  return `r${max + 1}`;
}

function locateRow(rows: readonly unknown[], rowId: string): { readonly index: number; readonly row: Record<string, unknown> } {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (isPlainRecord(row) && row._rowId === rowId) return { index, row };
  }
  throw new Error(`row not found: ${rowId}`);
}

function listValueOf(field: ConfigDraftField, fieldId: string): readonly unknown[] {
  if (field.value === undefined) return [];
  if (!Array.isArray(field.value)) {
    throw new TypeError(`field is not a list: ${fieldId}`);
  }
  return field.value;
}

/**
 * Row ops only apply to object rows; a scalar first row means the renderer is
 * driving a string[]/number[] list through row ops and must rebuild the array
 * via sessionSetValue instead.
 */
function assertObjectRowList(rows: readonly unknown[], fieldId: string): void {
  if (rows.length > 0 && !isPlainRecord(rows[0])) {
    throw new TypeError(`field holds a scalar list; rebuild it via sessionSetValue: ${fieldId}`);
  }
}

function setFieldValue(session: ConfigEditorSession, fieldId: string, current: ConfigDraftField, value: unknown): ConfigEditorSession {
  return derive(session, withField(session.draft, fieldId, { ...current, value, mode: "present", inherit: false }));
}

function defaultMapValue(field: ConfigUiField): unknown {
  if (field.mapValueKind === "record") return {};
  if (field.mapValueKind === "number") return undefined;
  return "";
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export function createEditorSession(page: ConfigUiPage, input: ConfigDecodeInput): ConfigEditorSession {
  const draft = decodeDraft(page, input);
  const kindField = kindFieldOf(page);
  const kindValue = kindField === undefined ? undefined : draft.fields[kindField.id]?.value;
  const kind = typeof kindValue === "string" && kindValue !== "" ? kindValue : undefined;
  let session: ConfigEditorSession = { page, draft, dirty: false, kind, removedOnSave: [], stashes: {} };
  // U14: a brand-new entity draft defaults to the first declared kind so the
  // rendered kind select and the encoded record can never disagree (the
  // browser always displays option[0] as selected). The default is the
  // baseline, not a user edit: the session starts clean.
  if (session.kind === undefined && kindField !== undefined && draft.scope.kind === "entity" && draft.scope.recordId === null) {
    const defaultKind = page.entity?.kindOptions?.[0];
    if (defaultKind !== undefined) {
      const switched = sessionSwitchKind(session, defaultKind);
      session = { ...switched, dirty: false };
    }
  }
  INITIAL.set(session, session.draft);
  return session;
}

// ---------------------------------------------------------------------------
// Scalar field mutators
// ---------------------------------------------------------------------------

export function sessionSetValue(session: ConfigEditorSession, fieldId: string, value: unknown): ConfigEditorSession {
  const kindField = kindFieldOf(session.page);
  if (kindField !== undefined && fieldId === kindField.id) {
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`kind field requires a non-empty string value: ${fieldId}`);
    }
    return sessionSwitchKind(session, value);
  }
  const current = requireDraftField(session.draft, fieldId);
  return setFieldValue(session, fieldId, current, value);
}

/** U05: inherit <-> override. Entering inherit keeps the value for toggle-back. */
export function sessionToggleInherit(session: ConfigEditorSession, fieldId: string): ConfigEditorSession {
  const field = findField(session.page, fieldId);
  if (field.binding !== "inherit-or-override") {
    throw new Error(`field does not support inherit/override: ${fieldId}`);
  }
  const current = requireDraftField(session.draft, fieldId);
  const updated: ConfigDraftField = current.inherit
    ? {
        ...current,
        inherit: false,
        mode: "present",
        value: current.value !== undefined ? current.value : field.hasDefault ? field.defaultValue : undefined,
      }
    : { ...current, inherit: true };
  return derive(session, withField(session.draft, fieldId, updated));
}

/** Entity field absent <-> present; while absent the schema default applies. */
export function sessionSetPresent(session: ConfigEditorSession, fieldId: string, present: boolean): ConfigEditorSession {
  const field = findField(session.page, fieldId);
  const current = requireDraftField(session.draft, fieldId);
  if (!present) {
    return derive(session, withField(session.draft, fieldId, { ...current, mode: "absent" }));
  }
  const value =
    current.value !== undefined
      ? current.value
      : field.hasDefault
        ? field.defaultValue
        : current.effectiveValue !== undefined
          ? current.effectiveValue
          : undefined;
  return setFieldValue(session, fieldId, current, value);
}

// ---------------------------------------------------------------------------
// Kind variants (U14)
// ---------------------------------------------------------------------------

export function sessionSwitchKind(session: ConfigEditorSession, kind: string): ConfigEditorSession {
  const kindField = kindFieldOf(session.page);
  if (kindField === undefined) {
    throw new Error(`page has no kind field: ${session.page.id}`);
  }
  if (kind === "") {
    throw new TypeError("kind must be a non-empty string");
  }
  if (session.kind === kind) {
    return session;
  }
  const initial = initialDraftOf(session);
  const kindSpecific = kindSpecificFields(session.page);

  // Fields with a present value the new kind does not support (pre-switch
  // draft, page order): the "will be removed" list.
  const removedOnSave: string[] = [];
  for (const field of kindSpecific) {
    if (field.kinds.includes(kind)) continue;
    const current = session.draft.fields[field.id];
    if (current !== undefined && current.mode === "present" && !current.inherit) {
      removedOnSave.push(field.id);
    }
  }

  // Stash every kind-specific field under the outgoing kind.
  const stashes: Record<string, Readonly<Record<string, ConfigDraftField>>> = { ...session.stashes };
  if (session.kind !== undefined) {
    const stash: Record<string, ConfigDraftField> = {};
    for (const field of kindSpecific) {
      const current = session.draft.fields[field.id];
      if (current !== undefined) stash[field.id] = current;
    }
    stashes[session.kind] = stash;
  }

  // Restore the target kind's stash; fields without a stash revert to pristine.
  const restore = session.stashes[kind];
  const fields: Record<string, ConfigDraftField> = { ...session.draft.fields };
  for (const field of kindSpecific) {
    const current = fields[field.id];
    if (current === undefined) continue;
    const stashed = field.kinds.includes(kind) ? restore?.[field.id] : undefined;
    fields[field.id] = stashed !== undefined ? stashed
      : field.kinds.includes(kind) && session.kind !== undefined && field.kinds.includes(session.kind)
        ? current : pristineField(initial, field, current);
  }

  const kindCurrent = requireDraftField(session.draft, kindField.id);
  fields[kindField.id] = { ...kindCurrent, value: kind, mode: "present", inherit: false };

  const draft: ConfigDraft = { ...session.draft, fields };
  const next: ConfigEditorSession = {
    page: session.page,
    draft,
    dirty: computeDirty(draft, initial),
    kind,
    removedOnSave,
    stashes,
  };
  INITIAL.set(next, initial);
  return next;
}

// ---------------------------------------------------------------------------
// Ordered-list operations (U08)
// ---------------------------------------------------------------------------

export function sessionListOp(session: ConfigEditorSession, fieldId: string, op: ConfigListOperation): ConfigEditorSession {
  const current = requireDraftField(session.draft, fieldId);
  const rows = listValueOf(current, fieldId);
  switch (op.type) {
    case "insert": {
      assertObjectRowList(rows, fieldId);
      const row: Record<string, unknown> = { ...(op.row ?? {}), _rowId: nextRowId(rows) };
      const index = op.index === undefined ? rows.length : Math.min(Math.max(Math.trunc(op.index), 0), rows.length);
      return setFieldValue(session, fieldId, current, [...rows.slice(0, index), row, ...rows.slice(index)]);
    }
    case "remove": {
      const { index } = locateRow(rows, op.rowId);
      return setFieldValue(session, fieldId, current, [...rows.slice(0, index), ...rows.slice(index + 1)]);
    }
    case "move": {
      const { index: from, row } = locateRow(rows, op.rowId);
      const without = [...rows.slice(0, from), ...rows.slice(from + 1)];
      const to = Math.min(Math.max(Math.trunc(op.toIndex), 0), without.length);
      return setFieldValue(session, fieldId, current, [...without.slice(0, to), row, ...without.slice(to)]);
    }
    case "set": {
      assertSafeKey(op.itemFieldId);
      const { index, row } = locateRow(rows, op.rowId);
      const next = rows.slice();
      next[index] = writeRowField(row, findField(session.page, fieldId), op.itemFieldId, op.value);
      return setFieldValue(session, fieldId, current, next);
    }
  }
}

// ---------------------------------------------------------------------------
// Map operations (U09)
// ---------------------------------------------------------------------------

export function sessionMapOp(session: ConfigEditorSession, fieldId: string, op: ConfigMapOperation): ConfigEditorSession {
  const current = requireDraftField(session.draft, fieldId);
  const entries = listValueOf(current, fieldId);
  switch (op.type) {
    case "insert": {
      if (op.key !== undefined) assertSafeKey(op.key);
      assertObjectRowList(entries, fieldId);
      const field = findField(session.page, fieldId);
      const entry = { _rowId: nextRowId(entries), key: op.key ?? "", value: defaultMapValue(field) };
      return setFieldValue(session, fieldId, current, [...entries, entry]);
    }
    case "remove": {
      const { index } = locateRow(entries, op.rowId);
      return setFieldValue(session, fieldId, current, [...entries.slice(0, index), ...entries.slice(index + 1)]);
    }
    case "setKey": {
      assertSafeKey(op.key);
      const { index, row } = locateRow(entries, op.rowId);
      const next = entries.slice();
      next[index] = { ...row, key: op.key };
      return setFieldValue(session, fieldId, current, next);
    }
    case "setValue": {
      const { index, row } = locateRow(entries, op.rowId);
      const next = entries.slice();
      next[index] = { ...row, value: op.value };
      return setFieldValue(session, fieldId, current, next);
    }
  }
}

/** Duplicate and empty map keys, in first-seen then row order. */
export function sessionMapIssues(session: ConfigEditorSession, fieldId: string): readonly string[] {
  const current = requireDraftField(session.draft, fieldId);
  if (!Array.isArray(current.value)) return [];
  const byKey = new Map<string, string[]>();
  const emptyRows: string[] = [];
  for (const [index, row] of current.value.entries()) {
    if (!isPlainRecord(row)) continue;
    const rowId = typeof row._rowId === "string" ? row._rowId : `#${index}`;
    const key = typeof row.key === "string" ? row.key : "";
    if (key === "") {
      emptyRows.push(rowId);
      continue;
    }
    const rows = byKey.get(key);
    if (rows === undefined) {
      byKey.set(key, [rowId]);
    } else {
      rows.push(rowId);
    }
  }
  const issues: string[] = [];
  for (const [key, rows] of byKey) {
    if (rows.length > 1) {
      issues.push(`duplicate map key "${key}" (rows: ${rows.join(", ")})`);
    }
  }
  for (const rowId of emptyRows) {
    issues.push(`empty map key (row: ${rowId})`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Encoding (U05/U14) and changeset assembly (U22)
// ---------------------------------------------------------------------------

/**
 * Encode the session via encodeChanges. Fields inapplicable to the current
 * kind (except the kind field itself and synthetic carriers such as $extras)
 * are excluded from the draft first; `removed` echoes removedOnSave.
 */
export function sessionEncode(
  session: ConfigEditorSession,
  base: ConfigDecodeInput,
): { readonly operations: readonly ConfigUiOperation[]; readonly removed: readonly string[] } {
  let draft = session.draft;
  const kind = session.kind;
  const initialKind = kindFieldOf(session.page);
  if (kind !== undefined) {
    const initial = initialDraftOf(session);
    const kindChanged = kind !== (initialKind && initial.fields[initialKind.id]?.value);
    const kindFieldId = kindFieldOf(session.page)?.id;
    const fields: Record<string, ConfigDraftField> = {};
    for (const [id, field] of Object.entries(session.draft.fields)) {
      if (id === kindFieldId) {
        fields[id] = field;
        continue;
      }
      const spec = pageFields(session.page).find((candidate) => candidate.id === id);
      if (spec !== undefined && spec.kinds !== undefined && !spec.kinds.includes(kind)) {
        if (!kindChanged && initial.fields[id]) fields[id] = initial.fields[id];
        continue;
      }
      fields[id] = field;
    }
    draft = { ...draft, fields };
  }
  const operations = [...encodeChanges(session.page, draft, base)];
  const entity = session.page.entity;
  if (entity && draft.scope.kind === "entity" && draft.scope.recordId !== null) {
    const nameField = pageFields(session.page).find(field => entity.idField === null
      ? field.id === `${entity.kind}:$name` : field.path.length === 1 && field.path[0] === entity.idField);
    const name = nameField && draft.fields[nameField.id]?.value;
    const original = nameField && initialDraftOf(session).fields[nameField.id]?.value;
    if (typeof name === "string" && name !== original) {
      operations.unshift({ op: "rename", collection: entity.collection, recordId: draft.scope.recordId, newName: name });
    }
  }
  return { operations, removed: session.removedOnSave };
}

/**
 * U22: concatenate session operations in session order; the server applies
 * them atomically. Throws when two sessions target the same collection record.
 */
export function assembleChangeset(
  sessions: readonly ConfigEditorSession[],
  base: ConfigDecodeInput,
): { readonly operations: readonly ConfigUiOperation[] } {
  const operations: ConfigUiOperation[] = [];
  const records = new Set<string>();
  for (const session of sessions) {
    for (const key of sessionRecordKeys(session)) {
      if (records.has(key)) {
        throw new Error(`conflicting changeset: two sessions edit the same record: ${key}`);
      }
      records.add(key);
    }
    operations.push(...sessionEncode(session, base).operations);
  }
  return { operations };
}

/**
 * Conflict identity of an entity session: "<collection>/<recordId>" for
 * existing records, "<collection>/<id field value>" for creates when the id
 * field carries a non-empty string. Globals sessions and unidentifiable
 * creates (map collections, unset id) are not tracked.
 */
function sessionRecordKeys(session: ConfigEditorSession): readonly string[] {
  const scope = session.draft.scope;
  if (scope.kind !== "entity") return [];
  if (scope.recordId !== null) return [`${scope.collection}/${scope.recordId}`];
  const entity = session.page.entity;
  if (entity === undefined || entity.idField === null) return [];
  for (const field of pageFields(session.page)) {
    if (field.path.length === 1 && field.path[0] === entity.idField) {
      const value = session.draft.fields[field.id]?.value;
      return typeof value === "string" && value !== "" ? [`${scope.collection}/${value}`] : [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// API error mapping (U20)
// ---------------------------------------------------------------------------

/**
 * Map API field errors onto draft field ids. Entity errors must address this
 * session's record; path errors match field paths verbatim (already full doc
 * tokens for globals fields, record-value-relative for entity fields),
 * longest prefix wins. Anything unmappable lands under "$global". The first
 * error per field wins.
 */
export function mapApiErrors(
  session: ConfigEditorSession,
  errors: readonly ConfigApiFieldError[],
): Readonly<Record<string, string>> {
  const mapped: Record<string, string> = {};
  for (const error of errors) {
    const fieldId = matchErrorField(session, error);
    const key = fieldId ?? "$global";
    if (mapped[key] === undefined) {
      mapped[key] = error.message;
    }
  }
  return mapped;
}

function matchErrorField(session: ConfigEditorSession, error: ConfigApiFieldError): string | undefined {
  if (error.entity !== undefined && !entityMatches(session, error.entity)) {
    return undefined;
  }
  const path = error.path;
  if (path === undefined) return undefined;
  let best: { readonly id: string; readonly length: number } | undefined;
  for (const field of pageFields(session.page)) {
    if (session.draft.fields[field.id] === undefined) continue;
    const full = field.path;
    if (full.length > path.length) continue;
    let matches = true;
    for (let i = 0; i < full.length; i += 1) {
      if (full[i] !== path[i]) {
        matches = false;
        break;
      }
    }
    if (matches && (best === undefined || full.length > best.length)) {
      best = { id: field.id, length: full.length };
    }
  }
  return best?.id;
}

function entityMatches(session: ConfigEditorSession, entity: { readonly kind: string; readonly id: string }): boolean {
  const scope = session.draft.scope;
  const pageEntity = session.page.entity;
  if (scope.kind !== "entity" || pageEntity === undefined) return false;
  if (pageEntity.kind !== entity.kind) return false;
  return scope.recordId !== null && scope.recordId === entity.id;
}

// ---------------------------------------------------------------------------
// Diff (U21 conflict display)
// ---------------------------------------------------------------------------

/** Recursive structural diff; path tokens join with "." and array "[i]". */
export function diffConfigValues(before: unknown, after: unknown, basePath = ""): readonly ConfigDiffEntry[] {
  const entries: ConfigDiffEntry[] = [];
  diffInto(before, after, basePath, entries);
  return entries;
}

function diffInto(before: unknown, after: unknown, path: string, entries: ConfigDiffEntry[]): void {
  if (deepEqual(before, after)) return;
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPath = path === "" ? key : `${path}.${key}`;
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
      if (hasBefore && hasAfter) {
        diffInto(before[key], after[key], childPath, entries);
      } else if (hasAfter) {
        entries.push({ path: childPath, change: "added", before: undefined, after: after[key] });
      } else {
        entries.push({ path: childPath, change: "removed", before: before[key], after: undefined });
      }
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i += 1) {
      const childPath = `${path}[${i}]`;
      if (i < before.length && i < after.length) {
        diffInto(before[i], after[i], childPath, entries);
      } else if (i < after.length) {
        entries.push({ path: childPath, change: "added", before: undefined, after: after[i] });
      } else {
        entries.push({ path: childPath, change: "removed", before: before[i], after: undefined });
      }
    }
    return;
  }
  entries.push({ path, change: "changed", before, after });
}

// ---------------------------------------------------------------------------
// Rebase (U21)
// ---------------------------------------------------------------------------

/**
 * Rebase onto a fresh server view: fields the user edited (dirty vs the
 * session baseline) keep their edited value/mode/inherit on top of fresh
 * metadata; pristine fields adopt the fresh decode wholesale. baseRevision
 * and fileDigest come from `fresh`; kind and stashes are preserved. The
 * caller surfaces conflicts via diffConfigValues(fresh record, draft record).
 */
export function rebaseSession(session: ConfigEditorSession, fresh: ConfigDecodeInput): ConfigEditorSession {
  if (session.draft.scope.kind === "entity" && session.draft.scope.recordId !== null && fresh.record === null) {
    throw new Error("The record no longer exists. Reload the latest configuration before creating a replacement.");
  }
  const freshDraft = decodeDraft(session.page, fresh);
  const initial = initialDraftOf(session);
  const fields: Record<string, ConfigDraftField> = {};
  for (const [id, freshField] of Object.entries(freshDraft.fields)) {
    const current = session.draft.fields[id];
    if (current === undefined) {
      fields[id] = freshField;
      continue;
    }
    const pristine = initial.fields[id];
    const userDirty = pristine === undefined || fieldsDiffer(current, pristine);
    fields[id] = userDirty
      ? { ...freshField, value: current.value, mode: current.mode, inherit: current.inherit }
      : freshField;
  }
  for (const [id, current] of Object.entries(session.draft.fields)) {
    // Field unknown to the fresh decode (spec drift): keep, never drop.
    if (freshDraft.fields[id] === undefined) fields[id] = current;
  }
  const draft: ConfigDraft = { ...freshDraft, fields };
  const kindField = kindFieldOf(session.page);
  const kind = kindField && fields[kindField.id]?.value;
  const next: ConfigEditorSession = {
    page: session.page,
    draft,
    dirty: computeDirty(draft, freshDraft),
    kind: typeof kind === "string" ? kind : undefined,
    removedOnSave: session.removedOnSave,
    stashes: session.stashes,
  };
  INITIAL.set(next, freshDraft);
  return next;
}

// ---------------------------------------------------------------------------
// Explicit entity actions (set-enabled / delete / rename)
// ---------------------------------------------------------------------------

export function buildEntityAction(action: ConfigEntityAction): ConfigEntityActionOperation {
  switch (action.type) {
    case "set-enabled":
      return { op: "set-enabled", collection: action.collection, recordId: action.recordId, enabled: action.enabled };
    case "delete":
      return { op: "delete", collection: action.collection, recordId: action.recordId };
    case "rename":
      return { op: "rename", collection: action.collection, recordId: action.recordId, newName: action.newName };
  }
}
