/**
 * PostgreSQL branch of the model catalog cache (model-catalog.ts). Same
 * point/fuzzy reads and conflict-update writes as the sqlite implementation.
 */

import { eq } from "drizzle-orm";

import type { PgStoreDb } from "./database.js";
import { modelCatalog, modelCatalogSource } from "./schema.pg.js";
import {
  toModelCatalogRecord,
  type ModelCatalogRecord,
  type ModelCatalogSourceMeta,
} from "./model-catalog.js";

export async function getModelCatalogEntryPg(store: PgStoreDb, catalogId: string): Promise<ModelCatalogRecord | undefined> {
  const row = (
    await store.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.catalogId, catalogId))
  )[0];
  return row ? toModelCatalogRecord(row) : undefined;
}

export async function getModelCatalogEntriesByModelIdPg(store: PgStoreDb, modelId: string): Promise<ModelCatalogRecord[]> {
  const rows = await store.db
    .select()
    .from(modelCatalog)
    .where(eq(modelCatalog.modelId, modelId));
  return rows.map((row) => toModelCatalogRecord(row));
}

export async function listModelCatalogEntriesPg(store: PgStoreDb): Promise<ModelCatalogRecord[]> {
  const rows = await store.db.select().from(modelCatalog);
  return rows.map((row) => toModelCatalogRecord(row));
}

export async function upsertModelCatalogEntriesPg(store: PgStoreDb, records: readonly ModelCatalogRecord[]): Promise<void> {
  if (records.length === 0) return;
  await store.db.transaction(async (tx) => {
    for (const record of records) {
      const value = {
        catalogId: record.catalogId,
        providerId: record.providerId,
        modelId: record.modelId,
        data: record.data,
        source: record.source ?? null,
        fetchedAt: record.fetchedAt,
      };
      await tx
        .insert(modelCatalog)
        .values(value)
        .onConflictDoUpdate({
          target: modelCatalog.catalogId,
          set: {
            providerId: value.providerId,
            modelId: value.modelId,
            data: value.data,
            source: value.source,
            fetchedAt: value.fetchedAt,
          },
        });
    }
  });
}

export async function getModelCatalogSourceMetaPg(store: PgStoreDb, sourceUrl: string): Promise<ModelCatalogSourceMeta | undefined> {
  const row = (
    await store.db
      .select()
      .from(modelCatalogSource)
      .where(eq(modelCatalogSource.sourceUrl, sourceUrl))
  )[0];
  if (!row) return undefined;
  return {
    sourceUrl: row.sourceUrl,
    lastRefreshedAt: row.lastRefreshedAt,
    ...(row.etag ? { etag: row.etag } : {}),
  };
}

export async function listModelCatalogSourceMetasPg(store: PgStoreDb): Promise<ModelCatalogSourceMeta[]> {
  const rows = await store.db.select().from(modelCatalogSource);
  return rows.map((row) => ({
    sourceUrl: row.sourceUrl,
    lastRefreshedAt: row.lastRefreshedAt,
    ...(row.etag ? { etag: row.etag } : {}),
  }));
}

export async function setModelCatalogSourceMetaPg(store: PgStoreDb, meta: ModelCatalogSourceMeta): Promise<void> {
  const value = {
    sourceUrl: meta.sourceUrl,
    lastRefreshedAt: meta.lastRefreshedAt,
    etag: meta.etag ?? null,
  };
  await store.db
    .insert(modelCatalogSource)
    .values(value)
    .onConflictDoUpdate({
      target: modelCatalogSource.sourceUrl,
      set: {
        lastRefreshedAt: value.lastRefreshedAt,
        etag: value.etag,
      },
    });
}
