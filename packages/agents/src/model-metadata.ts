import type { ModelSpec } from "@aicr/llm";

function buildGenericModelInfo(
	model: ModelSpec,
	includeCachePrices: boolean,
): Record<string, unknown> | undefined {
	const info: Record<string, unknown> = {};
	let hasAny = false;
	const set = (key: string, value: unknown): void => {
		if (value !== undefined) {
			info[key] = value;
			hasAny = true;
		}
	};

	set("contextWindow", model.contextWindow);
	set("maxTokens", model.maxOutputTokens);
	set("supportsImages", model.supportsVision);
	set("supportsComputerUse", model.supportsComputerUse);
	set("supportsPromptCache", model.supportsCachePrompt);
	if (model.costInputPerMTok !== undefined) {
		set("inputPrice", model.costInputPerMTok);
	}
	if (model.costOutputPerMTok !== undefined) {
		set("outputPrice", model.costOutputPerMTok);
	}
	if (includeCachePrices) {
		if (model.costCacheReadPerMTok !== undefined) {
			set("cacheReadsPrice", model.costCacheReadPerMTok);
		}
		if (model.costCacheWritePerMTok !== undefined) {
			set("cacheWritesPrice", model.costCacheWritePerMTok);
		}
	}

	return hasAny ? info : undefined;
}

export function buildKiloModelInfo(model: ModelSpec): Record<string, unknown> | undefined {
	return buildGenericModelInfo(model, true);
}

export function buildRooCustomModelInfo(model: ModelSpec): Record<string, unknown> | undefined {
	return buildGenericModelInfo(model, false);
}

export function isOpenCodeCustomProvider(model: ModelSpec): boolean {
	return model.providerKind === "openai_compatible" || model.providerKind === "ollama";
}

export function buildOpencodeModelEntry(model: ModelSpec): Record<string, unknown> | undefined {
	if (!isOpenCodeCustomProvider(model)) return undefined;

	const limit: Record<string, unknown> = {};
	let hasLimit = false;
	if (model.contextWindow !== undefined) {
		limit.context = model.contextWindow;
		hasLimit = true;
	}
	if (model.maxOutputTokens !== undefined) {
		limit.output = model.maxOutputTokens;
		hasLimit = true;
	}

	const cost: Record<string, unknown> = {};
	let hasCost = false;
	if (model.costInputPerMTok !== undefined) {
		cost.input = model.costInputPerMTok;
		hasCost = true;
	}
	if (model.costOutputPerMTok !== undefined) {
		cost.output = model.costOutputPerMTok;
		hasCost = true;
	}
	if (model.costCacheReadPerMTok !== undefined) {
		cost.cache_read = model.costCacheReadPerMTok;
		hasCost = true;
	}
	if (model.costCacheWritePerMTok !== undefined) {
		cost.cache_write = model.costCacheWritePerMTok;
		hasCost = true;
	}

	const entry: Record<string, unknown> = {};
	if (model.displayName) {
		entry.name = model.displayName;
	} else {
		entry.name = model.modelId;
	}
	if (hasLimit) entry.limit = limit;
	if (hasCost) entry.cost = cost;

	return entry;
}
