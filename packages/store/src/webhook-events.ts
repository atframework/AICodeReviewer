import { desc, sql } from "drizzle-orm";

import type { StoreDb } from "./database.js";
import { webhookEvents, type WebhookEventDecision } from "./schema.js";

/**
 * Cap on stored webhook event rows. The dashboard Events panel mirrors the
 * Recent Runs contract (latest 100 entries, paged 20 per page on the client),
 * so older rows are pruned on every insert.
 */
export const WEBHOOK_EVENTS_RETENTION_LIMIT = 100;

export interface WebhookEventInsert {
  receivedAt?: Date;
  provider?: string | null;
  eventName?: string | null;
  workspaceId?: string | null;
  triggerName?: string | null;
  repoRef?: string | null;
  targetKind?: string | null;
  targetUrl?: string | null;
  branch?: string | null;
  decision: WebhookEventDecision;
  reason?: string | null;
  /** JSON-serializable extra context (matched labels, resume instant, receipt id). */
  detail?: unknown;
}

export interface RecentWebhookEvent {
  id: number;
  receivedAt: Date;
  provider: string | null;
  eventName: string | null;
  workspaceId: string | null;
  triggerName: string | null;
  repoRef: string | null;
  targetKind: string | null;
  targetUrl: string | null;
  branch: string | null;
  decision: string;
  reason: string | null;
  /** Parsed JSON detail; null when absent or not valid JSON. */
  detail: unknown;
}

export function insertWebhookEvent(store: StoreDb, event: WebhookEventInsert): void {
  store.db
    .insert(webhookEvents)
    .values({
      receivedAt: event.receivedAt ?? new Date(),
      provider: event.provider ?? null,
      eventName: event.eventName ?? null,
      workspaceId: event.workspaceId ?? null,
      triggerName: event.triggerName ?? null,
      repoRef: event.repoRef ?? null,
      targetKind: event.targetKind ?? null,
      targetUrl: event.targetUrl ?? null,
      branch: event.branch ?? null,
      decision: event.decision,
      reason: event.reason ?? null,
      detail: event.detail === undefined ? null : JSON.stringify(event.detail),
    })
    .run();

  pruneWebhookEvents(store);
}

export function pruneWebhookEvents(
  store: StoreDb,
  keep: number = WEBHOOK_EVENTS_RETENTION_LIMIT,
): number {
  const result = store.db
    .delete(webhookEvents)
    .where(
      sql`${webhookEvents.id} NOT IN (SELECT id FROM webhook_events ORDER BY id DESC LIMIT ${keep})`,
    )
    .run();
  return Number(result.changes);
}

export function getRecentWebhookEvents(store: StoreDb, limit: number): RecentWebhookEvent[] {
  const rows = store.db
    .select()
    .from(webhookEvents)
    .orderBy(desc(webhookEvents.id))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    receivedAt: row.receivedAt,
    provider: row.provider,
    eventName: row.eventName,
    workspaceId: row.workspaceId,
    triggerName: row.triggerName,
    repoRef: row.repoRef,
    targetKind: row.targetKind,
    targetUrl: row.targetUrl,
    branch: row.branch,
    decision: row.decision,
    reason: row.reason,
    detail: parseDetail(row.detail),
  }));
}

function parseDetail(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
