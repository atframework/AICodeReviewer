import type { ReviewDeferralRow, StoreDb } from "@aicr/store";
import {
  claimReviewDeferral,
  completeReviewDeferral,
  deleteReviewDeferral,
  getReviewDeferral,
  listPendingReviewDeferrals,
  resetClaimedReviewDeferrals,
  releaseReviewDeferral,
  upsertReviewDeferral,
} from "@aicr/store";
import { createReviewEvent, type ReviewEvent, type ReviewProvider } from "@aicr/core";

/** Node setTimeout clamps delays above the signed 32-bit range; stay below. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface DeferredTriggerTarget {
  readonly provider: ReviewProvider;
  readonly eventName: string;
  readonly decoded: unknown;
  readonly reviewEvent: ReviewEvent;
}

export type DeferralResumeHandler = (target: DeferredTriggerTarget) => void;

export interface ReviewDeferralManagerOptions {
  /**
   * Observability store backing the persistent deferral table. When omitted
   * the manager degrades to process-memory timers only (the pre-persistence
   * behavior: a restart drops pending deferrals).
   */
  readonly store?: StoreDb;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Coalescing key for one deferral target. Mirrors the review deduplicator's
 * key shape so a pending deferral, a fresh event, and an in-flight run for
 * the same PR branch all agree on identity.
 */
export function computeDeferralKey(reviewEvent: ReviewEvent): string {
  const targetId =
    reviewEvent.branch ?? reviewEvent.url ?? reviewEvent.headSha ?? reviewEvent.baseSha ?? "unknown";
  return JSON.stringify([
    reviewEvent.triggerName,
    reviewEvent.workspaceId,
    reviewEvent.provider,
    reviewEvent.repoRef,
    reviewEvent.targetKind,
    targetId,
  ]);
}

/**
 * Execution-window deferral registry for the async trigger path. `defer`
 * persists (or memorizes) the latest event per target and arms one timer;
 * when the timer fires the manager hands the target back through
 * `resumeHandler`, which re-enters normal scheduling — including the window
 * clamp, so a window that closed during a process pause simply re-defers.
 * Persistence semantics:
 * - upsert replaces the stored envelope but never moves `not_before` earlier;
 * - resume claims atomically then acknowledges the handoff — once execution starts,
 *   the run lifecycle (review_runs) owns the outcome, retries included;
 * - startup recovery resets claimed rows to pending and re-arms every timer.
 *
 * The store contract is async (sqlite or postgres). Store operations run
 * through one serialized queue so their relative order matches the previous
 * synchronous call order; in-memory bookkeeping (deadlines, timers, memory
 * fallback targets) still updates synchronously, and a generation token per
 * key drops stale async continuations superseded by cancel/defer. On
 * postgres the upsert itself joins the queue — concurrent same-key upserts
 * race the not-before clamp — while on sqlite the upsert body still issues
 * synchronously (the visibility contract below) and only its continuation
 * queues.
 */
export class ReviewDeferralManager {
  /** Re-entry point wired by the server app once route options are known. */
  resumeHandler: DeferralResumeHandler | undefined;

  private readonly store: StoreDb | undefined;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly memoryTargets = new Map<string, DeferredTriggerTarget>();
  private readonly deadlines = new Map<string, number>();
  private readonly generations = new Map<string, symbol>();
  private storeQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: ReviewDeferralManagerOptions) {
    this.store = options.store;
  }

  /** Serializes async store operations to preserve the previous sync ordering. */
  private enqueue(op: () => Promise<void>): void {
    const result = this.storeQueue.then(op, op);
    this.storeQueue = result.catch(() => {});
  }

  /** Persist (or memorize) a deferral and arm its wake-up timer. */
  defer(target: DeferredTriggerTarget, notBeforeMs: number): void {
    if (this.stopped) return;
    const key = computeDeferralKey(target.reviewEvent);
    notBeforeMs = Math.max(notBeforeMs, this.deadlines.get(key) ?? 0);
    const generation = Symbol(key);
    this.generations.set(key, generation);
    this.deadlines.set(key, notBeforeMs);
    if (this.store) {
      const store = this.store;
      const issueUpsert = (): Promise<ReviewDeferralRow> =>
        upsertReviewDeferral(store, {
          dedupKey: key,
          workspaceId: target.reviewEvent.workspaceId,
          provider: target.provider,
          eventName: target.eventName,
          reviewEvent: JSON.stringify(target.reviewEvent),
          payload: safeSerialize(target.decoded),
          notBefore: new Date(notBeforeMs),
        });
      const settle = async (persisted: Promise<ReviewDeferralRow>): Promise<void> => {
        try {
          const row = await persisted;
          if (this.generations.get(key) === generation) {
            this.memoryTargets.delete(key);
            this.armTimer(key, row.notBefore.getTime());
          }
        } catch (error) {
          // Persistence failure must not lose the event: fall back to memory.
          console.warn(JSON.stringify({
            level: "warn",
            msg: "failed to persist review deferral, deferring in memory only",
            workspaceId: target.reviewEvent.workspaceId,
            repoRef: target.reviewEvent.repoRef,
            error: toErrorMessage(error),
          }));
          if (this.generations.get(key) === generation) {
            this.memoryTargets.set(key, target);
            this.armTimer(key, notBeforeMs);
          }
        }
      };
      if (store.kind === "postgres") {
        // PG: the upsert joins the serialized queue so consecutive defer()
        // calls for one key observe each other's row — issued concurrently,
        // they race the not-before clamp and can resurrect an earlier wake.
        this.enqueue(() => settle(issueUpsert()));
      } else {
        // Issue the upsert immediately: on the sqlite backend the body
        // executes synchronously, so a defer() call leaves a visible row just
        // like the pre-async store contract (raw-sql consumers/tests rely on
        // it). Only the continuation joins the queue.
        const persisted = issueUpsert();
        this.enqueue(() => settle(persisted));
      }
    } else {
      this.memoryTargets.set(key, target);
      this.armTimer(key, notBeforeMs);
    }
  }

  /**
   * Drop a pending deferral because a fresh in-window event for the same
   * target supersedes it. The caller executes the fresh event instead.
   */
  cancel(reviewEvent: ReviewEvent): void {
    const key = computeDeferralKey(reviewEvent);
    this.clearTimer(key);
    this.generations.delete(key);
    this.memoryTargets.delete(key);
    this.deadlines.delete(key);
    if (this.store) {
      const store = this.store;
      const settle = async (deleted: Promise<void>): Promise<void> => {
        try {
          await deleted;
        } catch (error) {
          console.warn(JSON.stringify({
            level: "warn",
            msg: "failed to delete superseded review deferral",
            workspaceId: reviewEvent.workspaceId,
            repoRef: reviewEvent.repoRef,
            error: toErrorMessage(error),
          }));
        }
      };
      if (store.kind === "sqlite") {
        // Match synchronous SQLite upserts: a later defer must survive this
        // cancellation even when queued continuations have not run yet.
        const deleted = deleteReviewDeferral(store, key);
        this.enqueue(() => settle(deleted));
      } else {
        this.enqueue(() => settle(deleteReviewDeferral(store, key)));
      }
    }
  }

  /** Startup recovery: un-stick claimed rows and re-arm every pending timer. */
  async recover(): Promise<void> {
    if (!this.store || this.stopped) return;
    try {
      const reset = await resetClaimedReviewDeferrals(this.store);
      const pending = await listPendingReviewDeferrals(this.store);
      if (reset > 0 || pending.length > 0) {
        console.info(JSON.stringify({
          level: "info",
          msg: "recovered review deferrals",
          resetClaimed: reset,
          pending: pending.length,
        }));
      }
      for (const row of pending) {
        this.generations.set(row.dedupKey, Symbol(row.dedupKey));
        this.armTimer(row.dedupKey, row.notBefore.getTime());
      }
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "failed to recover review deferrals",
        error: toErrorMessage(error),
      }));
    }
  }

  /** Clear all armed timers (shutdown). Persisted rows survive for recover(). */
  stop(): void {
    this.stopped = true;
    this.generations.clear();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private armTimer(key: string, notBeforeMs: number): void {
    if (this.stopped) return;
    this.clearTimer(key);
    this.deadlines.set(key, notBeforeMs);
    const delay = Math.min(Math.max(0, notBeforeMs - Date.now()), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.resume(key);
    }, delay);
    // Deferral timers must never hold the process open on their own.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private clearTimer(key: string): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
    }
  }

  private resume(key: string): void {
    if (this.stopped) return;
    this.timers.delete(key);
    const deadline = this.deadlines.get(key) ?? 0;
    if (deadline > Date.now()) {
      this.armTimer(key, deadline);
      return;
    }
    if (!this.resumeHandler) return;
    const handler = this.resumeHandler;
    const generation = this.generations.get(key);
    const current = (): boolean => !this.stopped && this.generations.get(key) === generation;
    this.enqueue(async () => {
      if (!current()) return;
      try {
        const target = await this.takeTarget(key);
        if (!current()) return;
        if (!target) {
          if (!this.timers.has(key)) this.deadlines.delete(key);
          return;
        }
        handler(target);
        // A cleanup failure after handoff must not launch a second review.
        try {
          if (this.store) await completeReviewDeferral(this.store, key);
        } catch (error) {
          console.warn(JSON.stringify({ level: "warn", msg: "failed to acknowledge review deferral", error: toErrorMessage(error) }));
        }
        if (!this.timers.has(key)) {
          this.memoryTargets.delete(key);
          this.deadlines.delete(key);
        }
      } catch (error) {
        if (!current()) return;
        console.warn(JSON.stringify({ level: "warn", msg: "failed to resume review deferral, retrying", error: toErrorMessage(error) }));
        try {
          if (this.store) await releaseReviewDeferral(this.store, key);
        } catch {
          // Recovery resets claims after a restart; retry the read meanwhile.
        }
        this.armTimer(key, Date.now() + 5000);
      }
    });
  }

  private async takeTarget(key: string): Promise<DeferredTriggerTarget | undefined> {
    // A failed upsert may leave an older database row. The fallback holds
    // the latest envelope and must take precedence over that row.
    const memoryTarget = this.memoryTargets.get(key);
    if (memoryTarget) {
      if (this.store) {
        try {
          await deleteReviewDeferral(this.store, key);
        } catch {
          // Persistence is unavailable; the in-memory handoff can still run.
        }
      }
      return memoryTarget;
    }
    if (!this.store) return undefined;

    const stored = await getReviewDeferral(this.store, key);
    if (stored && stored.notBefore.getTime() > Date.now()) {
      this.armTimer(key, stored.notBefore.getTime());
      return undefined;
    }
    const row = await claimReviewDeferral(this.store, key);
    if (!row) return undefined;

    try {
      const reviewEvent = createReviewEvent(JSON.parse(row.reviewEvent) as ReviewEvent);
      return {
        provider: row.provider as ReviewProvider,
        eventName: row.eventName,
        decoded: row.payload ? (JSON.parse(row.payload) as unknown) : undefined,
        reviewEvent,
      };
    } catch (error) {
      // A corrupt row must not block the queue behind it.
      console.warn(JSON.stringify({
        level: "warn",
        msg: "failed to resume persisted review deferral, dropping row",
        error: toErrorMessage(error),
      }));
      try {
        await deleteReviewDeferral(this.store, key);
      } catch {
        // best effort
      }
      return undefined;
    }
  }
}

function safeSerialize(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
