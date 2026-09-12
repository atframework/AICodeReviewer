import { describe, expect, it } from "vitest";

import { sweepUnreferencedConfigSnapshots } from "../src/config-snapshot-retention.js";
import { createMemoryConfigStore } from "../src/config-store.js";

const T0 = 1_800_000_000_000;
const NS = "retention-test";

async function storeWithSnapshots(ids: readonly string[]) {
  const store = createMemoryConfigStore();
  await store.commitChangeset({
    namespace: NS,
    baseRevision: null,
    fileDigest: "fd",
    operationId: "op-1",
    actor: "test",
    document: { formatVersion: 1, entities: {}, globals: {} },
    formatVersion: 1,
    audit: { action: "publish", entityRefs: [], redactedDiff: {} },
    now: T0,
  });
  for (const id of ids) {
    await store.writeSnapshot({
      id,
      namespace: NS,
      fileDigest: "fd",
      databaseRevision: 1,
      resolverVersion: 1,
      sanitizedEffectiveConfig: {},
      contentHash: `hash-${id}`,
      now: T0,
    });
  }
  return store;
}

describe("sweepUnreferencedConfigSnapshots", () => {
  it("deletes only candidates no reference source lists", async () => {
    const store = await storeWithSnapshots(["snap-old", "snap-live", "snap-new"]);
    const result = await sweepUnreferencedConfigSnapshots(store, {
      namespace: NS,
      olderThan: T0 + 1000,
      now: T0 + 2000,
      referencedBy: [{ listActiveConfigSnapshotIds: () => Promise.resolve(["snap-live"]) }],
    });
    expect(result.deleted).toEqual(["snap-old", "snap-new"]);
    expect(result.kept).toEqual(["snap-live"]);
    expect(await store.readSnapshot("snap-live")).not.toBeNull();
    expect(await store.readSnapshot("snap-old")).toBeNull();
  });

  it("unions references across sources", async () => {
    const store = await storeWithSnapshots(["snap-a", "snap-b", "snap-c"]);
    const result = await sweepUnreferencedConfigSnapshots(store, {
      namespace: NS,
      olderThan: T0,
      now: T0,
      referencedBy: [
        { listActiveConfigSnapshotIds: () => Promise.resolve(["snap-a"]) },
        { listActiveConfigSnapshotIds: () => Promise.resolve(["snap-b"]) },
      ],
    });
    expect(result.deleted).toEqual(["snap-c"]);
    expect(result.kept.sort()).toEqual(["snap-a", "snap-b"]);
  });

  it("never sweeps pinned or refcounted rows even when unreferenced", async () => {
    const store = await storeWithSnapshots(["snap-pinned", "snap-busy"]);
    await store.setSnapshotPinned("snap-pinned", true);
    await store.adjustSnapshotRefCount("snap-busy", +2);
    const result = await sweepUnreferencedConfigSnapshots(store, {
      namespace: NS,
      olderThan: T0,
      now: T0,
      referencedBy: [],
    });
    expect(result.deleted).toEqual([]);
    expect(await store.readSnapshot("snap-pinned")).not.toBeNull();
    expect(await store.readSnapshot("snap-busy")).not.toBeNull();
  });

  it("respects the age cutoff and the candidate limit", async () => {
    const store = await storeWithSnapshots(["snap-1", "snap-2", "snap-3"]);
    const young = await sweepUnreferencedConfigSnapshots(store, {
      namespace: NS,
      olderThan: T0 - 1,
      now: T0,
      referencedBy: [],
    });
    expect(young.deleted).toEqual([]);
    const limited = await sweepUnreferencedConfigSnapshots(store, {
      namespace: NS,
      olderThan: T0,
      now: T0,
      limit: 2,
      referencedBy: [],
    });
    expect(limited.deleted).toHaveLength(2);
  });

  it("keeps a snapshot pinned between listing and deletion (race-safe)", async () => {
    const store = await storeWithSnapshots(["snap-race"]);
    // A racing executor pins the candidate after the candidate listing but
    // before delete: the store-side guard turns the delete into a kept skip.
    const originalDelete = store.deleteSnapshot.bind(store);
    let intercepted = false;
    const racing = {
      ...store,
      deleteSnapshot: async (id: string) => {
        if (!intercepted) {
          intercepted = true;
          await store.setSnapshotPinned(id, true);
        }
        return originalDelete(id);
      },
    };
    const result = await sweepUnreferencedConfigSnapshots(racing, {
      namespace: NS,
      olderThan: T0,
      now: T0,
      referencedBy: [],
    });
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual(["snap-race"]);
  });
});
