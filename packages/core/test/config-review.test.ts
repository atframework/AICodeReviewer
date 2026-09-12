import { describe, expect, it } from "vitest";

import {
  appConfigSchema,
  assertNoSecretEnvIssues,
  applyConfigChangeset,
  buildEffectiveConfigView,
  convertLegacyConfigDocument,
  copyFileEntityAsDatabaseDraft,
  formatConfigPath,
  mergeConfigSources,
  modelRequestOverridesSchema,
  parseConfigDocumentText,
  parseConfigPath,
  parseConfigRuntimeSnapshotRef,
  parseRawConfigSource,
  stableSerialize,
  validateDatabaseDocument,
  type DatabaseConfigDocument,
} from "../src/index.js";

const entries = [{ provider: "main", model: "m1", role: "any" }];

describe("P0 review regressions", () => {
  it("converts into a fresh model map without modifying frozen raw input", () => {
    const model_chain = Object.freeze({ default: entries });
    const input = { llm: { model_chain, triage_fallback_chain: entries } };
    const converted = convertLegacyConfigDocument(input);
    expect(converted.document.llm).toMatchObject({ model_chain: { default: entries, triage: entries } });
    expect(input.llm.model_chain).toEqual({ default: entries });
  });

  it("a rejected conversion leaves the source unchanged", () => {
    const input = { llm: { model_chain: {}, fallback_chain: entries, triage_fallback_chain: entries, triage_model_chain: "fast" } };
    const before = structuredClone(input);
    expect(() => convertLegacyConfigDocument(input)).toThrow();
    expect(input).toEqual(before);
  });

  it.each(["null", '"invalid"', "42"])("does not discard malformed fallback_chain %s when another key converts", (value) => {
    expect(() => parseConfigDocumentText(`llm:\n  fallback_chain: ${value}\n  triage_model_chain:\n    - { provider: main, model: m1, role: any }\n`)).toThrow();
  });

  it.each(["null", '"invalid"', "42"])("does not replace malformed model_chain %s during conversion", (value) => {
    expect(() => parseConfigDocumentText(`llm:\n  model_chain: ${value}\n  fallback_chain:\n    - { provider: main, model: m1, role: any }\n`)).toThrow();
  });

  it("supports model group create, update, rename, copy and projection as ordered arrays", () => {
    const draft = copyFileEntityAsDatabaseDraft({ llm: { model_chain: { default: entries } } }, { kind: "model_group", id: "default" }, "group-record", "copy");
    let database = applyConfigChangeset({}, [{ op: "create", collection: "model_groups", record: draft.record }]);
    const reversed = [{ provider: "main", model: "m2", role: "heavy" }, ...entries];
    database = applyConfigChangeset(database, [
      { op: "update", collection: "model_groups", recordId: "group-record", value: reversed },
      { op: "rename", collection: "model_groups", recordId: "group-record", newName: "default" },
    ]);
    const merged = mergeConfigSources({ database });
    expect(appConfigSchema.parse(merged.document).llm.model_chain.default).toEqual(reversed);
    expect(draft.record.value).toEqual(entries);
  });

  it("rejects a database map key that differs from the immutable record id", () => {
    expect(() => validateDatabaseDocument({ entities: { workspaces: { wrong: { id: "right", name: "project", enabled: true, value: {} } } } })).toThrow();
  });

  it("rejects dangerous entity names before projecting them into config paths", () => {
    expect(() => validateDatabaseDocument({ entities: { workspaces: { record: { id: "record", name: "__proto__", enabled: true, value: {} } } } })).toThrow();
  });

  it("rejects prototype keys in database entity values before schema strips them", () => {
    const value = JSON.parse('{"review":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
    expect(() => validateDatabaseDocument({ entities: { workspaces: { record: { id: "record", name: "project", enabled: true, value } } } })).toThrow();
  });

  it("rejects raw changeset prototype segments before modifying any object", () => {
    const base = { globals: { review: { untouched: true } } };
    const before = structuredClone(base);
    try {
      expect(() => applyConfigChangeset(base, [{ op: "set", path: ["review", "__proto__", "__aicr_config_review_polluted__"], value: true }])).toThrow();
      expect(base).toEqual(before);
      expect(Object.getPrototypeOf({})).not.toHaveProperty("__aicr_config_review_polluted__");
    } finally {
      delete (Object.prototype as Record<string, unknown>).__aicr_config_review_polluted__;
    }
  });

  it("rejects parent writes overlapping a file-locked leaf", () => {
    expect(() => applyConfigChangeset({}, [{ op: "set", path: ["review"], value: { max_files: 1 } }], { fileLocks: new Set(["review.max_files"]) })).toThrow();
  });

  it.each(["set", "unset"] as const)("%s cannot address individual elements of an atomic array", (op) => {
    const base = { globals: { review: { include: ["a", "b"] } } };
    const operation = op === "set"
      ? { op, path: ["review", "include", "0"], value: "c" }
      : { op, path: ["review", "include", "0"] };
    expect(() => applyConfigChangeset(base, [operation])).toThrow();
    expect(base.globals.review.include).toEqual(["a", "b"]);
  });

  it.each([
    { llm: { providers: [null] } },
    { triggers: [{ kind: "github" }] },
    { outputs: { channels: [{ kind: "webhook" }] } },
    { llm: { model_chain: null } },
    { workspaces: { instances: [] } },
  ])("never repairs malformed entity input by dropping it: %j", (file) => {
    expect(() => appConfigSchema.parse(mergeConfigSources({ file }).document)).toThrow();
  });

  it("merging frozen file entities does not mutate input or add collection-wide locks", () => {
    const file = { llm: Object.freeze({ providers: Object.freeze([{ id: "main", kind: "ollama" }]) }) };
    const merged = mergeConfigSources({ file });
    expect(merged.fileLocks.has("llm.providers")).toBe(false);
    expect(merged.fileLocks.has("llm.providers.main")).toBe(true);
  });

  it("file scalar parents cannot be replaced by database entity containers", () => {
    const database: DatabaseConfigDocument = { entities: { providers: { rec: { id: "rec", name: "main", enabled: true, value: { id: "main", kind: "ollama" } } } } };
    expect(() => appConfigSchema.parse(mergeConfigSources({ file: { llm: null }, database }).document)).toThrow();
  });

  it.each(['a: &a { self: *a }', 'a: &a [*a]'])("rejects YAML alias cycles with a config error: %s", (yaml) => {
    expect(() => parseRawConfigSource(yaml)).toThrow(expect.objectContaining({ code: "malformed_yaml" }));
  });

  it("rejects distinct YAML keys that collapse to the same JavaScript property", () => {
    expect(() => parseRawConfigSource('review:\n  1: first\n  "1": second\n')).toThrow();
  });

  it.each([["a]b"], ["a", 'x]"\\y', "last"], ["", "a.b"]])("round-trips quoted config segments %j", (...path) => {
    expect(parseConfigPath(formatConfigPath(path))).toEqual(path);
  });

  it.each([NaN, Infinity, -Infinity])("rejects hash input %s instead of colliding with null", (value) => {
    expect(() => stableSerialize({ value })).toThrow(TypeError);
  });

  it.each([{ snapshotFormat: 2 }, { resolverVersion: "v1" }])("does not classify partial current snapshot %j as legacy", (raw) => {
    expect(() => parseConfigRuntimeSnapshotRef(raw)).toThrow();
  });

  it("effective view retains shadowed database entity fields", () => {
    const merged = mergeConfigSources({
      file: { llm: { providers: [{ id: "main", kind: "ollama", base_url: "http://file" }] } },
      database: { entities: { providers: { rec: { id: "rec", name: "main", enabled: true, value: { id: "main", kind: "ollama", base_url: "http://database" } } } } },
    });
    const view = buildEffectiveConfigView(merged, appConfigSchema.parse(merged.document));
    expect(view.find((field) => field.path === "llm.providers.main.base_url")?.overriddenValues).toEqual([{ source: "database", value: "http://database" }]);
  });

  it.each(["provider", "kind", "base_url", "api_key_env", "unknown_option"])("model request overrides reject non-request field %s", (key) => {
    expect(() => modelRequestOverridesSchema.parse({ [key]: "value" })).toThrow();
  });

  it("model request overrides preserve supported maps and explicit false/zero/empty arrays", () => {
    const overrides = { extra_params: { temperature: 0 }, extra_body: { custom: true }, extra_headers: { "X-Mode": "test" }, parallel_tool_calls: false, seed: 0, drop_params: [], allowed_openai_params: ["seed"] };
    expect(modelRequestOverridesSchema.parse(overrides)).toEqual(overrides);
  });

  it.each(["invalid env", null, 12, []])("secret errors keep structural paths and omit invalid value %j", (value) => {
    expect(() => assertNoSecretEnvIssues({ triggers: [{ token_env: value }] })).toThrow(expect.objectContaining({ code: "invalid_secret_env", path: ["triggers", "0", "token_env"] }));
  });

  it("global unset removes a shadowed database override while preserving the file value", () => {
    const file = { review: { max_files: 10 } };
    const database = { globals: { review: { max_files: 99, output_language: "en-US" } } };
    const before = mergeConfigSources({ file, database });
    const cleared = applyConfigChangeset(database, [{ op: "unset", path: ["review", "max_files"] }], { fileLocks: before.fileLocks });
    expect(mergeConfigSources({ file, database: cleared }).document.review).toEqual({ max_files: 10, output_language: "en-US" });
  });

  it.each([null, false, 0, []])("empty file mappings do not erase explicit database leaf %j", (value) => {
    const merged = mergeConfigSources({ file: { review: {} }, database: { globals: { review: value } } });
    expect(merged.document.review).toEqual(value);
    expect(merged.provenance.get("review")).toBe("database");
    expect(() => appConfigSchema.parse(merged.document)).toThrow();
  });

  it("file locks compare path segments and allow unlocked siblings", () => {
    const context = { fileLocks: new Set([formatConfigPath(["review", "custom.key"])]) };
    expect(() => applyConfigChangeset({}, [{ op: "set", path: ["review"], value: {} }], context)).toThrow();
    expect(applyConfigChangeset({}, [{ op: "set", path: ["review", "custom"], value: true }], context).globals).toEqual({ review: { custom: true } });
  });

  it("database disable/delete and no-op changesets leave the original records intact", () => {
    const base = validateDatabaseDocument({ entities: { model_groups: { record: { id: "record", name: "default", enabled: true, value: entries } } } });
    const disabled = applyConfigChangeset(base, [{ op: "set-enabled", collection: "model_groups", recordId: "record", enabled: false }]);
    expect(mergeConfigSources({ database: disabled }).document).toEqual({});
    expect(applyConfigChangeset(base, [])).toEqual(base);
    expect(base.entities?.model_groups?.record?.enabled).toBe(true);
    expect(applyConfigChangeset(base, [{ op: "delete", collection: "model_groups", recordId: "record" }]).entities?.model_groups).toEqual({});
  });

  it.each(["original", "occupied", "__proto__", ""])("file copies require a new available entity name: %s", (name) => {
    const file = { workspaces: { instances: { original: {}, occupied: {} } } };
    expect(() => copyFileEntityAsDatabaseDraft(file, { kind: "workspace", id: "original" }, "record", name)).toThrow();
  });
});
