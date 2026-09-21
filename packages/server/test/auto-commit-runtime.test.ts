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

  it("keeps partially failed publication pending and replays only through the recovery policy", async () => {
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
    // 2026-09 operator policy: a retry re-executes even when the previous
    // outcome is unprovable — the store's single automatic recovery bounds
    // the replay instead of dead-lettering the stream.
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    expect(runReview).toHaveBeenCalledTimes(2);
  });

  it("replays a started checkpoint left behind by an unconfirmed execution (operator policy)", async () => {
    const { store, context } = await fixture();
    const runReview = vi
      .fn<typeof runReviewOrchestration>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(result(true));
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      now: () => 1001,
    });
    await expect(execute(context)).rejects.toThrow("response lost");
    // The `started` checkpoint no longer dead-letters the batch; the retry
    // re-runs the analysis under the live lease (duplicate publication risk
    // accepted by the 2026-09 operator decision).
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    expect(runReview).toHaveBeenCalledTimes(2);
    expect((await store.readBatch("batch"))?.executionCheckpoint?.phase).toBe(
      "publication_pending",
    );
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

  it("persists the publication payload and per-channel receipts, then completes without them", async () => {
    const { store, context } = await fixture();
    const runReview = vi.fn<typeof runReviewOrchestration>()
      .mockImplementation(async (runContext, runOptions) => {
        await runOptions.onAnalysisComplete?.({
          problems: [],
          summaries: [{ markdown: "Reviewed" }],
          contextRequests: [],
        });
        await runContext.publicationRecovery?.onChannelResult?.(
          { channel: "gitea-pr", status: "published", externalId: "comment-1" },
          "summary",
        );
        // Mid-flight the checkpoint must already carry the payload + receipt.
        const midFlight = (await store.readBatch("batch"))?.executionCheckpoint;
        expect(midFlight?.phase).toBe("publication_pending");
        expect(midFlight?.publication?.receipts).toEqual([
          expect.objectContaining({ channel: "gitea-pr", status: "published", externalId: "comment-1", attempts: 1 }),
        ]);
        return result();
      });
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      now: () => 1001,
    });
    await execute(context);
    const checkpoint = (await store.readBatch("batch"))?.executionCheckpoint;
    expect(checkpoint?.phase).toBe("completed");
    expect(checkpoint?.publication).toBeUndefined();
  });

  it("resumes a publication_pending batch without re-running analysis and skips confirmed channels", async () => {
    const { store, context } = await fixture();
    const analysisOutput = {
      problems: [{ file: "file.ts", line: 1, severity: "high", category: "correctness", message: "boom" }],
      summaries: [{ markdown: "Reviewed" }],
      contextRequests: [],
    };
    const runReview = vi.fn<typeof runReviewOrchestration>()
      // First attempt: channel A lands, channel B loses its response.
      .mockImplementationOnce(async (runContext, runOptions) => {
        await runOptions.onAnalysisComplete?.(analysisOutput);
        await runContext.publicationRecovery?.onChannelResult?.(
          { channel: "gitea-pr", status: "published", externalId: "comment-1" },
          "summary",
        );
        await runContext.publicationRecovery?.onChannelResult?.(
          { channel: "feishu", status: "failed", raw: { action: "dispatch_failed", phase: "summary", error: "fetch failed" } },
          "summary",
        );
        return result(true);
      })
      // Recovery attempt: must receive the persisted payload and skip channel A.
      .mockImplementationOnce(async (runContext, runOptions) => {
        expect(runOptions.resumePublication).toEqual({
          problems: analysisOutput.problems,
          summaries: analysisOutput.summaries,
        });
        expect(runContext.publicationRecovery?.skipChannels).toEqual(["gitea-pr"]);
        await runContext.publicationRecovery?.onChannelResult?.(
          { channel: "feishu", status: "published" },
          "summary",
        );
        return result();
      });
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      now: () => 1001,
    });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    const pending = (await store.readBatch("batch"))?.executionCheckpoint;
    expect(pending?.phase).toBe("publication_pending");
    expect(pending?.publication?.receipts).toEqual([
      expect.objectContaining({ channel: "gitea-pr", status: "published", attempts: 1 }),
      // No HTTP status in the failure raw payload: the outcome is unknown.
      expect.objectContaining({ channel: "feishu", status: "unknown", attempts: 1 }),
    ]);

    await execute(context);
    expect(runReview).toHaveBeenCalledTimes(2);
    const completed = (await store.readBatch("batch"))?.executionCheckpoint;
    expect(completed?.phase).toBe("completed");
    expect(completed?.publication).toBeUndefined();
  });

  it.each([[403, "failed"], [429, "failed"], [408, "unknown"], [500, "unknown"], [502, "unknown"], [504, "unknown"]] as const)("maps HTTP %s to %s", async (status, expected) => {
    const { store, context } = await fixture();
    const runReview = vi.fn<typeof runReviewOrchestration>()
      .mockImplementation(async (runContext, runOptions) => {
        await runOptions.onAnalysisComplete?.({
          problems: [],
          summaries: [{ markdown: "Reviewed" }],
          contextRequests: [],
        });
        await runContext.publicationRecovery?.onChannelResult?.(
          { channel: "gitlab-mr", status: "failed", raw: { action: "dispatch_failed", phase: "summary", error: `HTTP ${status}`, status } },
          "summary",
        );
        return result(true);
      });
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      now: () => 1001,
    });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    const checkpoint = (await store.readBatch("batch"))?.executionCheckpoint;
    expect(checkpoint?.publication?.receipts).toEqual([
      expect.objectContaining({ channel: "gitlab-mr", status: expected, lastError: `HTTP ${status}` }),
    ]);
  });

  it("falls back to a full replay for a legacy publication_pending checkpoint without a payload", async () => {
    const { store, context } = await fixture();
    // First attempt fails without ever reporting its analysis output, so the
    // checkpoint carries no recovery payload (legacy behavior).
    const runReview = vi.fn<typeof runReviewOrchestration>()
      .mockResolvedValueOnce(result(true))
      .mockResolvedValueOnce(result());
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      now: () => 1001,
    });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    expect((await store.readBatch("batch"))?.executionCheckpoint?.publication).toBeUndefined();

    await execute(context);
    const [, secondOptions] = runReview.mock.calls[1]!;
    expect(secondOptions.resumePublication).toBeUndefined();
    expect((await store.readBatch("batch"))?.executionCheckpoint?.phase).toBe("completed");
  });

  it("stops before publication when the analysis checkpoint loses its lease", async () => {
    const { store, context } = await fixture();
    const checkpoint = store.checkpointBatchExecution.bind(store);
    vi.spyOn(store, "checkpointBatchExecution").mockImplementation((id, token, value, at) =>
      value.phase === "publication_pending" ? Promise.resolve(false) : checkpoint(id, token, value, at));
    const publish = vi.fn();
    const execute = createAutoCommitBatchExecutor({ store, now: () => 1001,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview: async (_context, options) => {
        await options.onAnalysisComplete?.(result().outputState);
        publish();
        return result();
      },
    });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["failed", "buffered"] as const)("does not complete a channel with an unfinished %s dispatch", async (status) => {
    const { store, context } = await fixture();
    const execute = createAutoCommitBatchExecutor({ store, now: () => 1001,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview: async (runContext, options) => {
        await options.onAnalysisComplete?.(result().outputState);
        await runContext.publicationRecovery?.onChannelResult?.({ channel: "first", status }, "problem");
        if (status === "failed") {
          await runContext.publicationRecovery?.onChannelResult?.({ channel: "first", status: "published" }, "summary");
        }
        return result();
      },
    });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    expect((await store.readBatch("batch"))?.executionCheckpoint?.publication?.receipts[0]?.status)
      .toBe(status === "failed" ? "unknown" : "pending");
  });

  it.each([
    { output: { problems: [], summaries: [null] }, receipts: [] },
    { output: { problems: [], summaries: [{ markdown: "saved" }] }, receipts: {} },
    { output: { problems: [], summaries: [{ markdown: "saved" }] }, receipts: [{ channel: "first", status: "published" }] },
    { output: { problems: [{ file: "a.ts", line: 1, category: "correctness", message: "saved", severity: ["high"] }], summaries: [] }, receipts: [] },
    { output: { problems: [], summaries: [] }, receipts: [{ channel: "first", status: ["published"], attempts: 1, updatedAt: 1000 }] },
    { output: { problems: [], summaries: [] }, receipts: [
      { channel: "first", status: "failed", attempts: 1, updatedAt: 1000 },
      { channel: "first", status: "published", attempts: 1, updatedAt: 1000 },
    ] },
  ])("rejects corrupt recovery state without running or skipping analysis", async (publication) => {
    const { store, context } = await fixture();
    await store.checkpointBatchExecution("batch", context.leaseToken, {
      phase: "publication_pending", publication: publication as never,
    }, 1001);
    const runReview = vi.fn<typeof runReviewOrchestration>().mockResolvedValue(result());
    const execute = createAutoCommitBatchExecutor({ store, runReview, now: () => 1001,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    expect(runReview).not.toHaveBeenCalled();
  });

  it("counts repeated identical failed outcomes on separate attempts", async () => {
    const { store, context } = await fixture();
    const execute = createAutoCommitBatchExecutor({ store, now: () => 1001,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview: async (runContext, options) => {
        if (!options.resumePublication) await options.onAnalysisComplete?.(result().outputState);
        await runContext.publicationRecovery?.onChannelResult?.({ channel: "first", status: "failed" }, "summary");
        return result(true);
      },
    });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    expect((await store.readBatch("batch"))?.executionCheckpoint?.publication?.receipts[0]?.attempts).toBe(2);
  });

  it("does not skip a channel interrupted between two summaries", async () => {
    const { store, context } = await fixture();
    const runReview = vi.fn<typeof runReviewOrchestration>()
      .mockImplementationOnce(async (runContext, options) => {
        await options.onAnalysisComplete?.({ problems: [], summaries: [{ markdown: "one" }, { markdown: "two" }], contextRequests: [] });
        await runContext.publicationRecovery?.onChannelResult?.({ channel: "first", status: "published" }, "summary", false);
        expect((await store.readBatch("batch"))?.executionCheckpoint?.publication?.receipts[0]?.status).toBe("unknown");
        throw new Error("interrupted before second summary");
      })
      .mockImplementationOnce(async (runContext, options) => {
        expect(runContext.publicationRecovery?.skipChannels).toEqual([]);
        expect(options.resumePublication?.summaries).toHaveLength(2);
        await runContext.publicationRecovery?.onChannelResult?.({ channel: "first", status: "published" }, "summary", false);
        await runContext.publicationRecovery?.onChannelResult?.({ channel: "first", status: "published" }, "summary", true);
        return result();
      });
    const execute = createAutoCommitBatchExecutor({ store, runReview, now: () => 1001,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions });
    await expect(execute(context)).rejects.toThrow("interrupted before second summary");
    await execute(context);
    expect((await store.readBatch("batch"))?.executionCheckpoint?.phase).toBe("completed");
  });

  it.each([true, false])("does not confirm mixed buffered/published summary results (buffer first: %s)", async (bufferFirst) => {
    const { store, context } = await fixture();
    const execute = createAutoCommitBatchExecutor({ store, now: () => 1001,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview: async (runContext, options) => {
        await options.onAnalysisComplete?.(result().outputState);
        for (const status of bufferFirst ? ["buffered", "published"] as const : ["published", "buffered"] as const) {
          await runContext.publicationRecovery?.onChannelResult?.({ channel: "first", status }, "summary");
        }
        return result();
      },
    });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    expect((await store.readBatch("batch"))?.executionCheckpoint?.publication?.receipts[0]?.status).toBe("pending");
  });

  it.each(["receipt", "accounting"] as const)("removes stale recovery state when %s pushes the checkpoint over its cap", async (growth) => {
    const { store, context } = await fixture();
    const largeOutput = { problems: [], summaries: [{ markdown: "x".repeat(1_048_576 - 220) }], contextRequests: [] };
    const runReview = vi.fn<typeof runReviewOrchestration>()
      .mockImplementationOnce(async (runContext, options) => {
        await options.onAnalysisComplete?.(largeOutput);
        expect((await store.readBatch("batch"))?.executionCheckpoint?.publication).toBeDefined();
        if (growth === "receipt") {
          await runContext.publicationRecovery?.onChannelResult?.({ channel: "first", status: "failed", raw: { error: "e".repeat(1000) } }, "summary");
          expect((await store.readBatch("batch"))?.executionCheckpoint?.publication).toBeUndefined();
          throw new Error("crash after overflow");
        }
        return result(true);
      })
      .mockImplementationOnce(async (runContext, options) => {
        expect(options.resumePublication).toBeUndefined();
        expect(runContext.publicationRecovery?.skipChannels).toEqual([]);
        return result();
      });
    const execute = createAutoCommitBatchExecutor({ store, runReview, now: () => 1001,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions });
    await expect(execute(context)).rejects.toThrow(growth === "receipt" ? "crash after overflow" : "unconfirmed output");
    expect((await store.readBatch("batch"))?.executionCheckpoint?.publication).toBeUndefined();
    await execute(context);
  });

  it("aborts the orchestration signal when a receipt cannot be persisted", async () => {
    const { store, context } = await fixture();
    const execute = createAutoCommitBatchExecutor({ store, now: () => 1001,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview: async (runContext, options) => {
        await options.onAnalysisComplete?.(result().outputState);
        vi.spyOn(store, "checkpointBatchExecution").mockRejectedValue(new Error("database unavailable"));
        await expect(runContext.publicationRecovery?.onChannelResult?.({ channel: "first", status: "published" }, "summary"))
          .rejects.toMatchObject({ retryable: false });
        expect(runContext.signal?.aborted).toBe(true);
        return result();
      },
    });
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
  });

  it("retains analysis accounting and the existing analysis callback across recovery", async () => {
    const { store, context } = await fixture();
    const analysis = { model: { providerId: "fallback", modelId: "paid" }, promptTokenEstimate: 400,
      contextRequestCount: 1, llmUsage: { totalTokens: 800 }, estimatedCostUsd: 0.5, requestCount: 2 };
    const hook = vi.fn();
    const runReview = vi.fn<typeof runReviewOrchestration>()
      .mockImplementationOnce(async (_runContext, options) => {
        await options.onAnalysisComplete?.(result().outputState, analysis);
        throw new Error("interrupted");
      })
      .mockImplementationOnce(async (_runContext, options) => {
        expect(options.resumePublication?.analysis).toEqual(analysis);
        return result();
      });
    const execute = createAutoCommitBatchExecutor({ store, runReview, now: () => 1001,
      orchestrationOptions: { onAnalysisComplete: hook } as unknown as ServerReviewOrchestrationOptions });
    await expect(execute(context)).rejects.toThrow("interrupted");
    expect(hook).toHaveBeenCalledWith(result().outputState, analysis);
    await execute(context);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("drops an oversized recovery payload and degrades to full-replay recovery", async () => {
    const { store, context } = await fixture();
    const oversized = "x".repeat(1024 * 1024);
    const runReview = vi.fn<typeof runReviewOrchestration>()
      .mockImplementation(async (_runContext, runOptions) => {
        await runOptions.onAnalysisComplete?.({
          problems: [],
          summaries: [{ markdown: oversized }],
          contextRequests: [],
        });
        return result(true);
      });
    const execute = createAutoCommitBatchExecutor({
      store,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
      now: () => 1001,
    });
    // The run itself must not fail on the RangeError from the 1 MiB cap.
    await expect(execute(context)).rejects.toMatchObject({ retryable: false });
    const checkpoint = (await store.readBatch("batch"))?.executionCheckpoint;
    expect(checkpoint?.phase).toBe("publication_pending");
    expect(checkpoint?.publication).toBeUndefined();
  });
});
