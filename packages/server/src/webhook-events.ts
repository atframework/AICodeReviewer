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
 * Best-effort append to the webhook event log backing the dashboard Events
 * panel. Never throws into the webhook path and never blocks a decision;
 * failures surface as a warning log only.
 */
export function recordWebhookEvent(store: StoreDb | undefined, entry: WebhookEventInsert): void {
  if (!store) return;
  try {
    insertWebhookEvent(store, entry);
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      msg: "failed to record webhook event",
      provider: entry.provider ?? undefined,
      eventName: entry.eventName ?? undefined,
      decision: entry.decision,
      reason: entry.reason ?? undefined,
      error: toErrorMessage(error),
    }));
  }
}
