import { describe, expect, it, vi } from "vitest";

import {
	createResilientChatClient,
	LlmFallbackExhaustedError,
	LlmProviderError,
	type ChatCompletionClient,
	type ChatCompletionInput,
	type ChatCompletionResult,
	type LlmGatewayOptions,
	type ModelSpec,
} from "../src/index.js";

const baseModel: ModelSpec = {
	providerKind: "openai_compatible",
	providerId: "openai-prod",
	modelId: "gpt-test",
	baseUrl: "https://llm.example/v1/",
};

function makeClient(result: ChatCompletionResult): ChatCompletionClient {
	return {
		async complete(): Promise<ChatCompletionResult> {
			return result;
		},
	};
}

function makeFailingClient(error: unknown): ChatCompletionClient {
	return {
		async complete(): Promise<never> {
			throw error;
		},
	};
}

function makeToggleClient(results: (ChatCompletionResult | Error)[]): ChatCompletionClient {
	let callIndex = 0;
	return {
		async complete(): Promise<ChatCompletionResult> {
			const result = results[callIndex];
			callIndex++;
			if (result instanceof Error) {
				throw result;
			}

			return result;
		},
	};
}

function makeOptions(partial: Partial<LlmGatewayOptions> & Pick<LlmGatewayOptions, "clientFactory">): LlmGatewayOptions {
	return {
		providers: [
			{ id: "openai-prod", kind: "openai_compatible" },
			{ id: "anthropic-prod", kind: "openai_compatible" },
		],
		fallbackChain: [{ provider: "anthropic-prod", model: "claude-test", role: "heavy" }],
		...partial,
	};
}

describe("createResilientChatClient", () => {
	it("returns the result from the primary client on success", async () => {
		const expected: ChatCompletionResult = {
			providerId: "openai-prod",
			modelId: "gpt-test",
			content: "ok",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			raw: {},
		};

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: () => makeClient(expected),
			}),
		);

		const result = await gateway.complete({ model: baseModel, messages: [] });
		expect(result.content).toBe("ok");
		expect(result.fallbackCount).toBe(0);
		expect(result.retryCount).toBe(0);
	});

	it("falls back to the next model in the chain on fallback-eligible errors", async () => {
		const primaryError = new LlmProviderError("primary failed", { status: 500 });
		const fallbackResult: ChatCompletionResult = {
			providerId: "anthropic-prod",
			modelId: "claude-test",
			content: "fallback ok",
			usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
			raw: {},
		};

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						return makeFailingClient(primaryError);
					}

					return makeClient(fallbackResult);
				},
			}),
		);

		const result = await gateway.complete({ model: baseModel, messages: [] });
		expect(result.content).toBe("fallback ok");
		expect(result.providerId).toBe("anthropic-prod");
		expect(result.fallbackCount).toBe(1);
	});

	it("throws non-retryable provider errors without falling back", async () => {
		const clientError = new LlmProviderError("bad request", { status: 400 });
		const onFallback = vi.fn();
		const fallbackFactory = vi.fn(() =>
			makeClient({ providerId: "anthropic-prod", modelId: "claude-test", content: "fallback", raw: {} }),
		);

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						return makeFailingClient(clientError);
					}

					return fallbackFactory();
				},
				onFallback,
			}),
		);

		await expect(gateway.complete({ model: baseModel, messages: [] })).rejects.toBe(clientError);
		expect(onFallback).not.toHaveBeenCalled();
		expect(fallbackFactory).not.toHaveBeenCalled();
	});

	it("falls back on context overflow errors even when the provider returns 400", async () => {
		const contextOverflowError = new LlmProviderError("context length exceeded", {
			status: 400,
			responseBody: "maximum context length exceeded",
		});
		const fallbackResult: ChatCompletionResult = {
			providerId: "anthropic-prod",
			modelId: "claude-test",
			content: "fallback ok",
			raw: {},
		};

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						return makeFailingClient(contextOverflowError);
					}

					return makeClient(fallbackResult);
				},
			}),
		);

		const result = await gateway.complete({ model: baseModel, messages: [] });

		expect(result.content).toBe("fallback ok");
		expect(result.fallbackCount).toBe(1);
	});

	it("retries on 429 errors before falling back", async () => {
		const rateLimitError = new LlmProviderError("rate limited", { status: 429, retryAfter: "1" });
		const successResult: ChatCompletionResult = {
			providerId: "openai-prod",
			modelId: "gpt-test",
			content: "ok after retry",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			raw: {},
		};

		const sharedClient = makeToggleClient([rateLimitError, successResult]);
		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: () => sharedClient,
				retry: { maxAttempts: 3, backoff: { kind: "constant", baseMs: 10, jitter: false } },
			}),
		);

		const start = Date.now();
		const result = await gateway.complete({ model: baseModel, messages: [] });
		const elapsed = Date.now() - start;

		expect(result.content).toBe("ok after retry");
		expect(result.retryCount).toBe(1);
		expect(result.fallbackCount).toBe(0);
		expect(elapsed).toBeLessThan(100);
	});

	it("falls back after retry attempts are exhausted", async () => {
		const rateLimitError = new LlmProviderError("rate limited", { status: 429 });
		const fallbackResult: ChatCompletionResult = {
			providerId: "anthropic-prod",
			modelId: "claude-test",
			content: "fallback ok",
			usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
			raw: {},
		};

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						return makeFailingClient(rateLimitError);
					}

					return makeClient(fallbackResult);
				},
				retry: { maxAttempts: 2, backoff: { kind: "constant", baseMs: 1, jitter: false } },
			}),
		);

		const result = await gateway.complete({ model: baseModel, messages: [] });
		expect(result.content).toBe("fallback ok");
		expect(result.fallbackCount).toBe(1);
		expect(result.retryCount).toBe(1);
	});

	it("treats maxAttempts as total provider calls and does not sleep after the final attempt", async () => {
		const rateLimitError = new LlmProviderError("rate limited", { status: 429 });
		let primaryCalls = 0;

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						return {
							async complete(): Promise<never> {
								primaryCalls++;
								throw rateLimitError;
							},
						};
					}

					return makeClient({ providerId: "anthropic-prod", modelId: "claude-test", content: "fallback ok", raw: {} });
				},
				retry: { maxAttempts: 1, backoff: { kind: "constant", baseMs: 1000, jitter: false } },
			}),
		);

		const start = Date.now();
		const result = await gateway.complete({ model: baseModel, messages: [] });

		expect(result.content).toBe("fallback ok");
		expect(primaryCalls).toBe(1);
		expect(result.retryCount).toBe(0);
		expect(Date.now() - start).toBeLessThan(100);
	});

	it("throws LlmFallbackExhaustedError when all options fail", async () => {
		const primaryError = new LlmProviderError("primary failed", { status: 500 });
		const fallbackError = new LlmProviderError("fallback failed", { status: 500 });

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						return makeFailingClient(primaryError);
					}

					return makeFailingClient(fallbackError);
				},
				retry: { maxAttempts: 1, backoff: { kind: "constant", baseMs: 1, jitter: false } },
			}),
		);

		await expect(gateway.complete({ model: baseModel, messages: [] })).rejects.toBeInstanceOf(
			LlmFallbackExhaustedError,
		);
	});

	it("calls onFallback callback when switching models", async () => {
		const primaryError = new LlmProviderError("primary failed", { status: 500 });
		const fallbackResult: ChatCompletionResult = {
			providerId: "anthropic-prod",
			modelId: "claude-test",
			content: "fallback ok",
			usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
			raw: {},
		};

		const onFallback = vi.fn();
		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						return makeFailingClient(primaryError);
					}

					return makeClient(fallbackResult);
				},
				onFallback,
			}),
		);

		await gateway.complete({ model: baseModel, messages: [] });
		expect(onFallback).toHaveBeenCalledOnce();
		expect(onFallback).toHaveBeenCalledWith(
			expect.stringContaining("primary failed"),
			expect.objectContaining({ providerId: "openai-prod", modelId: "gpt-test" }),
			expect.objectContaining({ providerId: "anthropic-prod", modelId: "claude-test" }),
		);
	});

	it("respects per-provider overrides for retry limits", async () => {
		const rateLimitError = new LlmProviderError("rate limited", { status: 429 });
		const fallbackResult: ChatCompletionResult = {
			providerId: "anthropic-prod",
			modelId: "claude-test",
			content: "fallback ok",
			usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
			raw: {},
		};

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						return makeFailingClient(rateLimitError);
					}

					return makeClient(fallbackResult);
				},
				retry: { maxAttempts: 5, backoff: { kind: "constant", baseMs: 1, jitter: false } },
				perProviderOverrides: {
					"openai-prod": { maxAttempts: 1 },
				},
			}),
		);

		const result = await gateway.complete({ model: baseModel, messages: [] });
		expect(result.content).toBe("fallback ok");
		expect(result.retryCount).toBe(0);
	});

	it("returns budgetExceeded flag when perRunUsd is exceeded", async () => {
		const expensiveResult: ChatCompletionResult = {
			providerId: "openai-prod",
			modelId: "gpt-test",
			content: "expensive",
			usage: { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 },
			raw: {},
		};

		const onFallback = vi.fn();
		const clientFactory = vi.fn(() => makeClient(expensiveResult));
		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory,
				budget: { perRunUsd: 0.001 },
				onFallback,
			}),
		);

		const result = await gateway.complete({ model: baseModel, messages: [] });
		expect(result.budgetExceeded).toBe("per_run");
		expect(result.content).toBe("expensive");
		expect(clientFactory).toHaveBeenCalledOnce();
		expect(onFallback).not.toHaveBeenCalled();
	});

	it("tracks estimated cost in the result", async () => {
		const result: ChatCompletionResult = {
			providerId: "openai-prod",
			modelId: "gpt-test",
			content: "ok",
			usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
			raw: {},
		};

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: () => makeClient(result),
			}),
		);

		const output = await gateway.complete({ model: baseModel, messages: [] });
		// 1500 tokens at $0.002 per 1K = $0.003
		expect(output.estimatedCostUsd).toBeCloseTo(0.003, 4);
	});

	it("uses exponential backoff by default", async () => {
		const rateLimitError = new LlmProviderError("rate limited", { status: 429 });
		const successResult: ChatCompletionResult = {
			providerId: "openai-prod",
			modelId: "gpt-test",
			content: "ok",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			raw: {},
		};

		const sharedClient = makeToggleClient([rateLimitError, rateLimitError, successResult]);
		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: () => sharedClient,
				retry: {
					maxAttempts: 5,
					backoff: { kind: "exponential", baseMs: 10, maxMs: 100, jitter: false },
				},
			}),
		);

		const start = Date.now();
		const output = await gateway.complete({ model: baseModel, messages: [] });
		const elapsed = Date.now() - start;

		expect(output.content).toBe("ok");
		expect(output.retryCount).toBe(2);
		// First retry: baseMs * 2^0 = 10ms
		// Second retry: baseMs * 2^1 = 20ms
		// Total delay should be around 30ms
		expect(elapsed).toBeGreaterThanOrEqual(25);
	});

	it("respects giveUpAfterSeconds and falls back early", async () => {
		const rateLimitError = new LlmProviderError("rate limited", { status: 429 });
		const fallbackResult: ChatCompletionResult = {
			providerId: "anthropic-prod",
			modelId: "claude-test",
			content: "fallback ok",
			usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
			raw: {},
		};

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						// This will take longer than giveUpAfterSeconds
						return {
							async complete(): Promise<never> {
								await new Promise((resolve) => setTimeout(resolve, 200));
								throw rateLimitError;
							},
						};
					}

					return makeClient(fallbackResult);
				},
				retry: { maxAttempts: 10, giveUpAfterSeconds: 0.1, backoff: { kind: "constant", baseMs: 1, jitter: false } },
			}),
		);

		const result = await gateway.complete({ model: baseModel, messages: [] });
		expect(result.content).toBe("fallback ok");
		expect(result.fallbackCount).toBe(1);
	});

	it("passes through the input model to the client factory", async () => {
		const capturedInputs: ChatCompletionInput[] = [];
		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: () => ({
					async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
						capturedInputs.push(input);
						return {
							providerId: input.model.providerId,
							modelId: input.model.modelId,
							content: "ok",
							raw: {},
						};
					},
				}),
			}),
		);

		await gateway.complete({
			model: baseModel,
			messages: [{ role: "user", content: "hello" }],
			temperature: 0.5,
		});

		expect(capturedInputs).toHaveLength(1);
		expect(capturedInputs[0]?.model.providerId).toBe("openai-prod");
		expect(capturedInputs[0]?.messages).toEqual([{ role: "user", content: "hello" }]);
		expect(capturedInputs[0]?.temperature).toBe(0.5);
	});

	it("does not retry or fall back on 4xx errors other than 429", async () => {
		const clientError = new LlmProviderError("bad request", { status: 400 });
		const onFallback = vi.fn();

		const gateway = createResilientChatClient(
			makeOptions({
				clientFactory: (model) => {
					if (model.providerId === "openai-prod") {
						return makeFailingClient(clientError);
					}

					throw new Error("fallback should not be created");
				},
				retry: { maxAttempts: 5, backoff: { kind: "constant", baseMs: 1, jitter: false } },
				onFallback,
			}),
		);

		await expect(gateway.complete({ model: baseModel, messages: [] })).rejects.toBe(clientError);
		expect(onFallback).not.toHaveBeenCalled();
	});
});
