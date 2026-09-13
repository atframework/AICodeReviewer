import { expect } from "vitest";
import type { StoreDb } from "../src/database.js";
import { compactReflectionMemory, readReflectionMemory, writeReflectionMemory } from "../src/reflection.js";

export async function assertReflectionLimits(store: StoreDb): Promise<void> {
  const now = Date.now();
  await writeReflectionMemory(store, [
    { workspaceId: "bounded", fingerprint: "new", content: "中", createdAt: new Date(now - 10) },
    { workspaceId: "bounded", fingerprint: "next", content: "é", createdAt: new Date(now - 20) },
    { workspaceId: "bounded", fingerprint: "overflow", content: "a", createdAt: new Date(now - 30) },
    { workspaceId: "bounded", fingerprint: "expired", content: "expired", createdAt: new Date(now - 1), expiresAt: new Date(now - 1) },
    { workspaceId: "bounded", fingerprint: "retention", content: "old", createdAt: new Date(now - 2 * 86_400_000) },
    { workspaceId: "other", fingerprint: "isolated", content: "unchanged", createdAt: new Date(now) },
  ]);
  expect(await compactReflectionMemory(store, "bounded", { maxEntries: 100, maxBytes: 5, retentionDays: 1 })).toBe(3);
  expect((await readReflectionMemory(store, "bounded")).map(row => row.fingerprint)).toEqual(["new", "next"]);
  expect(await compactReflectionMemory(store, "bounded", { maxEntries: 1, maxBytes: 5, retentionDays: 1 })).toBe(1);
  expect((await readReflectionMemory(store, "bounded"))[0]?.content).toBe("中");
  expect(await readReflectionMemory(store, "other")).toHaveLength(1);
}
