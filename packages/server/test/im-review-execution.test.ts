import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appConfigSchema, createReviewEvent, type AppConfig } from "@aicr/core";
import { closeStoreDb, createStoreDb, type SqliteStoreDb } from "@aicr/store";

import { createImReviewExecutor } from "../src/im/review-execution.js";
import type { ImReviewCheckpoint, ImReviewExecutionInput, ImReviewResume } from "../src/im/manual-review-service.js";
import type { ReviewOrchestrationContext, ReviewOrchestrationResult, ServerReviewOrchestrationOptions } from "../src/review-orchestrator.js";
import type { runReviewOrchestration } from "../src/review-orchestrator.js";

/**
 * IM-14 executor acceptance R14/R15: the analysis output is checkpointed
 * before any remote write, per-channel receipts persist as they settle, a
 * resumed publication replays without a fresh analysis, and a lost lease
 * (fenced checkpoint write) stops further remote work.
 */

const config: AppConfig = appConfigSchema.parse({
  im: {
    connections: { bot: { kind: "wecom_aibot", corp_id: "ww", aibot_id: "b1" } },
    command_bindings: {
      reviewers: {
        enabled: true, connection: "bot",
        conversations: [{ kind: "bot_direct" }],
        actors: [{ type: "wecom_userid", id: "owent" }],
        commands: ["review"],
        repositories: { svc: { workspace: "ws", source_trigger: "git-main", repo_ref: "org/s" } },
      },
    },
  },
  triggers: [{ name: "git-main", kind: "github" }],
  workspaces: { instances: { ws: {} } },
  outputs: { channels: [] },
});

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-im-executor-"));
  store = createStoreDb(join(dir, "executor.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

function result(): ReviewOrchestrationResult {
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
    dispatchCount: 1,
    model: { providerId: "test", modelId: "test" },
    preparedPrompt: {} as ReviewOrchestrationResult["preparedPrompt"],
    outputState: { problems: [], summaries: [{ markdown: "Reviewed" }], contextRequests: [] },
    dispatchResults: [{ channel: "chat", status: "published", externalId: "m-1" }],
    llmResult: { providerId: "test", modelId: "test", content: "review", raw: {}, usage: { totalTokens: 123 } },
    scrubMatches: [],
  };
}

function executionInput(overrides: Partial<ImReviewExecutionInput> = {}): ImReviewExecutionInput {
  return {
    event: createReviewEvent({
      triggerName: "git-main", provider: "manual", workspaceId: "ws", targetKind: "commit",
      repoRef: "org/s", headSha: "0123456789abcdef0123456789abcdef01234567", author: {}, reason: "im:command",
    }),
    config,
    request: { requestId: "imr-x", runId: `run-${Math.random().toString(36).slice(2)}`, configSnapshotId: "snap" } as ImReviewExecutionInput["request"],
    signal: new AbortController().signal,
    resume: undefined,
    hooks: { saveCheckpoint: async () => true },
    ...overrides,
  };
}

describe("IM review executor publication recovery", () => {
  it("checkpoints the analysis output before remote writes and persists receipts (R14/R15)", async () => {
    const saved: ImReviewCheckpoint[] = [];
    const runReview = vi.fn<typeof runReviewOrchestration>(async (context: ReviewOrchestrationContext, options) => {
      await options.onAnalysisComplete?.(result().outputState, undefined);
      // The first checkpoint (analysis payload) precedes any remote write.
      expect(saved[0]?.phase).toBe("publication_pending");
      expect(saved[0]?.publication?.output).toMatchObject({ problems: [], summaries: [{ markdown: "Reviewed" }] });
      const recovery = context.publicationRecovery!;
      await recovery.onChannelStart!("chat");
      await recovery.onChannelResult!({ channel: "chat", status: "published", externalId: "m-1" }, "summary");
      return result();
    });
    const execute = createImReviewExecutor({
      store, now: () => 2000,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
    });
    const outcome = await execute(executionInput({
      hooks: { saveCheckpoint: async checkpoint => { saved.push(checkpoint); return true; } },
    }));
    expect(outcome).toEqual({ state: "succeeded" });
    expect(runReview).toHaveBeenCalledTimes(1);
    // Receipts settled through the checkpoint: one channel, published once.
    expect(saved.at(-1)?.publication?.receipts).toEqual([
      expect.objectContaining({ channel: "chat", status: "published", attempts: 1, externalId: "m-1" }),
    ]);
  });

  it("replays a resumed publication without a fresh analysis and skips published channels (R14/R15)", async () => {
    const resume: ImReviewResume = {
      output: { problems: [], summaries: [{ markdown: "Reviewed" }] },
      receipts: [
        { channel: "chat", status: "published", attempts: 1, updatedAt: 1000 },
        { channel: "issue", status: "failed", attempts: 1, lastError: "boom", updatedAt: 1000 },
      ],
    };
    const replays = vi.fn();
    const saved: ImReviewCheckpoint[] = [];
    const runReview = vi.fn<typeof runReviewOrchestration>(async (context, options) => {
      expect(options.resumePublication).toBe(resume.output);
      expect(context.publicationRecovery?.skipChannels).toEqual(["chat"]);
      replays();
      const recovery = context.publicationRecovery!;
      await recovery.onChannelStart!("issue");
      await recovery.onChannelResult!({ channel: "issue", status: "published", externalId: "i-9" }, "summary");
      return { ...result(), dispatchResults: [
        { channel: "chat", status: "published", externalId: "old" },
        { channel: "issue", status: "published", externalId: "i-9" },
      ] };
    });
    const execute = createImReviewExecutor({
      store, now: () => 2000,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
    });
    const outcome = await execute(executionInput({
      resume,
      hooks: { saveCheckpoint: async checkpoint => { saved.push(checkpoint); return true; } },
    }));
    expect(outcome).toEqual({ state: "succeeded" });
    // The replay ran once through the resume path; the LLM was skipped by
    // resumePublication (R14: 计数不增加), and only the failed channel retried.
    expect(replays).toHaveBeenCalledTimes(1);
    expect(saved[0]?.publication?.receipts?.find(receipt => receipt.channel === "issue"))
      .toMatchObject({ status: "unknown", attempts: 2 });
    expect(saved.at(-1)?.publication?.receipts?.find(receipt => receipt.channel === "issue"))
      .toMatchObject({ status: "published", attempts: 2 });
  });

  it("stops remote work when the fenced checkpoint write loses the lease (R15 fencing)", async () => {
    const runReview = vi.fn<typeof runReviewOrchestration>(async (context, options) => {
      // Losing the lease at the pre-publication checkpoint aborts the run
      // before publication: the rejection propagates out of the analysis
      // hook (发布前先检查 fencing), so the stub returns through the same
      // error path a real orchestration would.
      await expect(options.onAnalysisComplete!(result().outputState, undefined)).rejects.toThrow("lease was lost");
      return result();
    });
    const execute = createImReviewExecutor({
      store, now: () => 2000,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
    });
    const input = executionInput({
      hooks: { saveCheckpoint: async () => false }, // fence lost
    });
    const outcome = await execute(input);
    expect(outcome).toMatchObject({ state: "publication_unknown", errorCode: "im.review_failed_unknown" });
    expect(store.sqlite.prepare("SELECT id FROM review_runs WHERE id = ?").get(input.request.runId)).toBeUndefined();
  });

  it.each(["oversized", "storage failure"])("stops publication when checkpoint persistence reports %s, even if orchestration catches the error", async failure => {
    const writes = vi.fn();
    const runReview = vi.fn<typeof runReviewOrchestration>(async (context, options) => {
      try { await options.onAnalysisComplete!(result().outputState, undefined); } catch { /* dispatch errors may be caught */ }
      if (!context.signal?.aborted) writes();
      return result();
    });
    const execute = createImReviewExecutor({ store, orchestrationOptions: {} as ServerReviewOrchestrationOptions, runReview });
    const input = executionInput({ hooks: { saveCheckpoint: async () => {
      if (failure === "storage failure") throw new Error("store unavailable");
      return "oversized";
    } } });
    const outcome = await execute(input);
    expect(writes).not.toHaveBeenCalled();
    expect(outcome.state).toBe("publication_unknown");
    expect(store.sqlite.prepare("SELECT status FROM review_runs WHERE id = ?").get(input.request.runId)).toMatchObject({ status: "failed" });
  });

  it("retains an unknown receipt in the terminal outcome when a transport fails", async () => {
    const runReview = vi.fn<typeof runReviewOrchestration>(async (context, options) => {
      await options.onAnalysisComplete!(result().outputState, undefined);
      const unknown = { channel: "chat", status: "failed" as const, raw: { error: "connection lost" } };
      await context.publicationRecovery!.onChannelResult!(unknown, "summary");
      return { ...result(), dispatchResults: [unknown] };
    });
    const execute = createImReviewExecutor({ store, orchestrationOptions: {} as ServerReviewOrchestrationOptions, runReview });
    expect(await execute(executionInput())).toMatchObject({ state: "publication_unknown" });
  });

  it("maps partial channel failure to the partial terminal state", async () => {
    const runReview = vi.fn<typeof runReviewOrchestration>(async (context, options) => {
      await options.onAnalysisComplete?.(result().outputState, undefined);
      await context.publicationRecovery!.onChannelResult!({ channel: "issue", status: "failed", raw: { status: 404, error: "gone" } }, "summary");
      return { ...result(), dispatchResults: [
        { channel: "chat", status: "published", externalId: "m-1" },
        { channel: "issue", status: "failed", raw: { status: 404 } },
      ] };
    });
    const execute = createImReviewExecutor({
      store, now: () => 2000,
      orchestrationOptions: {} as ServerReviewOrchestrationOptions,
      runReview,
    });
    const input = executionInput();
    const outcome = await execute(input);
    expect(outcome).toEqual({ state: "partial", errorCode: "im.publication_partial" });
    // The terminal run row replaced the in-flight analyzing marker.
    expect(store.sqlite.prepare("SELECT id FROM review_runs WHERE id = ?").get(input.request.runId))
      .toMatchObject({ id: input.request.runId });
  });
});
