import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const llmPackageName = "@aicr/llm";

export function getModelCatalogBundledSnapshotPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "../assets/model-catalog/models-dev.json");
}

export type ModelProviderKind =
	| "openai_compatible"
	| "azure_openai"
	| "anthropic"
	| "vertex_ai"
	| "bedrock"
	| "google_ai_studio"
	| "ollama"
	| "copilot";

export type CatalogSource = "override" | "config" | "remote" | "bundled" | "cache";

export type ModelStatus =
	| "stable"
	| "preview"
	| "experimental"
	| "alpha"
	| "beta"
	| "deprecated"
	| "shutdown";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ModelSpec {
	readonly providerKind: ModelProviderKind;
	readonly providerId: string;
	readonly modelId: string;
	readonly baseUrl?: string;
	readonly apiKeyEnv?: string;
	readonly organization?: string;
	readonly extraHeaders?: Readonly<Record<string, string>>;
	readonly extraBody?: Readonly<Record<string, unknown>>;
	readonly extraParams?: Readonly<Record<string, unknown>>;
	readonly httpProxy?: string;
	readonly timeoutMs?: number;
	readonly maxRetries?: number;
	readonly apiVersion?: string;
	readonly vertexProject?: string;
	readonly vertexLocation?: string;
	readonly googleApplicationCredentialsEnv?: string;
	readonly awsRegion?: string;
	readonly awsAccessKeyEnv?: string;
	readonly awsSecretKeyEnv?: string;
	readonly awsSessionTokenEnv?: string;
	readonly awsProfile?: string;
	readonly anthropicVersion?: string;
	readonly anthropicBeta?: readonly string[];
	readonly cacheControl?: "ephemeral" | "off";
	readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "max";
	readonly thinkingBudgetTokens?: number;
	readonly reasoningEffort?: "minimal" | "low" | "medium" | "high";
	readonly thinking?: { readonly enabled: boolean; readonly budgetTokens?: number };
	readonly responseFormat?: { readonly kind: "json_schema" | "json_object" | "text"; readonly schema?: unknown };
	readonly toolChoice?: "auto" | "none" | "required" | { readonly name: string };
	readonly parallelToolCalls?: boolean;
	readonly seed?: number;
	readonly logitBias?: Readonly<Record<string, number>>;
	readonly dropParams?: readonly string[];
	readonly allowedOpenaiParams?: readonly string[];
	readonly contextWindow?: number;
	readonly supportsToolCall?: boolean;
	readonly supportsVision?: boolean;
	readonly supportsCachePrompt?: boolean;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly costInputPerMTok?: number;
	readonly costOutputPerMTok?: number;
	readonly costCacheReadPerMTok?: number;
	readonly costCacheWritePerMTok?: number;
	readonly costReasoningPerMTok?: number;
	readonly costInputAudioPerMTok?: number;
	readonly costOutputAudioPerMTok?: number;
	readonly supportsReasoning?: boolean;
	// Descriptive list of every reasoning-effort tier the catalog advertises
	// (e.g. "none", "minimal", "low", "medium", "high", "xhigh", "max", "default").
	// Kept as plain strings so mainstream tiers like GPT-5.x `xhigh` or DeepSeek
	// `max` are not dropped; `defaultReasoningEffort` stays the narrow request value.
	readonly supportedReasoningEfforts?: readonly string[];
	readonly defaultReasoningEffort?: ReasoningEffort;
	readonly thinkingModes?: readonly string[];
	readonly supportsInterleavedReasoning?: boolean;
	readonly interleavedReasoningField?: string;
	readonly supportsStructuredOutput?: boolean;
	readonly supportsTemperature?: boolean;
	readonly supportsStreaming?: boolean;
	readonly supportsLogprobs?: boolean;
	readonly supportsAttachment?: boolean;
	readonly supportsSearch?: boolean;
	readonly supportsComputerUse?: boolean;
	readonly nativeToolCapabilities?: readonly string[];
	readonly supportedRequestParameters?: readonly string[];
	readonly unsupportedRequestParameters?: readonly string[];
	readonly inputModalities?: readonly string[];
	readonly outputModalities?: readonly string[];
	readonly catalogSource?: CatalogSource;
	readonly catalogId?: string;
	readonly displayName?: string;
	readonly family?: string;
	readonly knowledgeCutoff?: string;
	readonly trainingCutoff?: string;
	readonly releaseDate?: string;
	readonly lastUpdated?: string;
	readonly modelStatus?: ModelStatus;
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

export type ChatMessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
	readonly role: ChatMessageRole;
	readonly content: string;
	readonly name?: string;
}

export interface ChatCompletionInput {
	readonly model: ModelSpec;
	readonly messages: readonly ChatMessage[];
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly signal?: AbortSignal;
}

export interface ChatCompletionUsage {
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly totalTokens?: number;
}

export interface ChatCompletionResult {
	readonly providerId: string;
	readonly modelId: string;
	readonly content: string;
	readonly reasoningContent?: string;
	readonly usage?: ChatCompletionUsage;
	readonly raw: unknown;
}

export interface ResponseLike {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
	readonly headers: { get(name: string): string | null };
	json(): Promise<unknown>;
	text(): Promise<string>;
}

export type FetchLike = (
	input: string,
	init?: {
		readonly method?: string;
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: string;
		readonly signal?: AbortSignal;
	},
) => Promise<ResponseLike>;

export interface OpenAICompatibleClientOptions {
	readonly fetch?: FetchLike;
	readonly apiKeyResolver?: (envName: string) => string | undefined;
}

export interface ChatCompletionClient {
	complete(input: ChatCompletionInput): Promise<ChatCompletionResult>;
}

export class LlmProviderError extends Error {
	readonly status?: number;
	readonly retryAfter?: string;
	readonly responseBody?: string;

	constructor(
		message: string,
		options: { readonly status?: number; readonly retryAfter?: string; readonly responseBody?: string } = {},
	) {
		super(message);
		this.name = "LlmProviderError";
		if (options.status !== undefined) {
			this.status = options.status;
		}
		if (options.retryAfter !== undefined) {
			this.retryAfter = options.retryAfter;
		}
		if (options.responseBody !== undefined) {
			this.responseBody = options.responseBody;
		}
	}
}

function defaultFetch(): FetchLike {
	const candidate = globalThis.fetch;
	if (!candidate) {
		throw new TypeError("No global fetch implementation is available.");
	}

	return candidate as unknown as FetchLike;
}

function normalizeBaseUrl(model: ModelSpec): string {
	if (model.baseUrl) {
		return model.baseUrl.replace(/\/+$/u, "");
	}

	if (model.providerKind === "openai_compatible") {
		return "https://api.openai.com/v1";
	}

	if (model.providerKind === "ollama") {
		return "http://127.0.0.1:11434/v1";
	}

	throw new TypeError(`Provider kind ${model.providerKind} is not OpenAI-compatible.`);
}

function buildHeaders(
	model: ModelSpec,
	apiKeyResolver: (envName: string) => string | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		...(model.extraHeaders ?? {}),
	};

	if (model.organization) {
		headers["openai-organization"] = model.organization;
	}

	if (model.apiKeyEnv) {
		const apiKey = apiKeyResolver(model.apiKeyEnv);
		if (!apiKey) {
			throw new LlmProviderError(`Missing API key environment variable: ${model.apiKeyEnv}`);
		}
		headers.authorization = `Bearer ${apiKey}`;
	}

	return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstStringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string") {
			return candidate;
		}
	}

	return undefined;
}

function collectReasoningValue(value: unknown): string[] {
	if (typeof value === "string" && value.length > 0) {
		return [value];
	}

	if (Array.isArray(value)) {
		return value.flatMap((entry) => collectReasoningValue(entry));
	}

	if (!isRecord(value)) {
		return [];
	}

	const text = firstStringField(value, [
		"text",
		"content",
		"reasoning",
		"reasoning_content",
		"reasoningContent",
		"thinking",
		"thought",
	]);

	return text ? [text] : [];
}

function isReasoningContentPart(part: Record<string, unknown>): boolean {
	const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
	return part.thought === true || part.is_thought === true || /reason|think|thought/u.test(type);
}

function extractTextFromContentPart(part: unknown): string | undefined {
	if (typeof part === "string") {
		return part;
	}

	if (!isRecord(part)) {
		return undefined;
	}

	return firstStringField(part, ["text", "content", "output_text", "reasoning", "thinking"]);
}

function extractContentParts(content: unknown): { readonly content: string; readonly reasoningContent?: string } {
	if (typeof content === "string") {
		return { content };
	}

	if (content === null || content === undefined) {
		return { content: "" };
	}

	if (Array.isArray(content)) {
		const finalText: string[] = [];
		const reasoningText: string[] = [];
		for (const part of content) {
			const text = extractTextFromContentPart(part);
			if (text === undefined) {
				continue;
			}

			if (isRecord(part) && isReasoningContentPart(part)) {
				reasoningText.push(text);
			} else {
				finalText.push(text);
			}
		}

		return {
			content: finalText.join(""),
			...(reasoningText.length > 0 ? { reasoningContent: reasoningText.join("\n") } : {}),
		};
	}

	throw new LlmProviderError("OpenAI-compatible response message content is not text.");
}

function extractToolCallsAsJson(toolCalls: unknown): string | undefined {
	if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
		return undefined;
	}

	const translated = toolCalls.flatMap((entry) => {
		if (!isRecord(entry) || !isRecord(entry.function)) {
			return [];
		}

		const name = typeof entry.function.name === "string" ? entry.function.name : undefined;
		if (!name) {
			return [];
		}

		let input: unknown = {};
		if (typeof entry.function.arguments === "string" && entry.function.arguments.trim()) {
			try {
				input = JSON.parse(entry.function.arguments) as unknown;
			} catch {
				input = { arguments: entry.function.arguments };
			}
		}

		return [{ name, input }];
	});

	return translated.length > 0 ? JSON.stringify({ toolCalls: translated }) : undefined;
}

function extractContent(raw: unknown): { readonly content: string; readonly reasoningContent?: string } {
	if (!raw || typeof raw !== "object" || !("choices" in raw) || !Array.isArray(raw.choices)) {
		throw new LlmProviderError("OpenAI-compatible response did not include choices[].");
	}

	const firstChoice = raw.choices[0] as unknown;
	if (!firstChoice || typeof firstChoice !== "object" || !("message" in firstChoice)) {
		throw new LlmProviderError("OpenAI-compatible response did not include choices[0].message.");
	}

	const message = firstChoice.message as unknown;
	if (!isRecord(message)) {
		throw new LlmProviderError("OpenAI-compatible response did not include choices[0].message.");
	}

	if (!("content" in message) && !("tool_calls" in message)) {
		throw new LlmProviderError("OpenAI-compatible response did not include message content.");
	}

	const extracted = extractContentParts(message.content);
	const toolCallContent = extracted.content ? undefined : extractToolCallsAsJson(message.tool_calls);
	const reasoningText = [
		...collectReasoningValue(message.reasoning_content),
		...collectReasoningValue(message.reasoningContent),
		...collectReasoningValue(message.reasoning),
		...collectReasoningValue(message.thinking),
		...collectReasoningValue(message.thought),
		...collectReasoningValue(message.reasoning_details),
		...collectReasoningValue(message.reasoningDetails),
		...(extracted.reasoningContent ? [extracted.reasoningContent] : []),
	];

	return {
		content: toolCallContent ?? extracted.content,
		...(reasoningText.length > 0 ? { reasoningContent: reasoningText.join("\n") } : {}),
	};
}

function buildResponseFormat(format: ModelSpec["responseFormat"]): Record<string, unknown> | undefined {
	if (!format) {
		return undefined;
	}

	if (format.kind === "text") {
		return { type: "text" };
	}

	if (format.kind === "json_object") {
		return { type: "json_object" };
	}

	const schema = format.schema;
	if (isRecord(schema) && typeof schema.name === "string" && schema.schema !== undefined) {
		return { type: "json_schema", json_schema: schema };
	}

	return {
		type: "json_schema",
		json_schema: {
			name: "aicr_review_result",
			strict: true,
			schema: schema ?? {},
		},
	};
}

function thinkingLevelToReasoningEffort(level: ModelSpec["thinkingLevel"]): ModelSpec["reasoningEffort"] | undefined {
	switch (level) {
		case "minimal":
			return "minimal";
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		case "max":
			return "high";
		case "off":
		case undefined:
			return undefined;
	}
}

function normalizeToolChoice(toolChoice: ModelSpec["toolChoice"]): unknown {
	if (!toolChoice) {
		return undefined;
	}

	if (typeof toolChoice === "string") {
		return toolChoice;
	}

	return { type: "function", function: { name: toolChoice.name } };
}

function applyOpenAIParamFilters(body: Record<string, unknown>, model: ModelSpec): Record<string, unknown> {
	const filtered = { ...body };
	for (const param of model.dropParams ?? []) {
		delete filtered[param];
	}

	if (model.allowedOpenaiParams && model.allowedOpenaiParams.length > 0) {
		const alwaysAllowed = new Set(["model", "messages", "stream"]);
		const allowed = new Set([...model.allowedOpenaiParams, ...alwaysAllowed]);
		for (const key of Object.keys(filtered)) {
			if (!allowed.has(key)) {
				delete filtered[key];
			}
		}
	}

	return filtered;
}

function buildOpenAICompatibleBody(input: ChatCompletionInput): Record<string, unknown> {
	const responseFormat = buildResponseFormat(input.model.responseFormat);
	const reasoningEffort = input.model.reasoningEffort ?? thinkingLevelToReasoningEffort(input.model.thinkingLevel);
	const toolChoice = normalizeToolChoice(input.model.toolChoice);
	const thinking = input.model.thinking;
	const body: Record<string, unknown> = {
		model: input.model.modelId,
		messages: input.messages.map((message) => ({
			role: message.role,
			content: message.content,
			...(message.name ? { name: message.name } : {}),
		})),
		stream: false,
		...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
		...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
		...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
		...(input.model.thinkingBudgetTokens !== undefined
			? { thinking_budget_tokens: input.model.thinkingBudgetTokens }
			: {}),
		...(thinking
			? {
				thinking: {
					enabled: thinking.enabled,
					...(thinking.budgetTokens !== undefined ? { budget_tokens: thinking.budgetTokens } : {}),
				},
			}
			: {}),
		...(responseFormat ? { response_format: responseFormat } : {}),
		...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
		...(input.model.parallelToolCalls !== undefined ? { parallel_tool_calls: input.model.parallelToolCalls } : {}),
		...(input.model.seed !== undefined ? { seed: input.model.seed } : {}),
		...(input.model.logitBias ? { logit_bias: input.model.logitBias } : {}),
		...(input.model.extraParams ?? {}),
		...(input.model.extraBody ?? {}),
	};

	return applyOpenAIParamFilters(body, input.model);
}

function extractUsage(raw: unknown): ChatCompletionUsage | undefined {
	if (!raw || typeof raw !== "object" || !("usage" in raw)) {
		return undefined;
	}

	const usage = raw.usage as Record<string, unknown> | undefined;
	if (!usage) {
		return undefined;
	}

	return {
		...(typeof usage.prompt_tokens === "number" ? { promptTokens: usage.prompt_tokens } : {}),
		...(typeof usage.completion_tokens === "number" ? { completionTokens: usage.completion_tokens } : {}),
		...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
	};
}

export {
	createResilientChatClient,
	DailyBudgetTracker,
	extractModelPricing,
	LlmBudgetExceededError,
	LlmFallbackExhaustedError,
	type LlmGatewayBudgetConfig,
	type LlmGatewayFallbackEntry,
	type LlmGatewayOptions,
	type LlmGatewayPerProviderOverride,
	type LlmGatewayProviderConfig,
	type LlmGatewayRetryConfig,
	type LlmGatewayCallResult,
	type LlmGatewayChatClient,
	type ModelPricing,
} from "./gateway.js";

export {
	buildCompactedDiff,
	compressDiff,
	estimatePromptTokenCount,
	generatePerFileSummaries,
	scoreAndSelectHunks,
	shouldTriggerCompression,
	type CompressionConfig,
	type CompressionInput,
	type CompressionResult,
	type CompressDiffOptions,
	type ScoredHunk,
} from "./compression.js";

import { createAnthropicChatClient } from "./anthropic.js";
export { createAnthropicChatClient } from "./anthropic.js";
export type { AnthropicClientOptions } from "./anthropic.js";
import { createGoogleAiStudioChatClient } from "./google-ai-studio.js";
export { createGoogleAiStudioChatClient } from "./google-ai-studio.js";
export type { GoogleAiStudioClientOptions } from "./google-ai-studio.js";

export {
	mapCatalogEntryToModelSpecFields,
	parseModelsDevApiJson,
	resolveCatalogEntry,
} from "./model-catalog.js";
export type {
	CatalogMatchStrategy,
	CatalogResolutionHints,
	CatalogResolutionResult,
	ModelCatalogEntry,
} from "./model-catalog.js";

export function createOpenAICompatibleChatClient(
	options: OpenAICompatibleClientOptions = {},
): ChatCompletionClient {
	const fetchImpl = options.fetch ?? defaultFetch();
	const apiKeyResolver = options.apiKeyResolver ?? ((envName: string) => process.env[envName]);

	return {
		async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
			const baseUrl = normalizeBaseUrl(input.model);
			const body = buildOpenAICompatibleBody(input);
			const response = await fetchImpl(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: buildHeaders(input.model, apiKeyResolver),
				body: JSON.stringify(body),
				...(input.signal ? { signal: input.signal } : {}),
			});

			if (!response.ok) {
				const responseBody = await response.text();
				const retryAfter = response.headers.get("retry-after");
				throw new LlmProviderError(`OpenAI-compatible provider returned ${response.status}.`, {
					status: response.status,
					...(retryAfter ? { retryAfter } : {}),
					responseBody,
				});
			}

			const raw = await response.json();
			const usage = extractUsage(raw);
			const extracted = extractContent(raw);
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

export function createChatClientFromModelSpec(model: ModelSpec): ChatCompletionClient {
	switch (model.providerKind) {
		case "openai_compatible":
		case "ollama":
			return createOpenAICompatibleChatClient();
		case "azure_openai": {
			const apiVersion = model.apiVersion ?? "2024-06-01";
			const azureOpts: OpenAICompatibleClientOptions = {
				fetch: async (input, init) => {
					const url = new URL(input);
					url.searchParams.set("api-version", apiVersion);
					const resolvedUrl = url.toString();
					const candidate = globalThis.fetch;
					if (!candidate) {
						throw new TypeError("No global fetch implementation is available.");
					}
					const apiKey = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
					const headers: Record<string, string> = {
						...(init?.headers ?? {}),
						"content-type": "application/json",
						...(apiKey ? { "api-key": apiKey } : {}),
					};
				return candidate(resolvedUrl, { ...init, headers }) as unknown as Awaited<ReturnType<FetchLike>>;
			},
		};
		if (model.apiKeyEnv) {
			(azureOpts as Record<string, unknown>).apiKeyResolver = (envName: string) => process.env[envName];
		}
		return createOpenAICompatibleChatClient(azureOpts);
		}
		case "anthropic":
			return createAnthropicChatClient();
		case "google_ai_studio":
			return createGoogleAiStudioChatClient();
		case "vertex_ai":
		case "bedrock":
		case "copilot":
			throw new TypeError(
				`Provider kind "${model.providerKind}" is not yet supported. Only openai_compatible, ollama, azure_openai, anthropic, and google_ai_studio are implemented.`,
			);
	}
}