import { eq } from "drizzle-orm";

import { modelCatalog, modelCatalogSource } from "./schema.js";
import type { StoreDb } from "./database.js";

export interface ModelCatalogRecord {
	readonly catalogId: string;
	readonly providerId: string;
	readonly modelId: string;
	readonly data: string;
	readonly source?: string;
	readonly fetchedAt: Date;
}

export interface ModelCatalogSourceMeta {
	readonly sourceUrl: string;
	readonly lastRefreshedAt: Date;
	readonly etag?: string;
}

function toRecord(row: {
	catalogId: string;
	providerId: string;
	modelId: string;
	data: string;
	source: string | null;
	fetchedAt: Date;
}): ModelCatalogRecord {
	return {
		catalogId: row.catalogId,
		providerId: row.providerId,
		modelId: row.modelId,
		data: row.data,
		...(row.source ? { source: row.source } : {}),
		fetchedAt: row.fetchedAt,
	};
}

export function getModelCatalogEntry(store: StoreDb, catalogId: string): ModelCatalogRecord | undefined {
	const row = store.db
		.select()
		.from(modelCatalog)
		.where(eq(modelCatalog.catalogId, catalogId))
		.get();
	return row ? toRecord(row) : undefined;
}

export function getModelCatalogEntriesByModelId(store: StoreDb, modelId: string): ModelCatalogRecord[] {
	const rows = store.db
		.select()
		.from(modelCatalog)
		.where(eq(modelCatalog.modelId, modelId))
		.all();
	return rows.map((row) => toRecord(row));
}

export function upsertModelCatalogEntries(store: StoreDb, records: readonly ModelCatalogRecord[]): void {
	if (records.length === 0) return;
	store.db.transaction((tx) => {
		for (const record of records) {
			const value = {
				catalogId: record.catalogId,
				providerId: record.providerId,
				modelId: record.modelId,
				data: record.data,
				source: record.source ?? null,
				fetchedAt: record.fetchedAt,
			};
			tx.insert(modelCatalog)
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
				})
				.run();
		}
	});
}

export function getModelCatalogSourceMeta(store: StoreDb, sourceUrl: string): ModelCatalogSourceMeta | undefined {
	const row = store.db
		.select()
		.from(modelCatalogSource)
		.where(eq(modelCatalogSource.sourceUrl, sourceUrl))
		.get();
	if (!row) return undefined;
	return {
		sourceUrl: row.sourceUrl,
		lastRefreshedAt: row.lastRefreshedAt,
		...(row.etag ? { etag: row.etag } : {}),
	};
}

export function setModelCatalogSourceMeta(store: StoreDb, meta: ModelCatalogSourceMeta): void {
	const value = {
		sourceUrl: meta.sourceUrl,
		lastRefreshedAt: meta.lastRefreshedAt,
		etag: meta.etag ?? null,
	};
	store.db
		.insert(modelCatalogSource)
		.values(value)
		.onConflictDoUpdate({
			target: modelCatalogSource.sourceUrl,
			set: {
				lastRefreshedAt: value.lastRefreshedAt,
				etag: value.etag,
			},
		})
		.run();
}
