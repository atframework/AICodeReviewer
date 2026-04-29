import { resolve } from "node:path";

import { isPlainObject, type AppConfig, type ReviewEvent } from "@aicr/core";
import { createAgentAdapter, type AgentAdapter, type AgentKind } from "@aicr/agents";
import {
  createOpenAICompatibleChatClient,
  createResilientChatClient,
  type ChatCompletionClient,
  type LlmGatewayProviderConfig,
  type LlmGatewayRetryConfig,
  type LlmGatewayBudgetConfig,
  type LlmGatewayFallbackEntry,
  type LlmGatewayPerProviderOverride,
  type ModelSpec,
  type ModelProviderKind,
} from "@aicr/llm";
import { createGiteaPullRequestReviewDispatcher, type ReviewFinding, type DispatchResult } from "@aicr/outputs";
import {
  createSandboxBackend,
  resolveSandboxKind,
  type SandboxBackend,
  type SandboxKind,
  type SandboxEngine,
} from "@aicr/sandbox";
import { createGitVcsAdapter, type GitVcsAdapter } from "@aicr/vcs";

import type { GiteaWebhookConfig } from "./gitea-webhook.js";
import type { ServerAppOptions, ServerReviewOrchestrationOptions } from "./index.js";
import type {
  ReviewOrchestrationContext,
  ReviewOutputPublisher,
  ReviewOutputPublisherResolver,
} from "./review-orchestrator.js";

export interface BootstrapServerOptions {
  readonly config: AppConfig;
  readonly baseSystemPrompt: string;
  readonly baseDir?: string;
  readonly workspaceId?: string;
}

function resolveEnv(name: string | undefined): string | undefined {
  return name ? process.env[name] : undefined;
}

function extractPullNumber(payload: unknown): number | undefined {
  if (!isPlainObject(payload)) {
    return undefined;
  }

  const pullRequest = payload.pull_request;
  if (isPlainObject(pullRequest) && typeof pullRequest.number === "number") {
    return pullRequest.number;
  }

  return typeof payload.number === "number" ? payload.number : undefined;
}

export function resolveModelSpecFromConfig(config: AppConfig, providerId?: string): ModelSpec {
  const providers = config.llm.providers;
  if (providers.length === 0) {
    throw new TypeError("No LLM providers configured.");
  }

  const fallbackEntry = providerId
    ? config.llm.fallback_chain.find((entry) => entry.provider === providerId)
    : config.llm.fallback_chain[0];
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

  return {
    providerKind: provider.kind as ModelProviderKind,
    providerId: provider.id,
    modelId,
    ...resolveModelProviderFields(provider),
  };
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

type MutableModelFields = {
  -readonly [K in keyof ModelSpec]?: ModelSpec[K];
};

function resolveModelProviderFields(provider: AppConfig["llm"]["providers"][number]): Partial<ModelSpec> {
  const raw = provider as Record<string, unknown>;
  const fields: MutableModelFields = {};

  const baseUrl = readString(raw, "base_url", "baseUrl");
  if (baseUrl !== undefined) fields.baseUrl = baseUrl;
  const apiKeyEnv = readString(raw, "api_key_env", "apiKeyEnv");
  if (apiKeyEnv !== undefined) fields.apiKeyEnv = apiKeyEnv;
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
  const awsRegion = readString(raw, "aws_region", "awsRegion");
  if (awsRegion !== undefined) fields.awsRegion = awsRegion;
  const awsAccessKeyEnv = readString(raw, "aws_access_key_env", "awsAccessKeyEnv");
  if (awsAccessKeyEnv !== undefined) fields.awsAccessKeyEnv = awsAccessKeyEnv;
  const awsSecretKeyEnv = readString(raw, "aws_secret_key_env", "awsSecretKeyEnv");
  if (awsSecretKeyEnv !== undefined) fields.awsSecretKeyEnv = awsSecretKeyEnv;
  const awsSessionTokenEnv = readString(raw, "aws_session_token_env", "awsSessionTokenEnv");
  if (awsSessionTokenEnv !== undefined) fields.awsSessionTokenEnv = awsSessionTokenEnv;
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
    reasoningEffort === "high"
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

  return fields;
}

export function createLlmClientFromModelSpec(model: ModelSpec): ChatCompletionClient {
  if (
    model.providerKind === "openai_compatible" ||
    model.providerKind === "ollama"
  ) {
    return createOpenAICompatibleChatClient();
  }

  throw new TypeError(
    `Provider kind "${model.providerKind}" is not yet supported. Only openai_compatible and ollama are implemented.`,
  );
}

export function resolveAgentAdapterFromConfig(config: AppConfig): AgentAdapter {
  const agentDefault = config.agent.default;
  return createAgentAdapter({ kind: agentDefault as AgentKind });
}

export async function createSandboxBackendFromConfig(config: AppConfig): Promise<SandboxBackend> {
  const sandboxConfig = config.agent.sandbox;
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
): GiteaWebhookConfig | undefined {
  const trigger = triggerName
    ? config.triggers.find((t) => t.name === triggerName && (t.kind === "gitea" || t.kind === "forgejo"))
    : config.triggers.find((t) => t.kind === "gitea" || t.kind === "forgejo");

  if (!trigger) {
    return undefined;
  }

  const triggerConfig = trigger as Record<string, unknown>;
  const webhookSecretEnv = triggerConfig.webhook_secret_env as string | undefined;
  const webhookSecret = webhookSecretEnv ? resolveEnv(webhookSecretEnv) : undefined;

  return {
    triggerName: trigger.name,
    workspaceId: resolveWorkspaceIdFromTrigger(config, trigger.name),
    ...(webhookSecret !== undefined ? { webhookSecret } : {}),
  };
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

export function createOutputPublisherFromConfig(
  config: AppConfig,
  channelName?: string,
  pullNumber?: number,
  workspaceId?: string,
): ReviewOutputPublisher | undefined {
  const channels = config.outputs.channels;
  if (channels.length === 0) {
    return undefined;
  }

  const channel = channelName
    ? channels.find((c) => c.name === channelName)
    : channels.find((c) => c.kind === "gitea_pr_review");

  if (!channel || channel.kind !== "gitea_pr_review") {
    return undefined;
  }

  const channelConfig = channel as Record<string, unknown>;
  const triggerName = channelConfig.trigger as string | undefined;
  const trigger = triggerName
    ? config.triggers.find((t) => t.name === triggerName && (t.kind === "gitea" || t.kind === "forgejo"))
    : config.triggers.find((t) => t.kind === "gitea" || t.kind === "forgejo");
  const triggerConfig = (trigger ?? {}) as Record<string, unknown>;
  const baseUrl = (channelConfig.base_url as string | undefined) ??
    (triggerConfig.base_url as string | undefined);
  const tokenEnv = (channelConfig.token_env as string | undefined) ??
    (triggerConfig.token_env as string | undefined);
  const explicitOwner = channelConfig.owner as string | undefined;
  const explicitRepo = channelConfig.repo as string | undefined;
  const workspaceRepoRef = trigger
    ? resolveWorkspaceRepoRef(config, trigger.name, workspaceId)
    : undefined;
  const parsedRepo = parseRepoRef(explicitOwner ? explicitRepo : explicitRepo ?? workspaceRepoRef);
  const owner = explicitOwner ?? parsedRepo?.owner;
  const repo = explicitOwner ? explicitRepo : parsedRepo?.repo;

  if (!baseUrl || !owner || !repo || !pullNumber) {
    return undefined;
  }

  const dispatcher = createGiteaPullRequestReviewDispatcher({
    baseUrl,
    ...(tokenEnv ? { token: resolveEnv(tokenEnv) ?? "" } : {}),
    owner,
    repo,
    pullNumber,
    channelName: channel.name,
  });

  return {
    async publishFinding(finding: ReviewFinding): Promise<DispatchResult> {
      return dispatcher.publishFinding(finding);
    },
  };
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

function resolveLineCommentChannelName(
  config: AppConfig,
  context: ReviewOrchestrationContext,
): string | undefined {
  const workspace = config.workspaces.instances[context.reviewEvent.workspaceId];
  const workspaceChannel = workspace?.outputs?.line_comments?.[0];
  if (workspaceChannel) {
    return workspaceChannel;
  }

  const routeChannel = config.outputs.routes?.rules
    .find((route) => routeMatchesEvent(route, context))
    ?.line_comments?.[0];
  if (routeChannel) {
    return routeChannel;
  }

  return config.outputs.routes?.default?.line_comments?.[0];
}

export function createOutputPublisherResolverFromConfig(
  config: AppConfig,
): ReviewOutputPublisherResolver {
  return (context) => {
    const pullNumber = extractPullNumber(context.payload);
    if (pullNumber === undefined) {
      return undefined;
    }

    return createOutputPublisherFromConfig(
      config,
      resolveLineCommentChannelName(config, context),
      pullNumber,
      context.reviewEvent.workspaceId,
    );
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

export function createVcsAdapterFromConfig(
  config: AppConfig,
  repositoryDir: string,
): GitVcsAdapter {
  return createGitVcsAdapter({
    repositoryDir: resolve(repositoryDir),
    allowDeepen: config.review.git?.allow_deepen ?? false,
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
  chain: AppConfig["llm"]["fallback_chain"],
): readonly LlmGatewayFallbackEntry[] {
  return chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    role: entry.role,
  }));
}

export async function bootstrapServerApp(options: BootstrapServerOptions): Promise<ServerAppOptions> {
  const { config, baseSystemPrompt, baseDir = process.cwd() } = options;

  const giteaConfig = resolveGiteaWebhookConfig(config);

  const model = resolveModelSpecFromConfig(config);
  const retryConfig = toGatewayRetry(config.llm.retry);
  const budgetConfig = toGatewayBudget(config.llm.budget);
  const perProviderOverrides = toGatewayPerProviderOverrides(config.llm.per_provider_overrides);
  const llmClient = createResilientChatClient({
    clientFactory: createLlmClientFromModelSpec,
    providers: toGatewayProviders(config.llm.providers),
    fallbackChain: toGatewayFallbackChain(config.llm.fallback_chain),
    ...(retryConfig ? { retry: retryConfig } : {}),
    ...(budgetConfig ? { budget: budgetConfig } : {}),
    ...(perProviderOverrides ? { perProviderOverrides } : {}),
  });

  const sourceRootResolver = buildSourceRootResolver(baseDir);
  const sandbox = await createSandboxBackendFromConfig(config);
  const agentAdapter = resolveAgentAdapterFromConfig(config);

  const orchestrationOptions: ServerReviewOrchestrationOptions = {
    baseSystemPrompt,
    sourceRootResolver,
    vcs: createVcsAdapterFromConfig(config, baseDir),
    llm: llmClient,
    model,
    dryRun: false,
    outputPublisherResolver: createOutputPublisherResolverFromConfig(config),
    sandbox,
    agentAdapter,
    agentTimeoutMs: config.agent.timeout_seconds * 1000,
  };

  return {
    ...(giteaConfig ? { gitea: giteaConfig } : {}),
    reviewOrchestration: orchestrationOptions,
  };
}
