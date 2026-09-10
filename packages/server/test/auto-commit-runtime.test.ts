import {
  createMemoryAutoCommitStore,
  type AutoCommitStore,
  type CommitMemberRecord,
} from "@aicr/core";
import { describe, expect, it, vi } from "vitest";

import {
  createAutoCommitBatchExecutor,
  reviewEventForBatch,
} from "../src/auto-commit-runtime.js";
import type { BatchExecutionContext } from "../src/auto-commit-scheduler.js";
import type {
  ReviewOrchestrationResult,
  ServerReviewOrchestrationOptions,
  runReviewOrchestration,
} from "../src/review-orchestrator.js";

async function fixture(): Promise<{
  store: AutoCommitStore;
  context: BatchExecutionContext;
}> {
  const store = createMemoryAutoCommitStore();
  const { receipt } = await store.acceptReceipt({
    deliveryKey: "delivery",
    workspaceId: "workspace",
    triggerName: "trigger",
    provider: "gitea",
    vcs: "git",
    sourceNamespace: "gitea:org/repo",
    scopeRef: "refs/heads/main",
    historyGeneration: 0,
    coverage: { kind: "range", base: "A0", head: "A1" },
    envelope: {
      repoRef: "org/repo",
      branch: "main",
      url: "https://git.test/org/repo/commit/A1",
    },
    delaySeconds: 0,
    policyVersion: "policy",
    now: 1000,
  });
  await store.applyMetadataPage({
    streamId: receipt.streamId,
    receiptId: receipt.receiptId,
    now: 1000,
    members: ["A1", "A2"].map((revision, index) => ({
      revision,
      orderKey: String(index),
      parents: [index === 0 ? "A0" : "A1"],
      sourceSnapshot: {
        v: 1,
        vcs: "git",
        sourceNamespace: receipt.sourceNamespace,
        revision,
        fields: {
          authorName: { status: "known", value: "Recorded Author" },
          authorEmail: { status: "known", value: "author@example.test" },
        },
        command: "git log",
        observedAt: 1000,
        rulesVersion: "policy",
        sourceKey: "source",
        status: "known",
      },
    })),
  });
  const members = (await store.readPendingMembers(receipt.streamId, null, 10))
    .items;
  await store.applyExclusionVerdicts({
    streamId: receipt.streamId,
    now: 1000,
    verdicts: members.map((member) => ({
      memberId: member.memberId,
      state: "allowed",
      policyVersion: "policy",
    })),
  });
  const reservation = await store.acquireStreamReservation(
    receipt.streamId,
    "consumer",
    10000,
    1000,
  );
  const head = await store.readStreamHead(receipt.streamId);
  expect(
    await store.sealBatch({
      streamId: receipt.streamId,
      reservationToken: reservation!.token,
      expectedStreamVersion: head!.version,
      batchId: "batch",
      runId: "stable-run",
      members: members.map((member) => ({
        memberId: member.memberId,
        revision: member.revision,
        sourceKey: "source",
      })),
      base: "A0",
      head: "A2",
      sourceKey: "source",
      exclusionPolicyVersion: "policy",
      configPolicyVersion: "policy",
      maxAttempts: 3,
      now: 1000,
    }),
  ).toEqual({ kind: "sealed" });
  const [claim] = await store.claimDispatch(1000, "consumer", 1);
  await store.confirmDispatch("batch", claim!.claimToken, 1000);
  const leaseToken = await store.startBatchExecution(
    "batch",
    "consumer",
    10000,
    1000,
  );
  const batch = await store.readBatch("batch");
  return {
    store,
    context: { batch: batch!, members, receipt, leaseToken: leaseToken! },
  };
}

function result(failed = false): ReviewOrchestrationResult {
  // Only the persisted public summary and dispatch acknowledgments are used
  // by this boundary; prompt discovery and sandbox internals belong upstream.
  return {
    status: "published",
    sourceRoot: "source",
    changedFiles: ["file.ts"],
    fetchedFiles: ["file.ts"],
    diffFileCount: 1,
    promptTokenEstimate: 100,
    problemCount: 0,
    summaryCount: 1,
    contextRequestCount: 0,
    dispatchCount: failed ? 2 : 1,
    model: { providerId: "test", modelId: "test" },
    preparedPrompt: {} as ReviewOrchestrationResult["preparedPrompt"],
    outputState: {
      problems: [],
      summaries: [{ markdown: "Reviewed" }],
      contextRequests: [],
    },
    dispatchResults: [
      { channel: "first", status: "published", externalId: "comment-1" },
      ...(failed ? [{ channel: "second", status: "failed" as const }] : []),
    ],
    llmResult: {
      providerId: "test",
      modelId: "test",
      content: "review",
      raw: {},
      usage: { totalTokens: 123 },
    },
    scrubMatches: [],
  };
}

describe("automatic batch execution boundary", () => {
  it("passes stable run identity, all members, range, and recorded author into one review", async () => {
    const { store, context } = await fixture();
    const runReview = vi
      .fn<typeof runReviewOrchestration>()
      .mockResolvedValue(result());
    const persistResult = vi.fn();
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      persistResult,
      now: () => 1001,
    });
    await execute(context);
    await execute(context);
    expect(runReview).toHaveBeenCalledTimes(1);
    const [runContext] = runReview.mock.calls[0]!;
    expect(runContext.runId).toBe("stable-run");
    expect(runContext.additionalTaskContext).toContain('"members":["A1","A2"]');
    expect(runContext.reviewEvent).toMatchObject({
      baseSha: "A0",
      headSha: "A2",
      title: "2 commits: A0..A2",
      author: { displayName: "Recorded Author", email: "author@example.test" },
    });
    expect(runContext.reviewEvent.url).toBeUndefined();
    expect(persistResult).toHaveBeenCalledWith(
      "stable-run",
      expect.objectContaining({
        reviewRun: expect.objectContaining({ llmUsage: { totalTokens: 123 } }),
      }),
    );
    expect((await store.readBatch("batch"))?.executionCheckpoint?.phase).toBe(
      "completed",
    );
  });

  it("retries local accounting from the completed checkpoint without repeating analysis or outputs", async () => {
    const { store, context } = await fixture();
    const runReview = vi
      .fn<typeof runReviewOrchestration>()
      .mockResolvedValue(result());
    const persistResult = vi
      .fn()
      .mockRejectedValueOnce(new Error("local database unavailable"))
      .mockResolvedValue(undefined);
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      persistResult,
      now: () => 1001,
    });
    await expect(execute(context)).rejects.toThrow(
      "local database unavailable",
    );
    await execute(context);
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(persistResult).toHaveBeenCalledTimes(2);
  });

  it("keeps partially failed publication pending and never repeats a successful POST", async () => {
    const { store, context } = await fixture();
    const runReview = vi
      .fn<typeof runReviewOrchestration>()
      .mockResolvedValue(result(true));
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      now: () => 1001,
    });
    await expect(execute(context)).rejects.toMatchObject({
      retryable: false,
      code: "execution_outcome_unknown",
    });
    expect((await store.readBatch("batch"))?.executionCheckpoint?.phase).toBe(
      "publication_pending",
    );
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    expect(runReview).toHaveBeenCalledTimes(1);
  });

  it("does not replay a started checkpoint left behind by an unconfirmed execution", async () => {
    const { store, context } = await fixture();
    const runReview = vi
      .fn<typeof runReviewOrchestration>()
      .mockRejectedValue(new Error("response lost"));
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      now: () => 1001,
    });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    await expect(execute(context)).rejects.toThrow("started checkpoint");
    expect(runReview).toHaveBeenCalledTimes(1);
  });

  it("never enters analysis when its execution checkpoint cannot acquire the lease", async () => {
    const { store, context } = await fixture();
    const runReview = vi.fn<typeof runReviewOrchestration>();
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      now: () => 1001,
    });
    await expect(
      execute({ ...context, leaseToken: "stale" }),
    ).rejects.toMatchObject({ retryable: false });
    expect(runReview).not.toHaveBeenCalled();
  });

  it("uses the authoritative P4 User and Client instead of receipt payload hints", async () => {
    const { context } = await fixture();
    const member: CommitMemberRecord = {
      ...context.members[0]!,
      sourceSnapshot: {
        ...context.members[0]!.sourceSnapshot!,
        vcs: "p4",
        fields: {
          user: { status: "known", value: "alice" },
          client: { status: "known", value: "task-client" },
        },
      },
    };
    const event = reviewEventForBatch({
      ...context,
      batch: { ...context.batch, vcs: "p4" },
      receipt: {
        ...context.receipt,
        provider: "p4",
        envelope: { repoRef: "//depot/main", submitterWorkspace: "ci-client" },
      },
      members: [member],
    });
    expect(event.author.username).toBe("alice");
    expect(event.submitterWorkspace).toBe("task-client");
  });
});
