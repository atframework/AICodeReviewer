import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStoreDb, closeStoreDb, type SqliteStoreDb } from "../src/database.js";
import {
  upsertReviewDeferral,
  claimReviewDeferral,
  deleteReviewDeferral,
  listPendingReviewDeferrals,
  resetClaimedReviewDeferrals,
} from "../src/review-deferrals.js";

let tmpDir: string;
let store: SqliteStoreDb;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aicr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  store = createStoreDb(join(tmpDir, "test.db"));
});

afterEach(async () => {
  (await closeStoreDb(store));
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function deferral(overrides: Partial<Parameters<typeof upsertReviewDeferral>[1]> = {}) {
  return {
    dedupKey: "key-1",
    workspaceId: "ws-1",
    provider: "gitea",
    eventName: "pull_request",
    reviewEvent: JSON.stringify({ targetKind: "pull_request" }),
    payload: JSON.stringify({ action: "opened" }),
    notBefore: new Date(10_000),
    ...overrides,
  };
}

describe("review deferrals", () => {
  it("creates the review_deferrals table via migrations", async () => {
    const tables = store.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as Record<string, string>).name);
    expect(tables).toContain("review_deferrals");
  });

  it("upserts and lists pending deferrals ordered by not_before", async () => {
    (await upsertReviewDeferral(store, deferral({ dedupKey: "b", notBefore: new Date(20_000) })));
    (await upsertReviewDeferral(store, deferral({ dedupKey: "a", notBefore: new Date(10_000) })));

    const pending = (await listPendingReviewDeferrals(store));
    expect(pending.map((row) => row.dedupKey)).toEqual(["a", "b"]);
    expect(pending[0]!.status).toBe("pending");
    expect(pending[0]!.attempts).toBe(0);
  });

  it("replaces the envelope on conflict but never moves not_before earlier", async () => {
    (await upsertReviewDeferral(store, deferral({ notBefore: new Date(10_000) })));
    (await upsertReviewDeferral(store, deferral({
      reviewEvent: JSON.stringify({ targetKind: "pull_request", headSha: "newer" }),
      notBefore: new Date(5_000),
    })));

    let pending = (await listPendingReviewDeferrals(store));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reviewEvent).toContain("newer");
    expect(pending[0]!.notBefore.getTime()).toBe(10_000);

    (await upsertReviewDeferral(store, deferral({ notBefore: new Date(30_000) })));
    pending = (await listPendingReviewDeferrals(store));
    expect(pending[0]!.notBefore.getTime()).toBe(30_000);
  });

  it("claims a pending deferral atomically and refuses a second claim", async () => {
    (await upsertReviewDeferral(store, deferral()));

    const claimed = (await claimReviewDeferral(store, "key-1"));
    expect(claimed).toBeDefined();
    expect(claimed!.status).toBe("claimed");
    expect(claimed!.attempts).toBe(1);

    expect((await claimReviewDeferral(store, "key-1"))).toBeUndefined();
    expect((await listPendingReviewDeferrals(store))).toHaveLength(0);
  });

  it("resets claimed rows back to pending for startup recovery", async () => {
    (await upsertReviewDeferral(store, deferral()));
    expect((await claimReviewDeferral(store, "key-1"))).toBeDefined();

    const reset = (await resetClaimedReviewDeferrals(store));
    expect(reset).toBe(1);
    const pending = (await listPendingReviewDeferrals(store));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBe(1);
  });

  it("deletes a deferral once execution owns the outcome", async () => {
    (await upsertReviewDeferral(store, deferral()));
    (await deleteReviewDeferral(store, "key-1"));
    expect((await listPendingReviewDeferrals(store))).toHaveLength(0);
    expect((await claimReviewDeferral(store, "key-1"))).toBeUndefined();
  });
});
