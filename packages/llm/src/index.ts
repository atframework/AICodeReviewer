export const llmPackageName = "@aicr/llm";

export type ModelProviderKind =
	| "openai_compatible"
	| "azure_openai"
	| "anthropic"
	| "vertex_ai"
	| "bedrock"
	| "google_ai_studio"
	| "ollama"
	| "copilot";

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

function extractContent(raw: unknown): string {
	if (!raw || typeof raw !== "object" || !("choices" in raw) || !Array.isArray(raw.choices)) {
		throw new LlmProviderError("OpenAI-compatible response did not include choices[].");
	}

	const firstChoice = raw.choices[0] as unknown;
	if (!firstChoice || typeof firstChoice !== "object" || !("message" in firstChoice)) {
		throw new LlmProviderError("OpenAI-compatible response did not include choices[0].message.");
	}

	const message = firstChoice.message as unknown;
	if (!message || typeof message !== "object" || !("content" in message)) {
		throw new LlmProviderError("OpenAI-compatible response did not include message content.");
	}

	const content = (message as { content: unknown }).content;
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.flatMap((part) => {
				if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
					return [part.text];
				}
				return [];
			})
			.join("");
	}

	throw new LlmProviderError("OpenAI-compatible response message content is not text.");
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

export function createOpenAICompatibleChatClient(
	options: OpenAICompatibleClientOptions = {},
): ChatCompletionClient {
	const fetchImpl = options.fetch ?? defaultFetch();
	const apiKeyResolver = options.apiKeyResolver ?? ((envName: string) => process.env[envName]);

	return {
		async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
			const baseUrl = normalizeBaseUrl(input.model);
			const body = {
				model: input.model.modelId,
				messages: input.messages.map((message) => ({
					role: message.role,
					content: message.content,
					...(message.name ? { name: message.name } : {}),
				})),
				stream: false,
				...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
				...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
				...(input.model.extraParams ?? {}),
				...(input.model.extraBody ?? {}),
			};
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
			return {
				providerId: input.model.providerId,
				modelId: input.model.modelId,
				content: extractContent(raw),
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
		case "vertex_ai":
		case "bedrock":
		case "google_ai_studio":
		case "copilot":
			throw new TypeError(
				`Provider kind "${model.providerKind}" is not yet supported. Only openai_compatible, ollama, azure_openai, and anthropic are implemented.`,
			);
	}
}