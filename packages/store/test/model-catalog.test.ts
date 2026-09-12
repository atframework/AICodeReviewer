import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStoreDb, closeStoreDb, type SqliteStoreDb } from "../src/database.js";
import {
	getModelCatalogEntry,
	getModelCatalogEntriesByModelId,
	upsertModelCatalogEntries,
	getModelCatalogSourceMeta,
	setModelCatalogSourceMeta,
} from "../src/model-catalog.js";

let tmpDir: string;
let store: SqliteStoreDb;

beforeEach(async () => {
	tmpDir = join(tmpdir(), `aicr-mc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	store = createStoreDb(join(tmpDir, "test.db"));
});

afterEach(async () => {
	(await closeStoreDb(store));
	if (existsSync(tmpDir)) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe("model catalog repository", () => {
	it("returns undefined for unknown catalog id (point query)", async () => {
		expect((await getModelCatalogEntry(store, "openai/gpt-4o"))).toBeUndefined();
	});

	it("upserts and point-queries a model entry by catalog id", async () => {
		const fetchedAt = new Date();
		(await upsertModelCatalogEntries(store, [
			{
				catalogId: "openai/gpt-4o",
				providerId: "openai",
				modelId: "gpt-4o",
				data: JSON.stringify({ contextWindow: 128000 }),
				source: "remote",
				fetchedAt,
			},
		]));

		const entry = (await getModelCatalogEntry(store, "openai/gpt-4o"));
		expect(entry).toBeDefined();
		expect(entry!.catalogId).toBe("openai/gpt-4o");
		expect(entry!.source).toBe("remote");
		expect(JSON.parse(entry!.data).contextWindow).toBe(128000);
		expect(entry!.fetchedAt.getTime()).toBe(fetchedAt.getTime());
	});

	it("upsert overwrites an existing row on second write", async () => {
		(await upsertModelCatalogEntries(store, [
			{ catalogId: "anthropic/claude", providerId: "anthropic", modelId: "claude", data: JSON.stringify({ v: 1 }), fetchedAt: new Date(1000) },
		]));
		(await upsertModelCatalogEntries(store, [
			{ catalogId: "anthropic/claude", providerId: "anthropic", modelId: "claude", data: JSON.stringify({ v: 2 }), fetchedAt: new Date(2000) },
		]));

		const entry = (await getModelCatalogEntry(store, "anthropic/claude"));
		expect(JSON.parse(entry!.data).v).toBe(2);
		expect(entry!.fetchedAt.getTime()).toBe(2000);
	});

	it("upserts multiple entries in one call", async () => {
		(await upsertModelCatalogEntries(store, [
			{ catalogId: "a/m1", providerId: "a", modelId: "m1", data: "{}", fetchedAt: new Date() },
			{ catalogId: "b/m2", providerId: "b", modelId: "m2", data: "{}", fetchedAt: new Date() },
		]));
		expect((await getModelCatalogEntry(store, "a/m1"))).toBeDefined();
		expect((await getModelCatalogEntry(store, "b/m2"))).toBeDefined();
	});

	it("fuzzy-matches entries by model id across providers", async () => {
		(await upsertModelCatalogEntries(store, [
			{ catalogId: "a/shared", providerId: "a", modelId: "shared", data: "{}", fetchedAt: new Date() },
			{ catalogId: "b/shared", providerId: "b", modelId: "shared", data: "{}", fetchedAt: new Date() },
			{ catalogId: "c/other", providerId: "c", modelId: "other", data: "{}", fetchedAt: new Date() },
		]));
		const matches = (await getModelCatalogEntriesByModelId(store, "shared"));
		expect(matches).toHaveLength(2);
		expect(matches.map((m) => m.catalogId).sort()).toEqual(["a/shared", "b/shared"]);
	});

	it("does nothing for an empty record list", async () => {
		(await upsertModelCatalogEntries(store, []));
		expect((await getModelCatalogEntry(store, "a/m1"))).toBeUndefined();
	});

	it("records and reads source-level refresh metadata", async () => {
		const refreshedAt = new Date();
		(await setModelCatalogSourceMeta(store, {
			sourceUrl: "https://models.dev/api.json",
			lastRefreshedAt: refreshedAt,
			etag: "w-abc",
		}));

		const meta = (await getModelCatalogSourceMeta(store, "https://models.dev/api.json"));
		expect(meta).toBeDefined();
		expect(meta!.etag).toBe("w-abc");
		expect(meta!.lastRefreshedAt.getTime()).toBe(refreshedAt.getTime());
	});

	it("updates source metadata on subsequent writes", async () => {
		(await setModelCatalogSourceMeta(store, { sourceUrl: "src", lastRefreshedAt: new Date(1000), etag: "e1" }));
		(await setModelCatalogSourceMeta(store, { sourceUrl: "src", lastRefreshedAt: new Date(2000) }));

		const meta = (await getModelCatalogSourceMeta(store, "src"));
		expect(meta!.lastRefreshedAt.getTime()).toBe(2000);
		expect(meta!.etag).toBeUndefined();
	});

	it("returns undefined for unknown source url", async () => {
		expect((await getModelCatalogSourceMeta(store, "unknown"))).toBeUndefined();
	});
});
