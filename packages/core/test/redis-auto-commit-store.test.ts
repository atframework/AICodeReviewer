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

import { afterAll, describe, it } from "vitest";

import type { AutoCommitStore } from "../src/auto-commit-store.js";
import { createRedisAutoCommitStore } from "../src/redis-auto-commit-store.js";

import { runAutoCommitStoreConformance } from "./auto-commit-store-conformance.js";

const REDIS_TEST_URL = process.env.AICR_REDIS_TEST_URL;

if (REDIS_TEST_URL) {
  const stores: AutoCommitStore[] = [];
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
