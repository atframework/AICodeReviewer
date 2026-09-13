import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAutoCommitStore, createMemoryConfigStore, parseConfigDocumentText,
  prepareConfigPublication, publishConfig, type ConfigChangesetOperation } from "@aicr/core";
import { RuntimeConfigManager } from "../src/runtime-config.js";
import { resolveGenericWebhookConfigs } from "../src/bootstrap.js";
import { createServerApp } from "../src/index.js";
import { AutoCommitRuntime } from "../src/auto-commit-runtime.js";
import { createReviewDeduplicator } from "../src/review-deduplicator.js";
import type * as ReviewOrchestrator from "../src/review-orchestrator.js";

const reviewMock = vi.hoisted(() => vi.fn());
vi.mock("../src/review-orchestrator.js", async importOriginal => ({
  ...await importOriginal<typeof ReviewOrchestrator>(),
  runReviewOrchestration: reviewMock,
}));

afterEach(() => vi.unstubAllEnvs());

async function harness() {
  vi.stubEnv("HOOK_OLD", "old-secret");
  vi.stubEnv("HOOK_NEW", "new-secret");
  const file = parseConfigDocumentText("llm:\n  providers: [{ id: local, kind: ollama }]\n  model_chain: { default: [{ provider: local, model: m, role: any }] }\nconfig_sources:\n  secret_refs:\n" +
    ["HOOK_OLD", "HOOK_NEW"].map(env => `    - { env: ${env}, target: [triggers, hook, webhook_secret_env], destinations: {kind: github} }\n`).join(""));
  const store = createMemoryConfigStore();
  const manager = new RuntimeConfigManager({ fileConfig: file.config, fileDocument: file.document,
    fileDigest: file.digest, namespace: "http-test", store, baseDir: process.cwd() });
  const receipts = createMemoryAutoCommitStore();
  const autoCommit = new AutoCommitRuntime({ store: receipts, getPolicyLayers: () => ({ global: manager.current().config.review.auto_commit }) });
  let operation = 0;
  async function publish(operations: readonly ConfigChangesetOperation[]) {
    const head = await store.readHead("http-test");
    const revision = head ? await store.readRevision("http-test", head.activeRevision) : null;
    const prepared = prepareConfigPublication({ namespace: "http-test", file: file.document, fileDigest: file.digest,
      operationId: `http-operation-${++operation}`, actor: "test", baseRevision: head?.activeRevision ?? null,
      current: revision?.document ?? {}, formatVersion: 2, operations });
    const result = await publishConfig(store, prepared, {});
    if (result.status !== "committed") throw new Error(result.status);
    return result.snapshotId;
  }
  const profiles = () => {
    const generation = manager.current();
    return resolveGenericWebhookConfigs(generation.config, "github", undefined, undefined, generation.workspaceRuntime);
  };
  await publish([
    { op: "create", collection: "triggers", record: { id: "hook-record", name: "hook", enabled: true,
      value: { name: "hook", kind: "github", webhook_secret_env: "HOOK_OLD" } } },
    { op: "create", collection: "workspaces", record: { id: "ws-record", name: "ws", enabled: true,
      value: { source_repo: { trigger: "hook", repo: "acme/repo" } } } },
  ]);
  const rotate = () => publish([{ op: "update", collection: "triggers", recordId: "hook-record",
    value: { name: "hook", kind: "github", webhook_secret_env: "HOOK_NEW" } }]);
  return { manager, store, receipts, autoCommit, profiles, publish, rotate };
}

function post(app: ReturnType<typeof createServerApp>, secret: string, delivery: string) {
  const body = JSON.stringify({ ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40),
    repository: { full_name: "acme/repo", default_branch: "main" },
    commits: [{ id: "b".repeat(40), added: ["src/a.ts"], modified: [], removed: [] }] });
  return app.request("/webhooks/github", { method: "POST", body, headers: {
    "x-github-event": "push", "x-github-delivery": delivery,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  } });
}

describe("runtime HTTP admission", () => {
  it("routes an authenticated push before accepting it and rejects a later no-route generation", async () => {
    const h = await harness();
    await h.publish([
      { op: "create", collection: "routes", record: { id: "route-record", name: "push-route", enabled: true,
        value: { id: "push-route", enabled: true, priority: 10, workspace: "ws", match: { triggers: ["hook"], target_kinds: ["push"] }, outputs: { summary: [] } } } },
    ]);
    const app = createServerApp({ runtimeConfig: h.manager, github: h.profiles, autoCommit: h.autoCommit });
    try {
      const accepted = await post(app, "old-secret", "routed-push");
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toMatchObject({ reviewEvent: { workspaceId: "ws" } });
      await h.publish([{ op: "set-enabled", collection: "routes", recordId: "route-record", enabled: false }]);
      const denied = await post(app, "old-secret", "no-route-push");
      expect(await denied.json()).toMatchObject({ accepted: false, reason: "no_route" });
    } finally { h.manager.close(); }
  });
  it("replays a deduplicated PR using that request's snapshot after the first run settles", async () => {
    const h = await harness();
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    reviewMock.mockReset().mockImplementationOnce(async () => {
      await blocked;
      throw new Error("deterministic first-run failure");
    }).mockRejectedValue(new Error("deterministic second-run failure"));
    const app = createServerApp({ runtimeConfig: h.manager, github: h.profiles, asyncTriggers: true,
      deduplicator: createReviewDeduplicator(), triggerRetry: { attempts: 1 }, reviewOrchestration: {} as never });
    const requestPr = (secret: string, head: string) => {
      const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/repo" },
        pull_request: { number: 1, html_url: "https://github.com/acme/repo/pull/1",
          base: { sha: "a".repeat(40), ref: "main" }, head: { sha: head.repeat(40), ref: "feature" } } });
      return app.request("/webhooks/github", { method: "POST", body, headers: { "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` } });
    };
    try {
      expect((await requestPr("old-secret", "b")).status).toBe(202);
      await vi.waitFor(() => expect(reviewMock).toHaveBeenCalledTimes(1));
      const latest = await h.rotate();
      const pending = await requestPr("new-secret", "c");
      expect(await pending.json()).toMatchObject({ processing: { status: "deduplicated" } });
      unblock();
      await vi.waitFor(() => expect(reviewMock).toHaveBeenCalledTimes(2));
      expect(reviewMock.mock.calls[0]![0].configSnapshotId).not.toBe(latest);
      expect(reviewMock.mock.calls[1]![0].configSnapshotId).toBe(latest);
    } finally {
      unblock();
      await vi.waitFor(() => expect(h.manager.status().activeLeases).toBe(0));
      h.manager.close();
    }
  });
  it("adopts published credentials before authenticating, without an explicit refresh", async () => {
    const h = await harness();
    const app = createServerApp({ runtimeConfig: h.manager, github: h.profiles, autoCommit: h.autoCommit });
    expect((await post(app, "old-secret", "one")).status).toBe(202);
    const snapshot = await h.rotate();
    expect((await post(app, "old-secret", "two")).status).toBe(401);
    const response = await post(app, "new-secret", "three");
    expect(response.status).toBe(202);
    const body = await response.json() as { processing: { receiptId: string } };
    expect((await h.receipts.getReceipt(body.processing.receiptId))?.receipt.configSnapshotId).toBe(snapshot);
    h.manager.close();
  });

  it("pins overlapping requests across an awaited profile lookup and publication", async () => {
    const h = await harness();
    const original = await h.manager.admission();
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    const app = createServerApp({ runtimeConfig: h.manager, autoCommit: h.autoCommit, github: async () => {
      const result = h.profiles();
      if (first) { first = false; entered(); await blocked; }
      return result;
    } });
    const firstRequest = post(app, "old-secret", "old");
    await started;
    const latest = await h.rotate();
    const second = await post(app, "new-secret", "new");
    unblock();
    const firstResponse = await firstRequest;
    expect([firstResponse.status, second.status]).toEqual([202, 202]);
    const firstBody = await firstResponse.json() as { processing: { receiptId: string } };
    const secondBody = await second.json() as { processing: { receiptId: string } };
    expect((await h.receipts.getReceipt(firstBody.processing.receiptId))?.receipt.configSnapshotId).toBe(original.snapshotId);
    expect((await h.receipts.getReceipt(secondBody.processing.receiptId))?.receipt.configSnapshotId).toBe(latest);
    expect(h.manager.status().activeLeases).toBe(0);
    h.manager.close();
  });

  it("returns 503 before profile selection on store failure and never exposes driver secrets", async () => {
    const h = await harness();
    const profiles = vi.fn(h.profiles);
    const app = createServerApp({ runtimeConfig: h.manager, github: profiles });
    vi.spyOn(h.store, "readHead").mockRejectedValue(new Error("postgres://admin:private-password@db/internal"));
    const response = await post(app, "old-secret", "failed");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-password");
    expect(profiles).not.toHaveBeenCalled();
    expect((await app.request("/readyz")).status).toBe(503);
  });
});
