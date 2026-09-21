import { desc, gte, sql } from "drizzle-orm";
import { historyCutoff } from "@aicr/core";
import { pruneEventHistory, storeHistoryRetention } from "./history-retention.js";

import type { StoreDb } from "./database.js";
import { webhookEvents, type WebhookEventDecision } from "./schema.js";
import {
  getRecentWebhookEventsPg,
  insertWebhookEventPg,
  markWebhookEventsTimedOutPg,
} from "./webhook-events.pg.js";

/**
 * Default count cap; bootstrap supplies the live count and calendar-month age.
 */
export const WEBHOOK_EVENTS_RETENTION_LIMIT = 2000;

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

export async function insertWebhookEvent(store: StoreDb, event: WebhookEventInsert): Promise<void> {
  if (store.kind === "postgres") {
    return insertWebhookEventPg(store, event);
  }
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

  await pruneWebhookEvents(store);
}

export async function pruneWebhookEvents(
  store: StoreDb,
  keep?: number,
  now = Date.now(),
): Promise<number> {
  return pruneEventHistory(store, keep, now);
}

export async function getRecentWebhookEvents(store: StoreDb, limit: number, offset = 0): Promise<RecentWebhookEvent[]> {
  if (store.kind === "postgres") {
    return getRecentWebhookEventsPg(store, limit, offset);
  }
  const policy = storeHistoryRetention(store)?.events;
  if (policy) limit = Math.max(0, Math.min(limit, policy.max_count - offset));
  const rows = store.db
    .select()
    .from(webhookEvents)
    .where(policy ? gte(webhookEvents.receivedAt, new Date(historyCutoff(policy))) : undefined)
    .orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id))
    .limit(limit)
    .offset(offset)
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
    detail: parseWebhookDetail(row.detail),
  }));
}

export function parseWebhookDetail(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Mirror the auto-commit queue-timeout sweep onto the event log: queued (or
 * duplicate) events whose receipt timed out flip to the terminal `timeout`
 * decision so the Events panel reflects reality instead of showing stale
 * queue entries forever. `routingIds` covers routing-stage intake events,
 * whose detail carries `routingId` instead of a formal `receiptId`. Chunked
 * to keep the IN list bounded.
 */
export async function markWebhookEventsTimedOut(
  store: StoreDb,
  receiptIds: readonly string[],
  routingIds: readonly string[] = [],
): Promise<number> {
  if (receiptIds.length === 0 && routingIds.length === 0) return 0;
  if (store.kind === "postgres") {
    return markWebhookEventsTimedOutPg(store, receiptIds, routingIds);
  }
  let total = 0;
  for (let offset = 0; offset < receiptIds.length; offset += 100) {
    const chunk = receiptIds.slice(offset, offset + 100);
    const result = store.db.run(sql`UPDATE webhook_events SET decision = 'timeout', reason = 'queued_timeout'
      WHERE decision IN ('queued', 'duplicate')
        AND json_extract(detail, '$.receiptId') IN (${sql.join(
          chunk.map((id) => sql`${id}`),
          sql`, `,
        )})`);
    total += Number(result.changes);
  }
  for (let offset = 0; offset < routingIds.length; offset += 100) {
    const chunk = routingIds.slice(offset, offset + 100);
    const result = store.db.run(sql`UPDATE webhook_events SET decision = 'timeout', reason = 'queued_timeout'
      WHERE decision IN ('queued', 'duplicate')
        AND json_extract(detail, '$.routingId') IN (${sql.join(
          chunk.map((id) => sql`${id}`),
          sql`, `,
        )})`);
    total += Number(result.changes);
  }
  return total;
}
