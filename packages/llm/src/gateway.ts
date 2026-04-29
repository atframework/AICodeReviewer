import {
	LlmProviderError,
	type ChatCompletionClient,
	type ChatCompletionInput,
	type ChatCompletionResult,
	type ChatCompletionUsage,
	type ModelProviderKind,
	type ModelSpec,
} from "./index.js";

export interface LlmGatewayFallbackEntry {
	readonly provider: string;
	readonly model: string;
	readonly role: "light" | "heavy" | "any";
}

export interface LlmGatewayRetryConfig {
	readonly maxAttempts?: number;
	readonly respectRetryAfter?: boolean;
	readonly backoff?: {
		readonly kind: "exponential" | "linear" | "constant";
		readonly baseMs?: number;
		readonly maxMs?: number;
		readonly jitter?: boolean;
	};
	readonly giveUpAfterSeconds?: number;
}

export interface LlmGatewayBudgetConfig {
	readonly perRunUsd?: number;
	readonly perRepoDailyUsd?: number;
}

export interface LlmGatewayPerProviderOverride {
	readonly maxAttempts?: number;
	readonly giveUpAfterSeconds?: number;
}

export interface LlmGatewayProviderConfig {
	readonly id: string;
	readonly kind: ModelProviderKind;
	readonly baseUrl?: string;
	readonly apiKeyEnv?: string;
}

export interface LlmGatewayOptions {
	readonly clientFactory: (model: ModelSpec) => ChatCompletionClient;
	readonly providers: readonly LlmGatewayProviderConfig[];
	readonly fallbackChain: readonly LlmGatewayFallbackEntry[];
	readonly retry?: LlmGatewayRetryConfig;
	readonly budget?: LlmGatewayBudgetConfig;
	readonly perProviderOverrides?: Readonly<Record<string, LlmGatewayPerProviderOverride>>;
	readonly onFallback?: (reason: string, from: ModelSpec, to: ModelSpec) => void;
}

export interface LlmGatewayCallResult extends ChatCompletionResult {
	readonly fallbackCount: number;
	readonly retryCount: number;
	readonly estimatedCostUsd: number;
}

export interface LlmGatewayChatClient extends ChatCompletionClient {
	complete(input: ChatCompletionInput): Promise<LlmGatewayCallResult>;
}

export class LlmBudgetExceededError extends Error {
	readonly reason: string;
	readonly limitUsd: number;
	readonly estimatedCostUsd: number;

	constructor(reason: string, limitUsd: number, estimatedCostUsd: number) {
		super(`LLM budget exceeded: ${reason} (limit $${limitUsd.toFixed(4)}, estimated $${estimatedCostUsd.toFixed(4)})`);
		this.name = "LlmBudgetExceededError";
		this.reason = reason;
		this.limitUsd = limitUsd;
		this.estimatedCostUsd = estimatedCostUsd;
	}
}

export class LlmFallbackExhaustedError extends Error {
	readonly lastError: unknown;
	readonly attemptedModels: readonly ModelSpec[];

	constructor(lastError: unknown, attemptedModels: readonly ModelSpec[]) {
		super(`LLM fallback chain exhausted after ${attemptedModels.length} attempt(s).`);
		this.name = "LlmFallbackExhaustedError";
		this.lastError = lastError;
		this.attemptedModels = attemptedModels;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function parseRetryAfter(value: string): number | undefined {
	const trimmed = value.trim();
	if (/^\d+$/u.test(trimmed)) {
		const seconds = Number.parseInt(trimmed, 10);
		return seconds * 1000;
	}

	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}

	return undefined;
}

function computeBackoffDelay(
	attempt: number,
	retryConfig: LlmGatewayRetryConfig,
	retryAfter?: string,
): number {
	const baseMs = retryConfig.backoff?.baseMs ?? 1000;
	const maxMs = retryConfig.backoff?.maxMs ?? 60000;
	const jitter = retryConfig.backoff?.jitter ?? true;
	const kind = retryConfig.backoff?.kind ?? "exponential";

	let delay: number;
	if (retryConfig.respectRetryAfter && retryAfter) {
		const parsedRetryAfter = parseRetryAfter(retryAfter);
		if (parsedRetryAfter !== undefined) {
			const computedDelay =
				kind === "exponential"
					? baseMs * 2 ** attempt
					: kind === "linear"
						? baseMs * (attempt + 1)
						: baseMs;
			delay = Math.min(parsedRetryAfter, computedDelay);
		} else {
			delay =
				kind === "exponential"
					? baseMs * 2 ** attempt
					: kind === "linear"
						? baseMs * (attempt + 1)
						: baseMs;
		}
	} else {
		delay =
			kind === "exponential"
				? baseMs * 2 ** attempt
				: kind === "linear"
					? baseMs * (attempt + 1)
					: baseMs;
	}

	if (jitter) {
		delay = delay * (0.5 + Math.random() * 0.5);
	}

	return Math.min(delay, maxMs);
}

function isContextOverflowError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const message = `${error.message}\n${error instanceof LlmProviderError ? error.responseBody ?? "" : ""}`;
	return /context(?:_|\s|-)?(?:length|window|overflow)|maximum context|too many tokens/iu.test(message);
}

function isFallbackEligibleError(error: unknown): boolean {
	if (error instanceof LlmProviderError) {
		if (error.status === 429) return true;
		if (error.status && error.status >= 500) return true;
	}

	if (isContextOverflowError(error)) return true;
	if (error instanceof Error && error.name === "AbortError") return true;
	if (error instanceof Error && error.name === "TimeoutError") return true;

	return false;
}

function getProviderOverride(
	providerId: string,
	overrides: Readonly<Record<string, LlmGatewayPerProviderOverride>> | undefined,
): LlmGatewayPerProviderOverride | undefined {
	return overrides?.[providerId];
}

function resolveRetryConfig(
	providerId: string,
	baseRetry: LlmGatewayRetryConfig | undefined,
	overrides: Readonly<Record<string, LlmGatewayPerProviderOverride>> | undefined,
): LlmGatewayRetryConfig {
	const providerOverride = getProviderOverride(providerId, overrides);
	if (!providerOverride) {
		return baseRetry ?? {};
	}

	return {
		...baseRetry,
		...(providerOverride.maxAttempts !== undefined ? { maxAttempts: providerOverride.maxAttempts } : {}),
		...(providerOverride.giveUpAfterSeconds !== undefined
			? { giveUpAfterSeconds: providerOverride.giveUpAfterSeconds }
			: {}),
	};
}

function findCurrentFallbackIndex(
	model: ModelSpec,
	fallbackChain: readonly LlmGatewayFallbackEntry[],
): number {
	for (let i = 0; i < fallbackChain.length; i++) {
		const entry = fallbackChain[i];
		if (entry && entry.provider === model.providerId && entry.model === model.modelId) {
			return i;
		}
	}

	return -1;
}

function findNextFallbackEntry(
	currentModel: ModelSpec,
	fallbackChain: readonly LlmGatewayFallbackEntry[],
	usedIndices: Set<number>,
): { entry: LlmGatewayFallbackEntry; index: number } | undefined {
	const currentIndex = findCurrentFallbackIndex(currentModel, fallbackChain);
	for (let i = currentIndex + 1; i < fallbackChain.length; i++) {
		if (!usedIndices.has(i)) {
			const entry = fallbackChain[i];
			if (entry) {
				return { entry, index: i };
			}
		}
	}

	return undefined;
}

function buildModelSpecFromFallback(
	entry: LlmGatewayFallbackEntry,
	providers: readonly LlmGatewayProviderConfig[],
): ModelSpec {
	const provider = providers.find((p) => p.id === entry.provider);
	if (!provider) {
		throw new LlmProviderError(`Fallback provider "${entry.provider}" not found in configured providers.`);
	}

	return {
		providerKind: provider.kind,
		providerId: provider.id,
		modelId: entry.model,
		...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
		...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
	};
}

function estimateCost(usage: ChatCompletionUsage | undefined): number {
	if (!usage) return 0;
	const tokens = usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
	return (tokens / 1000) * 0.002;
}

export function createResilientChatClient(options: LlmGatewayOptions): LlmGatewayChatClient {
	const {
		clientFactory,
		providers,
		fallbackChain,
		retry: baseRetry,
		budget,
		perProviderOverrides,
		onFallback,
	} = options;

	return {
		async complete(input: ChatCompletionInput): Promise<LlmGatewayCallResult> {
			let currentModel = input.model;
			const attemptedModels: ModelSpec[] = [currentModel];
			const usedFallbackIndices = new Set<number>();
			let fallbackCount = 0;
			let totalRetryCount = 0;
			let accumulatedCost = 0;
			let lastError: unknown;

			while (true) {
				const retryConfig = resolveRetryConfig(currentModel.providerId, baseRetry, perProviderOverrides);
				const maxAttempts = Math.max(1, retryConfig.maxAttempts ?? 1);
				const giveUpAfterSeconds = Math.max(0, retryConfig.giveUpAfterSeconds ?? 300);
				const startTime = Date.now();
				let attempt = 0;

				while (attempt < maxAttempts) {
					try {
						const client = clientFactory(currentModel);
						const result = await client.complete({ ...input, model: currentModel });
						const callCost = estimateCost(result.usage);
						accumulatedCost += callCost;

						if (budget?.perRunUsd && accumulatedCost > budget.perRunUsd) {
							throw new LlmBudgetExceededError("per_run_usd exceeded", budget.perRunUsd, accumulatedCost);
						}

						return {
							...result,
							fallbackCount,
							retryCount: totalRetryCount,
							estimatedCostUsd: accumulatedCost,
						};
					} catch (error) {
						lastError = error;
						const elapsedSeconds = (Date.now() - startTime) / 1000;

						if (error instanceof LlmBudgetExceededError) {
							throw error;
						}

						if (!isFallbackEligibleError(error)) {
							throw error;
						}

						const hasRetryAttemptRemaining = attempt + 1 < maxAttempts;
						if (!hasRetryAttemptRemaining || elapsedSeconds >= giveUpAfterSeconds) {
							break;
						}

						const retryAfter =
							error instanceof LlmProviderError ? error.retryAfter : undefined;
						const delay = computeBackoffDelay(attempt, retryConfig, retryAfter);
						if (elapsedSeconds + delay / 1000 >= giveUpAfterSeconds) {
							break;
						}

						await sleep(delay);
						attempt++;
						totalRetryCount++;
					}
				}

				const nextFallback = findNextFallbackEntry(currentModel, fallbackChain, usedFallbackIndices);
				if (!nextFallback) {
					if (lastError instanceof LlmBudgetExceededError) {
						throw lastError;
					}

					throw new LlmFallbackExhaustedError(lastError, attemptedModels);
				}

				const nextModel = buildModelSpecFromFallback(nextFallback.entry, providers);
				usedFallbackIndices.add(nextFallback.index);
				if (onFallback) {
					onFallback(
						lastError instanceof Error ? lastError.message : String(lastError),
						currentModel,
						nextModel,
					);
				}

				currentModel = nextModel;
				attemptedModels.push(currentModel);
				fallbackCount++;
			}
		},
	};
}
