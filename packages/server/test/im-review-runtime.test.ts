import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appConfigSchema, type AppConfig } from "@aicr/core";
import { closeStoreDb, createStoreDb, findImReviewRequest, claimDueImReviewRequests, updateImReviewRequest, type SqliteStoreDb } from "@aicr/store";
import type { VcsAdapter } from "@aicr/vcs";

import { admitImCommand, parseImCommand } from "../src/im/command-service.js";
import { classifyImReviewResult, ManualReviewService } from "../src/im/manual-review-service.js";

/**
 * IM-14 worker acceptance R10–R16 share: claim→validate→dispatch→execute→
 * finish through the real SQLite store with mock adapter/executor. Lost
 * wake-ups, fence discipline and terminal-state guards are covered.
 */

const REPO_SHA = "0123456789abcdef0123456789abcdef01234567";
const ACTOR = { type: "wecom_userid" as const, id: "owent" };

describe("IM review publication outcome", () => {
  it("reports an all-failed publish as failed and a mixed publish as partial", () => {
    expect(classifyImReviewResult({ status: "skipped", skipReason: "output_dispatch_failed",
      dispatchResults: [{ channel: "chat", status: "failed" }] })).toEqual({ state: "failed", errorCode: "im.publication_failed" });
    expect(classifyImReviewResult({ status: "published", dispatchResults: [
      { channel: "chat", status: "published" }, { channel: "issue", status: "failed" },
    ] })).toEqual({ state: "partial", errorCode: "im.publication_partial" });
  });

  it("keeps buffered publication uncertain and distinguishes suppression from no publisher", () => {
    expect(classifyImReviewResult({ status: "published", dispatchResults: [
      { channel: "chat", status: "published" }, { channel: "issue", status: "buffered" },
    ] })).toEqual({ state: "publication_unknown", errorCode: "im.publication_buffered" });
    expect(classifyImReviewResult({ status: "skipped", skipReason: "no_output_publisher", dispatchResults: [] }))
      .toEqual({ state: "failed", errorCode: "im.review_not_published" });
    expect(classifyImReviewResult({ status: "skipped", skipReason: "no_problems_suppressed", dispatchResults: [] }))
      .toEqual({ state: "succeeded" });
  });
});

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-im-worker-"));
  store = createStoreDb(join(dir, "worker.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

function config(): AppConfig {
  return appConfigSchema.parse({
    im: {
      connections: { bot: { kind: "wecom_aibot", corp_id: "ww", aibot_id: "b1" } },
      command_bindings: {
        reviewers: {
          enabled: true, connection: "bot",
          conversations: [{ kind: "bot_direct" }],
          actors: [ACTOR],
          commands: ["review"],
          repositories: { svc: { workspace: "ws", source_trigger: "git-main", repo_ref: "org/s" } },
        },
      },
    },
    triggers: [{ name: "git-main", kind: "github" }],
    workspaces: { instances: { ws: {} } },
    outputs: { channels: [] },
  });
}

const mockAdapter = (metadata: Record<string, string | null> = { author_username: "dev", title: "T" }): VcsAdapter =>
  ({ kind: "github", describeSource: async () => metadata } as VcsAdapter);

async function seedRequest(revision: string = REPO_SHA): Promise<string> {
  const parse = parseImCommand(`aicr review svc ${revision}`);
  expect(parse.kind).toBe("command");
  if (parse.kind !== "command") throw new Error("parse failed");
  const outcome = await admitImCommand(store, {
    config: config(), namespace: "ns-w", connectionName: "bot", connectionIdentity: "cid",
    deliveryKey: `msg-${Math.random()}`, payloadDigest: `sha:${Math.random()}`,
    actor: ACTOR, conversation: { kind: "bot_direct" }, command: parse.command,
    now: new Date(), configSnapshotId: "snap", configFileDigest: "d".repeat(64),
  });
  expect(outcome.kind).toBe("accepted");
  if (outcome.kind !== "accepted") throw new Error("admit failed");
  return outcome.requestId;
}

describe("R10–R16: worker scan→validate→dispatch→execute→finish", () => {
  it("processes a request through the full state machine to succeeded", async () => {
    const requestId = await seedRequest();
    const executed: unknown[] = [];
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      enqueueReview: async (jobId, run) => { expect(jobId).toBe(`im-review-${requestId}-1`); await run(); },
      executeReview: async event => {
        executed.push(event);
        return { state: "succeeded" };
      },
    });
    const processed = await service.scan();
    expect(processed).toBe(1);
    expect(executed).toHaveLength(1);
    const event = executed[0] as { requestOrigin?: { kind: string; requestId: string } };
    expect(event.requestOrigin).toMatchObject({ kind: "im_command", requestId });

    const final = await findImReviewRequest(store, "ns-w", requestId);
    expect(final?.state).toBe("succeeded");
    const notification = store.sqlite.prepare("SELECT destination_identity, compact_receipt FROM im_reply_outbox WHERE request_id = ?")
      .get(requestId) as { destination_identity: string; compact_receipt: string };
    expect(notification.destination_identity).toBe("bot");
    expect(JSON.parse(notification.compact_receipt)).toMatchObject({ connectionName: "bot", requestId });
  });

  it("releases the active target when its configured adapter is unavailable", async () => {
    const requestId = await seedRequest();
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => undefined,
      enqueueReview: async () => { throw new Error("must not enqueue"); },
      executeReview: async () => { throw new Error("must not execute"); },
    });
    await service.scan();
    expect((await findImReviewRequest(store, "ns-w", requestId))?.state).toBe("rejected");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS total FROM im_active_targets").get()).toMatchObject({ total: 0 });
  });

  it("rejects a request whose revision does not exist in the repository", async () => {
    const requestId = await seedRequest();
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter({}), // empty metadata → not_found
      enqueueReview: async (_id, run) => { await run(); },
      executeReview: async () => { throw new Error("should not execute"); },
    });
    await service.scan();
    const final = await findImReviewRequest(store, "ns-w", requestId);
    expect(final?.state).toBe("rejected");
    expect(final?.errorCode).toContain("not_found");
    expect(store.sqlite.prepare("SELECT state FROM im_reply_outbox WHERE request_id = ?").get(requestId))
      .toMatchObject({ state: "pending" });
  });

  it("rejects an invalid revision format before any adapter call", async () => {
    const badRequestId = await seedRequest("zzz" + REPO_SHA.slice(3)); // not hex
    const adapterCalls = vi.fn();
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => { adapterCalls(); return mockAdapter(); },
      enqueueReview: async (_id, run) => { await run(); },
      executeReview: async () => { throw new Error("should not execute"); },
    });
    await service.scan();
    expect(adapterCalls).toHaveBeenCalled(); // adapter is created before resolution
    const final = await findImReviewRequest(store, "ns-w", badRequestId);
    expect(final?.state).toBe("rejected");
    expect(final?.errorCode).toBe("im.invalid_format");
  });

  it("allows a new command after a terminal request releases the active target (V06)", async () => {
    const requestId1 = await seedRequest();
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      enqueueReview: async (_id, run) => { await run(); },
      executeReview: async () => ({ state: "succeeded" }),
    });
    await service.scan();
    expect((await findImReviewRequest(store, "ns-w", requestId1))?.state).toBe("succeeded");

    // A new command for the same revision creates a NEW request.
    const requestId2 = await seedRequest();
    expect(requestId2).not.toBe(requestId1);
  });

  it("does not re-process a terminal request on a subsequent scan", async () => {
    await seedRequest();
    const executeCount = vi.fn(async () => ({ state: "succeeded" as const }));
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      enqueueReview: async (_id, run) => { await run(); },
      executeReview: executeCount,
    });
    await service.scan();
    expect(executeCount).toHaveBeenCalledTimes(1);
    await service.scan(); // second scan should find nothing due
    expect(executeCount).toHaveBeenCalledTimes(1);
  });

  it("uses the request's saved snapshot and renews its lease during execution", async () => {
    const requestId = await seedRequest();
    const snapshots: string[] = [];
    let startExecution: (() => void) | undefined;
    const started = new Promise<void>(resolve => { startExecution = resolve; });
    const service = new ManualReviewService({
      store, namespace: "ns-w", leaseMs: 90,
      getConfig: snapshotId => { snapshots.push(snapshotId); return config(); },
      createAdapter: () => mockAdapter(),
      enqueueReview: async (_id, run) => run(),
      executeReview: async () => {
        startExecution?.();
        await new Promise(resolve => setTimeout(resolve, 140));
        return { state: "succeeded" };
      },
    });
    const running = service.scan();
    await started;
    await new Promise(resolve => setTimeout(resolve, 110));
    expect(await service.scan()).toBe(0);
    expect(snapshots).toEqual(["snap"]);
    await running;
    expect((await findImReviewRequest(store, "ns-w", requestId))?.state).toBe("succeeded");
  });

  it("marks an interrupted running request unknown without publishing again", async () => {
    const requestId = await seedRequest();
    const claim = (await claimDueImReviewRequests(store, {
      namespace: "ns-w", now: new Date(), leaseMs: 1, owner: "lost", limit: 1,
    }))[0]!;
    await updateImReviewRequest(store, { requestId, fence: claim.fence, state: "running", releaseLease: true, now: new Date() });
    const executeReview = vi.fn();
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      enqueueReview: async () => { throw new Error("must not enqueue"); },
      executeReview,
    });
    await service.scan();
    expect(executeReview).not.toHaveBeenCalled();
    expect((await findImReviewRequest(store, "ns-w", requestId))?.state).toBe("publication_unknown");
  });
});
