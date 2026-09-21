/**
 * Redis AutoCommitStore conformance.
 *
 * Runs the shared conformance suite against a real Redis service only when
 * AICR_REDIS_TEST_URL is set (e.g. `redis://localhost:6379/15`). Without a
 * real Redis service this file stays skipped.
 *
 * Verified 2026-09-09 against a real Redis 5.0.14.1 (tporadowski Windows
 * port, loopback, AOF everysec): 15/15 conformance, plus scheduler parity
 * and disconnect/AOF-recovery drills (F10) — evidence in
 * build/logs/auto-commit/redis-live-drill.log and the implementation plan
 * §1.2. Delayed/outbox timing, lease lifecycle, and fairness rotation were
 * exercised against the live server through the shared suite.
 *
 * Each store instance gets a unique random keyPrefix, so tests are isolated
 * without FLUSHDB and are safe to run against a shared test server.
 */

import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import type { AutoCommitStore, CommitBatchRecord } from "../src/auto-commit-store.js";
import { createRedisAutoCommitStore } from "../src/redis-auto-commit-store.js";

import { runAutoCommitStoreConformance } from "./auto-commit-store-conformance.js";

const REDIS_TEST_URL = process.env.AICR_REDIS_TEST_URL;

if (REDIS_TEST_URL) {
  const stores: AutoCommitStore[] = [];
  it("backfills legacy history indexes and pages protected rows past expired history after restart", async () => {
    // Match the optional runtime import: ioredis is not a required backend.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("ioredis");
    const RedisCtor = mod.Redis ?? mod.default ?? mod;
    const client = new RedisCtor(REDIS_TEST_URL);
    const keyPrefix = `aicr-test:${randomUUID()}:`;
    const prefix = `${keyPrefix}ac:`;
    const keys: string[] = [];
    const now = Date.now();
    try {
      for (let i = 0; i < 5; i++) {
        const id = `legacy-${i}`;
        const batch: CommitBatchRecord = { batchId: id, runId: id, streamId: id, workspaceId: "ws", triggerName: "git", vcs: "git",
          sourceNamespace: "repo", scopeRef: "main", historyGeneration: 0, sourceKey: "author", members: [], base: "a", head: "b",
          exclusionPolicyVersion: "test", configPolicyVersion: "test", configSnapshotId: null, executionCheckpoint: null,
          status: i === 0 ? "dead" : "completed", attempt: 1, maxAttempts: 3, recoveryAttempt: 0,
          retryNotBefore: null, leaseToken: null, leaseOwner: null, leaseExpiry: null, lastError: null, createdAt: now + i };
        const key = `${prefix}batch:${id}`;
        keys.push(key);
        await client.hset(key, "data", JSON.stringify(batch), "status", batch.status);
      }
      keys.push(`${prefix}stream:legacy-0`);
      await client.hset(keys.at(-1), "data", JSON.stringify({ activeBatchId: "legacy-0" }));
      let store = await createRedisAutoCommitStore({ connection: { url: REDIS_TEST_URL }, keyPrefix });
      stores.push(store);
      expect((await store.readBatchesByStatus(["completed", "dead"], 2, 1)).map(row => row.batchId)).toEqual(["legacy-3", "legacy-2"]);
      await store.close?.();
      store = await createRedisAutoCommitStore({ connection: { url: REDIS_TEST_URL }, keyPrefix });
      stores.push(store);
      const policy = { maxCount: 1, before: now };
      expect((await store.readBatchesByStatus(["completed", "dead"], 1, 1, policy)).map(row => row.batchId)).toEqual(["legacy-0"]);
      // A protected oldest row cannot starve bounded cleanup forever.
      expect(await store.pruneBatchHistory(1, now, 1)).toBe(0);
      expect(await store.pruneBatchHistory(1, now, 1)).toBe(1);
      expect(await store.readBatch("legacy-0")).toBeDefined();
      expect(await store.readBatch("legacy-1")).toBeUndefined();
    } finally {
      keys.push(...["completed", "dead", "terminal", "ready", "pruneCursor"].map(name => `${prefix}idx:batch:${name}`));
      await client.del(...keys);
      await client.quit();
    }
  });
  afterAll(() => {
    for (const store of stores) {
      store.close?.();
    }
  });
  runAutoCommitStoreConformance({
    backendKind: "redis",
    makeStore: async () => {
      const store = await createRedisAutoCommitStore({
        connection: { url: REDIS_TEST_URL },
        keyPrefix: `aicr-test:${randomUUID()}:`,
      });
      stores.push(store);
      return store;
    },
  });
} else {
  describe.skip("AutoCommitStore conformance [redis] (AICR_REDIS_TEST_URL not set)", () => {
    it("requires a real Redis service; see file header", () => {});
  });
}
