import type { CatalogSource, ModelSpec, ModelStatus } from "./index.js";
import { isPlainObject } from "@aicr/core";

export interface ModelCatalogEntry {
	readonly catalogId: string;
	readonly providerId: string;
	readonly modelId: string;
	readonly displayName?: string;
	readonly family?: string;
	readonly contextWindow?: number;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly costInputPerMTok?: number;
	readonly costOutputPerMTok?: number;
	readonly costCacheReadPerMTok?: number;
	readonly costCacheWritePerMTok?: number;
	readonly costReasoningPerMTok?: number;
	readonly costInputAudioPerMTok?: number;
	readonly costOutputAudioPerMTok?: number;
	readonly supportsToolCall?: boolean;
	readonly supportsAttachment?: boolean;
	readonly supportsVision?: boolean;
	readonly supportsCachePrompt?: boolean;
	readonly supportsReasoning?: boolean;
	readonly supportedReasoningEfforts?: readonly string[];
	readonly thinkingModes?: readonly string[];
	readonly supportsInterleavedReasoning?: boolean;
	readonly interleavedReasoningField?: string;
	readonly supportsStructuredOutput?: boolean;
	readonly supportsTemperature?: boolean;
	readonly inputModalities?: readonly string[];
	readonly outputModalities?: readonly string[];
	readonly knowledgeCutoff?: string;
	readonly releaseDate?: string;
	readonly lastUpdated?: string;
	readonly modelStatus?: ModelStatus;
	readonly openWeights?: boolean;
	readonly experimental?: boolean;
	readonly license?: string;
	readonly providerDisplayName?: string;
	readonly providerNpmPackage?: string;
	readonly providerEnvVars?: readonly string[];
	readonly providerDocsUrl?: string;
}

const MODEL_STATUS_VALUES = new Set<ModelStatus>([
	"stable",
	"preview",
	"experimental",
	"alpha",
	"beta",
	"deprecated",
	"shutdown",
]);

function asStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: string[] = [];
	for (const item of value) {
		if (typeof item === "string") result.push(item);
	}
	return result.length > 0 ? result : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function normalizeStatus(statusRaw: unknown, experimental: boolean | undefined): ModelStatus | undefined {
	const status = asString(statusRaw);
	if (status && MODEL_STATUS_VALUES.has(status as ModelStatus)) {
		return status as ModelStatus;
	}
	if (status) {
		const lower = status.toLowerCase();
		if (MODEL_STATUS_VALUES.has(lower as ModelStatus)) return lower as ModelStatus;
	}
	if (experimental) return "experimental";
	return undefined;
}

function extractReasoningEfforts(options: unknown): readonly string[] | undefined {
	if (!Array.isArray(options)) return undefined;
	// Capture every advertised effort tier in source order (deduplicated). Tiers
	// such as "none", "xhigh", "max", and "default" appear in real models.dev data
	// for GPT-5.x / DeepSeek / others, so they must not be filtered out.
	const efforts: string[] = [];
	const seen = new Set<string>();
	for (const opt of options) {
		if (!isPlainObject(opt)) continue;
		if (opt.type === "effort" && Array.isArray(opt.values)) {
			for (const v of opt.values) {
				if (typeof v === "string" && v.length > 0 && !seen.has(v)) {
					seen.add(v);
					efforts.push(v);
				}
			}
		}
	}
	return efforts.length > 0 ? efforts : undefined;
}

function extractThinkingModes(options: unknown): readonly string[] | undefined {
	if (!Array.isArray(options)) return undefined;
	const modes = new Set<string>();
	for (const opt of options) {
		if (!isPlainObject(opt)) continue;
		const type = asString(opt.type);
		if (type) modes.add(type);
	}
	return modes.size > 0 ? [...modes] : undefined;
}

function buildEntryFromModel(
	providerId: string,
	modelId: string,
	providerMeta: Record<string, unknown> | undefined,
	raw: Record<string, unknown>,
): ModelCatalogEntry {
	const limit = isPlainObject(raw.limit) ? raw.limit : {};
	const cost = isPlainObject(raw.cost) ? raw.cost : {};
	const modalities = isPlainObject(raw.modalities) ? raw.modalities : {};
	const inputModalities = asStringArray(modalities.input);
	const attachment = asBoolean(raw.attachment);
	const interleaved = isPlainObject(raw.interleaved) ? raw.interleaved : {};
	const reasoningOptions = raw.reasoning_options;
	const experimental = asBoolean(raw.experimental);
	const costCacheRead = asNumber(cost.cache_read);
	const costCacheWrite = asNumber(cost.cache_write);
	const license = isPlainObject(raw.weights) ? asString((raw.weights as Record<string, unknown>).license) : asString(raw.license);

	const entry: Record<string, unknown> = {
		catalogId: `${providerId}/${modelId}`,
		providerId,
		modelId,
	};

	const assign = (key: string, value: unknown): void => {
		if (value !== undefined) entry[key] = value;
	};

	assign("displayName", asString(raw.name));
	assign("family", asString(raw.family));
	assign("contextWindow", asNumber(limit.context));
	assign("maxInputTokens", asNumber(limit.input));
	assign("maxOutputTokens", asNumber(limit.output));
	assign("costInputPerMTok", asNumber(cost.input));
	assign("costOutputPerMTok", asNumber(cost.output));
	assign("costCacheReadPerMTok", costCacheRead);
	assign("costCacheWritePerMTok", costCacheWrite);
	assign("costReasoningPerMTok", asNumber(cost.reasoning));
	assign("costInputAudioPerMTok", asNumber(cost.input_audio));
	assign("costOutputAudioPerMTok", asNumber(cost.output_audio));
	assign("supportsToolCall", asBoolean(raw.tool_call));
	assign("supportsAttachment", attachment);
	assign("supportsVision", attachment === true || (inputModalities?.includes("image") ?? false));
	assign("supportsCachePrompt", costCacheRead !== undefined || costCacheWrite !== undefined ? true : undefined);
	assign("supportsReasoning", asBoolean(raw.reasoning));
	assign("supportedReasoningEfforts", extractReasoningEfforts(reasoningOptions));
	assign("thinkingModes", extractThinkingModes(reasoningOptions));
	const interleavedField = asString(interleaved.field);
	assign("supportsInterleavedReasoning", interleavedField !== undefined ? true : undefined);
	assign("interleavedReasoningField", interleavedField);
	assign("supportsStructuredOutput", asBoolean(raw.structured_output));
	assign("supportsTemperature", asBoolean(raw.temperature));
	assign("inputModalities", inputModalities);
	assign("outputModalities", asStringArray(modalities.output));
	assign("knowledgeCutoff", asString(raw.knowledge));
	assign("releaseDate", asString(raw.release_date));
	assign("lastUpdated", asString(raw.last_updated));
	assign("modelStatus", normalizeStatus(raw.status, experimental));
	assign("openWeights", asBoolean(raw.open_weights));
	assign("experimental", experimental);
	assign("license", license);
	assign("providerDisplayName", providerMeta ? asString(providerMeta.name) : undefined);
	assign("providerNpmPackage", providerMeta ? asString(providerMeta.npm) : undefined);
	assign("providerEnvVars", providerMeta ? asStringArray(providerMeta.env) : undefined);
	assign("providerDocsUrl", providerMeta ? asString(providerMeta.doc) : undefined);

	return entry as unknown as ModelCatalogEntry;
}

export function parseModelsDevApiJson(json: unknown): ReadonlyMap<string, ModelCatalogEntry> {
	if (!isPlainObject(json)) {
		throw new TypeError("models.dev api.json root must be a JSON object keyed by provider id.");
	}

	const catalog = new Map<string, ModelCatalogEntry>();

	for (const [providerId, providerValue] of Object.entries(json)) {
		if (!isPlainObject(providerValue)) continue;
		const models = providerValue.models;
		if (!isPlainObject(models)) continue;
		const providerMeta: Record<string, unknown> = {
			name: providerValue.name,
			npm: providerValue.npm,
			env: providerValue.env,
			doc: providerValue.doc,
		};

		for (const [modelId, modelValue] of Object.entries(models)) {
			if (!isPlainObject(modelValue)) continue;
			const entry = buildEntryFromModel(providerId, modelId, providerMeta, modelValue);
			catalog.set(entry.catalogId, entry);
		}
	}

	return catalog;
}

export interface CatalogResolutionHints {
	readonly overrideCatalogId?: string;
	readonly catalogProvider?: string;
}

export type CatalogMatchStrategy = "explicit" | "catalog_provider" | "direct" | "fuzzy";

export interface CatalogResolutionResult {
	readonly entry: ModelCatalogEntry;
	readonly matchedCatalogId: string;
	readonly matchStrategy: CatalogMatchStrategy;
	readonly ambiguousMatches?: readonly string[];
}

export function resolveCatalogEntry(
	catalog: ReadonlyMap<string, ModelCatalogEntry>,
	providerId: string,
	modelId: string,
	hints?: CatalogResolutionHints,
): CatalogResolutionResult | undefined {
	const explicit = hints?.overrideCatalogId;
	if (explicit) {
		const entry = catalog.get(explicit);
		if (entry) {
			return { entry, matchedCatalogId: explicit, matchStrategy: "explicit" };
		}
	}

	if (hints?.catalogProvider) {
		const key = `${hints.catalogProvider}/${modelId}`;
		const entry = catalog.get(key);
		if (entry) {
			return { entry, matchedCatalogId: key, matchStrategy: "catalog_provider" };
		}
	}

	const directKey = `${providerId}/${modelId}`;
	const directEntry = catalog.get(directKey);
	if (directEntry) {
		return { entry: directEntry, matchedCatalogId: directKey, matchStrategy: "direct" };
	}

	const fuzzyMatches: string[] = [];
	for (const candidate of catalog.values()) {
		if (candidate.modelId === modelId) {
			fuzzyMatches.push(candidate.catalogId);
		}
	}
	if (fuzzyMatches.length === 1) {
		const key = fuzzyMatches[0]!;
		const entry = catalog.get(key)!;
		return { entry, matchedCatalogId: key, matchStrategy: "fuzzy" };
	}
	if (fuzzyMatches.length > 1) {
		const key = fuzzyMatches[0]!;
		const entry = catalog.get(key)!;
		return {
			entry,
			matchedCatalogId: key,
			matchStrategy: "fuzzy",
			ambiguousMatches: fuzzyMatches,
		};
	}

	return undefined;
}

const RUNTIME_FIELD_KEYS: readonly (keyof ModelSpec)[] = [
	"contextWindow",
	"maxInputTokens",
	"maxOutputTokens",
	"costInputPerMTok",
	"costOutputPerMTok",
	"costCacheReadPerMTok",
	"costCacheWritePerMTok",
	"costReasoningPerMTok",
	"costInputAudioPerMTok",
	"costOutputAudioPerMTok",
	"supportsToolCall",
	"supportsAttachment",
	"supportsVision",
	"supportsCachePrompt",
	"supportsReasoning",
	"supportedReasoningEfforts",
	"thinkingModes",
	"supportsInterleavedReasoning",
	"interleavedReasoningField",
	"supportsStructuredOutput",
	"supportsTemperature",
	"inputModalities",
	"outputModalities",
	"supportsSearch",
	"supportsComputerUse",
	"nativeToolCapabilities",
	"supportedRequestParameters",
	"unsupportedRequestParameters",
	"supportsStreaming",
	"supportsLogprobs",
];

const VENDOR_FIELD_KEYS: readonly (keyof ModelSpec)[] = [
	"catalogId",
	"displayName",
	"family",
	"knowledgeCutoff",
	"trainingCutoff",
	"releaseDate",
	"lastUpdated",
	"modelStatus",
	"openWeights",
	"license",
	"modelLinks",
	"providerDisplayName",
	"providerNpmPackage",
	"providerEnvVars",
	"providerApiBaseUrl",
	"providerDocsUrl",
	"providerModelAliases",
	"providerModelIds",
	"preferredEndpoint",
	"latencyClass",
	"priorityTierSupported",
	"rateLimitTier",
	"concurrencyLimit",
	"throughputHintTokensPerSecond",
];

export function mapCatalogEntryToModelSpecFields(
	entry: ModelCatalogEntry,
	source: CatalogSource,
): Partial<ModelSpec> {
	const fields: Partial<ModelSpec> = { catalogSource: source };

	const copy = (specKey: keyof ModelSpec, entryKey: keyof ModelCatalogEntry): void => {
		const value = entry[entryKey];
		if (value !== undefined) {
			(fields as Record<string, unknown>)[specKey as string] = value;
		}
	};

	for (const key of RUNTIME_FIELD_KEYS) {
		copy(key, key as keyof ModelCatalogEntry);
	}
	for (const key of VENDOR_FIELD_KEYS) {
		copy(key, key as keyof ModelCatalogEntry);
	}

	return fields;
}
