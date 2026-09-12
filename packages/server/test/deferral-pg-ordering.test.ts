import { createReviewEvent } from "@aicr/core";
import { closeStoreDb, createStoreDb, getReviewDeferral, upsertReviewDeferral, type ReviewDeferralRow, type StoreDb } from "@aicr/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { computeDeferralKey, ReviewDeferralManager, type DeferredTriggerTarget } from "../src/deferral-manager.js";
import type * as AicrStore from "@aicr/store";

// Same module shape as production; upsertReviewDeferral is wrapped so the
// issuance timing relative to defer() is observable.
vi.mock("@aicr/store", async (importOriginal) => {
  const original = await importOriginal<typeof AicrStore>();
  return { ...original, upsertReviewDeferral: vi.fn(original.upsertReviewDeferral) };
});

const upsertMock = vi.mocked(upsertReviewDeferral);

function target(headSha = "head"): DeferredTriggerTarget {
  return {
    provider: "gitea", eventName: "pull_request", decoded: { action: "opened" },
    reviewEvent: createReviewEvent({
      provider: "gitea", triggerName: "gitea", workspaceId: "ws", repoRef: "owner/repo",
      targetKind: "pull_request", branch: "feature", headSha, author: {}, reason: "gitea:opened",
    }),
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  upsertMock.mockReset();
  vi.useRealTimers();
});

describe("deferral upsert ordering per backend", () => {
  it("a SQLite cancel followed immediately by defer preserves the new row", async () => {
    const store = createStoreDb(":memory:");
    const manager = new ReviewDeferralManager({ store });
    try {
      manager.defer(target("old"), Date.now() + 60_000);
      manager.cancel(target().reviewEvent);
      manager.defer(target("new"), Date.now() + 90_000);
      await flushMicrotasks();
      expect((await getReviewDeferral(store, computeDeferralKey(target().reviewEvent)))?.reviewEvent).toContain('"headSha":"new"');
    } finally { manager.stop(); await closeStoreDb(store); }
  });

  it("stop prevents a pending postgres upsert from rearming a timer", async () => {
    vi.useFakeTimers();
    const manager = new ReviewDeferralManager({ store: { kind: "postgres" } as StoreDb });
    let release!: () => void;
    upsertMock.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ notBefore: new Date(Date.now() + 1000) } as ReviewDeferralRow);
    }));
    manager.defer(target(), Date.now() + 1000);
    await flushMicrotasks();
    manager.stop();
    release();
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes consecutive same-key upserts on postgres", async () => {
    // A fake PG-kind store: only the manager's issuance timing is exercised,
    // so the upsert itself is gated by hand.
    const store = { kind: "postgres" } as unknown as StoreDb;
    const manager = new ReviewDeferralManager({ store });
    const first = target("head-1");
    const key = computeDeferralKey(first.reviewEvent);
    const gates: Array<() => void> = [];
    upsertMock.mockImplementation(((_store: StoreDb, row: { notBefore: Date }) =>
      new Promise<ReviewDeferralRow>((resolve) => {
        gates.push(() => resolve({ notBefore: row.notBefore } as unknown as ReviewDeferralRow));
      })) as typeof upsertReviewDeferral);

    try {
      manager.defer(first, 10_000);
      manager.defer(target("head-2"), 20_000);
      await flushMicrotasks();
      // The second upsert must not start while the first is in flight.
      expect(upsertMock).toHaveBeenCalledTimes(1);

      gates[0]!();
      await flushMicrotasks();
      expect(upsertMock).toHaveBeenCalledTimes(2);
      // The queued upsert carries the latest envelope for the key.
      expect(String((upsertMock.mock.calls[1]?.[1] as { reviewEvent: string }).reviewEvent)).toContain("head-2");
      expect((upsertMock.mock.calls[1]?.[1] as { dedupKey: string }).dedupKey).toBe(key);
    } finally {
      manager.stop();
    }
  });

  it("keeps the sqlite upsert synchronously visible", async () => {
    const store = createStoreDb(":memory:");
    const manager = new ReviewDeferralManager({ store });
    const deferred = target();
    try {
      manager.defer(deferred, 60_000);
      // No flush: issuance happens inside the defer() call itself.
      expect(upsertMock).toHaveBeenCalledTimes(1);
      expect(await getReviewDeferral(store, computeDeferralKey(deferred.reviewEvent))).toBeDefined();
    } finally {
      manager.stop();
      await closeStoreDb(store);
    }
  });
});
