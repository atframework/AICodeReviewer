/**
 * PostgreSQL branch of reflection memory (reflection.ts). Same
 * upsert-by-fingerprint, expiry filtering, and retention compaction contract.
 */

import { and, desc, eq } from "drizzle-orm";

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
  options?: { retentionDays?: number; maxEntries?: number; maxBytes?: number },
): Promise<number> {
  const retentionDays = options?.retentionDays ?? 90;
  const maxEntries = options?.maxEntries ?? 500;
  const now = Date.now();
  const result = await store.pool.query(`DELETE FROM reflection_memory WHERE workspace_id = $1 AND
    (expires_at < $2 OR created_at < $3 OR id IN (
      SELECT id FROM (SELECT id,
        ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS position,
        SUM(octet_length(content)) OVER (ORDER BY created_at DESC, id DESC) AS bytes
        FROM reflection_memory WHERE workspace_id = $1 AND (expires_at IS NULL OR expires_at >= $2) AND created_at >= $3) ranked
      WHERE position > $4 OR bytes > $5))`,
    [workspaceId, now, now - retentionDays * 86_400_000, maxEntries, options?.maxBytes ?? Number.MAX_SAFE_INTEGER]);
  return result.rowCount ?? 0;
}
