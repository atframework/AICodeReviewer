/**
 * PostgreSQL branch of the review deferral table (review-deferrals.ts).
 * Same claim/replace/recovery semantics; `max()` becomes GREATEST and the
 * claim round-trip uses RETURNING like the sqlite implementation.
 */

import { asc, eq, sql } from "drizzle-orm";

import type { PgStoreDb } from "./database.js";
import { reviewDeferrals } from "./schema.pg.js";
import type { ReviewDeferralRow, ReviewDeferralUpsert } from "./review-deferrals.js";

export async function upsertReviewDeferralPg(store: PgStoreDb, deferral: ReviewDeferralUpsert): Promise<ReviewDeferralRow> {
  const now = new Date();
  const row = (
    await store.db
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
          notBefore: sql`GREATEST(${reviewDeferrals.notBefore}, ${deferral.notBefore.getTime()})`,
          status: "pending",
          updatedAt: now,
        },
      })
      .returning()
  )[0];
  return row!;
}

export async function getReviewDeferralPg(store: PgStoreDb, dedupKey: string): Promise<ReviewDeferralRow | undefined> {
  return (
    await store.db.select().from(reviewDeferrals).where(eq(reviewDeferrals.dedupKey, dedupKey))
  )[0];
}

export async function releaseReviewDeferralPg(store: PgStoreDb, dedupKey: string): Promise<void> {
  await store.db
    .update(reviewDeferrals)
    .set({ status: "pending", updatedAt: new Date() })
    .where(sql`${reviewDeferrals.dedupKey} = ${dedupKey} AND ${reviewDeferrals.status} = 'claimed'`);
}

export async function completeReviewDeferralPg(store: PgStoreDb, dedupKey: string): Promise<void> {
  await store.db
    .delete(reviewDeferrals)
    .where(sql`${reviewDeferrals.dedupKey} = ${dedupKey} AND ${reviewDeferrals.status} = 'claimed'`);
}

export async function claimReviewDeferralPg(
  store: PgStoreDb,
  dedupKey: string,
): Promise<ReviewDeferralRow | undefined> {
  const rows = await store.db
    .update(reviewDeferrals)
    .set({
      status: "claimed",
      attempts: sql`${reviewDeferrals.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(sql`${reviewDeferrals.dedupKey} = ${dedupKey} AND ${reviewDeferrals.status} = 'pending'`)
    .returning();
  return rows[0];
}

export async function deleteReviewDeferralPg(store: PgStoreDb, dedupKey: string): Promise<void> {
  await store.db.delete(reviewDeferrals).where(eq(reviewDeferrals.dedupKey, dedupKey));
}

export async function listPendingReviewDeferralsPg(store: PgStoreDb): Promise<ReviewDeferralRow[]> {
  return store.db
    .select()
    .from(reviewDeferrals)
    .where(eq(reviewDeferrals.status, "pending"))
    .orderBy(asc(reviewDeferrals.notBefore));
}

export async function resetClaimedReviewDeferralsPg(store: PgStoreDb): Promise<number> {
  const updated = await store.db
    .update(reviewDeferrals)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(reviewDeferrals.status, "claimed"))
    .returning({ dedupKey: reviewDeferrals.dedupKey });
  return updated.length;
}
