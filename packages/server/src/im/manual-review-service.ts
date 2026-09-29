import type { AppConfig } from "@aicr/core";
import { createReviewEvent, type ReviewEvent } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import {
  claimDueImReviewRequests,
  finishImReviewRequest,
  findImReviewRequest,
  prepareImDispatch,
  updateImReviewRequest,
  imReviewJobId,
  type ClaimedImReviewRequest,
  type ImTerminalState,
} from "@aicr/store";
import type { VcsAdapter } from "@aicr/vcs";

import { resolveImRevision } from "./revision-resolver.js";

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
  readonly getConfig: () => Promise<AppConfig> | AppConfig;
  readonly createAdapter: (config: AppConfig, triggerName: string) => VcsAdapter | undefined;
  readonly enqueueReview: (jobId: string, run: () => Promise<void>) => Promise<void>;
  readonly executeReview: (event: ReviewEvent, config: AppConfig) => Promise<{ readonly state: ImTerminalState; readonly errorCode?: string }>;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly batchLimit?: number;
}

export class ManualReviewService {
  private readonly options: Required<ManualReviewWorkerOptions>;
  private running = false;

  constructor(options: ManualReviewWorkerOptions) {
    this.options = {
      ...options,
      now: options.now ?? (() => new Date()),
      leaseMs: options.leaseMs ?? 60_000,
      batchLimit: options.batchLimit ?? 100,
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
      const now = this.options.now();
      const claimed = await claimDueImReviewRequests(this.options.store, {
        namespace: this.options.namespace,
        now,
        leaseMs: this.options.leaseMs,
        owner: `im-worker-${Date.now()}`,
        limit: this.options.batchLimit,
      });
      for (const claim of claimed) {
        await this.processClaim(claim);
      }
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  private async processClaim(claim: ClaimedImReviewRequest): Promise<void> {
    const request = claim.request;
    const now = this.options.now();
    const { fence } = claim;

    // Terminal-state guard: a request that reached a terminal state between
    // the claim scan and this call must not be resurrected.
    if (["succeeded", "partial", "publication_unknown", "failed", "rejected"].includes(request.state)) {
      return;
    }

    const config = await this.options.getConfig();

    // validating: resolve the revision through the trusted adapter.
    if (request.state === "accepted") {
      const adapter = this.options.createAdapter(config, request.sourceTrigger);
      if (adapter === undefined) {
        await updateImReviewRequest(this.options.store, {
          requestId: request.requestId, fence, state: "rejected", errorCode: "im.invalid_revision",
          now,
        });
        await finishImReviewRequest(this.options.store, {
          requestId: request.requestId, fence, state: "rejected", errorCode: "im.invalid_revision", now,
        });
        return;
      }

      await updateImReviewRequest(this.options.store, {
        requestId: request.requestId, fence, state: "validating", now,
      });
      const resolution = await resolveImRevision(adapter, request.requestedRevision);
      if (resolution.kind === "rejected") {
        await finishImReviewRequest(this.options.store, {
          requestId: request.requestId, fence, state: "rejected", errorCode: `im.${resolution.reason}`, now,
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
      await this.execute(request.requestId, config, dispatchSeq);
    });
  }

  private async execute(requestId: string, config: AppConfig, dispatchSeq: number): Promise<void> {
    const request = await findImReviewRequest(this.options.store, this.options.namespace, requestId);
    if (request === undefined) return;
    const now = this.options.now();

    // Renew the lease under the dispatch-sequence fence; a zero-row update
    // means the lease was lost to a replica and this execution stops.
    const claimed = await claimDueImReviewRequests(this.options.store, {
      namespace: this.options.namespace,
      now,
      leaseMs: this.options.leaseMs,
      owner: `im-exec-${requestId}-${dispatchSeq}`,
      limit: 1,
    });
    // The scan owner's lease may still be active; use the current request
    // row's fence (which processClaim already incremented) directly.
    const fence = request.fence;
    void claimed;

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

    await updateImReviewRequest(this.options.store, {
      requestId: request.requestId, fence, state: "running", now,
    });

    const result = await this.options.executeReview(event, config);

    await finishImReviewRequest(this.options.store, {
      requestId: request.requestId,
      fence,
      state: result.state,
      errorCode: result.errorCode,
      now,
    });
  }
}
