import { randomUUID } from "node:crypto";

import type { AppConfig } from "@aicr/core";
import { createReviewEvent, resolveAutoCommitPolicy, type ReviewEvent } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import {
  claimDueImReviewRequests,
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

import { resolveImRevision } from "./revision-resolver.js";
import type { ReviewOrchestrationResult } from "../review-orchestrator.js";

export function classifyImReviewResult(result: Pick<ReviewOrchestrationResult, "status" | "skipReason" | "dispatchResults">): {
  readonly state: ImTerminalState;
  readonly errorCode?: string;
} {
  if (result.dispatchResults.some(entry => entry.status === "buffered")) {
    return { state: "publication_unknown", errorCode: "im.publication_buffered" };
  }
  if (result.dispatchResults.some(entry => entry.status === "failed")) {
    return result.dispatchResults.some(entry => entry.status === "published")
      ? { state: "partial", errorCode: "im.publication_partial" }
      : { state: "failed", errorCode: "im.publication_failed" };
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

/**
 * IM-14 request worker (design §7.3, contracts §5): claims due requests,
 * validates the fixed revision through the trusted VCS adapter, builds a
 * ReviewEvent with the im_command requestOrigin, dispatches through the
 * queue, and writes terminal state + active-target release atomically.
 *
 * The request table owns retry/attempt truth; the queue is only a wake-up.
 * maxAttempts:1 on the queue job means a lost wake-up is recovered by the
 * due scan, never by re-running the logical request.
 */

export interface ManualReviewWorkerOptions {
  readonly store: StoreDb;
  readonly namespace: string;
  readonly getConfig: (snapshotId: string) => Promise<AppConfig> | AppConfig;
  readonly createAdapter: (config: AppConfig, request: ImReviewRequestRow) => Promise<VcsAdapter | undefined> | VcsAdapter | undefined;
  readonly enqueueReview: (jobId: string, run: () => Promise<void>, workspaceId: string) => Promise<void>;
  readonly executeReview: (event: ReviewEvent, config: AppConfig, request: ImReviewRequestRow, signal: AbortSignal) => Promise<{ readonly state: ImTerminalState; readonly errorCode?: string }>;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly batchLimit?: number;
}

export class ManualReviewService {
  private readonly options: Required<ManualReviewWorkerOptions>;
  private running = false;
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
  async scan(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const configs = new Map<string, AppConfig>();
      await this.expireQueued(configs);
      const now = this.options.now();
      const claimed = await claimDueImReviewRequests(this.options.store, {
        namespace: this.options.namespace,
        now,
        leaseMs: this.options.leaseMs,
        owner: `im-worker-${randomUUID()}`,
        limit: this.options.batchLimit,
      });
      for (const claim of claimed) {
        const controller = new AbortController();
        this.cancelAborts.set(claim.request.requestId, controller);
        const renew = async () => {
          try {
            const valid = await renewImReviewLease(this.options.store, {
              requestId: claim.request.requestId, fence: claim.fence, owner: claim.request.leaseOwner!,
              now: this.options.now(), leaseMs: this.options.leaseMs,
            });
            if (!valid) controller.abort();
          } catch { controller.abort(); }
        };
        const timer = setInterval(() => { void renew(); }, Math.max(1, Math.floor(this.options.leaseMs / 3)));
        timer.unref();
        try {
          await this.processClaim(claim, controller.signal, configs);
        } catch (error) {
          console.warn(JSON.stringify({ msg: "im_review_failed", requestId: claim.request.requestId, error: String(error) }));
          if (!controller.signal.aborted) {
            await finishImReviewRequest(this.options.store, {
              requestId: claim.request.requestId, fence: claim.fence, state: "failed", errorCode: "im.execution_failed",
              notifications: [buildTerminalNotification(claim.request, "failed", "im.execution_failed")].filter((value): value is NonNullable<typeof value> => value !== undefined),
              now: this.options.now(),
            });
          }
        } finally {
          clearInterval(timer);
          this.cancelAborts.delete(claim.request.requestId);
        }
      }
      return claimed.length;
    } finally {
      this.running = false;
    }
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

  private async processClaim(claim: ClaimedImReviewRequest, signal: AbortSignal, configs: Map<string, AppConfig>): Promise<void> {
    const request = claim.request;
    const now = this.options.now();
    const { fence } = claim;

    // Terminal-state guard: a request that reached a terminal state between
    // the claim scan and this call must not be resurrected.
    if (["succeeded", "partial", "publication_unknown", "failed", "rejected"].includes(request.state)) {
      return;
    }

    const config = configs.get(request.configSnapshotId) ?? await this.options.getConfig(request.configSnapshotId);

    // An interrupted published run cannot be replayed without its remote
    // publication journal. Keep the uncertainty visible and release the target.
    if (request.state === "running" || request.state === "publishing") {
      await finishImReviewRequest(this.options.store, {
        requestId: request.requestId, fence, state: "publication_unknown", errorCode: "im.interrupted",
        notifications: [buildTerminalNotification(request, "publication_unknown", "im.interrupted")].filter((value): value is NonNullable<typeof value> => value !== undefined),
        now,
      });
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
        now,
      });
    }

    // queued→running→publishing→terminal: dispatch through the queue for
    // shared concurrency control, then execute the review pipeline.
    const dispatchSeq = await prepareImDispatch(this.options.store, request.requestId, fence, now);
    if (dispatchSeq === undefined) {
      return; // lost ownership
    }

    const jobId = imReviewJobId(request.requestId, dispatchSeq);
    await this.options.enqueueReview(jobId, async () => {
      signal.throwIfAborted();
      await this.execute(request.requestId, config, dispatchSeq, fence, signal);
    }, request.workspaceId);
  }

  private async execute(requestId: string, config: AppConfig, dispatchSeq: number, fence: number, signal: AbortSignal): Promise<void> {
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
      author: {},
      reason: "im:command",
      requestOrigin: {
        kind: "im_command",
        requestId: request.requestId,
        connectionIdentity: request.connectionIdentity,
        requestedBy: { type: request.requestedByType as "wecom_userid" | "wecom_encrypted_userid" | "feishu_open_id", id: request.requestedById },
      },
    });

    if (!await updateImReviewRequest(this.options.store, {
      requestId: request.requestId, fence, state: "running", now,
    })) return;

    const result = await this.options.executeReview(event, config, request, signal);
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
