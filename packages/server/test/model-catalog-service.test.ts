import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseModelsDevApiJson, type ModelCatalogEntry, type ModelSpec } from "@aicr/llm";

import {
	createMemoryModelCatalogBackend,
	createModelCatalogService,
	createRedisModelCatalogBackend,
	type ModelCatalogFetcher,
	type ModelCatalogOverrideFields,
	type RedisModelCatalogClient,
} from "../src/model-catalog-service.js";

const sampleApiJson = {
	openai: {
		id: "openai",
		name: "OpenAI",
		npm: "@ai-sdk/openai",
		env: ["OPENAI_API_KEY"],
		doc: "https://platform.openai.com/docs",
		models: {
			"gpt-4o": {
				id: "gpt-4o",
				name: "GPT-4o",
				family: "gpt",
				attachment: true,
				tool_call: true,
				structured_output: true,
				temperature: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 128000, output: 16384 },
				cost: { input: 2.5, output: 10, cache_read: 1.25 },
			},
			"gpt-4o-mini": {
				id: "gpt-4o-mini",
				name: "GPT-4o mini",
				family: "gpt",
				tool_call: true,
				temperature: true,
				modalities: { input: ["text"], output: ["text"] },
				limit: { context: 128000, output: 16384 },
				cost: { input: 0.15, output: 0.6 },
			},
		},
	},
	anthropic: {
		id: "anthropic",
		name: "Anthropic",
		npm: "@ai-sdk/anthropic",
		env: ["ANTHROPIC_API_KEY"],
		models: {
			"claude-sonnet-4-5": {
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				reasoning: true,
				reasoning_options: [{ type: "budget_tokens", min: 1024 }],
				tool_call: true,
				temperature: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 200000, output: 64000 },
				cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
			},
		},
	},
};

function makeFetcher(json: unknown): ModelCatalogFetcher {
	const body = JSON.stringify(json);
	return async () => ({ body });
}

function baseSpec(overrides: Partial<ModelSpec> = {}): ModelSpec {
	return {
		providerKind: "openai_compatible",
		providerId: "openai",
		modelId: "gpt-4o",
		...overrides,
	};
}

function sampleCatalogEntries(): ModelCatalogEntry[] {
	return [...parseModelsDevApiJson(sampleApiJson).values()];
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
	return new RegExp(`^${escaped}$`, "u");
}

class FakeRedisModelCatalogClient implements RedisModelCatalogClient {
	readonly data = new Map<string, string>();
	connectCount = 0;
	quitCount = 0;
	disconnectCount = 0;

	async connect(): Promise<void> {
		this.connectCount += 1;
	}

	async get(key: string): Promise<string | null> {
		return this.data.get(key) ?? null;
	}

	async set(key: string, value: string): Promise<"OK"> {
		this.data.set(key, value);
		return "OK";
	}

	async scan(_cursor: string, ...args: readonly string[]): Promise<[string, string[]]> {
		const matchIndex = args.indexOf("MATCH");
		const pattern = matchIndex >= 0 ? args[matchIndex + 1] ?? "*" : "*";
		const regex = globToRegExp(pattern);
		return ["0", [...this.data.keys()].filter((key) => regex.test(key)).sort()];
	}

	async quit(): Promise<"OK"> {
		this.quitCount += 1;
		return "OK";
	}

	disconnect(): void {
		this.disconnectCount += 1;
	}
}

describe("model catalog Redis backend", () => {
	it("persists entries, model-id indexes, and source metadata", async () => {
		const client = new FakeRedisModelCatalogClient();
		const backend = await createRedisModelCatalogBackend({ client, keyPrefix: "test:" });
		const entries = sampleCatalogEntries().filter((entry) => entry.providerId === "openai");

		backend.upsertMany(entries, "remote");
		backend.setSourceMeta("https://models.dev/api.json", {
			lastRefreshedAt: new Date(1234),
			etag: '"abc"',
		});
		await backend.flushPending?.();

		expect(client.data.has("test:model-catalog:entry:openai%2Fgpt-4o")).toBe(true);
		expect(client.data.has("test:model-catalog:model:gpt-4o")).toBe(false);

		const reloaded = await createRedisModelCatalogBackend({ client, keyPrefix: "test:" });
		expect(reloaded.getEntry("openai/gpt-4o")?.source).toBe("remote");
		expect(reloaded.getEntry("openai/gpt-4o")?.entry.contextWindow).toBe(128000);
		expect(reloaded.getEntriesByModelId("gpt-4o")).toHaveLength(1);
		expect(reloaded.getSourceMeta("https://models.dev/api.json")).toEqual({
			lastRefreshedAt: new Date(1234),
			etag: '"abc"',
		});

		await reloaded.close?.();
		expect(client.quitCount).toBe(1);
	});

	it("keeps Redis catalog namespaces isolated by key prefix", async () => {
		const client = new FakeRedisModelCatalogClient();
		const [entry] = sampleCatalogEntries();
		expect(entry).toBeDefined();
		const first = await createRedisModelCatalogBackend({ client, keyPrefix: "first:" });
		first.upsertMany([entry!], "bundled");
		await first.flushPending?.();

		const second = await createRedisModelCatalogBackend({ client, keyPrefix: "second:" });
		expect(second.getEntry(entry!.catalogId)).toBeUndefined();
		expect(second.getEntriesByModelId(entry!.modelId)).toEqual([]);
	});
});
describe("model catalog service — refresh and fallback", () => {
	it("refreshes from remote and serves point queries", async () => {
		const backend = createMemoryModelCatalogBackend();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			fetcher: makeFetcher(sampleApiJson),
		});

		await service.ensureRefreshed();
		const resolved = service.resolve("openai", "gpt-4o");
		expect(resolved.entry).toBeDefined();
		expect(resolved.entry!.contextWindow).toBe(128000);
		expect(resolved.matchStrategy).toBe("direct");
		expect(resolved.source).toBe("remote");
	});

	it("does not fetch again within the refresh interval", async () => {
		const backend = createMemoryModelCatalogBackend();
		let fetchCount = 0;
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			fetcher: async () => {
				fetchCount += 1;
				return { body: JSON.stringify(sampleApiJson) };
			},
		});

		await service.ensureRefreshed();
		await service.ensureRefreshed();
		await service.ensureRefreshed();
		expect(fetchCount).toBe(1);
	});

	it("sends stored ETag and skips parse/upsert on 304", async () => {
		const backend = createMemoryModelCatalogBackend();
		let requestedEtag: string | undefined;
		let fetchCount = 0;
		let nowTime = 0;
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 0,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			now: () => new Date(nowTime),
			fetcher: async (_url, _timeout, options) => {
				fetchCount += 1;
				requestedEtag = options?.etag;
				return requestedEtag === '"abc"' ? { body: "", notModified: true } : { body: JSON.stringify(sampleApiJson), etag: '"abc"' };
			},
		});

		await service.ensureRefreshed();
		expect(requestedEtag).toBeUndefined();
		expect(backend.getEntry("openai/gpt-4o")).toBeDefined();

		nowTime += 1;
		await service.ensureRefreshed();
		expect(requestedEtag).toBe('"abc"');
		expect(backend.getSourceMeta("https://models.dev/api.json")?.etag).toBe('"abc"');
		expect(backend.getSourceMeta("https://models.dev/api.json")?.lastRefreshedAt.getTime()).toBe(1);

		await service.ensureRefreshed();
		expect(fetchCount).toBe(2);
	});

	it("does not update source meta when remote returns an empty catalog", async () => {
		const backend = createMemoryModelCatalogBackend();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			fetcher: async () => ({ body: JSON.stringify({}) }),
		});

		await service.ensureRefreshed();
		expect(backend.getSourceMeta("https://models.dev/api.json")).toBeUndefined();
	});

	it("skips remote fetch in offline mode", async () => {
		const backend = createMemoryModelCatalogBackend();
		let fetchCount = 0;
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: true,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			fetcher: async () => {
				fetchCount += 1;
				return { body: JSON.stringify(sampleApiJson) };
			},
		});

		await service.ensureRefreshed();
		expect(fetchCount).toBe(0);
	});

	it("tolerates a rejected remote fetch and falls back to the bundled snapshot", async () => {
		const backend = createMemoryModelCatalogBackend();
		const bundled = parseMiniSnapshot();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			bundledSnapshotPath: bundled.path,
			fetcher: async () => {
				throw new Error("network down");
			},
		});

		// A rejected remote fetch must be swallowed (D31 first fallback tier).
		await expect(service.ensureRefreshed()).resolves.toBeUndefined();
		const resolved = service.resolve("openai", "gpt-4o");
		expect(resolved.entry).toBeDefined();
		expect(resolved.entry!.contextWindow).toBe(128000);
		expect(resolved.source).toBe("bundled");
	});

	it("a rejected remote refresh preserves previously cached entries", async () => {
		const backend = createMemoryModelCatalogBackend();
		let nowTime = 0;
		let fetchCount = 0;
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 1,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			now: () => new Date(nowTime),
			fetcher: async () => {
				fetchCount += 1;
				if (fetchCount === 1) return { body: JSON.stringify(sampleApiJson) };
				throw new Error("network down");
			},
		});

		await service.ensureRefreshed();
		expect(backend.getEntry("openai/gpt-4o")).toBeDefined();

		// Advance beyond the refresh interval so the next call attempts a remote fetch.
		nowTime += 2 * 3600_000;
		await expect(service.ensureRefreshed()).resolves.toBeUndefined();
		expect(fetchCount).toBe(2);

		// Stale cached entry remains usable after the failed refresh.
		const resolved = service.resolve("openai", "gpt-4o");
		expect(resolved.entry!.contextWindow).toBe(128000);
		expect(resolved.source).toBe("remote");
	});

	it("falls back to bundled snapshot when backend misses and remote is offline", async () => {
		const backend = createMemoryModelCatalogBackend();
		const bundled = parseMiniSnapshot();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: true,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			bundledSnapshotPath: bundled.path,
			fetcher: makeFetcher({}),
		});

		await service.ensureRefreshed();
		const resolved = service.resolve("openai", "gpt-4o");
		expect(resolved.entry).toBeDefined();
		expect(resolved.entry!.contextWindow).toBe(128000);
		expect(resolved.source).toBe("bundled");
		expect(resolved.matchStrategy).toBe("direct");
	});

	it("fuzzy-matches against the bundled snapshot for hint-less custom providers in offline mode", async () => {
		const backend = createMemoryModelCatalogBackend();
		const bundled = parseMiniSnapshot();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: true,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			bundledSnapshotPath: bundled.path,
			fetcher: makeFetcher({}),
		});

		await service.ensureRefreshed();
		const resolved = service.resolve("my-custom-gateway", "gpt-4o");
		expect(resolved.entry).toBeDefined();
		expect(resolved.entry!.contextWindow).toBe(128000);
		expect(resolved.matchStrategy).toBe("fuzzy");
		expect(resolved.source).toBe("bundled");
	});

	it("reports config source when no catalog entry exists anywhere", async () => {
		const backend = createMemoryModelCatalogBackend();
		const bundled = parseMiniSnapshot();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: true,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			bundledSnapshotPath: bundled.path,
			fetcher: makeFetcher({}),
		});

		await service.ensureRefreshed();
		const resolved = service.resolve("unknown", "does-not-exist");
		expect(resolved.entry).toBeUndefined();
		expect(resolved.source).toBe("config");
	});

	it("resolves via catalog_provider hint when direct key misses", async () => {
		const backend = createMemoryModelCatalogBackend();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [{ id: "my-gateway", catalogProvider: "openai" }],
			overrides: {},
			backend,
			fetcher: makeFetcher(sampleApiJson),
		});
		await service.ensureRefreshed();

		const resolved = service.resolve("my-gateway", "gpt-4o");
		expect(resolved.matchStrategy).toBe("catalog_provider");
		expect(resolved.entry!.contextWindow).toBe(128000);
	});

	it("resolves via explicit catalog_id hint", async () => {
		const backend = createMemoryModelCatalogBackend();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [{ id: "custom", catalogId: "anthropic/claude-sonnet-4-5" }],
			overrides: {},
			backend,
			fetcher: makeFetcher(sampleApiJson),
		});
		await service.ensureRefreshed();

		const resolved = service.resolve("custom", "some-model");
		expect(resolved.matchStrategy).toBe("explicit");
		expect(resolved.entry!.contextWindow).toBe(200000);
		expect(resolved.entry!.supportsReasoning).toBe(true);
	});

	it("resolves override catalog_id before provider and fuzzy hints", async () => {
		const backend = createMemoryModelCatalogBackend();
		const overrides: Record<string, ModelCatalogOverrideFields> = {
			"custom/some-model": { catalogId: "anthropic/claude-sonnet-4-5" },
		};
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [{ id: "custom", catalogId: "openai/gpt-4o" }],
			overrides,
			backend,
			fetcher: makeFetcher(sampleApiJson),
		});
		await service.ensureRefreshed();

		const resolved = service.resolve("custom", "some-model");
		expect(resolved.matchStrategy).toBe("explicit");
		expect(resolved.entry!.providerId).toBe("anthropic");
		expect(resolved.entry!.modelId).toBe("claude-sonnet-4-5");
		expect(resolved.source).toBe("remote");

		const enriched = service.enrichModelSpec({
			providerKind: "openai_compatible",
			providerId: "custom",
			modelId: "some-model",
		});
		expect(enriched.contextWindow).toBe(200000);
		expect(enriched.maxOutputTokens).toBe(64000);
		expect(enriched.catalogSource).toBe("remote");
	});

	it("reports ambiguous fuzzy matches", async () => {
		const backend = createMemoryModelCatalogBackend();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			fetcher: makeFetcher({
				a: { id: "a", models: { "shared": { id: "shared", modalities: { input: ["text"], output: ["text"] }, limit: { context: 8000 } } } },
				b: { id: "b", models: { "shared": { id: "shared", modalities: { input: ["text"], output: ["text"] }, limit: { context: 16000 } } } },
			}),
		});
		await service.ensureRefreshed();

		const resolved = service.resolve("unknown", "shared");
		expect(resolved.matchStrategy).toBe("fuzzy");
		expect(resolved.ambiguousMatches).toHaveLength(2);
	});

	it("returns no entry for unknown models without re-fetching repeatedly", async () => {
		const backend = createMemoryModelCatalogBackend();
		let fetchCount = 0;
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			fetcher: async () => {
				fetchCount += 1;
				return { body: JSON.stringify(sampleApiJson) };
			},
		});

		await service.ensureRefreshed();
		const before = fetchCount;
		service.resolve("x", "does-not-exist");
		service.resolve("x", "does-not-exist");
		expect(fetchCount).toBe(before);
	});
});

describe("model catalog service — enrichment", () => {
	it("fills gaps from catalog without overwriting user-explicit fields", async () => {
		const backend = createMemoryModelCatalogBackend();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			fetcher: makeFetcher(sampleApiJson),
		});
		await service.ensureRefreshed();

		const spec = baseSpec({ contextWindow: 999 });
		const enriched = service.enrichModelSpec(spec);
		expect(enriched.contextWindow).toBe(999);
		expect(enriched.maxOutputTokens).toBe(16384);
		expect(enriched.costInputPerMTok).toBe(2.5);
		expect(enriched.supportsToolCall).toBe(true);
		expect(enriched.catalogSource).toBe("remote");
	});

	it("override fields take priority over catalog but not over user-explicit", async () => {
		const backend = createMemoryModelCatalogBackend();
		const overrides: Record<string, ModelCatalogOverrideFields> = {
			"openai/gpt-4o": { contextWindow: 200000, costInputPerMTok: 1 },
		};
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides,
			backend,
			fetcher: makeFetcher(sampleApiJson),
		});
		await service.ensureRefreshed();

		const enriched = service.enrichModelSpec(baseSpec());
		expect(enriched.contextWindow).toBe(200000);
		expect(enriched.costInputPerMTok).toBe(1);
		expect(enriched.catalogSource).toBe("override");
		expect(enriched.maxOutputTokens).toBe(16384);
	});

	it("does not enrich when disabled", () => {
		const service = createModelCatalogService({
			enabled: false,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
		});
		const spec = baseSpec();
		expect(service.enrichModelSpec(spec)).toBe(spec);
	});

	it("does not enrich when apply_to_model_spec is false", async () => {
		const backend = createMemoryModelCatalogBackend();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: false,
			providerHints: [],
			overrides: {},
			backend,
			fetcher: makeFetcher(sampleApiJson),
		});
		const spec = baseSpec();
		expect(service.enrichModelSpec(spec)).toBe(spec);
	});

	it("leaves unknown model fields unset rather than fabricating", async () => {
		const backend = createMemoryModelCatalogBackend();
		const service = createModelCatalogService({
			enabled: true,
			sourceUrl: "https://models.dev/api.json",
			refreshIntervalHours: 24,
			fetchTimeoutMs: 5000,
			offline: false,
			applyToModelSpec: true,
			providerHints: [],
			overrides: {},
			backend,
			fetcher: makeFetcher(sampleApiJson),
		});
		await service.ensureRefreshed();

		const spec = baseSpec({ providerId: "x", modelId: "y" });
		const enriched = service.enrichModelSpec(spec);
		expect(enriched.contextWindow).toBeUndefined();
		expect(enriched.costInputPerMTok).toBeUndefined();
	});
});

function parseMiniSnapshot(): { path: string } {
	const dir = mkdtempSync(join(tmpdir(), "aicr-mc-bundled-"));
	const filePath = join(dir, "models-dev.json");
	writeFileSync(filePath, JSON.stringify(sampleApiJson), "utf8");
	return { path: filePath };
}
