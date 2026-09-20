import { resolve } from "node:path";

import {
  fixAndValidateMarkdown,
  hashStructured,
  isPlainObject,
  createMultiProviderRateLimiter,
  createQueueFromConfig,
  loadSystemPromptTemplate,
  markdownDocumentBody,
  resolveWorkspaceConfig,
  reviewMemoryScope,
  createConfigStoreFromDatabaseConfig,
  resolveConfigSecretSealing,
  type AppConfig,
  type ConfigStore,
  type ReviewEvent,
} from "@aicr/core";
import { createQueueWorker, type QueueJobHandler, type QueueWorker } from "@aicr/core";
import { createAgentAdapter, type AgentAdapter } from "@aicr/agents";
import {
  createChatClientFromModelSpec,
  createResilientChatClient,
  DailyBudgetTracker,
  LlmBudgetExceededError,
  extractModelPricing,
  getModelCatalogBundledSnapshotPath,
  type ChatCompletionClient,
  type CompressionConfig,
  type LlmGatewayProviderConfig,
  type LlmGatewayRetryConfig,
  type LlmGatewayBudgetConfig,
  type LlmGatewayFallbackEntry,
  type LlmGatewayPerProviderOverride,
  type ModelPricing,
  type ModelSpec,
  type ModelProviderKind,
} from "@aicr/llm";
import {
  buildAtMentions,
  buildTemplateTargetContext,
  createTemplateResolver,
  createGiteaPullRequestReviewDispatcher,
  createGithubPullRequestReviewDispatcher,
  createGitlabMergeRequestReviewDispatcher,
  createGiteaIssueDispatcher,
  createGiteaProblemIssueDispatcher,
  createGithubIssueDispatcher,
  createGithubProblemIssueDispatcher,
  createFeishuBotDispatcher,
  createWeComBotDispatcher,
  type ProblemResolutionAnalyzer,
  type ReviewProblem,
  type DispatchResult,
  toTemplateProblem,
  resolveAuthorAssignment,
  type AuthorResolutionOptions,
  type MentionChannelKind,
  type TemplateContext,
} from "@aicr/outputs";
import {
  createSandboxBackend,
  resolveSandboxKind,
  type SandboxBackend,
  type SandboxKind,
  type SandboxEngine,
} from "@aicr/sandbox";
import {
  createGitVcsAdapter,
  createP4VcsAdapter,
  createSvnVcsAdapter,
  type GitVcsAdapter,
  type P4VcsAdapter,
  type SvnVcsAdapter,
  type VcsAdapter,
} from "@aicr/vcs";
import {
  closeStoreDb,
  createStoreDb,
  hardDeleteExpiredProjects,
  markWebhookEventsTimedOut,
  readReflectionMemory,
  writeReflectionMemory,
  compactReflectionMemory,
  softDeleteMissingProjects,
  type StoreDb,
} from "@aicr/store";
import {
  buildMemoryHintsForPrompt,
  extractCrossRunPatterns,
  extractReflections,
  extractRepositoryConventions,
  type ExtractedReflection,
} from "@aicr/core";

import type { VcsWebhookConfig } from "./webhook-common.js";
import { RoutingReceiptResolver } from "./routing-resolver.js";
import { createWorkspaceRuntime, type WorkspaceRuntime } from "./workspace-runtime.js";
import type { P4TriggerConfig } from "./p4-webhook.js";
import type { SvnTriggerConfig } from "./svn-webhook.js";
import { GiteaApiClient } from "./issue-triage.js";
import type { IssueTriageRuntimeOptions, WorkspaceIssueTriagePolicy } from "./issue-triage.js";
import { createProblemResolutionAnalyzer } from "./problem-resolution.js";
import type { ServerAppOptions, ServerReviewOrchestrationOptions } from "./index.js";
import { persistReviewRunToStore, resolveTriggerRetryConfig } from "./index.js";
import { type AutoCommitStore, type StreamKeyInput, resolveAutoCommitPolicy } from "@aicr/core";
import { createAutoCommitStoreFromConfig } from "@aicr/core";
import { resolvePullRequestSchedule, resolvePullRequestTargetBranches } from "@aicr/core";
import { AutoCommitRuntime, createAutoCommitBatchExecutor } from "./auto-commit-runtime.js";
import {
  AutoCommitScheduler,
} from "./auto-commit-scheduler.js";
import { type AuthConfig } from "./auth.js";
import { createReviewDeduplicator } from "./review-deduplicator.js";
import { ReviewDeferralManager } from "./deferral-manager.js";
import { createRuntimeQueue } from "./runtime-queue.js";
import { cleanupExpiredSessions, resolveAdminAuthConfig } from "./admin-auth.js";
import {
  createGithubAppTokenService,
  resolveGithubAppTriggerAuth,
  resolveGithubApiBaseUrl,
} from "./github-app-token.js";
import type { GithubAppTokenService } from "./github-app-token.js";
import {
  createHttpModelCatalogFetcher,
  createMemoryModelCatalogBackend,
  createModelCatalogService,
  createStoreModelCatalogBackend,
  createRedisModelCatalogBackend,
  MODEL_CATALOG_FIELD_KEY_MAP,
  MODEL_CATALOG_HINT_KEY_MAP,
  type ModelCatalogBackend,
  type ModelCatalogService,
  type ModelCatalogOverrideFields,
  type ModelCatalogProviderHint,
  type RedisModelCatalogBackendOptions,
} from "./model-catalog-service.js";
import type { ObservabilityApiOptions } from "./observability-api.js";
import { createLiveRunRegistry, type LiveRunRegistry } from "./live-runs.js";
import type {
  ReviewDispatchResult,
  ReviewOrchestrationContext,
  ReviewOrchestrationResult,
  ReviewOutputPublisher,
  ReviewOutputPublisherResolver,
  ReviewSummaryPublishOptions,
} from "./review-orchestrator.js";
import {
  RuntimeConfigManager,
  type RuntimeConfigGeneration,
  admissionUnavailableReason,
} from "./runtime-config.js";
import {
  createRedisConfigStore,
  resolveAnalysisSelection,
  compileExecutionGraph,
  resolveRouteForEvent,
  resolveOutputChannelsForEvent,
  ConfigError,
  type EffectiveConfigV2,
  type CompiledRoutingRule,
  type AppConfigInput,
} from "@aicr/core";

export interface BootstrapServerOptions {
  readonly config: AppConfig;
  readonly baseSystemPrompt: string;
  readonly baseDir?: string;
  readonly workspaceId?: string;
  readonly jobHandler?: QueueJobHandler;
  /**
   * Raw file document + digest for dynamic-config mode (P4). Required when
   * `config_sources.database.enabled`: source merging and file-digest checks
   * operate on the legacy-converted pre-defaults document. CLI loaders pass
   * this from `loadConfigDocumentFile`.
   */
  readonly configDocument?: { readonly document: AppConfigInput; readonly digest: string } | undefined;
}

interface ActiveProjectIdentity {
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly repoRef: string;
}

function resolveEnv(name: string | undefined): string | undefined {
  return name ? process.env[name] : undefined;
}

/**
 * Envelope encryption service for literal credentials (AICR_CONFIG_SECRETS_KEY).
 * Created once per process; undefined when no key is configured — every
 * consumer fails closed only when a literal actually crosses its boundary.
 */
const configSecretSealing = resolveConfigSecretSealing((name) => process.env[name]);

/**
 * Resolves a secret config field: the literal value wins, then the `*_env`
 * reference. Database-sourced literals arrive already unsealed (the runtime
 * config manager opens them when the generation is built).
 */
function resolveSecretField(record: Record<string, unknown>, literalField: string, envField: string): string | undefined {
  const literal = record[literalField];
  if (typeof literal === "string" && literal.length > 0) return literal;
  const envName = record[envField];
  return typeof envName === "string" && envName.length > 0 ? resolveEnv(envName) : undefined;
}

function toRedisModelCatalogBackendOptions(config: AppConfig): RedisModelCatalogBackendOptions {
  if (config.storage.cache.kind !== "redis") {
    throw new TypeError("llm.model_catalog.cache.backend 'redis' requires storage.cache.kind 'redis'.");
  }

  const redisConfig = (config.storage.cache.redis ?? {}) as Record<string, unknown>;
  const urlEnv = typeof redisConfig.url_env === "string" ? redisConfig.url_env : undefined;
  const url = resolveEnv(urlEnv) ?? (typeof redisConfig.url === "string" ? redisConfig.url : undefined);
  if (!url) {
    throw new TypeError(
      "llm.model_catalog.cache.backend 'redis' requires storage.cache.redis.url_env to resolve to a Redis URL.",
    );
  }

  return {
    url,
    keyPrefix: typeof redisConfig.key_prefix === "string" ? redisConfig.key_prefix : "aicr:",
  };
}

function extractPullNumber(payload: unknown, event: ReviewEvent): number | undefined {
  if (!isPlainObject(payload)) {
    return undefined;
  }

  if (event.provider === "gitlab") {
    if (event.targetKind !== "pull_request") return undefined;
    // MR hooks put the project-local IID in object_attributes; Note Hooks
    // carry the referenced MR at the payload root. Global id/note iid are
    // never valid substitutes for the merge request's project-local number.
    const mergeRequest = isPlainObject(payload.merge_request) ? payload.merge_request :
      payload.object_kind === "merge_request" ? payload.object_attributes : undefined;
    const iid = isPlainObject(mergeRequest) ? mergeRequest.iid : undefined;
    return typeof iid === "number" && Number.isSafeInteger(iid) && iid > 0 ? iid : undefined;
  }

  const pullRequest = payload.pull_request;
  if (isPlainObject(pullRequest) && typeof pullRequest.number === "number") {
    return pullRequest.number;
  }

  return typeof payload.number === "number" ? payload.number : undefined;
}

type LlmModelChain = AppConfig["llm"]["model_chain"][string];

function resolveModelChainNames(config: AppConfig, workspaceId?: string) {
  const workspace = workspaceId ? config.workspaces.instances[workspaceId] : undefined;
  const modelChain = workspace?.model_chain ?? config.workspaces.defaults.model_chain
    ?? config.llm.default_model_chain ?? "default";
  const triageModelChain = workspace?.triage_model_chain ?? config.workspaces.defaults.triage_model_chain
    ?? config.llm.triage_model_chain ?? modelChain;
  return { modelChain, triageModelChain };
}

function resolveModelChain(config: AppConfig, name: string): LlmModelChain {
  if (Object.hasOwn(config.llm.model_chain, name)) {
    return config.llm.model_chain[name]!;
  }
  if (name === "default" && Object.keys(config.llm.model_chain).length === 0) return [];
  throw new TypeError(`Model chain group "${name}" is not defined in llm.model_chain.`);
}

function resolveModelSpecFromChain(
  providers: AppConfig["llm"]["providers"],
  chain: LlmModelChain,
  providerId?: string,
): ModelSpec {
  if (providers.length === 0) {
    throw new TypeError("No LLM providers configured.");
  }

  const fallbackEntry = providerId
    ? chain.find((entry) => entry.provider === providerId)
    : chain[0];
  const provider = fallbackEntry
    ? providers.find((p) => p.id === fallbackEntry.provider)
    : providerId
      ? providers.find((p) => p.id === providerId)
      : providers[0];

  if (!provider) {
    const missingProviderId = fallbackEntry?.provider ?? providerId;
    throw new TypeError(`LLM provider "${missingProviderId}" not found in configuration.`);
  }

  const modelId = fallbackEntry?.model ?? "gpt-4o-mini";

  const spec: ModelSpec = {
    providerKind: provider.kind as ModelProviderKind,
    providerId: provider.id,
    modelId,
    ...resolveModelProviderFields(provider),
  };

  // Entry-level request overrides (architecture §3.15, wired in P4): maps merge by
  // key over provider fields, arrays and scalars replace. Disabling a
  // parameter goes through drop_params — JSON null is never a deletion.
  const overrides = fallbackEntry?.overrides;
  const draft = { ...spec } as {
    extraParams?: Record<string, unknown>;
    extraBody?: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
    reasoningEffort?: ModelSpec["reasoningEffort"];
    thinkingLevel?: ModelSpec["thinkingLevel"];
    thinkingBudgetTokens?: number;
    thinking?: ModelSpec["thinking"];
    responseFormat?: ModelSpec["responseFormat"];
    toolChoice?: ModelSpec["toolChoice"];
    parallelToolCalls?: boolean;
    seed?: number;
    logitBias?: Record<string, number>;
    dropParams?: readonly string[];
    allowedOpenaiParams?: readonly string[];
  };
  if (overrides) {
    mergeRecord(draft, "extraParams", overrides.extra_params);
    mergeRecord(draft, "extraBody", overrides.extra_body);
    mergeRecord(draft, "extraHeaders", overrides.extra_headers);
    if (overrides.reasoning_effort !== undefined) draft.reasoningEffort = overrides.reasoning_effort;
    if (overrides.thinking_level !== undefined) draft.thinkingLevel = overrides.thinking_level;
    if (overrides.thinking_budget_tokens !== undefined) draft.thinkingBudgetTokens = overrides.thinking_budget_tokens;
    if (overrides.thinking !== undefined) draft.thinking = overrides.thinking;
    if (overrides.response_format !== undefined) draft.responseFormat = overrides.response_format;
    if (overrides.tool_choice !== undefined) {
      const choice = overrides.tool_choice;
      if (typeof choice === "string") {
        draft.toolChoice = choice;
      } else {
        // Accept the OpenAI {"function":{"name"}} shape and the flat
        // {"name"} shape; anything else cannot name a tool and is dropped.
        const fn = (choice as { function?: { name?: unknown } }).function;
        const name = typeof fn?.name === "string" ? fn.name
          : typeof (choice as { name?: unknown }).name === "string" ? (choice as { name: string }).name
          : undefined;
        if (name !== undefined) draft.toolChoice = { name };
      }
    }
    if (overrides.parallel_tool_calls !== undefined) draft.parallelToolCalls = overrides.parallel_tool_calls;
    if (overrides.seed !== undefined) draft.seed = overrides.seed;
    if (overrides.logit_bias !== undefined) draft.logitBias = { ...draft.logitBias, ...overrides.logit_bias };
    if (overrides.drop_params !== undefined) draft.dropParams = overrides.drop_params;
    if (overrides.allowed_openai_params !== undefined) draft.allowedOpenaiParams = overrides.allowed_openai_params;
  }
  // exactOptionalPropertyTypes: never materialize explicit-undefined keys.
  const merged: Record<string, unknown> = { ...spec, ...draft };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as unknown as ModelSpec;
}

/** Key-wise merge of an overrides map into an optional draft record field. */
function mergeRecord<K extends "extraParams" | "extraBody" | "extraHeaders">(
  draft: Record<string, unknown>,
  key: K,
  overrides: Record<string, unknown> | undefined,
): void {
  if (overrides === undefined) return;
  const base = draft[key] as Readonly<Record<string, unknown>> | undefined;
  draft[key] = { ...(base ?? {}), ...overrides };
}

export function resolveModelSpecFromConfig(config: AppConfig, providerId?: string, workspaceId?: string): ModelSpec {
  const { modelChain } = resolveModelChainNames(config, workspaceId);
  return resolveModelSpecFromChain(config.llm.providers, resolveModelChain(config, modelChain), providerId);
}

export function resolveIssueTriageModelSpecFromConfig(config: AppConfig, workspaceId?: string): ModelSpec {
  const { triageModelChain } = resolveModelChainNames(config, workspaceId);
  return resolveModelSpecFromChain(config.llm.providers, resolveModelChain(config, triageModelChain));
}

function readString(raw: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function readNumber(raw: Record<string, unknown>, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function readBoolean(raw: Record<string, unknown>, ...keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  return undefined;
}

function readStringArray(raw: Record<string, unknown>, ...keys: readonly string[]): readonly string[] | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value;
    }
  }

  return undefined;
}

function readRecord(raw: Record<string, unknown>, ...keys: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (isPlainObject(value)) {
      return value;
    }
  }

  return undefined;
}

function readStringRecord(raw: Record<string, unknown>, ...keys: readonly string[]): Readonly<Record<string, string>> | undefined {
  const value = readRecord(raw, ...keys);
  if (!value || Object.values(value).some((entry) => typeof entry !== "string")) {
    return undefined;
  }

  return value as Readonly<Record<string, string>>;
}

function readNumberRecord(raw: Record<string, unknown>, ...keys: readonly string[]): Readonly<Record<string, number>> | undefined {
  const value = readRecord(raw, ...keys);
  if (!value || Object.values(value).some((entry) => typeof entry !== "number")) {
    return undefined;
  }

  return value as Readonly<Record<string, number>>;
}

function readThinking(raw: Record<string, unknown>): ModelSpec["thinking"] | undefined {
  const value = readRecord(raw, "thinking");
  if (!value || typeof value.enabled !== "boolean") {
    return undefined;
  }

  return {
    enabled: value.enabled,
    ...(typeof value.budgetTokens === "number" ? { budgetTokens: value.budgetTokens } : {}),
    ...(typeof value.budget_tokens === "number" ? { budgetTokens: value.budget_tokens } : {}),
  };
}

function readResponseFormat(raw: Record<string, unknown>): ModelSpec["responseFormat"] | undefined {
  const value = readRecord(raw, "response_format", "responseFormat");
  if (!value || (value.kind !== "json_schema" && value.kind !== "json_object" && value.kind !== "text")) {
    return undefined;
  }

  return {
    kind: value.kind,
    ...(value.schema !== undefined ? { schema: value.schema } : {}),
  };
}

function readToolChoice(raw: Record<string, unknown>): ModelSpec["toolChoice"] | undefined {
  const value = raw.tool_choice ?? raw.toolChoice;
  if (value === "auto" || value === "none" || value === "required") {
    return value;
  }

  if (isPlainObject(value) && typeof value.name === "string") {
    return { name: value.name };
  }

  return undefined;
}

function readStringEnum<T extends string>(
  raw: Record<string, unknown>,
  values: ReadonlySet<T>,
  ...keys: readonly string[]
): T | undefined {
  const value = readString(raw, ...keys);
  return value && values.has(value as T) ? value as T : undefined;
}

type MutableModelFields = {
  -readonly [K in keyof ModelSpec]?: ModelSpec[K];
};

function assignModelField(fields: MutableModelFields, key: keyof ModelSpec, value: unknown): void {
  if (value !== undefined) {
    (fields as Record<string, unknown>)[key] = value;
  }
}

const modelCatalogNumberKeys = new Set<keyof ModelSpec>([
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
  "concurrencyLimit",
  "throughputHintTokensPerSecond",
]);

const modelCatalogBooleanKeys = new Set<keyof ModelSpec>([
  "supportsToolCall",
  "supportsAttachment",
  "supportsVision",
  "supportsCachePrompt",
  "supportsReasoning",
  "supportsInterleavedReasoning",
  "supportsStructuredOutput",
  "supportsTemperature",
  "supportsStreaming",
  "supportsLogprobs",
  "supportsSearch",
  "supportsComputerUse",
  "openWeights",
  "priorityTierSupported",
]);

const modelCatalogStringArrayKeys = new Set<keyof ModelSpec>([
  "thinkingModes",
  "nativeToolCapabilities",
  "supportedRequestParameters",
  "unsupportedRequestParameters",
  "inputModalities",
  "outputModalities",
  "providerEnvVars",
  "providerModelAliases",
  "providerModelIds",
]);

const modelCatalogStringKeys = new Set<keyof ModelSpec>([
  "interleavedReasoningField",
  "displayName",
  "family",
  "knowledgeCutoff",
  "trainingCutoff",
  "releaseDate",
  "lastUpdated",
  "license",
  "providerDisplayName",
  "providerNpmPackage",
  "providerApiBaseUrl",
  "providerDocsUrl",
  "preferredEndpoint",
  "latencyClass",
  "rateLimitTier",
]);

type ReasoningEffortValue = NonNullable<ModelSpec["defaultReasoningEffort"]>;
type ModelStatusValue = NonNullable<ModelSpec["modelStatus"]>;

const reasoningEffortValues = new Set<ReasoningEffortValue>([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
]);

const modelStatusValues = new Set<ModelStatusValue>([
  "stable",
  "preview",
  "experimental",
  "alpha",
  "beta",
  "deprecated",
  "shutdown",
]);

function applyModelCatalogProviderFields(raw: Record<string, unknown>, fields: MutableModelFields): void {
  for (const [snakeKey, modelKey] of Object.entries(MODEL_CATALOG_FIELD_KEY_MAP)) {
    if (modelCatalogNumberKeys.has(modelKey)) {
      assignModelField(fields, modelKey, readNumber(raw, snakeKey, modelKey));
    } else if (modelCatalogBooleanKeys.has(modelKey)) {
      assignModelField(fields, modelKey, readBoolean(raw, snakeKey, modelKey));
    } else if (modelCatalogStringArrayKeys.has(modelKey)) {
      assignModelField(fields, modelKey, readStringArray(raw, snakeKey, modelKey));
    } else if (modelCatalogStringKeys.has(modelKey)) {
      assignModelField(fields, modelKey, readString(raw, snakeKey, modelKey));
    } else if (modelKey === "supportedReasoningEfforts") {
      const efforts = readStringArray(raw, snakeKey, modelKey);
      if (efforts?.every((effort) => reasoningEffortValues.has(effort as ReasoningEffortValue))) {
        fields.supportedReasoningEfforts = efforts as NonNullable<ModelSpec["supportedReasoningEfforts"]>;
      }
    } else if (modelKey === "defaultReasoningEffort") {
      assignModelField(fields, modelKey, readStringEnum(raw, reasoningEffortValues, snakeKey, modelKey));
    } else if (modelKey === "modelStatus") {
      assignModelField(fields, modelKey, readStringEnum(raw, modelStatusValues, snakeKey, modelKey));
    } else if (modelKey === "modelLinks") {
      assignModelField(fields, modelKey, readStringRecord(raw, snakeKey, modelKey));
    }
  }
}

function resolveModelProviderFields(provider: AppConfig["llm"]["providers"][number]): Partial<ModelSpec> {
  const raw = provider as Record<string, unknown>;
  const fields: MutableModelFields = {};

  const baseUrl = readString(raw, "base_url", "baseUrl");
  if (baseUrl !== undefined) fields.baseUrl = baseUrl;
  const apiKeyEnv = readString(raw, "api_key_env", "apiKeyEnv");
  if (apiKeyEnv !== undefined) fields.apiKeyEnv = apiKeyEnv;
  const apiKey = readString(raw, "api_key", "apiKey");
  if (apiKey !== undefined) fields.apiKey = apiKey;
  const organization = readString(raw, "organization");
  if (organization !== undefined) fields.organization = organization;
  const extraHeaders = readStringRecord(raw, "extra_headers", "extraHeaders");
  if (extraHeaders !== undefined) fields.extraHeaders = extraHeaders;
  const extraBody = readRecord(raw, "extra_body", "extraBody");
  if (extraBody !== undefined) fields.extraBody = extraBody;
  const extraParams = readRecord(raw, "extra_params", "extraParams");
  if (extraParams !== undefined) fields.extraParams = extraParams;
  const httpProxy = readString(raw, "http_proxy", "httpProxy");
  if (httpProxy !== undefined) fields.httpProxy = httpProxy;
  const timeoutMs = readNumber(raw, "timeout_ms", "timeoutMs");
  if (timeoutMs !== undefined) fields.timeoutMs = timeoutMs;
  const maxRetries = readNumber(raw, "max_retries", "maxRetries");
  if (maxRetries !== undefined) fields.maxRetries = maxRetries;
  const apiVersion = readString(raw, "api_version", "apiVersion");
  if (apiVersion !== undefined) fields.apiVersion = apiVersion;
  const vertexProject = readString(raw, "vertex_project", "vertexProject");
  if (vertexProject !== undefined) fields.vertexProject = vertexProject;
  const vertexLocation = readString(raw, "vertex_location", "vertexLocation");
  if (vertexLocation !== undefined) fields.vertexLocation = vertexLocation;
  const googleCredentialsEnv = readString(raw, "google_application_credentials_env", "googleApplicationCredentialsEnv");
  if (googleCredentialsEnv !== undefined) fields.googleApplicationCredentialsEnv = googleCredentialsEnv;
  const googleCredentials = readString(raw, "google_application_credentials", "googleApplicationCredentials");
  if (googleCredentials !== undefined) fields.googleApplicationCredentials = googleCredentials;
  const awsRegion = readString(raw, "aws_region", "awsRegion");
  if (awsRegion !== undefined) fields.awsRegion = awsRegion;
  const awsAccessKeyEnv = readString(raw, "aws_access_key_env", "awsAccessKeyEnv");
  if (awsAccessKeyEnv !== undefined) fields.awsAccessKeyEnv = awsAccessKeyEnv;
  const awsSecretKeyEnv = readString(raw, "aws_secret_key_env", "awsSecretKeyEnv");
  if (awsSecretKeyEnv !== undefined) fields.awsSecretKeyEnv = awsSecretKeyEnv;
  const awsSessionTokenEnv = readString(raw, "aws_session_token_env", "awsSessionTokenEnv");
  if (awsSessionTokenEnv !== undefined) fields.awsSessionTokenEnv = awsSessionTokenEnv;
  const awsAccessKey = readString(raw, "aws_access_key", "awsAccessKey");
  if (awsAccessKey !== undefined) fields.awsAccessKey = awsAccessKey;
  const awsSecretKey = readString(raw, "aws_secret_key", "awsSecretKey");
  if (awsSecretKey !== undefined) fields.awsSecretKey = awsSecretKey;
  const awsSessionToken = readString(raw, "aws_session_token", "awsSessionToken");
  if (awsSessionToken !== undefined) fields.awsSessionToken = awsSessionToken;
  const awsProfile = readString(raw, "aws_profile", "awsProfile");
  if (awsProfile !== undefined) fields.awsProfile = awsProfile;
  const anthropicVersion = readString(raw, "anthropic_version", "anthropicVersion");
  if (anthropicVersion !== undefined) fields.anthropicVersion = anthropicVersion;
  const anthropicBeta = readStringArray(raw, "anthropic_beta", "anthropicBeta");
  if (anthropicBeta !== undefined) fields.anthropicBeta = anthropicBeta;

  const cacheControl = readString(raw, "cache_control", "cacheControl");
  if (cacheControl === "ephemeral" || cacheControl === "off") fields.cacheControl = cacheControl;
  const thinkingLevel = readString(raw, "thinking_level", "thinkingLevel");
  if (
    thinkingLevel === "off" ||
    thinkingLevel === "minimal" ||
    thinkingLevel === "low" ||
    thinkingLevel === "medium" ||
    thinkingLevel === "high" ||
    thinkingLevel === "max"
  ) {
    fields.thinkingLevel = thinkingLevel;
  }
  const thinkingBudgetTokens = readNumber(raw, "thinking_budget_tokens", "thinkingBudgetTokens");
  if (thinkingBudgetTokens !== undefined) fields.thinkingBudgetTokens = thinkingBudgetTokens;
  const reasoningEffort = readString(raw, "reasoning_effort", "reasoningEffort");
  if (
    reasoningEffort === "minimal" ||
    reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high" ||
    reasoningEffort === "max"
  ) {
    fields.reasoningEffort = reasoningEffort;
  }
  const thinking = readThinking(raw);
  if (thinking !== undefined) fields.thinking = thinking;
  const responseFormat = readResponseFormat(raw);
  if (responseFormat !== undefined) fields.responseFormat = responseFormat;
  const toolChoice = readToolChoice(raw);
  if (toolChoice !== undefined) fields.toolChoice = toolChoice;
  const parallelToolCalls = readBoolean(raw, "parallel_tool_calls", "parallelToolCalls");
  if (parallelToolCalls !== undefined) fields.parallelToolCalls = parallelToolCalls;
  const seed = readNumber(raw, "seed");
  if (seed !== undefined) fields.seed = seed;
  const logitBias = readNumberRecord(raw, "logit_bias", "logitBias");
  if (logitBias !== undefined) fields.logitBias = logitBias;
  const dropParams = readStringArray(raw, "drop_params", "dropParams");
  if (dropParams !== undefined) fields.dropParams = dropParams;
  const allowedOpenaiParams = readStringArray(raw, "allowed_openai_params", "allowedOpenaiParams");
  if (allowedOpenaiParams !== undefined) fields.allowedOpenaiParams = allowedOpenaiParams;
  const contextWindow = readNumber(raw, "context_window", "contextWindow");
  if (contextWindow !== undefined) fields.contextWindow = contextWindow;
  const supportsToolCall = readBoolean(raw, "supports_tool_call", "supportsToolCall");
  if (supportsToolCall !== undefined) fields.supportsToolCall = supportsToolCall;
  const supportsVision = readBoolean(raw, "supports_vision", "supportsVision");
  if (supportsVision !== undefined) fields.supportsVision = supportsVision;
  const supportsCachePrompt = readBoolean(raw, "supports_cache_prompt", "supportsCachePrompt");
  if (supportsCachePrompt !== undefined) fields.supportsCachePrompt = supportsCachePrompt;
  applyModelCatalogProviderFields(raw, fields);

  return fields;
}

export function createLlmClientFromModelSpec(model: ModelSpec): ChatCompletionClient {
  return createChatClientFromModelSpec(model);
}

function createConfiguredAgentAdapter(kind: AppConfig["agent"]["default"]): AgentAdapter | undefined {
  return kind === "native-llm" ? undefined : createAgentAdapter({ kind });
}

export function resolveAgentAdapterFromConfig(config: AppConfig): AgentAdapter | undefined {
  return createConfiguredAgentAdapter(config.agent.default);
}

export async function createSandboxBackendFromConfig(config: AppConfig): Promise<SandboxBackend> {
  return createSandboxBackendFromSandboxConfig(config.agent.sandbox);
}

/**
 * Sandbox factory over a sandbox-config slice (P4/H04): the global
 * `agent.sandbox` or its workspace-layer merged equivalent. An explicitly
 * requested container kind that fails preflight throws — never a silent
 * native downgrade.
 */
export async function createSandboxBackendFromSandboxConfig(
  sandboxConfig: AppConfig["agent"]["sandbox"],
): Promise<SandboxBackend> {
  const resolved = await resolveSandboxKind(
    sandboxConfig.kind as SandboxKind | undefined,
    sandboxConfig.engine as SandboxEngine | undefined,
  );

  return createSandboxBackend({
    kind: resolved.kind,
    engine: resolved.engine,
    ...(sandboxConfig.image ? { image: sandboxConfig.image } : {}),
  });
}

export function resolveGiteaWebhookConfig(
  config: AppConfig,
  triggerName?: string,
  appTokenServices?: ReadonlyMap<string, GithubAppTokenService>,
  workspaceRuntime?: WorkspaceRuntime,
): VcsWebhookConfig | undefined {
  return resolveGiteaLikeWebhookConfigs(config, "gitea", triggerName, appTokenServices, workspaceRuntime)[0];
}

/**
 * Every gitea-like trigger profile of one kind (P1b: all profiles are
 * selectable per request, not just the first). The gitea route additionally
 * serves forgejo triggers for backward compatibility.
 */
export function resolveGiteaLikeWebhookConfigs(
  config: AppConfig,
  kind: "gitea" | "forgejo",
  triggerName?: string,
  appTokenServices?: ReadonlyMap<string, GithubAppTokenService>,
  workspaceRuntime?: WorkspaceRuntime,
): readonly VcsWebhookConfig[] {
  const kinds: readonly string[] = kind === "gitea" ? ["gitea", "forgejo"] : ["forgejo"];
  const triggers = config.triggers.filter((trigger) =>
    kinds.includes(trigger.kind) && (triggerName === undefined || trigger.name === triggerName));
  return triggers.filter((trigger) => triggerAdmitsNewWork(config, trigger)).map((trigger) => buildWebhookConfigFromTrigger(config, trigger, appTokenServices, workspaceRuntime));
}

function buildWebhookConfigFromTrigger(
  config: AppConfig,
  trigger: AppConfig["triggers"][number],
  appTokenServices?: ReadonlyMap<string, GithubAppTokenService>,
  workspaceRuntime?: WorkspaceRuntime,
): VcsWebhookConfig {
  const triggerConfig = trigger as Record<string, unknown>;
  const webhookSecret = resolveSecretField(triggerConfig, "webhook_secret", "webhook_secret_env");
  const token = resolveSecretField(triggerConfig, "token", "token_env");
  const baseUrl = triggerConfig.base_url as string | undefined;
  const workspaceId = resolveWorkspaceIdFromTrigger(config, trigger.name);
  const repoRef = resolveWorkspaceRepoRef(config, trigger.name, workspaceId) ?? resolveWorkspaceRepoRef(config, trigger.name);
  const hasApp = isPlainObject(triggerConfig.app);
  const appTokenService = hasApp ? appTokenServices?.get(trigger.name) : undefined;

  return {
    triggerName: trigger.name,
    routingEnabled: (config as EffectiveConfigV2).routing !== undefined,
    workspaceId,
    isWorkspaceEnabled: (id) => (id === "default" && Object.keys(config.workspaces.instances).length === 0) ||
      (config.workspaces.instances[id] !== undefined && config.workspaces.instances[id]?.enabled !== false),
    ...(repoRef ? { repoRef } : {}),
    ...withRepoMappings(triggerConfig),
    ...(webhookSecret !== undefined ? { webhookSecret } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(appTokenService ? { appTokenResolver: (installationId: number) => appTokenService.getInstallationToken(installationId) } : {}),
    ...(appTokenService ? { evictTokenCache: (installationId?: number) => appTokenService.evict(installationId) } : {}),
    ...(workspaceRuntime?.isMatchReferenced(trigger.name)
      ? { resolveWorkspace: (source, event) => workspaceRuntime.resolveForSource(trigger.name, source, event) }
      : {}),
  };
}

export function resolveGenericWebhookConfigs(
  config: AppConfig,
  kind: string,
  triggerName?: string,
  appTokenServices?: ReadonlyMap<string, GithubAppTokenService>,
  workspaceRuntime?: WorkspaceRuntime,
): readonly VcsWebhookConfig[] {
  const triggers = triggerName
    ? config.triggers.filter((trigger) => trigger.name === triggerName && trigger.kind === kind)
    : config.triggers.filter((trigger) => trigger.kind === kind);

  return triggers.filter((trigger) => triggerAdmitsNewWork(config, trigger)).map((trigger) => buildWebhookConfigFromTrigger(config, trigger, appTokenServices, workspaceRuntime));
}

export function resolveGenericWebhookConfig(
  config: AppConfig,
  kind: string,
  triggerName?: string,
  appTokenServices?: ReadonlyMap<string, GithubAppTokenService>,
): VcsWebhookConfig | undefined {
  return resolveGenericWebhookConfigs(config, kind, triggerName, appTokenServices)[0];
}

export function resolveP4TriggerConfigs(
  config: AppConfig,
  triggerName?: string,
  workspaceRuntime?: WorkspaceRuntime,
): readonly P4TriggerConfig[] {
  const triggers = triggerName
    ? config.triggers.filter((t) => t.name === triggerName && t.kind === "p4")
    : config.triggers.filter((t) => t.kind === "p4");

  return triggers.filter((trigger) => triggerAdmitsNewWork(config, trigger)).map((trigger): P4TriggerConfig => {
    const triggerConfig = trigger as Record<string, unknown>;
    const port = triggerConfig.port as string | undefined;
    const user = resolveSecretField(triggerConfig, "user", "user_env");
    const rawPassword = resolveSecretField(triggerConfig, "password", "password_env")
      ?? resolveSecretField(triggerConfig, "ticket", "ticket_env");
    const depot = triggerConfig.depot_path as string | undefined;
    const streams = triggerConfig.streams as string[] | undefined;
    const workspace = triggerConfig.workspace as string | undefined;
    const watchPath = triggerConfig.watch_path as string[] | undefined;
    const includeCrFile = triggerConfig.include_cr_file as string[] | undefined;
    const excludeCrFile = triggerConfig.exclude_cr_file as string[] | undefined;

    return {
      triggerName: trigger.name,
      workspaceId: resolveWorkspaceIdFromTrigger(config, trigger.name),
      ...(port ? { port } : {}),
      ...(user ? { user } : {}),
      ...(rawPassword ? { password: rawPassword } : {}),
      // depot stays the legacy single-scope fallback; streams keeps the full
      // configured list so resolution/factory never truncate to the first.
      ...(streams?.[0] ? { depot: streams[0] } : depot ? { depot } : {}),
      ...(streams && streams.length > 0 ? { streams } : {}),
      ...(workspace ? { workspace } : {}),
      ...(watchPath ? { watchPath } : {}),
      ...(includeCrFile ? { includeCrFile } : {}),
      ...(excludeCrFile ? { excludeCrFile } : {}),
      ...(workspaceRuntime?.isMatchReferenced(trigger.name)
        ? { resolveWorkspace: (source, event) => workspaceRuntime.resolveForSource(trigger.name, source, event) }
        : {}),
    };
  });
}

export function resolveP4TriggerConfig(
  config: AppConfig,
  triggerName?: string,
  workspaceRuntime?: WorkspaceRuntime,
): P4TriggerConfig | undefined {
  return resolveP4TriggerConfigs(config, triggerName, workspaceRuntime)[0];
}

export function resolveSvnTriggerConfigs(
  config: AppConfig,
  triggerName?: string,
  workspaceRuntime?: WorkspaceRuntime,
): readonly SvnTriggerConfig[] {
  const triggers = triggerName
    ? config.triggers.filter((t) => t.name === triggerName && t.kind === "svn")
    : config.triggers.filter((t) => t.kind === "svn");

  const configs: SvnTriggerConfig[] = [];
  for (const trigger of triggers) {
    if (!triggerAdmitsNewWork(config, trigger)) continue;
    const triggerConfig = trigger as Record<string, unknown>;
    const repositoryUrl = typeof triggerConfig.repository_url === "string"
      ? triggerConfig.repository_url.trim()
      : "";
    if (!repositoryUrl) {
      continue;
    }
    const rawRoots = Array.isArray(triggerConfig.project_roots)
      ? (triggerConfig.project_roots as readonly Record<string, unknown>[])
      : undefined;
    const projectRoots = rawRoots
      ?.filter((root) => typeof root?.prefix === "string" && typeof root?.project === "string")
      .map((root) => ({
        prefix: String(root.prefix),
        project: String(root.project),
        ...(typeof root.branch === "string" ? { branch: root.branch } : {}),
      }))
      .filter((root) => root.prefix.startsWith("/"));
    configs.push({
      triggerName: trigger.name,
      workspaceId: resolveWorkspaceIdFromTrigger(config, trigger.name),
      repositoryUrl,
      ...(projectRoots && projectRoots.length > 0 ? { projectRoots } : {}),
      ...(workspaceRuntime?.isMatchReferenced(trigger.name)
        ? { resolveWorkspace: (source, event) => workspaceRuntime.resolveForSource(trigger.name, source, event) }
        : {}),
    });
  }
  return configs;
}

export function resolveSvnTriggerConfig(
  config: AppConfig,
  triggerName?: string,
  workspaceRuntime?: WorkspaceRuntime,
): SvnTriggerConfig | undefined {
  return resolveSvnTriggerConfigs(config, triggerName, workspaceRuntime)[0];
}

export function resolveAuthConfig(config: AppConfig): AuthConfig | undefined {
  const serverAuth = config.server.auth as Record<string, unknown> | undefined;
  const globalApiKey = serverAuth ? resolveSecretField(serverAuth, "api_key", "api_key_env") : undefined;
  const authEnabled = serverAuth ? (serverAuth.enabled as boolean | undefined) !== false : true;

  const workspaceApiKeys = new Map<string, string>();
  for (const [workspaceId, instance] of Object.entries(config.workspaces.instances)) {
    const workspaceConfig = instance as Record<string, unknown>;
    const workspaceAuth = workspaceConfig.auth as Record<string, unknown> | undefined;
    if (!workspaceAuth) continue;

    const wsEnabled = workspaceAuth.enabled as boolean | undefined;
    if (wsEnabled === false) continue;

    const wsApiKey = resolveSecretField(workspaceAuth, "api_key", "api_key_env");
    if (wsApiKey) {
      workspaceApiKeys.set(workspaceId, wsApiKey);
    }
  }

  if (!globalApiKey && workspaceApiKeys.size === 0 && authEnabled) {
    return undefined;
  }

  return {
    ...(globalApiKey ? { globalApiKey } : {}),
    workspaceApiKeys,
    enabled: authEnabled,
  };
}

function triggerAdmitsNewWork(config: AppConfig, trigger: AppConfig["triggers"][number]): boolean {
  if (trigger.enabled === false) return false;
  const bound = Object.values(config.workspaces.instances).find((entry) => entry.source_repo?.trigger === trigger.name);
  if (bound) return bound.enabled !== false;
  const candidates = Object.values(config.workspaces.instances).filter((entry) => entry.match?.some((rule) => !rule.triggers || rule.triggers.includes(trigger.name)));
  return candidates.length === 0 || candidates.some((entry) => entry.enabled !== false);
}

function buildActiveProjectIdentities(config: AppConfig): readonly ActiveProjectIdentity[] {
  return Object.entries(config.workspaces.instances).flatMap(([workspaceId, instance]) => {
    const sourceRepo = instance.source_repo;
    if (!sourceRepo) {
      return [];
    }

    return [{
      workspaceId,
      triggerName: sourceRepo.trigger,
      repoRef: sourceRepo.repo,
    }];
  });
}

function resolveWorkspaceIdFromTrigger(config: AppConfig, triggerName: string): string {
  const instances = config.workspaces.instances;
  for (const [id, instance] of Object.entries(instances)) {
    if (instance.source_repo?.trigger === triggerName) {
      return id;
    }
  }
  const instanceKeys = Object.keys(instances);
  const firstKey = instanceKeys[0];
  if (firstKey !== undefined) {
    return firstKey;
  }

  return "default";
}

function resolveRepoMappings(triggerConfig: Record<string, unknown>): readonly { readonly match: string; readonly workspace: string }[] {
  const repos = triggerConfig.repos;
  if (!Array.isArray(repos)) {
    return [];
  }

  return repos.flatMap((repo) => {
    if (!repo || typeof repo !== "object") {
      return [];
    }

    const entry = repo as Record<string, unknown>;
    return typeof entry.match === "string" && typeof entry.workspace === "string"
      ? [{ match: entry.match, workspace: entry.workspace }]
      : [];
  });
}

function withRepoMappings(
  triggerConfig: Record<string, unknown>,
): { readonly repoMappings?: readonly { readonly match: string; readonly workspace: string }[] } {
  const repoMappings = resolveRepoMappings(triggerConfig);
  return repoMappings.length > 0 ? { repoMappings } : {};
}

type OutputChannelConfig = AppConfig["outputs"]["channels"][number];
type OutputRouteChannelKey = "line_comments" | "summary";
type NoProblemsAction = "publish" | "suppress" | "publish_if_summary";

interface TargetUrlTemplateOptions {
  readonly commitUrlTemplate?: string;
  readonly revisionUrlTemplate?: string;
  readonly changeUrlTemplate?: string;
  readonly baseUrl?: string;
}

export interface OutputPublisherConfigOptions {
  readonly baseDir?: string;
  readonly appTokenServices?: ReadonlyMap<string, GithubAppTokenService>;
  readonly resolutionAnalyzerFactory?: (
    sourceRoot: string,
    context: ReviewOrchestrationContext,
  ) => ProblemResolutionAnalyzer;
}

function readNoProblemsAction(value: unknown): NoProblemsAction | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  return value.action === "publish" || value.action === "suppress" || value.action === "publish_if_summary"
    ? value.action
    : undefined;
}

function readNoProblemsActionFrom(raw: unknown): NoProblemsAction | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }

  return readNoProblemsAction(raw.no_problems);
}

function readChannelOverrideNoProblemsAction(raw: unknown, channelName: string): NoProblemsAction | undefined {
  if (!isPlainObject(raw) || !isPlainObject(raw.channel_overrides)) {
    return undefined;
  }

  return readNoProblemsActionFrom(raw.channel_overrides[channelName]);
}

function defaultNoProblemsActionForChannel(channelKind: string): NoProblemsAction {
  if (channelKind === "gitea_problem_issue" || channelKind === "github_problem_issue") {
    return "publish";
  }
  if (channelKind === "feishu_bot" || channelKind === "wecom_bot") {
    return "publish_if_summary";
  }
  return "suppress";
}

function resolveNoProblemsAction(
  config: AppConfig,
  channel: OutputChannelConfig,
  workspaceId: string | undefined,
): NoProblemsAction {
  let action = defaultNoProblemsActionForChannel(channel.kind);
  action = readNoProblemsActionFrom(config.outputs) ?? action;
  action = readNoProblemsActionFrom(channel) ?? action;

  const defaultsOutputs = config.workspaces.defaults.outputs;
  action = readNoProblemsActionFrom(defaultsOutputs) ?? action;
  action = readChannelOverrideNoProblemsAction(defaultsOutputs, channel.name) ?? action;

  const workspaceOutputs = workspaceId ? config.workspaces.instances[workspaceId]?.outputs : undefined;
  action = readNoProblemsActionFrom(workspaceOutputs) ?? action;
  action = readChannelOverrideNoProblemsAction(workspaceOutputs, channel.name) ?? action;

  return action;
}

function resolveProblemIssueMaxRecentIssues(
  config: AppConfig,
  workspaceId: string | undefined,
): number | undefined {
  const globalLimit = config.review.problem_issue?.max_recent_issues;
  if (!workspaceId) {
    return globalLimit;
  }

  try {
    const workspace = resolveWorkspaceConfig(config, workspaceId);
    return workspace.review?.problem_issue?.max_recent_issues ?? globalLimit;
  } catch {
    return globalLimit;
  }
}

function toMentionChannelKind(channelKind: string): MentionChannelKind | undefined {
  switch (channelKind) {
    case "gitea_pr_review":
    case "github_pr_review":
    case "github_issue":
    case "github_problem_issue":
    case "gitlab_mr_review":
    case "gitea_issue":
    case "gitea_problem_issue":
    case "feishu_bot":
    case "wecom_bot":
      return channelKind;
    default:
      return undefined;
  }
}

function shouldMentionAuthor(channel: OutputChannelConfig): boolean {
  const configured = (channel as Record<string, unknown>).mention_author;
  if (typeof configured === "boolean") {
    return configured;
  }

  return channel.kind === "gitea_pr_review" ||
    channel.kind === "github_pr_review" ||
    channel.kind === "github_issue" ||
    channel.kind === "github_problem_issue" ||
    channel.kind === "gitlab_mr_review" ||
    channel.kind === "gitea_issue";
}

function buildAuthorResolutionOptions(
  config: AppConfig,
  channel: OutputChannelConfig,
): AuthorResolutionOptions | undefined {
  const authorResolution = config.outputs.author_resolution;
  const mentionFallback = (channel as Record<string, unknown>).mention_fallback;
  const options: AuthorResolutionOptions = {
    ...(authorResolution?.email_mappings ? { emailMappings: authorResolution.email_mappings } : {}),
    ...(authorResolution?.email_blacklist ? { emailBlacklist: new Set(authorResolution.email_blacklist) } : {}),
    ...(mentionFallback === "all" || mentionFallback === "skip" ? { mentionFallback } : {}),
  };

  return Object.keys(options).length > 0 ? options : undefined;
}

function buildBaseTemplateContext(
  reviewEvent: ReviewEvent | undefined,
  repoRef: string | undefined,
  mentionChannelKind: MentionChannelKind | undefined,
  mentionAuthor: boolean,
  authorResolution: AuthorResolutionOptions | undefined,
  targetUrlTemplates: TargetUrlTemplateOptions = {},
): Omit<TemplateContext, "problem" | "problems"> {
  const eventAuthor = reviewEvent?.author?.username;
  const eventEmail = reviewEvent?.author?.email;
  const eventDisplayName = reviewEvent?.author?.displayName;
  const eventCtx: { author?: string; email?: string; displayName?: string; url?: string; title?: string } = {};
  if (eventAuthor !== undefined) {
    eventCtx.author = eventAuthor;
  }
  if (eventEmail !== undefined) {
    eventCtx.email = eventEmail;
  }
  if (eventDisplayName !== undefined) {
    eventCtx.displayName = eventDisplayName;
  }
  if (reviewEvent?.title !== undefined) {
    eventCtx.title = reviewEvent.title;
  }
  if (reviewEvent?.url !== undefined) {
    eventCtx.url = reviewEvent.url;
  }

  const resolvedRepoRef = reviewEvent?.repoRef ?? repoRef;
  const repoName = resolvedRepoRef?.split("/").at(-1);
  const repo = resolvedRepoRef
    ? {
        fullName: resolvedRepoRef,
        ...(repoName ? { name: repoName } : {}),
      }
    : undefined;
  const atMentions = mentionAuthor && reviewEvent && mentionChannelKind
    ? buildAtMentions({ author: reviewEvent.author }, mentionChannelKind, authorResolution)
    : "";
  const target = reviewEvent
    ? buildTemplateTargetContext({
        kind: reviewEvent.targetKind,
        provider: reviewEvent.provider,
        ...(resolvedRepoRef ? { repoRef: resolvedRepoRef } : {}),
        ...(reviewEvent.title !== undefined ? { title: reviewEvent.title } : {}),
        ...(reviewEvent.url !== undefined ? { url: reviewEvent.url } : {}),
        ...(reviewEvent.baseSha !== undefined ? { baseRevision: reviewEvent.baseSha } : {}),
        ...(reviewEvent.headSha !== undefined ? { headRevision: reviewEvent.headSha } : {}),
        triggerName: reviewEvent.triggerName,
        workspaceId: reviewEvent.workspaceId,
        ...targetUrlTemplates,
      })
    : undefined;

  const vcs = buildVcsContext(reviewEvent);

  return {
    ...(Object.keys(eventCtx).length > 0 ? { event: eventCtx } : {}),
    ...(target ? { target } : {}),
    ...(repo ? { repo } : {}),
    ...(atMentions ? { atMentions } : {}),
    ...(Object.keys(vcs).length > 0 ? { vcs } : {}),
  };
}

function buildVcsContext(reviewEvent: ReviewEvent | undefined): { branch?: string; sourcePath?: string; workspace?: string; repositoryPath?: string } {
  if (!reviewEvent) {
    return {};
  }

  const result: { branch?: string; sourcePath?: string; workspace?: string; repositoryPath?: string } = {};

  if (reviewEvent.branch !== undefined) {
    result.branch = reviewEvent.branch;
  }
  if (reviewEvent.sourcePath !== undefined) {
    result.sourcePath = reviewEvent.sourcePath;
  }
  if (reviewEvent.submitterWorkspace !== undefined) {
    result.workspace = reviewEvent.submitterWorkspace;
  }
  if (reviewEvent.repoRef !== undefined) {
    result.repositoryPath = reviewEvent.repoRef;
  }

  return result;
}

function createChannelRendering(
  config: AppConfig,
  channel: OutputChannelConfig,
  workspaceId: string | undefined,
  reviewEvent: ReviewEvent | undefined,
  repoRef: string | undefined,
  baseDir: string,
  targetUrlTemplates: TargetUrlTemplateOptions = {},
): {
  readonly mentionText: string;
  readonly renderProblem: (problem: ReviewProblem) => ReviewProblem;
  readonly renderSummary: (summary: string, problems: readonly ReviewProblem[], title?: string) => string;
} {
  const layout = reviewEvent ? createWorkspaceRuntime(config, baseDir).layoutForEvent(reviewEvent) : undefined;
  const workspaceTemplatesDir = layout?.templatesDir ?? (workspaceId
    ? resolve(baseDir, "workspaces", workspaceId, "templates")
    : undefined);
  const builtinTemplatesBaseDir = resolve(baseDir, "templates", "builtin");
  const resolver = createTemplateResolver({
    channelKind: channel.kind,
    channelName: channel.name,
    // Explicit channel template references (outputs.templates, merged
    // file+database config) win over workspace-directory and built-in lookup.
    namedTemplateSource: (kind) => {
      const name = channel.templates?.[kind];
      return name !== undefined ? config.outputs.templates[name] : undefined;
    },
    ...(workspaceTemplatesDir ? { workspaceTemplatesDir } : {}),
    ...(layout?.policyRoot ? { fallbackWorkspaceTemplatesDirs: [resolve(layout.policyRoot, "templates")] } : {}),
    builtinTemplatesBaseDir,
  });
  const mentionChannelKind = toMentionChannelKind(channel.kind);
  const authorResolution = buildAuthorResolutionOptions(config, channel);
  const baseTemplateContext = buildBaseTemplateContext(
    reviewEvent,
    repoRef,
    mentionChannelKind,
    shouldMentionAuthor(channel),
    authorResolution,
    targetUrlTemplates,
  );

  return {
    mentionText: baseTemplateContext.atMentions ?? "",
    renderProblem(problem: ReviewProblem): ReviewProblem {
      if (problem.renderedMarkdown) {
        return problem;
      }

      const renderedMarkdown = fixAndValidateMarkdown(resolver.render("problem", {
        ...baseTemplateContext,
        problem: toTemplateProblem(problem),
      }));

      return { ...problem, renderedMarkdown };
    },
    renderSummary(summary: string, problems: readonly ReviewProblem[], title?: string): string {
      return fixAndValidateMarkdown(resolver.render("summary", {
        ...baseTemplateContext,
        summary,
        ...(title ? { summaryTitle: title } : {}),
        problems: problems.map((problem) => toTemplateProblem(problem)),
      }));
    },
  };
}

function appendPublisherResults(target: DispatchResult[], result: ReviewDispatchResult): void {
  if (Array.isArray(result)) {
    target.push(...(result as readonly DispatchResult[]));
    return;
  }

  target.push(result as DispatchResult);
}

interface OutputPublisherEntry {
  readonly name: string;
  readonly publisher: ReviewOutputPublisher;
}

function readDispatchErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function toDispatchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildDispatchFailureHint(channelName: string, status: number | undefined): string | undefined {
  if (status === 403 && channelName.toLowerCase().includes("github")) {
    return "GitHub webhook event subscriptions do not grant REST API permissions. Configure token_env with a token or GitHub App installation token that has Issues read/write access, and reinstall/refresh the App installation after changing permissions.";
  }

  return undefined;
}

function createFailedDispatchResult(channelName: string, phase: "problem" | "summary", error: unknown): DispatchResult {
  const status = readDispatchErrorStatus(error);
  const hint = buildDispatchFailureHint(channelName, status);
  return {
    channel: channelName,
    status: "failed",
    raw: {
      action: "dispatch_failed",
      phase,
      error: toDispatchErrorMessage(error),
      ...(status !== undefined ? { status } : {}),
      ...(hint ? { hint } : {}),
    },
  };
}

function logDispatchFailure(channelName: string, phase: "problem" | "summary", error: unknown): void {
  const status = readDispatchErrorStatus(error);
  const hint = buildDispatchFailureHint(channelName, status);
  console.warn(JSON.stringify({
    level: "warn",
    msg: "output channel dispatch failed",
    channel: channelName,
    phase,
    error: toDispatchErrorMessage(error),
    ...(status !== undefined ? { status } : {}),
    ...(hint ? { hint } : {}),
  }));
}

function callPublishProblem(
  publisher: ReviewOutputPublisher,
  problem: ReviewProblem,
): Promise<ReviewDispatchResult> {
  if (!publisher.publishProblem) {
    throw new TypeError("Review output publisher must provide publishProblem.");
  }

  return publisher.publishProblem(problem);
}

function uniqueOutputPublisherEntries(entries: readonly OutputPublisherEntry[]): readonly OutputPublisherEntry[] {
  const seen = new Set<string>();
  const result: OutputPublisherEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      continue;
    }
    seen.add(entry.name);
    result.push(entry);
  }
  return result;
}

function createCompositeOutputPublisher(
  linePublishers: readonly OutputPublisherEntry[],
  summaryPublishers: readonly OutputPublisherEntry[],
): ReviewOutputPublisher | undefined {
  const summaryCapable = uniqueOutputPublisherEntries(summaryPublishers.filter((entry) => entry.publisher.publishSummary));
  const lineFlushCapable = uniqueOutputPublisherEntries(linePublishers.filter((entry) => entry.publisher.publishSummary));
  const summaryFlushCapable = uniqueOutputPublisherEntries([...lineFlushCapable, ...summaryCapable]);
  const summaryChannelNames = new Set(summaryCapable.map((entry) => entry.name));

  if (linePublishers.length === 0 && summaryFlushCapable.length === 0) {
    return undefined;
  }

  return {
    handlesRendering: true,
    publishesProblems: linePublishers.length > 0,
    noProblemsAction: summaryCapable.some((entry) => entry.publisher.noProblemsAction === "publish" || entry.publisher.noProblemsAction === "publish_if_summary") ? summaryCapable.every((entry) => entry.publisher.noProblemsAction === "publish_if_summary") ? "publish_if_summary" : "publish" : "suppress",
    publishEmptySummary: summaryCapable.some((entry) => entry.publisher.publishEmptySummary && entry.publisher.noProblemsAction !== "suppress"),
    async publishProblem(problem: ReviewProblem): Promise<readonly DispatchResult[]> {
      const results: DispatchResult[] = [];
      for (const entry of linePublishers) {
        try {
          appendPublisherResults(results, await callPublishProblem(entry.publisher, problem));
        } catch (error) {
          logDispatchFailure(entry.name, "problem", error);
          results.push(createFailedDispatchResult(entry.name, "problem", error));
        }
      }
      return results;
    },
    ...(summaryFlushCapable.length > 0
      ? {
          async publishSummary(
            summary: string,
            problems?: readonly ReviewProblem[],
            options?: ReviewSummaryPublishOptions,
          ): Promise<readonly DispatchResult[]> {
            const results: DispatchResult[] = [];
            const noProblems = (problems?.length ?? 0) === 0;
            const bypassNoProblemsPolicy = options?.bypassNoProblemsPolicy === true;
            const entries = noProblems ? summaryCapable : summaryFlushCapable;
            for (const entry of entries) {
              const publisher = entry.publisher;
              if (!summaryChannelNames.has(entry.name) && noProblems) {
                continue;
              }
              if (!bypassNoProblemsPolicy && noProblems) {
                if (publisher.noProblemsAction === "suppress") {
                  continue;
                }
                if (publisher.noProblemsAction === "publish_if_summary" && !summary.trim()) {
                  continue;
                }
              }
              if (publisher.publishSummary) {
                try {
                  appendPublisherResults(results, await publisher.publishSummary(summary, problems, options));
                } catch (error) {
                  logDispatchFailure(entry.name, "summary", error);
                  results.push(createFailedDispatchResult(entry.name, "summary", error));
                }
              }
            }
            return results;
          },
        }
      : {}),
  };
}

export function createOutputPublisherFromConfig(
  config: AppConfig,
  channelName?: string,
  pullNumber?: number,
  workspaceId?: string,
  reviewEvent?: ReviewEvent,
  baseDir = process.cwd(),
  resolvedTriggerToken?: string,
  resolutionAnalyzer?: ProblemResolutionAnalyzer,
): ReviewOutputPublisher | undefined {
  const channels = config.outputs.channels;
  if (channels.length === 0) {
    return undefined;
  }

  const channel = channelName
    ? channels.find((c) => c.name === channelName)
    : channels.find((c) => c.kind === "gitea_pr_review" || c.kind === "github_pr_review" || c.kind === "gitlab_mr_review");

  if (!channel) {
    return undefined;
  }

  const channelConfig = channel as Record<string, unknown>;
  const triggerName = channelConfig.trigger as string | undefined;
  const isPrReview = channel.kind === "gitea_pr_review" || channel.kind === "github_pr_review" || channel.kind === "gitlab_mr_review";
  const supportedTriggerKinds = channel.kind === "gitea_pr_review" ||
    channel.kind === "gitea_issue" ||
    channel.kind === "gitea_problem_issue"
    ? ["gitea", "forgejo"]
    : channel.kind === "github_pr_review" ||
      channel.kind === "github_issue" ||
      channel.kind === "github_problem_issue"
      ? ["github"]
      : channel.kind === "gitlab_mr_review"
        ? ["gitlab"]
        : [];

  // Outbound attribution (E04): a channel without an explicit `trigger` pins
  // publishes through the trigger that accepted this event, so each run posts
  // to its owning host with that trigger's base_url/token_env. An explicit
  // channel trigger stays pinned; without any event the first supported
  // trigger remains the fallback.
  const eventTrigger = triggerName === undefined && reviewEvent?.triggerName !== undefined
    ? config.triggers.find((t) => t.name === reviewEvent.triggerName && supportedTriggerKinds.includes(t.kind))
    : undefined;
  const trigger = isPrReview || supportedTriggerKinds.length > 0
    ? (triggerName
        ? config.triggers.find((t) => t.name === triggerName && supportedTriggerKinds.includes(t.kind))
        : (eventTrigger ?? config.triggers.find((t) => supportedTriggerKinds.includes(t.kind))))
    : undefined;
  const triggerConfig = (trigger ?? {}) as Record<string, unknown>;
  const baseUrl = (channelConfig.base_url as string | undefined) ??
    (triggerConfig.base_url as string | undefined);
  // GitHub triggers carry `base_url` as the host (github.com / GHE host) for App
  // JWT and git clone, but GitHub REST dispatchers need the API base. Derive it
  // for GitHub channels only; leave `baseUrl` (host) for URL-template links and
  // for gitea/gitlab dispatchers.
  const githubApiBaseUrl = baseUrl ? resolveGithubApiBaseUrl(baseUrl) : undefined;
  const commitUrlTemplate = readString(channelConfig, "commit_url_template", "commitUrlTemplate") ??
    readString(triggerConfig, "commit_url_template", "commitUrlTemplate");
  const revisionUrlTemplate = readString(channelConfig, "revision_url_template", "revisionUrlTemplate") ??
    readString(triggerConfig, "revision_url_template", "revisionUrlTemplate");
  const changeUrlTemplate = readString(channelConfig, "change_url_template", "changeUrlTemplate") ??
    readString(triggerConfig, "change_url_template", "changeUrlTemplate");
  const targetUrlTemplates: TargetUrlTemplateOptions = {
    ...(commitUrlTemplate ? { commitUrlTemplate } : {}),
    ...(revisionUrlTemplate ? { revisionUrlTemplate } : {}),
    ...(changeUrlTemplate ? { changeUrlTemplate } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
  const noProblemsAction = resolveNoProblemsAction(config, channel, workspaceId);
  const workspaceLabels = workspaceId
    ? (() => {
        try {
          const ws = resolveWorkspaceConfig(config, workspaceId);
          return ws.review?.labels;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const autoTag = workspaceLabels?.auto_tag ?? config.review.labels?.auto_tag;
  const reviewedTag = workspaceLabels?.reviewed_tag ?? config.review.labels?.reviewed_tag;
  const channelToken = resolveSecretField(channelConfig, "token", "token_env");
  const triggerToken = resolveSecretField(triggerConfig, "token", "token_env");
  const resolvedToken = channelToken ?? triggerToken ?? (resolvedTriggerToken ?? "");
  const explicitOwner = channelConfig.owner as string | undefined;
  const explicitRepo = channelConfig.repo as string | undefined;
  const workspaceRepoRef = trigger
    ? resolveWorkspaceRepoRef(config, trigger.name, workspaceId)
    : undefined;
  // Match-rule workspaces carry no source_repo, so the accepted event's
  // repoRef is the only repository identity (E04); legacy bindings keep
  // their workspace-pinned repo untouched.
  const parsedRepo = parseRepoRef(explicitOwner && explicitRepo ? undefined : explicitRepo ?? workspaceRepoRef ?? reviewEvent?.repoRef);
  const owner = explicitOwner ?? parsedRepo?.owner;
  const repo = explicitOwner ? explicitRepo : parsedRepo?.repo;
  // GitLab project paths may contain multiple namespace segments. Preserve
  // the complete accepted target path instead of requiring owner/repo shape.
  const repoRef = owner && repo ? `${owner}/${repo}` :
    channel.kind === "gitlab_mr_review" ? explicitRepo ?? workspaceRepoRef ?? reviewEvent?.repoRef : workspaceRepoRef;
  const rendering = createChannelRendering(config, channel, workspaceId, reviewEvent, repoRef, baseDir, targetUrlTemplates);
  const publishEmptySummary = noProblemsAction === "publish";
  const channelSeverityLabelPrefix = readString(channelConfig, "severity_label_prefix", "severityLabelPrefix");
  const channelSeverityLabelColors = isPlainObject(channelConfig.severity_label_colors)
    ? channelConfig.severity_label_colors as Readonly<Record<string, string>>
    : undefined;
  const problemIssueMaxRecentIssues = resolveProblemIssueMaxRecentIssues(config, workspaceId);
  const channelReviewMode = readString(channelConfig, "review_mode", "reviewMode") as "auto" | "review" | "comment" | undefined;
  const channelReviewEvent = readString(channelConfig, "review_event", "reviewEvent") as "COMMENT" | "REQUEST_CHANGES" | undefined;
  const channelReviewUpdateStrategy = readString(channelConfig, "review_update_strategy", "reviewUpdateStrategy") as "always_new" | "update_existing" | undefined;
  const headSha = reviewEvent?.headSha;

  if (channel.kind === "gitea_pr_review") {
    if (!baseUrl || !owner || !repo || pullNumber === undefined) {
      return undefined;
    }

    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl,
      ...(resolvedToken ? { token: resolvedToken } : {}),
      owner,
      repo,
      pullNumber,
      channelName: channel.name,
      ...(channelSeverityLabelPrefix ? { severityLabelPrefix: channelSeverityLabelPrefix } : {}),
      ...(channelSeverityLabelColors ? { severityLabelColors: channelSeverityLabelColors } : {}),
      ...(autoTag ? { autoTag } : {}),
      ...(reviewedTag ? { reviewedTag } : {}),
      ...(channelReviewMode ? { reviewMode: channelReviewMode } : {}),
      ...(channelReviewEvent ? { reviewEvent: channelReviewEvent } : {}),
      ...(channelReviewUpdateStrategy ? { reviewUpdateStrategy: channelReviewUpdateStrategy } : {}),
      ...(headSha ? { headSha } : {}),
      ...(resolutionAnalyzer ? { resolutionAnalyzer } : {}),
    });

    return {
      handlesRendering: true,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        return dispatcher.publishProblem(rendering.renderProblem(problem));
      },
      ...(dispatcher.publishSummary ? {
        async publishSummary(summary: string, problems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<DispatchResult> {
          const renderedProblems = (problems ?? []).map((problem) => rendering.renderProblem(problem));
          return dispatcher.publishSummary!(
            rendering.renderSummary(summary, renderedProblems, options?.title),
            renderedProblems,
            options?.reviewedFiles ? { reviewedFiles: options.reviewedFiles } : undefined,
          );
        },
      } : {}),
    };
  }

  if (channel.kind === "github_pr_review") {
    if (!owner || !repo || pullNumber === undefined) {
      return undefined;
    }

    const dispatcher = createGithubPullRequestReviewDispatcher({
      ...(githubApiBaseUrl ? { baseUrl: githubApiBaseUrl } : {}),
      ...(resolvedToken ? { token: resolvedToken } : {}),
      owner,
      repo,
      pullNumber,
      channelName: channel.name,
      ...(channelSeverityLabelPrefix ? { severityLabelPrefix: channelSeverityLabelPrefix } : {}),
      ...(channelSeverityLabelColors ? { severityLabelColors: channelSeverityLabelColors } : {}),
      ...(autoTag ? { autoTag } : {}),
      ...(reviewedTag ? { reviewedTag } : {}),
      ...(channelReviewMode ? { reviewMode: channelReviewMode } : {}),
      ...(channelReviewEvent ? { reviewEvent: channelReviewEvent } : {}),
      ...(channelReviewUpdateStrategy ? { reviewUpdateStrategy: channelReviewUpdateStrategy } : {}),
      ...(headSha ? { headSha } : {}),
      ...(resolutionAnalyzer ? { resolutionAnalyzer } : {}),
    });

    return {
      handlesRendering: true,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        return dispatcher.publishProblem(rendering.renderProblem(problem));
      },
      ...(dispatcher.publishSummary ? {
        async publishSummary(summary: string, problems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<DispatchResult> {
          const renderedProblems = (problems ?? []).map((problem) => rendering.renderProblem(problem));
          return dispatcher.publishSummary!(
            rendering.renderSummary(summary, renderedProblems, options?.title),
            renderedProblems,
            options?.reviewedFiles ? { reviewedFiles: options.reviewedFiles } : undefined,
          );
        },
      } : {}),
    };
  }

  if (channel.kind === "github_issue") {
    if (!owner || !repo || pullNumber === undefined) {
      return undefined;
    }

    const dispatcher = createGithubIssueDispatcher({
      ...(githubApiBaseUrl ? { baseUrl: githubApiBaseUrl } : {}),
      ...(resolvedToken ? { token: resolvedToken } : {}),
      owner,
      repo,
      issueNumber: pullNumber,
      channelName: channel.name,
      ...(autoTag ? { autoTag } : {}),
      ...(reviewedTag ? { reviewedTag } : {}),
    });

    const problems: ReviewProblem[] = [];
    return {
      handlesRendering: true,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        problems.push(rendering.renderProblem(problem));
        return { channel: channel.name, status: "published", raw: {} };
      },
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<DispatchResult> {
        const renderedProblems = (summaryProblems ?? problems).map((problem) => rendering.renderProblem(problem));
        return dispatcher.publishAggregatedProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems, options?.title),
        );
      },
    };
  }

  if (channel.kind === "github_problem_issue") {
    if (!owner || !repo) {
      return undefined;
    }

    const resolvedAction = readString(channelConfig, "resolved_action", "resolvedAction");
    const markerPrefix = readString(channelConfig, "marker_prefix", "markerPrefix");
    const markerLabel = readString(channelConfig, "marker_label", "markerLabel");
    const issueMode = readString(channelConfig, "issue_mode", "issueMode");
    const resolvedIssueMode = issueMode === "consolidated" || issueMode === "per_problem" || issueMode === "per_commit"
      ? issueMode
      : undefined;
    const channelLabels = Array.isArray(channelConfig.labels) && channelConfig.labels.every((value) => typeof value === "string")
      ? channelConfig.labels as readonly string[]
      : undefined;
    const assignCommitter = readBoolean(channelConfig, "assign_committer", "assignCommitter");
    const ownersFile = readString(channelConfig, "owners_file", "ownersFile");
    const addOwnersAsAssignees = readBoolean(channelConfig, "add_owners_as_assignees", "addOwnersAsAssignees");
    const notifyFeishuConfig = isPlainObject(channelConfig.notify_feishu)
      ? channelConfig.notify_feishu as Record<string, unknown>
      : undefined;
    const notifyFeishuWebhookUrl = notifyFeishuConfig ? resolveSecretField(notifyFeishuConfig, "webhook_url", "webhook_url_env") : undefined;
    const notifyFeishuSecret = notifyFeishuConfig ? resolveSecretField(notifyFeishuConfig, "secret", "secret_env") : undefined;
    const authorResolution = buildAuthorResolutionOptions(config, channel);
    const authorAssignment = resolveAuthorAssignment(reviewEvent ?? {}, authorResolution);
    const committerUsername = authorAssignment.username;
    const fallbackCommitterUsername = authorAssignment.fallbackUsername;
    const ref = reviewEvent?.headSha ?? "main";

    const dispatcher = createGithubProblemIssueDispatcher({
      ...(githubApiBaseUrl ? { baseUrl: githubApiBaseUrl } : {}),
      ...(resolvedToken ? { token: resolvedToken } : {}),
      owner,
      repo,
      channelName: channel.name,
      ...(markerPrefix ? { markerPrefix } : {}),
      ...(markerLabel ? { markerLabel } : {}),
      ...(channelLabels ? { labels: channelLabels } : {}),
      ...(resolvedIssueMode ? { issueMode: resolvedIssueMode } : {}),
      ...(resolvedAction === "none" || resolvedAction === "close" || resolvedAction === "mark_resolved" ? { resolvedAction } : {}),
      ...(problemIssueMaxRecentIssues !== undefined ? { maxRecentIssues: problemIssueMaxRecentIssues } : {}),
      ...(authorAssignment.blocked ? { assignCommitter: false } : assignCommitter !== undefined ? { assignCommitter } : {}),
      ...(committerUsername ? { committerUsername } : {}),
      ...(fallbackCommitterUsername ? { fallbackCommitterUsername } : {}),
      ...(ownersFile ? { ownersFilePath: ownersFile } : {}),
      ...(addOwnersAsAssignees !== undefined ? { addOwnersAsAssignees } : {}),
      ...(channelSeverityLabelPrefix ? { severityLabelPrefix: channelSeverityLabelPrefix } : {}),
      ...(channelSeverityLabelColors ? { severityLabelColors: channelSeverityLabelColors } : {}),
      ...(notifyFeishuWebhookUrl ? { notifyFeishu: { webhookUrl: notifyFeishuWebhookUrl, ...(notifyFeishuSecret ? { secret: notifyFeishuSecret } : {}) } } : {}),
      ...(autoTag ? { autoTag } : {}),
      ...(reviewedTag ? { reviewedTag } : {}),
      ...(resolutionAnalyzer ? { resolutionAnalyzer } : {}),
      ref,
      ...(reviewEvent?.headSha ? { headSha: reviewEvent.headSha } : {}),
      ...(reviewEvent?.targetKind ? { targetKind: reviewEvent.targetKind } : {}),
      ...(pullNumber !== undefined ? { pullNumber } : {}),
      ...(reviewEvent?.branch ? { branch: reviewEvent.branch } : {}),
    });

    let reconciled = false;
    return {
      handlesRendering: true,
      publishesProblems: false,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(): Promise<DispatchResult> {
        return { channel: channel.name, status: "published", raw: { collected: true } };
      },
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<readonly DispatchResult[]> {
        if (options?.skipReconcile) {
          return [];
        }
        if (reconciled) {
          return [];
        }
        reconciled = true;
        const renderedProblems = (summaryProblems ?? []).map((problem) => rendering.renderProblem(problem));
        return dispatcher.reconcileProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems, options?.title),
          options?.reviewedFiles ? { reviewedFiles: options.reviewedFiles } : undefined,
        );
      },
    };
  }

  if (channel.kind === "gitlab_mr_review") {
    const projectId = channelConfig.project_id ?? channelConfig.projectId ?? repoRef;
    const mergeRequestIid = readNumber(channelConfig, "merge_request_iid", "mergeRequestIid") ?? pullNumber;
    if ((typeof projectId !== "string" && typeof projectId !== "number") || mergeRequestIid === undefined) {
      return undefined;
    }

    const dispatcher = createGitlabMergeRequestReviewDispatcher({
      ...(baseUrl ? { baseUrl } : {}),
      ...(resolvedToken ? { token: resolvedToken } : {}),
      projectId,
      mergeRequestIid,
      ...(reviewEvent?.baseSha ? { baseSha: reviewEvent.baseSha } : {}),
      ...(reviewEvent?.baseSha ? { startSha: reviewEvent.baseSha } : {}),
      ...(reviewEvent?.headSha ? { headSha: reviewEvent.headSha } : {}),
      channelName: channel.name,
      ...(channelSeverityLabelPrefix ? { severityLabelPrefix: channelSeverityLabelPrefix } : {}),
      ...(channelSeverityLabelColors ? { severityLabelColors: channelSeverityLabelColors } : {}),
      ...(autoTag ? { autoTag } : {}),
      ...(reviewedTag ? { reviewedTag } : {}),
    });

    return {
      handlesRendering: true,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        return dispatcher.publishProblem(rendering.renderProblem(problem));
      },
      ...(dispatcher.publishSummary ? {
        async publishSummary(summary: string, problems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<DispatchResult> {
          const renderedProblems = (problems ?? []).map((problem) => rendering.renderProblem(problem));
          return dispatcher.publishSummary!(rendering.renderSummary(summary, renderedProblems, options?.title), renderedProblems);
        },
      } : {}),
    };
  }

  if (channel.kind === "gitea_issue") {
    if (!baseUrl || !owner || !repo || pullNumber === undefined) {
      return undefined;
    }

    const dispatcher = createGiteaIssueDispatcher({
      baseUrl,
      ...(resolvedToken ? { token: resolvedToken } : {}),
      owner,
      repo,
      indexNumber: pullNumber,
      channelName: channel.name,
      ...(autoTag ? { autoTag } : {}),
      ...(reviewedTag ? { reviewedTag } : {}),
    });

    const problems: ReviewProblem[] = [];
    return {
      handlesRendering: true,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        problems.push(rendering.renderProblem(problem));
        return { channel: channel.name, status: "published", raw: {} };
      },
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<DispatchResult> {
        const renderedProblems = (summaryProblems ?? problems).map((problem) => rendering.renderProblem(problem));
        return dispatcher.publishAggregatedProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems, options?.title),
        );
      },
    };
  }

  if (channel.kind === "gitea_problem_issue") {
    if (!baseUrl || !owner || !repo) {
      return undefined;
    }

    const resolvedAction = readString(channelConfig, "resolved_action", "resolvedAction");
    const markerPrefix = readString(channelConfig, "marker_prefix", "markerPrefix");
    const markerLabel = readString(channelConfig, "marker_label", "markerLabel");
    const issueMode = readString(channelConfig, "issue_mode", "issueMode");
    const resolvedIssueMode = issueMode === "consolidated" || issueMode === "per_problem" || issueMode === "per_commit"
      ? issueMode
      : undefined;
    const labelIds = Array.isArray(channelConfig.label_ids) && channelConfig.label_ids.every((value) => typeof value === "number")
      ? channelConfig.label_ids as readonly number[]
      : undefined;
    const assignCommitter = readBoolean(channelConfig, "assign_committer", "assignCommitter");
    const ownersFile = readString(channelConfig, "owners_file", "ownersFile");
    const addOwnersAsAssignees = readBoolean(channelConfig, "add_owners_as_assignees", "addOwnersAsAssignees");
    const notifyFeishuConfig = isPlainObject(channelConfig.notify_feishu)
      ? channelConfig.notify_feishu as Record<string, unknown>
      : undefined;
    const notifyFeishuWebhookUrl = notifyFeishuConfig ? resolveSecretField(notifyFeishuConfig, "webhook_url", "webhook_url_env") : undefined;
    const notifyFeishuSecret = notifyFeishuConfig ? resolveSecretField(notifyFeishuConfig, "secret", "secret_env") : undefined;
    const authorResolution = buildAuthorResolutionOptions(config, channel);
    const authorAssignment = resolveAuthorAssignment(reviewEvent ?? {}, authorResolution);
    const committerUsername = authorAssignment.username;
    const fallbackCommitterUsername = authorAssignment.fallbackUsername;
    const ref = reviewEvent?.headSha ?? "main";

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl,
      ...(resolvedToken ? { token: resolvedToken } : {}),
      owner,
      repo,
      channelName: channel.name,
      ...(markerPrefix ? { markerPrefix } : {}),
      ...(markerLabel ? { markerLabel } : {}),
      ...(labelIds ? { labelIds } : {}),
      ...(resolvedIssueMode ? { issueMode: resolvedIssueMode } : {}),
      ...(resolvedAction === "none" || resolvedAction === "close" || resolvedAction === "mark_resolved" || resolvedAction === "delete" ? { resolvedAction } : {}),
      ...(problemIssueMaxRecentIssues !== undefined ? { maxRecentIssues: problemIssueMaxRecentIssues } : {}),
      ...(authorAssignment.blocked ? { assignCommitter: false } : assignCommitter !== undefined ? { assignCommitter } : {}),
      ...(committerUsername ? { committerUsername } : {}),
      ...(fallbackCommitterUsername ? { fallbackCommitterUsername } : {}),
      ...(ownersFile ? { ownersFilePath: ownersFile } : {}),
      ...(addOwnersAsAssignees !== undefined ? { addOwnersAsAssignees } : {}),
      ...(channelSeverityLabelPrefix ? { severityLabelPrefix: channelSeverityLabelPrefix } : {}),
      ...(channelSeverityLabelColors ? { severityLabelColors: channelSeverityLabelColors } : {}),
      ...(notifyFeishuWebhookUrl ? { notifyFeishu: { webhookUrl: notifyFeishuWebhookUrl, ...(notifyFeishuSecret ? { secret: notifyFeishuSecret } : {}) } } : {}),
      ...(autoTag ? { autoTag } : {}),
      ...(reviewedTag ? { reviewedTag } : {}),
      ...(resolutionAnalyzer ? { resolutionAnalyzer } : {}),
      ref,
      ...(reviewEvent?.headSha ? { headSha: reviewEvent.headSha } : {}),
      ...(reviewEvent?.targetKind ? { targetKind: reviewEvent.targetKind } : {}),
      ...(pullNumber !== undefined ? { pullNumber } : {}),
      ...(reviewEvent?.branch ? { branch: reviewEvent.branch } : {}),
    });

    let reconciled = false;
    return {
      handlesRendering: true,
      publishesProblems: false,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(): Promise<DispatchResult> {
        return { channel: channel.name, status: "published", raw: { collected: true } };
      },
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<readonly DispatchResult[]> {
        if (options?.skipReconcile) {
          return [];
        }
        if (reconciled) {
          return [];
        }
        reconciled = true;
        const renderedProblems = (summaryProblems ?? []).map((problem) => rendering.renderProblem(problem));
        return dispatcher.reconcileProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems, options?.title),
          options?.reviewedFiles ? { reviewedFiles: options.reviewedFiles } : undefined,
        );
      },
    };
  }

  if (channel.kind === "feishu_bot") {
    const webhookUrl = resolveSecretField(channelConfig, "webhook_url", "webhook_url_env");
    if (!webhookUrl) {
      return undefined;
    }

    const feishuSecret = resolveSecretField(channelConfig, "secret", "secret_env");
    const dispatcher = createFeishuBotDispatcher({
      webhookUrl,
      ...(feishuSecret !== undefined ? { secret: feishuSecret } : {}),
      channelName: channel.name,
    });

    const problems: ReviewProblem[] = [];
    return {
      handlesRendering: true,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        problems.push(rendering.renderProblem(problem));
        return { channel: channel.name, status: "published", raw: {} };
      },
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<DispatchResult> {
        const renderedProblems = (summaryProblems ?? problems).map((problem) => rendering.renderProblem(problem));
        return dispatcher.publishAggregatedProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems, options?.title),
          rendering.mentionText || undefined,
        );
      },
    };
  }

  if (channel.kind === "wecom_bot") {
    const webhookUrl = resolveSecretField(channelConfig, "webhook_url", "webhook_url_env");
    if (!webhookUrl) {
      return undefined;
    }

    const dispatcher = createWeComBotDispatcher({
      webhookUrl,
      channelName: channel.name,
      ...(channelConfig.mentioned_mobile_list
        ? { mentionedMobileList: channelConfig.mentioned_mobile_list as readonly string[] }
        : {}),
    });

    const problems: ReviewProblem[] = [];
    return {
      handlesRendering: true,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        problems.push(rendering.renderProblem(problem));
        return { channel: channel.name, status: "published", raw: {} };
      },
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[], options?: ReviewSummaryPublishOptions): Promise<DispatchResult> {
        const renderedProblems = (summaryProblems ?? problems).map((problem) => rendering.renderProblem(problem));
        return dispatcher.publishAggregatedProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems, options?.title),
          rendering.mentionText || undefined,
        );
      },
    };
  }

  return undefined;
}

function routeMatchesEvent(
  route: {
    readonly match?: {
      readonly trigger?: string | undefined;
      readonly target_kind?: string | undefined;
    } | undefined;
  },
  context: ReviewOrchestrationContext,
): boolean {
  const match = route.match;
  if (!match) {
    return true;
  }

  if (match.trigger && match.trigger !== context.reviewEvent.triggerName) {
    return false;
  }

  if (match.target_kind && match.target_kind !== context.reviewEvent.targetKind) {
    return false;
  }

  return true;
}

function uniqueChannelNames(channelNames: readonly string[]): readonly string[] {
  return [...new Set(channelNames)];
}

function resolveOutputChannelNames(
  config: AppConfig,
  context: ReviewOrchestrationContext,
  key: OutputRouteChannelKey,
): readonly string[] {
  const graph = compileExecutionGraph(config as EffectiveConfigV2);
  if (graph.mode === "v2") {
    const event = context.reviewEvent;
    const routingEvent = { ...event, triggerName: event.triggerName };
    return resolveOutputChannelsForEvent(config as EffectiveConfigV2, graph, routingEvent,
      event.workspaceId, key, executionRoute(config, event));
  }
  // Route rules are more specific (match by trigger + target_kind) and should
  // override workspace defaults for events like push/commit that need different
  // channels than pull_request (e.g. problem_issue instead of pr_review).
  const routeChannels = config.outputs.routes?.rules
    .find((route) => routeMatchesEvent(route, context))
    ?.[key];
  if (routeChannels && routeChannels.length > 0) {
    return uniqueChannelNames(routeChannels);
  }

  const workspace = config.workspaces.instances[context.reviewEvent.workspaceId];
  const workspaceChannels = workspace?.outputs?.[key];
  if (workspaceChannels && workspaceChannels.length > 0) {
    return uniqueChannelNames(workspaceChannels);
  }

  const defaultChannels = config.outputs.routes?.default?.[key];
  if (defaultChannels && defaultChannels.length > 0) {
    return uniqueChannelNames(defaultChannels);
  }

  if (key === "line_comments") {
    const fallback = config.outputs.channels.find((c) =>
      c.kind === "gitea_pr_review" || c.kind === "github_pr_review" || c.kind === "gitlab_mr_review"
    );
    return fallback ? [fallback.name] : [];
  }

  return [];
}

/** Re-resolve only inside the task's immutable generation; never the live head. */
function executionRoute(config: AppConfig, event: ReviewEvent): CompiledRoutingRule | undefined {
  const graph = compileExecutionGraph(config as EffectiveConfigV2);
  if (graph.mode === "legacy") return undefined;
  const selected = resolveRouteForEvent(graph, event);
  if (selected.status === "none") throw new ConfigError("no_route", "No route matches the accepted event.");
  if (selected.rule.workspace !== event.workspaceId) {
    throw new ConfigError("routing_invalid", "Accepted workspace differs from the pinned route.");
  }
  return selected.rule;
}

async function resolveGithubAppInstallationToken(
  config: AppConfig,
  appTokenServices: ReadonlyMap<string, GithubAppTokenService> | undefined,
  triggerName: string | undefined,
  repoRef: string | undefined,
): Promise<string | undefined> {
  if (!triggerName || !repoRef || !appTokenServices) {
    return undefined;
  }

  const service = appTokenServices.get(triggerName);
  if (!service) {
    return undefined;
  }

  const trigger = config.triggers.find((t) => t.name === triggerName && t.kind === "github");
  if (!trigger) {
    return undefined;
  }

  const triggerConfig = trigger as Record<string, unknown>;
  if (!isPlainObject(triggerConfig.app)) {
    return undefined;
  }

  const parsed = parseRepoRef(repoRef);
  if (!parsed) {
    return undefined;
  }

  return service.getInstallationTokenForRepo(parsed.owner, parsed.repo);
}

async function resolveTriggerTokenForContext(
  config: AppConfig,
  context: ReviewOrchestrationContext,
  appTokenServices?: ReadonlyMap<string, GithubAppTokenService>,
): Promise<string | undefined> {
  return resolveGithubAppInstallationToken(
    config,
    appTokenServices,
    context.reviewEvent.triggerName,
    context.reviewEvent.repoRef,
  );
}

export function createOutputPublisherResolverFromConfig(
  config: AppConfig,
  options: OutputPublisherConfigOptions = {},
): ReviewOutputPublisherResolver {
  return async (context, runtime) => {
    const pullNumber = extractPullNumber(context.payload, context.reviewEvent);
    const baseDir = options.baseDir ?? process.cwd();
    const tokenPromises = new Map<string, Promise<string | undefined>>();
    const channelToken = (name: string): Promise<string | undefined> => {
      const channel = config.outputs.channels.find(entry => entry.name === name);
      if (!channel?.kind.startsWith("github_") || channel.token_env !== undefined || channel.token !== undefined) return Promise.resolve(undefined);
      const eventTrigger = config.triggers.find(entry => entry.name === context.reviewEvent.triggerName && entry.kind === "github");
      const triggerName = readString(channel, "trigger") ?? eventTrigger?.name ?? config.triggers.find(entry => entry.kind === "github")?.name;
      const explicitOwner = readString(channel, "owner");
      const explicitRepo = readString(channel, "repo");
      const repoRef = explicitOwner && explicitRepo ? `${explicitOwner}/${explicitRepo}` : explicitRepo ??
        (triggerName ? resolveWorkspaceRepoRef(config, triggerName, context.reviewEvent.workspaceId) : undefined) ?? context.reviewEvent.repoRef;
      const key = JSON.stringify([triggerName, repoRef]);
      let token = tokenPromises.get(key);
      if (!token) {
        token = resolveGithubAppInstallationToken(config, options.appTokenServices, triggerName, repoRef);
        tokenPromises.set(key, token);
      }
      return token;
    };
    const resolutionAnalyzer = options.resolutionAnalyzerFactory?.(
      runtime?.sourceRoot ?? baseDir,
      context,
    );
    const linePublishers = (await Promise.all(resolveOutputChannelNames(config, context, "line_comments")
      .map(async (name): Promise<OutputPublisherEntry | undefined> => {
        const publisher = createOutputPublisherFromConfig(
          config,
          name,
          pullNumber,
          context.reviewEvent.workspaceId,
          context.reviewEvent,
          baseDir,
          await channelToken(name),
          resolutionAnalyzer,
        );
        return publisher ? { name, publisher } : undefined;
      })))
      .filter((entry): entry is OutputPublisherEntry => Boolean(entry));
    const summaryPublishers = (await Promise.all(resolveOutputChannelNames(config, context, "summary")
      .map(async (name): Promise<OutputPublisherEntry | undefined> => {
        const publisher = createOutputPublisherFromConfig(
          config,
          name,
          pullNumber,
          context.reviewEvent.workspaceId,
          context.reviewEvent,
          baseDir,
          await channelToken(name),
          resolutionAnalyzer,
        );
        return publisher ? { name, publisher } : undefined;
      })))
      .filter((entry): entry is OutputPublisherEntry => Boolean(entry));

    return createCompositeOutputPublisher(linePublishers, summaryPublishers);
  };
}

function resolveWorkspaceRepoRef(
  config: AppConfig,
  triggerName: string,
  workspaceId?: string,
): string | undefined {
  if (workspaceId) {
    const instance = config.workspaces.instances[workspaceId];
    return instance?.source_repo?.trigger === triggerName ? instance.source_repo.repo : undefined;
  }

  for (const instance of Object.values(config.workspaces.instances)) {
    if (instance.source_repo?.trigger === triggerName) {
      return instance.source_repo.repo;
    }
  }

  return undefined;
}

function parseRepoRef(repoRef: string | undefined): { owner: string; repo: string } | undefined {
  if (!repoRef) {
    return undefined;
  }

  const [owner, repo, ...extra] = repoRef.split("/");
  if (!owner || !repo || extra.length > 0) {
    return undefined;
  }

  return { owner, repo };
}

function isGitRemoteTriggerKind(kind: string): boolean {
  return kind === "gitea" || kind === "forgejo" || kind === "github" || kind === "gitlab";
}

function buildGitRemoteUrl(baseUrl: string | undefined, repoRef: string | undefined): string | undefined {
  if (!baseUrl || !repoRef) {
    return undefined;
  }

  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, "");
  const normalizedRepoRef = repoRef.replace(/^\/+|\/+$/gu, "");
  if (!normalizedBaseUrl || !normalizedRepoRef) {
    return undefined;
  }

  return `${normalizedBaseUrl}/${normalizedRepoRef}.git`;
}

export function createVcsAdapterFromConfig(
  config: AppConfig,
  repositoryDir: string,
  triggerName?: string,
  repoRef?: string,
  options?: {
    readonly resolvedToken?: string;
    readonly tokenProvider?: () => Promise<string | undefined> | string | undefined;
    readonly alwaysFetch?: boolean;
  },
): GitVcsAdapter | P4VcsAdapter | SvnVcsAdapter {
  const p4Trigger = triggerName
    ? config.triggers.find((t) => t.name === triggerName && t.kind === "p4")
    : config.triggers.find((t) => t.kind === "p4");
  if (p4Trigger) {
    const triggerConfig = p4Trigger as Record<string, unknown>;
    const port = triggerConfig.port as string | undefined;
    const workspace = triggerConfig.workspace as string | undefined;
    const depot = triggerConfig.depot_path as string | undefined;
    const streams = triggerConfig.streams as string[] | undefined;
    const watchPath = triggerConfig.watch_path as string[] | undefined;
    const includeCrFile = triggerConfig.include_cr_file as string[] | undefined;
    const excludeCrFile = triggerConfig.exclude_cr_file as string[] | undefined;

    const password = resolveSecretField(triggerConfig, "password", "password_env")
      ?? resolveSecretField(triggerConfig, "ticket", "ticket_env");
    const user = resolveSecretField(triggerConfig, "user", "user_env");

    // Scope binding: the event repoRef is the authoritative depot scope
    // (routing-derived receipts carry the per-scope depot path; legacy
    // payloads may override depot_path). Configured depot/streams[0] is only
    // the fallback when the event carries no usable scope.
    const scopeDepot = repoRef !== undefined && repoRef.startsWith("//") ? repoRef : undefined;
    const boundDepot = scopeDepot ?? streams?.[0] ?? depot;
    return createP4VcsAdapter({
      repositoryDir: resolve(repositoryDir),
      ...(port ? { port } : {}),
      ...(user ? { user } : {}),
      ...(password ? { password } : {}),
      ...(workspace ? { workspace } : {}),
      ...(boundDepot ? { depot: boundDepot } : {}),
      ...(watchPath ? { watchPath } : {}),
      ...(includeCrFile ? { includeCrFile } : {}),
      ...(excludeCrFile ? { excludeCrFile } : {}),
    });
  }

  const svnTrigger = triggerName
    ? config.triggers.find((t) => t.name === triggerName && t.kind === "svn")
    : config.triggers.find((t) => t.kind === "svn");
  if (svnTrigger) {
    const triggerConfig = svnTrigger as Record<string, unknown>;
    const repositoryUrl = typeof triggerConfig.repository_url === "string"
      ? triggerConfig.repository_url.trim()
      : undefined;
    const username = resolveSecretField(triggerConfig, "username", "username_env")
      ?? resolveSecretField(triggerConfig, "user", "user_env");
    const password = resolveSecretField(triggerConfig, "password", "password_env");
    const watchPath = triggerConfig.watch_path as string[] | undefined;
    const includeCrFile = triggerConfig.include_cr_file as string[] | undefined;
    const excludeCrFile = triggerConfig.exclude_cr_file as string[] | undefined;
    const trustServerCert = triggerConfig.trust_server_cert === true;

    // Scope binding: routing-derived svn events carry the project-root
    // scope URL (repository_url + prefix) as repoRef; bind the adapter to
    // it so log/diff run against the project scope, not the repo root.
    const scopeUrl =
      repoRef !== undefined && repositoryUrl !== undefined &&
      (repoRef === repositoryUrl || repoRef.startsWith(`${repositoryUrl.replace(/\/+$/u, "")}/`))
        ? repoRef
        : undefined;
    return createSvnVcsAdapter({
      repositoryDir: resolve(repositoryDir),
      ...(scopeUrl !== undefined
        ? { repositoryUrl: scopeUrl }
        : repositoryUrl !== undefined
          ? { repositoryUrl }
          : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(trustServerCert ? { trustServerCert } : {}),
      ...(watchPath ? { watchPath } : {}),
      ...(includeCrFile ? { includeCrFile } : {}),
      ...(excludeCrFile ? { excludeCrFile } : {}),
    });
  }

  const gitTrigger = triggerName
    ? config.triggers.find((t) => t.name === triggerName && isGitRemoteTriggerKind(t.kind))
    : undefined;
  const gitTriggerConfig = gitTrigger as Record<string, unknown> | undefined;
  const gitTriggerKind = gitTriggerConfig?.kind as string | undefined;
  const triggerBaseUrl = gitTriggerConfig?.base_url as string | undefined;
  const effectiveBaseUrl = triggerBaseUrl
    ?? (gitTriggerKind === "github" ? "https://github.com" : undefined);
  const remoteUrl = buildGitRemoteUrl(effectiveBaseUrl, repoRef);
  const token = gitTriggerConfig !== undefined
    ? resolveSecretField(gitTriggerConfig, "token", "token_env")
    : undefined;
  const resolvedGitToken = token ?? options?.resolvedToken;

  return createGitVcsAdapter({
    repositoryDir: resolve(repositoryDir),
    allowDeepen: config.review.git?.allow_deepen ?? false,
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(resolvedGitToken ? { token: resolvedGitToken } : {}),
    ...(options?.tokenProvider ? { tokenProvider: options.tokenProvider } : {}),
    ...(options?.alwaysFetch ? { alwaysFetch: true } : {}),
  });
}

export function buildSourceRootResolver(
  baseDir: string,
): (reviewEvent: ReviewEvent) => string {
  return (reviewEvent: ReviewEvent) => {
    const repoRef = reviewEvent.repoRef.replace(/[/:]/g, "_");
    return resolve(baseDir, "workspaces", reviewEvent.workspaceId, "source", repoRef);
  };
}

function toGatewayProviders(
  providers: AppConfig["llm"]["providers"],
): readonly LlmGatewayProviderConfig[] {
  return providers.map((p) => ({
    id: p.id,
    kind: p.kind as ModelProviderKind,
    ...resolveModelProviderFields(p),
  }));
}

function toGatewayRetry(config: AppConfig["llm"]["retry"]): LlmGatewayRetryConfig | undefined {
  if (!config) return undefined;
  return {
    ...(config.max_attempts !== undefined ? { maxAttempts: config.max_attempts } : {}),
    ...(config.respect_retry_after !== undefined ? { respectRetryAfter: config.respect_retry_after } : {}),
    ...(config.backoff
      ? {
          backoff: {
            kind: config.backoff.kind,
            ...(config.backoff.base_ms !== undefined ? { baseMs: config.backoff.base_ms } : {}),
            ...(config.backoff.max_ms !== undefined ? { maxMs: config.backoff.max_ms } : {}),
            ...(config.backoff.jitter !== undefined ? { jitter: config.backoff.jitter } : {}),
          },
        }
      : {}),
    ...(config.give_up_after_seconds !== undefined ? { giveUpAfterSeconds: config.give_up_after_seconds } : {}),
  };
}

function toGatewayBudget(config: AppConfig["llm"]["budget"]): LlmGatewayBudgetConfig | undefined {
  if (!config) return undefined;
  return {
    ...(config.per_run_usd !== undefined ? { perRunUsd: config.per_run_usd } : {}),
    ...(config.per_repo_daily_usd !== undefined ? { perRepoDailyUsd: config.per_repo_daily_usd } : {}),
  };
}

function toGatewayPerProviderOverrides(
  overrides: AppConfig["llm"]["per_provider_overrides"],
): Readonly<Record<string, LlmGatewayPerProviderOverride>> | undefined {
  if (!overrides) return undefined;

  const result: Record<string, LlmGatewayPerProviderOverride> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!value) continue;

    const entry: LlmGatewayPerProviderOverride = {
      ...(value.max_attempts !== undefined ? { maxAttempts: value.max_attempts } : {}),
      ...(value.give_up_after_seconds !== undefined ? { giveUpAfterSeconds: value.give_up_after_seconds } : {}),
    };

    if (Object.keys(entry).length > 0) {
      result[key] = entry;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function toGatewayFallbackChain(
  chain: LlmModelChain,
): readonly LlmGatewayFallbackEntry[] {
  return chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    role: entry.role,
  }));
}

export function normalizeModelCatalogOverrides(
  raw: Readonly<Record<string, Record<string, unknown>>>,
): Readonly<Record<string, ModelCatalogOverrideFields>> {
  const keyMap: Readonly<Record<string, string>> = {
    ...MODEL_CATALOG_HINT_KEY_MAP,
    ...MODEL_CATALOG_FIELD_KEY_MAP,
  };
  const result: Record<string, ModelCatalogOverrideFields> = {};
  for (const [modelKey, fields] of Object.entries(raw)) {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      normalized[keyMap[key] ?? key] = value;
    }
    result[modelKey] = normalized as ModelCatalogOverrideFields;
  }
  return result;
}

function buildGatewayModelPricing(
  catalogService: ModelCatalogService,
  config: AppConfig,
): Record<string, ModelPricing> {
  const pricing: Record<string, ModelPricing> = {};
  const collect = (provider: AppConfig["llm"]["providers"][number], modelId: string): void => {
    const key = `${provider.id}/${modelId}`;
    if (pricing[key]) return;
    const enriched = catalogService.enrichModelSpec({
      providerKind: provider.kind as ModelProviderKind,
      providerId: provider.id,
      modelId,
      ...resolveModelProviderFields(provider),
    });
    const extracted = extractModelPricing(enriched);
    if (
      extracted.costInputPerMTok !== undefined ||
      extracted.costOutputPerMTok !== undefined ||
      extracted.costCacheReadPerMTok !== undefined ||
      extracted.costCacheWritePerMTok !== undefined
    ) {
      pricing[key] = extracted;
    }
  };
  for (const entry of Object.values(config.llm.model_chain).flat()) {
    const provider = config.llm.providers.find((p) => p.id === entry.provider);
    if (provider) {
      collect(provider, entry.model);
    }
  }
  return pricing;
}

function toCompressionConfig(compression: AppConfig["compression"]): CompressionConfig | undefined {
  if (!compression) return undefined;

  let perModelOverrides: Readonly<Record<string, { readonly triggerTokens?: number }>> | undefined;
  if (compression.per_model_overrides) {
    const entries: Record<string, { readonly triggerTokens?: number }> = {};
    for (const [key, value] of Object.entries(compression.per_model_overrides)) {
      if (value && typeof value === "object" && value.trigger_tokens !== undefined) {
        entries[key] = { triggerTokens: value.trigger_tokens };
      }
    }
    if (Object.keys(entries).length > 0) {
      perModelOverrides = entries;
    }
  }

  return {
    ...(compression.trigger_tokens !== undefined ? { triggerTokens: compression.trigger_tokens } : {}),
    ...(compression.max_input_ratio !== undefined ? { maxInputRatio: compression.max_input_ratio } : {}),
    ...(compression.keep_hunks_top_k !== undefined ? { keepHunksTopK: compression.keep_hunks_top_k } : {}),
    ...(compression.context_lines !== undefined ? { contextLines: compression.context_lines } : {}),
    ...(compression.summarize_model_role !== undefined ? { summarizeModelRole: compression.summarize_model_role } : {}),
    ...(perModelOverrides ? { perModelOverrides } : {}),
  };
}

function toDefaultCompressionConfig(model: ModelSpec): CompressionConfig {
  const contextWindow = model.contextWindow;
  const ratioLimit = contextWindow
    ? Math.max(8192, Math.floor(contextWindow * 0.6))
    : 131072;
  return {
    triggerTokens: Math.min(131072, ratioLimit),
    maxInputRatio: 0.6,
    keepHunksTopK: 30,
    contextLines: 5,
  };
}

function resolveSummarizeModelFromChain(config: AppConfig, chain: LlmModelChain): ModelSpec | undefined {
  const summarizeRole = config.compression?.summarize_model_role ?? "light";
  const providers = config.llm.providers;
  if (providers.length === 0) return undefined;

  const entry = chain.find((candidate) => candidate.role === summarizeRole) ?? chain[0];
  return entry ? resolveModelSpecFromChain(providers, [entry]) : undefined;
}

async function createAppTokenServices(config: AppConfig): Promise<Map<string, GithubAppTokenService>> {
  const services = new Map<string, GithubAppTokenService>();
  for (const trigger of config.triggers) {
    if (trigger.kind !== "github") {
      continue;
    }
    const triggerConfig = trigger as Record<string, unknown>;
    if (!isPlainObject(triggerConfig.app)) {
      continue;
    }
    try {
      const auth = await resolveGithubAppTriggerAuth(triggerConfig, resolveEnv);
      services.set(trigger.name, createGithubAppTokenService(auth));
    } catch (error) {
      throw new Error(
        `Failed to initialize GitHub App token service for trigger "${trigger.name}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return services;
}

/** Resources bootstrap opens and must release when a later build step fails. */
interface BootstrapOpenedResources {
  store: StoreDb | undefined;
  sessionStore: ConfigStore | undefined;
  configStore: ConfigStore | undefined;
  catalogBackend: ModelCatalogBackend | undefined;
  closeAutoCommit: (() => Promise<void>) | undefined;
}

/**
 * Expired-admin-session sweep cadence (P2). Session reads already treat
 * expired rows as absent, so the periodic sweep only bounds table growth.
 */
const ADMIN_SESSION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function logBootstrapCloseFailure(resource: string, error: unknown): void {
  console.warn(JSON.stringify({
    level: "warn",
    msg: "failed to release resource after bootstrap failure",
    resource,
    error: error instanceof Error ? error.message : String(error),
  }));
}

export async function bootstrapServerApp(options: BootstrapServerOptions): Promise<ServerAppOptions> {
  // A failure mid-build must not leak what earlier steps opened: release in
  // reverse creation order, then rethrow the original error.
  const opened: BootstrapOpenedResources = { store: undefined, sessionStore: undefined, configStore: undefined, catalogBackend: undefined, closeAutoCommit: undefined };
  try {
    return await bootstrapServerAppCore(options, opened);
  } catch (error) {
    if (opened.closeAutoCommit !== undefined) {
      await opened.closeAutoCommit().catch((closeError: unknown) => logBootstrapCloseFailure("autoCommit", closeError));
    }
    if (opened.sessionStore !== undefined) {
      await opened.sessionStore.close().catch((closeError: unknown) => logBootstrapCloseFailure("sessionStore", closeError));
    }
    if (opened.configStore !== undefined) {
      await opened.configStore.close().catch((closeError: unknown) => logBootstrapCloseFailure("configStore", closeError));
    }
    if (opened.catalogBackend?.close !== undefined) {
      await opened.catalogBackend.close().catch((closeError: unknown) => logBootstrapCloseFailure("catalogBackend", closeError));
    }
    if (opened.store !== undefined) {
      await closeStoreDb(opened.store).catch((closeError: unknown) => logBootstrapCloseFailure("store", closeError));
    }
    throw error;
  }
}

async function bootstrapServerAppCore(options: BootstrapServerOptions, opened: BootstrapOpenedResources): Promise<ServerAppOptions> {
  const { config, baseSystemPrompt, baseDir = process.cwd(), jobHandler } = options;

  // --- Runtime config manager (P4): immutable generations replace the
  // process-frozen config object. File-only mode keeps a single generation
  // exactly matching the pre-P4 behavior; database mode adopts the durable
  // head at startup (a broken revision stops bootstrap) and re-reads the
  // head at every admission boundary. The fallback covers hand-built test
  // configs that skip the schema parse.
  const configSources: AppConfig["config_sources"] = config.config_sources ?? {
    database: { enabled: false, backend: "storage", namespace: "default" },
    runtime: { refresh_interval_seconds: 5 },
  };
  let runtimeConfigStore: ConfigStore | undefined;
  if (configSources.database.enabled) {
    if (configSources.database.backend === "redis") {
      const urlEnv = config.storage.cache.redis?.url_env;
      const redisUrl = urlEnv ? resolveEnv(urlEnv) : undefined;
      if (!redisUrl) {
        throw new TypeError(
          "config_sources.database.backend 'redis' requires storage.cache.redis.url_env to resolve to a Redis URL.",
        );
      }
      runtimeConfigStore = await createRedisConfigStore({ connection: { url: redisUrl } });
    } else {
      runtimeConfigStore = await createConfigStoreFromDatabaseConfig(config.storage.database, resolveEnv);
    }
    opened.configStore = runtimeConfigStore;
  }
  const runtimeConfig = new RuntimeConfigManager({
    fileConfig: config,
    ...(options.configDocument
      ? { fileDocument: options.configDocument.document, fileDigest: options.configDocument.digest }
      : {}),
    ...(runtimeConfigStore ? { store: runtimeConfigStore } : {}),
    namespace: configSources.database.namespace,
    baseDir,
    ...(configSecretSealing ? { secretSealing: configSecretSealing } : {}),
  });
  if (runtimeConfigStore !== undefined) {
    await runtimeConfig.admission();
    await runtimeConfig.legacyImport();
    await runtimeConfig.heartbeat();
    // Background refresh only accelerates generation swaps; every admission
    // re-reads the durable head regardless (H15).
    const refreshTimer = setInterval(() => {
      void runtimeConfig.admission().finally(() => runtimeConfig.heartbeat()).catch((error: unknown) => {
        console.warn(JSON.stringify({
          level: "warn",
          msg: "runtime config background refresh failed; admissions will retry",
          error: admissionUnavailableReason(error),
        }));
      });
    }, configSources.runtime.refresh_interval_seconds * 1000);
    refreshTimer.unref();
    const closeConfigStore = runtimeConfigStore.close.bind(runtimeConfigStore);
    let configStoreClosed = false;
    runtimeConfigStore.close = async () => {
      if (configStoreClosed) return;
      configStoreClosed = true;
      clearInterval(refreshTimer);
      await runtimeConfig.drain();
      await closeConfigStore();
    };
  }
  const currentConfig = (): AppConfig => runtimeConfig.current().config;

  // Generation-scoped caches (H01/H02/H06): model routes and GitHub App token
  // services are rebuilt per generation, so a published revision swaps the
  // effective clients and trigger credentials on the next request.
  interface ModelRoute {
    readonly llm: ChatCompletionClient;
    readonly model: ModelSpec;
    readonly agentModelChain: readonly ModelSpec[];
    readonly compression?: CompressionConfig;
    readonly summarizeModel?: ModelSpec;
    readonly summarizeClient?: ChatCompletionClient;
  }
  const generationModelRoutes = new WeakMap<RuntimeConfigGeneration, Map<string, ModelRoute>>();
  const dailyBudgetTracker = new DailyBudgetTracker();
  const rateLimiter = createMultiProviderRateLimiter(() => runtimeConfig.withoutGeneration(() => runtimeConfig.current().config.queue.rate_limit?.per_provider_rps ?? {}));
  const generationAppTokenServices = new WeakMap<RuntimeConfigGeneration, Promise<ReadonlyMap<string, GithubAppTokenService>>>();
  const appTokenServicesFor = (generation: RuntimeConfigGeneration): Promise<ReadonlyMap<string, GithubAppTokenService>> => {
    let services = generationAppTokenServices.get(generation);
    if (services === undefined) {
      services = createAppTokenServices(generation.config);
      generationAppTokenServices.set(generation, services);
    }
    return services;
  };

  const workspaceRuntime = runtimeConfig.current().workspaceRuntime;

  // Fixed dispatcher sources (P4/H06): each admission re-resolves trigger
  // profiles from the CURRENT generation, so publishing a revision that
  // adds/removes/re-credentials triggers applies to the next request without
  // remounting any Hono route.
  const gitWebhookConfigs = async (kind: "gitea" | "forgejo" | "github" | "gitlab"): Promise<readonly VcsWebhookConfig[]> => {
    const generation = runtimeConfig.current();
    const tokenServices = await appTokenServicesFor(generation);
    if (kind === "gitea") return resolveGiteaLikeWebhookConfigs(generation.config, "gitea", undefined, tokenServices, generation.workspaceRuntime);
    if (kind === "forgejo") return resolveGiteaLikeWebhookConfigs(generation.config, "forgejo", undefined, tokenServices, generation.workspaceRuntime);
    if (kind === "github") return resolveGenericWebhookConfigs(generation.config, "github", undefined, tokenServices, generation.workspaceRuntime);
    return resolveGenericWebhookConfigs(generation.config, "gitlab", undefined, undefined, generation.workspaceRuntime);
  };
  const giteaConfigs = () => gitWebhookConfigs("gitea");
  const forgejoConfigs = () => gitWebhookConfigs("forgejo");
  const githubConfigs = () => gitWebhookConfigs("github");
  const gitlabConfigs = () => gitWebhookConfigs("gitlab");
  const p4Configs = () => resolveP4TriggerConfigs(runtimeConfig.current().config, undefined, runtimeConfig.current().workspaceRuntime);
  const svnConfigs = () => resolveSvnTriggerConfigs(runtimeConfig.current().config, undefined, runtimeConfig.current().workspaceRuntime);

  const adminAuthConfig = resolveAdminAuthConfig(config as unknown as Record<string, unknown>, resolveEnv);
  const catalogConfig = config.llm?.model_catalog;
  const catalogEnabled = !!catalogConfig?.enabled;
  const reflectionConfig = config.review.reflection;
  const catalogNeedsStore = catalogEnabled && catalogConfig!.cache.backend === "sqlite";
  const reflectionNeedsStore =
    !!reflectionConfig && reflectionConfig.enabled !== false && reflectionConfig.mode !== "off";
  const needsStore = !!adminAuthConfig || catalogNeedsStore || reflectionNeedsStore || runtimeConfig.mode === "database";

  let store: StoreDb | undefined;
  let sessionStore: ConfigStore | undefined;
  let observability: ObservabilityApiOptions | undefined;
  let liveRunRegistry: LiveRunRegistry | undefined;

  if (needsStore) {
    try {
      if (config.storage.database.kind === "postgres") {
        const pgConfig = (config.storage.database.postgres ?? {}) as Record<string, unknown>;
        const pgUrlEnv = typeof pgConfig.url_env === "string" ? pgConfig.url_env : undefined;
        const pgUrl = (pgUrlEnv ? resolveEnv(pgUrlEnv) : undefined)
          ?? (typeof pgConfig.url === "string" ? pgConfig.url : undefined);
        if (!pgUrl) {
          throw new TypeError(
            "storage.database.kind 'postgres' requires storage.database.postgres.url_env to resolve to a PostgreSQL URL.",
          );
        }
        store = await createStoreDb({ kind: "postgres", url: pgUrl, migrationMode: config.storage.database.migrate });
      } else {
        store = await createStoreDb({ kind: "sqlite", path: config.storage.database.sqlite.path, migrationMode: config.storage.database.migrate });
      }
    } catch (error) {
      if (!runtimeConfigStore || catalogNeedsStore || reflectionNeedsStore) throw error;
      console.warn(JSON.stringify({ level: "warn", msg: "Statistics store unavailable; configuration administration remains available." }));
    }
  }
  opened.store = store;

  const generationCatalogs = new WeakMap<RuntimeConfigGeneration, ModelCatalogService>();
  const catalogBackends = new Map<string, Promise<ModelCatalogBackend>>();
  let catalogBackendToClose: ModelCatalogBackend | undefined;
  await runtimeConfig.setGenerationPreparer(async generation => {
    const config = generation.config;
    const catalogConfig = config.llm.model_catalog;
    if (!catalogConfig?.enabled) return;
    let backendPromise = catalogBackends.get(catalogConfig.cache.backend);
    if (!backendPromise) {
      backendPromise = (async () => {
        if (catalogConfig.cache.backend === "sqlite") {
          if (!store) throw new ConfigError("store_unavailable", "The configured catalog requires an available statistics store.");
          return createStoreModelCatalogBackend(store);
        }
        if (catalogConfig.cache.backend === "memory") return createMemoryModelCatalogBackend();
        const backend = await createRedisModelCatalogBackend(toRedisModelCatalogBackendOptions(config));
        catalogBackendToClose = backend;
        opened.catalogBackend = backend;
        return backend;
      })().catch(error => { catalogBackends.delete(catalogConfig.cache.backend); throw error; });
      catalogBackends.set(catalogConfig.cache.backend, backendPromise);
    }
    const catalogBackend = await backendPromise;
    const providerHints: ModelCatalogProviderHint[] = config.llm.providers.map((provider) => {
      const raw = provider as Record<string, unknown>;
      const hint: { id: string; catalogProvider?: string; catalogId?: string } = { id: provider.id };
      if (typeof raw.catalog_provider === "string") hint.catalogProvider = raw.catalog_provider;
      if (typeof raw.catalog_id === "string") hint.catalogId = raw.catalog_id;
      return hint;
    });
    const catalogService = createModelCatalogService({
      enabled: true,
      sourceUrl: catalogConfig.source_url,
      refreshIntervalHours: catalogConfig.refresh_interval_hours,
      fetchTimeoutMs: catalogConfig.fetch_timeout_ms,
      offline: catalogConfig.offline,
      applyToModelSpec: catalogConfig.apply_to_model_spec,
      providerHints,
      overrides: normalizeModelCatalogOverrides(
        (catalogConfig.overrides ?? {}) as Record<string, Record<string, unknown>>,
      ),
      ...(catalogBackend ? { backend: catalogBackend } : {}),
      bundledSnapshotPath: getModelCatalogBundledSnapshotPath(),
      fetcher: createHttpModelCatalogFetcher(),
    });
    await catalogService.ensureRefreshed();
    // Capture every configured model before activation. Shared cache refreshes
    // must not change a pinned generation's later fallback or summary lookup.
    const specs = Object.values(config.llm.model_chain).flat().map(entry => resolveModelSpecFromChain(config.llm.providers, [entry]));
    if (config.llm.providers.length > 0) specs.push(resolveModelSpecFromChain(config.llm.providers, []));
    catalogService.freezeModels(specs);
    let models = Object.fromEntries(specs.map(spec => [JSON.stringify(spec), catalogService.enrichModelSpec(spec)]));
    if (runtimeConfigStore && generation.snapshotId) {
      const key = `catalog/${generation.snapshotId}`;
      let record = await runtimeConfigStore.readRuntimeState(configSources.database.namespace, key);
      if (!record) record = await runtimeConfigStore.writeRuntimeState({ namespace: configSources.database.namespace, key,
        expectedVersion: null, snapshotId: null, value: { models, hash: hashStructured([models]) }, now: Date.now() });
      record ??= await runtimeConfigStore.readRuntimeState(configSources.database.namespace, key);
      if (!isPlainObject(record?.value) || !isPlainObject(record.value.models) || record.value.hash !== hashStructured([record.value.models])) {
        throw new ConfigError("snapshot_invalid", "Pinned catalog metadata is corrupt.");
      }
      models = record.value.models as Record<string, ModelSpec>;
    }
    generationCatalogs.set(generation, { ...catalogService, enrichModelSpec(spec) {
      const frozen = models[JSON.stringify(spec)];
      if (!frozen) throw new ConfigError("snapshot_invalid", "Pinned catalog metadata does not contain the configured model.");
      return structuredClone(frozen);
    } });
  });

  function createModelRouteFor(generation: RuntimeConfigGeneration, name: string, workspaceId?: string): ModelRoute {
    const generationConfig = generation.config;
    const catalogService = generationCatalogs.get(generation);
    // Gateway retry/budget/per-provider overrides and pricing are
    // database-manageable globals: resolve them per generation so a
    // published revision actually changes the next task's client config.
    const retryConfig = toGatewayRetry(generationConfig.llm.retry);
    const budgetConfig = toGatewayBudget(generationConfig.llm.budget);
    const perProviderOverrides = toGatewayPerProviderOverrides(generationConfig.llm.per_provider_overrides);
    const gatewayModelPricing = catalogService
      ? buildGatewayModelPricing(catalogService, generationConfig)
      : undefined;
    const chain = resolveModelChain(generationConfig, name);
    const enrich = (candidate: ModelSpec): ModelSpec =>
      catalogService ? catalogService.enrichModelSpec(candidate) : candidate;
    const model = enrich(resolveModelSpecFromChain(generationConfig.llm.providers, chain));
    const agentModelChain = chain.length > 0
      ? chain.map((entry, index) => index === 0 ? model : enrich(resolveModelSpecFromChain(generationConfig.llm.providers, [entry])))
      : [model];
    const llm = createResilientChatClient({
      dailyBudgetTracker,
      beforeRequest: model => rateLimiter.acquireAsync(model.providerId),
      ...(workspaceId ? { workspaceId } : {}),
      clientFactory: createLlmClientFromModelSpec,
      providers: toGatewayProviders(generationConfig.llm.providers),
      fallbackChain: toGatewayFallbackChain(chain),
      ...(retryConfig ? { retry: retryConfig } : {}),
      ...(budgetConfig ? { budget: budgetConfig } : {}),
      ...(perProviderOverrides ? { perProviderOverrides } : {}),
      ...(gatewayModelPricing ? { modelPricing: gatewayModelPricing } : {}),
    });
    const summaryCandidate = resolveSummarizeModelFromChain(generationConfig, chain);
    const summarizeModel = summaryCandidate ? enrich(summaryCandidate) : undefined;
    return {
      llm,
      model,
      agentModelChain,
      compression: toCompressionConfig(generationConfig.compression) ?? toDefaultCompressionConfig(model),
      ...(summarizeModel ? { summarizeModel, summarizeClient: llm } : {}),
    };
  }
  function getModelRouteFor(generation: RuntimeConfigGeneration, name: string, workspaceId?: string): ModelRoute {
    let routes = generationModelRoutes.get(generation);
    if (!routes) {
      routes = new Map<string, ModelRoute>();
      generationModelRoutes.set(generation, routes);
    }
    const key = JSON.stringify([name, workspaceId ?? null]);
    let route = routes.get(key);
    if (!route) {
      route = createModelRouteFor(generation, name, workspaceId);
      routes.set(key, route);
    }
    return route;
  }
  const modelOptionsResolver = (workspaceId?: string) => {
    const generation = runtimeConfig.current();
    return getModelRouteFor(generation, resolveModelChainNames(generation.config, workspaceId).modelChain, workspaceId);
  };
  const triageModelOptionsResolver = (workspaceId?: string) => {
    const generation = runtimeConfig.current();
    const { llm, model } = getModelRouteFor(generation, resolveModelChainNames(generation.config, workspaceId).triageModelChain, workspaceId);
    return { llm, model };
  };
  const defaultRoute = modelOptionsResolver();
  // Resolve every configured workspace while the catalog backend is open.
  for (const workspaceId of Object.keys(config.workspaces.instances)) {
    modelOptionsResolver(workspaceId);
    triageModelOptionsResolver(workspaceId);
  }

  const sourceRootResolver = (reviewEvent: ReviewEvent): string =>
    runtimeConfig.current().workspaceRuntime.layoutForEvent(reviewEvent).sourceRoot;
  const runtimeDirsResolver = (reviewEvent: ReviewEvent) => runtimeConfig.current().workspaceRuntime.layoutForEvent(reviewEvent);
  const agentAdapter = resolveAgentAdapterFromConfig(config);

  if (adminAuthConfig && store) {
    // B09: soft-delete must judge liveness by the CURRENT generation's
    // definitions (dynamic config included) plus durable bindings, never by
    // a stale static snapshot that would bury wildcard-rule projects.
    const generationConfig = currentConfig();
    const activeProjectIdentities = buildActiveProjectIdentities(generationConfig);
    const matchDefinitionIds = Object.entries(generationConfig.workspaces.instances)
      .filter(([, instance]) => instance.match !== undefined)
      .map(([id]) => id);
    const bindingDefinitionIds = runtimeConfigStore !== undefined
      ? new Set((await runtimeConfigStore.listWorkspaceBindings(configSources.database.namespace))
          .filter((binding) => binding.state === "active")
          .map((binding) => binding.definitionId))
      : new Set<string>();
    const protectedIds = [...new Set([...matchDefinitionIds, ...bindingDefinitionIds])];
    await softDeleteMissingProjects(store, activeProjectIdentities, protectedIds);
    await hardDeleteExpiredProjects(store, config.storage.retention.deleted_project_grace_days);
  }

  if (adminAuthConfig) {
    liveRunRegistry = createLiveRunRegistry();
    // Durable admin sessions ride the deployment database (P2 item 97):
    // sha256-hashed tokens, TTL at read time, logout visible to every replica.
    // Dynamic-config mode shares the runtime config store handle instead of
    // opening a second connection to the same backend (P5 decoupling: admin
    // sessions and config management no longer require the stats store).
    sessionStore = runtimeConfigStore ?? await createConfigStoreFromDatabaseConfig(config.storage.database, resolveEnv);
    if (sessionStore !== runtimeConfigStore) {
      opened.sessionStore = sessionStore;
    }
    // Bounded sweep of expired session rows (P2): production never called
    // cleanupExpiredSessions, so admin_sessions grew without bound. The
    // timer is unref'd — it must never hold the process open — and closing
    // the store stops the sweep (close owns the lifecycle).
    const sessions = sessionStore;
    const sessionSweep = setInterval(() => {
      void cleanupExpiredSessions({ config: adminAuthConfig, sessions }).catch((error: unknown) => {
        console.warn(JSON.stringify({
          level: "warn",
          msg: "failed to sweep expired admin sessions",
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    }, ADMIN_SESSION_SWEEP_INTERVAL_MS);
    sessionSweep.unref();
    const closeSessions = sessionStore.close.bind(sessionStore);
    sessionStore.close = async () => {
      clearInterval(sessionSweep);
      await closeSessions();
    };
    observability = {
      ...(store ? { store } : {}),
      adminAuth: adminAuthConfig,
      sessionStore,
      liveRuns: liveRunRegistry,
    };
  }

  const reflectionEnabled = !!store;

  const webSearchFromConfig = (source: AppConfig) => ({
    enabled: source.agent.web_search?.enabled ?? false,
    ...(source.agent.web_search !== undefined && source.agent.web_search.providers.length > 0
      ? { providers: source.agent.web_search.providers }
      : {}),
    ...(source.agent.web_search !== undefined && source.agent.web_search.exclude.length > 0
      ? { exclude: source.agent.web_search.exclude }
      : {}),
    ...(source.agent.web_search?.timeout_seconds !== undefined
      ? { timeoutSeconds: source.agent.web_search.timeout_seconds }
      : {}),
    ...(source.agent.web_search !== undefined && Object.keys(source.agent.web_search.credentials).length > 0
      ? { credentials: source.agent.web_search.credentials }
      : {}),
    ...(source.agent.web_search?.searxng
      ? {
          searxng: {
            ...(source.agent.web_search.searxng.endpoint !== undefined
              ? { endpoint: source.agent.web_search.searxng.endpoint }
              : {}),
            ...(source.agent.web_search.searxng.categories !== undefined
              ? { categories: source.agent.web_search.searxng.categories }
              : {}),
            ...(source.agent.web_search.searxng.engines !== undefined
              ? { engines: source.agent.web_search.searxng.engines }
              : {}),
            ...(source.agent.web_search.searxng.language !== undefined
              ? { language: source.agent.web_search.searxng.language }
              : {}),
            ...(source.agent.web_search.searxng.safesearch !== undefined
              ? { safesearch: source.agent.web_search.searxng.safesearch }
              : {}),
          },
        }
      : {}),
  });

  const contextCompactionFromConfig = (source: AppConfig) => ({
    auto: source.agent.context_compaction?.auto ?? true,
    ...(source.agent.context_compaction?.threshold_percent !== undefined
      ? { thresholdPercent: source.agent.context_compaction.threshold_percent }
      : {}),
    ...(source.agent.context_compaction?.prune !== undefined
      ? { prune: source.agent.context_compaction.prune }
      : {}),
  });

  // P4 execution plan: one resolver, one pinned generation per task (H03–H08).
  // Everything config-derived that a run consumes resolves here — model route,
  // workspace-layer agent/sandbox selection, review policy (include/exclude/
  // max_files), output language, web search — so a mid-flight publish can
  // never mix generations inside one run.
  const resolveRunOptions = async (
    context: ReviewOrchestrationContext,
  ): Promise<Partial<ServerReviewOrchestrationOptions>> => {
    const generation = context.configSnapshotId === undefined ? await runtimeConfig.captureForTask() : await runtimeConfig.resolveGeneration(context.configSnapshotId);
    const generationConfig = generation.config;
    const workspaceId = context.reviewEvent.workspaceId;
    const analysis = resolveAnalysisSelection(generationConfig, workspaceId, executionRoute(generationConfig, context.reviewEvent));
    const reviewPolicy = analysis.review as AppConfig["review"];
    const executionConfig: AppConfig = { ...generationConfig, review: reviewPolicy,
      workspaces: { ...generationConfig.workspaces, instances: { ...generationConfig.workspaces.instances,
        [workspaceId]: { ...generationConfig.workspaces.instances[workspaceId], review: reviewPolicy } } } };
    const agentConfig = { ...generationConfig, agent: analysis.agent ?? generationConfig.agent };
    const selectedAgentAdapter = createConfiguredAgentAdapter(analysis.agent?.default ?? generationConfig.agent.default);
    const route = getModelRouteFor(generation, analysis.modelChain, reviewMemoryScope(context.reviewEvent));
    const tokenServices = await appTokenServicesFor(generation);
    const billingScope = reviewMemoryScope(context.reviewEvent);
    const budget = generationConfig.llm.budget;
    let runSpend = 0;
    const checkBudget = () => {
      if (budget?.per_run_usd && runSpend >= budget.per_run_usd) throw new LlmBudgetExceededError("per_run", budget.per_run_usd, runSpend);
      const dailySpend = dailyBudgetTracker.getDailySpend(billingScope);
      if (budget?.per_repo_daily_usd && dailySpend >= budget.per_repo_daily_usd) throw new LlmBudgetExceededError("per_repo_daily", budget.per_repo_daily_usd, dailySpend);
    };
    const runClient: ChatCompletionClient = {
      async complete(input) {
        checkBudget();
        const result = await route.llm.complete(input);
        const cost = (result as { estimatedCostUsd?: number }).estimatedCostUsd;
        if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) runSpend += cost;
        return result;
      },
    };
    return {
      ...route,
      llm: runClient,
      ...(route.summarizeModel ? { summarizeClient: runClient } : {}),
      beforeAgentCall: async model => { checkBudget(); await rateLimiter.acquireAsync(model.providerId); },
      onAgentCost: cost => {
        if (!Number.isFinite(cost) || cost <= 0) return;
        runSpend += cost;
        dailyBudgetTracker.recordSpend(billingScope, cost);
      },
      baseSystemPromptResolver: async (id: string) => {
        try {
          const workspace = resolveWorkspaceConfig(generationConfig, id);
          // A named prompts.system reference replaces the built-in base and
          // wins over the workspace prompt file (managed config over file).
          const promptName = workspace.prompt?.system_prompt;
          if (promptName !== undefined) {
            const document = generationConfig.prompts.system[promptName];
            if (document !== undefined) {
              return markdownDocumentBody(document);
            }
          }
          const promptFile = workspace.prompt?.base_system_prompt_file;
          if (promptFile) {
            return await loadSystemPromptTemplate(resolve(baseDir, promptFile));
          }
        } catch {
          // workspace not found or file not readable — fall back to global prompt
        }
        return undefined;
      },
      extraSystemPromptResolver: (id: string) => {
        try {
          const workspace = resolveWorkspaceConfig(generationConfig, id);
          const extraName = workspace.prompt?.extra_system_prompt;
          if (extraName !== undefined) {
            const document = generationConfig.prompts.system[extraName];
            if (document !== undefined) {
              return markdownDocumentBody(document);
            }
          }
        } catch {
          // workspace not found — no extra prompt
        }
        return undefined;
      },
      forceSkillsResolver: (id: string) => {
        try {
          return resolveWorkspaceConfig(generationConfig, id).prompt?.force_skills;
        } catch {
          return undefined;
        }
      },
      sourceRootResolver: (reviewEvent: ReviewEvent) => generation.workspaceRuntime.layoutForEvent(reviewEvent).sourceRoot,
      runtimeDirsResolver: (reviewEvent: ReviewEvent) => generation.workspaceRuntime.layoutForEvent(reviewEvent),
      vcs: createVcsAdapterFromConfig(executionConfig, baseDir),
      vcsFactory: async (sourceRoot: string, vcsContext: ReviewOrchestrationContext) => {
        const resolvedToken = await resolveTriggerTokenForContext(generationConfig, vcsContext, tokenServices);
        return createVcsAdapterFromConfig(
          executionConfig,
          sourceRoot,
          vcsContext.reviewEvent.triggerName,
          vcsContext.reviewEvent.repoRef,
          resolvedToken !== undefined ? { resolvedToken } : undefined,
        );
      },
      outputPublisherResolver: createOutputPublisherResolverFromConfig(executionConfig, {
        baseDir,
        appTokenServices: tokenServices,
        resolutionAnalyzerFactory: (sourceRoot, analyzerContext) => createProblemResolutionAnalyzer({
          ...getModelRouteFor(generation, resolveAnalysisSelection(generationConfig, analyzerContext.reviewEvent.workspaceId,
            executionRoute(generationConfig, analyzerContext.reviewEvent)).triageModelChain, reviewMemoryScope(analyzerContext.reviewEvent)),
          sourceRoot,
        }),
      }),
      // H03/H04: workspace-layer agent and sandbox selection via the merged
      // analysis selection; an explicit container sandbox that fails
      // preflight rejects this run instead of downgrading to native.
      sandboxFactory: selectedAgentAdapter ? () => createSandboxBackendFromSandboxConfig(
        analysis.sandbox ?? generationConfig.agent.sandbox,
      ) : undefined,
      agentAdapter: selectedAgentAdapter,
      agentTimeoutMs: agentConfig.agent.timeout_seconds * 1000,
      agentAutoApprove: agentConfig.agent.auto_approve,
      contextCompaction: contextCompactionFromConfig(agentConfig),
      webSearch: webSearchFromConfig(agentConfig),
      ignoreLabelsResolver: (id: string) => {
        if (id === workspaceId) return reviewPolicy.labels?.ignore ?? ["aicr:ignore", "aicr-ignore"];
        try {
          const workspace = resolveWorkspaceConfig(generationConfig, id);
          return workspace.review?.labels?.ignore ?? generationConfig.review.labels?.ignore ?? ["aicr:ignore", "aicr-ignore"];
        } catch {
          return generationConfig.review.labels?.ignore ?? ["aicr:ignore", "aicr-ignore"];
        }
      },
      contextRepositoriesResolver: (id: string) => {
        try {
          return resolveWorkspaceConfig(generationConfig, id).context_repositories;
        } catch {
          return undefined;
        }
      },
      reviewPolicyResolver: (id: string) => {
        const merged = id === workspaceId
          ? reviewPolicy
          : (resolveAnalysisSelection(generationConfig, id, undefined).review as AppConfig["review"]);
        return { include: merged.include, exclude: merged.exclude, max_files: merged.max_files };
      },
      reviewConfig: reviewPolicy,
      configVersion: { configSnapshotId: generation.snapshotId, databaseRevision: generation.databaseRevision,
        fileDigest: generation.fileDigest, ...(executionRoute(generationConfig, context.reviewEvent)
          ? { routeId: executionRoute(generationConfig, context.reviewEvent)!.id } : {}) },
      memoryHintsResolver: async (scope: string) => {
        const reflection = reviewPolicy.reflection;
        if (!store || !reflection || reflection.enabled === false || reflection.mode === "off") return [];
        const entries = await readReflectionMemory(store, scope, { limit: reflection.memory?.max_entries ?? 100 });
        let bytes = 0;
        const bounded = entries.filter(entry => {
          bytes += Buffer.byteLength(entry.content, "utf8");
          return bytes <= (reflection.memory?.max_size_kb ?? Infinity) * 1024;
        });
        return buildMemoryHintsForPrompt(bounded);
      },
      ...(toCompressionConfig(analysis.compression as AppConfig["compression"])
        ? { compression: toCompressionConfig(analysis.compression as AppConfig["compression"])! } : {}),
      ...(reviewPolicy.output_language !== undefined ? { outputLanguage: reviewPolicy.output_language } : {}),
      ...(reviewPolicy.log_thinking !== undefined ? { logThinking: reviewPolicy.log_thinking } : {}),
    };
  };

  const orchestrationOptions: ServerReviewOrchestrationOptions = {
    baseSystemPrompt,
    sourceRootResolver,
    runtimeDirsResolver,
    vcs: createVcsAdapterFromConfig(config, baseDir),
    ...defaultRoute,
    modelOptionsResolver,
    optionsResolver: resolveRunOptions,
    executionScope: async (context, run) => {
      const generation = context.configSnapshotId === undefined ? await runtimeConfig.captureForTask() : await runtimeConfig.resolveGeneration(context.configSnapshotId);
      return runtimeConfig.withGeneration(generation, run);
    },
    dryRun: false,
    // Bootstrap-time fallbacks below apply only when a run somehow bypasses
    // optionsResolver (e.g. a custom caller); every server path resolves the
    // pinned generation per task instead.
    outputPublisherResolver: createOutputPublisherResolverFromConfig(config, {
      baseDir,
      resolutionAnalyzerFactory: (sourceRoot, context) => createProblemResolutionAnalyzer({
        ...triageModelOptionsResolver(context.reviewEvent.workspaceId),
        sourceRoot,
      }),
    }),
    sandboxFactory: agentAdapter ? () => createSandboxBackendFromConfig(config) : undefined,
    agentAdapter,
    agentTimeoutMs: config.agent.timeout_seconds * 1000,
    contextCompaction: contextCompactionFromConfig(config),
    webSearch: webSearchFromConfig(config),
    ignoreLabelsResolver: (workspaceId) => {
      try {
        const workspace = resolveWorkspaceConfig(config, workspaceId);
        return workspace.review?.labels?.ignore ?? config.review.labels?.ignore ?? ["aicr:ignore", "aicr-ignore"];
      } catch {
        return config.review.labels?.ignore ?? ["aicr:ignore", "aicr-ignore"];
      }
    },
    contextRepositoriesResolver: (workspaceId: string) => {
      try {
        return resolveWorkspaceConfig(config, workspaceId).context_repositories;
      } catch {
        return undefined;
      }
    },
    ...(reflectionEnabled
      ? {
          memoryHintsResolver: async (workspaceId: string): Promise<readonly string[]> => {
            try {
              const entries = await readReflectionMemory(store!, workspaceId, { limit: 100 });
              return buildMemoryHintsForPrompt(entries);
            } catch {
              return [];
            }
          },
        }
      : {}),
    ...(reflectionEnabled
      ? {
          postRunCallback: async (result: ReviewOrchestrationResult, ctx: ReviewOrchestrationContext): Promise<void> => {
            const workspaceId = reviewMemoryScope(ctx.reviewEvent);
            const runId = ctx.runId ?? ctx.reviewEvent.headSha ?? String(Date.now());
            // H05 reflection layering: the run's own generation decides mode
            // and retention, not whatever revision is current at completion.
            const generationConfig = (await runtimeConfig.resolveGeneration(ctx.configSnapshotId ?? null)).config;
            const reflectionPolicy = (resolveAnalysisSelection(
              generationConfig,
              ctx.reviewEvent.workspaceId,
              executionRoute(generationConfig, ctx.reviewEvent),
            ).review as AppConfig["review"]).reflection;
            if (!reflectionPolicy || reflectionPolicy.enabled === false || reflectionPolicy.mode === "off") {
              return;
            }
            const reflectionInput = {
              workspaceId,
              runId,
              status: result.status,
              skipReason: result.skipReason,
              problems: result.outputState.problems,
              summaries: result.outputState.summaries,
              changedFiles: result.changedFiles,
            };
            const reflections = [
              ...extractReflections(reflectionInput),
              ...extractRepositoryConventions(reflectionInput),
            ];

            if (reflections.length > 0) {
              const now = new Date();
              const retentionDays = reflectionPolicy?.memory?.retention_days ?? 90;
              const expiresAt = new Date(now.getTime() + retentionDays * 86_400_000);
              const toEntries = (rs: readonly ExtractedReflection[]) =>
                rs.map((r: ExtractedReflection) => ({
                  workspaceId,
                  fingerprint: r.fingerprint,
                  content: r.content,
                  sourceRunId: runId,
                  createdAt: now,
                  expiresAt,
                }));
              await writeReflectionMemory(store!, toEntries(reflections));

              if (reflectionPolicy?.mode === "thorough" && result.outputState.problems.length > 0) {
                const allEntries = await readReflectionMemory(store!, workspaceId, { limit: 200 });
                const currentCategories = [
                  ...new Set(
                    result.outputState.problems.map((p: { category?: string }) => p.category ?? "uncategorized"),
                  ),
                ];
                const crossRunReflections = extractCrossRunPatterns(
                  workspaceId,
                  currentCategories,
                  allEntries.map((e) => ({ fingerprint: e.fingerprint, occurrenceCount: e.occurrenceCount ?? 1 })),
                );
                if (crossRunReflections.length > 0) {
                  await writeReflectionMemory(store!, toEntries(crossRunReflections));
                }
              }

              const maxEntries = reflectionPolicy?.memory?.max_entries;
              if (maxEntries || reflectionPolicy.memory?.max_size_kb) {
                await compactReflectionMemory(store!, workspaceId, {
                  retentionDays,
                  ...(maxEntries ? { maxEntries } : {}),
                  ...(reflectionPolicy.memory?.max_size_kb ? { maxBytes: reflectionPolicy.memory.max_size_kb * 1024 } : {}),
                });
              }
            }
          },
        }
      : {}),
    ...(config.review.output_language ? { outputLanguage: config.review.output_language } : {}),
    ...(config.review.log_thinking === false ? { logThinking: false } : {}),
    ...(liveRunRegistry ? { liveRuns: liveRunRegistry } : {}),
  };

  const rawQueue = await createQueueFromConfig(config);
  const runtimeQueue = runtimeConfigStore ? createRuntimeQueue(rawQueue, runtimeConfigStore, configSources.database.namespace, runtimeConfig) : undefined;
  const queue = runtimeQueue?.queue ?? rawQueue;
  const deferralManager = new ReviewDeferralManager({ ...(store ? { store } : {}) });

  let worker: QueueWorker | undefined;
  if (jobHandler) {
    const workersConfig = config.queue.workers;
    worker = createQueueWorker(async job => {
      const generation = await runtimeConfig.resolveGeneration(job.configVersion?.configSnapshotId ?? null);
      await runtimeConfig.withGeneration(generation, () => jobHandler(job));
    }, {
      queue,
      beforePoll: () => runtimeConfig.admission(),
      concurrency: () => runtimeConfig.current().config.queue.workers?.concurrency ?? 4,
      perWorkspaceConcurrency: () => runtimeConfig.current().config.queue.workers?.per_workspace_concurrency ?? 1,
      lockTtlSeconds: workersConfig?.lock_ttl_seconds ?? 1800,
    });
  }

  const autoCommitPipeline = await createAutoCommitPipeline({
    config,
    baseDir,
    orchestrationOptions,
    workspaceRuntime,
    runtimeConfig,
    appTokenServicesFor,
    ...(store ? { reviewStore: store } : {}),
  });
  opened.closeAutoCommit = autoCommitPipeline.close;
  let sweepRunning: Promise<void> | undefined;
  const sweepTimer = runtimeConfigStore ? setInterval(() => {
    if (sweepRunning) return;
    sweepRunning = runtimeConfig.withoutGeneration(async () => {
      await runtimeConfig.admission();
      await runtimeConfig.heartbeat();
      await runtimeConfig.sweepSnapshots([autoCommitPipeline.store, deferralManager, ...(runtimeQueue ? [runtimeQueue] : [])]);
    }).catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", msg: "config snapshot collection deferred", error: admissionUnavailableReason(error) })))
      .finally(() => { sweepRunning = undefined; });
  }, 60_000) : undefined;
  sweepTimer?.unref();

  // Queue-timeout sweep (review.auto_commit.queued_timeout_hours, default
  // 48h): pending members past the per-workspace bound become terminally
  // skipped and their webhook events flip to the `timeout` decision, so a
  // stuck queue can never accumulate forever or show stale queue entries.
  const QUEUED_TIMEOUT_SWEEP_INTERVAL_MS = 10 * 60_000;
  let queuedTimeoutRunning = false;
  const runQueuedTimeoutSweep = async (): Promise<void> => {
    if (queuedTimeoutRunning) return;
    queuedTimeoutRunning = true;
    try {
      const now = Date.now();
      const workspaceIds = new Set<string>(
        Object.keys(runtimeConfig.current().config.workspaces?.instances ?? {}),
      );
      // Declared workspaces resolve their own bound (instance → defaults →
      // global → built-in 48h). Only a config without any workspace instance
      // falls back to one unscoped pass — an unscoped pass cannot honor a
      // per-workspace disabled timeout, so it must not run alongside
      // declared instances.
      const scopes: (string | undefined)[] = workspaceIds.size > 0 ? [...workspaceIds] : [undefined];
      const timedOut: string[] = [];
      for (const workspaceId of scopes) {
        const timeoutMs = workspaceId === undefined
          ? resolveAutoCommitPolicy(
              (runtimeConfig.current().config as unknown as { review?: { auto_commit?: Parameters<typeof resolveAutoCommitPolicy>[0] } }).review?.auto_commit,
              (runtimeConfig.current().config as unknown as { workspaces?: { defaults?: { review?: { auto_commit?: Parameters<typeof resolveAutoCommitPolicy>[0] } } } }).workspaces?.defaults?.review?.auto_commit,
              undefined,
            ).queuedTimeoutMs
          : autoCommitPipeline.runtime.policyFor(workspaceId).queuedTimeoutMs;
        if (timeoutMs === null) continue;
        const cutoff = now - timeoutMs;
        timedOut.push(
          ...(await autoCommitPipeline.store.timeoutStaleQueue(cutoff, now, workspaceId)),
        );
      }
      if (store && timedOut.length > 0) {
        const events = await markWebhookEventsTimedOut(store, timedOut);
        console.warn(JSON.stringify({
          level: "warn",
          msg: "auto-commit queue timeout sweep marked stale entries",
          receipts: timedOut.length,
          events,
        }));
      }
    } catch (error) {
      console.warn(JSON.stringify({
        level: "warn",
        msg: "auto-commit queue timeout sweep failed; retrying next interval",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      queuedTimeoutRunning = false;
    }
  };
  const queuedTimeoutTimer = setInterval(() => {
    void runQueuedTimeoutSweep();
  }, QUEUED_TIMEOUT_SWEEP_INTERVAL_MS);
  queuedTimeoutTimer.unref();
  setTimeout(() => {
    void runQueuedTimeoutSweep();
  }, 30_000).unref();

  const authConfig = resolveAuthConfig(config);

  const triggerRetry = resolveTriggerRetryConfig(config);
  const fileTriage = resolveIssueTriageOptions(config, triageModelOptionsResolver().llm, triageModelOptionsResolver().model);

  let draining: Promise<void> | undefined;
  const beginDrain = (): Promise<void> => {
    if (draining) return draining;
    runtimeConfig.stopAdmission();
    deferralManager.stop();
    if (sweepTimer) clearInterval(sweepTimer);
    draining = Promise.all([sweepRunning, worker?.stop(), autoCommitPipeline.scheduler.stopAndDrain()]).then(() => {});
    return draining;
  };

  return {
    // Fixed dispatcher sources (P4/H06): index.ts resolves these per request
    // against the current generation; trigger changes apply to the next
    // admission without remounting routes.
    gitea: giteaConfigs,
    forgejo: forgejoConfigs,
    github: githubConfigs,
    gitlab: gitlabConfigs,
    p4: p4Configs,
    svn: svnConfigs,
    reviewOrchestration: orchestrationOptions,
    issueTriage: runtimeConfig.mode === "file-only"
      ? fileTriage && { ...fileTriage, modelOptionsResolver: triageModelOptionsResolver }
      : (event: ReviewEvent) => {
      const generation = runtimeConfig.current();
      if (generation.config.workspaces.instances[event.workspaceId]?.triage?.enabled !== true) return undefined;
      const analysis = resolveAnalysisSelection(generation.config, event.workspaceId, executionRoute(generation.config, event));
      const route = getModelRouteFor(generation, analysis.triageModelChain, reviewMemoryScope(event));
      return resolveIssueTriageOptions(generation.config, route.llm, route.model, event.triggerName);
    },
    queue,
    ...(worker ? { worker } : {}),
    ...(config.server.path_prefix ? { pathPrefix: config.server.path_prefix } : {}),
    ...(authConfig ? { auth: authConfig } : {}),
    asyncTriggers: true,
    deduplicator: createReviewDeduplicator(),
    ...(triggerRetry ? { triggerRetry } : {}),
    // Automatic commit events persist as receipts and run through the
    // scheduler; PR/issue/comment/manual flows run on the async path below.
    autoCommit: autoCommitPipeline.runtime,
    autoCommitStore: autoCommitPipeline.store,
    beginDrain,
    closeAutoCommit: async () => {
      await beginDrain();
      await runtimeConfig.drain();
      await deferralManager.drain();
      await autoCommitPipeline.close();
      await runtimeConfigStore?.close();
      await queue.close?.();
      await catalogBackendToClose?.close?.();
    },
    // Runtime config manager (P4): admission barrier + generation pinning.
    runtimeConfig,
    // Config admin API surface (P5) — mounted only with admin auth plus the
    // config store; independent of the stats store.
    ...(adminAuthConfig && runtimeConfigStore
      ? {
          configApi: {
            store: runtimeConfigStore,
            adminAuth: adminAuthConfig,
            sessionStore: sessionStore ?? runtimeConfigStore,
            namespace: configSources.database.namespace,
            fileConfig: (options.configDocument?.document ?? {}) as AppConfigInput,
            fileDigest: options.configDocument?.digest ?? "",
            formatVersion: 2,
            manager: runtimeConfig,
            envLookup: resolveEnv,
            builtinPrompts: [
              { id: "code-reviewer", name: "Built-in code reviewer (prompts/system/code-reviewer.system.md)", document: baseSystemPrompt },
            ],
            builtinTemplatesBaseDir: resolve(baseDir, "templates", "builtin"),
            ...(configSecretSealing ? { secretSealing: configSecretSealing } : {}),
          },
        }
      : {}),
    // PR/MR events prefer their own `review.pull_request.schedule`; when no
    // layer sets it they fall back to the resolved auto-commit schedule, and
    // every other async target kind uses the auto-commit schedule directly.
    getExecutionSchedule: (workspaceId: string, targetKind?: string) => {
      const generationConfig = currentConfig();
      if (targetKind === "pull_request") {
        const pullRequestSchedule = resolvePullRequestSchedule(
          generationConfig.review.pull_request,
          generationConfig.workspaces.defaults.review?.pull_request,
          generationConfig.workspaces.instances[workspaceId]?.review?.pull_request,
        );
        if (pullRequestSchedule) {
          return pullRequestSchedule;
        }
      }
      return autoCommitPipeline.runtime.policyFor(workspaceId).schedule;
    },
    // Receive-side branch allowlist for automatic commit events, from the
    // same layered policy (`review.auto_commit.include_branches`).
    getAutoCommitBranches: (workspaceId: string) =>
      autoCommitPipeline.runtime.policyFor(workspaceId).includeBranches,
    // Receive-side target-branch allowlist for PR/MR analysis
    // (`review.pull_request.include_target_branches`).
    getPullRequestTargetBranches: (workspaceId: string) =>
      resolvePullRequestTargetBranches(
        currentConfig().review.pull_request,
        currentConfig().workspaces.defaults.review?.pull_request,
        currentConfig().workspaces.instances[workspaceId]?.review?.pull_request,
      ),
    // Window-deferred async events persist here so a restart resumes them.
    deferralManager,
    ...(observability ? { observability } : {}),
    ...(sessionStore ? { sessionStore } : {}),
    ...(liveRunRegistry ? { liveRuns: liveRunRegistry } : {}),
    ...(store ? { store } : {}),
  };
}

function resolveIssueTriageOptions(
  config: AppConfig,
  llmClient: ChatCompletionClient,
  model: ModelSpec,
  triggerName?: string,
): IssueTriageRuntimeOptions | undefined {
  const anyTriageEnabled = Object.values(config.workspaces.instances).some(
    (instance) => instance.triage?.enabled === true,
  );
  if (!anyTriageEnabled) {
    return undefined;
  }

  const giteaTrigger = config.triggers.find(
    (t) => (t.kind === "gitea" || t.kind === "forgejo") && (triggerName === undefined || t.name === triggerName),
  );
  if (!giteaTrigger) {
    return undefined;
  }

  const triggerConfig = giteaTrigger as Record<string, unknown>;
  const baseUrl = (triggerConfig.base_url as string | undefined) ??
    config.server.base_url;
  const token = resolveSecretField(triggerConfig, "token", "token_env");

  if (!baseUrl) {
    return undefined;
  }

  const workspacePolicies: Record<string, WorkspaceIssueTriagePolicy> = {};
  for (const [workspaceId, instance] of Object.entries(config.workspaces.instances)) {
    const triageConfig = instance.triage;
    if (triageConfig?.enabled !== true) {
      continue;
    }

    workspacePolicies[workspaceId] = {
      ...(triageConfig.events ? { events: triageConfig.events } : {}),
      ...(triageConfig.actions ? { actions: triageConfig.actions } : {}),
      ...(triageConfig.categories_close ? { categoriesClose: triageConfig.categories_close } : {}),
      ...(triageConfig.dry_run !== undefined ? { dryRun: triageConfig.dry_run } : {}),
      ...(triageConfig.custom_prompt ? { customPrompt: triageConfig.custom_prompt } : {}),
    };
  }

  const giteaClient = new GiteaApiClient({
    baseUrl,
    ...(token ? { token } : {}),
  });

  return {
    llm: llmClient,
    model,
    giteaClient,
    workspacePolicies,
  };
}

/**
 * Automatic-commit pipeline (design §7): one persistent store following the
 * queue backend, the receive-path runtime, and the single debounced
 * scheduler loop. The scheduler starts on construction like the queue
 * worker; its leases, reservations, and outbox claims expire, so process
 * kill is a safe stop and restart resumes without member loss.
 */
async function createAutoCommitPipeline(deps: {
  readonly config: AppConfig;
  readonly baseDir: string;
  readonly orchestrationOptions: ServerReviewOrchestrationOptions;
  readonly reviewStore?: StoreDb;
  readonly appTokenServices?: ReadonlyMap<string, GithubAppTokenService>;
  readonly workspaceRuntime: WorkspaceRuntime;
  /** P4 generation source: policies, adapters, and profiles read the CURRENT generation. */
  readonly runtimeConfig: RuntimeConfigManager;
  readonly appTokenServicesFor?: (generation: RuntimeConfigGeneration) => Promise<ReadonlyMap<string, GithubAppTokenService>>;
}): Promise<{
  readonly runtime: AutoCommitRuntime;
  readonly scheduler: AutoCommitScheduler;
  readonly store: AutoCommitStore;
  readonly close: () => Promise<void>;
}> {
  const { config, orchestrationOptions, workspaceRuntime, runtimeConfig } = deps;
  const store = await createAutoCommitStoreFromConfig(config);
  if (config.queue.kind === "memory" || config.queue.kind === "rabbitmq") {
    console.warn(JSON.stringify({
      level: "warn",
      msg: "auto-commit store is in-memory: a 202 receipt only proves this process accepted the event; receipts do not survive restart",
      queueBackend: config.queue.kind,
    }));
  }

  const getPolicyLayers = (workspaceId: string) => {
    const generationConfig = runtimeConfig.current().config;
    return {
      global: generationConfig.review.auto_commit,
      defaults: generationConfig.workspaces.defaults.review?.auto_commit,
      instance: generationConfig.workspaces.instances[workspaceId]?.review?.auto_commit,
    };
  };

  const schedulerHolder: { scheduler?: AutoCommitScheduler } = {};
  const runtime = new AutoCommitRuntime({
    store,
    getPolicyLayers,
    // H08: every receipt seals the admission generation's snapshot id.
    getConfigSnapshotId: () => runtimeConfig.current().snapshotId,
    withAdmissionPin: (id, accept) => runtimeConfig.withAdmissionPin(id, accept),
    onAccepted: () => runtimeConfig.withoutGeneration(() => schedulerHolder.scheduler?.kick()),
  });

  // Adapter caches are generation-scoped: a published revision must not
  // reuse an adapter bound to the previous config's trigger credentials.
  const adapterCaches = new WeakMap<RuntimeConfigGeneration, Map<string, GitVcsAdapter | P4VcsAdapter | SvnVcsAdapter>>();
  const getAdapterCacheFor = (generation: RuntimeConfigGeneration): Map<string, GitVcsAdapter | P4VcsAdapter | SvnVcsAdapter> => {
    let cache = adapterCaches.get(generation);
    if (cache === undefined) {
      cache = new Map<string, GitVcsAdapter | P4VcsAdapter | SvnVcsAdapter>();
      adapterCaches.set(generation, cache);
    }
    return cache;
  };

  const getAdapter = async (stream: StreamKeyInput, configSnapshotId?: string | null) => {
    const generation = await runtimeConfig.resolveGeneration(configSnapshotId ?? null);
    const generationConfig = generation.config;
    const generationWorkspaceRuntime = generation.workspaceRuntime;
    const trigger = generationConfig.triggers.find((entry) => entry.name === stream.triggerName);
    if (!trigger) {
      return undefined;
    }
    const adapterCache = getAdapterCacheFor(generation);
    // The namespace prefixes provider identity; the remainder is the
    // original-case repo/depot reference the adapter needs for remote URLs.
    const repoRef = stream.sourceNamespace.slice(stream.sourceNamespace.indexOf(":") + 1);
    // The cache key must include the workspace: two workspaces watching the
    // same trigger+repo each get their own adapter bound to their own clone
    // directory — sharing one adapter would clone workspace B's events into
    // workspace A's directory. The snapshot id joins the key so a new
    // generation never reuses an adapter bound to the previous config.
    const cacheKey = `${stream.workspaceId} ${stream.triggerName} ${repoRef} ${generation.snapshotId ?? ""}`;
    let adapter = adapterCache.get(cacheKey);
    if (!adapter) {
      // The metadata adapter must clone into the per-workspace source root —
      // the same layout buildSourceRootResolver produces — never baseDir
      // (process cwd): inside the runtime image cwd is the read-only /app,
      // so a clone attempt there fails with EACCES and poisons the receipt
      // with a terminal metadata error. The adapter is long-lived, so it
      // re-fetches on every sync (alwaysFetch) and resolves GitHub App
      // installation tokens lazily per sync (tokenProvider) — a cached static
      // token expires after an hour and would break every later expansion.
      // Metadata queries precede admission and have no branch/template
      // context. Keep caches independent of event-dependent work_path.
      const metadataDir = generationConfig.workspaces.instances[stream.workspaceId]?.match === undefined
        ? generationWorkspaceRuntime.layoutForEvent({ triggerName: stream.triggerName, workspaceId: stream.workspaceId, repoRef }).sourceRoot
        : resolve(generationWorkspaceRuntime.workspacesRoot, ".metadata", hashStructured([stream.triggerName, stream.workspaceId, stream.vcs, repoRef]));
      adapter = createVcsAdapterFromConfig(
        generationConfig,
        metadataDir,
        stream.triggerName,
        repoRef || undefined,
        {
          alwaysFetch: true,
          tokenProvider: async () => {
            const tokenServices = await (deps.appTokenServicesFor?.(generation) ?? Promise.resolve(deps.appTokenServices));
            return resolveGithubAppInstallationToken(
              generationConfig,
              tokenServices,
              stream.triggerName,
              repoRef || undefined,
            );
          },
        },
      );
      adapterCache.set(cacheKey, adapter);
    }
    return typeof adapter.listCommitMetadataPage === "function"
      ? (adapter as VcsAdapter & { listCommitMetadataPage: NonNullable<VcsAdapter["listCommitMetadataPage"]> })
      : undefined;
  };

  // Stage C resolver (architecture §3.10): converts durable p4/svn routing receipts
  // into formal receipts during the scheduler tick. Adapter lookups are
  // cached per trigger — the p4/svn metadata queries hit the server
  // directly, no per-scope adapter instances needed.
  const routingAdapterCache = new Map<string, GitVcsAdapter | P4VcsAdapter | SvnVcsAdapter>();
  const routingResolver = new RoutingReceiptResolver({
    runtimeConfig,
    store,
    config,
    runtime,
    workspaceRuntime,
    adapterFor: (triggerName, provider) => {
      if (provider !== "p4" && provider !== "svn") {
        return undefined;
      }
      const generation = runtimeConfig.current();
      let adapter = routingAdapterCache.get(`${generation.snapshotId ?? ""} ${triggerName}`);
      if (!adapter) {
        const metadataDir = resolve(generation.workspaceRuntime.workspacesRoot, ".metadata", hashStructured(["routing", triggerName, provider]));
        adapter = createVcsAdapterFromConfig(generation.config, metadataDir, triggerName, undefined, {});
        routingAdapterCache.set(`${generation.snapshotId ?? ""} ${triggerName}`, adapter);
      }
      return adapter;
    },
    profileFor: (triggerName, provider) => {
      const generation = runtimeConfig.current();
      if (provider === "p4") {
        const profile = resolveP4TriggerConfigs(generation.config, triggerName, generation.workspaceRuntime)[0];
        return profile
          ? {
              workspaceId: profile.workspaceId,
              ...(profile.streams ? { scopes: profile.streams } : {}),
              ...(profile.depot ? { depotPath: profile.depot } : {}),
            }
          : undefined;
      }
      if (provider === "svn") {
        const profile = resolveSvnTriggerConfigs(generation.config, triggerName, generation.workspaceRuntime)[0];
        return profile
          ? {
              workspaceId: profile.workspaceId,
              repositoryUrl: profile.repositoryUrl,
              ...(profile.projectRoots ? { projectRoots: profile.projectRoots } : {}),
            }
          : undefined;
      }
      return undefined;
    },
  });

  const executeBatch = createAutoCommitBatchExecutor({
    store,
    orchestrationOptions,
    persistResult: async (runId, result) => {
      const reviewStore = deps.reviewStore;
      if (!reviewStore) return;
      // One atomic dedup + write includes usage and rollup rows. A
      // recovered completed checkpoint can safely retry this accounting.
      await persistReviewRunToStore(reviewStore, runId, result.reviewEvent, result.reviewRun,
        result.durationMs, result.startedAt, { strict: true, idempotent: true });
    },
  });
  const scheduler = new AutoCommitScheduler({
    store,
    getPolicy: (workspaceId) => runtime.policyFor(workspaceId),
    getAdapter,
    routingResolver,
    executeBatch,
    // H17: concurrency re-reads at the claim boundary from the current
    // generation; lowering the limit never cancels running batches.
    globalConcurrency: () => runtimeConfig.current().config.queue.workers?.concurrency ?? 1,
    perWorkspaceConcurrency: () => runtimeConfig.current().config.queue.workers?.per_workspace_concurrency ?? 1,
  });
  schedulerHolder.scheduler = scheduler;
  scheduler.start();
  return {
    runtime,
    scheduler,
    store,
    close: async () => {
      await scheduler.stopAndDrain();
      store.close?.();
    },
  };
}
