import { describe, expect, it } from "vitest";

import {
  CONFIG_ENTITY_COLLECTIONS,
  CONFIG_ERROR_CODES,
  ConfigError,
  CONFIG_MATCHER_LIMITS,
  LEGACY_SNAPSHOT_IMPORT,
  computeWorkspaceInstanceId,
  entityCollectionsForVersion,
  entityPath,
  formatConfigPath,
  formatEntityRef,
  formatConfigGeneration,
  isConfigError,
  isPrototypeKey,
  parseConfigPath,
  parseConfigGeneration,
  parseConfigRuntimeSnapshotRef,
  stableConfigHash,
  stableSerialize,
  validateConfigMatcher,
  validateConfigNamespace,
  validateConfigRevisionNumber,
  validateWorkspaceDefinitionId,
  type ConfigPath,
} from "../src/index.js";

describe("config-format path utilities", () => {
  it("formats nested segments with dot separators", () => {
    expect(formatConfigPath(["llm", "retry", "backoff"])).toBe("llm.retry.backoff");
  });

  it("formats integer segments as plain keys (entities are addressed by id)", () => {
    expect(formatConfigPath(["triggers", "0", "name"])).toBe("triggers.0.name");
  });

  it("JSON-quotes segments that are not plain identifiers", () => {
    expect(formatConfigPath(["a", "__proto__"])).toBe('a["__proto__"]');
    expect(formatConfigPath(["constructor"])).toBe("constructor");
    expect(formatConfigPath(["outputs", "my.channel"])).toBe('outputs["my.channel"]');
  });

  it("parseConfigPath round-trips formatted paths", () => {
    const cases: ConfigPath[] = [
      ["llm", "retry", "backoff"],
      ["triggers", "0", "name"],
      ["outputs", "my.channel"],
      ["review"],
    ];
    for (const path of cases) {
      expect(parseConfigPath(formatConfigPath(path))).toEqual(path);
    }
  });

  it("parseConfigPath rejects prototype segments and malformed input", () => {
    expect(() => parseConfigPath("a.__proto__")).toThrow(ConfigError);
    expect(() => parseConfigPath("constructor")).toThrow(ConfigError);
    expect(() => parseConfigPath("a..b")).toThrow(ConfigError);
    expect(() => parseConfigPath("a[-1]")).toThrow(ConfigError);
    expect(() => parseConfigPath("a[1x]")).toThrow(ConfigError);
  });

  it("isPrototypeKey covers the three dangerous keys only", () => {
    expect(isPrototypeKey("__proto__")).toBe(true);
    expect(isPrototypeKey("prototype")).toBe(true);
    expect(isPrototypeKey("constructor")).toBe(true);
    expect(isPrototypeKey("proto")).toBe(false);
  });
});

describe("config revision, matcher and snapshot contracts", () => {
  it.each(["main", "a.b_c-1", "a".repeat(64)])("accepts namespace %s", (namespace) => {
    expect(validateConfigNamespace(namespace)).toBe(namespace);
  });

  it.each(["", "a".repeat(65), "bad/namespace", "has space", 1, null])("rejects namespace %j", (namespace) => {
    expect(() => validateConfigNamespace(namespace)).toThrow(ConfigError);
  });

  it.each([1, Number.MAX_SAFE_INTEGER])("accepts revision %s", (revision) => {
    expect(validateConfigRevisionNumber(revision)).toBe(revision);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "1", null])("rejects revision %j", (revision) => {
    expect(() => validateConfigRevisionNumber(revision)).toThrow(ConfigError);
  });

  it("round-trips generation above JS safe integers without precision loss", () => {
    const generation = "18446744073709551616";
    expect(formatConfigGeneration(parseConfigGeneration(generation))).toBe(generation);
    expect(formatConfigGeneration(parseConfigGeneration("0"))).toBe("0");
    expect(() => formatConfigGeneration(-1n)).toThrow(ConfigError);
  });

  it.each([1, null, "", "-1", "1.0", "1e3", " 1"])("rejects malformed generation %j", (generation) => {
    expect(() => parseConfigGeneration(generation)).toThrow(ConfigError);
  });

  it.each([{ exact: "project" }, { glob: "owner/*", ignore_case: false }, { regex: "^main$", ignore_case: true }])("accepts matcher %j without changing it", (matcher) => {
    expect(validateConfigMatcher(matcher)).toEqual(matcher);
  });

  it.each([{}, { exact: "" }, { glob: "x", regex: "y" }, { regex: "x", ignore_case: 1 }, { exact: "x", extra: true }, { exact: "x", ignore_case: true }])("rejects invalid matcher shape %j", (matcher) => {
    expect(() => validateConfigMatcher(matcher, ["match"])).toThrow(expect.objectContaining({ code: "matcher_invalid", path: ["match"] }));
  });

  it("measures matcher limits in UTF-8 bytes", () => {
    expect(validateConfigMatcher({ exact: "a".repeat(CONFIG_MATCHER_LIMITS.maxExpressionBytes) })).toHaveProperty("exact");
    expect(() => validateConfigMatcher({ exact: "中".repeat(Math.floor(CONFIG_MATCHER_LIMITS.maxExpressionBytes / 3) + 1) })).toThrow(ConfigError);
  });

  it.each(["project", "Project.a-1_2", "a".repeat(128)])("accepts definition id %s", (id) => {
    expect(validateWorkspaceDefinitionId(id)).toBe(id);
  });

  it.each(["", "cache", "defaults", "instances", "../escape", "x/y", "x\\y", " has-space", "a".repeat(129)])("rejects definition id %s", (id) => {
    expect(() => validateWorkspaceDefinitionId(id)).toThrow(ConfigError);
  });

  it("identity includes definition, trigger, VCS and canonical project, independent of object key order", () => {
    const input = { definitionId: "definition", triggerName: "github-main", vcs: "git", canonicalProjectKey: "host/owner/repo" };
    const identity = computeWorkspaceInstanceId(input);
    expect(identity).toMatch(/^[0-9a-f]{64}$/u);
    expect(computeWorkspaceInstanceId({ canonicalProjectKey: input.canonicalProjectKey, vcs: input.vcs, triggerName: input.triggerName, definitionId: input.definitionId })).toBe(identity);
    for (const key of Object.keys(input)) {
      expect(computeWorkspaceInstanceId({ ...input, [key]: "other" })).not.toBe(identity);
    }
  });

  const snapshot = { snapshotFormat: 1, fileDigest: "a".repeat(64), databaseRevision: 1, resolverVersion: "v1", contentHash: "b".repeat(64) };

  it("distinguishes legacy, current and imported snapshot references", () => {
    expect(parseConfigRuntimeSnapshotRef({ runId: "old" })).toEqual({ kind: "legacy" });
    expect(parseConfigRuntimeSnapshotRef(snapshot)).toEqual({ kind: "current", ref: snapshot });
    expect(parseConfigRuntimeSnapshotRef({ ...snapshot, databaseRevision: LEGACY_SNAPSHOT_IMPORT })).toMatchObject({ kind: "current", ref: { databaseRevision: LEGACY_SNAPSHOT_IMPORT } });
  });

  it.each([null, [], 1, { ...snapshot, snapshotFormat: 2 }, { ...snapshot, fileDigest: "x" }, { ...snapshot, contentHash: "y" }, { ...snapshot, databaseRevision: 0 }, { ...snapshot, resolverVersion: "" }])("rejects malformed snapshot %j", (raw) => {
    expect(() => parseConfigRuntimeSnapshotRef(raw)).toThrow(ConfigError);
  });

  it("hashes repeated references but rejects object and array cycles", () => {
    const shared = { a: 1 };
    expect(stableSerialize([shared, shared])).toBe(stableSerialize([{ a: 1 }, { a: 1 }]));
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push(array);
    expect(() => stableSerialize(object)).toThrow(TypeError);
    expect(() => stableSerialize(array)).toThrow(TypeError);
  });
});

describe("config-format stable serialization", () => {
  it("serializes objects with sorted keys regardless of insertion order", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(stableSerialize(a)).toBe(stableSerialize(b));
  });

  it("keeps array order significant", () => {
    expect(stableSerialize([1, 2])).not.toBe(stableSerialize([2, 1]));
  });

  it("rejects values JSON cannot represent losslessly", () => {
    expect(() => stableSerialize({ n: 1n })).toThrow(TypeError);
    expect(() => stableSerialize({ f: () => 1 })).toThrow(TypeError);
  });

  it("stableConfigHash is order-independent and change-sensitive", () => {
    const hash = stableConfigHash({ b: 1, a: 2 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).toBe(stableConfigHash({ a: 2, b: 1 }));
    expect(hash).not.toBe(stableConfigHash({ a: 2, b: 3 }));
  });
});

describe("config-format entity registry", () => {
  it("formats entity refs as id-keyed config paths for all six kinds", () => {
    expect(formatEntityRef({ kind: "provider", id: "main-1" })).toBe("llm.providers.main-1");
    expect(formatEntityRef({ kind: "model_group", id: "fast" })).toBe("llm.model_chain.fast");
    expect(formatEntityRef({ kind: "trigger", id: "gitea-a" })).toBe("triggers.gitea-a");
    expect(formatEntityRef({ kind: "channel", id: "summary" })).toBe("outputs.channels.summary");
    expect(formatEntityRef({ kind: "workspace", id: "w1" })).toBe("workspaces.instances.w1");
    expect(formatEntityRef({ kind: "route", id: "r1" })).toBe("routing.rules.r1");
  });

  it("registers collection shape, path, and id field per entity kind", () => {
    expect(CONFIG_ENTITY_COLLECTIONS.provider).toMatchObject({
      shape: "array",
      path: ["llm", "providers"],
      idField: "id",
    });
    expect(CONFIG_ENTITY_COLLECTIONS.model_group).toMatchObject({
      shape: "map",
      path: ["llm", "model_chain"],
      idField: null,
    });
    expect(CONFIG_ENTITY_COLLECTIONS.workspace).toMatchObject({
      shape: "map",
      path: ["workspaces", "instances"],
      idField: null,
    });
    expect(CONFIG_ENTITY_COLLECTIONS.route).toMatchObject({
      shape: "array",
      path: ["routing", "rules"],
      idField: "id",
      since: 2,
    });
  });

  it("entityPath appends the entity id to the collection path", () => {
    expect(entityPath({ kind: "provider", id: "main" })).toEqual(["llm", "providers", "main"]);
    expect(entityPath({ kind: "route", id: "r1" })).toEqual(["routing", "rules", "r1"]);
  });

  it("v1 exposes five collections; routing rules join at v2", () => {
    const v1Kinds = entityCollectionsForVersion(1).map((collection) => collection.kind);
    const v2Kinds = entityCollectionsForVersion(2).map((collection) => collection.kind);
    expect(v1Kinds).toEqual(["provider", "model_group", "trigger", "channel", "workspace"]);
    expect(v2Kinds).toContain("route");
    expect(v2Kinds).toHaveLength(v1Kinds.length + 1);
  });
});

describe("config-format errors", () => {
  it("ConfigError carries code, path, and entity details", () => {
    const error = new ConfigError("file_owned", "locked", {
      path: ["review"],
      entity: { kind: "provider", id: "main" },
    });
    expect(error.code).toBe("file_owned");
    expect(error.message).toBe("locked");
    expect(error.path).toEqual(["review"]);
    expect(error.entity).toEqual({ kind: "provider", id: "main" });
    expect(error).toBeInstanceOf(Error);
  });

  it("isConfigError narrows by instance and optional code", () => {
    const error = new ConfigError("entity_not_found", "missing");
    expect(isConfigError(error)).toBe(true);
    expect(isConfigError(error, "entity_not_found")).toBe(true);
    expect(isConfigError(error, "file_owned")).toBe(false);
    expect(isConfigError(new Error("x"))).toBe(false);
  });

  it("CONFIG_ERROR_CODES pins the contract vocabulary", () => {
    expect([...CONFIG_ERROR_CODES].sort()).toEqual(
      [
        "ambiguous_route",
        "binding_conflict",
        "bootstrap_readonly",
        "committed_activating",
        "config_too_large",
        "config_path_invalid",
        "conversion_conflict",
        "definition_id_invalid",
        "duplicate_entity",
        "entity_collection_misplaced",
        "entity_exists",
        "entity_id_mismatch",
        "entity_not_found",
        "file_config_mismatch",
        "file_owned",
        "invalid_field_type",
        "invalid_reference",
        "invalid_secret_env",
        "malformed_yaml",
        "match_rule_invalid",
        "migration_failed",
        "matcher_invalid",
        "no_route",
        "operation_conflict",
        "path_not_overridden",
        "prototype_key",
        "repository_not_configured",
        "revision_conflict",
        "revision_invalid",
        "root_not_mapping",
        "routing_conflict",
        "routing_invalid",
        "schema_version_unsupported",
        "snapshot_invalid",
        "store_unavailable",
        "template_invalid",
        "unsupported_capability",
        "unsupported_config_version",
      ].sort(),
    );
  });
});
