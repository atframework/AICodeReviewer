import { describe, expect, it, vi } from "vitest";
import { parseEffectiveConfig } from "../src/config.js";
import { compileExecutionGraph, resolveAnalysisSelection } from "../src/config-compiler.js";
import { diagnoseConfigReadiness, previewConfigChangeset, previewConfigRoute } from "../src/config-preview.js";
import { prepareConfigPublication, prepareConfigRestore, publishConfig, type ConfigPublishInput } from "../src/config-publish.js";
import { contentHashOf, createMemoryConfigStore } from "../src/config-store.js";
import { MigrationRunner, type AppliedMigration, type MigrationStore } from "../src/migration-runner.js";

function publication(overrides: Partial<ConfigPublishInput> = {}): ConfigPublishInput {
  return { namespace: "one", baseRevision: null, operationId: "first", actor: "test",
    file: { review: { output_language: "en" } }, fileDigest: "a".repeat(64), current: {}, operations: [], ...overrides };
}

describe("publication identity and recovery", () => {
  it("reports activation pending when the post-commit head lookup fails", async () => {
    const store = createMemoryConfigStore();
    vi.spyOn(store, "readHead").mockRejectedValue(new Error("offline"));
    await expect(publishConfig(store, prepareConfigPublication(publication()), { install: async () => {} })).resolves.toMatchObject({ status: "committed_activating", stage: "install" });
    expect(await store.readOperation("one", "first")).not.toBeNull();
  });

  it("restores the historical format and audits changes relative to the current revision", async () => {
    const store = createMemoryConfigStore();
    const first = prepareConfigPublication(publication({ formatVersion: 2 }));
    await publishConfig(store, first);
    await publishConfig(store, prepareConfigPublication(publication({ formatVersion: 2, baseRevision: 1, operationId: "second", current: first.document,
      operations: [{ op: "set", path: ["review", "max_files"], value: 22 }] })));
    const restore = await prepareConfigRestore(store, { namespace: "one", revision: 1, baseRevision: 2, operationId: "restore", actor: "test", file: publication().file, fileDigest: publication().fileDigest });
    expect(restore.formatVersion).toBe(2);
    expect(restore.audit.redactedDiff).toMatchObject({ globals: { unset: ["review"] }, restoredFromRevision: 1 });
  });

  it("rejects a changeset preview when the head revision is missing", async () => {
    const store = createMemoryConfigStore();
    vi.spyOn(store, "readHead").mockResolvedValue({ namespace: "one", activeRevision: 1, generation: "1" });
    expect(await previewConfigChangeset({ store, namespace: "one", fileDigest: "digest", operations: [] })).toMatchObject({ valid: false, issue: { code: "store_unavailable" } });
  });

  it("previews enabled effective values rather than disabled database records", async () => {
    const store = createMemoryConfigStore();
    const result = await previewConfigChangeset({ store, namespace: "one", fileDigest: "digest", operations: [
      { op: "create", collection: "channels", record: { id: "disabled", name: "hidden", enabled: false, value: { name: "hidden", kind: "feishu_bot", webhook_url_env: "SECRET_NAME" } } },
    ] });
    expect(result).toMatchObject({ valid: true, baseRevision: null, affected: [] });
  });
  it("uses an actual content digest with stable object ordering", () => {
    expect(contentHashOf({ globals: { review: { max_files: 10, output_language: "en" } } })).toMatch(/^[a-f0-9]{64}$/u);
    expect(contentHashOf({ globals: { review: { max_files: 10, output_language: "en" } } })).toBe(contentHashOf({ globals: { review: { output_language: "en", max_files: 10 } } }));
  });

  it("rejects unknown changeset operations instead of publishing an empty change", () => {
    const operations = [{ op: "upsert" }] as unknown as ConfigPublishInput["operations"];
    expect(() => prepareConfigPublication(publication({ operations }))).toThrowError(expect.objectContaining({ code: "invalid_field_type" }));
  });

  it("audits restored global overrides that are absent in the current document", async () => {
    const store = createMemoryConfigStore();
    const first = prepareConfigPublication(publication({ operations: [{ op: "set", path: ["review", "max_files"], value: 22 }] }));
    await publishConfig(store, first);
    await publishConfig(store, prepareConfigPublication(publication({ baseRevision: 1, operationId: "second" })));
    const restored = await prepareConfigRestore(store, { namespace: "one", revision: 1, baseRevision: 2, operationId: "restore", actor: "test", fileDigest: publication().fileDigest });
    expect(restored.audit.redactedDiff).toMatchObject({ globals: { set: ["review"] } });
  });

  it("isolates snapshots for equal revisions in different namespaces", async () => {
    const store = createMemoryConfigStore();
    const a = await publishConfig(store, prepareConfigPublication(publication()));
    const b = await publishConfig(store, prepareConfigPublication(publication({ namespace: "two", file: { review: { output_language: "zh-CN" } }, fileDigest: "b".repeat(64) })));
    expect(a.status).toBe("committed"); expect(b.status).toBe("committed");
    if (a.status !== "committed" || b.status !== "committed") throw new Error("expected publications");
    expect(a.snapshotId).not.toBe(b.snapshotId);
    expect(await store.readSnapshot(b.snapshotId)).toMatchObject({ namespace: "two", sanitizedEffectiveConfig: { review: { output_language: "zh-CN" } } });
  });

  it("does not install an old operation after a newer revision is published", async () => {
    const store = createMemoryConfigStore();
    const first = prepareConfigPublication(publication());
    await publishConfig(store, first);
    await publishConfig(store, prepareConfigPublication(publication({ operationId: "second", baseRevision: 1, operations: [{ op: "set", path: ["review", "max_files"], value: 22 }] })));
    const install = vi.fn(async () => {});
    await publishConfig(store, first, { install });
    expect(install).not.toHaveBeenCalled();
    expect((await store.readHead("one"))?.activeRevision).toBe(2);
  });

  it("rejects an operation replay with a different file digest", async () => {
    const store = createMemoryConfigStore();
    await publishConfig(store, prepareConfigPublication(publication()));
    await expect(publishConfig(store, prepareConfigPublication(publication({ fileDigest: "b".repeat(64), file: { review: { output_language: "zh-CN" } } })))).rejects.toMatchObject({ code: "operation_conflict" });
  });

  it("does not report readiness for a head whose revision is missing", async () => {
    const store = createMemoryConfigStore();
    vi.spyOn(store, "readHead").mockResolvedValue({ namespace: "one", activeRevision: 1, generation: "1" });
    expect((await diagnoseConfigReadiness({ store, namespace: "one" })).status).not.toBe("ready");
  });

  it("reports failures while reading a revision as store_unavailable", async () => {
    const store = createMemoryConfigStore();
    await publishConfig(store, prepareConfigPublication(publication()));
    vi.spyOn(store, "readRevision").mockRejectedValue(new Error("disconnected"));
    await expect(diagnoseConfigReadiness({ store, namespace: "one" })).resolves.toMatchObject({ status: "store_unavailable" });
  });
});

function routeConfig(overrides: Record<string, unknown> = {}) {
  return parseEffectiveConfig({ triggers: [{ name: "primary", kind: "github" }],
    workspaces: { instances: { service: { match: [{ triggers: ["primary"], source: { repo_ref: { glob: "allowed/*" } } }] } } },
    routing: { rules: [{ id: "route", priority: 1, enabled: true, workspace: "service", match: { triggers: ["primary"] } }] },
    ...overrides }, 2);
}

describe("preview admission and compiler parity", () => {
  it("uses provider fixture facts when rendering a workspace directory", () => {
    const config = routeConfig({ workspaces: { instances: { service: { match: [{ triggers: ["primary"] }], work_path: "{{segment github.repository_id}}" } } } });
    const result = previewConfigRoute(config, { triggerName: "primary", targetKind: "pull_request", repoRef: "allowed/repo", providerFields: { repository_id: "12345" } });
    expect(result.status).toBe("matched");
    if (result.status === "matched") expect(result.layout.sourceRoot).toContain("12345");
  });

  it("inherits an omitted agent field and sandbox image through partial overrides", () => {
    const config = routeConfig({ agent: { default: "kilo", sandbox: { kind: "docker", image: "review:test" } }, workspaces: {
      defaults: { agent: {}, sandbox: { engine: "podman" } }, instances: { service: { match: [{ triggers: ["primary"] }] } },
    } });
    expect(resolveAnalysisSelection(config, "service")).toMatchObject({ agent: { default: "kilo" }, sandbox: { kind: "docker", image: "review:test", engine: "podman" } });
  });
  it("cannot widen a workspace match using an explicit route", () => {
    expect(previewConfigRoute(routeConfig(), { triggerName: "primary", targetKind: "pull_request", repoRef: "denied/repo" }).status).not.toBe("matched");
  });
  it("does not bind a route without repository evidence", () => {
    expect(previewConfigRoute(routeConfig(), { triggerName: "primary", targetKind: "pull_request" }).status).not.toBe("matched");
  });
  it("keeps disabled triggers out of preview", () => {
    expect(previewConfigRoute(routeConfig({ triggers: [{ name: "primary", kind: "github", enabled: false }] }), { triggerName: "primary", targetKind: "pull_request", repoRef: "allowed/repo" }).status).not.toBe("matched");
  });
  it("derives isolated layout from a match binding even without v2 output routing", () => {
    expect(previewConfigRoute(routeConfig({ routing: undefined }), { triggerName: "primary", targetKind: "pull_request", repoRef: "allowed/repo" })).toMatchObject({ status: "matched", graphMode: "legacy", layoutKind: "isolated_v2" });
  });
  it("an explicitly empty v2 routing section remains v2", () => {
    expect(compileExecutionGraph(routeConfig({ routing: { rules: [] } })).mode).toBe("v2");
  });
  it.each([undefined, ["primary"]])("rejects overlapping legacy and v2 catch-all trigger scopes: %j", (triggers) => {
    const config = routeConfig({ outputs: { routes: { rules: [{ summary: [] }] } }, routing: { rules: [{ id: "any", workspace: "service", match: { triggers } }] } });
    expect(() => compileExecutionGraph(config)).toThrowError(expect.objectContaining({ code: "routing_conflict" }));
  });
  it("inherits global agent selection when workspace and route omit it", () => {
    expect(resolveAnalysisSelection(routeConfig({ agent: { default: "kilo" } }), "service").agent).toMatchObject({ default: "kilo" });
  });
});

describe("migration ledger validation", () => {
  const steps = [{ id: "one", fromVersion: 0, toVersion: 1, checksum: "a" }, { id: "two", fromVersion: 1, toVersion: 2, checksum: "b" }];
  it.each([
    [{ ...steps[1]!, appVersion: null, appliedAt: 1 }],
    [{ ...steps[0]!, fromVersion: 5, appVersion: null, appliedAt: 1 }],
    [{ ...steps[0]!, id: "unknown", appVersion: null, appliedAt: 1 }],
  ].map((applied) => ({ applied })))("refuses a non-prefix or conflicting ledger: %j", async ({ applied }: { applied: AppliedMigration[] }) => {
    const store: MigrationStore = { backendKind: "fixture", ledgerExists: async () => true, ensureLedger: async () => {},
      readApplied: async () => applied, withMigrationLock: async (fn) => fn(), applyStep: async () => {}, recordApplied: async () => {} };
    await expect(new MigrationRunner(store, [{ namespace: "test", targetVersion: 2, steps }]).check()).rejects.toMatchObject({ code: "schema_version_unsupported" });
  });
});
