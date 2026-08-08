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

export function buildZooCustomModelInfo(model: ModelSpec): Record<string, unknown> | undefined {
	return buildGenericModelInfo(model, false);
}

export function isOpenCodeCustomProvider(model: ModelSpec): boolean {
	return model.providerKind === "openai_compatible" || model.providerKind === "ollama";
}

const OPENCODE_MODALITIES = new Set(["text", "audio", "image", "video", "pdf"]);

function toOpenCodeModalities(values: readonly string[] | undefined): string[] | undefined {
	const supported = values?.filter((value) => OPENCODE_MODALITIES.has(value));
	return supported && supported.length > 0 ? supported : undefined;
}

export function buildOpencodeModelEntry(model: ModelSpec): Record<string, unknown> | undefined {
	if (!isOpenCodeCustomProvider(model)) return undefined;

	const entry: Record<string, unknown> = {
		name: model.displayName ?? model.modelId,
	};
	// OpenCode's schema requires both fields when either block is present. Do not
	// invent the missing half of a partial catalog/override result.
	if (model.contextWindow !== undefined && model.maxOutputTokens !== undefined) {
		entry.limit = {
			context: model.contextWindow,
			...(model.maxInputTokens !== undefined ? { input: model.maxInputTokens } : {}),
			output: model.maxOutputTokens,
		};
	}
	if (model.costInputPerMTok !== undefined && model.costOutputPerMTok !== undefined) {
		entry.cost = {
			input: model.costInputPerMTok,
			output: model.costOutputPerMTok,
			...(model.costCacheReadPerMTok !== undefined ? { cache_read: model.costCacheReadPerMTok } : {}),
			...(model.costCacheWritePerMTok !== undefined ? { cache_write: model.costCacheWritePerMTok } : {}),
		};
	}
	if (model.supportsAttachment !== undefined || model.supportsVision !== undefined) {
		entry.attachment = model.supportsAttachment ?? model.supportsVision;
	}
	if (model.supportsReasoning !== undefined) entry.reasoning = model.supportsReasoning;
	if (model.supportsTemperature !== undefined) entry.temperature = model.supportsTemperature;
	if (model.supportsToolCall !== undefined) entry.tool_call = model.supportsToolCall;
	if (model.supportsInterleavedReasoning !== undefined) {
		entry.interleaved = model.supportsInterleavedReasoning
			? (model.interleavedReasoningField ?? true)
			: false;
	}
	const inputModalities = toOpenCodeModalities(model.inputModalities);
	const outputModalities = toOpenCodeModalities(model.outputModalities);
	if (inputModalities || outputModalities) {
		entry.modalities = {
			...(inputModalities ? { input: inputModalities } : {}),
			...(outputModalities ? { output: outputModalities } : {}),
		};
	}

	return entry;
}
