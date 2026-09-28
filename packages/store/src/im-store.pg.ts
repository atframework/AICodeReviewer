/**
 * PostgreSQL branch of the IM store (im-store.ts). Same operations; PG-specific
 * pieces: `.for("update")` row locks inside acceptDelivery, RETURNING-based CAS
 * and GREATEST-free set expressions kept in drizzle's portable form.
 */

import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { randomUUID } from "node:crypto";

import type { PgStoreDb } from "./database.js";
import {
  imActions,
  imActiveTargets,
  imInbox,
  imRateLimits,
  imReplyOutbox,
  imReviewRequests,
} from "./schema.pg.js";
import type {
  AcceptImDeliveryInput,
  AcceptImDeliveryOutcome,
  ClaimedImReviewRequest,
  FinishImReviewRequestInput,
  ImActionRecord,
  ImFencedUpdate,
  ImReviewRequestRow,
} from "./im-store.js";
import { normalizeRevision } from "./im-store.js";

export async function findImReviewRequestPg(store: PgStoreDb, namespace: string, requestId: string): Promise<ImReviewRequestRow | undefined> {
  const rows = await store.db.select().from(imReviewRequests)
    .where(and(eq(imReviewRequests.namespace, namespace), eq(imReviewRequests.requestId, requestId)));
  return rows[0] !== undefined ? toRequestRow(rows[0]) : undefined;
}

export async function listImActiveConfigSnapshotIdsPg(store: PgStoreDb, namespace: string): Promise<string[]> {
  const rows = await store.db.selectDistinct({ snapshotId: imReviewRequests.configSnapshotId })
    .from(imReviewRequests)
    .where(and(
      eq(imReviewRequests.namespace, namespace),
      inArray(imReviewRequests.state, ["accepted", "validating", "queued", "running", "publishing", "retry_wait"]),
    ));
  return rows.map(row => row.snapshotId);
}

export async function getImActionPg(store: PgStoreDb, actionId: string): Promise<ImActionRecord | undefined> {
  const rows = await store.db.select().from(imActions).where(eq(imActions.actionId, actionId));
  return rows[0];
}

export async function deleteExpiredImInboxPg(store: PgStoreDb, namespace: string, before: Date, keepRequestIds: readonly string[]): Promise<number> {
  const rows = await store.db.delete(imInbox).where(and(
    eq(imInbox.namespace, namespace),
    lt(imInbox.receivedAt, before),
    keepRequestIds.length === 0 ? sql`1 = 1` : sql`${imInbox.requestId} IS NULL OR ${imInbox.requestId} NOT IN (${sql.join(keepRequestIds.map(id => sql`${id}`), sql`, `)})`,
  )).returning({ id: imInbox.id });
  return rows.length;
}

export async function deleteExpiredImActionsPg(store: PgStoreDb, namespace: string, before: Date): Promise<number> {
  const rows = await store.db.delete(imActions).where(and(
    eq(imActions.namespace, namespace),
    lt(imActions.expiresAt, before),
    sql`${imActions.status} != 'issued'`,
  )).returning({ id: imActions.actionId });
  return rows.length;
}

export async function deleteExpiredImRateLimitsPg(store: PgStoreDb, namespace: string, before: Date): Promise<number> {
  const rows = await store.db.delete(imRateLimits).where(and(
    eq(imRateLimits.namespace, namespace),
    lt(imRateLimits.windowStart, before),
  )).returning({ bucketKey: imRateLimits.bucketKey });
  return rows.length;
}

function toRequestRow(row: typeof imReviewRequests.$inferSelect): ImReviewRequestRow {
  return { ...row };
}

export async function acceptImDeliveryPg(store: PgStoreDb, input: AcceptImDeliveryInput): Promise<AcceptImDeliveryOutcome> {
  return store.db.transaction(async (tx) => {
    const inboxId = randomUUID();
    const inserted = await tx.insert(imInbox).values({
      id: inboxId,
      namespace: input.delivery.namespace,
      connectionIdentity: input.delivery.connectionIdentity,
      deliveryKind: input.delivery.deliveryKind,
      deliveryKey: input.delivery.deliveryKey,
      payloadDigest: input.delivery.payloadDigest,
      receivedAt: input.now,
      status: input.command !== undefined ? "request_created" : "noted",
    }).onConflictDoNothing().returning({ id: imInbox.id });
    if (inserted.length === 0) {
      const existing = (await tx.select().from(imInbox).where(and(
        eq(imInbox.namespace, input.delivery.namespace),
        eq(imInbox.connectionIdentity, input.delivery.connectionIdentity),
        eq(imInbox.deliveryKind, input.delivery.deliveryKind),
        eq(imInbox.deliveryKey, input.delivery.deliveryKey),
      )))[0];
      if (existing === undefined || existing.payloadDigest !== input.delivery.payloadDigest) {
        return { kind: "conflict" } as AcceptImDeliveryOutcome;
      }
      return { kind: "duplicate", inboxId: existing.id, requestId: existing.requestId } as AcceptImDeliveryOutcome;
    }

    if (input.command === undefined) {
      return { kind: "created", inboxId, requestId: "" } as AcceptImDeliveryOutcome;
    }

    const action = input.command.consumeActionId;
    if (action !== undefined) {
      const rows = await tx.select().from(imActions).where(eq(imActions.actionId, action)).for("update");
      const existingAction = rows[0];
      if (existingAction === undefined) return { kind: "action_rejected", reason: "not_found" } as AcceptImDeliveryOutcome;
      if (existingAction.status === "consumed") {
        await tx.update(imInbox).set({ requestId: existingAction.consumedRequestId }).where(eq(imInbox.id, inboxId));
        return { kind: "duplicate", inboxId, requestId: existingAction.consumedRequestId } as AcceptImDeliveryOutcome;
      }
      if (existingAction.expiresAt.getTime() <= input.now.getTime()) {
        await tx.update(imActions).set({ status: "expired", updatedAt: input.now }).where(eq(imActions.actionId, action));
        return { kind: "action_rejected", reason: "expired" } as AcceptImDeliveryOutcome;
      }
    }

    if (input.command.rateLimit !== undefined) {
      const { bucketKey, windowStart, limit } = input.command.rateLimit;
      const bumped = await tx.insert(imRateLimits).values({
        namespace: input.delivery.namespace, bucketKey, windowStart, count: 1,
      }).onConflictDoUpdate({
        target: [imRateLimits.namespace, imRateLimits.bucketKey, imRateLimits.windowStart],
        set: { count: sql`${imRateLimits.count} + 1` },
      }).returning({ count: imRateLimits.count });
      if ((bumped[0]?.count ?? 0) > limit) {
        return { kind: "rate_limited", count: bumped[0]?.count ?? limit } as AcceptImDeliveryOutcome;
      }
    }

    const targetKey = {
      namespace: input.delivery.namespace,
      workspaceInstance: input.command.activeTarget.workspaceInstance,
      sourceIdentity: input.command.activeTarget.sourceIdentity,
      revision: normalizeRevision(input.command.request.requestedRevision),
    };
    const target = await tx.insert(imActiveTargets).values({ ...targetKey, requestId: input.command.request.requestId, createdAt: input.now })
      .onConflictDoNothing().returning({ requestId: imActiveTargets.requestId });
    if (target.length === 0) {
      const existingTarget = (await tx.select().from(imActiveTargets).where(and(
        eq(imActiveTargets.namespace, targetKey.namespace),
        eq(imActiveTargets.workspaceInstance, targetKey.workspaceInstance),
        eq(imActiveTargets.sourceIdentity, targetKey.sourceIdentity),
        eq(imActiveTargets.revision, targetKey.revision),
      )))[0];
      await tx.update(imInbox).set({ requestId: existingTarget?.requestId ?? null }).where(eq(imInbox.id, inboxId));
      return { kind: "active_merged", inboxId, requestId: existingTarget?.requestId ?? "" } as AcceptImDeliveryOutcome;
    }

    const request = input.command.request;
    await tx.insert(imReviewRequests).values({
      requestId: request.requestId,
      runId: request.runId,
      namespace: input.delivery.namespace,
      bindingId: request.bindingId,
      connectionIdentity: input.delivery.connectionIdentity,
      requestedByType: request.requestedBy.type,
      requestedById: request.requestedBy.id,
      conversationJson: request.conversation,
      workspaceId: request.workspaceId,
      sourceTrigger: request.sourceTrigger,
      repoRef: request.repoRef,
      requestedRevision: request.requestedRevision,
      configSnapshotId: request.configSnapshotId,
      configFileDigest: request.configFileDigest,
      configVersionJson: request.configVersionJson,
      state: "accepted",
      createdAt: input.now,
      updatedAt: input.now,
    });
    if (action !== undefined) {
      await tx.update(imActions).set({ status: "consumed", consumedRequestId: request.requestId, updatedAt: input.now })
        .where(eq(imActions.actionId, action));
    }
    await tx.update(imInbox).set({ requestId: request.requestId }).where(eq(imInbox.id, inboxId));
    return { kind: "created", inboxId, requestId: request.requestId } as AcceptImDeliveryOutcome;
  });
}

export async function claimDueImReviewRequestsPg(
  store: PgStoreDb,
  options: { readonly namespace: string; readonly now: Date; readonly leaseMs: number; readonly owner: string; readonly limit: number },
): Promise<ClaimedImReviewRequest[]> {
  const due = await store.db.select().from(imReviewRequests)
    .where(and(
      eq(imReviewRequests.namespace, options.namespace),
      or(isNull(imReviewRequests.nextAttemptAt), lt(imReviewRequests.nextAttemptAt, options.now)),
      inArray(imReviewRequests.state, ["accepted", "validating", "queued", "running", "publishing", "retry_wait"]),
    )).limit(options.limit);
  const claimed: ClaimedImReviewRequest[] = [];
  for (const candidate of due) {
    if (candidate.leaseUntil !== null && candidate.leaseUntil.getTime() > options.now.getTime()) continue;
    const updated = await store.db.update(imReviewRequests).set({
      leaseOwner: options.owner,
      leaseUntil: new Date(options.now.getTime() + options.leaseMs),
      fence: candidate.fence + 1,
      updatedAt: options.now,
    }).where(and(
      eq(imReviewRequests.requestId, candidate.requestId),
      eq(imReviewRequests.fence, candidate.fence),
      or(isNull(imReviewRequests.leaseUntil), lt(imReviewRequests.leaseUntil, options.now)),
    )).returning();
    if (updated[0] !== undefined) claimed.push({ request: toRequestRow(updated[0]), fence: updated[0].fence });
  }
  return claimed;
}

export async function updateImReviewRequestPg(store: PgStoreDb, update: ImFencedUpdate): Promise<boolean> {
  const set: Record<string, unknown> = { updatedAt: update.now };
  if (update.state !== undefined) set.state = update.state;
  if (update.resolvedRevision !== undefined) set.resolvedRevision = update.resolvedRevision;
  if (update.baseRevision !== undefined) set.baseRevision = update.baseRevision;
  if (update.attemptsByPhaseJson !== undefined) set.attemptsByPhaseJson = update.attemptsByPhaseJson;
  if (update.resumePhase !== undefined) set.resumePhase = update.resumePhase;
  if (update.nextAttemptAt !== undefined) set.nextAttemptAt = update.nextAttemptAt;
  if (update.checkpointJson !== undefined) set.checkpointJson = update.checkpointJson;
  if (update.errorCode !== undefined) set.errorCode = update.errorCode;
  if (update.releaseLease === true) {
    set.leaseOwner = null;
    set.leaseUntil = null;
  }
  const rows = await store.db.update(imReviewRequests).set(set)
    .where(and(eq(imReviewRequests.requestId, update.requestId), eq(imReviewRequests.fence, update.fence)))
    .returning({ requestId: imReviewRequests.requestId });
  return rows.length > 0;
}

export async function prepareImDispatchPg(store: PgStoreDb, requestId: string, fence: number, now: Date): Promise<number | undefined> {
  const rows = await store.db.update(imReviewRequests).set({ dispatchSeq: sql`${imReviewRequests.dispatchSeq} + 1`, updatedAt: now })
    .where(and(eq(imReviewRequests.requestId, requestId), eq(imReviewRequests.fence, fence)))
    .returning({ dispatchSeq: imReviewRequests.dispatchSeq });
  return rows[0]?.dispatchSeq;
}

export async function finishImReviewRequestPg(store: PgStoreDb, input: FinishImReviewRequestInput): Promise<boolean> {
  return store.db.transaction(async (tx) => {
    const rows = await tx.update(imReviewRequests).set({
      state: input.state,
      errorCode: input.errorCode ?? null,
      leaseOwner: null,
      leaseUntil: null,
      fence: sql`${imReviewRequests.fence} + 1`,
      nextAttemptAt: null,
      updatedAt: input.now,
    }).where(and(
      eq(imReviewRequests.requestId, input.requestId),
      eq(imReviewRequests.fence, input.fence),
      inArray(imReviewRequests.state, ["accepted", "validating", "queued", "running", "publishing", "retry_wait"]),
    )).returning();
    if (rows.length === 0) return false;
    const request = rows[0]!;
    await tx.delete(imActiveTargets).where(and(
      eq(imActiveTargets.namespace, request.namespace),
      eq(imActiveTargets.requestId, request.requestId),
    ));
    await tx.update(imInbox).set({ status: "request_finished" }).where(eq(imInbox.requestId, request.requestId));
    for (const notification of input.notifications ?? []) {
      await tx.insert(imReplyOutbox).values({
        operationId: notification.operationId,
        namespace: request.namespace,
        requestId: request.requestId,
        destinationIdentity: notification.destinationIdentity,
        operationKind: notification.operationKind,
        payloadDigest: notification.payloadDigest,
        state: "pending",
        expiry: notification.expiry ?? null,
        nextAttemptAt: notification.nextAttemptAt,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    return true;
  });
}

export async function insertImActionPg(store: PgStoreDb, action: Record<string, unknown>): Promise<void> {
  await store.db.insert(imActions).values(action as typeof imActions.$inferInsert);
}

export async function consumeImActionPg(store: PgStoreDb, input: { readonly actionId: string; readonly now: Date }): Promise<{ readonly kind: "consumed"; readonly requestId: string } | { readonly kind: "expired" } | { readonly kind: "not_found" } | { readonly kind: "not_issued" }> {
  return store.db.transaction(async (tx) => {
    const rows = await tx.select().from(imActions).where(eq(imActions.actionId, input.actionId)).for("update");
    const action = rows[0];
    if (action === undefined) return { kind: "not_found" } as const;
    if (action.status === "consumed") return { kind: "consumed", requestId: action.consumedRequestId ?? "" } as const;
    if (action.expiresAt.getTime() <= input.now.getTime()) {
      await tx.update(imActions).set({ status: "expired", updatedAt: input.now }).where(eq(imActions.actionId, input.actionId));
      return { kind: "expired" } as const;
    }
    return { kind: "not_issued" } as const;
  });
}

export async function consumeImRateLimitPg(store: PgStoreDb, input: { readonly namespace: string; readonly bucketKey: string; readonly windowStart: Date }): Promise<number> {
  const rows = await store.db.insert(imRateLimits).values({
    namespace: input.namespace, bucketKey: input.bucketKey, windowStart: input.windowStart, count: 1,
  }).onConflictDoUpdate({
    target: [imRateLimits.namespace, imRateLimits.bucketKey, imRateLimits.windowStart],
    set: { count: sql`${imRateLimits.count} + 1` },
  }).returning({ count: imRateLimits.count });
  return rows[0]?.count ?? 1;
}
