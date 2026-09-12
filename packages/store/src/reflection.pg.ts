/**
 * PostgreSQL branch of reflection memory (reflection.ts). Same
 * upsert-by-fingerprint, expiry filtering, and retention compaction contract.
 */

import { and, desc, eq, lt } from "drizzle-orm";

import type { PgStoreDb } from "./database.js";
import { reflectionMemory } from "./schema.pg.js";
import type { ReflectionMemoryEntry } from "./reflection.js";

export async function writeReflectionMemoryPg(
  store: PgStoreDb,
  entries: readonly ReflectionMemoryEntry[],
): Promise<void> {
  if (entries.length === 0) return;

  for (const entry of entries) {
    const value = {
      workspaceId: entry.workspaceId,
      fingerprint: entry.fingerprint,
      content: entry.content,
      sourceRunId: entry.sourceRunId ?? null,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt ?? null,
    };
    const existing = (
      await store.db
        .select({ id: reflectionMemory.id, occurrenceCount: reflectionMemory.occurrenceCount })
        .from(reflectionMemory)
        .where(
          and(
            eq(reflectionMemory.workspaceId, entry.workspaceId),
            eq(reflectionMemory.fingerprint, entry.fingerprint),
          ),
        )
    )[0];

    if (existing) {
      await store.db
        .update(reflectionMemory)
        .set({
          content: value.content,
          sourceRunId: value.sourceRunId,
          createdAt: value.createdAt,
          expiresAt: value.expiresAt,
          occurrenceCount: existing.occurrenceCount + 1,
        })
        .where(eq(reflectionMemory.id, existing.id));
    } else {
      await store.db.insert(reflectionMemory).values(value);
    }
  }
}

export async function readReflectionMemoryPg(
  store: PgStoreDb,
  workspaceId: string,
  options?: { limit?: number },
): Promise<ReflectionMemoryEntry[]> {
  const limit = options?.limit ?? 50;
  const now = Date.now();

  const rows = await store.db
    .select()
    .from(reflectionMemory)
    .where(eq(reflectionMemory.workspaceId, workspaceId))
    .orderBy(desc(reflectionMemory.createdAt))
    .limit(limit);

  return rows
    .filter((row) => {
      if (row.expiresAt === null) return true;
      return row.expiresAt.getTime() > now;
    })
    .map((row) => ({
      workspaceId: row.workspaceId,
      fingerprint: row.fingerprint,
      content: row.content,
      ...(row.sourceRunId ? { sourceRunId: row.sourceRunId } : {}),
      createdAt: row.createdAt,
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
      occurrenceCount: row.occurrenceCount,
    }));
}

export async function compactReflectionMemoryPg(
  store: PgStoreDb,
  workspaceId: string,
  options?: { retentionDays?: number; maxEntries?: number },
): Promise<number> {
  const retentionDays = options?.retentionDays ?? 90;
  const maxEntries = options?.maxEntries ?? 500;
  let deleted = 0;

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const expiredRows = await store.db
    .delete(reflectionMemory)
    .where(
      and(
        eq(reflectionMemory.workspaceId, workspaceId),
        lt(reflectionMemory.expiresAt, cutoff),
      ),
    )
    .returning({ id: reflectionMemory.id });
  deleted += expiredRows.length;

  const excessRows = await store.db
    .select({ id: reflectionMemory.id })
    .from(reflectionMemory)
    .where(eq(reflectionMemory.workspaceId, workspaceId))
    .orderBy(desc(reflectionMemory.createdAt))
    .offset(maxEntries)
    .limit(1000);

  if (excessRows.length > 0) {
    const idsToDelete = excessRows.map((row) => row.id);
    for (const id of idsToDelete) {
      await store.db
        .delete(reflectionMemory)
        .where(eq(reflectionMemory.id, id));
    }
    deleted += idsToDelete.length;
  }

  return deleted;
}
