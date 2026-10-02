import type { PublicationReceipt } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { PublicationJournal, type DispatchResult } from "@aicr/outputs";

import { receiptStatusForDispatch } from "../auto-commit-runtime.js";
import { persistFailedRunToStore, persistReviewRunToStore } from "../index.js";
import {
  runReviewOrchestration,
  summarizeReviewOrchestrationForWebhook,
  type ReviewAnalysisSnapshot,
  type ServerReviewOrchestrationOptions,
} from "../review-orchestrator.js";
import { classifyImReviewResult, IM_CANCEL_REASON, type ImReviewCheckpoint, type ImReviewExecutionInput, type ImReviewExecutionResult } from "./manual-review-service.js";

/**
 * IM review execution hook (IM-14, R14/R15): adapts `runReviewOrchestration`
 * to the request worker's fenced checkpoint writer. Mirrors the auto-commit
 * executor's publication recovery: the analysis output is durably recorded
 * before any remote write, per-channel receipts are persisted as they
 * settle, and the remote-write journal reconciles unknown operations instead
 * of re-sending them.
 */
export function createImReviewExecutor(options: {
  readonly store: StoreDb;
  readonly orchestrationOptions: ServerReviewOrchestrationOptions;
  /** Test seam; defaults to the real orchestration. */
  readonly runReview?: typeof runReviewOrchestration;
  readonly now?: () => number;
}): (input: ImReviewExecutionInput) => Promise<ImReviewExecutionResult> {
  const now = options.now ?? Date.now;
  const runReview = options.runReview ?? runReviewOrchestration;
  return async ({ event, request, signal, resume, hooks }) => {
    const startMs = now();
    const receipts = new Map<string, PublicationReceipt>(resume?.receipts.map(receipt => [receipt.channel, receipt]) ?? []);
    const attempted = new Set<string>();
    const failed = new Set<string>();
    const unflushed = new Set<string>();
    let payload: ResumePublicationPayload | undefined = resume?.output;
    let remote = resume?.remote;
    let leaseLost = false;
    const abort = new AbortController();
    const executionSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;

    const persistCheckpoint = async (): Promise<void> => {
      if (payload === undefined) {
        // Remote-write reconciliation requires a durable analysis payload; without one,
        // the journal save fails closed below rather than trusting an unrecoverable write.
        return;
      }
      const checkpoint: ImReviewCheckpoint = {
        phase: "publication_pending",
        publication: { output: payload, receipts: [...receipts.values()], ...(remote ? { remote } : {}) },
      };
      try {
        const accepted = await hooks.saveCheckpoint(checkpoint);
        if (accepted === false) {
          leaseLost = true;
          throw new Error("im checkpoint lease was lost");
        }
        if (accepted === "oversized") throw new Error("im publication checkpoint exceeds the size limit");
      } catch (error) {
        // Dispatch may catch an exception. The shared signal must still fence
        // every subsequent channel and journaled POST.
        abort.abort(error);
        throw error;
      }
    };

    const publicationRecovery = {
      remote: new PublicationJournal({
        batchId: request.runId,
        ...(remote ? { operations: remote.operations } : {}),
        signal: executionSignal,
        now,
        save: async operations => {
          if (payload === undefined) {
            const failure = new Error("remote publication requires a durable analysis payload");
            abort.abort(failure);
            throw failure;
          }
          remote = { version: 1, operations };
          await persistCheckpoint();
        },
      }),
      // A channel holding a `published` receipt is provably delivered and is
      // skipped on resume; unknown/failed receipts are retried through the journal.
      skipChannels: [...receipts.values()].filter(receipt => receipt.status === "published").map(receipt => receipt.channel),
      onChannelStart: async (channel: string): Promise<void> => {
        const previous = receipts.get(channel);
        receipts.set(channel, {
          ...previous, channel,
          status: failed.has(channel) ? previous!.status : "unknown",
          attempts: (previous?.attempts ?? 0) + (attempted.has(channel) ? 0 : 1),
          updatedAt: now(),
        });
        attempted.add(channel);
        await persistCheckpoint();
      },
      onChannelResult: async (result: DispatchResult, phase: "problem" | "summary", finalForChannel = true): Promise<void> => {
        const mapped = receiptStatusForDispatch(result, phase);
        if (!mapped) return;
        const previous = receipts.get(result.channel);
        if (result.status === "failed") failed.add(result.channel);
        if (phase === "summary" && mapped.status === "pending") unflushed.add(result.channel);
        const status = failed.has(result.channel)
          ? result.status === "failed" ? mapped.status : previous?.status === "failed" ? "failed" : "unknown"
          : unflushed.has(result.channel) ? "pending"
          : mapped.status === "published" && !finalForChannel ? "unknown" : mapped.status;
        const next: PublicationReceipt = {
          channel: result.channel,
          status,
          ...(result.externalId !== undefined ? { externalId: result.externalId } : {}),
          attempts: (previous?.attempts ?? 0) + (attempted.has(result.channel) ? 0 : 1),
          ...(mapped.lastError !== undefined
            ? { lastError: mapped.lastError }
            : previous?.lastError !== undefined && status !== "published"
              ? { lastError: previous.lastError }
              : {}),
          updatedAt: now(),
        };
        attempted.add(result.channel);
        receipts.set(result.channel, next);
        await persistCheckpoint();
      },
    };

    try {
      const result = await runReview({
        reviewEvent: event, payload: {}, provider: "manual", eventName: "im.command.review",
        runId: request.runId, runSource: "im_command", signal: executionSignal,
        configSnapshotId: request.configSnapshotId === "file-only" ? null : request.configSnapshotId,
        publicationRecovery,
      }, {
        ...options.orchestrationOptions,
        ...(payload !== undefined ? { resumePublication: payload } : {}),
        onAnalysisComplete: async (outputState, analysis?: ReviewAnalysisSnapshot) => {
          payload = {
            problems: outputState.problems,
            summaries: outputState.summaries,
            ...(outputState.skipReason !== undefined ? { skipReason: outputState.skipReason } : {}),
            ...(analysis !== undefined ? { analysis } : {}),
          };
          // Durably record the publishable payload before any remote write so
          // an interrupted publication resumes without re-running the LLM (R14).
          await persistCheckpoint();
        },
      });
      executionSignal.throwIfAborted();
      // Terminal persistence mirrors the webhook path so the in-flight
      // `analyzing` marker written at execution start is replaced by the
      // full outcome row (otherwise `aicr running` shows stale entries).
      await persistReviewRunToStore(
        options.store,
        request.runId,
        event,
        summarizeReviewOrchestrationForWebhook(result),
        now() - startMs,
        startMs,
      );
      return classifyImReviewResult(result, [...receipts.values()]);
    } catch (error) {
      // Operator cancellation: the cancel coordinator already wrote the
      // terminal request state and the cancelled run row; a failed row
      // here would overwrite it.
      const cancelled = signal?.aborted === true && (signal as { reason?: unknown }).reason === IM_CANCEL_REASON;
      if (!signal.aborted && !leaseLost) {
        console.warn(JSON.stringify({ msg: "im_review_orchestration_failed", requestId: request.requestId, error: String(error) }));
        await persistFailedRunToStore(options.store, request.runId, event, now() - startMs, startMs, error);
      }
      return {
        state: "publication_unknown" as const,
        errorCode: cancelled ? "im.cancelled_by_user" : "im.review_failed_unknown",
      };
    }
  };
}

type ResumePublicationPayload = {
  readonly problems: Parameters<NonNullable<ServerReviewOrchestrationOptions["onAnalysisComplete"]>>[0]["problems"];
  readonly summaries: Parameters<NonNullable<ServerReviewOrchestrationOptions["onAnalysisComplete"]>>[0]["summaries"];
  readonly skipReason?: string;
  readonly analysis?: ReviewAnalysisSnapshot;
};
