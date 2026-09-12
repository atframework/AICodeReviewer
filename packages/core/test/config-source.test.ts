import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigError,
  appConfigSchema,
  applyConfigChangeset,
  assertDatabaseGlobalsAllowed,
  assertDatabasePathAllowed,
  assertNoSecretEnvIssues,
  buildEffectiveConfigView,
  collectEntityReferences,
  collectFileEntityIds,
  collectSecretEnvIssues,
  computeConfigDigest,
  convertLegacyConfigDocument,
  copyFileEntityAsDatabaseDraft,
  findReferencesTo,
  mergeConfigSources,
  parseConfigDocumentText,
  parseRawConfigSource,
  stableSerialize,
  validateDatabaseDocument,
  type AppConfigInput,
  type DatabaseConfigDocument,
  type DatabaseEntityRecord,
} from "../src/index.js";

async function loadFixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/config/${name}`, import.meta.url), "utf8");
}

function expectConfigError(fn: () => unknown, code: string): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(code);
    return error as ConfigError;
  }
  throw new Error(`Expected ConfigError ${code} but nothing was thrown.`);
}

// ---------------------------------------------------------------------------
// Raw source parsing (spec §9.1 stage 1)
// ---------------------------------------------------------------------------

describe("parseRawConfigSource", () => {
  it("parses YAML with digest, size, and 1-based source locations", () => {
    const text = "llm:\n  providers:\n    - id: main\n      kind: ollama\n";
    const raw = parseRawConfigSource(text, { fileName: "config.yaml" });
    expect(raw.formatVersion).toBe(1);
    expect(raw.digest).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    expect(raw.byteLength).toBe(Buffer.byteLength(text, "utf8"));
    expect(raw.fileName).toBe("config.yaml");
    const root = raw.root as { llm: { providers: { id: string }[] } };
    expect(root.llm.providers[0]!.id).toBe("main");
    const location = raw.sourceMap.get("llm.providers.0.id");
    expect(location).toBeDefined();
    expect(location!.line).toBe(3);
    expect(location!.column).toBeGreaterThan(1);
  });

  it("expands YAML anchors and aliases", () => {
    const raw = parseRawConfigSource("defaults: &d\n  kind: ollama\na: *d\n");
    const root = raw.root as { a: { kind: string } };
    expect(root.a.kind).toBe("ollama");
  });

  it("treats an empty document as an empty root", () => {
    expect(parseRawConfigSource("").root).toEqual({});
    expect(parseRawConfigSource("# comment only\n").root).toEqual({});
  });

  it("rejects a non-mapping root with the historical message", () => {
    const error = expectConfigError(() => parseRawConfigSource("- a\n- b\n"), "root_not_mapping");
    expect(error.message).toBe("Config file root must be a YAML mapping/object.");
  });

  it("rejects duplicate mapping keys with line information", () => {
    const error = expectConfigError(() => parseRawConfigSource("a: 1\na: 2\n", { fileName: "dup.yaml" }), "malformed_yaml");
    expect(error.message).toContain("dup.yaml");
    expect(error.message).toMatch(/line 2/u);
  });

  it("rejects malformed YAML", () => {
    expectConfigError(() => parseRawConfigSource("a: [1, 2\n  b: ]\n"), "malformed_yaml");
  });

  it("rejects documents above maxBytes", () => {
    expectConfigError(() => parseRawConfigSource("a: 123456789\n", { maxBytes: 4 }), "config_too_large");
  });

  it("rejects prototype keys anywhere in the tree", () => {
    const error = expectConfigError(() => parseRawConfigSource('a:\n  "__proto__": 1\n'), "prototype_key");
    expect(error.path).toEqual(["a", "__proto__"]);
  });

  it("accepts config_version 1 as envelope metadata and strips it", () => {
    const raw = parseRawConfigSource("config_version: 1\nllm: {}\n");
    expect(raw.formatVersion).toBe(1);
    expect(raw.root).not.toHaveProperty("config_version");
    expect(raw.root).toHaveProperty("llm");
  });

  it("rejects config_version above the supported version or non-integer", () => {
    expectConfigError(() => parseRawConfigSource("config_version: 2\n"), "unsupported_config_version");
    expectConfigError(() => parseRawConfigSource('config_version: "1"\n'), "unsupported_config_version");
  });

  it("computeConfigDigest is a stable sha256 of the exact bytes", () => {
    expect(computeConfigDigest("a: 1\n")).toBe(computeConfigDigest("a: 1\n"));
    expect(computeConfigDigest("a: 1\n")).not.toBe(computeConfigDigest("a: 2\n"));
  });
});

// ---------------------------------------------------------------------------
// Legacy format conversion (spec §9.4 stage 2, tests C12-C14)
// ---------------------------------------------------------------------------

describe("convertLegacyConfigDocument", () => {
  it("converts fallback_chain to the default model_chain group preserving order", () => {
    const result = convertLegacyConfigDocument({
      llm: {
        fallback_chain: [
          { provider: "a", model: "m1" },
          { provider: "a", model: "m2" },
        ],
      },
    });
    const llm = result.document.llm as { model_chain: Record<string, unknown> };
    expect(llm.model_chain.default).toEqual([
      { provider: "a", model: "m1" },
      { provider: "a", model: "m2" },
    ]);
    expect(llm).not.toHaveProperty("fallback_chain");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ path: ["llm", "fallback_chain"], kind: "transform" });
  });

  it("converts the array form of llm.model_chain to the default group", () => {
    const result = convertLegacyConfigDocument({
      llm: { model_chain: [{ provider: "a", model: "m1" }] },
    });
    const llm = result.document.llm as { model_chain: Record<string, unknown> };
    expect(llm.model_chain.default).toEqual([{ provider: "a", model: "m1" }]);
  });

  it("converts triage_fallback_chain to a triage group plus triage_model_chain reference", () => {
    const result = convertLegacyConfigDocument({
      llm: { triage_fallback_chain: [{ provider: "a", model: "t1" }] },
    });
    const llm = result.document.llm as { model_chain: Record<string, unknown>; triage_model_chain: string };
    expect(llm.model_chain.triage).toEqual([{ provider: "a", model: "t1" }]);
    expect(llm.triage_model_chain).toBe("triage");
  });

  it("drops a legacy key that duplicates an identical group (rename change)", () => {
    const entries = [{ provider: "a", model: "m1" }];
    const result = convertLegacyConfigDocument({
      llm: { model_chain: { default: entries }, fallback_chain: entries },
    });
    const llm = result.document.llm as Record<string, unknown>;
    expect(llm).not.toHaveProperty("fallback_chain");
    expect(result.changes[0]).toMatchObject({ kind: "rename" });
  });

  it("rejects a legacy key conflicting with an existing group", () => {
    expectConfigError(
      () =>
        convertLegacyConfigDocument({
          llm: {
            model_chain: { default: [{ provider: "a", model: "m1" }] },
            fallback_chain: [{ provider: "a", model: "other" }],
          },
        }),
      "conversion_conflict",
    );
  });

  it("rejects two legacy triage arrays with different content", () => {
    expectConfigError(
      () =>
        convertLegacyConfigDocument({
          llm: {
            triage_fallback_chain: [{ provider: "a", model: "t1" }],
            triage_model_chain: [{ provider: "a", model: "t2" }],
          },
        }),
      "conversion_conflict",
    );
  });

  it("rejects a legacy triage array when triage_model_chain names another group", () => {
    expectConfigError(
      () =>
        convertLegacyConfigDocument({
          llm: {
            triage_fallback_chain: [{ provider: "a", model: "t1" }],
            triage_model_chain: "fast",
          },
        }),
      "conversion_conflict",
    );
  });

  it("is a no-op on already-converted documents (repeatable, C14)", () => {
    const once = convertLegacyConfigDocument({
      llm: { fallback_chain: [{ provider: "a", model: "m1" }] },
    });
    const twice = convertLegacyConfigDocument(once.document);
    expect(twice.changes).toEqual([]);
    expect(twice.document).toBe(once.document);
  });

  it("returns the identical reference when llm is absent or has no legacy keys", () => {
    const doc: AppConfigInput = { review: { max_files: 5 } };
    expect(convertLegacyConfigDocument(doc).document).toBe(doc);
    expect(convertLegacyConfigDocument({ llm: { providers: [] } }).document).toEqual({ llm: { providers: [] } });
  });
});

// ---------------------------------------------------------------------------
// Secret env references (test C04)
// ---------------------------------------------------------------------------

describe("secret env validation", () => {
  it("accepts conventional env names in nested positions", () => {
    expect(() =>
      assertNoSecretEnvIssues({
        llm: { providers: [{ id: "a", api_key_env: "OPENAI_API_KEY" }] },
        server: { auth: { api_key_env: "AICR_API_KEY" } },
      }),
    ).not.toThrow();
  });

  it("collects issues with formatted structural paths", () => {
    const issues = collectSecretEnvIssues({
      triggers: [{ name: "t", token_env: "MY-KEY" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("invalid_secret_env");
    expect(issues[0]!.path).toBe("triggers.0.token_env");
  });

  it("assertNoSecretEnvIssues throws the first issue as ConfigError", () => {
    const error = expectConfigError(() => assertNoSecretEnvIssues({ x_api_key_env: "1BAD" }), "invalid_secret_env");
    expect(error.message).toContain("x_api_key_env");
  });
});

// ---------------------------------------------------------------------------
// Database document validation (tests C01, C06, C08)
// ---------------------------------------------------------------------------

function providerRecord(id: string, name: string, extra: Record<string, unknown> = {}): DatabaseEntityRecord {
  return { id, name, enabled: true, value: { id: name, kind: "ollama", ...extra } };
}

describe("validateDatabaseDocument", () => {
  it("accepts a document with entities and allowed globals", () => {
    const doc = validateDatabaseDocument({
      entities: { providers: { "rec-1": providerRecord("rec-1", "main") } },
      globals: { review: { max_files: 10 } },
    });
    expect(doc.entities?.providers?.["rec-1"]?.name).toBe("main");
  });

  it("rejects duplicate entity names inside one collection (C01)", () => {
    expectConfigError(
      () =>
        validateDatabaseDocument({
          entities: {
            providers: {
              "rec-1": providerRecord("rec-1", "main"),
              "rec-2": providerRecord("rec-2", "main"),
            },
          },
        }),
      "duplicate_entity",
    );
  });

  it("rejects array-collection records whose value id differs from the record name", () => {
    expectConfigError(
      () =>
        validateDatabaseDocument({
          entities: { providers: { "rec-1": providerRecord("rec-1", "main", { id: "other" }) } },
        }),
      "entity_id_mismatch",
    );
  });

  it("rejects routing rule records at format version 1", () => {
    expectConfigError(
      () =>
        validateDatabaseDocument({
          entities: {
            routes: { "rec-1": { id: "rec-1", name: "r1", enabled: true, value: { id: "r1" } } },
          },
        }),
      "unsupported_config_version",
    );
  });

  it("assertDatabaseGlobalsAllowed rejects bootstrap and unknown prefixes", () => {
    expectConfigError(() => assertDatabaseGlobalsAllowed({ server: { port: 1 } }), "bootstrap_readonly");
    expectConfigError(() => assertDatabaseGlobalsAllowed({ routing: { rules: [] } }), "entity_collection_misplaced");
    expectConfigError(() => assertDatabaseGlobalsAllowed({ llm: { providers: [] } }), "entity_collection_misplaced");
    expectConfigError(() => assertDatabaseGlobalsAllowed({ queue: { kind: "redis" } }), "bootstrap_readonly");
  });

  it("assertDatabaseGlobalsAllowed accepts documented business prefixes", () => {
    expect(() =>
      assertDatabaseGlobalsAllowed({
        review: { max_files: 10 },
        llm: { default_model_chain: "fast" },
        workspaces: { defaults: { review: { include: ["src/**"] } } },
        queue: { workers: { concurrency: 2 } },
      }),
    ).not.toThrow();
  });

  it("assertDatabasePathAllowed treats entity collection paths as misplaced, not readonly", () => {
    expectConfigError(() => assertDatabasePathAllowed(["llm", "providers"]), "entity_collection_misplaced");
    expectConfigError(() => assertDatabasePathAllowed(["workspaces", "instances", "w1"]), "entity_collection_misplaced");
    expect(() => assertDatabasePathAllowed(["review", "max_files"])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Source merging and provenance (spec §4.2, tests F01-F08)
// ---------------------------------------------------------------------------

describe("mergeConfigSources", () => {
  it("passes a file-only document through with file provenance and locks", () => {
    const merged = mergeConfigSources({ file: { review: { max_files: 10, include: ["src/**"] } } });
    expect(merged.document).toEqual({ review: { max_files: 10, include: ["src/**"] } });
    expect(merged.provenance.get("review.max_files")).toBe("file");
    expect(merged.fileLocks.has("review.max_files")).toBe(true);
    expect(merged.fileLocks.has("review.include")).toBe(true);
  });

  it("merges database-only entities and globals with database provenance", () => {
    const merged = mergeConfigSources({
      database: {
        entities: { providers: { "rec-1": providerRecord("rec-1", "main") } },
        globals: { review: { max_files: 10 } },
      },
    });
    const llm = (merged.document as { llm: { providers: unknown[] } }).llm;
    expect(llm.providers).toEqual([{ id: "main", kind: "ollama" }]);
    expect(merged.provenance.get("review.max_files")).toBe("database");
    expect(merged.provenance.get("llm.providers.main")).toBe("database");
  });

  it("file entities shadow same-name database entities and are reported", () => {
    const merged = mergeConfigSources({
      file: { llm: { providers: [{ id: "main", kind: "ollama" }] } },
      database: { entities: { providers: { "rec-1": providerRecord("rec-1", "main", { base_url: "http://db" }) } } },
    });
    const llm = (merged.document as { llm: { providers: { kind: string }[] } }).llm;
    expect(llm.providers).toEqual([{ id: "main", kind: "ollama" }]);
    expect(merged.shadowedEntities).toEqual([{ kind: "provider", id: "main" }]);
    expect(merged.provenance.get("llm.providers.main")).toBe("file");
    expect(merged.fileLocks.has("llm.providers.main")).toBe(true);
  });

  it("orders file entities first, then database-only entities (F02)", () => {
    const merged = mergeConfigSources({
      file: { llm: { providers: [{ id: "b", kind: "ollama" }, { id: "a", kind: "ollama" }] } },
      database: {
        entities: {
          providers: {
            "rec-1": providerRecord("rec-1", "a", { base_url: "http://shadowed" }),
            "rec-2": providerRecord("rec-2", "c"),
          },
        },
      },
    });
    const providers = (merged.document as { llm: { providers: { id: string }[] } }).llm.providers;
    expect(providers.map((provider) => provider.id)).toEqual(["b", "a", "c"]);
  });

  it("merges globals per leaf: database additions survive, file leaves win (F03/F04)", () => {
    const merged = mergeConfigSources({
      file: { review: { exclude: ["dist/**"] } },
      database: { globals: { review: { max_files: 10, exclude: ["vendor/**"] } } },
    });
    const review = (merged.document as { review: Record<string, unknown> }).review;
    expect(review.max_files).toBe(10);
    expect(review.exclude).toEqual(["dist/**"]);
    expect(merged.provenance.get("review.max_files")).toBe("database");
    expect(merged.provenance.get("review.exclude")).toBe("file");
    expect(merged.fileLocks.has("review.exclude")).toBe(true);
    expect(merged.fileLocks.has("review.max_files")).toBe(false);
  });

  it("an empty file object declares nothing and locks nothing below it (F07)", () => {
    const merged = mergeConfigSources({
      file: { review: {} },
      database: { globals: { review: { max_files: 10 } } },
    });
    expect((merged.document as { review: Record<string, unknown> }).review.max_files).toBe(10);
    expect(merged.provenance.get("review.max_files")).toBe("database");
  });

  it("a file empty array is an explicit locked leaf (F06)", () => {
    const merged = mergeConfigSources({
      file: { review: { include: [] } },
      database: { globals: { review: { include: ["src/**"] } } },
    });
    expect((merged.document as { review: Record<string, unknown> }).review.include).toEqual([]);
    expect(merged.fileLocks.has("review.include")).toBe(true);
  });

  it("a file scalar wins the whole subtree on type change (F08)", () => {
    const merged = mergeConfigSources({
      file: { review: "disabled" },
      database: { globals: { review: { max_files: 10 } } },
    });
    expect((merged.document as { review: unknown }).review).toBe("disabled");
    expect(merged.provenance.get("review")).toBe("file");
  });

  it("collectFileEntityIds indexes both array and map collections by entity id", () => {
    const ids = collectFileEntityIds({
      llm: { providers: [{ id: "main" }], model_chain: { fast: [] } },
      triggers: [{ name: "gitea-a" }],
      workspaces: { instances: { w1: {} } },
    });
    expect(ids.provider.has("main")).toBe(true);
    expect(ids.model_group.has("fast")).toBe(true);
    expect(ids.trigger.has("gitea-a")).toBe(true);
    expect(ids.workspace.has("w1")).toBe(true);
    expect(ids.channel.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Effective config view (spec §4.2 rule 6, tests F05/F09/F10)
// ---------------------------------------------------------------------------

describe("buildEffectiveConfigView", () => {
  it("marks file-owned and bootstrap fields not editable; database fields editable", () => {
    const merged = mergeConfigSources({
      file: { review: { max_files: 10 } },
      database: { globals: { review: { exclude: ["dist/**"] } } },
    });
    const parsed = appConfigSchema.parse(merged.document);
    const view = buildEffectiveConfigView(merged, parsed);
    const byPath = new Map(view.map((entry) => [entry.path, entry]));
    expect(byPath.get("review.max_files")).toMatchObject({ source: "file", editable: false, effectiveValue: 10 });
    expect(byPath.get("review.exclude")).toMatchObject({ source: "database", editable: true });
    expect(byPath.get("server.port")).toMatchObject({ source: "default", editable: false, effectiveValue: 8080 });
  });

  it("exposes overridden database values under file-owned leaves (F09)", () => {
    const merged = mergeConfigSources({
      file: { review: { max_files: 10 } },
      database: { globals: { review: { max_files: 99 } } },
    });
    const parsed = appConfigSchema.parse(merged.document);
    const view = buildEffectiveConfigView(merged, parsed);
    const entry = view.find((candidate) => candidate.path === "review.max_files");
    expect(entry?.source).toBe("file");
    expect(entry?.overriddenValues).toEqual([{ source: "database", value: 99 }]);
  });

  it("walks entity collections keyed by entity id (F10)", () => {
    const merged = mergeConfigSources({
      database: { entities: { providers: { "rec-1": providerRecord("rec-1", "main", { api_key_env: "OLLAMA_KEY" }) } } },
    });
    const parsed = appConfigSchema.parse(merged.document);
    const view = buildEffectiveConfigView(merged, parsed);
    const entry = view.find((candidate) => candidate.path === "llm.providers.main.api_key_env");
    expect(entry).toMatchObject({ source: "database", editable: true, effectiveValue: "OLLAMA_KEY" });
  });
});

// ---------------------------------------------------------------------------
// Entity references (tests C02/C03)
// ---------------------------------------------------------------------------

const REF_CONFIG: AppConfigInput = {
  llm: {
    providers: [{ id: "main", kind: "ollama" }],
    model_chain: { default: [{ provider: "main", model: "m1", role: "any" }] },
    default_model_chain: "default",
    triage_model_chain: "triage",
    per_provider_overrides: { main: { max_attempts: 2 } },
  },
  triggers: [{ name: "gitea-a", kind: "gitea", repos: [{ match: "/a", workspace: "w1" }] }],
  outputs: {
    channels: [{ name: "summary", kind: "gitea_issue", trigger: "gitea-a" }],
    routes: {
      default: { summary: ["summary"] },
      rules: [{ match: { trigger: "gitea-a" }, line_comments: ["summary"] }],
    },
  },
  workspaces: {
    defaults: { model_chain: "default" },
    instances: {
      w1: {
        model_chain: "fast",
        source_repo: { trigger: "gitea-a", repo: "/a" },
        outputs: { line_comments: ["summary"], channel_overrides: { summary: {} } },
      },
    },
  },
  queue: { rate_limit: { per_provider_rps: { main: 2 } } },
};

describe("collectEntityReferences", () => {
  it("collects every v1 cross-entity reference with formatted source paths", () => {
    const refs = collectEntityReferences(REF_CONFIG);
    const asTuples = refs.map((reference) => [reference.from, `${reference.to.kind}:${reference.to.id}`]);
    expect(asTuples).toContainEqual(["llm.model_chain.default.0.provider", "provider:main"]);
    expect(asTuples).toContainEqual(["llm.default_model_chain", "model_group:default"]);
    expect(asTuples).toContainEqual(["llm.triage_model_chain", "model_group:triage"]);
    expect(asTuples).toContainEqual(["llm.per_provider_overrides.main", "provider:main"]);
    expect(asTuples).toContainEqual(["triggers.0.repos.0.workspace", "workspace:w1"]);
    expect(asTuples).toContainEqual(["outputs.channels.0.trigger", "trigger:gitea-a"]);
    expect(asTuples).toContainEqual(["outputs.routes.default.summary.0", "channel:summary"]);
    expect(asTuples).toContainEqual(["outputs.routes.rules.0.line_comments.0", "channel:summary"]);
    expect(asTuples).toContainEqual(["workspaces.defaults.model_chain", "model_group:default"]);
    expect(asTuples).toContainEqual(["workspaces.instances.w1.model_chain", "model_group:fast"]);
    expect(asTuples).toContainEqual(["workspaces.instances.w1.source_repo.trigger", "trigger:gitea-a"]);
    expect(asTuples).toContainEqual(["workspaces.instances.w1.outputs.line_comments.0", "channel:summary"]);
    expect(asTuples).toContainEqual(["workspaces.instances.w1.outputs.channel_overrides.summary", "channel:summary"]);
    expect(asTuples).toContainEqual(["queue.rate_limit.per_provider_rps.main", "provider:main"]);
  });

  it("findReferencesTo filters by entity identity", () => {
    const refs = findReferencesTo(REF_CONFIG, { kind: "provider", id: "main" });
    expect(refs).toHaveLength(3);
    expect(refs.every((reference) => reference.to.kind === "provider" && reference.to.id === "main")).toBe(true);
    expect(findReferencesTo(REF_CONFIG, { kind: "provider", id: "missing" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Changeset operations (spec §4.3, tests C05/C07/C09, F12)
// ---------------------------------------------------------------------------

describe("applyConfigChangeset", () => {
  const base: DatabaseConfigDocument = {
    entities: {
      providers: { "rec-1": providerRecord("rec-1", "main") },
    },
    globals: { review: { max_files: 10 } },
  };

  it("creates entity records and validates the outcome", () => {
    const next = applyConfigChangeset(base, [
      { op: "create", collection: "providers", record: providerRecord("rec-2", "second") },
    ]);
    expect(Object.keys(next.entities?.providers ?? {})).toEqual(["rec-1", "rec-2"]);
  });

  it("rejects duplicate record ids and duplicate entity names", () => {
    expectConfigError(
      () => applyConfigChangeset(base, [{ op: "create", collection: "providers", record: providerRecord("rec-1", "other") }]),
      "entity_exists",
    );
    expectConfigError(
      () => applyConfigChangeset(base, [{ op: "create", collection: "providers", record: providerRecord("rec-2", "main") }]),
      "entity_exists",
    );
  });

  it("rejects creating an entity whose name the file owns (C05)", () => {
    const fileEntityIds = collectFileEntityIds({ llm: { providers: [{ id: "file-main" }] } });
    expectConfigError(
      () =>
        applyConfigChangeset(base, [{ op: "create", collection: "providers", record: providerRecord("rec-9", "file-main") }], {
          fileEntityIds,
        }),
      "file_owned",
    );
  });

  it("rejects updating or renaming a file-shadowed record but allows deleting it", () => {
    const fileEntityIds = collectFileEntityIds({ llm: { providers: [{ id: "main" }] } });
    expectConfigError(
      () => applyConfigChangeset(base, [{ op: "update", collection: "providers", recordId: "rec-1", value: { id: "main" } }], { fileEntityIds }),
      "file_owned",
    );
    expectConfigError(
      () => applyConfigChangeset(base, [{ op: "rename", collection: "providers", recordId: "rec-1", newName: "renamed" }], { fileEntityIds }),
      "file_owned",
    );
    const next = applyConfigChangeset(base, [{ op: "delete", collection: "providers", recordId: "rec-1" }], { fileEntityIds });
    expect(next.entities?.providers).toEqual({});
  });

  it("rename keeps the value id field in sync for array collections (F12)", () => {
    const next = applyConfigChangeset(base, [{ op: "rename", collection: "providers", recordId: "rec-1", newName: "renamed" }]);
    const record = next.entities?.providers?.["rec-1"];
    expect(record?.name).toBe("renamed");
    expect(record?.value).toMatchObject({ id: "renamed" });
  });

  it("set-enabled toggles without touching the value", () => {
    const next = applyConfigChangeset(base, [{ op: "set-enabled", collection: "providers", recordId: "rec-1", enabled: false }]);
    expect(next.entities?.providers?.["rec-1"]?.enabled).toBe(false);
    expect(next.entities?.providers?.["rec-1"]?.value).toEqual({ id: "main", kind: "ollama" });
  });

  it("rejects operations on missing records", () => {
    expectConfigError(() => applyConfigChangeset(base, [{ op: "update", collection: "providers", recordId: "nope", value: {} }]), "entity_not_found");
    expectConfigError(() => applyConfigChangeset(base, [{ op: "delete", collection: "providers", recordId: "nope" }]), "entity_not_found");
  });

  it("sets and unsets allowed global leaves", () => {
    const next = applyConfigChangeset(base, [{ op: "set", path: ["review", "exclude"], value: ["dist/**"] }]);
    expect(next.globals?.review).toEqual({ max_files: 10, exclude: ["dist/**"] });
    const cleared = applyConfigChangeset(next, [{ op: "unset", path: ["review", "exclude"] }]);
    expect(cleared.globals?.review).toEqual({ max_files: 10 });
  });

  it("rejects unset of a path with no database override", () => {
    expectConfigError(() => applyConfigChangeset(base, [{ op: "unset", path: ["review", "exclude"] }]), "path_not_overridden");
  });

  it("rejects global writes to bootstrap and entity paths (C06)", () => {
    expectConfigError(() => applyConfigChangeset(base, [{ op: "set", path: ["server", "port"], value: 1 }]), "bootstrap_readonly");
    expectConfigError(() => applyConfigChangeset(base, [{ op: "set", path: ["llm", "providers"], value: [] }]), "entity_collection_misplaced");
  });

  it("rejects writes under file-locked paths (F11)", () => {
    expectConfigError(
      () => applyConfigChangeset(base, [{ op: "set", path: ["review", "max_files"], value: 3 }], { fileLocks: new Set(["review.max_files"]) }),
      "file_owned",
    );
  });

  it("is all-or-nothing: a failing operation leaves the base untouched (C09)", () => {
    const before = stableSerialize(base);
    expectConfigError(() =>
      applyConfigChangeset(base, [
        { op: "create", collection: "providers", record: providerRecord("rec-2", "second") },
        { op: "set", path: ["server", "port"], value: 1 },
      ]),
    "bootstrap_readonly");
    expect(stableSerialize(base)).toBe(before);
  });

  it("rejects route record creation at format version 1", () => {
    expectConfigError(
      () =>
        applyConfigChangeset(base, [
          { op: "create", collection: "routes", record: { id: "r1", name: "r1", enabled: true, value: { id: "r1" } } },
        ]),
      "unsupported_config_version",
    );
  });
});

// ---------------------------------------------------------------------------
// Copy file entity as database draft (spec §4.2 rule 7, F11)
// ---------------------------------------------------------------------------

describe("copyFileEntityAsDatabaseDraft", () => {
  it("clones the file entity with a new name and reports references to the original", () => {
    const file: AppConfigInput = {
      llm: {
        providers: [{ id: "main", kind: "ollama", api_key_env: "OLLAMA_KEY" }],
        model_chain: { default: [{ provider: "main", model: "m1", role: "any" }] },
      },
    };
    const draft = copyFileEntityAsDatabaseDraft(file, { kind: "provider", id: "main" }, "rec-2", "main-copy");
    expect(draft.record).toMatchObject({ id: "rec-2", name: "main-copy", enabled: true });
    expect(draft.record.value).toMatchObject({ id: "main-copy", api_key_env: "OLLAMA_KEY" });
    expect(draft.references).toHaveLength(1);
    expect(draft.references[0]).toMatchObject({ from: "llm.model_chain.default.0.provider", to: { kind: "provider", id: "main" } });
  });

  it("rejects a file entity that does not exist", () => {
    expectConfigError(() => copyFileEntityAsDatabaseDraft({}, { kind: "provider", id: "nope" }, "r", "n"), "entity_not_found");
  });
});

// ---------------------------------------------------------------------------
// parseConfigDocumentText pipeline (stages 1-3, C11)
// ---------------------------------------------------------------------------

describe("parseConfigDocumentText", () => {
  it("runs the full raw → convert → schema pipeline", () => {
    const loaded = parseConfigDocumentText("llm:\n  fallback_chain:\n    - provider: main\n      model: m1\n      role: any\n", {
      fileName: "inline.yaml",
    });
    expect(loaded.formatVersion).toBe(1);
    expect(loaded.changes.length).toBeGreaterThan(0);
    expect(loaded.config.llm.model_chain?.["default"]?.[0]?.model).toBe("m1");
  });

  it("rejects malformed YAML with the source name in the message", () => {
    const error = expectConfigError(() => parseConfigDocumentText("a: [1\n", { fileName: "broken.yaml" }), "malformed_yaml");
    expect(error.message).toContain("broken.yaml");
  });
});

// ---------------------------------------------------------------------------
// B-series compatibility fixtures (spec §9.4, tests B01-B05)
// ---------------------------------------------------------------------------

describe("compatibility fixtures", () => {
  it("B01: legacy fallback chains convert to named groups through the load pipeline", async () => {
    const text = await loadFixture("b01-legacy-model-chains.yaml");
    const loaded = parseConfigDocumentText(text, { fileName: "b01-legacy-model-chains.yaml" });
    expect(loaded.config.llm.model_chain?.["default"]?.map((entry) => entry.model)).toEqual([
      "qwen2.5-coder:32b",
      "qwen2.5-coder:14b",
    ]);
    expect(loaded.config.llm.model_chain?.["triage"]?.[0]?.model).toBe("qwen2.5-coder:7b");
    expect(loaded.config.llm.triage_model_chain).toBe("triage");
  });

  it("B02: legacy output routes keep default-first then file order", async () => {
    const text = await loadFixture("b02-output-routes.yaml");
    const loaded = parseConfigDocumentText(text, { fileName: "b02-output-routes.yaml" });
    const routes = loaded.config.outputs?.routes;
    expect(routes?.default?.summary).toEqual(["gitea-summary"]);
    expect(routes?.rules?.map((rule) => rule.match?.target_kind ?? null)).toEqual(["push", null]);
  });

  it("B03: the removed outputs.no_findings alias stays rejected", async () => {
    const text = await loadFixture("b03-no-findings.yaml");
    expect(() => parseConfigDocumentText(text, { fileName: "b03-no-findings.yaml" })).toThrowError(z.ZodError);
  });

  it("B04: deprecated keys under workspaces stay rejected", async () => {
    const text = await loadFixture("b04-deprecated-workspace-keys.yaml");
    expect(() => parseConfigDocumentText(text, { fileName: "b04-deprecated-workspace-keys.yaml" })).toThrowError(z.ZodError);
  });

  it("B05: legacy exact repo bindings parse verbatim (never globs, W10)", async () => {
    const text = await loadFixture("b05-legacy-repo-bindings.yaml");
    const loaded = parseConfigDocumentText(text, { fileName: "b05-legacy-repo-bindings.yaml" });
    const trigger = loaded.config.triggers[0]!;
    expect(trigger.repos).toEqual([
      { match: "/svn/a", workspace: "w1" },
      { match: "/svn/b", workspace: "w2" },
    ]);
    expect(loaded.config.workspaces.instances["w1"]?.source_repo).toEqual({ trigger: "svn-main", repo: "/svn/a" });
  });

});

describe("changeset passthrough preservation (C06)", () => {
  it("preserves unknown extension keys on untouched records and file passthrough fields", () => {
    const base: DatabaseConfigDocument = {
      entities: {
        providers: {
          "rec-1": {
            id: "rec-1",
            name: "main",
            enabled: true,
            value: { id: "main", kind: "openai_compatible", future_plugin: { nested: [1, 2] } },
          },
        },
      },
    };
    const next = applyConfigChangeset(base, [
      {
        op: "create",
        collection: "triggers",
        record: {
          id: "rec-2",
          name: "git",
          enabled: true,
          value: { name: "git", kind: "manual", legacy_flag: true },
        },
      },
    ]);
    // The untouched provider record keeps its unknown extension byte-stable.
    expect(stableSerialize(next.entities?.providers?.["rec-1"])).toBe(
      stableSerialize(base.entities?.providers?.["rec-1"]),
    );
    // File-side passthrough survives the merge and the final schema parse.
    const merged = mergeConfigSources({
      file: { triggers: [{ name: "git-file", kind: "manual", legacy_flag: true }] },
      database: next,
    });
    const config = appConfigSchema.parse(merged.document);
    expect(config.triggers.map((trigger) => (trigger as Record<string, unknown>).legacy_flag)).toEqual([true, true]);
  });
});

describe("unset restores lower-layer value (F08)", () => {
  it("removing a database-only override falls back to schema defaults, not JSON null", () => {
    const base: DatabaseConfigDocument = {
      globals: { review: { exclude: ["db-glob"], max_files: 99 } },
    };
    const withOverride = mergeConfigSources({ database: base });
    expect(withOverride.document.review).toEqual({ exclude: ["db-glob"], max_files: 99 });

    const removed = applyConfigChangeset(base, [
      { op: "unset", path: ["review", "exclude"] },
      { op: "unset", path: ["review", "max_files"] },
    ]);
    const restored = mergeConfigSources({ database: removed });
    expect(restored.document.review).toBeUndefined();
    const config = appConfigSchema.parse(restored.document);
    expect(config.review.exclude).toEqual(["**/vendor/**", "**/*.min.js", "**/*.lock"]);
    expect(config.review.max_files).toBe(50);
  });

  it("keeps file-declared leaves intact while the database override exists (F03)", () => {
    const merged = mergeConfigSources({
      file: { review: { exclude: ["file-glob"] } },
      database: { globals: { review: { exclude: ["db-glob"], max_files: 99 } } },
    });
    // File explicit leaf wins over the database override; the db-only leaf survives.
    expect(merged.document.review).toEqual({ exclude: ["file-glob"], max_files: 99 });
    expect(merged.fileLocks.has("review.exclude")).toBe(true);
    expect(merged.provenance.get("review.max_files")).toBe("database");
  });
});
