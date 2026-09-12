import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { isConfigError } from "../src/config-format.js";
import type { ConfigStore, WriteSnapshotInput } from "../src/config-store.js";
import { createSqliteConfigStore } from "../src/sqlite-config-store.js";

import { runConfigStoreConformance } from "./config-store-conformance.js";

const tempDirs: string[] = [];
const stores: ConfigStore[] = [];

afterAll(async () => {
  // Close before unlink: Windows refuses to delete a locked SQLite file.
  await Promise.allSettled(stores.map((store) => store.close()));
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function makeStore(): Promise<ConfigStore> {
  // Real on-disk file per factory call: the SQLite cases prove durable
  // commit points, not in-memory bookkeeping.
  const dir = await mkdtemp(join(tmpdir(), "aicr-config-store-"));
  tempDirs.push(dir);
  const store = await createSqliteConfigStore({ path: join(dir, "config.sqlite") });
  stores.push(store);
  return store;
}

describe("sqlite config store", () => {
  runConfigStoreConformance({
    backendKind: "sqlite",
    makeStore,
  });
});

// Snapshot mutation races (spec §7.2: a signed-out task's snapshot must
// never vanish under it, and writeSnapshot is idempotent per id).
// better-sqlite3 executes synchronously on one thread, so JS cannot
// interleave statements inside one method call; these cases pin the
// dangerous orderings and the atomic conditional-write outcomes the
// single-statement DELETE / INSERT OR IGNORE guarantee under any
// interleaving. Genuine statement-level races are covered by the
// env-gated PostgreSQL suite (real pool concurrency).
describe("sqlite config store snapshot races", () => {
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

  it("T3: deleteSnapshot losing to a landed ref-count throws snapshot_invalid and the referenced row survives", async () => {
    const store = await makeStore();
    await store.writeSnapshot(snapshot());
    // Pinned to the dangerous ordering: the ref-count lands first, then the
    // delete must lose atomically instead of deleting a referenced row.
    const [adjusted, deleted] = await Promise.allSettled([
      store.adjustSnapshotRefCount("snap-race", +1),
      store.deleteSnapshot("snap-race"),
    ]);
    expect(adjusted.status).toBe("fulfilled");
    expect(deleted.status).toBe("rejected");
    if (deleted.status === "rejected") {
      expect(isConfigError(deleted.reason, "snapshot_invalid")).toBe(true);
    }
    const surviving = await store.readSnapshot("snap-race");
    expect(surviving).not.toBeNull();
    expect(surviving?.refCount).toBe(1);
    // The survivor is fully intact: unpinning and releasing the reference
    // makes it deletable again.
    await store.adjustSnapshotRefCount("snap-race", -1);
    await store.deleteSnapshot("snap-race");
    expect(await store.readSnapshot("snap-race")).toBeNull();
  });

  it("T4: racing writeSnapshot folds identical content into the stored record; different content loses with snapshot_invalid", async () => {
    const store = await makeStore();
    const input = snapshot({ id: "snap-race-t4" });
    const [first, second] = await Promise.all([
      store.writeSnapshot(input),
      store.writeSnapshot(input),
    ]);
    expect(second).toEqual(first);
    expect(first.contentHash).toBe("snap-hash-1");

    const [winner, loser] = await Promise.allSettled([
      store.writeSnapshot(snapshot({ id: "snap-race-t4b", contentHash: "snap-hash-x" })),
      store.writeSnapshot(snapshot({
        id: "snap-race-t4b",
        contentHash: "snap-hash-y",
        sanitizedEffectiveConfig: { llm: { providers: ["p2"] } },
      })),
    ]);
    expect(winner.status).toBe("fulfilled");
    expect(loser.status).toBe("rejected");
    if (loser.status === "rejected") {
      expect(isConfigError(loser.reason, "snapshot_invalid")).toBe(true);
    }
    // The winner's row is the one that survives.
    expect((await store.readSnapshot("snap-race-t4b"))?.contentHash).toBe("snap-hash-x");
  });
});
