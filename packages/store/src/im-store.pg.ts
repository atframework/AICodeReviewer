/**
 * PostgreSQL branch of the IM store (im-store.ts). Same operations; PG-specific
 * pieces: `.for("update")` row locks inside acceptDelivery, RETURNING-based CAS
 * and GREATEST-free set expressions kept in drizzle's portable form.
 */

import { and, eq, gt, gte, inArray, notInArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";

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
  CancelImReviewRequestInput,
  ClaimedImReviewRequest,
  FinishImReplyNotificationInput,
  FinishImReviewRequestInput,
  ImActionRecord,
  ImFencedUpdate,
  ImReviewRequestQueryOptions,
  ImReviewRequestRow,
} from "./im-store.js";
import {
  ImActionRollback,
  ImRateLimitRollback,
  assertImNotificationIdentity,
  normalizeRevision,
  validateImNotification,
  checkImAdmissionBudget,
  checkImReviewRequestQueryBudget,
} from "./im-store.js";

export async function findImReviewRequestPg(
  store: PgStoreDb,
  namespace: string,
  requestId: string,
  options: ImReviewRequestQueryOptions = {},
): Promise<ImReviewRequestRow | undefined> {
  if (options.signal === undefined && options.deadlineAt === undefined) {
    const rows = await store.db.select().from(imReviewRequests)
      .where(and(eq(imReviewRequests.namespace, namespace), eq(imReviewRequests.requestId, requestId)));
    return rows[0] !== undefined ? toRequestRow(rows[0]) : undefined;
  }
  checkImReviewRequestQueryBudget(options);
  const client = await store.pool.connect();
  let aborted = false;
  let transactionOpen = false;
  const onAbort = (): void => {
    aborted = true;
    // pg marks an intentional disconnect before aborting the in-flight query.
    void client.end();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    checkImReviewRequestQueryBudget(options);
    await client.query("BEGIN");
    transactionOpen = true;
    if (options.deadlineAt !== undefined) {
      const remaining = Math.max(1, options.deadlineAt - Date.now());
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(remaining)]);
    }
    checkImReviewRequestQueryBudget(options);
    const rows = await drizzlePg(client).select().from(imReviewRequests)
      .where(and(eq(imReviewRequests.namespace, namespace), eq(imReviewRequests.requestId, requestId)));
    checkImReviewRequestQueryBudget(options);
    await client.query("COMMIT");
    transactionOpen = false;
    return rows[0] !== undefined ? toRequestRow(rows[0]) : undefined;
  } catch (error) {
    if (aborted) options.signal?.throwIfAborted();
    checkImReviewRequestQueryBudget(options);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (transactionOpen && !aborted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A connection whose transaction cannot be cleaned up must not be reused.
        aborted = true;
      }
    }
    client.release(aborted);
  }
}

export async function listImActiveConfigSnapshotIdsPg(store: PgStoreDb, namespace: string, now = new Date()): Promise<string[]> {
  const rows = await store.db.selectDistinct({ snapshotId: imReviewRequests.configSnapshotId })
    .from(imReviewRequests)
    .where(and(
      eq(imReviewRequests.namespace, namespace),
      inArray(imReviewRequests.state, ["accepted", "validating", "queued", "running", "publishing", "retry_wait"]),
    ));
  const actions = await store.db.selectDistinct({ snapshotId: imActions.issuedConfigVersion }).from(imActions).where(and(
    eq(imActions.namespace, namespace), eq(imActions.status, "issued"), gt(imActions.expiresAt, now),
  ));
  return [...new Set([...rows, ...actions].map(row => row.snapshotId))];
}

export async function getImActionPg(store: PgStoreDb, actionId: string): Promise<ImActionRecord | undefined> {
  const rows = await store.db.select().from(imActions).where(eq(imActions.actionId, actionId));
  return rows[0];
}

export async function bindImActionSourcePg(store: PgStoreDb, input: { readonly actionId: string; readonly sourceMessageId?: string | undefined; readonly sourceTaskId?: string | undefined; readonly now: Date }): Promise<boolean> {
  if ((!input.sourceMessageId && !input.sourceTaskId) || input.sourceMessageId === "" || input.sourceTaskId === "") return false;
  const rows = await store.db.update(imActions).set({
    ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.sourceTaskId !== undefined ? { sourceTaskId: input.sourceTaskId } : {}),
    updatedAt: input.now,
  }).where(and(
    eq(imActions.actionId, input.actionId),
    eq(imActions.status, "issued"),
    gt(imActions.expiresAt, input.now),
    isNull(imActions.sourceMessageId),
    isNull(imActions.sourceTaskId),
  )).returning({ actionId: imActions.actionId });
  return rows.length > 0;
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
  checkImAdmissionBudget(input);
  try {
    return await store.db.transaction(async (tx) => {
    if (input.deadlineAt !== undefined) await tx.execute(sql`SET LOCAL statement_timeout = '750ms'`);
    const notify = async (kind: "created" | "active_merged", requestId: string): Promise<void> => {
      checkImAdmissionBudget(input);
      const notification = input.notification?.({ kind, requestId });
      if (!notification) return;
      validateImNotification(notification);
      const values = {
        operationId: notification.operationId,
        namespace: input.delivery.namespace,
        requestId: requestId || null,
        destinationIdentity: notification.destinationIdentity,
        operationKind: notification.operationKind,
        payloadDigest: notification.payloadDigest,
        payloadJson: notification.payloadJson ?? null,
        compactReceipt: notification.compactReceipt ?? null,
        expiry: notification.expiry ?? new Date(input.now.getTime() + 86_400_000),
        state: "pending",
        nextAttemptAt: notification.nextAttemptAt ?? input.now,
        createdAt: input.now,
        updatedAt: input.now,
      };
      const insertedNotification = await tx.insert(imReplyOutbox).values(values).onConflictDoNothing().returning();
      if (insertedNotification.length === 0) {
        const existing = (await tx.select().from(imReplyOutbox)
          .where(eq(imReplyOutbox.operationId, notification.operationId)).for("update"))[0];
        assertImNotificationIdentity(existing, values);
      }
      checkImAdmissionBudget(input);
    };
    let inboxId: string = randomUUID();
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
      )).for("update"))[0];
      if (existing === undefined || existing.payloadDigest !== input.delivery.payloadDigest) {
        return { kind: "conflict" } as AcceptImDeliveryOutcome;
      }
      if (input.command === undefined || existing.status !== "noted" || existing.requestId !== null) {
        return { kind: "duplicate", inboxId: existing.id, requestId: existing.requestId } as AcceptImDeliveryOutcome;
      }
      inboxId = existing.id;
    }

    if (input.command === undefined) {
      await notify("created", "");
      return { kind: "created", inboxId, requestId: "" } as AcceptImDeliveryOutcome;
    }

    const action = input.command.consumeActionId;
    if (action !== undefined) {
      const rows = await tx.select().from(imActions).where(eq(imActions.actionId, action)).for("update");
      const existingAction = rows[0];
      if (existingAction === undefined) throw new ImActionRollback("not_found");
      if (existingAction.namespace !== input.delivery.namespace || existingAction.connectionIdentity !== input.delivery.connectionIdentity ||
          existingAction.bindingId !== input.command.request.bindingId || existingAction.workspaceId !== input.command.request.workspaceId ||
          existingAction.sourceTrigger !== input.command.request.sourceTrigger || existingAction.repoRef !== input.command.request.repoRef ||
          normalizeRevision(existingAction.revision) !== normalizeRevision(input.command.request.requestedRevision)) {
        throw new ImActionRollback("source_mismatch");
      }
      if (existingAction.status === "consumed") {
        await tx.update(imInbox).set({ requestId: existingAction.consumedRequestId }).where(eq(imInbox.id, inboxId));
        return { kind: "duplicate", inboxId, requestId: existingAction.consumedRequestId } as AcceptImDeliveryOutcome;
      }
      if (existingAction.expiresAt.getTime() <= input.now.getTime()) {
        await tx.update(imActions).set({ status: "expired", updatedAt: input.now }).where(eq(imActions.actionId, action));
        return { kind: "action_rejected", reason: "expired" } as AcceptImDeliveryOutcome;
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
      await tx.update(imInbox).set({ status: "request_created", requestId: existingTarget?.requestId ?? null }).where(eq(imInbox.id, inboxId));
      if (action !== undefined && existingTarget?.requestId !== undefined) {
        await tx.update(imActions).set({ status: "consumed", consumedRequestId: existingTarget.requestId, updatedAt: input.now })
          .where(eq(imActions.actionId, action));
      }
      await notify("active_merged", existingTarget?.requestId ?? "");
      return { kind: "active_merged", inboxId, requestId: existingTarget?.requestId ?? "" } as AcceptImDeliveryOutcome;
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
        throw new ImRateLimitRollback(bumped[0]?.count ?? limit);
      }
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
    await tx.update(imInbox).set({ status: "request_created", requestId: request.requestId }).where(eq(imInbox.id, inboxId));
    await notify("created", request.requestId);
    return { kind: "created", inboxId, requestId: request.requestId } as AcceptImDeliveryOutcome;
    });
  } catch (error) {
    if (error instanceof ImRateLimitRollback) return { kind: "rate_limited", count: error.count };
    if (error instanceof ImActionRollback) return { kind: "action_rejected", reason: error.reason };
    throw error;
  }
}

export async function claimDueImReviewRequestsPg(
  store: PgStoreDb,
  options: { readonly namespace: string; readonly now: Date; readonly leaseMs: number; readonly owner: string; readonly limit: number; readonly excludeWorkspaceIds?: readonly string[] },
): Promise<ClaimedImReviewRequest[]> {
  const due = await store.db.select().from(imReviewRequests)
    .where(and(
      eq(imReviewRequests.namespace, options.namespace),
      ...(options.excludeWorkspaceIds?.length ? [notInArray(imReviewRequests.workspaceId, [...options.excludeWorkspaceIds])] : []),
      or(isNull(imReviewRequests.nextAttemptAt), lte(imReviewRequests.nextAttemptAt, options.now)),
      or(isNull(imReviewRequests.leaseUntil), lte(imReviewRequests.leaseUntil, options.now)),
      inArray(imReviewRequests.state, ["accepted", "validating", "queued", "running", "publishing", "retry_wait"]),
    )).orderBy(imReviewRequests.createdAt, imReviewRequests.requestId).limit(options.limit);
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
      or(isNull(imReviewRequests.leaseUntil), lte(imReviewRequests.leaseUntil, options.now)),
    )).returning();
    if (updated[0] !== undefined) claimed.push({ request: toRequestRow(updated[0]), fence: updated[0].fence });
  }
  return claimed;
}

export async function claimImReviewRequestByIdPg(
  store: PgStoreDb,
  options: { readonly namespace: string; readonly requestId: string; readonly now: Date; readonly leaseMs: number; readonly owner: string },
): Promise<ClaimedImReviewRequest | undefined> {
  const candidate = (await store.db.select().from(imReviewRequests)
    .where(and(eq(imReviewRequests.namespace, options.namespace), eq(imReviewRequests.requestId, options.requestId))))[0];
  if (candidate === undefined) return undefined;
  if (!["accepted", "validating", "queued", "running", "publishing", "retry_wait"].includes(candidate.state)) return undefined;
  if (candidate.nextAttemptAt !== null && candidate.nextAttemptAt.getTime() > options.now.getTime()) return undefined;
  if (candidate.leaseUntil !== null && candidate.leaseUntil.getTime() > options.now.getTime()) return undefined;
  const updated = await store.db.update(imReviewRequests).set({
    leaseOwner: options.owner,
    leaseUntil: new Date(options.now.getTime() + options.leaseMs),
    fence: candidate.fence + 1,
    updatedAt: options.now,
  }).where(and(
    eq(imReviewRequests.requestId, candidate.requestId),
    eq(imReviewRequests.fence, candidate.fence),
    or(isNull(imReviewRequests.leaseUntil), lte(imReviewRequests.leaseUntil, options.now)),
  )).returning();
  return updated[0] !== undefined ? { request: toRequestRow(updated[0]), fence: updated[0].fence } : undefined;
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

export async function renewImReviewLeasePg(store: PgStoreDb, input: {
  readonly requestId: string;
  readonly fence: number;
  readonly owner: string;
  readonly now: Date;
  readonly leaseMs: number;
}): Promise<boolean> {
  const rows = await store.db.update(imReviewRequests).set({
    leaseUntil: new Date(input.now.getTime() + input.leaseMs), updatedAt: input.now,
  }).where(and(
    eq(imReviewRequests.requestId, input.requestId), eq(imReviewRequests.fence, input.fence),
    eq(imReviewRequests.leaseOwner, input.owner),
    gte(imReviewRequests.leaseUntil, input.now),
  )).returning({ requestId: imReviewRequests.requestId });
  return rows.length > 0;
}

export async function prepareImDispatchPg(store: PgStoreDb, requestId: string, fence: number, now: Date): Promise<number | undefined> {
  const rows = await store.db.update(imReviewRequests).set({ dispatchSeq: sql`CASE WHEN ${imReviewRequests.state} = 'queued' AND ${imReviewRequests.dispatchSeq} > 0 THEN ${imReviewRequests.dispatchSeq} ELSE ${imReviewRequests.dispatchSeq} + 1 END`, updatedAt: now })
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
      validateImNotification(notification);
      await tx.insert(imReplyOutbox).values({
        operationId: notification.operationId,
        namespace: request.namespace,
        requestId: request.requestId,
        destinationIdentity: notification.destinationIdentity,
        operationKind: notification.operationKind,
        payloadDigest: notification.payloadDigest,
        state: "pending",
        expiry: notification.expiry ?? null,
        nextAttemptAt: notification.nextAttemptAt ?? input.now,
        compactReceipt: notification.compactReceipt ?? null,
        payloadJson: notification.payloadJson ?? null,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    return true;
  });
}

export async function cancelImReviewRequestPg(store: PgStoreDb, input: CancelImReviewRequestInput): Promise<boolean> {
  return store.db.transaction(async (tx) => {
    const rows = await tx.update(imReviewRequests).set({
      state: "rejected",
      errorCode: input.errorCode ?? "im.cancelled_by_user",
      leaseOwner: null,
      leaseUntil: null,
      fence: sql`${imReviewRequests.fence} + 1`,
      nextAttemptAt: null,
      updatedAt: input.now,
    }).where(and(
      eq(imReviewRequests.requestId, input.requestId),
      inArray(imReviewRequests.state, [...(input.states ?? ["accepted", "validating", "queued", "running", "publishing", "retry_wait"])]),
    )).returning();
    if (rows.length === 0) return false;
    const request = rows[0]!;
    await tx.delete(imActiveTargets).where(and(
      eq(imActiveTargets.namespace, request.namespace),
      eq(imActiveTargets.requestId, request.requestId),
    ));
    await tx.update(imInbox).set({ status: "request_finished" }).where(eq(imInbox.requestId, request.requestId));
    for (const notification of input.notifications ?? []) {
      validateImNotification(notification);
      await tx.insert(imReplyOutbox).values({
        operationId: notification.operationId,
        namespace: request.namespace,
        requestId: request.requestId,
        destinationIdentity: notification.destinationIdentity,
        operationKind: notification.operationKind,
        payloadDigest: notification.payloadDigest,
        state: "pending",
        expiry: notification.expiry ?? null,
        nextAttemptAt: notification.nextAttemptAt ?? input.now,
        compactReceipt: notification.compactReceipt ?? null,
        payloadJson: notification.payloadJson ?? null,
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

export interface ImReplyNotificationRowPg {
  readonly operationId: string;
  readonly namespace: string;
  readonly requestId: string | null;
  readonly destinationIdentity: string;
  readonly operationKind: string;
  readonly payloadDigest: string;
  readonly state: string;
  readonly expiry: Date | null;
  readonly compactReceipt: string | null;
  readonly payloadJson: string | null;
  readonly leaseOwner: string | null;
  readonly leaseUntil: Date | null;
  readonly attempts: number;
  readonly fence: number;
}

export async function claimDueImReplyNotificationsPg(store: PgStoreDb, input: { readonly owner: string; readonly limit: number; readonly now: Date }): Promise<ImReplyNotificationRowPg[]> {
  return store.db.transaction(async (tx) => {
    await tx.update(imReplyOutbox).set({ state: "unknown", leaseOwner: null, leaseUntil: null,
      fence: sql`${imReplyOutbox.fence} + 1`, updatedAt: input.now,
    }).where(and(eq(imReplyOutbox.state, "sending"), lte(imReplyOutbox.leaseUntil, input.now)));
    const due = await tx.select().from(imReplyOutbox).where(or(
      and(eq(imReplyOutbox.state, "pending"), lte(imReplyOutbox.nextAttemptAt, input.now)),
      and(eq(imReplyOutbox.state, "delivering"), lte(imReplyOutbox.leaseUntil, input.now)),
    )).orderBy(imReplyOutbox.nextAttemptAt).limit(input.limit).for("update", { skipLocked: true });
    const claimed: ImReplyNotificationRowPg[] = [];
    for (const row of due) {
      if (row.expiry !== null && row.expiry.getTime() <= input.now.getTime()) {
        await tx.update(imReplyOutbox).set({ state: "expired", leaseOwner: null, leaseUntil: null, nextAttemptAt: null,
          fence: sql`${imReplyOutbox.fence} + 1`, updatedAt: input.now,
        }).where(and(eq(imReplyOutbox.operationId, row.operationId), eq(imReplyOutbox.fence, row.fence),
          inArray(imReplyOutbox.state, ["pending", "delivering"])));
        continue;
      }
      const next = await tx.update(imReplyOutbox).set({
        state: "delivering",
        leaseOwner: input.owner,
        leaseUntil: new Date(input.now.getTime() + 60_000),
        attempts: row.attempts + 1,
        fence: sql`${imReplyOutbox.fence} + 1`,
        updatedAt: input.now,
      }).where(and(eq(imReplyOutbox.operationId, row.operationId), eq(imReplyOutbox.fence, row.fence),
        inArray(imReplyOutbox.state, ["pending", "delivering"]))).returning();
      if (next.length > 0) claimed.push(next[0]!);
    }
    return claimed;
  });
}

export async function finishImReplyNotificationPg(store: PgStoreDb, input: FinishImReplyNotificationInput): Promise<boolean> {
  if (input.owner === undefined) return false;
  const sourceStates = input.state === "sending" ? ["delivering"]
    : input.state === "delivered" || input.state === "unknown" ? ["sending"]
    : ["delivering", "sending"];
  const rows = await store.db.update(imReplyOutbox).set({
    state: input.state,
    ...(input.compactReceipt !== undefined ? { compactReceipt: input.compactReceipt } : {}),
    ...(input.state === "pending" ? { leaseOwner: null, leaseUntil: null, nextAttemptAt: input.retryAt ?? input.now } : {}),
    ...(input.state !== "pending" && input.state !== "sending" ? { leaseOwner: null, leaseUntil: null, nextAttemptAt: null } : {}),
    updatedAt: input.now,
  }).where(and(
    eq(imReplyOutbox.operationId, input.operationId),
    eq(imReplyOutbox.fence, input.fence),
    eq(imReplyOutbox.leaseOwner, input.owner),
    gt(imReplyOutbox.leaseUntil, input.now),
    inArray(imReplyOutbox.state, sourceStates),
    ...(input.state === "sending" ? [or(isNull(imReplyOutbox.expiry), gt(imReplyOutbox.expiry, input.now))] : []),
  )).returning();
  return rows.length > 0;
}

export async function consumeImActionForRequestPg(store: PgStoreDb, input: { readonly actionId: string; readonly requestId: string; readonly now: Date }): Promise<{ kind: "consumed" } | { kind: "duplicate"; requestId: string } | { kind: "expired" } | { kind: "not_found" }> {
  return store.db.transaction(async (tx) => {
    const rows = await tx.select().from(imActions).where(eq(imActions.actionId, input.actionId));
    const action = rows[0];
    if (action === undefined) return { kind: "not_found" } as const;
    if (action.status === "consumed") return { kind: "duplicate", requestId: action.consumedRequestId ?? "" } as const;
    if (action.expiresAt.getTime() <= input.now.getTime()) {
      await tx.update(imActions).set({ status: "expired", updatedAt: input.now }).where(eq(imActions.actionId, input.actionId));
      return { kind: "expired" } as const;
    }
    if (action.status !== "issued") return { kind: "expired" } as const;
    const updated = await tx.update(imActions).set({
      status: "consumed",
      consumedRequestId: input.requestId,
      updatedAt: input.now,
    }).where(and(eq(imActions.actionId, input.actionId), eq(imActions.status, "issued"))).returning();
    if (updated.length === 0) return { kind: "duplicate", requestId: "" } as const;
    return { kind: "consumed" } as const;
  });
}
