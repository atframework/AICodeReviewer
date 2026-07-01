import { readFileSync } from "node:fs";
import { get as httpsGet } from "node:https";

import {
	mapCatalogEntryToModelSpecFields,
	parseModelsDevApiJson,
	type CatalogMatchStrategy,
	type CatalogSource,
	type ModelCatalogEntry,
	type ModelSpec,
} from "@aicr/llm";
import {
	getModelCatalogEntriesByModelId,
	getModelCatalogEntry,
	getModelCatalogSourceMeta,
	setModelCatalogSourceMeta,
	upsertModelCatalogEntries,
	type ModelCatalogRecord,
	type StoreDb,
} from "@aicr/store";

export interface ModelCatalogSourceMetaView {
	readonly lastRefreshedAt: Date;
	readonly etag?: string;
}

export interface ModelCatalogBackendEntry {
	readonly entry: ModelCatalogEntry;
	readonly source: CatalogSource;
}

export interface ModelCatalogBackend {
	getEntry(catalogId: string): ModelCatalogBackendEntry | undefined;
	getEntriesByModelId(modelId: string): ModelCatalogBackendEntry[];
	upsertMany(entries: readonly ModelCatalogEntry[], source: CatalogSource): void;
	getSourceMeta(sourceUrl: string): ModelCatalogSourceMetaView | undefined;
	setSourceMeta(sourceUrl: string, meta: ModelCatalogSourceMetaView): void;
	flushPending?(): Promise<void>;
	close?(): Promise<void>;
}

function entryToRecord(entry: ModelCatalogEntry, source: CatalogSource, fetchedAt: Date): ModelCatalogRecord {
	return {
		catalogId: entry.catalogId,
		providerId: entry.providerId,
		modelId: entry.modelId,
		data: JSON.stringify(entry),
		source,
		fetchedAt,
	};
}

function recordToEntry(record: ModelCatalogRecord): ModelCatalogEntry {
	return JSON.parse(record.data) as ModelCatalogEntry;
}

function sourceFromString(source: string | undefined): CatalogSource {
	switch (source) {
		case "remote":
		case "bundled":
		case "cache":
		case "config":
		case "override":
			return source;
		default:
			return "cache";
	}
}

export interface RedisModelCatalogClient {
	readonly status?: string;
	connect?(): Promise<unknown>;
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<unknown>;
	scan(cursor: string, ...args: readonly string[]): Promise<[string, string[]]>;
	quit?(): Promise<unknown>;
	disconnect?(): void;
}

export interface RedisModelCatalogBackendOptions {
	readonly url?: string;
	readonly keyPrefix?: string;
	readonly client?: RedisModelCatalogClient;
	readonly scanCount?: number;
}

interface StoredRedisModelCatalogEntry {
	readonly catalogId: string;
	readonly providerId: string;
	readonly modelId: string;
	readonly data: ModelCatalogEntry;
	readonly source?: CatalogSource;
	readonly fetchedAt: string;
}

interface StoredRedisModelCatalogSourceMeta {
	readonly lastRefreshedAt: string;
	readonly etag?: string;
}

interface StoredRedisModelCatalogModelIndex {
	readonly modelId: string;
	readonly catalogIds: readonly string[];
	readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRedisKeyPrefix(prefix: string | undefined): string {
	const base = prefix && prefix.length > 0 ? prefix : "aicr:";
	return `${base.endsWith(":") ? base : `${base}:`}model-catalog:`;
}

function encodeRedisKeyPart(value: string): string {
	return encodeURIComponent(value);
}

function decodeRedisKeyPart(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

function redisEntryKey(namespace: string, catalogId: string): string {
	return `${namespace}entry:${encodeRedisKeyPart(catalogId)}`;
}

function redisModelKey(namespace: string, modelId: string): string {
	return `${namespace}model:${encodeRedisKeyPart(modelId)}`;
}

function redisSourceKey(namespace: string, sourceUrl: string): string {
	return `${namespace}source:${encodeRedisKeyPart(sourceUrl)}`;
}

function parseStoredRedisEntry(raw: string): StoredRedisModelCatalogEntry | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.data)) return undefined;
		const catalogId = typeof parsed.catalogId === "string" ? parsed.catalogId : undefined;
		const providerId = typeof parsed.providerId === "string" ? parsed.providerId : undefined;
		const modelId = typeof parsed.modelId === "string" ? parsed.modelId : undefined;
		const fetchedAt = typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : undefined;
		const data = parsed.data as Partial<ModelCatalogEntry>;
		if (!catalogId || !providerId || !modelId || !fetchedAt) return undefined;
		if (data.catalogId !== catalogId || data.providerId !== providerId || data.modelId !== modelId) return undefined;
		return {
			catalogId,
			providerId,
			modelId,
			data: data as ModelCatalogEntry,
			...(typeof parsed.source === "string" ? { source: sourceFromString(parsed.source) } : {}),
			fetchedAt,
		};
	} catch {
		return undefined;
	}
}

function parseStoredRedisSourceMeta(raw: string): ModelCatalogSourceMetaView | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || typeof parsed.lastRefreshedAt !== "string") return undefined;
		const lastRefreshedAt = new Date(parsed.lastRefreshedAt);
		if (Number.isNaN(lastRefreshedAt.getTime())) return undefined;
		return {
			lastRefreshedAt,
			...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
		};
	} catch {
		return undefined;
	}
}

async function loadRedisClient(url: string): Promise<RedisModelCatalogClient> {
	try {
		const mod = await import("ioredis");
		const RedisCtor = mod.default as unknown as new (url: string, options: { lazyConnect: boolean; maxRetriesPerRequest: number }) => RedisModelCatalogClient;
		const client = new RedisCtor(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
		if (client.connect) {
			await client.connect();
		}
		return client;
	} catch (error) {
		throw new Error(
			`ioredis is required for llm.model_catalog.cache.backend 'redis'. Install optional dependencies or use 'sqlite'/'memory'. Cause: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function scanRedisKeys(client: RedisModelCatalogClient, pattern: string, count: number): Promise<string[]> {
	const keys: string[] = [];
	let cursor = "0";
	do {
		const [nextCursor, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", String(count));
		cursor = nextCursor;
		keys.push(...batch);
	} while (cursor !== "0");
	return keys;
}

export async function createRedisModelCatalogBackend(options: RedisModelCatalogBackendOptions): Promise<ModelCatalogBackend> {
	if (!options.client && !options.url) {
		throw new TypeError("Redis model catalog backend requires a Redis URL or an injected Redis client.");
	}

	const namespace = normalizeRedisKeyPrefix(options.keyPrefix);
	const scanCount = options.scanCount ?? 100;
	const client = options.client ?? (await loadRedisClient(options.url!));
	if (options.client?.connect) {
		await options.client.connect();
	}

	const entries = new Map<string, ModelCatalogEntry>();
	const sources = new Map<string, CatalogSource>();
	const modelIndex = new Map<string, Set<string>>();
	const metaBySource = new Map<string, ModelCatalogSourceMetaView>();
	const pendingWrites: Promise<Error | undefined>[] = [];

	function rememberWrite(promise: Promise<unknown>): void {
		pendingWrites.push(
			promise.then(
				() => undefined,
				(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
			),
		);
	}

	async function flushPending(): Promise<void> {
		while (pendingWrites.length > 0) {
			const batch = pendingWrites.splice(0);
			const results = await Promise.all(batch);
			const firstError = results.find((result): result is Error => result instanceof Error);
			if (firstError) throw firstError;
		}
	}

	function addToModelIndex(entry: ModelCatalogEntry): void {
		let ids = modelIndex.get(entry.modelId);
		if (!ids) {
			ids = new Set<string>();
			modelIndex.set(entry.modelId, ids);
		}
		ids.add(entry.catalogId);
	}

	function removeFromModelIndex(modelId: string, catalogId: string): void {
		const ids = modelIndex.get(modelId);
		if (!ids) return;
		ids.delete(catalogId);
		if (ids.size === 0) modelIndex.delete(modelId);
	}

	function cacheEntry(entry: ModelCatalogEntry, source: CatalogSource): void {
		const previous = entries.get(entry.catalogId);
		if (previous && previous.modelId !== entry.modelId) {
			removeFromModelIndex(previous.modelId, entry.catalogId);
		}
		entries.set(entry.catalogId, entry);
		sources.set(entry.catalogId, source);
		addToModelIndex(entry);
	}

	async function loadExisting(): Promise<void> {
		const entryKeys = await scanRedisKeys(client, `${namespace}entry:*`, scanCount);
		for (const key of entryKeys) {
			const raw = await client.get(key);
			if (!raw) continue;
			const stored = parseStoredRedisEntry(raw);
			if (stored) {
				cacheEntry(stored.data, stored.source ?? "cache");
			}
		}

		const sourceKeys = await scanRedisKeys(client, `${namespace}source:*`, scanCount);
		for (const key of sourceKeys) {
			const encodedSourceUrl = key.slice(`${namespace}source:`.length);
			const sourceUrl = decodeRedisKeyPart(encodedSourceUrl);
			if (!sourceUrl) continue;
			const raw = await client.get(key);
			if (!raw) continue;
			const meta = parseStoredRedisSourceMeta(raw);
			if (meta) metaBySource.set(sourceUrl, meta);
		}
	}

	await loadExisting();

	return {
		getEntry(catalogId: string): ModelCatalogBackendEntry | undefined {
			const entry = entries.get(catalogId);
			if (!entry) return undefined;
			return { entry, source: sources.get(catalogId) ?? "cache" };
		},
		getEntriesByModelId(modelId: string): ModelCatalogBackendEntry[] {
			const ids = modelIndex.get(modelId);
			if (!ids) return [];
			return [...ids].flatMap((catalogId) => {
				const entry = entries.get(catalogId);
				return entry ? [{ entry, source: sources.get(catalogId) ?? "cache" }] : [];
			});
		},
		upsertMany(records: readonly ModelCatalogEntry[], source: CatalogSource): void {
			if (records.length === 0) return;
			const fetchedAt = new Date().toISOString();
			const affectedModelIds = new Set<string>();
			for (const entry of records) {
				const previous = entries.get(entry.catalogId);
				if (previous) affectedModelIds.add(previous.modelId);
				cacheEntry(entry, source);
				affectedModelIds.add(entry.modelId);
				const stored: StoredRedisModelCatalogEntry = {
					catalogId: entry.catalogId,
					providerId: entry.providerId,
					modelId: entry.modelId,
					data: entry,
					source,
					fetchedAt,
				};
				rememberWrite(client.set(redisEntryKey(namespace, entry.catalogId), JSON.stringify(stored)));
			}
			for (const modelId of affectedModelIds) {
				const stored: StoredRedisModelCatalogModelIndex = {
					modelId,
					catalogIds: [...(modelIndex.get(modelId) ?? [])].sort(),
					updatedAt: fetchedAt,
				};
				rememberWrite(client.set(redisModelKey(namespace, modelId), JSON.stringify(stored)));
			}
		},
		getSourceMeta(sourceUrl: string): ModelCatalogSourceMetaView | undefined {
			return metaBySource.get(sourceUrl);
		},
		setSourceMeta(sourceUrl: string, meta: ModelCatalogSourceMetaView): void {
			metaBySource.set(sourceUrl, meta);
			const stored: StoredRedisModelCatalogSourceMeta = {
				lastRefreshedAt: meta.lastRefreshedAt.toISOString(),
				...(meta.etag ? { etag: meta.etag } : {}),
			};
			rememberWrite(client.set(redisSourceKey(namespace, sourceUrl), JSON.stringify(stored)));
		},
		flushPending,
		async close(): Promise<void> {
			await flushPending();
			if (client.quit) {
				await client.quit();
			} else {
				client.disconnect?.();
			}
		},
	};
}

export function createSqliteModelCatalogBackend(store: StoreDb): ModelCatalogBackend {
	return {
		getEntry(catalogId: string): ModelCatalogBackendEntry | undefined {
			const record = getModelCatalogEntry(store, catalogId);
			if (!record) return undefined;
			return { entry: recordToEntry(record), source: sourceFromString(record.source) };
		},
		getEntriesByModelId(modelId: string): ModelCatalogBackendEntry[] {
			return getModelCatalogEntriesByModelId(store, modelId).map((record) => ({
				entry: recordToEntry(record),
				source: sourceFromString(record.source),
			}));
		},
		upsertMany(entries: readonly ModelCatalogEntry[], source: CatalogSource): void {
			const fetchedAt = new Date();
			upsertModelCatalogEntries(
				store,
				entries.map((entry) => entryToRecord(entry, source, fetchedAt)),
			);
		},
		getSourceMeta(sourceUrl: string): ModelCatalogSourceMetaView | undefined {
			return getModelCatalogSourceMeta(store, sourceUrl);
		},
		setSourceMeta(sourceUrl: string, meta: ModelCatalogSourceMetaView): void {
			setModelCatalogSourceMeta(store, {
				sourceUrl,
				lastRefreshedAt: meta.lastRefreshedAt,
				...(meta.etag ? { etag: meta.etag } : {}),
			});
		},
	};
}

export function createMemoryModelCatalogBackend(): ModelCatalogBackend {
	const entries = new Map<string, ModelCatalogEntry>();
	const sources = new Map<string, CatalogSource>();
	const metaBySource = new Map<string, ModelCatalogSourceMetaView>();
	return {
		getEntry(catalogId: string): ModelCatalogBackendEntry | undefined {
			const entry = entries.get(catalogId);
			if (!entry) return undefined;
			return { entry, source: sources.get(catalogId) ?? "cache" };
		},
		getEntriesByModelId(modelId: string): ModelCatalogBackendEntry[] {
			const matches: ModelCatalogBackendEntry[] = [];
			for (const [catalogId, entry] of entries.entries()) {
				if (entry.modelId === modelId) {
					matches.push({ entry, source: sources.get(catalogId) ?? "cache" });
				}
			}
			return matches;
		},
		upsertMany(records: readonly ModelCatalogEntry[], source: CatalogSource): void {
			for (const entry of records) {
				entries.set(entry.catalogId, entry);
				sources.set(entry.catalogId, source);
			}
		},
		getSourceMeta(sourceUrl: string): ModelCatalogSourceMetaView | undefined {
			return metaBySource.get(sourceUrl);
		},
		setSourceMeta(sourceUrl: string, meta: ModelCatalogSourceMetaView): void {
			metaBySource.set(sourceUrl, meta);
		},
	};
}

export interface ModelCatalogFetcherResult {
	readonly body: string;
	readonly etag?: string;
	readonly notModified?: boolean;
}

export interface ModelCatalogFetcherOptions {
	readonly etag?: string;
}

export type ModelCatalogFetcher = (
	url: string,
	timeoutMs: number,
	options?: ModelCatalogFetcherOptions,
) => Promise<ModelCatalogFetcherResult>;

export function createHttpModelCatalogFetcher(): ModelCatalogFetcher {
	return (url: string, timeoutMs: number, options: ModelCatalogFetcherOptions = {}) =>
		new Promise<ModelCatalogFetcherResult>((resolvePromise, reject) => {
			const headers: Record<string, string> = {
				"User-Agent": "AICodeReviewer-model-catalog",
				Accept: "application/json",
			};
			if (options.etag) {
				headers["If-None-Match"] = options.etag;
			}
			const req = httpsGet(
				url,
				{
					headers,
					timeout: timeoutMs,
				},
				(res) => {
					if (res.statusCode === 304) {
						resolvePromise({ body: "", notModified: true });
						res.resume();
						return;
					}
					if (res.statusCode && res.statusCode >= 400) {
						reject(new Error(`model catalog refresh failed: HTTP ${res.statusCode} for ${url}`));
						res.resume();
						return;
					}
					const etag = res.headers.etag;
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						body += chunk;
					});
					res.on("end", () => {
						resolvePromise({ body, ...(etag ? { etag } : {}) });
					});
				},
			);
			req.on("error", reject);
			req.on("timeout", () => {
				req.destroy(new Error(`model catalog refresh timed out after ${timeoutMs}ms for ${url}`));
			});
		});
}

export interface ModelCatalogProviderHint {
	readonly id: string;
	readonly catalogProvider?: string;
	readonly catalogId?: string;
}

export const MODEL_CATALOG_HINT_KEY_MAP = {
	catalog_id: "catalogId",
} as const;

export const MODEL_CATALOG_FIELD_KEY_MAP = {
	context_window: "contextWindow",
	max_input_tokens: "maxInputTokens",
	max_output_tokens: "maxOutputTokens",
	cost_input_per_mtok: "costInputPerMTok",
	cost_output_per_mtok: "costOutputPerMTok",
	cost_cache_read_per_mtok: "costCacheReadPerMTok",
	cost_cache_write_per_mtok: "costCacheWritePerMTok",
	cost_reasoning_per_mtok: "costReasoningPerMTok",
	cost_input_audio_per_mtok: "costInputAudioPerMTok",
	cost_output_audio_per_mtok: "costOutputAudioPerMTok",
	supports_tool_call: "supportsToolCall",
	supports_attachment: "supportsAttachment",
	supports_vision: "supportsVision",
	supports_cache_prompt: "supportsCachePrompt",
	supports_reasoning: "supportsReasoning",
	supported_reasoning_efforts: "supportedReasoningEfforts",
	default_reasoning_effort: "defaultReasoningEffort",
	thinking_modes: "thinkingModes",
	supports_interleaved_reasoning: "supportsInterleavedReasoning",
	interleaved_reasoning_field: "interleavedReasoningField",
	supports_structured_output: "supportsStructuredOutput",
	supports_temperature: "supportsTemperature",
	supports_streaming: "supportsStreaming",
	supports_logprobs: "supportsLogprobs",
	supports_search: "supportsSearch",
	supports_computer_use: "supportsComputerUse",
	native_tool_capabilities: "nativeToolCapabilities",
	supported_request_parameters: "supportedRequestParameters",
	unsupported_request_parameters: "unsupportedRequestParameters",
	input_modalities: "inputModalities",
	output_modalities: "outputModalities",
	display_name: "displayName",
	family: "family",
	knowledge_cutoff: "knowledgeCutoff",
	training_cutoff: "trainingCutoff",
	release_date: "releaseDate",
	last_updated: "lastUpdated",
	model_status: "modelStatus",
	open_weights: "openWeights",
	license: "license",
	model_links: "modelLinks",
	provider_display_name: "providerDisplayName",
	provider_npm_package: "providerNpmPackage",
	provider_env_vars: "providerEnvVars",
	provider_api_base_url: "providerApiBaseUrl",
	provider_docs_url: "providerDocsUrl",
	provider_model_aliases: "providerModelAliases",
	provider_model_ids: "providerModelIds",
	preferred_endpoint: "preferredEndpoint",
	latency_class: "latencyClass",
	priority_tier_supported: "priorityTierSupported",
	rate_limit_tier: "rateLimitTier",
	concurrency_limit: "concurrencyLimit",
	throughput_hint_tokens_per_second: "throughputHintTokensPerSecond",
} as const satisfies Readonly<Record<string, keyof ModelSpec>>;

const MODEL_CATALOG_MODEL_SPEC_KEYS = Array.from(
	new Set(Object.values(MODEL_CATALOG_FIELD_KEY_MAP)),
) as readonly (keyof ModelSpec)[];

export interface ModelCatalogOverrideFields {
	readonly catalogId?: string;
	readonly contextWindow?: number;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly supportsToolCall?: boolean;
	readonly supportsVision?: boolean;
	readonly supportsAttachment?: boolean;
	readonly supportsCachePrompt?: boolean;
	readonly supportsReasoning?: boolean;
	readonly supportsStructuredOutput?: boolean;
	readonly supportsTemperature?: boolean;
	readonly supportsStreaming?: boolean;
	readonly supportsLogprobs?: boolean;
	readonly supportsSearch?: boolean;
	readonly supportsComputerUse?: boolean;
	readonly costInputPerMTok?: number;
	readonly costOutputPerMTok?: number;
	readonly costCacheReadPerMTok?: number;
	readonly costCacheWritePerMTok?: number;
	readonly costReasoningPerMTok?: number;
	readonly costInputAudioPerMTok?: number;
	readonly costOutputAudioPerMTok?: number;
	readonly supportedReasoningEfforts?: ModelSpec["supportedReasoningEfforts"];
	readonly defaultReasoningEffort?: ModelSpec["defaultReasoningEffort"];
	readonly thinkingModes?: readonly string[];
	readonly supportsInterleavedReasoning?: boolean;
	readonly interleavedReasoningField?: string;
	readonly nativeToolCapabilities?: readonly string[];
	readonly supportedRequestParameters?: readonly string[];
	readonly unsupportedRequestParameters?: readonly string[];
	readonly inputModalities?: readonly string[];
	readonly outputModalities?: readonly string[];
	readonly displayName?: string;
	readonly family?: string;
	readonly knowledgeCutoff?: string;
	readonly trainingCutoff?: string;
	readonly releaseDate?: string;
	readonly lastUpdated?: string;
	readonly modelStatus?: ModelSpec["modelStatus"];
	readonly openWeights?: boolean;
	readonly license?: string;
	readonly modelLinks?: Readonly<Record<string, string>>;
	readonly providerDisplayName?: string;
	readonly providerNpmPackage?: string;
	readonly providerEnvVars?: readonly string[];
	readonly providerApiBaseUrl?: string;
	readonly providerDocsUrl?: string;
	readonly providerModelAliases?: readonly string[];
	readonly providerModelIds?: readonly string[];
	readonly preferredEndpoint?: string;
	readonly latencyClass?: string;
	readonly priorityTierSupported?: boolean;
	readonly rateLimitTier?: string;
	readonly concurrencyLimit?: number;
	readonly throughputHintTokensPerSecond?: number;
}

export interface ResolvedModelCatalog {
	readonly entry?: ModelCatalogEntry;
	readonly source: CatalogSource;
	readonly matchStrategy?: CatalogMatchStrategy;
	readonly ambiguousMatches?: readonly string[];
}

export interface ModelCatalogServiceOptions {
	readonly enabled: boolean;
	readonly sourceUrl: string;
	readonly refreshIntervalHours: number;
	readonly fetchTimeoutMs: number;
	readonly offline: boolean;
	readonly applyToModelSpec: boolean;
	readonly providerHints: readonly ModelCatalogProviderHint[];
	readonly overrides: Readonly<Record<string, ModelCatalogOverrideFields>>;
	readonly backend?: ModelCatalogBackend;
	readonly bundledSnapshotPath?: string;
	readonly fetcher?: ModelCatalogFetcher;
	readonly now?: () => Date;
}

export interface ModelCatalogService {
	ensureRefreshed(): Promise<void>;
	resolve(providerId: string, modelId: string): ResolvedModelCatalog;
	enrichModelSpec(spec: ModelSpec): ModelSpec;
}

export function createModelCatalogService(options: ModelCatalogServiceOptions): ModelCatalogService {
	const {
		enabled,
		sourceUrl,
		refreshIntervalHours,
		fetchTimeoutMs,
		offline,
		applyToModelSpec,
		providerHints,
		overrides,
		backend,
		bundledSnapshotPath,
		fetcher,
		now = () => new Date(),
	} = options;

	let bundledCatalog: ReadonlyMap<string, ModelCatalogEntry> | undefined;
	let refreshInFlight: Promise<void> | undefined;

	function loadBundledSnapshot(): ReadonlyMap<string, ModelCatalogEntry> {
		if (bundledCatalog) return bundledCatalog;
		if (!bundledSnapshotPath) {
			bundledCatalog = new Map();
			return bundledCatalog;
		}
		try {
			const raw = readFileSync(bundledSnapshotPath, "utf8");
			bundledCatalog = parseModelsDevApiJson(JSON.parse(raw));
		} catch {
			bundledCatalog = new Map();
		}
		return bundledCatalog;
	}

	async function refreshFromRemote(): Promise<void> {
		if (offline || !backend || !fetcher) return;
		try {
			const meta = backend.getSourceMeta(sourceUrl);
			const result = await fetcher(sourceUrl, fetchTimeoutMs, meta?.etag ? { etag: meta.etag } : {});
			if (result.notModified) {
				const etag = result.etag ?? meta?.etag;
				backend.setSourceMeta(sourceUrl, {
					lastRefreshedAt: now(),
					...(etag ? { etag } : {}),
				});
				return;
			}
			const catalog = parseModelsDevApiJson(JSON.parse(result.body));
			if (catalog.size === 0) return;
			backend.upsertMany([...catalog.values()], "remote");
			backend.setSourceMeta(sourceUrl, { lastRefreshedAt: now(), ...(result.etag ? { etag: result.etag } : {}) });
		} catch {
			return;
		}
	}

	async function ensureRefreshed(): Promise<void> {
		if (!enabled || !backend) return;
		loadBundledSnapshot();
		if (refreshInFlight) return refreshInFlight;
		const meta = backend.getSourceMeta(sourceUrl);
		const stale =
			!meta || now().getTime() - meta.lastRefreshedAt.getTime() > refreshIntervalHours * 3600_000;
		if (!stale) return;
		refreshInFlight = refreshFromRemote().finally(() => {
			refreshInFlight = undefined;
		});
		await refreshInFlight;
		await backend.flushPending?.();
	}

	function seedFromBundled(catalogId: string): ModelCatalogEntry | undefined {
		if (!backend) return undefined;
		const bundled = loadBundledSnapshot();
		const entry = bundled.get(catalogId);
		if (entry) {
			backend.upsertMany([entry], "bundled");
		}
		return entry;
	}

	function lookup(catalogId: string): ModelCatalogBackendEntry | undefined {
		if (!backend) return undefined;
		const hit = backend.getEntry(catalogId);
		if (hit) return hit;
		const seeded = seedFromBundled(catalogId);
		if (seeded) return { entry: seeded, source: "bundled" };
		return undefined;
	}

	function resolveEntryFromBackend(
		providerId: string,
		modelId: string,
		hint?: ModelCatalogProviderHint,
	): { entry?: ModelCatalogEntry; source: CatalogSource; strategy?: CatalogMatchStrategy; ambiguous?: readonly string[] } {
		if (!backend) {
			return { source: "config" };
		}
		const explicitId = hint?.catalogId;
		if (explicitId) {
			const found = lookup(explicitId);
			if (found) {
				return { entry: found.entry, source: found.source, strategy: "explicit" };
			}
		}
		if (hint?.catalogProvider) {
			const found = lookup(`${hint.catalogProvider}/${modelId}`);
			if (found) {
				return { entry: found.entry, source: found.source, strategy: "catalog_provider" };
			}
		}
		const directFound = lookup(`${providerId}/${modelId}`);
		if (directFound) {
			return { entry: directFound.entry, source: directFound.source, strategy: "direct" };
		}
		let fuzzyMatches = backend.getEntriesByModelId(modelId);
		if (fuzzyMatches.length === 0) {
			// Bundled snapshot is the documented last-resort tier. Consult it for
			// modelId-based (fuzzy) resolution so offline/pre-refresh custom
			// providers can still resolve models present only in the bundled snapshot.
			const bundled = loadBundledSnapshot();
			const seeded: ModelCatalogEntry[] = [];
			for (const entry of bundled.values()) {
				if (entry.modelId === modelId) seeded.push(entry);
			}
			if (seeded.length > 0) {
				backend.upsertMany(seeded, "bundled");
				fuzzyMatches = backend.getEntriesByModelId(modelId);
			}
		}
		if (fuzzyMatches.length >= 1) {
			const first = fuzzyMatches[0]!;
			return {
				entry: first.entry,
				source: first.source,
				strategy: "fuzzy",
				...(fuzzyMatches.length > 1 ? { ambiguous: fuzzyMatches.map((m) => m.entry.catalogId) } : {}),
			};
		}
		return { source: "config" };
	}

	function resolve(providerId: string, modelId: string): ResolvedModelCatalog {
		if (!enabled) {
			return { source: "config" };
		}
		const providerHint = providerHints.find((p) => p.id === providerId);
		const override = overrides[`${providerId}/${modelId}`];
		const hint = override?.catalogId
			? {
					...(providerHint ?? { id: providerId }),
					catalogId: override.catalogId,
				}
			: providerHint;
		const result = resolveEntryFromBackend(providerId, modelId, hint);
		return {
			...(result.entry ? { entry: result.entry } : {}),
			source: result.entry ? result.source : "config",
			...(result.strategy ? { matchStrategy: result.strategy } : {}),
			...(result.ambiguous ? { ambiguousMatches: result.ambiguous } : {}),
		};
	}

	function buildOverrideFields(providerId: string, modelId: string): Partial<ModelSpec> {
		const key = `${providerId}/${modelId}`;
		const override = overrides[key];
		if (!override) return {};
		const fields: Partial<ModelSpec> = {};
		for (const specKey of MODEL_CATALOG_MODEL_SPEC_KEYS) {
			const value = (override as Record<string, unknown>)[specKey];
			if (value !== undefined) {
				(fields as Record<string, unknown>)[specKey as string] = value;
			}
		}
		return fields;
	}

	function enrichModelSpec(spec: ModelSpec): ModelSpec {
		if (!enabled || !applyToModelSpec) return spec;
		const resolved = resolve(spec.providerId, spec.modelId);
		const overrideFields = buildOverrideFields(spec.providerId, spec.modelId);

		const merged: Record<string, unknown> = { ...spec };

		const fillFrom = (source: Record<string, unknown>): boolean => {
			let applied = false;
			for (const [key, value] of Object.entries(source)) {
				if (key === "catalogSource") continue;
				if (value !== undefined && merged[key] === undefined) {
					merged[key] = value;
					applied = true;
				}
			}
			return applied;
		};

		const catalogFields = resolved.entry
			? mapCatalogEntryToModelSpecFields(resolved.entry, resolved.source)
			: {};
		const overrideApplied = fillFrom(overrideFields as Record<string, unknown>);
		fillFrom(catalogFields as Record<string, unknown>);

		merged.catalogSource = overrideApplied ? "override" : resolved.entry ? resolved.source : "config";

		return merged as unknown as ModelSpec;
	}

	return { ensureRefreshed, resolve, enrichModelSpec };
}
