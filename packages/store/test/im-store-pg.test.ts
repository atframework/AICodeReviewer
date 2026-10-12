import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeStoreDb, createStoreDb, type PgStoreDb } from "../src/database.js";
import { runImStoreConformance } from "./im-store-conformance.js";

/**
 * IM-09 R02–R06 on the real PostgreSQL backend. Skips without
 * AICR_PG_TEST_URL; a partially configured environment fails (never a silent
 * mock pass).
 */

const PG_URL = process.env.AICR_PG_TEST_URL;
const suite = PG_URL ? describe : describe.skip;

let store: PgStoreDb;
let schema: string;

beforeEach(async () => {
  schema = `im_conformance_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  store = await createStoreDb({ kind: "postgres", url: PG_URL!, schema });
});

afterEach(async () => {
  await closeStoreDb(store);
});

suite("im store conformance [postgres]", () => {
  it("bounds a blocked admission statement below one second and rolls back the inbox", async () => {
    const { acceptImDelivery } = await import("../src/im-store.js");
    const lock = await store.pool.connect();
    const key = `blocked-${randomUUID()}`;
    try {
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE im_inbox IN ACCESS EXCLUSIVE MODE");
      const started = performance.now();
      await expect(acceptImDelivery(store, {
        delivery: { namespace: "deadline", connectionIdentity: "social", deliveryKind: "message", deliveryKey: key, payloadDigest: "d" },
        now: new Date(), deadlineAt: Date.now() + 1000, signal: AbortSignal.timeout(1000),
      })).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    const rows = await store.pool.query<{ count: string }>("SELECT count(*) FROM im_inbox WHERE delivery_key = $1", [key]);
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("accepts, merges, fences, dispatches and retains atomically (R02–R06)", async () => {
    await runImStoreConformance(store);
  });

  it("reuses the same delivery semantics across concurrent connections", async () => {
    const second = await createStoreDb({ kind: "postgres", url: PG_URL!, schema });
    try {
      const { acceptImDelivery } = await import("../src/im-store.js");
      const delivery = {
        delivery: {
          namespace: "ns-concurrent",
          connectionIdentity: "wecom-app:ww:1",
          deliveryKind: "message" as const,
          deliveryKey: `msg-${randomUUID()}`,
          payloadDigest: "sha256:same",
        },
        now: new Date(),
      };
      const results = await Promise.all([
        acceptImDelivery(store, delivery),
        acceptImDelivery(second, delivery),
      ]);
      const kinds = results.map(result => result.kind).sort();
      // One creation wins the unique constraint; the concurrent insert either
      // sees the row as a duplicate or (worst case) as a same-digest replay.
      expect(kinds).toContain("created");
      expect(kinds.every(kind => kind === "created" || kind === "duplicate")).toBe(true);
    } finally {
      await closeStoreDb(second);
    }
  });
});
