import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeStreamId, type AutoCommitStore, type ImCommandBindingConfig } from "@aicr/core";
import { createMemoryAutoCommitStore } from "@aicr/core";
import { closeStoreDb, createStoreDb, insertReviewRun, type SqliteStoreDb } from "@aicr/store";

import { createImCancelCommandHandler, createReviewCancellationService } from "../src/review-cancellation.js";

/**
 * Coordinator-level cancellation: the store transitions (terminal skip, run
 * markers, IM request CAS) and the binding-scoped IM adapter.
 */

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-cancel-"));
  store = createStoreDb(join(dir, "cancel.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

describe("review cancellation coordinator", () => {
  it("cancels a repository-scoped push larger than the 512-member lookup bound", async () => {
    const batches = createMemoryAutoCommitStore();
    await seedBatch(batches, "large", "org/service", "abc", 0, 550);
    await seedBatch(batches, "other", "org/other", "def");
    const lookup = vi.spyOn(batches, "readMembers");
    const service = createReviewCancellationService({ autoCommitStore: batches, imNamespace: "ns" });
    const summary = await service.cancelByFilter({ allowAll: false,
      targets: [{ workspaceId: "ws", sourceTrigger: "git", repoRef: "org/service" }] });
    expect(summary.batches).toBe(1);
    expect((await batches.readBatch("large"))?.status).toBe("skipped");
    expect((await batches.readBatch("other"))?.status).toBe("dispatch_pending");
    expect(lookup.mock.calls.every(([ids]) => ids.length === 1)).toBe(true);
  });
  it("rejects an invalid cutoff without cancelling any batch", async () => {
    const batches = createMemoryAutoCommitStore();
    await seedBatch(batches, "keep", "org/repo", "abc");
    const service = createReviewCancellationService({ autoCommitStore: batches, imNamespace: "ns" });
    await expect(service.cancelByFilter({ allowAll: true, targets: [], before: new Date(NaN) })).rejects.toThrow("cutoff");
    expect((await batches.readBatch("keep"))?.status).toBe("dispatch_pending");
  });
  it("applies repository, revision and time filters to execution-window deferrals", async () => {
    const { createReviewEvent } = await import("@aicr/core");
    const event = createReviewEvent({ workspaceId: "ws", triggerName: "git", provider: "gitea",
      repoRef: "org/repo", targetKind: "pull_request", headSha: "abcdef12", author: {}, reason: "webhook" });
    const cancelDeferred = vi.fn(async (matches: (candidate: typeof event, at: Date) => boolean) => {
      expect(matches(event, new Date(0))).toBe(true);
      expect(matches({ ...event, repoRef: "org/other" }, new Date(0))).toBe(false);
      expect(matches(event, new Date(100))).toBe(false);
      return 1;
    });
    const service = createReviewCancellationService({ imNamespace: "ns", cancelDeferred });
    expect((await service.cancelByFilter({ allowAll: false, targets: [{ workspaceId: "ws", sourceTrigger: "git", repoRef: "org/repo" }],
      revision: "abcdef", before: new Date(10) })).deferrals).toBe(1);
  });
  it("keeps an explicit alias scoped even when the binding allows all repositories", async () => {
    const cancelByFilter = vi.fn(async () => ({ batches: 0, imRequests: 0, runRows: 0, deferrals: 0, lines: [] }));
    const handler = createImCancelCommandHandler({ ...createReviewCancellationService({ imNamespace: "ns" }), cancelByFilter });
    const binding = { allow_all_repositories: true, repositories: {
      service: { workspace: "ws", source_trigger: "git", repo_ref: "org/service" },
      other: { workspace: "other", source_trigger: "git", repo_ref: "org/other" },
    } } as ImCommandBindingConfig;
    await handler.cancel({ binding, command: { kind: "cancel", repoAlias: "service", revision: "aabbccdd", beforeMs: undefined } });
    expect(cancelByFilter).toHaveBeenCalledWith({ allowAll: false, revision: "aabbccdd",
      targets: [{ workspaceId: "ws", sourceTrigger: "git", repoRef: "org/service" }] });
    await handler.cancel({ binding, command: { kind: "cancel", repoAlias: undefined, revision: undefined, beforeMs: 3600000 } });
    expect(cancelByFilter.mock.calls[1]?.[0]).toMatchObject({ allowAll: true });
  });

  it("uses exact repository identity and exact numeric revisions", async () => {
    const batches = createMemoryAutoCommitStore();
    await seedBatch(batches, "own", "org/service", "123");
    await seedBatch(batches, "prefix", "org/service-other", "123");
    await seedBatch(batches, "revision-prefix", "org/service", "1234");
    const service = createReviewCancellationService({ autoCommitStore: batches, imNamespace: "ns" });
    const summary = await service.cancelByFilter({ allowAll: false, revision: "123",
      targets: [{ workspaceId: "ws", sourceTrigger: "git", repoRef: "org/service" }] });
    expect(summary.batches).toBe(1);
    expect((await batches.readBatch("own"))?.status).toBe("skipped");
    expect((await batches.readBatch("prefix"))?.status).toBe("dispatch_pending");
    expect((await batches.readBatch("revision-prefix"))?.status).toBe("dispatch_pending");
  });

  it("cancels old tasks beyond the first batch page and all active marker pages", async () => {
    const batches = createMemoryAutoCommitStore();
    for (let index = 0; index < 513; index++) await seedBatch(batches, `batch-${index}`, "org/service", "abc", index);
    const service = createReviewCancellationService({ store, autoCommitStore: batches, imNamespace: "ns" });
    const scoped = await service.cancelByFilter({ targets: [], allowAll: true, before: new Date(1) });
    expect(scoped.batches).toBe(1);
    expect((await batches.readBatch("batch-0"))?.status).toBe("skipped");
    for (let index = 0; index < 205; index++) await insertReviewRun(store, {
      id: `marker-${index}`, eventId: `marker-${index}`, workspaceId: "ws", triggerName: "git", repoRef: "org/service",
      provider: null, providerModel: null, status: "analyzing", startedAt: new Date(index),
    });
    const all = await service.cancelByFilter({ targets: [], allowAll: true });
    expect(all.runRows).toBe(205);
    expect(all.batches).toBe(512);
  });

  it("persists cancellation before aborting the live executor", async () => {
    const batches = createMemoryAutoCommitStore();
    await seedBatch(batches, "running", "org/service", "abc");
    const claim = (await batches.claimDispatch(0, "d", 1))[0]!;
    await batches.confirmDispatch("running", claim.claimToken, 0);
    await batches.startBatchExecution("running", "w", 10000, 0);
    let atAbort: string | undefined;
    const service = createReviewCancellationService({ autoCommitStore: batches, imNamespace: "ns",
      cancelRunningBatch: () => { void batches.readBatch("running").then(row => { atAbort = row?.status; }); return true; },
    });
    expect((await service.cancelBatch("running")).status).toBe("cancelled");
    expect(atAbort).toBe("skipped");
    expect(await batches.reclaimBatchesByOwner("w", 20000)).toEqual([]);
  });
  it("cancels queued batches, run markers, and IM requests within the authorized targets", async () => {
    const autoCommit = createMemoryAutoCommitStore();
    // Drive one batch to dispatch_pending via the memory store contract.
    const accepted = await autoCommit.acceptReceipt({
      deliveryKey: "d1", workspaceId: "ws-main", triggerName: "github-main", provider: "github",
      vcs: "git", sourceNamespace: "git:github.com/org/service", scopeRef: "refs/heads/main",
      historyGeneration: 0, coverage: { kind: "range", base: "A0", head: "A1" },
      envelope: { repoRef: "org/service" }, delaySeconds: 0, policyVersion: "pol-1", now: 1,
    });
    const streamId = computeStreamId(accepted.receipt);
    await autoCommit.applyMetadataPage({
      streamId,
      receiptId: accepted.receipt.receiptId,
      members: [{ revision: "A1", orderKey: "000000000001", parents: [], sourceSnapshot: null }],
      now: 1,
    });
    const member = (await autoCommit.readPendingMembers(streamId, null, 10)).items[0]!;
    await autoCommit.applyExclusionVerdicts({
      streamId, verdicts: [{ memberId: member.memberId, state: "allowed", policyVersion: "pol-1" }], now: 1,
    });
    const reservation = await autoCommit.acquireStreamReservation(streamId, "s", 60_000, 1);
    await autoCommit.sealBatch({
      streamId, reservationToken: reservation!.token, expectedStreamVersion: reservation!.version,
      batchId: "batch-1", runId: "run-batch-1",
      members: [{ memberId: member.memberId, revision: "A1", sourceKey: "sk" }],
      base: "A0", head: "A1", sourceKey: "sk", exclusionPolicyVersion: "rules-v1",
      configPolicyVersion: "pol-1", maxAttempts: 2, now: 1,
    });
    // An in-flight marker row for the batch's run.
    await insertReviewRun(store, {
      id: "run-batch-1", eventId: "run-batch-1", workspaceId: "ws-main", triggerName: "github-main",
      repoRef: "org/service", provider: "openai", providerModel: "gpt-test",
      status: "analyzing", startedAt: new Date(), headSha: "A1",
    });
    // A zombie marker for a run the auto-commit store never knew.
    await insertReviewRun(store, {
      id: "run-zombie", eventId: "run-zombie", workspaceId: "ws-other", triggerName: "other-trigger",
      repoRef: "org/other", provider: null, providerModel: null,
      status: "analyzing", startedAt: new Date(), headSha: "B1",
    });

    const service = createReviewCancellationService({
      store,
      autoCommitStore: autoCommit,
      imNamespace: "ns",
    });
    // Targeted at ws-main/org/service only: the zombie in ws-other survives.
    const summary = await service.cancelByFilter({
      targets: [{ workspaceId: "ws-main", sourceTrigger: "github-main", repoRef: "org/service" }],
      allowAll: false,
    });
    expect(summary.batches).toBe(1);
    // The batch's run marker was cancelled alongside the batch itself.
    expect((await autoCommit.readBatch("batch-1"))?.status).toBe("skipped");
    const { getReviewRunById } = await import("@aicr/store");
    expect((await getReviewRunById(store, "run-batch-1"))?.status).toBe("cancelled");
    expect((await getReviewRunById(store, "run-zombie"))?.status).toBe("analyzing");
    // The out-of-target zombie stays; a targeted follow-up pass cancels it.
    const zombiePass = await service.cancelByFilter({
      targets: [{ workspaceId: "ws-other", sourceTrigger: "other-trigger", repoRef: "org/other" }],
      allowAll: false,
    });
    expect(zombiePass.runRows).toBe(1);
    expect((await getReviewRunById(store, "run-zombie"))?.status).toBe("cancelled");
    // Idempotent: a second pass finds nothing.
    const second = await service.cancelByFilter({
      targets: [{ workspaceId: "ws-main", sourceTrigger: "github-main", repoRef: "org/service" }],
      allowAll: false,
    });
    expect(second.batches + second.runRows).toBe(0);
  });

  it("scopes the IM cancel adapter to the binding's repositories", async () => {
    const service = createReviewCancellationService({ store, imNamespace: "ns" });
    const handler = createImCancelCommandHandler(service);
    const binding = {
      enabled: true,
      connection: "wecom-airobot",
      conversations: [],
      actors: [],
      commands: ["cancel"],
      repositories: {
        service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" },
      },
      allow_all_repositories: false,
    } as never;
    // Nothing matches, but the filter shape proves the alias restriction.
    const reply = await handler.cancel({
      command: { kind: "cancel", repoAlias: "service", revision: "A1", beforeMs: undefined },
      binding,
    });
    expect(reply).toContain("没有匹配");
    // An unauthorized alias is rejected before any cancellation runs.
    const rejected = await handler.cancel({
      command: { kind: "cancel", repoAlias: "ghost", revision: "A1", beforeMs: undefined },
      binding,
    });
    expect(rejected).toContain("未在当前绑定中授权");
  });
});

async function seedBatch(store: AutoCommitStore, batchId: string, repoRef: string, head: string, now = 0, count = 1): Promise<void> {
  const { receipt } = await store.acceptReceipt({ deliveryKey: batchId, workspaceId: "ws", triggerName: "git", provider: "github",
    vcs: "git", sourceNamespace: `github:${repoRef}`, scopeRef: `refs/heads/${batchId}`, historyGeneration: 0,
    coverage: { kind: "range", base: "base", head }, envelope: { repoRef }, delaySeconds: 0, policyVersion: "p", now });
  const streamId = computeStreamId(receipt);
  const metadata = Array.from({ length: count }, (_, index) => ({ revision: index === count - 1 ? head : `revision-${index}`,
    orderKey: String(index + 1).padStart(12, "0"), parents: [], sourceSnapshot: null }));
  for (let offset = 0; offset < count; offset += 256) {
    await store.applyMetadataPage({ streamId, receiptId: receipt.receiptId, members: metadata.slice(offset, offset + 256), now });
  }
  const members = (await store.readPendingMembers(streamId, null, count)).items;
  const reservation = await store.acquireStreamReservation(streamId, "s", 10000, now);
  await store.sealBatch({ streamId, reservationToken: reservation!.token, expectedStreamVersion: reservation!.version,
    batchId, runId: `run-${batchId}`, members: members.map(member => ({ memberId: member.memberId, revision: member.revision, sourceKey: "s" })),
    base: "base", head, sourceKey: "s", exclusionPolicyVersion: "p", configPolicyVersion: "p", maxAttempts: 2, now });
}
