import { eq } from "drizzle-orm";

import { modelCatalog, modelCatalogSource } from "./schema.js";
import type { StoreDb } from "./database.js";
import {
	getModelCatalogEntriesByModelIdPg,
	getModelCatalogEntryPg,
	getModelCatalogSourceMetaPg,
	listModelCatalogEntriesPg,
	listModelCatalogSourceMetasPg,
	setModelCatalogSourceMetaPg,
	upsertModelCatalogEntriesPg,
} from "./model-catalog.pg.js";

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

export function toModelCatalogRecord(row: {
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

export async function getModelCatalogEntry(store: StoreDb, catalogId: string): Promise<ModelCatalogRecord | undefined> {
	if (store.kind === "postgres") {
		return getModelCatalogEntryPg(store, catalogId);
	}
	const row = store.db
		.select()
		.from(modelCatalog)
		.where(eq(modelCatalog.catalogId, catalogId))
		.get();
	return row ? toModelCatalogRecord(row) : undefined;
}

export async function getModelCatalogEntriesByModelId(store: StoreDb, modelId: string): Promise<ModelCatalogRecord[]> {
	if (store.kind === "postgres") {
		return getModelCatalogEntriesByModelIdPg(store, modelId);
	}
	const rows = store.db
		.select()
		.from(modelCatalog)
		.where(eq(modelCatalog.modelId, modelId))
		.all();
	return rows.map((row) => toModelCatalogRecord(row));
}

export async function listModelCatalogEntries(store: StoreDb): Promise<ModelCatalogRecord[]> {
	if (store.kind === "postgres") {
		return listModelCatalogEntriesPg(store);
	}
	const rows = store.db.select().from(modelCatalog).all();
	return rows.map((row) => toModelCatalogRecord(row));
}

export async function upsertModelCatalogEntries(store: StoreDb, records: readonly ModelCatalogRecord[]): Promise<void> {
	if (store.kind === "postgres") {
		return upsertModelCatalogEntriesPg(store, records);
	}
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

export async function getModelCatalogSourceMeta(store: StoreDb, sourceUrl: string): Promise<ModelCatalogSourceMeta | undefined> {
	if (store.kind === "postgres") {
		return getModelCatalogSourceMetaPg(store, sourceUrl);
	}
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

export async function listModelCatalogSourceMetas(store: StoreDb): Promise<ModelCatalogSourceMeta[]> {
	if (store.kind === "postgres") {
		return listModelCatalogSourceMetasPg(store);
	}
	const rows = store.db.select().from(modelCatalogSource).all();
	return rows.map((row) => ({
		sourceUrl: row.sourceUrl,
		lastRefreshedAt: row.lastRefreshedAt,
		...(row.etag ? { etag: row.etag } : {}),
	}));
}

export async function setModelCatalogSourceMeta(store: StoreDb, meta: ModelCatalogSourceMeta): Promise<void> {
	if (store.kind === "postgres") {
		return setModelCatalogSourceMetaPg(store, meta);
	}
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
