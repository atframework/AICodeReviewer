import type { ReviewEvent, ReviewProvider } from "@aicr/core";

export interface DeduplicationTarget {
  readonly provider: ReviewProvider;
  readonly eventName: string;
  readonly decoded: unknown;
  readonly reviewEvent: ReviewEvent;
}

export interface ReviewDeduplicator {
  /** Compute a stable deduplication key for a review event. */
  computeKey(reviewEvent: ReviewEvent): string;

  /**
   * Attempt to schedule a review.
   * - If no review for the same target is running, returns `true` and marks it as running.
   * - If a review is already running, stores the latest target as pending and returns `false`.
   */
  trySchedule(reviewEvent: ReviewEvent): boolean;

  /** Mark a review as completed and return any pending re-review target, if one exists. */
  markCompleted(reviewEvent: ReviewEvent): DeduplicationTarget | undefined;

  /** Check whether a target currently has a running review. */
  isRunning(reviewEvent: ReviewEvent): boolean;

  /** Store a pending re-review target, overwriting any existing pending target for the same key. */
  setPending(target: DeduplicationTarget): void;
}

function buildDedupKey(reviewEvent: ReviewEvent): string {
  const targetId = reviewEvent.branch ?? reviewEvent.url ?? reviewEvent.headSha ?? reviewEvent.baseSha ?? "unknown";
  return JSON.stringify([
    reviewEvent.triggerName,
    reviewEvent.workspaceId,
    reviewEvent.provider,
    reviewEvent.repoRef,
    reviewEvent.targetKind,
    targetId,
  ]);
}

export function createReviewDeduplicator(): ReviewDeduplicator {
  const running = new Set<string>();
  const pending = new Map<string, DeduplicationTarget>();

  return {
    computeKey(reviewEvent: ReviewEvent): string {
      return buildDedupKey(reviewEvent);
    },

    trySchedule(reviewEvent: ReviewEvent): boolean {
      const key = buildDedupKey(reviewEvent);
      if (running.has(key)) {
        return false;
      }
      running.add(key);
      return true;
    },

    markCompleted(reviewEvent: ReviewEvent): DeduplicationTarget | undefined {
      const key = buildDedupKey(reviewEvent);
      running.delete(key);
      const target = pending.get(key);
      if (target) {
        pending.delete(key);
      }
      return target;
    },

    isRunning(reviewEvent: ReviewEvent): boolean {
      return running.has(buildDedupKey(reviewEvent));
    },

    setPending(target: DeduplicationTarget): void {
      pending.set(buildDedupKey(target.reviewEvent), target);
    },
  };
}
