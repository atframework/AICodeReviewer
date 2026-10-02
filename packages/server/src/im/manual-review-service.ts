import { randomUUID } from "node:crypto";

import type { AppConfig, BatchExecutionCheckpoint, PublicationReceipt, RemotePublicationOperation } from "@aicr/core";
import { computeBackoffDelay, createReviewEvent, resolveAutoCommitPolicy, type ReviewEvent } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import {
  claimDueImReviewRequests,
  claimImReviewRequestById,
  finishImReviewRequest,
  findImReviewRequest,
  prepareImDispatch,
  renewImReviewLease,
  updateImReviewRequest,
  imReviewJobId,
  listImReviewRequestsForAdmin,
  cancelImReviewRequest,
  updateRunStatus,
  type ClaimedImReviewRequest,
  type ImTerminalState,
  type ImReviewRequestRow,
} from "@aicr/store";
import type { VcsAdapter } from "@aicr/vcs";

import { resolveImRevision, type ResolvedImRevision } from "./revision-resolver.js";
import { readResumePublication, receiptStatusForDispatch, type ResumePublicationOutput } from "../auto-commit-runtime.js";
import type { ReviewOrchestrationResult } from "../review-orchestrator.js";

export function classifyImReviewResult(result: Pick<ReviewOrchestrationResult, "status" | "skipReason" | "dispatchResults">, receipts: readonly PublicationReceipt[] = []): {
  readonly state: ImTerminalState;
  readonly errorCode?: string;
} {
  if (result.dispatchResults.some(entry => entry.status === "buffered")) {
    return { state: "publication_unknown", errorCode: "im.publication_buffered" };
  }
  if (receipts.some(receipt => receipt.status === "unknown" || receipt.status === "pending")
    || result.dispatchResults.some(entry => entry.status === "failed" && receiptStatusForDispatch(entry, "summary")?.status === "unknown")) {
    return { state: "publication_unknown", errorCode: "im.publication_unknown" };
  }
  if (receipts.some(receipt => receipt.status === "failed") || result.dispatchResults.some(entry => entry.status === "failed")) {
    return receipts.some(receipt => receipt.status === "published") || result.dispatchResults.some(entry => entry.status === "published" || Number((entry.raw as { deliveredParts?: unknown } | undefined)?.deliveredParts) > 0)
      ? { state: "partial", errorCode: "im.publication_partial" }
      : { state: "failed", errorCode: "im.publication_failed" };
  }
  if (receipts.some(receipt => receipt.lastError === "recipient_partial")
    || result.dispatchResults.some(entry => receiptStatusForDispatch(entry, "summary")?.lastError === "recipient_partial")) {
    return { state: "partial", errorCode: "im.publication_partial" };
  }
  if (result.status === "dry_run" || result.skipReason === "no_output_publisher" || result.skipReason === "output_dispatch_failed") {
    return { state: "failed", errorCode: "im.review_not_published" };
  }
  return { state: "succeeded" };
}

/**
 * Abort reason marker for operator-driven cancellation of a running IM
 * review request; distinguishes cancel from lease-renewal interrupts so the
 * bootstrap execution hook can leave the run row to the cancel coordinator.
 */
export const IM_CANCEL_REASON = "aicr.im_cancelled";

/** Publication recovery payload persisted in the request checkpoint (R14/R15). */
export interface ImReviewResume {
  readonly output: ResumePublicationOutput;
  readonly receipts: readonly PublicationReceipt[];
  readonly remote?: { readonly version: 1; readonly operations: readonly RemotePublicationOperation[] };
}

/** Persisted checkpoint shape (mirrors the auto-commit execution checkpoint). */
export type ImReviewCheckpoint = BatchExecutionCheckpoint & { readonly target?: ResolvedImRevision };

export interface ImReviewExecutionHooks {
  /**
   * Fenced checkpoint persist (state→publishing + payload). `false` means the
   * lease was lost — the executor must stop before further remote writes;
   * `"oversized"` means the payload exceeded the cap. Preserve the last durable
   * checkpoint and stop publication rather than losing the remote journal.
   */
  readonly saveCheckpoint: (checkpoint: ImReviewCheckpoint) => Promise<boolean | "oversized">;
}

export interface ImReviewExecutionInput {
  readonly event: ReviewEvent;
  readonly config: AppConfig;
  readonly request: ImReviewRequestRow;
  readonly signal: AbortSignal;
  /** Present when a crashed publication is being resumed (R14): replay, no LLM. */
  readonly resume: ImReviewResume | undefined;
  readonly hooks: ImReviewExecutionHooks;
}

export type ImReviewExecutionResult = { readonly state: ImTerminalState; readonly errorCode?: string };

/** One queue handoff: the wake-up job identity plus the fenced execution. */
export interface ImReviewDispatch {
  readonly jobId: string;
  readonly requestId: string;
  readonly dispatchSeq: number;
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly configSnapshotId: string;
  /** True when the caller (queue worker branch) already holds the shared concurrency permit (R13). */
  readonly permitHeld: boolean;
  readonly execute: () => Promise<void>;
}

/** Per-phase attempt counters persisted in `attempts_by_phase_json` (spec §5). */
type PhaseAttempts = { readonly validating?: number; readonly analysis?: number; readonly publication?: number };

const CHECKPOINT_MAX_BYTES = 1_048_576;
const DEFAULT_PHASE_ATTEMPTS = 3;

function parseAttempts(row: ImReviewRequestRow): PhaseAttempts {
  try {
    const parsed = JSON.parse(row.attemptsByPhaseJson) as Partial<PhaseAttempts>;
    return {
      ...(typeof parsed.validating === "number" ? { validating: parsed.validating } : {}),
      ...(typeof parsed.analysis === "number" ? { analysis: parsed.analysis } : {}),
      ...(typeof parsed.publication === "number" ? { publication: parsed.publication } : {}),
    };
  } catch {
    return {};
  }
}

function retryPolicy(config: AppConfig): { attempts: number; backoff: { kind: "exponential" | "linear" | "constant"; baseMs: number; maxMs: number; jitter: boolean } } {
  const retry = config.queue.retry;
  return {
    attempts: retry?.attempts ?? DEFAULT_PHASE_ATTEMPTS,
    backoff: {
      kind: retry?.backoff?.kind ?? "exponential",
      baseMs: retry?.backoff?.base_ms ?? 2000,
      maxMs: retry?.backoff?.max_ms ?? 60_000,
      jitter: retry?.backoff?.jitter ?? true,
    },
  };
}

/**
 * Reads a persisted publication checkpoint. An invalid or oversized payload
 * degrades to the conservative recovery path, exactly like a missing one —
 * the resume position is never guessed from partial strings.
 */
export function readImReviewCheckpoint(row: Pick<ImReviewRequestRow, "resumePhase" | "checkpointJson">): ImReviewResume | undefined {
  if (row.resumePhase !== "publication_pending" || row.checkpointJson === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.checkpointJson);
  } catch {
    return undefined;
  }
  let output: ResumePublicationOutput | undefined;
  try { output = readResumePublication(parsed as ImReviewCheckpoint); } catch { return undefined; }
  const publication = (parsed as ImReviewCheckpoint | null)?.publication;
  if (output === undefined || publication === undefined) return undefined;
  return {
    output,
    receipts: publication.receipts,
    ...(publication.remote !== undefined ? { remote: publication.remote } : {}),
  };
}

function readResolvedTarget(request: ImReviewRequestRow): ResolvedImRevision | undefined {
  try {
    const target = (JSON.parse(request.checkpointJson ?? "null") as ImReviewCheckpoint | null)?.target;
    if (target?.revision !== request.resolvedRevision || target === undefined || typeof target.author !== "object" || target.author === null) return undefined;
    if ([target.author.username, target.author.email].some(value => value !== undefined && typeof value !== "string")) return undefined;
    return target;
  } catch { return undefined; }
}

/**
 * IM-14 request worker (design §7.3, contracts §5): claims due requests,
 * validates the fixed revision through the trusted VCS adapter, builds a
 * ReviewEvent with the im_command requestOrigin, hands execution to the
 * dispatch seam (durable queue wake-up + shared concurrency), and writes
 * terminal state + active-target release atomically.
 *
 * The request table owns retry/attempt truth; the queue is only a wake-up.
 * maxAttempts:1 on the queue job means a lost wake-up is recovered by the
 * due scan, never by re-running the logical request (R10–R12).
 */

export interface ManualReviewWorkerOptions {
  readonly store: StoreDb;
  readonly namespace: string;
  readonly getConfig: (snapshotId: string) => Promise<AppConfig> | AppConfig;
  readonly createAdapter: (config: AppConfig, request: ImReviewRequestRow) => Promise<VcsAdapter | undefined> | VcsAdapter | undefined;
  /**
   * One dispatch handoff: persist the wake-up job (dedup by job id, version
   * captured from the request's generation), then run the fenced execution —
   * under the shared concurrency permit unless the wake-up caller already
   * holds one (R13: the permit is acquired exactly once per execution).
   */
  readonly dispatch: (handoff: ImReviewDispatch) => Promise<void>;
  readonly executeReview: (input: ImReviewExecutionInput) => Promise<ImReviewExecutionResult>;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly batchLimit?: number;
}

export class ManualReviewService {
  private readonly options: Required<ManualReviewWorkerOptions>;
  private running = false;
  private stopped = false;
  private readonly activeOperations = new Set<Promise<unknown>>();
  /** Live per-request execution controllers (operator cancel path). */
  private readonly cancelAborts = new Map<string, AbortController>();

  constructor(options: ManualReviewWorkerOptions) {
    this.options = {
      ...options,
      now: options.now ?? (() => new Date()),
      leaseMs: options.leaseMs ?? 60_000,
      batchLimit: options.batchLimit ?? 1,
    };
  }

  /**
   * One scan pass: claims due requests and drives each through the state
   * machine accepted→validating→queued→running→publishing→terminal.
   * Idempotent — safe to call from the queue wake-up or a periodic timer.
   */
  async scan(handoffOptions: { readonly permitHeld?: boolean } = {}): Promise<number> {
    if (this.stopped) return 0;
    return this.track(() => this.scanPass(handoffOptions));
  }

  private async scanPass(handoffOptions: { readonly permitHeld?: boolean }): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const configs = new Map<string, AppConfig>();
      await this.expireQueued(configs);
      if (this.stopped) return 0;
      const now = this.options.now();
      const claimed = await claimDueImReviewRequests(this.options.store, {
        namespace: this.options.namespace,
        now,
        leaseMs: this.options.leaseMs,
        owner: `im-worker-${randomUUID()}`,
        limit: this.options.batchLimit,
      });
      for (const claim of claimed) {
        await this.driveClaim(claim, configs, handoffOptions.permitHeld === true);
      }
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  /**
   * Queue wake-up consumption (worker `kind:'im_review'` branch, R11/R12):
   * claims exactly one request when it is due and unleased, then drives it.
   * A duplicate wake-up while the live executor holds the lease claims
   * nothing and completes without a second execution.
   */
  async wake(job: { readonly requestId: string; readonly configSnapshotId?: string | undefined }): Promise<"executed" | "not_due" | "terminal" | "version_mismatch"> {
    if (this.stopped) return "not_due";
    return this.track(() => this.wakeRequest(job));
  }

  private async wakeRequest(job: { readonly requestId: string; readonly configSnapshotId?: string | undefined }): Promise<"executed" | "not_due" | "terminal" | "version_mismatch"> {
    const request = await findImReviewRequest(this.options.store, this.options.namespace, job.requestId);
    if (request === undefined || ["succeeded", "partial", "publication_unknown", "failed", "rejected"].includes(request.state)) {
      return "terminal";
    }
    // The queue job and the request table must agree on the config version;
    // a mismatch refuses execution and keeps the diagnostic (spec §5).
    if (job.configSnapshotId !== undefined && job.configSnapshotId !== request.configSnapshotId) {
      console.warn(JSON.stringify({ msg: "im_wake_version_mismatch", requestId: job.requestId, jobVersion: job.configSnapshotId, requestVersion: request.configSnapshotId }));
      return "version_mismatch";
    }
    if (this.stopped) return "not_due";
    const claim = await claimImReviewRequestById(this.options.store, {
      namespace: this.options.namespace,
      requestId: job.requestId,
      now: this.options.now(),
      leaseMs: this.options.leaseMs,
      owner: `im-wake-${randomUUID()}`,
    });
    if (claim === undefined) return "not_due";
    await this.driveClaim(claim, new Map<string, AppConfig>(), true);
    return "executed";
  }

  private async track<T>(operation: () => Promise<T>): Promise<T> {
    const task = operation();
    this.activeOperations.add(task);
    try { return await task; } finally { this.activeOperations.delete(task); }
  }

  /** Stop claims, abort live work, then drain before the host closes the store. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.cancelAborts.values()) controller.abort("aicr.im_shutdown");
    await Promise.allSettled([...this.activeOperations]);
  }

  /**
   * Aborts the live execution of one request (operator cancellation). The
   * caller owns the terminal store transition (`cancelImReviewRequest`
   * bumps the fence, so this worker's later fenced writes no-op). Returns
   * false when no execution is live for the request id.
   */
  cancelRunning(requestId: string): boolean {
    const controller = this.cancelAborts.get(requestId);
    if (!controller) return false;
    controller.abort(IM_CANCEL_REASON);
    return true;
  }

  /** May run while another request awaits admission; executing reviews survive. */
  async expireQueued(configs = new Map<string, AppConfig>()): Promise<number> {
    const rows = [];
    for (let offset = 0; ; offset += 200) {
      const page = await listImReviewRequestsForAdmin(this.options.store, 200, offset);
      rows.push(...page);
      if (page.length < 200) break;
    }
    let expired = 0;
    for (const row of rows) {
      if (row.namespace !== this.options.namespace || !["accepted", "validating", "queued", "retry_wait"].includes(row.state)) continue;
      const request = await findImReviewRequest(this.options.store, this.options.namespace, row.requestId);
      if (!request) continue;
      const config = configs.get(request.configSnapshotId) ?? await this.options.getConfig(request.configSnapshotId);
      configs.set(request.configSnapshotId, config);
      const timeoutMs = resolveAutoCommitPolicy(config.review.auto_commit, config.workspaces.defaults.review?.auto_commit,
        config.workspaces.instances[row.workspaceId]?.review?.auto_commit).queuedTimeoutMs;
      const now = this.options.now();
      if (timeoutMs === null || row.createdAt.getTime() >= now.getTime() - timeoutMs) continue;
      const notification = buildTerminalNotification(request, "rejected", "im.queued_timeout");
      if (!await cancelImReviewRequest(this.options.store, { requestId: request.requestId,
        states: ["accepted", "validating", "queued", "retry_wait"], errorCode: "im.queued_timeout",
        ...(notification ? { notifications: [notification] } : {}), now })) continue;
      this.cancelRunning(request.requestId);
      await updateRunStatus(this.options.store, request.runId, "timeout", { error: "queued_timeout", onlyIfActive: true });
      expired++;
    }
    return expired;
  }

  /** Runs one claimed request to its next stop with lease renewal and failure fencing. */
  private async driveClaim(claim: ClaimedImReviewRequest, configs: Map<string, AppConfig>, permitHeld: boolean): Promise<void> {
    const request = claim.request;
    const controller = new AbortController();
    this.cancelAborts.set(request.requestId, controller);
    if (this.stopped) controller.abort("aicr.im_shutdown");
    const renew = async () => {
      try {
        const valid = await renewImReviewLease(this.options.store, {
          requestId: request.requestId, fence: claim.fence, owner: request.leaseOwner!,
          now: this.options.now(), leaseMs: this.options.leaseMs,
        });
        if (!valid) controller.abort();
      } catch { controller.abort(); }
    };
    const timer = setInterval(() => { void renew(); }, Math.max(1, Math.floor(this.options.leaseMs / 3)));
    timer.unref();
    try {
      await this.processClaim(claim, controller.signal, configs, permitHeld);
    } catch (error) {
      console.warn(JSON.stringify({ msg: "im_review_failed", requestId: request.requestId, error: String(error) }));
      if (!controller.signal.aborted) {
        await finishImReviewRequest(this.options.store, {
          requestId: request.requestId, fence: claim.fence, state: "failed", errorCode: "im.execution_failed",
          notifications: [buildTerminalNotification(request, "failed", "im.execution_failed")].filter((value): value is NonNullable<typeof value> => value !== undefined),
          now: this.options.now(),
        });
      }
    } finally {
      clearInterval(timer);
      if (this.cancelAborts.get(request.requestId) === controller) this.cancelAborts.delete(request.requestId);
    }
  }

  private async processClaim(claim: ClaimedImReviewRequest, signal: AbortSignal, configs: Map<string, AppConfig>, permitHeld: boolean): Promise<void> {
    signal.throwIfAborted();
    const request = claim.request;
    const now = this.options.now();
    const { fence } = claim;

    // Terminal-state guard: a request that reached a terminal state between
    // the claim scan and this call must not be resurrected.
    if (["succeeded", "partial", "publication_unknown", "failed", "rejected"].includes(request.state)) {
      return;
    }

    const config = configs.get(request.configSnapshotId) ?? await this.options.getConfig(request.configSnapshotId);

    // Crash-recovery triage (R14/R15): a claim over `running`/`publishing`
    // means the previous owner's lease expired mid-flight. Publication with a
    // durable checkpoint resumes publication only; analysis re-attempts with
    // persisted backoff; anything unprovable stays conservatively unknown.
    if (request.state === "running" || request.state === "publishing") {
      await this.recoverInterrupted(claim, config, signal, permitHeld);
      return;
    }

    // validating: resolve the revision through the trusted adapter.
    if (request.state === "accepted" || request.state === "validating" || request.resolvedRevision === null) {
      const adapter = await this.options.createAdapter(config, request);
      if (adapter === undefined) {
        await finishImReviewRequest(this.options.store, {
          requestId: request.requestId, fence, state: "rejected", errorCode: "im.invalid_revision",
          notifications: [buildTerminalNotification(request, "rejected", "im.invalid_revision")].filter((value): value is NonNullable<typeof value> => value !== undefined), now,
        });
        return;
      }

      await updateImReviewRequest(this.options.store, {
        requestId: request.requestId, fence, state: "validating", now,
      });
      const resolution = await resolveImRevision(adapter, request.requestedRevision);
      signal.throwIfAborted();
      if (resolution.kind === "rejected") {
        await finishImReviewRequest(this.options.store, {
          requestId: request.requestId, fence, state: "rejected", errorCode: `im.${resolution.reason}`,
          notifications: [buildTerminalNotification(request, "rejected", `im.${resolution.reason}`)].filter((value): value is NonNullable<typeof value> => value !== undefined), now,
        });
        return;
      }
      // Save the resolved target and move to queued.
      await updateImReviewRequest(this.options.store, {
        requestId: request.requestId, fence: fence, state: "queued",
        resolvedRevision: resolution.revision.revision,
        baseRevision: resolution.revision.baseRevision ?? undefined,
        checkpointJson: JSON.stringify({ phase: "started", target: resolution.revision } satisfies ImReviewCheckpoint),
        now,
      });
    }

    await this.dispatchExecution(claim, config, signal, permitHeld, undefined);
  }

  /** Interrupted `running`/`publishing` request recovery (R14/R15). */
  private async recoverInterrupted(claim: ClaimedImReviewRequest, config: AppConfig, signal: AbortSignal, permitHeld: boolean): Promise<void> {
    const request = claim.request;
    const { fence } = claim;
    const now = this.options.now();
    const policy = retryPolicy(config);
    const attempts = parseAttempts(request);

    if (request.state === "publishing") {
      const resume = readImReviewCheckpoint(request);
      if (resume === undefined) {
        // Publication may have started without any provable receipt: keep the
        // uncertainty visible and release the target; never blind-resend.
        await finishImReviewRequest(this.options.store, {
          requestId: request.requestId, fence, state: "publication_unknown", errorCode: "im.interrupted",
          notifications: [buildTerminalNotification(request, "publication_unknown", "im.interrupted")].filter((value): value is NonNullable<typeof value> => value !== undefined),
          now,
        });
        return;
      }
      const publicationAttempts = (attempts.publication ?? 0) + 1;
      const attemptsByPhaseJson = JSON.stringify({ ...attempts, publication: publicationAttempts });
      if (publicationAttempts > policy.attempts) {
        await finishImReviewRequest(this.options.store, {
          requestId: request.requestId, fence, state: "publication_unknown", errorCode: "im.publication_attempts_exhausted",
          notifications: [buildTerminalNotification(request, "publication_unknown", "im.publication_attempts_exhausted")].filter((value): value is NonNullable<typeof value> => value !== undefined),
          now,
        });
        return;
      }
      // Persist the consumed attempt so a crash loop cannot retry unbounded.
      if (!await updateImReviewRequest(this.options.store, { requestId: request.requestId, fence, attemptsByPhaseJson, now })) return;
      await this.dispatchExecution(claim, config, signal, permitHeld, resume);
      return;
    }

    // `running`: the analysis crashed mid-flight. No remote write can have
    // started (publication transitions the row to `publishing` first), so a
    // bounded re-analysis is safe; the due time persists and is not re-sampled.
    const analysisAttempts = (attempts.analysis ?? 0) + 1;
    const attemptsByPhaseJson = JSON.stringify({ ...attempts, analysis: analysisAttempts });
    if (analysisAttempts > policy.attempts) {
      await finishImReviewRequest(this.options.store, {
        requestId: request.requestId, fence, state: "failed", errorCode: "im.analysis_attempts_exhausted",
        notifications: [buildTerminalNotification(request, "failed", "im.analysis_attempts_exhausted")].filter((value): value is NonNullable<typeof value> => value !== undefined),
        now,
      });
      return;
    }
    const nextAttemptAt = new Date(now.getTime() + computeBackoffDelay(analysisAttempts, policy.backoff));
    await updateImReviewRequest(this.options.store, {
      requestId: request.requestId, fence, state: "retry_wait", resumePhase: "analysis_retry",
      attemptsByPhaseJson, nextAttemptAt, releaseLease: true, now,
    });
  }

  /** prepareDispatch → queue handoff → fenced execution (fresh or resumed). */
  private async dispatchExecution(claim: ClaimedImReviewRequest, config: AppConfig, signal: AbortSignal, permitHeld: boolean, resume: ImReviewResume | undefined): Promise<void> {
    const request = claim.request;
    const now = this.options.now();
    const dispatchSeq = await prepareImDispatch(this.options.store, request.requestId, claim.fence, now);
    if (dispatchSeq === undefined) {
      return; // lost ownership
    }

    await this.options.dispatch({
      jobId: imReviewJobId(request.requestId, dispatchSeq),
      requestId: request.requestId,
      dispatchSeq,
      workspaceId: request.workspaceId,
      triggerName: request.sourceTrigger,
      configSnapshotId: request.configSnapshotId,
      permitHeld,
      execute: () => this.execute(request.requestId, config, dispatchSeq, claim.fence, signal, resume),
    });
  }

  private async execute(requestId: string, config: AppConfig, dispatchSeq: number, fence: number, signal: AbortSignal, resume: ImReviewResume | undefined): Promise<void> {
    const request = await findImReviewRequest(this.options.store, this.options.namespace, requestId);
    if (request === undefined || request.fence !== fence || request.dispatchSeq !== dispatchSeq) return;
    const now = this.options.now();

    const event = createReviewEvent({
      triggerName: request.sourceTrigger,
      provider: "manual",
      workspaceId: request.workspaceId,
      targetKind: "commit",
      repoRef: request.repoRef,
      headSha: request.resolvedRevision ?? request.requestedRevision,
      baseSha: request.baseRevision ?? undefined,
      author: readResolvedTarget(request)?.author ?? {},
      reason: "im:command",
      requestOrigin: {
        kind: "im_command",
        requestId: request.requestId,
        connectionIdentity: request.connectionIdentity,
        requestedBy: { type: request.requestedByType as "wecom_userid" | "wecom_encrypted_userid" | "feishu_open_id", id: request.requestedById },
      },
    });

    // A fresh analysis transitions the row to `running`; a resumed publication
    // keeps `publishing` (set by the checkpoint write) so the recovery
    // classifier never mistakes a replay for a new analysis.
    if (resume === undefined && !await updateImReviewRequest(this.options.store, {
      requestId: request.requestId, fence, state: "running", now,
    })) return;

    const hooks: ImReviewExecutionHooks = {
      saveCheckpoint: async checkpoint => {
        const target = readResolvedTarget(request);
        const json = JSON.stringify({ ...checkpoint, ...(target !== undefined ? { target } : {}) });
        if (Buffer.byteLength(json, "utf8") > CHECKPOINT_MAX_BYTES) {
          // Keep the last durable payload/journal. Replacing it with a phase
          // marker would lose proof of writes already accepted remotely.
          console.warn(JSON.stringify({ msg: "im_checkpoint_oversized", requestId: request.requestId }));
          return "oversized";
        }
        const accepted = await updateImReviewRequest(this.options.store, {
          requestId: request.requestId, fence, state: "publishing", resumePhase: checkpoint.phase, checkpointJson: json, now: this.options.now(),
        });
        return accepted;
      },
    };

    const result = await this.options.executeReview({ event, config, request, signal, resume, hooks });
    signal.throwIfAborted();
    const terminalNotification = buildTerminalNotification(request, result.state, result.errorCode);

    await finishImReviewRequest(this.options.store, {
      requestId: request.requestId,
      fence,
      state: result.state,
      errorCode: result.errorCode,
      ...(terminalNotification !== undefined ? { notifications: [terminalNotification] } : {}),
      now: this.options.now(),
    });
  }
}

/**
 * Terminal notification for the requesting conversation (IM-16, O09): the
 * destination is the request's connection; the compact receipt carries the
 * platform conversation plus the result summary. Notification delivery never
 * re-runs the review — the request row is already terminal here.
 */
function buildTerminalNotification(
  request: { readonly requestId: string; readonly connectionIdentity: string; readonly configVersionJson: string; readonly conversationJson: string; readonly requestedByType: string; readonly requestedById: string; readonly repoRef: string; readonly requestedRevision: string; readonly resolvedRevision: string | null },
  state: string,
  errorCode: string | undefined,
  operationKind: "review_terminal" | "review_cancelled" = "review_terminal",
): { readonly operationId: string; readonly destinationIdentity: string; readonly operationKind: string; readonly payloadDigest: string; readonly compactReceipt: string } | undefined {
  let connectionName = "";
  try {
    const version = JSON.parse(request.configVersionJson) as { connectionName?: unknown };
    if (typeof version.connectionName === "string") connectionName = version.connectionName;
  } catch { /* legacy rows may not contain structured version metadata */ }
  if (connectionName === "" && !request.connectionIdentity.startsWith("{") && !request.connectionIdentity.startsWith("[")) {
    connectionName = request.connectionIdentity.split(":").pop() ?? "";
  }
  if (connectionName === "") return undefined;
  const receipt = JSON.stringify({
    connectionName,
    conversation: request.conversationJson,
    actor: { type: request.requestedByType, id: request.requestedById },
    requestId: request.requestId,
    state,
    ...(errorCode !== undefined ? { errorCode } : {}),
    repoRef: request.repoRef,
    revision: request.resolvedRevision ?? request.requestedRevision,
  });
  return {
    operationId: `imn-${request.requestId}`,
    destinationIdentity: connectionName,
    operationKind,
    payloadDigest: `${state}:${request.requestId}`,
    compactReceipt: receipt,
  };
}

/** Notification for an operator-cancelled request (same pipeline, cancelled kind). */
export function buildCancelledNotification(
  request: Parameters<typeof buildTerminalNotification>[0],
): ReturnType<typeof buildTerminalNotification> {
  return buildTerminalNotification(request, "rejected", "im.cancelled_by_user", "review_cancelled");
}
