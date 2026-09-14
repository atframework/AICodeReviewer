import { describe, expect, it } from "vitest";

import {
  assembleChangeset,
  buildEntityAction,
  createEditorSession,
  diffConfigValues,
  mapApiErrors,
  rebaseSession,
  sessionEncode,
  sessionListOp,
  sessionMapIssues,
  sessionMapOp,
  sessionSetPresent,
  sessionSetValue,
  sessionSwitchKind,
  sessionToggleInherit,
  type ConfigEditorSession,
} from "../src/config-form-state.js";
import type {
  ConfigDecodeInput,
  ConfigDraft,
  ConfigDraftField,
  ConfigUiField,
  ConfigUiPage,
} from "../src/config-ui-runtime.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function uiField(
  partial: Partial<ConfigUiField> & Pick<ConfigUiField, "id" | "path" | "control" | "valueKind">,
): ConfigUiField {
  return {
    labelKey: `label.${partial.id}`,
    label: partial.id,
    section: "main",
    optional: true,
    binding: "value",
    hasDefault: false,
    ...partial,
  };
}

function draftField(partial: Partial<ConfigDraftField> & Pick<ConfigDraftField, "id">): ConfigDraftField {
  return {
    mode: "present",
    inherit: false,
    value: undefined,
    effectiveValue: undefined,
    provenance: "database",
    overriddenValues: [],
    ...partial,
  };
}

const providerPage: ConfigUiPage = {
  id: "providers",
  label: "Providers",
  entity: {
    kind: "provider",
    collection: "providers",
    idField: "id",
    valueShape: "object",
    kindField: "kind",
    kindOptions: ["openai", "vertex_ai", "bedrock"],
  },
  sections: [
    {
      id: "main",
      label: "Main",
      fields: [
        uiField({ id: "provider:id", path: ["id"], control: "text", valueKind: "string", optional: false }),
        uiField({ id: "provider:kind", path: ["kind"], control: "select", valueKind: "enum", optional: false }),
        uiField({ id: "provider:api_key", path: ["api_key"], control: "secret-ref", valueKind: "string" }),
        uiField({ id: "provider:timeout", path: ["timeout"], control: "number", valueKind: "number", hasDefault: true, defaultValue: 30 }),
        uiField({ id: "provider:vertex_project", path: ["vertex_project"], control: "text", valueKind: "string", kinds: ["vertex_ai"] }),
        uiField({ id: "provider:vertex_location", path: ["vertex_location"], control: "text", valueKind: "string", kinds: ["vertex_ai"] }),
        uiField({ id: "provider:aws_profile", path: ["aws_profile"], control: "text", valueKind: "string", kinds: ["bedrock"], hasDefault: true, defaultValue: "default-profile" }),
        uiField({
          id: "provider:models",
          path: ["models"],
          control: "ordered-list",
          valueKind: "record",
          itemFields: [uiField({ id: "provider:models[].name", path: ["name"], control: "text", valueKind: "string" })],
        }),
        uiField({ id: "provider:labels", path: ["labels"], control: "map", valueKind: "record", mapValueKind: "string" }),
        uiField({ id: "provider:limits", path: ["limits"], control: "map", valueKind: "record", mapValueKind: "number" }),
        uiField({ id: "provider:configs", path: ["configs"], control: "map", valueKind: "record", mapValueKind: "record" }),
      ],
    },
  ],
};

const reviewPage: ConfigUiPage = {
  id: "review",
  label: "Review",
  globals: true,
  sections: [
    {
      id: "main",
      label: "Main",
      fields: [
        uiField({
          id: "review:max_files",
          path: ["review", "max_files"],
          control: "number",
          valueKind: "number",
          binding: "inherit-or-override",
          hasDefault: true,
          defaultValue: 10,
        }),
        uiField({
          id: "review:output_language",
          path: ["review", "output_language"],
          control: "select",
          valueKind: "enum",
          binding: "inherit-or-override",
        }),
      ],
    },
  ],
};

/** Globals page with nested field paths for longest-match error mapping. */
const nestedPage: ConfigUiPage = {
  id: "nested",
  label: "Nested",
  globals: true,
  sections: [
    {
      id: "main",
      label: "Main",
      fields: [
        uiField({ id: "g:a", path: ["g", "a"], control: "toggle", valueKind: "boolean" }),
        uiField({ id: "g:a.b", path: ["g", "a", "b"], control: "text", valueKind: "string" }),
      ],
    },
  ],
};

/** Page whose entity declares a kindField no section field backs. */
const brokenKindPage: ConfigUiPage = {
  id: "broken",
  label: "Broken",
  entity: { kind: "provider", collection: "providers", idField: "id", valueShape: "object", kindField: "kind" },
  sections: [
    {
      id: "main",
      label: "Main",
      fields: [uiField({ id: "provider:id", path: ["id"], control: "text", valueKind: "string" })],
    },
  ],
};

/** Entity page with idField null (map collection) and no kind variants. */
const mapCollectionPage: ConfigUiPage = {
  id: "groups",
  label: "Groups",
  entity: { kind: "model_group", collection: "model_groups", idField: null, valueShape: "object" },
  sections: [
    {
      id: "main",
      label: "Main",
      fields: [uiField({ id: "model_group:$name", path: [], control: "text", valueKind: "string", optional: false })],
    },
  ],
};

/**
 * Session literal bypassing createEditorSession: exercises mechanics without a
 * decoded baseline (the module treats every current field as user-owned).
 */
function craftSession(
  page: ConfigUiPage,
  fields: Record<string, ConfigDraftField>,
  scope?: ConfigDraft["scope"],
): ConfigEditorSession {
  const resolvedScope =
    scope ?? (page.entity !== undefined
      ? { kind: "entity", collection: page.entity.collection, recordId: "rec-1" }
      : { kind: "globals", prefix: ["review"] });
  return {
    page,
    draft: { scope: resolvedScope, fields, baseRevision: 7, fileDigest: "digest-a" },
    dirty: false,
    kind: undefined,
    removedOnSave: [],
    stashes: {},
  };
}

function rowsOf(session: ConfigEditorSession, fieldId: string): Record<string, unknown>[] {
  const field = session.draft.fields[fieldId];
  if (field === undefined || !Array.isArray(field.value)) {
    throw new Error(`test fixture: ${fieldId} is not a row array`);
  }
  return field.value as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// diffConfigValues
// ---------------------------------------------------------------------------

describe("diffConfigValues", () => {
  it("returns no entries for deeply equal values", () => {
    expect(diffConfigValues({ a: [1, { b: "x" }], c: null }, { a: [1, { b: "x" }], c: null })).toEqual([]);
    // Shared deepConfigEqual contract: NaN is not config data and never equal.
    expect(diffConfigValues(Number.NaN, Number.NaN)).toEqual([
      { path: "", change: "changed", before: Number.NaN, after: Number.NaN },
    ]);
  });

  it("reports changed leaves, type changes, and root-level changes", () => {
    expect(diffConfigValues(1, 2)).toEqual([{ path: "", change: "changed", before: 1, after: 2 }]);
    expect(diffConfigValues(undefined, { a: 1 })).toEqual([
      { path: "", change: "changed", before: undefined, after: { a: 1 } },
    ]);
    expect(diffConfigValues({ a: 1 }, [1])).toEqual([{ path: "", change: "changed", before: { a: 1 }, after: [1] }]);
    expect(diffConfigValues({ a: 1, b: { c: "x" } }, { a: 1, b: { c: "y" } })).toEqual([
      { path: "b.c", change: "changed", before: "x", after: "y" },
    ]);
  });

  it("reports added and removed record keys with dotted paths", () => {
    expect(diffConfigValues({ keep: 1, gone: 2 }, { keep: 1, fresh: 3 }, "root")).toEqual([
      { path: "root.gone", change: "removed", before: 2, after: undefined },
      { path: "root.fresh", change: "added", before: undefined, after: 3 },
    ]);
  });

  it("recurses arrays by index and reports length changes", () => {
    expect(diffConfigValues([1, 2, 3], [1, 4])).toEqual([
      { path: "[1]", change: "changed", before: 2, after: 4 },
      { path: "[2]", change: "removed", before: 3, after: undefined },
    ]);
    expect(diffConfigValues([{ a: 1 }], [{ a: 1 }, { b: 2 }], "items")).toEqual([
      { path: "items[1]", change: "added", before: undefined, after: { b: 2 } },
    ]);
    expect(diffConfigValues({ l: [{ d: 1 }] }, { l: [{ d: 2 }] })).toEqual([
      { path: "l[0].d", change: "changed", before: 1, after: 2 },
    ]);
  });

  it("treats arrays and records with different shapes as changed, not recursed", () => {
    expect(diffConfigValues([1, 2], [1], "p")).toEqual([{ path: "p[1]", change: "removed", before: 2, after: undefined }]);
    expect(diffConfigValues({ a: [1, 2] }, { a: [1, 2, 3] })).toEqual([
      { path: "a[2]", change: "added", before: undefined, after: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildEntityAction
// ---------------------------------------------------------------------------

describe("buildEntityAction", () => {
  it("builds set-enabled/delete/rename operation literals", () => {
    expect(buildEntityAction({ type: "set-enabled", collection: "providers", recordId: "p1", enabled: false })).toEqual({
      op: "set-enabled",
      collection: "providers",
      recordId: "p1",
      enabled: false,
    });
    expect(buildEntityAction({ type: "delete", collection: "providers", recordId: "p1" })).toEqual({
      op: "delete",
      collection: "providers",
      recordId: "p1",
    });
    expect(buildEntityAction({ type: "rename", collection: "triggers", recordId: "t1", newName: "t2" })).toEqual({
      op: "rename",
      collection: "triggers",
      recordId: "t1",
      newName: "t2",
    });
  });
});

// ---------------------------------------------------------------------------
// mapApiErrors (U20)
// ---------------------------------------------------------------------------

describe("mapApiErrors (U20)", () => {
  const entitySession = craftSession(providerPage, {
    "provider:id": draftField({ id: "provider:id", value: "rec-1" }),
    "provider:kind": draftField({ id: "provider:kind", value: "openai" }),
    "provider:api_key": draftField({ id: "provider:api_key", value: "KEY" }),
    "provider:models": draftField({ id: "provider:models", value: [] }),
  });

  it("maps entity errors by kind + record id and relative path", () => {
    const mapped = mapApiErrors(entitySession, [
      { entity: { kind: "provider", id: "rec-1" }, path: ["api_key"], message: "bad key" },
    ]);
    expect(mapped).toEqual({ "provider:api_key": "bad key" });
  });

  it("maps errors addressed at array rows to the owning list field", () => {
    const mapped = mapApiErrors(entitySession, [
      { entity: { kind: "provider", id: "rec-1" }, path: ["models", "2", "name"], message: "duplicate model" },
    ]);
    expect(mapped).toEqual({ "provider:models": "duplicate model" });
  });

  it("routes mismatched entity addresses and unmapped paths to $global", () => {
    const mapped = mapApiErrors(entitySession, [
      { entity: { kind: "trigger", id: "rec-1" }, path: ["api_key"], message: "wrong kind" },
      { entity: { kind: "provider", id: "other" }, path: ["api_key"], message: "wrong record" },
      { entity: { kind: "provider", id: "rec-1" }, message: "no path" },
      { entity: { kind: "provider", id: "rec-1" }, path: ["nope"], message: "unknown path" },
      { message: "pathless" },
    ]);
    expect(mapped).toEqual({ $global: "wrong kind" });
    expect(mapApiErrors(entitySession, [{ entity: { kind: "provider", id: "other" }, path: ["api_key"], message: "m" }])).toEqual({
      $global: "m",
    });
  });

  it("matches globals errors against prefix + field path, longest match wins", () => {
    const session = craftSession(nestedPage, {
      "g:a": draftField({ id: "g:a", value: true }),
      "g:a.b": draftField({ id: "g:a.b", value: "x" }),
    }, { kind: "globals", prefix: ["g"] });
    expect(mapApiErrors(session, [{ path: ["g", "a", "b", "deep"], message: "deep" }])).toEqual({ "g:a.b": "deep" });
    expect(mapApiErrors(session, [{ path: ["g", "a"], message: "exact" }])).toEqual({ "g:a": "exact" });
    expect(mapApiErrors(session, [{ path: ["g", "a", "c"], message: "partial" }])).toEqual({ "g:a": "partial" });
    expect(mapApiErrors(session, [{ path: ["other"], message: "miss" }])).toEqual({ $global: "miss" });
    expect(mapApiErrors(session, [{ path: [], message: "empty" }])).toEqual({ $global: "empty" });
  });

  it("ignores page fields the session draft does not contain", () => {
    const session = craftSession(nestedPage, { "g:a": draftField({ id: "g:a", value: true }) }, { kind: "globals", prefix: ["g"] });
    expect(mapApiErrors(session, [{ path: ["g", "a", "b"], message: "m" }])).toEqual({ "g:a": "m" });
    const empty = craftSession(nestedPage, {}, { kind: "globals", prefix: ["g"] });
    expect(mapApiErrors(empty, [{ path: ["g", "a", "b"], message: "m" }])).toEqual({ $global: "m" });
  });

  it("keeps the first error per field and never maps entity errors on globals sessions", () => {
    const globalsSession = craftSession(reviewPage, {
      "review:max_files": draftField({ id: "review:max_files", value: 10 }),
    });
    expect(
      mapApiErrors(globalsSession, [{ entity: { kind: "provider", id: "rec-1" }, path: ["review", "max_files"], message: "m" }]),
    ).toEqual({ $global: "m" });
    expect(
      mapApiErrors(entitySession, [
        { entity: { kind: "provider", id: "rec-1" }, path: ["api_key"], message: "first" },
        { entity: { kind: "provider", id: "rec-1" }, path: ["api_key"], message: "second" },
      ]),
    ).toEqual({ "provider:api_key": "first" });
  });

  it("never maps entity errors when the page declares no entity", () => {
    const session = craftSession(reviewPage, { "review:max_files": draftField({ id: "review:max_files" }) }, {
      kind: "entity",
      collection: "providers",
      recordId: "rec-1",
    });
    expect(mapApiErrors(session, [{ entity: { kind: "provider", id: "rec-1" }, message: "m" }])).toEqual({ $global: "m" });
  });
});

// ---------------------------------------------------------------------------
// sessionListOp (U08)
// ---------------------------------------------------------------------------

describe("sessionListOp (U08)", () => {
  function listSession(value: unknown): ConfigEditorSession {
    return craftSession(providerPage, { "provider:models": draftField({ id: "provider:models", value }) });
  }

  it("inserts rows with generated stable ids, honoring and clamping index", () => {
    const base = listSession([{ _rowId: "r1", name: "a" }, { _rowId: "r2", name: "b" }]);
    const appended = sessionListOp(base, "provider:models", { type: "insert", row: { name: "c" } });
    expect(rowsOf(appended, "provider:models")).toEqual([
      { _rowId: "r1", name: "a" },
      { _rowId: "r2", name: "b" },
      { _rowId: "r3", name: "c" },
    ]);
    const inserted = sessionListOp(base, "provider:models", { type: "insert", index: 1, row: { name: "x" } });
    expect(rowsOf(inserted, "provider:models").map((row) => row.name)).toEqual(["a", "x", "b"]);
    const clampedHigh = sessionListOp(base, "provider:models", { type: "insert", index: 99 });
    expect(rowsOf(clampedHigh, "provider:models")).toEqual([
      { _rowId: "r1", name: "a" },
      { _rowId: "r2", name: "b" },
      { _rowId: "r3" },
    ]);
    const clampedLow = sessionListOp(base, "provider:models", { type: "insert", index: -5, row: { name: "z" } });
    expect(rowsOf(clampedLow, "provider:models").map((row) => row.name)).toEqual(["z", "a", "b"]);
    expect(appended.dirty).toBe(true);
  });

  it("derives the next row id from the max numeric suffix across irregular rows", () => {
    const base = listSession([
      { _rowId: "r2", name: "a" },
      "scalar-row",
      { name: "no-id" },
      { _rowId: "custom", name: "b" },
      { _rowId: "r10", name: "c" },
      { _rowId: "r3", name: "d" },
    ]);
    const next = sessionListOp(base, "provider:models", { type: "insert" });
    const inserted = rowsOf(next, "provider:models");
    expect(inserted[inserted.length - 1]).toEqual({ _rowId: "r11" });
  });

  it("inserts into an absent field as an empty list and overrides supplied row ids", () => {
    const base = listSession(undefined);
    const next = sessionListOp(base, "provider:models", { type: "insert", row: { _rowId: "forged", name: "a" } });
    expect(rowsOf(next, "provider:models")).toEqual([{ _rowId: "r1", name: "a" }]);
  });

  it("removes and moves rows by id; move then set hits the right row", () => {
    const base = listSession([
      { _rowId: "r1", name: "a" },
      { _rowId: "r2", name: "b" },
      { _rowId: "r3", name: "c" },
    ]);
    const removed = sessionListOp(base, "provider:models", { type: "remove", rowId: "r2" });
    expect(rowsOf(removed, "provider:models").map((row) => row.name)).toEqual(["a", "c"]);

    const moved = sessionListOp(base, "provider:models", { type: "move", rowId: "r3", toIndex: 0 });
    expect(rowsOf(moved, "provider:models").map((row) => row.name)).toEqual(["c", "a", "b"]);
    const edited = sessionListOp(moved, "provider:models", { type: "set", rowId: "r2", itemFieldId: "name", value: "B" });
    expect(rowsOf(edited, "provider:models").map((row) => row.name)).toEqual(["c", "a", "B"]);

    const clamped = sessionListOp(base, "provider:models", { type: "move", rowId: "r1", toIndex: 99 });
    expect(rowsOf(clamped, "provider:models").map((row) => row.name)).toEqual(["b", "c", "a"]);
    const clampedLow = sessionListOp(base, "provider:models", { type: "move", rowId: "r3", toIndex: -2 });
    expect(rowsOf(clampedLow, "provider:models").map((row) => row.name)).toEqual(["c", "a", "b"]);
  });

  it("rejects unknown row ids, prototype item keys, and scalar lists", () => {
    const base = listSession([{ _rowId: "r1", name: "a" }]);
    expect(() => sessionListOp(base, "provider:models", { type: "remove", rowId: "nope" })).toThrow(/row not found/);
    expect(() => sessionListOp(base, "provider:models", { type: "move", rowId: "nope", toIndex: 0 })).toThrow(/row not found/);
    expect(() =>
      sessionListOp(base, "provider:models", { type: "set", rowId: "nope", itemFieldId: "name", value: 1 }),
    ).toThrow(/row not found/);
    for (const key of ["__proto__", "prototype", "constructor"]) {
      expect(() => sessionListOp(base, "provider:models", { type: "set", rowId: "r1", itemFieldId: key, value: 1 })).toThrow(
        TypeError,
      );
    }

    const scalar = listSession(["a", "b"]);
    expect(() => sessionListOp(scalar, "provider:models", { type: "insert", row: {} })).toThrow(/scalar list/);
    expect(() => sessionListOp(scalar, "provider:models", { type: "remove", rowId: "r1" })).toThrow(/row not found/);

    const notAList = listSession("oops");
    expect(() => sessionListOp(notAList, "provider:models", { type: "insert" })).toThrow(/not a list/);

    expect(() => sessionListOp(base, "provider:missing", { type: "insert" })).toThrow(/unknown field/);
  });

  it("returns new sessions without mutating the input draft", () => {
    const initialRows = [{ _rowId: "r1", name: "a" }];
    const base = listSession(initialRows);
    const next = sessionListOp(base, "provider:models", { type: "set", rowId: "r1", itemFieldId: "name", value: "b" });
    expect(next).not.toBe(base);
    expect(rowsOf(base, "provider:models")).toEqual([{ _rowId: "r1", name: "a" }]);
    expect(rowsOf(next, "provider:models")).toEqual([{ _rowId: "r1", name: "b" }]);
  });
});

// ---------------------------------------------------------------------------
// sessionMapOp / sessionMapIssues (U09)
// ---------------------------------------------------------------------------

describe("sessionMapOp (U09)", () => {
  function mapSession(fieldId: string, value: unknown): ConfigEditorSession {
    return craftSession(providerPage, { [fieldId]: draftField({ id: fieldId, value }) });
  }

  it("inserts entries with per-kind default values and generated row ids", () => {
    const strings = sessionMapOp(mapSession("provider:labels", []), "provider:labels", { type: "insert", key: "env" });
    expect(rowsOf(strings, "provider:labels")).toEqual([{ _rowId: "r1", key: "env", value: "" }]);
    const numbers = sessionMapOp(mapSession("provider:limits", undefined), "provider:limits", { type: "insert" });
    expect(rowsOf(numbers, "provider:limits")).toEqual([{ _rowId: "r1", key: "", value: undefined }]);
    const records = sessionMapOp(mapSession("provider:configs", []), "provider:configs", { type: "insert" });
    expect(rowsOf(records, "provider:configs")).toEqual([{ _rowId: "r1", key: "", value: {} }]);
  });

  it("edits keys and values by row id and removes entries", () => {
    const base = mapSession("provider:labels", [
      { _rowId: "r1", key: "a", value: "1" },
      { _rowId: "r2", key: "b", value: "2" },
    ]);
    const keyed = sessionMapOp(base, "provider:labels", { type: "setKey", rowId: "r2", key: "b/2.0" });
    expect(rowsOf(keyed, "provider:labels")[1]).toEqual({ _rowId: "r2", key: "b/2.0", value: "2" });
    const valued = sessionMapOp(keyed, "provider:labels", { type: "setValue", rowId: "r1", value: "one" });
    expect(rowsOf(valued, "provider:labels")[0]).toEqual({ _rowId: "r1", key: "a", value: "one" });
    const removed = sessionMapOp(valued, "provider:labels", { type: "remove", rowId: "r2" });
    expect(rowsOf(removed, "provider:labels")).toEqual([{ _rowId: "r1", key: "a", value: "one" }]);
  });

  it("rejects prototype keys, unknown rows, non-list values, and scalar rows", () => {
    const base = mapSession("provider:labels", [{ _rowId: "r1", key: "a", value: "1" }]);
    for (const key of ["__proto__", "prototype", "constructor"]) {
      expect(() => sessionMapOp(base, "provider:labels", { type: "insert", key })).toThrow(TypeError);
      expect(() => sessionMapOp(base, "provider:labels", { type: "setKey", rowId: "r1", key })).toThrow(TypeError);
    }
    expect(() => sessionMapOp(base, "provider:labels", { type: "remove", rowId: "nope" })).toThrow(/row not found/);
    expect(() => sessionMapOp(base, "provider:labels", { type: "setKey", rowId: "nope", key: "x" })).toThrow(/row not found/);
    expect(() => sessionMapOp(base, "provider:labels", { type: "setValue", rowId: "nope", value: 1 })).toThrow(/row not found/);
    expect(() => sessionMapOp(mapSession("provider:labels", "oops"), "provider:labels", { type: "insert" })).toThrow(/not a list/);
    expect(() => sessionMapOp(mapSession("provider:labels", ["scalar"]), "provider:labels", { type: "insert" })).toThrow(
      /scalar list/,
    );
    expect(() => sessionMapOp(base, "provider:missing", { type: "insert" })).toThrow(/unknown field/);
  });
});

describe("sessionMapIssues (U09)", () => {
  it("flags duplicate and empty keys without touching state", () => {
    const session = craftSession(providerPage, {
      "provider:labels": draftField({
        id: "provider:labels",
        value: [
          { _rowId: "r1", key: "dup", value: "1" },
          { _rowId: "r2", key: "ok", value: "2" },
          { _rowId: "r3", key: "dup", value: "3" },
          { _rowId: "r4", key: "", value: "4" },
          "scalar-row",
          { value: "5" },
          { _rowId: "r6", key: 7, value: "6" },
        ],
      }),
    });
    expect(sessionMapIssues(session, "provider:labels")).toEqual([
      'duplicate map key "dup" (rows: r1, r3)',
      "empty map key (row: r4)",
      "empty map key (row: #5)",
      "empty map key (row: r6)",
    ]);
  });

  it("returns no issues for clean or absent map values", () => {
    const clean = craftSession(providerPage, {
      "provider:labels": draftField({ id: "provider:labels", value: [{ _rowId: "r1", key: "a", value: "1" }] }),
    });
    expect(sessionMapIssues(clean, "provider:labels")).toEqual([]);
    const absent = craftSession(providerPage, { "provider:labels": draftField({ id: "provider:labels", value: undefined }) });
    expect(sessionMapIssues(absent, "provider:labels")).toEqual([]);
    expect(() => sessionMapIssues(absent, "provider:missing")).toThrow(/unknown field/);
  });
});

// ---------------------------------------------------------------------------
// sessionToggleInherit (U05) / sessionSetPresent / sessionSetValue guards
// ---------------------------------------------------------------------------

describe("sessionToggleInherit (U05 state)", () => {
  function inheritSession(field: ConfigDraftField): ConfigEditorSession {
    return craftSession(reviewPage, { [field.id]: field });
  }

  it("entering override restores the stored value and marks present", () => {
    const session = inheritSession(draftField({ id: "review:max_files", inherit: true, value: 42 }));
    const next = sessionToggleInherit(session, "review:max_files");
    const field = next.draft.fields["review:max_files"];
    expect(field).toMatchObject({ inherit: false, mode: "present", value: 42 });
  });

  it("entering override with no stored value falls back to the default", () => {
    const session = inheritSession(draftField({ id: "review:max_files", inherit: true, value: undefined }));
    const next = sessionToggleInherit(session, "review:max_files");
    expect(next.draft.fields["review:max_files"]).toMatchObject({ inherit: false, mode: "present", value: 10 });

    const noDefault = inheritSession(draftField({ id: "review:output_language", inherit: true, value: undefined }));
    expect(sessionToggleInherit(noDefault, "review:output_language").draft.fields["review:output_language"]).toMatchObject({
      inherit: false,
      mode: "present",
      value: undefined,
    });
  });

  it("entering inherit keeps the value stored for toggle-back", () => {
    const session = inheritSession(draftField({ id: "review:max_files", inherit: false, value: 0 }));
    const inherited = sessionToggleInherit(session, "review:max_files");
    expect(inherited.draft.fields["review:max_files"]).toMatchObject({ inherit: true, value: 0 });
    const restored = sessionToggleInherit(inherited, "review:max_files");
    expect(restored.draft.fields["review:max_files"]).toMatchObject({ inherit: false, value: 0 });
  });

  it("rejects fields without inherit-or-override binding and unknown fields", () => {
    const session = inheritSession(draftField({ id: "review:max_files" }));
    expect(() => sessionToggleInherit(session, "review:missing")).toThrow(/unknown field/);
    const entity = craftSession(providerPage, { "provider:api_key": draftField({ id: "provider:api_key" }) });
    expect(() => sessionToggleInherit(entity, "provider:api_key")).toThrow(/inherit\/override/);
  });
});

describe("sessionSetPresent", () => {
  function presentSession(field: ConfigDraftField): ConfigEditorSession {
    return craftSession(providerPage, { [field.id]: field });
  }

  it("entering present keeps a stored value, else uses default or effective value", () => {
    const stored = presentSession(draftField({ id: "provider:timeout", mode: "absent", value: 5 }));
    expect(sessionSetPresent(stored, "provider:timeout", true).draft.fields["provider:timeout"]).toMatchObject({
      mode: "present",
      inherit: false,
      value: 5,
    });

    const defaulted = presentSession(draftField({ id: "provider:timeout", mode: "absent", value: undefined }));
    expect(sessionSetPresent(defaulted, "provider:timeout", true).draft.fields["provider:timeout"]).toMatchObject({
      mode: "present",
      value: 30,
    });

    const effective = presentSession(
      draftField({ id: "provider:api_key", mode: "absent", value: undefined, effectiveValue: "EFF" }),
    );
    expect(sessionSetPresent(effective, "provider:api_key", true).draft.fields["provider:api_key"]).toMatchObject({
      mode: "present",
      value: "EFF",
    });

    const bare = presentSession(draftField({ id: "provider:api_key", mode: "absent", value: undefined }));
    expect(sessionSetPresent(bare, "provider:api_key", true).draft.fields["provider:api_key"]).toMatchObject({
      mode: "present",
      value: undefined,
    });
  });

  it("entering absent keeps the value stored for re-present", () => {
    const session = presentSession(draftField({ id: "provider:timeout", value: 12 }));
    const absent = sessionSetPresent(session, "provider:timeout", false);
    expect(absent.draft.fields["provider:timeout"]).toMatchObject({ mode: "absent", value: 12 });
  });

  it("rejects unknown fields", () => {
    const session = presentSession(draftField({ id: "provider:timeout" }));
    expect(() => sessionSetPresent(session, "provider:missing", true)).toThrow(/unknown field/);
  });
});

describe("sessionSetValue guards", () => {
  it("rejects non-string values routed to the kind field and unknown fields", () => {
    const session = craftSession(providerPage, { "provider:kind": draftField({ id: "provider:kind", value: "openai" }) });
    expect(() => sessionSetValue(session, "provider:kind", 42)).toThrow(TypeError);
    expect(() => sessionSetValue(session, "provider:kind", "")).toThrow(TypeError);
    expect(() => sessionSetValue(session, "provider:missing", "x")).toThrow(/unknown field/);
  });

  it("treats crafted sessions without a baseline as fully user-owned (dirty)", () => {
    const session = craftSession(providerPage, { "provider:api_key": draftField({ id: "provider:api_key", value: "K" }) });
    const next = sessionSetValue(session, "provider:api_key", "K");
    expect(next.dirty).toBe(true);
    expect(next.draft.fields["provider:api_key"]).toMatchObject({ mode: "present", inherit: false, value: "K" });
  });
});

// ---------------------------------------------------------------------------
// sessionSwitchKind guards (deep flows need the runtime decode; see below)
// ---------------------------------------------------------------------------

describe("sessionSwitchKind guards", () => {
  it("rejects pages without a kind field, empty kinds, and no-ops on the current kind", () => {
    const globalsSession = craftSession(reviewPage, { "review:max_files": draftField({ id: "review:max_files" }) });
    expect(() => sessionSwitchKind(globalsSession, "x")).toThrow(/no kind field/);

    const broken = craftSession(brokenKindPage, { "provider:id": draftField({ id: "provider:id" }) });
    expect(() => sessionSwitchKind(broken, "openai")).toThrow(/no kind field/);

    const session = craftSession(providerPage, { "provider:kind": draftField({ id: "provider:kind", value: "openai" }) });
    expect(() => sessionSwitchKind(session, "")).toThrow(TypeError);

    const current: ConfigEditorSession = { ...session, kind: "openai" };
    expect(sessionSwitchKind(current, "openai")).toBe(current);
  });

  it("routes kind field edits through the kind switch", () => {
    const session = craftSession(providerPage, {
      "provider:kind": draftField({ id: "provider:kind", value: undefined, mode: "absent", inherit: true }),
      "provider:vertex_project": draftField({ id: "provider:vertex_project", mode: "absent", inherit: true }),
    });
    const next = sessionSetValue(session, "provider:kind", "vertex_ai");
    expect(next.kind).toBe("vertex_ai");
    expect(next.draft.fields["provider:kind"]).toMatchObject({ value: "vertex_ai", mode: "present", inherit: false });
  });
});
// ---------------------------------------------------------------------------
// Runtime-backed fixtures (real decodeDraft/encodeChanges)
// ---------------------------------------------------------------------------

function providerInput(
  value: Record<string, unknown>,
  overrides?: { readonly baseRevision?: number; readonly fileDigest?: string; readonly source?: "file" | "database" },
): ConfigDecodeInput {
  return {
    record: {
      id: "p1",
      name: "Provider One",
      enabled: true,
      value,
      source: overrides?.source ?? "database",
      readonly: false,
      shadowedByFile: false,
      effectiveValue: value,
    },
    baseRevision: overrides?.baseRevision ?? 3,
    fileDigest: overrides?.fileDigest ?? "digest-1",
  };
}

function createInput(): ConfigDecodeInput {
  return { record: null, baseRevision: 3, fileDigest: "digest-1" };
}

function reviewInput(overrides?: { readonly baseRevision?: number; readonly fileDigest?: string }): ConfigDecodeInput {
  return {
    fields: [
      { path: "review.max_files", source: "database", editable: true, effectiveValue: 25, overriddenValues: [] },
      { path: "review.output_language", source: "default", editable: true, effectiveValue: "zh-CN", overriddenValues: [] },
    ],
    baseRevision: overrides?.baseRevision ?? 3,
    fileDigest: overrides?.fileDigest ?? "digest-1",
  };
}

// ---------------------------------------------------------------------------
// createEditorSession
// ---------------------------------------------------------------------------

describe("createEditorSession", () => {
  it("decodes an entity record, derives the current kind, and starts clean", () => {
    const session = createEditorSession(
      providerPage,
      providerInput({ kind: "vertex_ai", vertex_project: "proj", extra_unknown: 1 }),
    );
    expect(session.kind).toBe("vertex_ai");
    expect(session.dirty).toBe(false);
    expect(session.removedOnSave).toEqual([]);
    expect(session.stashes).toEqual({});
    expect(session.draft.scope).toEqual({ kind: "entity", collection: "providers", recordId: "p1" });
    expect(session.draft.fields["provider:kind"]).toMatchObject({ mode: "present", inherit: false, value: "vertex_ai" });
    expect(session.draft.fields["provider:vertex_project"]).toMatchObject({ mode: "present", value: "proj" });
    expect(session.draft.fields["provider:aws_profile"]).toMatchObject({ mode: "absent", inherit: false });
    expect(session.draft.fields["$extras"]).toMatchObject({ mode: "present", value: { extra_unknown: 1 } });
  });

  it("starts create sessions on the first declared kind with a clean baseline", () => {
    const session = createEditorSession(providerPage, createInput());
    expect(session.kind).toBe(providerPage.entity?.kindOptions?.[0]);
    expect(session.dirty).toBe(false);
    expect(session.draft.scope).toEqual({ kind: "entity", collection: "providers", recordId: null });
    expect(session.draft.fields["provider:kind"]).toMatchObject({ mode: "present", inherit: false, value: "openai" });
    const { operations } = sessionEncode(sessionSetValue(session, "provider:id", "p-new"), createInput());
    expect(operations[0]).toMatchObject({ op: "create", record: { id: "p-new", value: { id: "p-new", kind: "openai" } } });
  });

  it("defaults no kind when the entity declares no kind options", () => {
    const { kindOptions: _dropped, ...entityRest } = providerPage.entity!;
    const noKindOptionsPage: ConfigUiPage = { ...providerPage, entity: entityRest };
    const session = createEditorSession(noKindOptionsPage, createInput());
    expect(session.kind).toBeUndefined();
    expect(session.dirty).toBe(false);
    expect(session.draft.fields["provider:kind"]).toMatchObject({ mode: "absent", inherit: false });
  });

  it("treats a missing or empty kind value as no kind", () => {
    expect(createEditorSession(providerPage, providerInput({ api_key: "K" })).kind).toBeUndefined();
    expect(createEditorSession(providerPage, providerInput({ kind: "" })).kind).toBeUndefined();
  });

  it("decodes globals pages with the common path prefix", () => {
    const session = createEditorSession(reviewPage, reviewInput());
    expect(session.kind).toBeUndefined();
    expect(session.dirty).toBe(false);
    expect(session.draft.scope).toEqual({ kind: "globals", prefix: ["review"] });
    expect(session.draft.fields["review:max_files"]).toMatchObject({ mode: "present", inherit: false, value: 25 });
    expect(session.draft.fields["review:output_language"]).toMatchObject({ mode: "absent", inherit: true });
  });
});

// ---------------------------------------------------------------------------
// dirty tracking
// ---------------------------------------------------------------------------

describe("dirty tracking", () => {
  it("flips on edits and clears when values return to the baseline", () => {
    const base = createEditorSession(reviewPage, reviewInput());
    const edited = sessionSetValue(base, "review:max_files", 99);
    expect(edited.dirty).toBe(true);
    expect(base.dirty).toBe(false);
    const reverted = sessionSetValue(edited, "review:max_files", 25);
    expect(reverted.dirty).toBe(false);

    const entity = createEditorSession(providerPage, providerInput({ kind: "vertex_ai", api_key: "KEY" }));
    const touched = sessionSetValue(entity, "provider:api_key", "OTHER");
    expect(touched.dirty).toBe(true);
    expect(sessionSetValue(touched, "provider:api_key", "KEY").dirty).toBe(false);
  });

  it("tracks mode/inherit changes, not only value changes", () => {
    const base = createEditorSession(reviewPage, reviewInput());
    expect(sessionToggleInherit(base, "review:max_files").dirty).toBe(true);
    const entity = createEditorSession(providerPage, providerInput({ kind: "vertex_ai", timeout: 45 }));
    expect(sessionSetPresent(entity, "provider:timeout", false).dirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// U05 inherit/override with encode
// ---------------------------------------------------------------------------

describe("U05 inherit/override round trips through encode", () => {
  it("unset on inherit, set on override, and falsey values are never cleared", () => {
    const base = createEditorSession(reviewPage, reviewInput());

    const zeroed = sessionSetValue(base, "review:max_files", 0);
    expect(sessionEncode(zeroed, reviewInput()).operations).toEqual([
      { op: "set", path: ["review", "max_files"], value: 0 },
    ]);

    const inherited = sessionToggleInherit(base, "review:max_files");
    expect(sessionEncode(inherited, reviewInput()).operations).toEqual([{ op: "unset", path: ["review", "max_files"] }]);

    const restored = sessionToggleInherit(inherited, "review:max_files");
    expect(restored.draft.fields["review:max_files"]).toMatchObject({ inherit: false, value: 25 });
    expect(sessionEncode(restored, reviewInput()).operations).toEqual([]);
  });

  it("override of a default-sourced field emits a set with the default value", () => {
    const base = createEditorSession(reviewPage, reviewInput());
    const override = sessionToggleInherit(base, "review:output_language");
    const ops = sessionEncode(sessionSetValue(override, "review:output_language", "en-US"), reviewInput()).operations;
    expect(ops).toEqual([{ op: "set", path: ["review", "output_language"], value: "en-US" }]);
  });

  it("pristine sessions encode to no operations", () => {
    expect(sessionEncode(createEditorSession(reviewPage, reviewInput()), reviewInput()).operations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// U14/U15 kind switch flows
// ---------------------------------------------------------------------------

describe("sessionSwitchKind (U14/U15)", () => {
  function vertexSession(): ConfigEditorSession {
    return createEditorSession(
      providerPage,
      providerInput({ kind: "vertex_ai", vertex_project: "proj", extra_unknown: 1 }),
    );
  }

  it("stashes kind-specific fields, lists removals, and excludes them from encode", () => {
    const switched = sessionSwitchKind(vertexSession(), "bedrock");
    expect(switched.kind).toBe("bedrock");
    expect(switched.dirty).toBe(true);
    expect(switched.removedOnSave).toEqual(["provider:vertex_project"]);
    expect(Object.keys(switched.stashes)).toEqual(["vertex_ai"]);
    expect(switched.stashes["vertex_ai"]?.["provider:vertex_project"]).toMatchObject({ value: "proj" });

    const edited = sessionSetValue(switched, "provider:aws_profile", "prof");
    const { operations, removed } = sessionEncode(edited, providerInput({}));
    expect(removed).toEqual(["provider:vertex_project"]);
    expect(operations).toEqual([
      {
        op: "update",
        collection: "providers",
        recordId: "p1",
        value: { extra_unknown: 1, kind: "bedrock", aws_profile: "prof" },
      },
    ]);
  });

  it("restores the stash when switching back and keeps later edits per kind", () => {
    const first = vertexSession();
    const toBedrock = sessionSetValue(sessionSwitchKind(first, "bedrock"), "provider:aws_profile", "prof");
    const backToVertex = sessionSwitchKind(toBedrock, "vertex_ai");
    expect(backToVertex.draft.fields["provider:vertex_project"]).toMatchObject({ mode: "present", value: "proj" });
    expect(backToVertex.removedOnSave).toEqual(["provider:aws_profile"]);
    const bedrockAgain = sessionSwitchKind(backToVertex, "bedrock");
    expect(bedrockAgain.draft.fields["provider:aws_profile"]).toMatchObject({ mode: "present", value: "prof" });
  });

  it("excludes state-level edits to inapplicable fields from encode without a switch", () => {
    const session = vertexSession();
    const edited = sessionSetValue(session, "provider:aws_profile", "prof");
    const { operations, removed } = sessionEncode(edited, providerInput({}));
    expect(removed).toEqual([]);
    expect(operations).toEqual([
      {
        op: "update",
        collection: "providers",
        recordId: "p1",
        value: { extra_unknown: 1, kind: "vertex_ai", vertex_project: "proj" },
      },
    ]);
  });

  it("switching away from the defaulted create kind stashes pristine fields and resets the target", () => {
    const created = createEditorSession(providerPage, createInput());
    expect(created.kind).toBe("openai");
    const switched = sessionSwitchKind(created, "vertex_ai");
    expect(switched.kind).toBe("vertex_ai");
    expect(Object.keys(switched.stashes)).toEqual(["openai"]);
    expect(switched.removedOnSave).toEqual([]);
    expect(switched.draft.fields["provider:vertex_project"]).toMatchObject({ mode: "absent" });
    expect(switched.draft.fields["provider:vertex_project"]?.value).toBeUndefined();
    expect(switched.draft.fields["provider:aws_profile"]).toMatchObject({ mode: "absent", value: "default-profile" });
    expect(switched.dirty).toBe(true);
  });

  it("crafted sessions without a baseline synthesize pristine state and skip missing fields", () => {
    const crafted = craftSession(providerPage, {
      "provider:kind": draftField({ id: "provider:kind", value: "vertex_ai" }),
      "provider:vertex_project": draftField({ id: "provider:vertex_project", value: "proj" }),
      "provider:aws_profile": draftField({ id: "provider:aws_profile", value: "prof" }),
    });
    const withKind: ConfigEditorSession = { ...crafted, kind: "vertex_ai" };
    const switched = sessionSwitchKind(withKind, "bedrock");
    expect(switched.removedOnSave).toEqual(["provider:vertex_project"]);
    expect(switched.draft.fields["provider:vertex_project"]).toMatchObject({
      mode: "absent",
      inherit: true,
      value: undefined,
    });
    expect(switched.draft.fields["provider:aws_profile"]).toMatchObject({
      mode: "absent",
      inherit: true,
      value: "default-profile",
    });
    expect(switched.draft.fields["provider:vertex_location"]).toBeUndefined();
    expect(switched.stashes["vertex_ai"]?.["provider:vertex_project"]).toMatchObject({ value: "proj" });
  });

  it("decodes list rows with stable ids so inserts continue the sequence", () => {
    const session = createEditorSession(
      providerPage,
      providerInput({ kind: "openai", models: [{ name: "a" }, { name: "b" }] }),
    );
    const inserted = sessionListOp(session, "provider:models", { type: "insert", row: { name: "c" } });
    expect(rowsOf(inserted, "provider:models").map((row) => [row._rowId, row.name])).toEqual([
      ["r1", "a"],
      ["r2", "b"],
      ["r3", "c"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// sessionEncode entity/globals pass-through
// ---------------------------------------------------------------------------

describe("sessionEncode", () => {
  it("encodes entity updates merged over preserved extras", () => {
    const session = createEditorSession(
      providerPage,
      providerInput({ kind: "vertex_ai", api_key: "KEY", vertex_project: "proj", extra_unknown: { a: 1 } }),
    );
    const edited = sessionSetValue(session, "provider:api_key", "NEW");
    expect(sessionEncode(edited, providerInput({}))).toEqual({
      operations: [
        {
          op: "update",
          collection: "providers",
          recordId: "p1",
          value: { extra_unknown: { a: 1 }, kind: "vertex_ai", api_key: "NEW", vertex_project: "proj" },
        },
      ],
      removed: [],
    });
  });

  it("encodes create operations for record-less sessions", () => {
    const created = createEditorSession(providerPage, createInput());
    const filled = sessionSetValue(sessionSetValue(created, "provider:id", "new-p"), "provider:kind", "openai");
    expect(sessionEncode(filled, createInput()).operations).toEqual([
      {
        op: "create",
        collection: "providers",
        record: { id: "new-p", name: "new-p", enabled: true, value: { id: "new-p", kind: "openai" } },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// rebaseSession (U21)
// ---------------------------------------------------------------------------
describe("rebaseSession (U21)", () => {
  const staleInput = providerInput({ kind: "vertex_ai", api_key: "KEY", vertex_project: "proj", extra_unknown: 1 });
  const freshInput = providerInput(
    { kind: "vertex_ai", api_key: "SERVER", vertex_project: "proj2", timeout: 99, extra_unknown: 1 },
    { baseRevision: 4, fileDigest: "digest-2" },
  );

  it("keeps user-dirty values, adopts fresh values for pristine fields, and refreshes the base", () => {
    const session = sessionSetValue(createEditorSession(providerPage, staleInput), "provider:api_key", "USER");
    const rebased = rebaseSession(session, freshInput);
    expect(rebased.dirty).toBe(true);
    expect(rebased.draft.baseRevision).toBe(4);
    expect(rebased.draft.fileDigest).toBe("digest-2");
    expect(rebased.kind).toBe("vertex_ai");
    expect(rebased.draft.fields["provider:api_key"]).toMatchObject({ value: "USER", mode: "present", inherit: false });
    expect(rebased.draft.fields["provider:vertex_project"]).toMatchObject({ value: "proj2" });
    expect(rebased.draft.fields["provider:timeout"]).toMatchObject({ mode: "present", value: 99 });
  });

  it("clears dirtiness when the server converged to the user's value", () => {
    const session = sessionSetValue(createEditorSession(providerPage, staleInput), "provider:api_key", "SERVER");
    const rebased = rebaseSession(session, freshInput);
    expect(rebased.dirty).toBe(false);
    expect(rebased.draft.fields["provider:api_key"]).toMatchObject({ value: "SERVER" });
  });

  it("surfaces conflicts through diffConfigValues on the fresh and draft records", () => {
    const freshRecord = freshInput.record;
    if (freshRecord === null || freshRecord === undefined) throw new Error("fixture: record required");
    const draftValue = { kind: "vertex_ai", api_key: "USER", vertex_project: "proj", extra_unknown: 1 };
    expect(diffConfigValues(freshRecord.value, draftValue)).toEqual([
      { path: "api_key", change: "changed", before: "SERVER", after: "USER" },
      { path: "vertex_project", change: "changed", before: "proj2", after: "proj" },
      { path: "timeout", change: "removed", before: 99, after: undefined },
    ]);
  });

  it("preserves kind stashes across the rebase", () => {
    const session = sessionSwitchKind(createEditorSession(providerPage, staleInput), "bedrock");
    const rebased = rebaseSession(session, freshInput);
    expect(rebased.kind).toBe("bedrock");
    expect(rebased.stashes["vertex_ai"]?.["provider:vertex_project"]).toMatchObject({ value: "proj" });
    expect(rebased.removedOnSave).toEqual(["provider:vertex_project"]);
  });

  it("treats crafted sessions as fully user-owned and keeps fields the fresh decode lacks", () => {
    const crafted = craftSession(providerPage, {
      "provider:kind": draftField({ id: "provider:kind", value: "openai" }),
      ghost: draftField({ id: "ghost", value: "keep-me" }),
    });
    const rebased = rebaseSession(crafted, freshInput);
    expect(rebased.dirty).toBe(true);
    expect(rebased.draft.fields["ghost"]).toMatchObject({ value: "keep-me" });
    expect(rebased.draft.fields["provider:kind"]).toMatchObject({ value: "openai" });
    expect(rebased.draft.fields["provider:timeout"]).toMatchObject({ value: 99, mode: "present" });
  });
});

// ---------------------------------------------------------------------------
// assembleChangeset (U22)
// ---------------------------------------------------------------------------

describe("assembleChangeset (U22)", () => {
  const providerBaseRecord = providerInput({ kind: "vertex_ai", api_key: "KEY" }).record;
  const reviewBaseFields = reviewInput().fields;
  if (providerBaseRecord === undefined || reviewBaseFields === undefined) throw new Error("fixture: slices required");
  const combinedBase: ConfigDecodeInput = {
    record: providerBaseRecord,
    fields: reviewBaseFields,
    baseRevision: 3,
    fileDigest: "digest-1",
  };

  it("concatenates operations in session order across pages", () => {
    const providerSession = sessionSetValue(
      createEditorSession(providerPage, providerInput({ kind: "vertex_ai", api_key: "KEY" })),
      "provider:api_key",
      "NEW",
    );
    const reviewSession = sessionSetValue(createEditorSession(reviewPage, reviewInput()), "review:max_files", 50);
    const createSession = sessionSetValue(
      sessionSetValue(createEditorSession(providerPage, createInput()), "provider:id", "new-p"),
      "provider:kind",
      "openai",
    );
    const { operations } = assembleChangeset([providerSession, reviewSession, createSession], combinedBase);
    expect(operations).toEqual([
      {
        op: "update",
        collection: "providers",
        recordId: "p1",
        value: { kind: "vertex_ai", api_key: "NEW" },
      },
      { op: "set", path: ["review", "max_files"], value: 50 },
      {
        op: "create",
        collection: "providers",
        record: { id: "new-p", name: "new-p", enabled: true, value: { id: "new-p", kind: "openai" } },
      },
    ]);
  });

  it("throws when two sessions edit the same record, including create vs update", () => {
    const editA = sessionSetValue(
      createEditorSession(providerPage, providerInput({ kind: "vertex_ai", api_key: "KEY" })),
      "provider:api_key",
      "A",
    );
    const editB = sessionSetValue(
      createEditorSession(providerPage, providerInput({ kind: "vertex_ai", api_key: "KEY" })),
      "provider:timeout",
      60,
    );
    expect(() => assembleChangeset([editA, editB], combinedBase)).toThrow(/two sessions edit the same record: providers\/p1/);

    const createP1 = sessionSetValue(createEditorSession(providerPage, createInput()), "provider:id", "p1");
    expect(() => assembleChangeset([editA, createP1], combinedBase)).toThrow(/providers\/p1/);
  });

  it("cannot identify map-collection creates and lets them through untracked", () => {
    const groupA = sessionSetValue(createEditorSession(mapCollectionPage, { record: null, baseRevision: 1, fileDigest: "d" }), "model_group:$name", "g1");
    const groupB = sessionSetValue(createEditorSession(mapCollectionPage, { record: null, baseRevision: 1, fileDigest: "d" }), "model_group:$name", "g1");
    const { operations } = assembleChangeset([groupA, groupB], { baseRevision: 1, fileDigest: "d" });
    expect(operations).toEqual([
      { op: "create", collection: "model_groups", record: { id: "g1", name: "g1", enabled: true, value: {} } },
      { op: "create", collection: "model_groups", record: { id: "g1", name: "g1", enabled: true, value: {} } },
    ]);
  });

  it("skips conflict tracking for creates without a usable id and surfaces the encode error", () => {
    const missing = sessionSetValue(createEditorSession(providerPage, createInput()), "provider:kind", "openai");
    expect(() => assembleChangeset([missing], combinedBase)).toThrow(TypeError);

    const numeric = sessionSetValue(createEditorSession(providerPage, createInput()), "provider:id", 42);
    expect(() => assembleChangeset([numeric], combinedBase)).toThrow(TypeError);

    const noIdFieldPage: ConfigUiPage = {
      id: "no-id",
      label: "NoId",
      entity: { kind: "provider", collection: "providers", idField: "id", valueShape: "object" },
      sections: [
        {
          id: "main",
          label: "Main",
          fields: [uiField({ id: "provider:kind", path: ["kind"], control: "select", valueKind: "enum" })],
        },
      ],
    };
    const noId = createEditorSession(noIdFieldPage, createInput());
    expect(() => assembleChangeset([noId], combinedBase)).toThrow(TypeError);
  });
});
