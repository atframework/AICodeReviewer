import { randomUUID } from "node:crypto";

import { and, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import type { StoreDb } from "./database.js";
import {
  imActions,
  imActiveTargets,
  imInbox,
  imRateLimits,
  imReplyOutbox,
  imReviewRequests,
} from "./schema.js";
import {
  acceptImDeliveryPg,
  claimDueImReviewRequestsPg,
  consumeImActionPg,
  consumeImRateLimitPg,
  deleteExpiredImActionsPg,
  deleteExpiredImInboxPg,
  deleteExpiredImRateLimitsPg,
  findImReviewRequestPg,
  finishImReviewRequestPg,
  claimDueImReplyNotificationsPg,
  consumeImActionForRequestPg,
  finishImReplyNotificationPg,
  getImActionPg,
  insertImActionPg,
  listImActiveConfigSnapshotIdsPg,
  prepareImDispatchPg,
  renewImReviewLeasePg,
  updateImReviewRequestPg,
} from "./im-store.pg.js";

/**
 * IM persistence (implementation spec §4–§5): one inbox row per delivery key,
 * requests owning state/lease/retry truth, active targets deduplicating the
 * same workspace/source/revision, atomic action consumption and rate-limit
 * buckets sharing the acceptDelivery transaction. All operations are
 * constraint-driven (no get-then-insert races) and identical across SQLite
 * and PostgreSQL backends.
 */

export type ImDeliveryKind = "message" | "event" | "card_action";

export interface ImDeliveryIdentity {
  readonly namespace: string;
  readonly connectionIdentity: string;
  readonly deliveryKind: ImDeliveryKind;
  readonly deliveryKey: string;
  readonly payloadDigest: string;
}

export interface ImReviewRequestTarget {
  readonly workspaceId: string;
  readonly sourceTrigger: string;
  readonly repoRef: string;
  readonly requestedRevision: string;
}

export interface NewImReviewRequest extends ImReviewRequestTarget {
  readonly requestId: string;
  readonly runId: string;
  readonly bindingId: string;
  readonly requestedBy: { readonly type: string; readonly id: string };
  readonly conversation: string;
  readonly configSnapshotId: string;
  readonly configFileDigest: string;
  readonly configVersionJson: string;
}

export interface ImReviewRequestRow {
  readonly requestId: string;
  readonly runId: string;
  readonly namespace: string;
  readonly bindingId: string;
  readonly connectionIdentity: string;
  readonly requestedByType: string;
  readonly requestedById: string;
  readonly conversationJson: string;
  readonly workspaceId: string;
  readonly sourceTrigger: string;
  readonly repoRef: string;
  readonly requestedRevision: string;
  readonly resolvedRevision: string | null;
  readonly baseRevision: string | null;
  readonly configSnapshotId: string;
  readonly configFileDigest: string;
  readonly configVersionJson: string;
  readonly state: string;
  readonly attemptsByPhaseJson: string;
  readonly resumePhase: string | null;
  readonly nextAttemptAt: Date | null;
  readonly leaseOwner: string | null;
  readonly leaseUntil: Date | null;
  readonly fence: number;
  readonly dispatchSeq: number;
  readonly checkpointJson: string | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ImTerminalState = "succeeded" | "partial" | "publication_unknown" | "failed" | "rejected";

export interface AcceptImDeliveryInput {
  readonly delivery: ImDeliveryIdentity;
  readonly now: Date;
  /** Creates the request, active target, action consumption and quota atomically. */
  readonly command?: {
    readonly request: NewImReviewRequest;
    readonly activeTarget: { readonly workspaceInstance: string; readonly sourceIdentity: string };
    readonly consumeActionId?: string | undefined;
    readonly rateLimit?: { readonly bucketKey: string; readonly windowStart: Date; readonly limit: number } | undefined;
  } | undefined;
}

export type AcceptImDeliveryOutcome =
  | { readonly kind: "created"; readonly inboxId: string; readonly requestId: string }
  | { readonly kind: "duplicate"; readonly inboxId: string; readonly requestId: string | null }
  | { readonly kind: "active_merged"; readonly inboxId: string; readonly requestId: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "action_rejected"; readonly reason: "expired" | "consumed_mismatch" | "not_found" | "source_mismatch" }
  | { readonly kind: "rate_limited"; readonly count: number };

export interface ClaimedImReviewRequest {
  readonly request: ImReviewRequestRow;
  /** CAS token; every later fenced update must carry this value. */
  readonly fence: number;
}

export interface ImFencedUpdate {
  readonly requestId: string;
  readonly fence: number;
  readonly state?: string | undefined;
  readonly resolvedRevision?: string | undefined;
  readonly baseRevision?: string | undefined;
  readonly attemptsByPhaseJson?: string | undefined;
  readonly resumePhase?: string | undefined;
  readonly nextAttemptAt?: Date | null | undefined;
  readonly checkpointJson?: string | null | undefined;
  readonly errorCode?: string | null | undefined;
  readonly releaseLease?: boolean;
  readonly now: Date;
}

export interface FinishImReviewRequestInput {
  readonly requestId: string;
  readonly fence: number;
  readonly state: ImTerminalState;
  readonly errorCode?: string | undefined;
  /** Terminal notification rows created in the same transaction. */
  readonly notifications?: readonly {
    readonly operationId: string;
    readonly destinationIdentity: string;
    readonly operationKind: string;
    readonly payloadDigest: string;
    readonly nextAttemptAt?: Date | undefined;
    readonly expiry?: Date | undefined;
    readonly compactReceipt?: string | undefined;
  }[];
  readonly now: Date;
}

export interface ImActionRecord {
  readonly actionId: string;
  readonly namespace: string;
  readonly connectionIdentity: string;
  readonly issuedConfigVersion: string;
  readonly sourceMessageId: string | null;
  readonly sourceTaskId: string | null;
  readonly conversationJson: string | null;
  readonly recipientId: string | null;
  readonly bindingId: string;
  readonly workspaceId: string;
  readonly sourceTrigger: string;
  readonly repoRef: string;
  readonly revision: string;
  readonly expiresAt: Date;
  readonly consumedRequestId: string | null;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function newImRowId(): string {
  return randomUUID();
}

/** Control-flow error used to roll back the inbox and quota bump together. */
export class ImRateLimitRollback extends Error {
  constructor(readonly count: number) {
    super("IM rate limit exceeded");
  }
}

export class ImActionRollback extends Error {
  constructor(readonly reason: "not_found" | "source_mismatch") {
    super(`IM action rejected: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// acceptDelivery (spec §4.1)
// ---------------------------------------------------------------------------

export async function acceptImDelivery(store: StoreDb, input: AcceptImDeliveryInput): Promise<AcceptImDeliveryOutcome> {
  if (store.kind === "postgres") return acceptImDeliveryPg(store, input);
  try {
    return store.db.transaction((tx) => {
    let inboxId = newImRowId();
    const inserted = tx.insert(imInbox).values({
      id: inboxId,
      namespace: input.delivery.namespace,
      connectionIdentity: input.delivery.connectionIdentity,
      deliveryKind: input.delivery.deliveryKind,
      deliveryKey: input.delivery.deliveryKey,
      payloadDigest: input.delivery.payloadDigest,
      receivedAt: input.now,
      status: input.command !== undefined ? "request_created" : "noted",
    }).onConflictDoNothing().returning({ id: imInbox.id }).all();
    if (inserted.length === 0) {
      // Same delivery key: same digest replays the original outcome, a
      // different digest is a conflict and never executes twice (R02).
      const existing = tx.select().from(imInbox).where(and(
        eq(imInbox.namespace, input.delivery.namespace),
        eq(imInbox.connectionIdentity, input.delivery.connectionIdentity),
        eq(imInbox.deliveryKind, input.delivery.deliveryKind),
        eq(imInbox.deliveryKey, input.delivery.deliveryKey),
      )).get();
      if (existing === undefined || existing.payloadDigest !== input.delivery.payloadDigest) {
        return { kind: "conflict" } as AcceptImDeliveryOutcome;
      }
      // Callback routes persist the verified delivery before command handling.
      // Its noted row may still be promoted to a request in this transaction.
      if (input.command === undefined || existing.status !== "noted" || existing.requestId !== null) {
        return { kind: "duplicate", inboxId: existing.id, requestId: existing.requestId } as AcceptImDeliveryOutcome;
      }
      inboxId = existing.id;
    }

    if (input.command === undefined) {
      return { kind: "created", inboxId, requestId: "" } as AcceptImDeliveryOutcome;
    }

    const action = input.command.consumeActionId;
    if (action !== undefined) {
      const existingAction = tx.select().from(imActions).where(eq(imActions.actionId, action)).get();
      if (existingAction === undefined) throw new ImActionRollback("not_found");
      if (existingAction.namespace !== input.delivery.namespace || existingAction.connectionIdentity !== input.delivery.connectionIdentity ||
          existingAction.bindingId !== input.command.request.bindingId || existingAction.workspaceId !== input.command.request.workspaceId ||
          existingAction.sourceTrigger !== input.command.request.sourceTrigger || existingAction.repoRef !== input.command.request.repoRef ||
          normalizeRevision(existingAction.revision) !== normalizeRevision(input.command.request.requestedRevision)) {
        throw new ImActionRollback("source_mismatch");
      }
      if (existingAction.status === "consumed") {
        // The command reruns; consumeAction returns the original request (R04/A10).
        tx.update(imInbox).set({ requestId: existingAction.consumedRequestId })
          .where(eq(imInbox.id, inboxId)).run();
        return { kind: "duplicate", inboxId, requestId: existingAction.consumedRequestId } as AcceptImDeliveryOutcome;
      }
      if (existingAction.expiresAt.getTime() <= input.now.getTime()) {
        tx.update(imActions).set({ status: "expired", updatedAt: input.now }).where(eq(imActions.actionId, action)).run();
        return { kind: "action_rejected", reason: "expired" } as AcceptImDeliveryOutcome;
      }
    }

    if (input.command.rateLimit !== undefined) {
      const { bucketKey, windowStart, limit } = input.command.rateLimit;
      const bumped = tx.insert(imRateLimits).values({
        namespace: input.delivery.namespace, bucketKey, windowStart, count: 1,
      }).onConflictDoUpdate({
        target: [imRateLimits.namespace, imRateLimits.bucketKey, imRateLimits.windowStart],
        set: { count: sql`${imRateLimits.count} + 1` },
      }).returning({ count: imRateLimits.count }).all();
      if ((bumped[0]?.count ?? 0) > limit) {
        throw new ImRateLimitRollback(bumped[0]?.count ?? limit);
      }
    }

    // Active target dedup: a running request for the same trusted
    // workspace/source/revision is reused instead of duplicated (R03).
    const targetKey = {
      namespace: input.delivery.namespace,
      workspaceInstance: input.command.activeTarget.workspaceInstance,
      sourceIdentity: input.command.activeTarget.sourceIdentity,
      revision: normalizeRevision(input.command.request.requestedRevision),
    };
    const target = tx.insert(imActiveTargets).values({ ...targetKey, requestId: input.command.request.requestId, createdAt: input.now })
      .onConflictDoNothing().returning({ requestId: imActiveTargets.requestId }).all();
    if (target.length === 0) {
      const existingTarget = tx.select().from(imActiveTargets).where(and(
        eq(imActiveTargets.namespace, targetKey.namespace),
        eq(imActiveTargets.workspaceInstance, targetKey.workspaceInstance),
        eq(imActiveTargets.sourceIdentity, targetKey.sourceIdentity),
        eq(imActiveTargets.revision, targetKey.revision),
      )).get();
      tx.update(imInbox).set({ status: "request_created", requestId: existingTarget?.requestId ?? null }).where(eq(imInbox.id, inboxId)).run();
      if (action !== undefined && existingTarget?.requestId !== undefined) {
        tx.update(imActions).set({ status: "consumed", consumedRequestId: existingTarget.requestId, updatedAt: input.now })
          .where(eq(imActions.actionId, action)).run();
      }
      return { kind: "active_merged", inboxId, requestId: existingTarget?.requestId ?? "" } as AcceptImDeliveryOutcome;
    }

    const request = input.command.request;
    tx.insert(imReviewRequests).values({
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
    }).run();
    if (action !== undefined) {
      tx.update(imActions).set({ status: "consumed", consumedRequestId: request.requestId, updatedAt: input.now })
        .where(eq(imActions.actionId, action)).run();
    }
    tx.update(imInbox).set({ status: "request_created", requestId: request.requestId }).where(eq(imInbox.id, inboxId)).run();
    return { kind: "created", inboxId, requestId: request.requestId } as AcceptImDeliveryOutcome;
    });
  } catch (error) {
    if (error instanceof ImRateLimitRollback) return { kind: "rate_limited", count: error.count };
    if (error instanceof ImActionRollback) return { kind: "action_rejected", reason: error.reason };
    throw error;
  }
}

/**
 * Revision normalization for active-target keys (spec §4): git hex lowercased;
 * SVN `rN` prefixes stripped; no sign/space/range acceptance — callers reject
 * those upstream, this only stabilizes the canonical form.
 */
export function normalizeRevision(revision: string): string {
  if (/^r?[0-9]+$/u.test(revision)) return revision.replace(/^r/u, "");
  if (/^[0-9a-fA-F]{40,64}$/u.test(revision)) return revision.toLowerCase();
  return revision;
}

// ---------------------------------------------------------------------------
// Requests: claim / fenced update / dispatch / finish (spec §4.2–§4.5)
// ---------------------------------------------------------------------------

function toRequestRow(row: typeof imReviewRequests.$inferSelect): ImReviewRequestRow {
  return { ...row };
}

export async function findImReviewRequest(store: StoreDb, namespace: string, requestId: string): Promise<ImReviewRequestRow | undefined> {
  if (store.kind === "postgres") return findImReviewRequestPg(store, namespace, requestId);
  const rows = await store.db.select().from(imReviewRequests)
    .where(and(eq(imReviewRequests.namespace, namespace), eq(imReviewRequests.requestId, requestId)));
  return rows[0] !== undefined ? toRequestRow(rows[0]) : undefined;
}

/** Claims due requests whose lease is absent or expired; CAS fence increments. */
export async function claimDueImReviewRequests(
  store: StoreDb,
  options: { readonly namespace: string; readonly now: Date; readonly leaseMs: number; readonly owner: string; readonly limit: number },
): Promise<ClaimedImReviewRequest[]> {
  if (store.kind === "postgres") return claimDueImReviewRequestsPg(store, options);
  const due = await store.db.select().from(imReviewRequests)
    .where(and(
      eq(imReviewRequests.namespace, options.namespace),
      or(isNull(imReviewRequests.nextAttemptAt), lt(imReviewRequests.nextAttemptAt, options.now)),
      or(isNull(imReviewRequests.leaseUntil), lte(imReviewRequests.leaseUntil, options.now)),
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
      or(isNull(imReviewRequests.leaseUntil), lte(imReviewRequests.leaseUntil, options.now)),
    )).returning();
    if (updated[0] !== undefined) claimed.push({ request: toRequestRow(updated[0]), fence: updated[0].fence });
  }
  return claimed;
}

/** Fenced update; a zero-row result means ownership was lost (R05). */
export async function updateImReviewRequest(store: StoreDb, update: ImFencedUpdate): Promise<boolean> {
  if (store.kind === "postgres") return updateImReviewRequestPg(store, update);
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

/** Extends an owned request lease without changing its fence or state. */
export async function renewImReviewLease(store: StoreDb, input: {
  readonly requestId: string;
  readonly fence: number;
  readonly owner: string;
  readonly now: Date;
  readonly leaseMs: number;
}): Promise<boolean> {
  if (store.kind === "postgres") return renewImReviewLeasePg(store, input);
  const rows = await store.db.update(imReviewRequests).set({
    leaseUntil: new Date(input.now.getTime() + input.leaseMs), updatedAt: input.now,
  }).where(and(
    eq(imReviewRequests.requestId, input.requestId), eq(imReviewRequests.fence, input.fence),
    eq(imReviewRequests.leaseOwner, input.owner),
    gte(imReviewRequests.leaseUntil, input.now),
  )).returning({ requestId: imReviewRequests.requestId });
  return rows.length > 0;
}

/** Atomically increments the dispatch sequence; job id stays stable per seq. */
export async function prepareImDispatch(store: StoreDb, requestId: string, fence: number, now: Date): Promise<number | undefined> {
  if (store.kind === "postgres") return prepareImDispatchPg(store, requestId, fence, now);
  const rows = await store.db.update(imReviewRequests).set({ dispatchSeq: sql`${imReviewRequests.dispatchSeq} + 1`, updatedAt: now })
    .where(and(eq(imReviewRequests.requestId, requestId), eq(imReviewRequests.fence, fence)))
    .returning({ dispatchSeq: imReviewRequests.dispatchSeq });
  return rows[0]?.dispatchSeq;
}

export function imReviewJobId(requestId: string, dispatchSeq: number): string {
  return `im-review-${requestId}-${dispatchSeq}`;
}

/** Terminal write + active-target release + notification outbox in one transaction. */
export async function finishImReviewRequest(store: StoreDb, input: FinishImReviewRequestInput): Promise<boolean> {
  if (store.kind === "postgres") return finishImReviewRequestPg(store, input);
  return store.db.transaction((tx) => {
    const rows = tx.update(imReviewRequests).set({
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
    )).returning().all();
    if (rows.length === 0) return false;
    const request = rows[0]!;
    tx.delete(imActiveTargets).where(and(
      eq(imActiveTargets.namespace, request.namespace),
      eq(imActiveTargets.requestId, request.requestId),
    )).run();
    tx.update(imInbox).set({ status: "request_finished" })
      .where(eq(imInbox.requestId, request.requestId)).run();
    for (const notification of input.notifications ?? []) {
      tx.insert(imReplyOutbox).values({
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
        createdAt: input.now,
        updatedAt: input.now,
      }).run();
    }
    return true;
  });
}

export interface ImReplyNotificationRow {
  readonly operationId: string;
  readonly namespace: string;
  readonly requestId: string | null;
  readonly destinationIdentity: string;
  readonly operationKind: string;
  readonly payloadDigest: string;
  readonly state: string;
  readonly expiry: Date | null;
  readonly compactReceipt: string | null;
  readonly attempts: number;
  readonly fence: number;
}

/** Claims due reply notifications for one worker (lease + fence; O09/O11). */
export async function claimDueImReplyNotifications(store: StoreDb, input: { readonly owner: string; readonly limit: number; readonly now: Date }): Promise<ImReplyNotificationRow[]> {
  if (store.kind === "postgres") return claimDueImReplyNotificationsPg(store, input);
  return store.db.transaction((tx) => {
    const due = tx.select().from(imReplyOutbox).where(or(
      and(eq(imReplyOutbox.state, "pending"), lte(imReplyOutbox.nextAttemptAt, input.now)),
      and(eq(imReplyOutbox.state, "delivering"), lte(imReplyOutbox.leaseUntil, input.now)),
    )).orderBy(imReplyOutbox.nextAttemptAt).limit(input.limit).all();
    const claimed: ImReplyNotificationRow[] = [];
    for (const row of due) {
      if (row.expiry !== null && row.expiry.getTime() <= input.now.getTime()) {
        tx.update(imReplyOutbox).set({ state: "expired", updatedAt: input.now }).where(eq(imReplyOutbox.operationId, row.operationId)).run();
        continue;
      }
      const next = tx.update(imReplyOutbox).set({
        state: "delivering",
        leaseOwner: input.owner,
        leaseUntil: new Date(input.now.getTime() + 60_000),
        attempts: row.attempts + 1,
        fence: sql`${imReplyOutbox.fence} + 1`,
        updatedAt: input.now,
      }).where(and(eq(imReplyOutbox.operationId, row.operationId), eq(imReplyOutbox.fence, row.fence))).returning().all();
      if (next.length > 0) claimed.push(next[0]!);
    }
    return claimed;
  });
}

/** Terminal update for one notification (delivered / failed / back to pending). */
export async function finishImReplyNotification(store: StoreDb, input: { readonly operationId: string; readonly fence: number; readonly state: "delivered" | "failed" | "pending"; readonly retryAt?: Date; readonly now: Date }): Promise<boolean> {
  if (store.kind === "postgres") return finishImReplyNotificationPg(store, input);
  const rows = store.db.update(imReplyOutbox).set({
    state: input.state,
    ...(input.state === "pending" ? { leaseOwner: null, leaseUntil: null, nextAttemptAt: input.retryAt ?? input.now } : {}),
    ...(input.state === "failed" ? { leaseOwner: null, leaseUntil: null } : {}),
    ...(input.state === "delivered" ? { leaseOwner: null, leaseUntil: null, nextAttemptAt: null } : {}),
    updatedAt: input.now,
  }).where(and(eq(imReplyOutbox.operationId, input.operationId), eq(imReplyOutbox.fence, input.fence))).returning().all();
  return rows.length > 0;
}

/** Active config snapshot references registered with the runtime GC (R06). */
export async function listImActiveConfigSnapshotIds(store: StoreDb, namespace: string): Promise<string[]> {
  if (store.kind === "postgres") return listImActiveConfigSnapshotIdsPg(store, namespace);
  const rows = await store.db.selectDistinct({ snapshotId: imReviewRequests.configSnapshotId })
    .from(imReviewRequests)
    .where(and(
      eq(imReviewRequests.namespace, namespace),
      inArray(imReviewRequests.state, ["accepted", "validating", "queued", "running", "publishing", "retry_wait"]),
    ));
  return rows.map(row => row.snapshotId);
}

// ---------------------------------------------------------------------------
// Actions and rate limits
// ---------------------------------------------------------------------------

export async function insertImAction(store: StoreDb, action: Omit<ImActionRecord, "consumedRequestId" | "status" | "createdAt" | "updatedAt"> & { readonly status: "issued"; readonly createdAt: Date; readonly updatedAt: Date }): Promise<void> {
  if (store.kind === "postgres") return insertImActionPg(store, action);
  await store.db.insert(imActions).values({ ...action, consumedRequestId: null });
}

export async function getImAction(store: StoreDb, actionId: string): Promise<ImActionRecord | undefined> {
  if (store.kind === "postgres") return getImActionPg(store, actionId);
  const rows = await store.db.select().from(imActions).where(eq(imActions.actionId, actionId));
  return rows[0];
}

/** Standalone consumption probe (card replay without a new command). */
export async function consumeImAction(store: StoreDb, input: { readonly actionId: string; readonly now: Date }): Promise<{ readonly kind: "consumed"; readonly requestId: string } | { readonly kind: "expired" } | { readonly kind: "not_found" } | { readonly kind: "not_issued" }> {
  if (store.kind === "postgres") return consumeImActionPg(store, input);
  return store.db.transaction((tx) => {
    const action = tx.select().from(imActions).where(eq(imActions.actionId, input.actionId)).get();
    if (action === undefined) return { kind: "not_found" } as const;
    if (action.status === "consumed") return { kind: "consumed", requestId: action.consumedRequestId ?? "" } as const;
    if (action.expiresAt.getTime() <= input.now.getTime()) {
      tx.update(imActions).set({ status: "expired", updatedAt: input.now }).where(eq(imActions.actionId, input.actionId)).run();
      return { kind: "expired" } as const;
    }
    return { kind: "not_issued" } as const;
  });
}

/**
 * Atomic consume-for-request (IM-15 A10): one CAS transition
 * issued -> consumed(requestId); replays return the original request id.
 */
export async function consumeImActionForRequest(store: StoreDb, input: { readonly actionId: string; readonly requestId: string; readonly now: Date }): Promise<{ kind: "consumed" } | { kind: "duplicate"; requestId: string } | { kind: "expired" } | { kind: "not_found" }> {
  if (store.kind === "postgres") return consumeImActionForRequestPg(store, input);
  return store.db.transaction((tx) => {
    const action = tx.select().from(imActions).where(eq(imActions.actionId, input.actionId)).get();
    if (action === undefined) return { kind: "not_found" } as const;
    if (action.status === "consumed") return { kind: "duplicate", requestId: action.consumedRequestId ?? "" } as const;
    if (action.expiresAt.getTime() <= input.now.getTime()) {
      tx.update(imActions).set({ status: "expired", updatedAt: input.now }).where(eq(imActions.actionId, input.actionId)).run();
      return { kind: "expired" } as const;
    }
    if (action.status !== "issued") return { kind: "expired" } as const;
    const updated = tx.update(imActions).set({
      status: "consumed",
      consumedRequestId: input.requestId,
      updatedAt: input.now,
    }).where(and(
      eq(imActions.actionId, input.actionId),
      eq(imActions.status, "issued"),
    )).returning().all();
    if (updated.length === 0) return { kind: "duplicate", requestId: "" } as const;
    return { kind: "consumed" } as const;
  });
}

/** Bumps a bucket counter; callers reject once the returned count exceeds the limit. */
export async function consumeImRateLimit(store: StoreDb, input: { readonly namespace: string; readonly bucketKey: string; readonly windowStart: Date }): Promise<number> {
  if (store.kind === "postgres") return consumeImRateLimitPg(store, input);
  const rows = await store.db.insert(imRateLimits).values({
    namespace: input.namespace, bucketKey: input.bucketKey, windowStart: input.windowStart, count: 1,
  }).onConflictDoUpdate({
    target: [imRateLimits.namespace, imRateLimits.bucketKey, imRateLimits.windowStart],
    set: { count: sql`${imRateLimits.count} + 1` },
  }).returning({ count: imRateLimits.count });
  return rows[0]?.count ?? 1;
}

// ---------------------------------------------------------------------------
// Retention (spec §6: terminal inbox entries expire; active rows never do)
// ---------------------------------------------------------------------------

export async function deleteExpiredImInbox(store: StoreDb, namespace: string, before: Date, keepRequestIds: readonly string[]): Promise<number> {
  if (store.kind === "postgres") return deleteExpiredImInboxPg(store, namespace, before, keepRequestIds);
  const rows = await store.db.delete(imInbox).where(and(
    eq(imInbox.namespace, namespace),
    lt(imInbox.receivedAt, before),
    keepRequestIds.length === 0 ? sql`1 = 1` : sql`${imInbox.requestId} IS NULL OR ${imInbox.requestId} NOT IN (${sql.join(keepRequestIds.map(id => sql`${id}`), sql`, `)})`,
  )).returning({ id: imInbox.id });
  return rows.length;
}

export async function deleteExpiredImActions(store: StoreDb, namespace: string, before: Date): Promise<number> {
  if (store.kind === "postgres") return deleteExpiredImActionsPg(store, namespace, before);
  const rows = await store.db.delete(imActions).where(and(
    eq(imActions.namespace, namespace),
    lt(imActions.expiresAt, before),
    sql`${imActions.status} != 'issued'`,
  )).returning({ id: imActions.actionId });
  return rows.length;
}

export async function deleteExpiredImRateLimits(store: StoreDb, namespace: string, before: Date): Promise<number> {
  if (store.kind === "postgres") return deleteExpiredImRateLimitsPg(store, namespace, before);
  const rows = await store.db.delete(imRateLimits).where(and(
    eq(imRateLimits.namespace, namespace),
    lt(imRateLimits.windowStart, before),
  )).returning({ bucketKey: imRateLimits.bucketKey });
  return rows.length;
}
