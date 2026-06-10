import { eq, and, lt, desc } from "drizzle-orm";

import { reflectionMemory } from "./schema.js";
import type { StoreDb } from "./database.js";

export interface ReflectionMemoryEntry {
  readonly workspaceId: string;
  readonly fingerprint: string;
  readonly content: string;
  readonly sourceRunId?: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
}

export async function writeReflectionMemory(
  store: StoreDb,
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
    const existing = store.db
      .select({ id: reflectionMemory.id })
      .from(reflectionMemory)
      .where(
        and(
          eq(reflectionMemory.workspaceId, entry.workspaceId),
          eq(reflectionMemory.fingerprint, entry.fingerprint),
        ),
      )
      .get();

    if (existing) {
      store.db
        .update(reflectionMemory)
        .set({
          content: value.content,
          sourceRunId: value.sourceRunId,
          createdAt: value.createdAt,
          expiresAt: value.expiresAt,
        })
        .where(eq(reflectionMemory.id, existing.id))
        .run();
    } else {
      store.db.insert(reflectionMemory).values(value).run();
    }
  }
}

export async function readReflectionMemory(
  store: StoreDb,
  workspaceId: string,
  options?: { limit?: number },
): Promise<ReflectionMemoryEntry[]> {
  const limit = options?.limit ?? 50;
  const now = Date.now();

  const rows = store.db
    .select()
    .from(reflectionMemory)
    .where(eq(reflectionMemory.workspaceId, workspaceId))
    .orderBy(desc(reflectionMemory.createdAt))
    .limit(limit)
    .all();

  return rows
    .filter((row: { expiresAt: Date | null }) => {
      if (row.expiresAt === null) return true;
      return row.expiresAt.getTime() > now;
    })
    .map((row: { workspaceId: string; fingerprint: string; content: string; sourceRunId: string | null; createdAt: Date; expiresAt: Date | null }) => ({
      workspaceId: row.workspaceId,
      fingerprint: row.fingerprint,
      content: row.content,
      ...(row.sourceRunId ? { sourceRunId: row.sourceRunId } : {}),
      createdAt: row.createdAt,
      ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    }));
}

export async function compactReflectionMemory(
  store: StoreDb,
  workspaceId: string,
  options?: { retentionDays?: number; maxEntries?: number },
): Promise<number> {
  const retentionDays = options?.retentionDays ?? 90;
  const maxEntries = options?.maxEntries ?? 500;
  let deleted = 0;

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const expiredResult = store.db
    .delete(reflectionMemory)
    .where(
      and(
        eq(reflectionMemory.workspaceId, workspaceId),
        lt(reflectionMemory.expiresAt, cutoff),
      ),
    )
    .run();
  deleted += expiredResult.changes;

  const excessRows = store.db
    .select({ id: reflectionMemory.id })
    .from(reflectionMemory)
    .where(eq(reflectionMemory.workspaceId, workspaceId))
    .orderBy(desc(reflectionMemory.createdAt))
    .offset(maxEntries)
    .limit(1000)
    .all();

  if (excessRows.length > 0) {
    const idsToDelete = excessRows.map((row: { id: number }) => row.id);
    for (const id of idsToDelete) {
      store.db
        .delete(reflectionMemory)
        .where(eq(reflectionMemory.id, id))
        .run();
    }
    deleted += idsToDelete.length;
  }

  return deleted;
}
