import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appConfigSchema, createReviewEvent, type AppConfig, type ReviewEvent } from "@aicr/core";
import { closeStoreDb, createStoreDb, findImReviewRequest, claimDueImReviewRequests, updateImReviewRequest, type SqliteStoreDb } from "@aicr/store";
import type { VcsAdapter } from "@aicr/vcs";

import { admitImCommand, parseImCommand } from "../src/im/command-service.js";
import { classifyImReviewResult, ManualReviewService, readImReviewCheckpoint } from "../src/im/manual-review-service.js";
import { createReviewDeduplicator } from "../src/review-deduplicator.js";

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
      dispatchResults: [{ channel: "chat", status: "failed", raw: { status: 404 } }] })).toEqual({ state: "failed", errorCode: "im.publication_failed" });
    expect(classifyImReviewResult({ status: "published", dispatchResults: [
      { channel: "chat", status: "published" }, { channel: "issue", status: "failed", raw: { status: 404 } },
    ] })).toEqual({ state: "partial", errorCode: "im.publication_partial" });
  });

  it.each([undefined, { status: 408 }, { status: 503 }, { kind: "unknown", reason: "network" }])("keeps an unprovable failed dispatch unknown (%j)", raw => {
    expect(classifyImReviewResult({ status: "published", dispatchResults: [
      { channel: "chat", status: "published" }, { channel: "issue", status: "failed", raw },
    ] }).state).toBe("publication_unknown");
  });

  it("distinguishes WeCom business rejection and partially delivered recipients", () => {
    expect(classifyImReviewResult({ status: "skipped", dispatchResults: [
      { channel: "chat", status: "failed", raw: { kind: "rejected", errcode: 81013 } },
    ] }).state).toBe("failed");
    expect(classifyImReviewResult({ status: "published", dispatchResults: [
      { channel: "chat", status: "published", raw: { kind: "partial", invalidUsers: ["missing"] } },
    ] }).state).toBe("partial");
    expect(classifyImReviewResult({ status: "published", dispatchResults: [
      { channel: "chat", status: "failed", raw: { deliveredParts: 1, failure: { kind: "rejected", errcode: 81013 } } },
    ] }).state).toBe("partial");
    expect(classifyImReviewResult({ status: "published", dispatchResults: [
      { channel: "chat", status: "published", raw: { details: [{ part: 1, kind: "partial" }] } },
    ] }).state).toBe("partial");
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
  it.each(["scan", "wake"] as const)("shutdown aborts and drains %s execution without marking it terminal", async entry => {
    const requestId = await seedRequest();
    const started = Promise.withResolvers<void>();
    const service = new ManualReviewService({ store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(), dispatch: async handoff => handoff.execute(),
      executeReview: async ({ signal }) => {
        started.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { state: "succeeded" };
      } });
    const task = entry === "scan" ? service.scan() : service.wake({ requestId, configSnapshotId: "snap" });
    await started.promise;
    await service.stop();
    await task;
    expect((await findImReviewRequest(store, "ns-w", requestId))?.state).toBe("running");
    expect(await service.scan()).toBe(0);
    expect(await service.wake({ requestId, configSnapshotId: "snap" })).toBe("not_due");
  });
  it("expires queued requests with a notification while preserving live requests", async () => {
    const requestId = await seedRequest();
    const request = (await findImReviewRequest(store, "ns-w", requestId))!;
    const now = new Date(request.createdAt.getTime() + 73 * 3600000);
    const executeReview = vi.fn(async () => ({ state: "succeeded" as const }));
    const service = new ManualReviewService({ store, namespace: "ns-w", getConfig: config, now: () => now,
      createAdapter: () => mockAdapter(), dispatch: async handoff => handoff.execute(), executeReview });
    expect(await service.scan()).toBe(0);
    expect(executeReview).not.toHaveBeenCalled();
    expect(await findImReviewRequest(store, "ns-w", requestId)).toMatchObject({ state: "rejected", errorCode: "im.queued_timeout" });
    const claimRequestId = await seedRequest("a".repeat(40));
    const claim = (await claimDueImReviewRequests(store, { namespace: "ns-w", now: new Date(), leaseMs: 1000000, owner: "w", limit: 1 }))[0]!;
    await updateImReviewRequest(store, { requestId: claimRequestId, fence: claim.fence, state: "running", now: new Date() });
    expect(await service.expireQueued()).toBe(0);
    expect((await findImReviewRequest(store, "ns-w", claimRequestId))?.state).toBe("running");
    expect(store.sqlite.prepare("SELECT COUNT(*) AS count FROM im_reply_outbox WHERE request_id = ?").get(requestId)).toMatchObject({ count: 1 });
  });

  it("operator cancellation wins over an executor that finishes after abort", async () => {
    const requestId = await seedRequest();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const service = new ManualReviewService({ store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(), dispatch: async handoff => handoff.execute(),
      executeReview: async () => { started.resolve(); await finish.promise; return { state: "succeeded" }; } });
    const scan = service.scan();
    await started.promise;
    const { createReviewCancellationService } = await import("../src/review-cancellation.js");
    const coordinator = createReviewCancellationService({ store, imNamespace: "ns-w", cancelRunningImRequest: id => service.cancelRunning(id) });
    expect((await coordinator.cancelImRequest(requestId)).status).toBe("cancelled");
    finish.resolve();
    await scan;
    expect(await findImReviewRequest(store, "ns-w", requestId)).toMatchObject({ state: "rejected", errorCode: "im.cancelled_by_user" });
    expect(await service.scan()).toBe(0);
  });
  it("processes a request through the full state machine to succeeded", async () => {
    const requestId = await seedRequest();
    const executed: unknown[] = [];
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      dispatch: async handoff => { expect(handoff.jobId).toBe(`im-review-${requestId}-1`); await handoff.execute(); },
      executeReview: async input => {
        executed.push(input.event);
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
      dispatch: async () => { throw new Error("must not dispatch"); },
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
      dispatch: async handoff => { await handoff.execute(); },
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
      dispatch: async handoff => { await handoff.execute(); },
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
      dispatch: async handoff => { await handoff.execute(); },
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
      dispatch: async handoff => { await handoff.execute(); },
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
      dispatch: async handoff => handoff.execute(),
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

  it("re-attempts an interrupted analysis with persisted backoff, then fails after the attempt budget (R14)", async () => {
    const requestId = await seedRequest();
    const claim = (await claimDueImReviewRequests(store, {
      namespace: "ns-w", now: new Date(), leaseMs: 1, owner: "lost", limit: 1,
    }))[0]!;
    await updateImReviewRequest(store, { requestId, fence: claim.fence, state: "running", releaseLease: true, now: new Date() });
    const executeReview = vi.fn();
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      dispatch: async () => { throw new Error("must not dispatch"); },
      executeReview,
    });
    // Each crashed analysis attempt lands in retry_wait with the attempt
    // count persisted and a due time in the future — never re-executed
    // immediately and never resurrected as a fresh analysis (R14/R12).
    await service.scan();
    expect(executeReview).not.toHaveBeenCalled();
    const request = await findImReviewRequest(store, "ns-w", requestId);
    expect(request?.state).toBe("retry_wait");
    expect(request?.resumePhase).toBe("analysis_retry");
    expect(JSON.parse(request!.attemptsByPhaseJson)).toEqual({ analysis: 1 });
    expect(request?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());

    // Later scans before the due time leave the request untouched.
    await service.scan();
    expect((await findImReviewRequest(store, "ns-w", requestId))?.state).toBe("retry_wait");

    // Crash each re-attempt when it becomes due; the attempt budget (default
    // 3 re-attempts) is exhausted and the request terminates as failed.
    let due = new Date(request!.nextAttemptAt!.getTime() + 1000);
    for (let round = 0; round < 3; round += 1) {
      const reclaimer = (await claimDueImReviewRequests(store, { namespace: "ns-w", now: due, leaseMs: 1, owner: `lost-${round}`, limit: 10 }))
        .find(entry => entry.request.requestId === requestId)!;
      await updateImReviewRequest(store, { requestId, fence: reclaimer.fence, state: "running", releaseLease: true, now: due });
      const next = new ManualReviewService({
        store, namespace: "ns-w", getConfig: config, now: () => due,
        createAdapter: () => mockAdapter(),
        dispatch: async () => { throw new Error("must not dispatch"); },
        executeReview,
      });
      await next.scan();
      const after = await findImReviewRequest(store, "ns-w", requestId);
      if (round < 2) {
        expect(after?.state).toBe("retry_wait");
        expect(JSON.parse(after!.attemptsByPhaseJson)).toEqual({ analysis: round + 2 });
        due = new Date(after!.nextAttemptAt!.getTime() + 1000);
      } else {
        expect(after?.state).toBe("failed");
        expect(after?.errorCode).toBe("im.analysis_attempts_exhausted");
      }
    }
    expect(executeReview).not.toHaveBeenCalled();
  });

  it("keeps the commit author separate from the chat operator (V05)", async () => {
    await seedRequest();
    const events: ReviewEvent[] = [];
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter({ author_name: "Alice Dev", author_email: "alice@example.com", title: "trusted commit" }),
      dispatch: async handoff => { await handoff.execute(); },
      executeReview: async ({ event }) => {
        events.push(event);
        return { state: "succeeded" };
      },
    });
    await service.scan();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.requestOrigin).toMatchObject({ kind: "im_command", requestedBy: { type: "wecom_userid", id: ACTOR.id } });
    expect(event.author).toEqual({ username: "Alice Dev", email: "alice@example.com" });
  });

  it("keeps the IM request out of the auto flow's admission key space (V07)", async () => {
    await seedRequest();
    const events: ReviewEvent[] = [];
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      dispatch: async handoff => { await handoff.execute(); },
      executeReview: async ({ event }) => {
        events.push(event);
        return { state: "succeeded" };
      },
    });
    await service.scan();
    const event = events[0]!;
    expect(event.provider).toBe("manual");
    expect(event.requestOrigin?.kind).toBe("im_command");

    // A concurrent auto push for the same commit keeps its own dedup slot:
    // the manual review neither blocks nor requeues the auto target, and the
    // auto cursor/batch state is never touched by the IM worker.
    const deduplicator = createReviewDeduplicator();
    const autoEvent = createReviewEvent({
      triggerName: "git-main", provider: "github", workspaceId: "ws", targetKind: "push",
      repoRef: "org/s", headSha: REPO_SHA, author: {}, reason: "github:push",
    });
    expect(deduplicator.trySchedule(autoEvent)).toBe(true);
    expect(deduplicator.isRunning(autoEvent)).toBe(true);
    expect(deduplicator.isRunning(event)).toBe(false);
    expect(deduplicator.trySchedule(event)).toBe(true); // manual re-review never consumed the auto slot
  });
});

describe("R10–R12: queue wake-up handoff", () => {
  it("hands each dispatch over with a stable job identity and the request's pinned snapshot (R10)", async () => {
    const requestId = await seedRequest();
    const handoffs: { jobId: string; dispatchSeq: number; workspaceId: string; triggerName: string; configSnapshotId: string; permitHeld: boolean }[] = [];
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      dispatch: async handoff => { handoffs.push(handoff); await handoff.execute(); },
      executeReview: async () => ({ state: "succeeded" }),
    });
    await service.scan();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      requestId, dispatchSeq: 1, workspaceId: "ws", triggerName: "git-main",
      configSnapshotId: "snap", permitHeld: false,
    });
    expect(handoffs[0]!.jobId).toBe(`im-review-${requestId}-1`);
  });

  it("ignores duplicate wake-ups while the executor holds the lease (R11)", async () => {
    const requestId = await seedRequest();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const executions = vi.fn();
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      dispatch: async handoff => handoff.execute(),
      executeReview: async () => { executions(); started.resolve(); await finish.promise; return { state: "succeeded" }; },
    });
    const scan = service.scan();
    await started.promise;
    // The duplicate wake-up arrives while the live executor renews the
    // lease: it claims nothing and never triggers a second execution.
    expect(await service.wake({ requestId, configSnapshotId: "snap" })).toBe("not_due");
    expect(executions).toHaveBeenCalledTimes(1);
    finish.resolve();
    await scan;
    expect((await findImReviewRequest(store, "ns-w", requestId))?.state).toBe("succeeded");
  });

  it("refuses wake-ups whose queue version disagrees with the request table (R10)", async () => {
    const requestId = await seedRequest();
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      dispatch: async () => { throw new Error("must not dispatch"); },
      executeReview: vi.fn(),
    });
    expect(await service.wake({ requestId, configSnapshotId: "snap-other" })).toBe("version_mismatch");
    expect(await service.wake({ requestId: "missing", configSnapshotId: "snap" })).toBe("terminal");
    // The refused wake-up left the request untouched for the due scan.
    expect((await findImReviewRequest(store, "ns-w", requestId))?.state).toBe("accepted");
  });

  it("wakes a crashed request through the queue path under the already-held permit (R12)", async () => {
    const requestId = await seedRequest();
    // Post-crash state: resolved target, queued, lease released.
    const claim = (await claimDueImReviewRequests(store, {
      namespace: "ns-w", now: new Date(), leaseMs: 1, owner: "lost", limit: 1,
    }))[0]!;
    await updateImReviewRequest(store, {
      requestId, fence: claim.fence, state: "queued", resolvedRevision: REPO_SHA,
      releaseLease: true, now: new Date(),
    });
    const handoffs: { jobId: string; dispatchSeq: number; permitHeld: boolean }[] = [];
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      dispatch: async handoff => { handoffs.push(handoff); await handoff.execute(); },
      executeReview: async () => ({ state: "succeeded" }),
    });
    expect(await service.wake({ requestId, configSnapshotId: "snap" })).toBe("executed");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ permitHeld: true, dispatchSeq: 1 });
    expect(handoffs[0]!.jobId).toBe(`im-review-${requestId}-1`);
    expect((await findImReviewRequest(store, "ns-w", requestId))?.state).toBe("succeeded");
  });
});

describe("R14/R15: publication checkpoint recovery", () => {
  const checkpoint = {
    phase: "publication_pending" as const,
    publication: {
      output: { problems: [], summaries: [{ markdown: "Reviewed" }] },
      receipts: [{ channel: "chat", status: "published" as const, attempts: 1, updatedAt: 1 }],
    },
  };

  it("retains the last durable publication checkpoint when a later journal exceeds the byte cap", async () => {
    const requestId = await seedRequest();
    const service = new ManualReviewService({ store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(), dispatch: async handoff => handoff.execute(),
      executeReview: async ({ hooks }) => {
        expect(await hooks.saveCheckpoint(checkpoint)).toBe(true);
        const durable = (await findImReviewRequest(store, "ns-w", requestId))!.checkpointJson;
        expect(await hooks.saveCheckpoint({ ...checkpoint, publication: { ...checkpoint.publication,
          output: { problems: [], summaries: [{ markdown: "x".repeat(1_048_576) }] } } })).toBe("oversized");
        expect((await findImReviewRequest(store, "ns-w", requestId))!.checkpointJson).toBe(durable);
        return { state: "publication_unknown" };
      } });
    await service.scan();
    expect((await findImReviewRequest(store, "ns-w", requestId))?.state).toBe("publication_unknown");
  });

  it.each([
    { ...checkpoint, phase: "started" },
    { ...checkpoint, publication: { ...checkpoint.publication, output: { problems: [{}], summaries: [] } } },
    { ...checkpoint, publication: { ...checkpoint.publication, receipts: [{ channel: "chat", status: "published" }] } },
    { ...checkpoint, publication: { ...checkpoint.publication, receipts: [...checkpoint.publication.receipts, ...checkpoint.publication.receipts] } },
    { ...checkpoint, publication: { ...checkpoint.publication, remote: { version: 2, operations: [] } } },
  ])("refuses malformed recovery state without authorizing publication", value => {
    expect(readImReviewCheckpoint({ resumePhase: "publication_pending", checkpointJson: JSON.stringify(value) })).toBeUndefined();
  });

  async function crashWhilePublishing(attemptsByPhase: string | undefined): Promise<string> {
    const requestId = await seedRequest();
    const claim = (await claimDueImReviewRequests(store, {
      namespace: "ns-w", now: new Date(), leaseMs: 1, owner: "lost", limit: 1,
    }))[0]!;
    await updateImReviewRequest(store, {
      requestId, fence: claim.fence, state: "publishing", resumePhase: "publication_pending",
      checkpointJson: JSON.stringify(checkpoint), releaseLease: true,
      ...(attemptsByPhase !== undefined ? { attemptsByPhaseJson: attemptsByPhase } : {}),
      now: new Date(),
    });
    return requestId;
  }

  it("resumes an interrupted publication from the durable checkpoint without a fresh analysis (R14)", async () => {
    const requestId = await crashWhilePublishing(undefined);
    const resumes: unknown[] = [];
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => { throw new Error("resume must not re-validate"); },
      dispatch: async handoff => handoff.execute(),
      executeReview: async ({ resume }) => {
        resumes.push(resume);
        return { state: "succeeded" };
      },
    });
    await service.scan();
    expect(resumes).toEqual([{
      output: checkpoint.publication.output,
      receipts: checkpoint.publication.receipts,
    }]);
    const final = await findImReviewRequest(store, "ns-w", requestId);
    expect(final?.state).toBe("succeeded");
    expect(JSON.parse(final!.attemptsByPhaseJson)).toEqual({ publication: 1 });
  });

  it("marks an unprovable interrupted publication unknown and stops resuming after the attempt budget (R15)", async () => {
    // No durable checkpoint: publication may have started, nothing is
    // provable — conservative unknown, never a blind resend.
    const requestId = await seedRequest();
    const claim = (await claimDueImReviewRequests(store, {
      namespace: "ns-w", now: new Date(), leaseMs: 1, owner: "lost", limit: 1,
    }))[0]!;
    await updateImReviewRequest(store, { requestId, fence: claim.fence, state: "publishing", releaseLease: true, now: new Date() });
    const service = new ManualReviewService({
      store, namespace: "ns-w", getConfig: config,
      createAdapter: () => mockAdapter(),
      dispatch: async () => { throw new Error("must not dispatch"); },
      executeReview: vi.fn(),
    });
    await service.scan();
    expect((await findImReviewRequest(store, "ns-w", requestId))).toMatchObject({ state: "publication_unknown", errorCode: "im.interrupted" });

    // Budget exhausted: a valid checkpoint still refuses another resume.
    const exhaustedId = await crashWhilePublishing(JSON.stringify({ publication: 3 }));
    await service.scan();
    expect(await findImReviewRequest(store, "ns-w", exhaustedId)).toMatchObject({ state: "publication_unknown", errorCode: "im.publication_attempts_exhausted" });
  });
});
