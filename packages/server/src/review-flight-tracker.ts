import type {
  ReviewEvent,
  ReviewProvider,
} from "@aicr/core";

import type {
  IssueTriageRuntimeOptions,
  ServerReviewOrchestrationOptions,
  ServerReviewPreparationOptions,
} from "./index.js";

export interface FlightContext {
  readonly provider: ReviewProvider;
  readonly eventName: string;
  readonly decoded: unknown;
  readonly reviewEvent: ReviewEvent;
  readonly reviewPreparationOptions: ServerReviewPreparationOptions | undefined;
  readonly reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined;
  readonly issueTriageOptions: IssueTriageRuntimeOptions | undefined;
}

interface FlightState {
  running: boolean;
  pending: FlightContext | null;
}

const flights = new Map<string, FlightState>();

function makeFlightKey(reviewEvent: ReviewEvent): string {
  return `${reviewEvent.repoRef}:${reviewEvent.url ?? reviewEvent.headSha ?? "unknown"}`;
}

function isCommentReviewTrigger(reviewEvent: ReviewEvent): boolean {
  return reviewEvent.reason?.endsWith(":comment_review") ?? false;
}

export function acquireFlight(context: FlightContext): "run" | "defer" | "coalesced" {
  if (!isCommentReviewTrigger(context.reviewEvent)) {
    return "run";
  }

  const key = makeFlightKey(context.reviewEvent);
  const state = flights.get(key);

  if (!state) {
    flights.set(key, { running: true, pending: null });
    return "run";
  }

  if (!state.running) {
    state.running = true;
    state.pending = null;
    return "run";
  }

  const isNewPending = state.pending === null;
  state.pending = context;
  return isNewPending ? "defer" : "coalesced";
}

export function releaseFlight(
  reviewEvent: ReviewEvent,
): { hasPending: boolean; pendingContext: FlightContext | null } {
  const key = makeFlightKey(reviewEvent);
  const state = flights.get(key);

  if (!state) {
    return { hasPending: false, pendingContext: null };
  }

  state.running = false;

  if (state.pending) {
    const result = { hasPending: true, pendingContext: state.pending };
    state.pending = null;
    return result;
  }

  flights.delete(key);
  return { hasPending: false, pendingContext: null };
}
