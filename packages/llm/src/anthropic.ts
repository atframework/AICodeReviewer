import {
	LlmProviderError,
	type ChatCompletionClient,
	type ChatCompletionInput,
	type ChatCompletionResult,
	type ChatCompletionUsage,
	type FetchLike,
	type ModelSpec,
} from "./index.js";

export interface AnthropicClientOptions {
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

function extractAnthropicContent(raw: unknown): string {
	if (!raw || typeof raw !== "object" || !("content" in raw) || !Array.isArray(raw.content)) {
		throw new LlmProviderError("Anthropic response did not include content array.");
	}

	const content = raw.content as unknown[];
	return content
		.flatMap((block) => {
			if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
				return [block.text];
			}
			return [];
		})
		.join("");
}

function extractAnthropicReasoningContent(raw: unknown): string | undefined {
	if (!raw || typeof raw !== "object" || !("content" in raw) || !Array.isArray(raw.content)) {
		return undefined;
	}

	const content = raw.content as unknown[];
	const reasoning = content.flatMap((block) => {
		if (!block || typeof block !== "object") {
			return [];
		}

		const record = block as Record<string, unknown>;
		if (record.type === "thinking" && typeof record.thinking === "string") {
			return [record.thinking];
		}

		if (record.type === "redacted_thinking" && typeof record.data === "string") {
			return [record.data];
		}

		return [];
	});

	return reasoning.length > 0 ? reasoning.join("\n") : undefined;
}

function extractAnthropicUsage(raw: unknown): ChatCompletionUsage | undefined {
	if (!raw || typeof raw !== "object" || !("usage" in raw)) {
		return undefined;
	}

	const usage = raw.usage as Record<string, unknown> | undefined;
	if (!usage) {
		return undefined;
	}

	const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
	const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined;
	const cacheCreation =
		typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined;
	const totalInput = inputTokens !== undefined ? inputTokens + (cacheRead ?? 0) : undefined;

	return {
		...(totalInput !== undefined ? { promptTokens: totalInput } : {}),
		...(typeof usage.output_tokens === "number" ? { completionTokens: usage.output_tokens } : {}),
		...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
		...(cacheRead !== undefined ? { cachedPromptTokens: cacheRead } : {}),
		...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
	};
}

function buildAnthropicHeaders(model: ModelSpec, apiKeyResolver: (envName: string) => string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		...(model.extraHeaders ?? {}),
	};

	if (model.anthropicVersion) {
		headers["anthropic-version"] = model.anthropicVersion;
	} else {
		headers["anthropic-version"] = "2023-06-01";
	}

	if (model.apiKeyEnv) {
		const apiKey = apiKeyResolver(model.apiKeyEnv);
		if (!apiKey) {
			throw new LlmProviderError(`Missing API key environment variable: ${model.apiKeyEnv}`);
		}
		headers["x-api-key"] = apiKey;
	}

	if (model.anthropicBeta && model.anthropicBeta.length > 0) {
		headers["anthropic-beta"] = model.anthropicBeta.join(",");
	}

	return headers;
}

export function createAnthropicChatClient(options: AnthropicClientOptions = {}): ChatCompletionClient {
	const fetchImpl = options.fetch ?? defaultFetch();
	const apiKeyResolver = options.apiKeyResolver ?? ((envName: string) => process.env[envName]);

	return {
		async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
			const baseUrl = input.model.baseUrl ?? "https://api.anthropic.com";
			const systemMessage = input.messages.find((m) => m.role === "system")?.content;
			const conversationMessages = input.messages.filter((m) => m.role !== "system");

			const body: Record<string, unknown> = {
				model: input.model.modelId,
				max_tokens: input.maxTokens ?? input.model.extraParams?.max_tokens ?? 4096,
				messages: conversationMessages.map((message) => ({
					role: message.role === "assistant" ? "assistant" : "user",
					content: message.content,
				})),
				stream: false,
				...(systemMessage !== undefined ? { system: systemMessage } : {}),
				...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
				...(input.model.thinking?.enabled
					? {
						thinking: {
							type: "enabled",
							budget_tokens: input.model.thinking.budgetTokens ?? 4096,
						},
					}
					: {}),
				...(input.model.extraBody ?? {}),
			};

			const response = await fetchImpl(`${baseUrl}/v1/messages`, {
				method: "POST",
				headers: buildAnthropicHeaders(input.model, apiKeyResolver),
				body: JSON.stringify(body),
				...(input.signal ? { signal: input.signal } : {}),
			});

			if (!response.ok) {
				const responseBody = await response.text();
				const retryAfter = response.headers.get("retry-after");
				throw new LlmProviderError(`Anthropic provider returned ${response.status}.`, {
					status: response.status,
					...(retryAfter ? { retryAfter } : {}),
					responseBody,
				});
			}

			const raw = await response.json();
			const usage = extractAnthropicUsage(raw);
			const reasoningContent = extractAnthropicReasoningContent(raw);
			return {
				providerId: input.model.providerId,
				modelId: input.model.modelId,
				content: extractAnthropicContent(raw),
				...(reasoningContent ? { reasoningContent } : {}),
				...(usage ? { usage } : {}),
				raw,
			};
		},
	};
}
