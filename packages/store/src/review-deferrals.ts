import { asc, eq, sql } from "drizzle-orm";

import type { StoreDb } from "./database.js";
import { reviewDeferrals, type ReviewDeferralStatus } from "./schema.js";
import {
  claimReviewDeferralPg,
  completeReviewDeferralPg,
  deleteReviewDeferralPg,
  getReviewDeferralPg,
  listPendingReviewDeferralsPg,
  releaseReviewDeferralPg,
  resetClaimedReviewDeferralsPg,
  upsertReviewDeferralPg,
} from "./review-deferrals.pg.js";

export interface ReviewDeferralUpsert {
  dedupKey: string;
  workspaceId: string;
  provider: string;
  eventName: string;
  /** Serialized ReviewEvent JSON. */
  reviewEvent: string;
  /** Serialized raw webhook payload JSON; nullable for absent payloads. */
  payload?: string | null;
  notBefore: Date;
}

export interface ReviewDeferralRow {
  dedupKey: string;
  workspaceId: string;
  provider: string;
  eventName: string;
  reviewEvent: string;
  payload: string | null;
  notBefore: Date;
  status: ReviewDeferralStatus;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Insert or replace a deferral for one dedup target. A newer event for the
 * same target replaces the stored envelope (only the latest state gets
 * reviewed), while `not_before` never moves earlier than the already pending
 * instant. The caller must arm its timer using the returned stored deadline.
 */
export async function upsertReviewDeferral(store: StoreDb, deferral: ReviewDeferralUpsert): Promise<ReviewDeferralRow> {
  if (store.kind === "postgres") {
    return upsertReviewDeferralPg(store, deferral);
  }
  const now = new Date();
  return store.db
    .insert(reviewDeferrals)
    .values({
      dedupKey: deferral.dedupKey,
      workspaceId: deferral.workspaceId,
      provider: deferral.provider,
      eventName: deferral.eventName,
      reviewEvent: deferral.reviewEvent,
      payload: deferral.payload ?? null,
      notBefore: deferral.notBefore,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: reviewDeferrals.dedupKey,
      set: {
        workspaceId: deferral.workspaceId,
        provider: deferral.provider,
        eventName: deferral.eventName,
        reviewEvent: deferral.reviewEvent,
        payload: deferral.payload ?? null,
        notBefore: sql`max(${reviewDeferrals.notBefore}, ${deferral.notBefore.getTime()})`,
        status: "pending",
        updatedAt: now,
      },
    })
    .returning()
    .get();
}

export async function getReviewDeferral(store: StoreDb, dedupKey: string): Promise<ReviewDeferralRow | undefined> {
  if (store.kind === "postgres") {
    return getReviewDeferralPg(store, dedupKey);
  }
  return store.db.select().from(reviewDeferrals).where(eq(reviewDeferrals.dedupKey, dedupKey)).get();
}

/** Release only this claim after a failed handoff; other targets keep their ownership. */
export async function releaseReviewDeferral(store: StoreDb, dedupKey: string): Promise<void> {
  if (store.kind === "postgres") {
    return releaseReviewDeferralPg(store, dedupKey);
  }
  store.db.update(reviewDeferrals).set({ status: "pending", updatedAt: new Date() })
    .where(sql`${reviewDeferrals.dedupKey} = ${dedupKey} AND ${reviewDeferrals.status} = 'claimed'`).run();
}

/** A handler may re-defer the target; never delete its replacement pending row. */
export async function completeReviewDeferral(store: StoreDb, dedupKey: string): Promise<void> {
  if (store.kind === "postgres") {
    return completeReviewDeferralPg(store, dedupKey);
  }
  store.db.delete(reviewDeferrals)
    .where(sql`${reviewDeferrals.dedupKey} = ${dedupKey} AND ${reviewDeferrals.status} = 'claimed'`).run();
}

/**
 * Atomically move a pending deferral to `claimed` and return it. Returns
 * undefined when the row is missing or already claimed, so a fired timer
 * racing a cancellation or a duplicate resume is a safe no-op.
 */
export async function claimReviewDeferral(
  store: StoreDb,
  dedupKey: string,
): Promise<ReviewDeferralRow | undefined> {
  if (store.kind === "postgres") {
    return claimReviewDeferralPg(store, dedupKey);
  }
  const rows = store.db
    .update(reviewDeferrals)
    .set({
      status: "claimed",
      attempts: sql`${reviewDeferrals.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(sql`${reviewDeferrals.dedupKey} = ${dedupKey} AND ${reviewDeferrals.status} = 'pending'`)
    .returning()
    .all();
  return rows[0];
}

/** Terminal transition: execution has started and owns the outcome from here. */
export async function deleteReviewDeferral(store: StoreDb, dedupKey: string): Promise<void> {
  if (store.kind === "postgres") {
    return deleteReviewDeferralPg(store, dedupKey);
  }
  store.db.delete(reviewDeferrals).where(eq(reviewDeferrals.dedupKey, dedupKey)).run();
}

export async function listPendingReviewDeferrals(store: StoreDb): Promise<ReviewDeferralRow[]> {
  if (store.kind === "postgres") {
    return listPendingReviewDeferralsPg(store);
  }
  return store.db
    .select()
    .from(reviewDeferrals)
    .where(eq(reviewDeferrals.status, "pending"))
    .orderBy(asc(reviewDeferrals.notBefore))
    .all();
}

/**
 * Startup recovery: a process that stopped between claim and execution start
 * must not strand the deferral, so every claimed row becomes pending again.
 */
export async function resetClaimedReviewDeferrals(store: StoreDb): Promise<number> {
  if (store.kind === "postgres") {
    return resetClaimedReviewDeferralsPg(store);
  }
  const result = store.db
    .update(reviewDeferrals)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(reviewDeferrals.status, "claimed"))
    .run();
  return Number(result.changes);
}
