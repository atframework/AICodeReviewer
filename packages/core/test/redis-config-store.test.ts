/**
 * Redis ConfigStore conformance (P2).
 *
 * Runs the shared ConfigStore suite against a real Redis service only when
 * AICR_REDIS_TEST_URL is set (e.g. `redis://127.0.0.1:6379`). Without a real
 * service this file stays skipped.
 *
 * Each store instance gets a unique random key prefix, and afterAll closes
 * every connection and SCAN+UNLINKs those prefixes, so the file is isolated
 * without FLUSHDB and safe to run against a shared test server.
 */

import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import type { CommitChangesetInput, ConfigStore, WriteSnapshotInput } from "../src/config-store.js";
import { isConfigError } from "../src/config-format.js";
import { createRedisConfigStore } from "../src/redis-config-store.js";

import { runConfigStoreConformance } from "./config-store-conformance.js";

const REDIS_TEST_URL = process.env.AICR_REDIS_TEST_URL;
const REDIS_OOM_TEST_URL = process.env.AICR_REDIS_OOM_TEST_URL;

if (REDIS_TEST_URL) {
  const stores: ConfigStore[] = [];
  const prefixes: string[] = [];

  afterAll(async () => {
    await Promise.allSettled(stores.map((store) => store.close()));
    // Remove every test key: unique prefixes make SCAN+UNLINK precise and
    // avoid FLUSHDB on a shared server. ioredis is loaded dynamically here
    // as well (optionalDependency; absent unless the Redis backend is used).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("ioredis");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const RedisCtor: any = mod.Redis ?? mod.default ?? mod;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = new RedisCtor(REDIS_TEST_URL);
    try {
      for (const prefix of prefixes) {
        let cursor = "0";
        do {
          const [next, keys] = (await client.scan(
            cursor,
            "MATCH",
            `${prefix}*`,
            "COUNT",
            200,
          )) as [string, string[]];
          cursor = next;
          if (keys.length > 0) {
            await client.unlink(...keys);
          }
        } while (cursor !== "0");
      }
    } finally {
      await client.quit();
    }
  });

  runConfigStoreConformance({
    backendKind: "redis",
    makeStore: async () => {
      const prefix = `aicr:config:test:${randomUUID()}:`;
      const store = await createRedisConfigStore({
        connection: { url: REDIS_TEST_URL },
        prefix,
      });
      prefixes.push(prefix);
      stores.push(store);
      return store;
    },
  });
  describe("Redis failure boundaries (M11)", () => {
    function changeset(namespace: string): CommitChangesetInput {
      return {
        namespace,
        baseRevision: null,
        fileDigest: "file-digest-1",
        operationId: `op-${randomUUID()}`,
        actor: "admin@example.com",
        document: { formatVersion: 1, entities: { providers: { p1: { enabled: true, value: { kind: "openai_compatible" } } } }, globals: {} },
        formatVersion: 1,
        audit: { action: "publish", entityRefs: [], redactedDiff: {} },
        now: Date.now(),
      };
    }

    it("surfaces WRONGTYPE state keys as bounded store_unavailable errors, never a hang", async () => {
      const prefix = `aicr:config:test:${randomUUID()}:`;
      prefixes.push(prefix);
      const { Redis } = await import("ioredis");
      const raw = new Redis(REDIS_TEST_URL!);
      try {
        // A poisoned head key of the wrong type in this namespace.
        await raw.set(`${prefix}{ns-m11}:head`, "not-a-hash");
        const store = await createRedisConfigStore({ connection: { url: REDIS_TEST_URL! }, prefix });
        stores.push(store);
        await expect(store.readHead("ns-m11")).rejects.toSatisfy(
          (error: unknown) => isConfigError(error, "store_unavailable"),
        );
        await expect(store.commitChangeset(changeset("ns-m11"))).rejects.toSatisfy(
          (error: unknown) => isConfigError(error, "store_unavailable"),
        );
      } finally {
        await raw.quit();
      }
    });

    it.each(["rev:z", "audit:z", "generation-invalid", "generation-overflow"])("rejects %s corruption before any revision/audit/index write", async (corruption) => {
      const prefix = `aicr:config:test:${randomUUID()}:`;
      prefixes.push(prefix);
      const { Redis } = await import("ioredis");
      const raw = new Redis(REDIS_TEST_URL!);
      const store = await createRedisConfigStore({ connection: { url: REDIS_TEST_URL! }, prefix });
      stores.push(store);
      try {
        if (corruption.startsWith("generation")) {
          await raw.hset(`${prefix}{ns}:head`, "generation", corruption === "generation-invalid" ? "bad" : "9223372036854775807");
        } else {
          await raw.set(`${prefix}{ns}:${corruption}`, "wrong-type");
        }
        const before = (await raw.keys(`${prefix}*`)).sort();
        await expect(store.commitChangeset(changeset("ns"))).rejects.toSatisfy((error: unknown) => isConfigError(error, "store_unavailable"));
        expect((await raw.keys(`${prefix}*`)).sort()).toEqual(before);
        expect(await raw.hget(`${prefix}{ns}:head`, "active_revision")).toBeNull();
        expect(await store.readRevision("ns", 1)).toBeNull();
      } finally { await raw.quit(); }
    });

    it("preserves decimal generation precision beyond JavaScript integers", async () => {
      const prefix = `aicr:config:test:${randomUUID()}:`;
      prefixes.push(prefix);
      const { Redis } = await import("ioredis");
      const raw = new Redis(REDIS_TEST_URL!);
      const store = await createRedisConfigStore({ connection: { url: REDIS_TEST_URL! }, prefix });
      stores.push(store);
      try {
        await raw.hset(`${prefix}{ns}:head`, "generation", "9007199254740992");
        const result = await store.commitChangeset(changeset("ns"));
        expect(result.head.generation).toBe("9007199254740993");
        expect((await store.readHead("ns"))?.generation).toBe(result.head.generation);
      } finally { await raw.quit(); }
    });

    it.skipIf(!REDIS_OOM_TEST_URL)("rejects writes under OOM without moving the head (dedicated instance)", async () => {
      const prefix = `aicr:config:test:${randomUUID()}:`;
      const { Redis } = await import("ioredis");
      const raw = new Redis(REDIS_OOM_TEST_URL!);
      const store = await createRedisConfigStore({ connection: { url: REDIS_OOM_TEST_URL! }, prefix });
      try {
        // Reject an accidentally shared endpoint before changing server config.
        const regular = new Redis(REDIS_TEST_URL!);
        try {
          const runId = /run_id:([^\r\n]+)/u;
          const oomId = runId.exec(await raw.info("server"))?.[1];
          const regularId = runId.exec(await regular.info("server"))?.[1];
          expect(oomId).toBeTruthy();
          expect(regularId).toBeTruthy();
          expect(oomId).not.toBe(regularId);
        } finally { regular.disconnect(); }
        const committed = await store.commitChangeset(changeset("ns-m11-oom"));
        expect(committed.status).toBe("committed");

        // CONFIG affects the entire server, including all logical databases.
        // This URL must identify a dedicated instance, never the shared suite.
        const previous = (await raw.config("GET", "maxmemory")) as [string, string];
        const policy = (await raw.config("GET", "maxmemory-policy")) as [string, string];
        try {
          await raw.config("SET", "maxmemory-policy", "noeviction");
          await raw.config("SET", "maxmemory", "1");
          await expect(
            store.commitChangeset({ ...changeset("ns-m11-oom"), baseRevision: 1, operationId: `op-${randomUUID()}` }),
          ).rejects.toThrow();
        } finally {
          await Promise.all([
            raw.config("SET", "maxmemory", previous[1]),
            raw.config("SET", "maxmemory-policy", policy[1]),
          ]);
        }

        // The failed publish never advanced the head: revision 1 is still active.
        const head = await store.readHead("ns-m11-oom");
        expect(head?.activeRevision).toBe(1);
        expect(await store.readRevision("ns-m11-oom", 2)).toBeNull();
      } finally {
        try {
          const keys = await raw.keys(`${prefix}*`);
          if (keys.length) await raw.unlink(...keys);
        } finally {
          await store.close();
          raw.disconnect();
        }
      }
    });
  });

  // Snapshot mutation races (spec §7.2), symmetric with the SQLite/Postgres
  // cases: every snapshot mutation here is one Lua script, so the dangerous
  // interleavings collapse into the same two legal linearizations.
  describe("redis config store snapshot races", () => {
    const T0 = 1_800_000_000_000;

    function snapshot(overrides: Partial<WriteSnapshotInput> = {}): WriteSnapshotInput {
      return {
        id: "snap-race",
        namespace: "test-ns-race",
        fileDigest: "file-digest-1",
        databaseRevision: 1,
        resolverVersion: 1,
        sanitizedEffectiveConfig: { llm: { providers: ["p1"] } },
        contentHash: "snap-hash-1",
        now: T0,
        ...overrides,
      };
    }

    async function makeStore(): Promise<ConfigStore> {
      const prefix = `aicr:config:test:${randomUUID()}:`;
      const store = await createRedisConfigStore({
        connection: { url: REDIS_TEST_URL },
        prefix,
      });
      prefixes.push(prefix);
      stores.push(store);
      return store;
    }

    it("checks the GC index before creating or deleting a snapshot", async () => {
      const prefix = `aicr:config:test:${randomUUID()}:`;
      prefixes.push(prefix);
      const { Redis } = await import("ioredis");
      const raw = new Redis(REDIS_TEST_URL!);
      const store = await createRedisConfigStore({ connection: { url: REDIS_TEST_URL! }, prefix });
      stores.push(store);
      const gcKey = `${prefix}{snap}:gc:test-ns-race`;
      try {
        await raw.set(gcKey, "wrong-type");
        await expect(store.writeSnapshot(snapshot())).rejects.toThrow();
        expect(await store.readSnapshot("snap-race")).toBeNull();
        await raw.del(gcKey);
        await store.writeSnapshot(snapshot());
        await raw.del(gcKey);
        await raw.set(gcKey, "wrong-type");
        await expect(store.deleteSnapshot("snap-race")).rejects.toThrow();
        expect(await store.readSnapshot("snap-race")).not.toBeNull();
      } finally { raw.disconnect(); }
    });

    it("T3: deleteSnapshot racing a ref-count landing never deletes a referenced row", async () => {
      const store = await makeStore();
      for (let round = 0; round < 5; round += 1) {
        const id = `snap-race-t3-${round}`;
        await store.writeSnapshot(snapshot({ id }));
        const [adjusted, deleted] = await Promise.allSettled([
          store.adjustSnapshotRefCount(id, +1),
          store.deleteSnapshot(id),
        ]);
        const surviving = await store.readSnapshot(id);
        if (deleted.status === "fulfilled") {
          // The delete won before the ref-count landed.
          expect(surviving).toBeNull();
          expect(adjusted.status).toBe("fulfilled");
          if (adjusted.status === "fulfilled") expect(adjusted.value).toBeNull();
        } else {
          // The ref-count won: the delete fails atomically, row survives.
          expect(isConfigError(deleted.reason, "snapshot_invalid")).toBe(true);
          expect(surviving?.refCount).toBe(1);
        }
      }
    });

    it("T4: concurrent writeSnapshot folds identical content into the stored record; different content loses with snapshot_invalid", async () => {
      const store = await makeStore();
      const identical = snapshot({ id: "snap-race-t4" });
      const [first, second] = await Promise.all([
        store.writeSnapshot(identical),
        store.writeSnapshot(identical),
      ]);
      expect(second).toEqual(first);
      expect(first.contentHash).toBe("snap-hash-1");

      const settled = await Promise.allSettled([
        store.writeSnapshot(snapshot({ id: "snap-race-t4b", contentHash: "snap-hash-x" })),
        store.writeSnapshot(snapshot({
          id: "snap-race-t4b",
          contentHash: "snap-hash-y",
          sanitizedEffectiveConfig: { llm: { providers: ["p2"] } },
        })),
      ]);
      const winner = settled.find((result) => result.status === "fulfilled");
      const loser = settled.find((result) => result.status === "rejected");
      expect(winner?.status).toBe("fulfilled");
      expect(loser?.status).toBe("rejected");
      if (winner?.status === "fulfilled" && loser?.status === "rejected") {
        expect(isConfigError(loser.reason, "snapshot_invalid")).toBe(true);
        expect((await store.readSnapshot("snap-race-t4b"))?.contentHash).toBe(winner.value.contentHash);
      }
    });
  });
} else {
  describe.skip("ConfigStore conformance [redis] (AICR_REDIS_TEST_URL not set)", () => {
    it("requires a real Redis service; see file header", () => {});
  });
}
