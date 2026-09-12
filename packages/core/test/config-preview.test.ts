/**
 * Preview + readiness tests (P3e): changeset preview is side-effect free,
 * route preview reuses the admission resolution path (R13), and readiness
 * reports the documented status vocabulary.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  diagnoseConfigReadiness,
  previewConfigChangeset,
  previewConfigRoute,
} from "../src/config-preview.js";
import { prepareConfigPublication, publishConfig } from "../src/config-publish.js";
import { parseEffectiveConfig } from "../src/config.js";
import type { ConfigStore } from "../src/config-store.js";
import { createSqliteConfigStore } from "../src/sqlite-config-store.js";

const NAMESPACE = "workspace:preview";
const DIGEST = "c".repeat(64);

let dir: string;
let store: ConfigStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aicr-config-preview-"));
  store = await createSqliteConfigStore({ path: join(dir, "config.sqlite") });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function v2Config(overrides: Record<string, unknown> = {}) {
  return parseEffectiveConfig(
    {
      llm: {
        providers: [{ id: "main", kind: "ollama" }],
        model_chain: { default: [{ provider: "main", model: "m", role: "any" }] },
      },
      triggers: [{ name: "github-main", kind: "github", token_env: "GH_TOKEN" }],
      outputs: {
        channels: [
          { name: "gh-review", kind: "github_pr_review", owner: "acme", repo: "svc", token_env: "GH_TOKEN" },
        ],
      },
      workspaces: {
        root: "/data/workspaces",
        defaults: {},
        instances: {
          "product-services": {
            match: [{ source: { repo_ref: { glob: "acme/*" } } }],
          },
        },
      },
      routing: {
        rules: [
          {
            id: "r-pr",
            enabled: true,
            priority: 100,
            workspace: "product-services",
            match: { triggers: ["github-main"], target_kinds: ["pull_request"] },
            outputs: { line_comments: ["gh-review"] },
          },
        ],
      },
      ...overrides,
    },
    2,
  );
}

describe("previewConfigChangeset", () => {
  const operations = [
    { op: "create" as const, collection: "channels" as const, record: { id: "rec-chat", name: "chat", enabled: true, value: { name: "chat", kind: "feishu_bot", webhook_url_env: "FEISHU_URL" } } },
  ];

  it("returns the impact view without committing anything", async () => {
    const preview = await previewConfigChangeset({ store, namespace: NAMESPACE, file: {}, fileDigest: DIGEST, operations });
    expect(preview.valid).toBe(true);
    if (!preview.valid) return;
    expect(preview.baseRevision).toBeNull();
    expect(preview.affected).toMatchObject([
      { kind: "channels", id: "chat", value: { name: "chat", kind: "feishu_bot", webhook_url_env: "FEISHU_URL" } },
    ]);
    // Side-effect boundary: no head, no revisions, no audits, no snapshots.
    await expect(store.readHead(NAMESPACE)).resolves.toBeNull();
    await expect(store.listRevisions(NAMESPACE)).resolves.toEqual([]);
    await expect(store.readAudit(NAMESPACE)).resolves.toEqual([]);
  });

  it("reports shadowed database records in the preview", async () => {
    // r1: DB owns channel "chat".
    await publishConfig(
      store,
      prepareConfigPublication({
        namespace: NAMESPACE,
        baseRevision: null,
        operationId: "op-1",
        actor: "tester",
        file: {},
        fileDigest: DIGEST,
        current: {},
        operations,
      }),
    );
    // Preview with the file now owning the same channel name → shadowed visible.
    const preview = await previewConfigChangeset({
      store,
      namespace: NAMESPACE,
      file: { outputs: { channels: [{ name: "chat", kind: "feishu_bot", webhook_url_env: "FILE_URL" }] } },
      fileDigest: "d".repeat(64),
      operations: [],
    });
    expect(preview.valid).toBe(true);
    if (!preview.valid) return;
    expect(preview.shadowedEntities).toEqual([{ kind: "channel", id: "chat" }]);
  });

  it("invalid changeset returns a structured issue and no commit", async () => {
    const preview = await previewConfigChangeset({
      store,
      namespace: NAMESPACE,
      file: {},
      fileDigest: DIGEST,
      operations: [
        { op: "create", collection: "channels", record: { id: "rec-bad", name: "bad", enabled: true, value: { name: "bad", kind: "carrier_pigeon" } } },
      ],
    });
    expect(preview.valid).toBe(false);
    if (preview.valid) return;
    expect(preview.issue.code).toBe("unsupported_capability");
    await expect(store.readHead(NAMESPACE)).resolves.toBeNull();
  });
});

describe("previewConfigRoute (R13)", () => {
  it("v2 matched event explains rule, workspace, full layout, model and outputs", () => {
    const preview = previewConfigRoute(v2Config(), {
      triggerName: "github-main",
      targetKind: "pull_request",
      repoRef: "acme/svc-api",
      branch: "main",
    });
    expect(preview.status).toBe("matched");
    if (preview.status !== "matched") return;
    expect(preview.graphMode).toBe("v2");
    expect(preview.routeRuleId).toBe("r-pr");
    expect(preview.workspace).toBe("product-services");
    expect(preview.workspaceInstanceId).toBeTruthy();
    // Full final path, not a template fragment (spec §5.5).
    expect(preview.layout.instanceRoot).toMatch(/^\/data\/workspaces\/product-services\/.+/u);
    expect(preview.layout.instanceRoot).toContain(preview.workspaceInstanceId!);
    expect(preview.layout.sourceRoot).toContain(preview.layout.instanceRoot);
    expect(preview.analysis.modelChain).toBe("default");
    expect(preview.outputs.line_comments).toEqual(["gh-review"]);
  });

  it("v2 non-matching event reports no_match with rule count", () => {
    const preview = previewConfigRoute(v2Config(), {
      triggerName: "github-main",
      targetKind: "push",
      repoRef: "acme/svc-api",
    });
    expect(preview).toMatchObject({ status: "no_match", graphMode: "v2" });
  });

  it("ambiguous priority tie surfaces the same error execution sees", () => {
    const config = v2Config({
      routing: {
        rules: [
          { id: "a", enabled: true, priority: 100, workspace: "product-services", match: { triggers: ["github-main"] } },
          { id: "b", enabled: true, priority: 100, workspace: "other", match: { triggers: ["github-main"] } },
        ],
      },
      workspaces: {
        defaults: {},
        instances: { "product-services": {}, other: {} },
      },
    });
    expect(() =>
      previewConfigRoute(config, { triggerName: "github-main", targetKind: "pull_request", repoRef: "acme/svc" }),
    ).toThrowError(expect.objectContaining({ code: "ambiguous_route" }) as Error);
  });

  it("legacy output routing retains the isolated layout of a workspace match", () => {
    const config = parseEffectiveConfig(
      {
        llm: {
          providers: [{ id: "main", kind: "ollama" }],
          model_chain: { default: [{ provider: "main", model: "m", role: "any" }] },
        },
        triggers: [{ name: "github-main", kind: "github", token_env: "GH_TOKEN" }],
        workspaces: {
          root: "/data/workspaces",
          defaults: {},
          instances: {
            "product-services": { match: [{ source: { repo_ref: { glob: "acme/*" } } }] },
          },
        },
      },
      1,
    );
    const preview = previewConfigRoute(config, {
      triggerName: "github-main",
      targetKind: "pull_request",
      repoRef: "acme/svc-api",
    });
    expect(preview.status).toBe("matched");
    if (preview.status !== "matched") return;
    expect(preview.graphMode).toBe("legacy");
    expect(preview.layoutKind).toBe("isolated_v2");
    expect(preview.layout.instanceRoot).toContain(preview.workspaceInstanceId);
    expect(preview.layout.sourceRoot).toBe(`${preview.layout.instanceRoot}/source`);
  });

  it("event outside every workspace rule reports unbound/no_match", () => {
    const config = parseEffectiveConfig(
      {
        triggers: [{ name: "github-main", kind: "github", token_env: "GH_TOKEN" }],
        workspaces: {
          defaults: {},
          instances: { "product-services": { match: [{ source: { repo_ref: { exact: "acme/only" } } }] } },
        },
      },
      1,
    );
    expect(
      previewConfigRoute(config, { triggerName: "github-main", targetKind: "push", repoRef: "acme/other" }),
    ).toMatchObject({ status: "no_match" });
  });
});

describe("diagnoseConfigReadiness", () => {
  it("disabled without a store", async () => {
    expect(await diagnoseConfigReadiness({ namespace: NAMESPACE })).toMatchObject({ status: "disabled" });
  });

  it("empty namespace before the first publish", async () => {
    expect(await diagnoseConfigReadiness({ store, namespace: NAMESPACE })).toEqual({
      status: "empty",
      namespace: NAMESPACE,
    });
  });

  it("ready after publish with matching file digest", async () => {
    const result = await publishConfig(
      store,
      prepareConfigPublication({
        namespace: NAMESPACE,
        baseRevision: null,
        operationId: "op-1",
        actor: "tester",
        file: {},
        fileDigest: DIGEST,
        current: {},
        operations: [],
      }),
    );
    expect(result.status).toBe("committed");
    const status = await diagnoseConfigReadiness({ store, namespace: NAMESPACE, fileDigest: DIGEST });
    expect(status).toMatchObject({ status: "ready", headRevision: 1, fileDigest: DIGEST });
  });

  it("file_config_mismatch when the process file digest differs from head", async () => {
    await publishConfig(
      store,
      prepareConfigPublication({
        namespace: NAMESPACE,
        baseRevision: null,
        operationId: "op-1",
        actor: "tester",
        file: {},
        fileDigest: DIGEST,
        current: {},
        operations: [],
      }),
    );
    const status = await diagnoseConfigReadiness({ store, namespace: NAMESPACE, fileDigest: "e".repeat(64) });
    expect(status).toMatchObject({ status: "file_config_mismatch", headFileDigest: DIGEST });
  });

  it("snapshot_missing after the head snapshot is swept", async () => {
    const result = await publishConfig(
      store,
      prepareConfigPublication({
        namespace: NAMESPACE,
        baseRevision: null,
        operationId: "op-1",
        actor: "tester",
        file: {},
        fileDigest: DIGEST,
        current: {},
        operations: [],
      }),
    );
    if (result.status !== "committed") throw new Error("expected commit");
    await store.deleteSnapshot(result.snapshotId);
    const status = await diagnoseConfigReadiness({ store, namespace: NAMESPACE });
    expect(status).toMatchObject({ status: "snapshot_missing", headRevision: 1 });
  });
});
