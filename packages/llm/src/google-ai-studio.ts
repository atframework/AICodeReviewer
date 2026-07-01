import {
	LlmProviderError,
	type ChatCompletionClient,
	type ChatCompletionInput,
	type ChatCompletionResult,
	type ChatCompletionUsage,
	type FetchLike,
	type ModelSpec,
} from "./index.js";

export interface GoogleAiStudioClientOptions {
	readonly fetch?: FetchLike;
	readonly apiKeyResolver?: (envName: string) => string | undefined;
}

function defaultFetch(): FetchLike {
	const candidate = globalThis.fetch;
	if (!candidate) {
		throw new TypeError("No global fetch implementation is available.");
	}

	return candidate as unknown as FetchLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(model: ModelSpec): string {
	return (model.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/u, "");
}

function normalizeModelPath(modelId: string): string {
	const normalized = modelId.replace(/^\/+|\/+$/gu, "");
	return normalized.startsWith("models/") ? normalized : `models/${normalized}`;
}

function buildHeaders(model: ModelSpec, apiKeyResolver: (envName: string) => string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		...(model.extraHeaders ?? {}),
	};

	if (model.apiKeyEnv) {
		const apiKey = apiKeyResolver(model.apiKeyEnv);
		if (!apiKey) {
			throw new LlmProviderError(`Missing API key environment variable: ${model.apiKeyEnv}`);
		}
		headers["x-goog-api-key"] = apiKey;
	}

	return headers;
}

function extractTextPart(part: unknown): string | undefined {
	return isRecord(part) && typeof part.text === "string" ? part.text : undefined;
}

function extractGoogleContent(raw: unknown): { readonly content: string; readonly reasoningContent?: string } {
	if (!isRecord(raw) || !Array.isArray(raw.candidates)) {
		throw new LlmProviderError("Google AI Studio response did not include candidates[].");
	}

	const firstCandidate = raw.candidates[0];
	if (!isRecord(firstCandidate) || !isRecord(firstCandidate.content) || !Array.isArray(firstCandidate.content.parts)) {
		throw new LlmProviderError("Google AI Studio response did not include candidates[0].content.parts[].");
	}

	const finalText: string[] = [];
	const thoughtText: string[] = [];
	for (const part of firstCandidate.content.parts) {
		const text = extractTextPart(part);
		if (text === undefined) {
			continue;
		}

		if (isRecord(part) && part.thought === true) {
			thoughtText.push(text);
		} else {
			finalText.push(text);
		}
	}

	return {
		content: finalText.join(""),
		...(thoughtText.length > 0 ? { reasoningContent: thoughtText.join("\n") } : {}),
	};
}

function extractGoogleUsage(raw: unknown): ChatCompletionUsage | undefined {
	if (!isRecord(raw) || !isRecord(raw.usageMetadata)) {
		return undefined;
	}

	const usage = raw.usageMetadata;
	return {
		...(typeof usage.promptTokenCount === "number" ? { promptTokens: usage.promptTokenCount } : {}),
		...(typeof usage.candidatesTokenCount === "number" ? { completionTokens: usage.candidatesTokenCount } : {}),
		...(typeof usage.totalTokenCount === "number" ? { totalTokens: usage.totalTokenCount } : {}),
		...(typeof usage.cachedContentTokenCount === "number" ? { cachedPromptTokens: usage.cachedContentTokenCount } : {}),
	};
}

function buildGenerationConfig(input: ChatCompletionInput): Record<string, unknown> | undefined {
	const generationConfig: Record<string, unknown> = {
		...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
		...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
	};

	if (input.model.responseFormat?.kind === "json_object" || input.model.responseFormat?.kind === "json_schema") {
		generationConfig.responseMimeType = "application/json";
	}

	if (input.model.responseFormat?.kind === "json_schema" && input.model.responseFormat.schema !== undefined) {
		generationConfig.responseSchema = input.model.responseFormat.schema;
	}

	const thinkingBudget = input.model.thinking?.budgetTokens ?? input.model.thinkingBudgetTokens;
	if (input.model.thinking?.enabled === false) {
		generationConfig.thinkingConfig = { thinkingBudget: 0 };
	} else if (input.model.thinking?.enabled || thinkingBudget !== undefined) {
		generationConfig.thinkingConfig = {
			includeThoughts: true,
			...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
		};
	}

	return Object.keys(generationConfig).length > 0 ? generationConfig : undefined;
}

function buildGoogleBody(input: ChatCompletionInput): Record<string, unknown> {
	const systemMessages = input.messages.filter((message) => message.role === "system");
	const conversationMessages = input.messages.filter((message) => message.role !== "system");
	const generationConfig = buildGenerationConfig(input);
	const body: Record<string, unknown> = {
		contents: conversationMessages.map((message) => ({
			role: message.role === "assistant" ? "model" : "user",
			parts: [{ text: message.content }],
		})),
		...(systemMessages.length > 0
			? { systemInstruction: { parts: systemMessages.map((message) => ({ text: message.content })) } }
			: {}),
		...(generationConfig ? { generationConfig } : {}),
		...(input.model.extraParams ?? {}),
		...(input.model.extraBody ?? {}),
	};

	return body;
}

export function createGoogleAiStudioChatClient(options: GoogleAiStudioClientOptions = {}): ChatCompletionClient {
	const fetchImpl = options.fetch ?? defaultFetch();
	const apiKeyResolver = options.apiKeyResolver ?? ((envName: string) => process.env[envName]);

	return {
		async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
			const baseUrl = normalizeBaseUrl(input.model);
			const modelPath = normalizeModelPath(input.model.modelId);
			const response = await fetchImpl(`${baseUrl}/${modelPath}:generateContent`, {
				method: "POST",
				headers: buildHeaders(input.model, apiKeyResolver),
				body: JSON.stringify(buildGoogleBody(input)),
				...(input.signal ? { signal: input.signal } : {}),
			});

			if (!response.ok) {
				const responseBody = await response.text();
				const retryAfter = response.headers.get("retry-after");
				throw new LlmProviderError(`Google AI Studio provider returned ${response.status}.`, {
					status: response.status,
					...(retryAfter ? { retryAfter } : {}),
					responseBody,
				});
			}

			const raw = await response.json();
			const usage = extractGoogleUsage(raw);
			const extracted = extractGoogleContent(raw);
			return {
				providerId: input.model.providerId,
				modelId: input.model.modelId,
				content: extracted.content,
				...(extracted.reasoningContent ? { reasoningContent: extracted.reasoningContent } : {}),
				...(usage ? { usage } : {}),
				raw,
			};
		},
	};
}