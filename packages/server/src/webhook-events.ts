import type { StoreDb } from "@aicr/store";
import { insertWebhookEvent, type WebhookEventInsert } from "@aicr/store";
import type { ReviewEvent } from "@aicr/core";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Traceability fields copied from a translated review event. */
export function webhookEventFields(
  reviewEvent: ReviewEvent | undefined,
): Pick<
  WebhookEventInsert,
  "workspaceId" | "triggerName" | "repoRef" | "targetKind" | "targetUrl" | "branch"
> {
  if (!reviewEvent) {
    return {};
  }
  return {
    workspaceId: reviewEvent.workspaceId,
    triggerName: reviewEvent.triggerName,
    repoRef: reviewEvent.repoRef,
    targetKind: reviewEvent.targetKind,
    ...(reviewEvent.url ? { targetUrl: reviewEvent.url } : {}),
    ...(reviewEvent.branch ? { branch: reviewEvent.branch } : {}),
  };
}

/**
 * Target identifiers for the Events panel: commit/push events carry the
 * received revision range (the Events table shows the short head SHA), and
 * PR/MR/issue numbers are derived from the target URL client-side.
 */
export function webhookTargetDetail(
  reviewEvent: ReviewEvent | undefined,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  if (!reviewEvent) return { ...(extra ?? {}) };
  return {
    ...(reviewEvent.baseSha ? { baseSha: reviewEvent.baseSha } : {}),
    ...(reviewEvent.headSha ? { headSha: reviewEvent.headSha } : {}),
    ...(extra ?? {}),
  };
}

/**
 * Best-effort append to the webhook event log backing the dashboard Events
 * panel. Never throws into the webhook path and never blocks a decision;
 * failures surface as a warning log only. When `reviewEvent` is supplied the
 * entry's detail gains the received target identifiers (head/base SHA) so
 * the Events panel can show commit revisions.
 */
export function recordWebhookEvent(
  store: StoreDb | undefined,
  entry: WebhookEventInsert,
  reviewEvent?: ReviewEvent,
): void {
  if (!store) return;
  let detail = entry.detail;
  if (reviewEvent !== undefined) {
    const target = webhookTargetDetail(reviewEvent);
    if (entry.detail === undefined || entry.detail === null) {
      detail = target;
    } else if (typeof entry.detail === "object" && !Array.isArray(entry.detail)) {
      detail = { ...target, ...(entry.detail as Record<string, unknown>) };
    }
  }
  const merged: WebhookEventInsert = detail === entry.detail ? entry : { ...entry, detail };
  // Fire-and-forget: the store contract is async, but recording must never
  // block or fail the webhook decision path; failures surface as a warning.
  void insertWebhookEvent(store, merged).catch((error: unknown) => {
    console.warn(JSON.stringify({
      level: "warn",
      msg: "failed to record webhook event",
      provider: entry.provider ?? undefined,
      eventName: entry.eventName ?? undefined,
      decision: entry.decision,
      reason: entry.reason ?? undefined,
      error: toErrorMessage(error),
    }));
  });
}
