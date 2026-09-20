/**
 * PostgreSQL branch of the webhook event log (webhook-events.ts). Same
 * append + retention-cap contract as the sqlite implementation.
 */

import { desc, sql } from "drizzle-orm";

import type { PgStoreDb } from "./database.js";
import { webhookEvents } from "./schema.pg.js";
import { parseWebhookDetail, WEBHOOK_EVENTS_RETENTION_LIMIT } from "./webhook-events.js";
import type { RecentWebhookEvent, WebhookEventInsert } from "./webhook-events.js";

export async function insertWebhookEventPg(store: PgStoreDb, event: WebhookEventInsert): Promise<void> {
  await store.db
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
    });

  await pruneWebhookEventsPg(store);
}

export async function pruneWebhookEventsPg(
  store: PgStoreDb,
  keep: number = WEBHOOK_EVENTS_RETENTION_LIMIT,
): Promise<number> {
  const deleted = await store.db
    .delete(webhookEvents)
    .where(
      sql`${webhookEvents.id} NOT IN (SELECT id FROM webhook_events ORDER BY id DESC LIMIT ${keep})`,
    )
    .returning({ id: webhookEvents.id });
  return deleted.length;
}

export async function getRecentWebhookEventsPg(store: PgStoreDb, limit: number): Promise<RecentWebhookEvent[]> {
  const rows = await store.db
    .select()
    .from(webhookEvents)
    .orderBy(desc(webhookEvents.id))
    .limit(limit);

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

export async function markWebhookEventsTimedOutPg(
  store: PgStoreDb,
  receiptIds: readonly string[],
): Promise<number> {
  if (receiptIds.length === 0) return 0;
  let total = 0;
  for (let offset = 0; offset < receiptIds.length; offset += 100) {
    const chunk = receiptIds.slice(offset, offset + 100);
    const updated = await store.db
      .update(webhookEvents)
      .set({ decision: "timeout", reason: "queued_timeout" })
      .where(
        sql`${webhookEvents.decision} IN ('queued', 'duplicate')
            AND ${webhookEvents.detail} ->> 'receiptId' IN (${sql.join(
          chunk.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      .returning({ id: webhookEvents.id });
    total += updated.length;
  }
  return total;
}
