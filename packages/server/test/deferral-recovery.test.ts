import { createReviewEvent } from "@aicr/core";
import { closeStoreDb, createStoreDb, getReviewDeferral, listPendingReviewDeferrals, type ReviewDeferralRow, type StoreDb } from "@aicr/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeDeferralKey, ReviewDeferralManager, type DeferredTriggerTarget } from "../src/deferral-manager.js";

function target(headSha = "head"): DeferredTriggerTarget {
  return {
    provider: "gitea", eventName: "pull_request", decoded: { action: "opened" },
    reviewEvent: createReviewEvent({
      provider: "gitea", triggerName: "gitea", workspaceId: "ws", repoRef: "owner/repo",
      targetKind: "pull_request", branch: "feature", headSha, author: {}, reason: "gitea:opened",
    }),
  };
}

describe("deferral failure and deadline recovery", () => {
  let store: StoreDb;
  beforeEach(() => {
    store = createStoreDb(":memory:");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    (await closeStoreDb(store));
  });

  it.each([true, false])("keeps the latest envelope without moving the timer earlier (persistent=%s)", async (persistent) => {
    const manager = new ReviewDeferralManager(persistent ? { store } : {});
    const resume = vi.fn();
    manager.resumeHandler = resume;
    manager.defer(target("old"), 10_000);
    manager.defer(target("latest"), 5_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resume).toHaveBeenCalledExactlyOnceWith(target("latest"));
    expect((await listPendingReviewDeferrals(store))).toEqual([]);
  });

  it("uses the latest memory fallback when an upsert fails over an older persisted row", async () => {
    const manager = new ReviewDeferralManager({ store });
    const resume = vi.fn();
    manager.resumeHandler = resume;
    manager.defer(target("old"), 100);
    vi.spyOn(store.db, "insert").mockImplementationOnce(() => { throw new Error("disk full"); });
    manager.defer(target("latest"), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(resume).toHaveBeenCalledExactlyOnceWith(target("latest"));
    expect((await getReviewDeferral(store, computeDeferralKey(target().reviewEvent)))).toBeUndefined();
  });

  it("does not discard a durable event when reading fails transiently", async () => {
    const manager = new ReviewDeferralManager({ store });
    const resume = vi.fn();
    manager.resumeHandler = resume;
    manager.defer(target(), 100);
    vi.spyOn(store.db, "select").mockImplementationOnce(() => { throw new Error("database busy"); });
    await vi.advanceTimersByTimeAsync(100);
    expect(resume).not.toHaveBeenCalled();
    expect((await listPendingReviewDeferrals(store))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("retains a claimed row until the scheduling handoff succeeds", async () => {
    const manager = new ReviewDeferralManager({ store });
    const key = computeDeferralKey(target().reviewEvent);
    // The manager treats the handler as synchronous: the throw must stay
    // synchronous, so capture the claimed-row read and assert on it below.
    let claimedRow: Promise<ReviewDeferralRow | undefined> | undefined;
    const resume = vi.fn().mockImplementationOnce(() => {
      claimedRow = getReviewDeferral(store, key);
      throw new Error("handoff failed");
    });
    manager.resumeHandler = resume;
    manager.defer(target(), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect((await claimedRow!)?.status).toBe("claimed");
    expect((await getReviewDeferral(store, key))?.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(5000);
    expect(resume).toHaveBeenCalledTimes(2);
    expect((await getReviewDeferral(store, key))).toBeUndefined();
  });

  it("preserves a replacement row when the resume handler re-defers", async () => {
    const manager = new ReviewDeferralManager({ store });
    const resume = vi.fn().mockImplementationOnce(() => manager.defer(target("new"), 1000));
    manager.resumeHandler = resume;
    manager.defer(target(), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect((await listPendingReviewDeferrals(store))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(resume).toHaveBeenLastCalledWith(target("new"));
    expect((await listPendingReviewDeferrals(store))).toEqual([]);
  });

  it("re-arms long waits instead of executing at Node's maximum timer delay", async () => {
    const manager = new ReviewDeferralManager({ store });
    const resume = vi.fn();
    manager.resumeHandler = resume;
    manager.defer(target(), 2_147_483_647 + 1000);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("drops corrupt envelopes without blocking an unrelated target", async () => {
    const manager = new ReviewDeferralManager({ store });
    const resume = vi.fn();
    manager.resumeHandler = resume;
    manager.defer(target(), 100);
    store.sqlite.prepare("UPDATE review_deferrals SET review_event = ?").run("broken JSON");
    const other = { ...target(), reviewEvent: createReviewEvent({ ...target().reviewEvent, branch: "other" }) };
    manager.defer(other, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(resume).toHaveBeenCalledExactlyOnceWith(other);
    expect((await listPendingReviewDeferrals(store))).toEqual([]);
  });
});
