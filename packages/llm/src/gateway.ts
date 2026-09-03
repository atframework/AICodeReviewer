import { isTransientIoError } from "@aicr/core";

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

export interface ModelPricing {
  readonly costInputPerMTok?: number;
  readonly costOutputPerMTok?: number;
  readonly costCacheReadPerMTok?: number;
  readonly costCacheWritePerMTok?: number;
}

export function extractModelPricing(model: ModelSpec): ModelPricing {
	const pricing: {
		costInputPerMTok?: number;
		costOutputPerMTok?: number;
		costCacheReadPerMTok?: number;
		costCacheWritePerMTok?: number;
	} = {};
	if (model.costInputPerMTok !== undefined) pricing.costInputPerMTok = model.costInputPerMTok;
	if (model.costOutputPerMTok !== undefined) pricing.costOutputPerMTok = model.costOutputPerMTok;
	if (model.costCacheReadPerMTok !== undefined) pricing.costCacheReadPerMTok = model.costCacheReadPerMTok;
	if (model.costCacheWritePerMTok !== undefined) pricing.costCacheWritePerMTok = model.costCacheWritePerMTok;
	return pricing;
}

export interface LlmGatewayProviderConfig {
  readonly id: string;
  readonly kind: ModelProviderKind;
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
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "max";
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
  readonly costInputPerMTok?: number;
  readonly costOutputPerMTok?: number;
  readonly costCacheReadPerMTok?: number;
  readonly costCacheWritePerMTok?: number;
}

export class DailyBudgetTracker {
  private readonly dailySpend = new Map<string, number>();

  private dayKey(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  }

  recordSpend(workspaceId: string, costUsd: number): number {
    const key = `${this.dayKey()}:${workspaceId}`;
    const current = this.dailySpend.get(key) ?? 0;
    const updated = current + costUsd;
    this.dailySpend.set(key, updated);
    return updated;
  }

  getDailySpend(workspaceId: string): number {
    const key = `${this.dayKey()}:${workspaceId}`;
    return this.dailySpend.get(key) ?? 0;
  }
}

export interface LlmGatewayOptions {
  readonly clientFactory: (model: ModelSpec) => ChatCompletionClient;
  readonly providers: readonly LlmGatewayProviderConfig[];
  readonly fallbackChain: readonly LlmGatewayFallbackEntry[];
  readonly retry?: LlmGatewayRetryConfig;
  readonly budget?: LlmGatewayBudgetConfig;
  readonly perProviderOverrides?: Readonly<Record<string, LlmGatewayPerProviderOverride>>;
  readonly onFallback?: (reason: string, from: ModelSpec, to: ModelSpec) => void;
  readonly workspaceId?: string;
  readonly dailyBudgetTracker?: DailyBudgetTracker;
  readonly modelPricing?: Readonly<Record<string, ModelPricing>>;
}

export interface LlmGatewayCallResult extends ChatCompletionResult {
  readonly fallbackCount: number;
  readonly retryCount: number;
  readonly estimatedCostUsd: number;
  readonly budgetExceeded?: "per_run" | "per_repo_daily";
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
    const lastErrorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    super(`LLM fallback chain exhausted after ${attemptedModels.length} attempt(s). Last error: ${lastErrorMessage}`);
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

export function isContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = `${error.message}\n${error instanceof LlmProviderError ? error.responseBody ?? "" : ""}`;
  return /context(?:_|\s|-)?(?:length|window|overflow)|maximum context|too many tokens/iu.test(message);
}

function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; current !== undefined && current !== null && depth < 6; depth++) {
    if (visited.has(current)) break;
    visited.add(current);

    if (typeof current === "string") {
      parts.push(current);
      break;
    }

    if (current instanceof Error) {
      parts.push(current.name, current.message);
      if (current instanceof LlmProviderError && current.responseBody) {
        parts.push(current.responseBody);
      }
      current = (current as Error & { readonly cause?: unknown }).cause;
      continue;
    }

    if (typeof current === "object") {
      try {
        parts.push(JSON.stringify(current));
      } catch {
        parts.push(String(current));
      }
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }

    parts.push(String(current));
    break;
  }

  return parts.join("\n");
}

/**
 * Identifies account/billing/plan quota exhaustion that retrying the same model cannot fix.
 *
 * HTTP 429 and `RESOURCE_EXHAUSTED` are deliberately insufficient: several providers use
 * them for short-lived request-rate or shared-capacity pressure. Callers may move to the next
 * configured model immediately only when a provider code or message explicitly identifies a
 * depleted balance, spend cap, or time-window allowance.
 */
export function isLlmQuotaExhaustedError(error: unknown): boolean {
  const text = collectErrorText(error);
  if (!text) return false;

  const durableQuotaCodePatterns = [
    /\b(?:credit_balance_exhausted|insufficient_quota|billing_hard_limit_reached)\b/iu,
    /\b(?:organization_spend_limit_exceeded|project_spend_limit_exceeded|organization_usage_limit_exceeded)\b/iu,
    /\b(?:enforced_spend_limit_reached|quota_exceeded|quota_exhausted|insufficient_balance)\b/iu,
    /\b(?:servicequotaexceededexception|throttling\.allocationquota|(?:free_)?resource_pack_exhausted)\b/iu,
  ];
  if (durableQuotaCodePatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  // Zhipu distinguishes durable account/plan limits from rate (1302), load (1305),
  // model permission (1311), and fair-use throttling (1313).
  if (/(?:\b(?:type|code|error_code)\b\s*[=:]\s*["']?)(?:1113|1308|1309|1310|1314|1316|1317|1318|1319|1320|1321)\b/iu.test(text)) {
    return true;
  }

  return [
    /\b(?:insufficient|depleted|exhausted)\s+(?:account\s+)?(?:balance|credits?)\b/iu,
    /\b(?:credit|account)\s+balance\s+(?:is\s+)?(?:depleted|exhausted|insufficient)\b/iu,
    /\b(?:daily|weekly|monthly|annual|5[- ]hour|7[- ]day|spend|credit)\b.{0,48}\blimit\b.{0,32}\b(?:reached|exceeded|exhausted)\b/iu,
    /\b(?:reached|exceeded|exhausted)\b.{0,32}\b(?:daily|weekly|monthly|annual|spend|credit)\b.{0,48}\blimit\b/iu,
    /\breached\b.{0,32}\b(?:specified\s+)?api\s+usage\s+limits?\b/iu,
    /\b(?:api\s+)?usage\s+limit\b.{0,48}\b(?:month|week|day|billing\s+cycle|reset)\b/iu,
    /\b(?:hour|week|month)\s+allocated\s+quota\s+exceeded\b/iu,
    /\b(?:premium\s+request|usage)\s+(?:allowance|credits?)\s+(?:is\s+)?(?:depleted|exhausted|used\s+up)\b/iu,
    /\b(?:used|consumed)\s+(?:all|every)\b.{0,24}\b(?:credits?|premium\s+requests?)\b/iu,
    /(?:余额不足|账户已欠费|账号已欠费|额度.{0,16}(?:耗尽|用尽|已用完|不足)|已达到.{0,24}(?:使用|消费)上限|限额将在.{0,80}重置|套餐已?(?:到期|失效))/u,
  ].some((pattern) => pattern.test(text));
}

function isFallbackEligibleError(error: unknown): boolean {
  if (isLlmQuotaExhaustedError(error)) return true;
  if (error instanceof LlmProviderError) {
    if (error.status === 429) return true;
    if (error.status && error.status >= 500) return true;
  }

  if (isContextOverflowError(error)) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  if (isTransientIoError(error)) return true;

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
  modelPricing?: Readonly<Record<string, ModelPricing>>,
): ModelSpec {
  const provider = providers.find((p) => p.id === entry.provider);
  if (!provider) {
    throw new LlmProviderError(`Fallback provider "${entry.provider}" not found in configured providers.`);
  }

  const { id: _id, kind: _kind, ...providerFields } = provider;
  const pricing = modelPricing?.[`${entry.provider}/${entry.model}`];

  return {
    providerKind: provider.kind,
    providerId: provider.id,
    modelId: entry.model,
    ...(pricing ?? {}),
    ...providerFields,
  };
}

function finiteTokenCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * Estimates the USD cost of one completion from token-category usage and model
 * pricing. With no catalog pricing at all it falls back to the documented
 * `(tokens/1000) * 0.002` placeholder so cost surfaces never read as exactly
 * free just because pricing metadata is missing.
 */
export function estimateCost(usage: ChatCompletionUsage | undefined, pricing?: ModelPricing): number {
  if (!usage) return 0;
  const inputTokens = finiteTokenCount(usage.promptTokens);
  const outputTokens = finiteTokenCount(usage.completionTokens);
  const cachedTokens = finiteTokenCount(usage.cachedPromptTokens);
  const cacheCreationTokens = finiteTokenCount(usage.cacheCreationTokens);
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);

  const inputRate = pricing?.costInputPerMTok;
  const outputRate = pricing?.costOutputPerMTok;
  const cacheReadRate = pricing?.costCacheReadPerMTok ?? inputRate;
  const cacheWriteRate = pricing?.costCacheWritePerMTok ?? inputRate;

  if (
    inputRate !== undefined ||
    outputRate !== undefined ||
    cacheReadRate !== undefined ||
    cacheWriteRate !== undefined
  ) {
    const inputCost = inputRate !== undefined ? (nonCachedInput / 1_000_000) * inputRate : 0;
    const cacheReadCost = cacheReadRate !== undefined ? (cachedTokens / 1_000_000) * cacheReadRate : 0;
    const cacheWriteCost = cacheWriteRate !== undefined ? (cacheCreationTokens / 1_000_000) * cacheWriteRate : 0;
    const outputCost = outputRate !== undefined ? (outputTokens / 1_000_000) * outputRate : 0;
    return Math.max(0, inputCost + cacheReadCost + cacheWriteCost + outputCost);
  }

  const totalRaw = usage.totalTokens;
  const tokens =
    totalRaw !== undefined && Number.isFinite(totalRaw) && totalRaw >= 0
      ? totalRaw
      : inputTokens + outputTokens;
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
    workspaceId,
    dailyBudgetTracker,
    modelPricing,
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

      if (budget?.perRepoDailyUsd && workspaceId && dailyBudgetTracker) {
        const dailySpend = dailyBudgetTracker.getDailySpend(workspaceId);
        if (dailySpend >= budget.perRepoDailyUsd) {
          throw new LlmBudgetExceededError(
            "per_repo_daily_usd exceeded",
            budget.perRepoDailyUsd,
            dailySpend,
          );
        }
      }

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
            const callCost = estimateCost(result.usage, extractModelPricing(currentModel));
            accumulatedCost += callCost;

            if (workspaceId && dailyBudgetTracker && callCost > 0) {
              dailyBudgetTracker.recordSpend(workspaceId, callCost);
            }

            if (budget?.perRunUsd && accumulatedCost > budget.perRunUsd) {
              return {
                ...result,
                fallbackCount,
                retryCount: totalRetryCount,
                estimatedCostUsd: accumulatedCost,
                budgetExceeded: "per_run" as const,
              };
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
            if (isLlmQuotaExhaustedError(error)) {
              break;
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

        const nextModel = buildModelSpecFromFallback(nextFallback.entry, providers, modelPricing);
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
