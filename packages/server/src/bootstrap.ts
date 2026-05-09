import { resolve } from "node:path";

import {
  fixAndValidateMarkdown,
  isPlainObject,
  createMultiProviderRateLimiter,
  createQueueFromConfig,
  type AppConfig,
  type ReviewEvent,
} from "@aicr/core";
import { createQueueWorker, type QueueJobHandler, type QueueWorker } from "@aicr/core";
import { createAgentAdapter, type AgentAdapter, type AgentKind } from "@aicr/agents";
import {
  createChatClientFromModelSpec,
  createResilientChatClient,
  type ChatCompletionClient,
  type CompressionConfig,
  type LlmGatewayProviderConfig,
  type LlmGatewayRetryConfig,
  type LlmGatewayBudgetConfig,
  type LlmGatewayFallbackEntry,
  type LlmGatewayPerProviderOverride,
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
  createFeishuBotDispatcher,
  createWeComBotDispatcher,
  type ReviewProblem,
  type DispatchResult,
  toTemplateProblem,
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
import { createGitVcsAdapter, createP4VcsAdapter, type GitVcsAdapter, type P4VcsAdapter } from "@aicr/vcs";

import type { GiteaWebhookConfig } from "./gitea-webhook.js";
import type { P4TriggerConfig } from "./p4-webhook.js";
import { GiteaApiClient } from "./issue-triage.js";
import type { IssueTriageRuntimeOptions, WorkspaceIssueTriagePolicy } from "./issue-triage.js";
import type { ServerAppOptions, ServerReviewOrchestrationOptions } from "./index.js";
import { type AuthConfig } from "./auth.js";
import type {
  ReviewDispatchResult,
  ReviewOrchestrationContext,
  ReviewOutputPublisher,
  ReviewOutputPublisherResolver,
} from "./review-orchestrator.js";

export interface BootstrapServerOptions {
  readonly config: AppConfig;
  readonly baseSystemPrompt: string;
  readonly baseDir?: string;
  readonly workspaceId?: string;
  readonly jobHandler?: QueueJobHandler;
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
  return createChatClientFromModelSpec(model);
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
    ...withRepoMappings(triggerConfig),
    ...(webhookSecret !== undefined ? { webhookSecret } : {}),
  };
}

export function resolveGenericWebhookConfig(
  config: AppConfig,
  kind: string,
  triggerName?: string,
): GiteaWebhookConfig | undefined {
  const trigger = triggerName
    ? config.triggers.find((t) => t.name === triggerName && t.kind === kind)
    : config.triggers.find((t) => t.kind === kind);

  if (!trigger) {
    return undefined;
  }

  const triggerConfig = trigger as Record<string, unknown>;
  const webhookSecretEnv = triggerConfig.webhook_secret_env as string | undefined;
  const webhookSecret = webhookSecretEnv ? resolveEnv(webhookSecretEnv) : undefined;

  return {
    triggerName: trigger.name,
    workspaceId: resolveWorkspaceIdFromTrigger(config, trigger.name),
    ...withRepoMappings(triggerConfig),
    ...(webhookSecret !== undefined ? { webhookSecret } : {}),
  };
}

export function resolveP4TriggerConfig(
  config: AppConfig,
  triggerName?: string,
): P4TriggerConfig | undefined {
  const trigger = triggerName
    ? config.triggers.find((t) => t.name === triggerName && t.kind === "p4")
    : config.triggers.find((t) => t.kind === "p4");

  if (!trigger) {
    return undefined;
  }

  const triggerConfig = trigger as Record<string, unknown>;
  const port = triggerConfig.port as string | undefined;
  const userEnv = triggerConfig.user_env as string | undefined;
  const ticketEnv = triggerConfig.ticket_env as string | undefined;
  const passwordEnv = triggerConfig.password_env as string | undefined;
  const user = userEnv ? resolveEnv(userEnv) : undefined;
  const rawPassword = passwordEnv ? resolveEnv(passwordEnv) : ticketEnv ? resolveEnv(ticketEnv) : undefined;
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
    ...(depot ? { depot } : {}),
    ...(streams?.[0] ? { depot: streams[0] } : {}),
    ...(workspace ? { workspace } : {}),
    ...(watchPath ? { watchPath } : {}),
    ...(includeCrFile ? { includeCrFile } : {}),
    ...(excludeCrFile ? { excludeCrFile } : {}),
  };
}

export function resolveAuthConfig(config: AppConfig): AuthConfig | undefined {
  const serverAuth = config.server.auth as Record<string, unknown> | undefined;
  const globalApiKeyEnv = serverAuth?.api_key_env as string | undefined;
  const globalApiKey = globalApiKeyEnv ? resolveEnv(globalApiKeyEnv) : undefined;
  const authEnabled = serverAuth ? (serverAuth.enabled as boolean | undefined) !== false : true;

  const workspaceApiKeys = new Map<string, string>();
  for (const [workspaceId, instance] of Object.entries(config.workspaces.instances)) {
    const workspaceConfig = instance as Record<string, unknown>;
    const workspaceAuth = workspaceConfig.auth as Record<string, unknown> | undefined;
    if (!workspaceAuth) continue;

    const wsEnabled = workspaceAuth.enabled as boolean | undefined;
    if (wsEnabled === false) continue;

    const wsApiKeyEnv = workspaceAuth.api_key_env as string | undefined;
    const wsApiKey = wsApiKeyEnv ? resolveEnv(wsApiKeyEnv) : undefined;
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
type NoProblemsAction = "publish" | "suppress";

interface TargetUrlTemplateOptions {
  readonly commitUrlTemplate?: string;
  readonly revisionUrlTemplate?: string;
  readonly changeUrlTemplate?: string;
  readonly baseUrl?: string;
}

export interface OutputPublisherConfigOptions {
  readonly baseDir?: string;
}

function readNoProblemsAction(value: unknown): NoProblemsAction | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  return value.action === "publish" || value.action === "suppress" ? value.action : undefined;
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
  return channelKind === "gitea_problem_issue"
    ? "publish"
    : "suppress";
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

function toMentionChannelKind(channelKind: string): MentionChannelKind | undefined {
  switch (channelKind) {
    case "gitea_pr_review":
    case "github_pr_review":
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
  const eventAuthor = reviewEvent?.author?.username ?? reviewEvent?.author?.displayName;
  const eventCtx: { author?: string; url?: string; title?: string } = {};
  if (eventAuthor !== undefined) {
    eventCtx.author = eventAuthor;
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

  return {
    ...(Object.keys(eventCtx).length > 0 ? { event: eventCtx } : {}),
    ...(target ? { target } : {}),
    ...(repo ? { repo } : {}),
    ...(atMentions ? { atMentions } : {}),
  };
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
  readonly renderSummary: (summary: string, problems: readonly ReviewProblem[]) => string;
} {
  const workspaceTemplatesDir = workspaceId
    ? resolve(baseDir, "workspaces", workspaceId, "templates")
    : undefined;
  const resolver = createTemplateResolver({
    channelKind: channel.kind,
    channelName: channel.name,
    ...(workspaceTemplatesDir ? { workspaceTemplatesDir } : {}),
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
    renderSummary(summary: string, problems: readonly ReviewProblem[]): string {
      return fixAndValidateMarkdown(resolver.render("summary", {
        ...baseTemplateContext,
        summary,
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

function callPublishProblem(
  publisher: ReviewOutputPublisher,
  problem: ReviewProblem,
): Promise<ReviewDispatchResult> {
  if (!publisher.publishProblem) {
    throw new TypeError("Review output publisher must provide publishProblem.");
  }

  return publisher.publishProblem(problem);
}

function createCompositeOutputPublisher(
  linePublishers: readonly ReviewOutputPublisher[],
  summaryPublishers: readonly ReviewOutputPublisher[],
): ReviewOutputPublisher | undefined {
  const summaryCapable = summaryPublishers.filter((publisher) => publisher.publishSummary);
  if (linePublishers.length === 0 && summaryCapable.length === 0) {
    return undefined;
  }

  if (linePublishers.length === 1 && summaryCapable.length === 0) {
    return linePublishers[0]!;
  }

  return {
    handlesRendering: true,
    publishesProblems: linePublishers.length > 0,
    noProblemsAction: summaryCapable.some((publisher) => publisher.noProblemsAction !== "suppress") ? "publish" : "suppress",
    publishEmptySummary: summaryCapable.some((publisher) => publisher.publishEmptySummary && publisher.noProblemsAction !== "suppress"),
    async publishProblem(problem: ReviewProblem): Promise<readonly DispatchResult[]> {
      const results: DispatchResult[] = [];
      for (const publisher of linePublishers) {
        appendPublisherResults(results, await callPublishProblem(publisher, problem));
      }
      return results;
    },
    ...(summaryCapable.length > 0
      ? {
          async publishSummary(summary: string, problems?: readonly ReviewProblem[]): Promise<readonly DispatchResult[]> {
            const results: DispatchResult[] = [];
            const noProblems = (problems?.length ?? 0) === 0;
            const hasExplicitSummary = summary.trim().length > 0;
            for (const publisher of summaryCapable) {
              if (noProblems && !hasExplicitSummary && publisher.noProblemsAction === "suppress") {
                continue;
              }
              if (publisher.publishSummary) {
                appendPublisherResults(results, await publisher.publishSummary(summary, problems));
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
    : channel.kind === "github_pr_review"
      ? ["github"]
      : channel.kind === "gitlab_mr_review"
        ? ["gitlab"]
        : [];

  const trigger = isPrReview || supportedTriggerKinds.length > 0
    ? (triggerName
        ? config.triggers.find((t) => t.name === triggerName && supportedTriggerKinds.includes(t.kind))
        : config.triggers.find((t) => supportedTriggerKinds.includes(t.kind)))
    : undefined;
  const triggerConfig = (trigger ?? {}) as Record<string, unknown>;
  const baseUrl = (channelConfig.base_url as string | undefined) ??
    (triggerConfig.base_url as string | undefined);
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
  const tokenEnv = (channelConfig.token_env as string | undefined) ??
    (triggerConfig.token_env as string | undefined);
  const explicitOwner = channelConfig.owner as string | undefined;
  const explicitRepo = channelConfig.repo as string | undefined;
  const workspaceRepoRef = trigger
    ? resolveWorkspaceRepoRef(config, trigger.name, workspaceId)
    : undefined;
  const parsedRepo = parseRepoRef(explicitOwner && explicitRepo ? undefined : explicitRepo ?? workspaceRepoRef);
  const owner = explicitOwner ?? parsedRepo?.owner;
  const repo = explicitOwner ? explicitRepo : parsedRepo?.repo;
  const repoRef = owner && repo ? `${owner}/${repo}` : workspaceRepoRef;
  const rendering = createChannelRendering(config, channel, workspaceId, reviewEvent, repoRef, baseDir, targetUrlTemplates);
  const publishEmptySummary = noProblemsAction === "publish";

  if (channel.kind === "gitea_pr_review") {
    if (!baseUrl || !owner || !repo || pullNumber === undefined) {
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
      handlesRendering: true,
      noProblemsAction,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        return dispatcher.publishProblem(rendering.renderProblem(problem));
      },
    };
  }

  if (channel.kind === "github_pr_review") {
    if (!owner || !repo || pullNumber === undefined) {
      return undefined;
    }

    const dispatcher = createGithubPullRequestReviewDispatcher({
      ...(baseUrl ? { baseUrl } : {}),
      ...(tokenEnv ? { token: resolveEnv(tokenEnv) ?? "" } : {}),
      owner,
      repo,
      pullNumber,
      channelName: channel.name,
    });

    return {
      handlesRendering: true,
      noProblemsAction,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        return dispatcher.publishProblem(rendering.renderProblem(problem));
      },
    };
  }

  if (channel.kind === "gitlab_mr_review") {
    const projectId = channelConfig.project_id ?? channelConfig.projectId ?? (owner && repo ? `${owner}/${repo}` : workspaceRepoRef);
    const mergeRequestIid = readNumber(channelConfig, "merge_request_iid", "mergeRequestIid") ?? pullNumber;
    if ((typeof projectId !== "string" && typeof projectId !== "number") || mergeRequestIid === undefined) {
      return undefined;
    }

    const dispatcher = createGitlabMergeRequestReviewDispatcher({
      ...(baseUrl ? { baseUrl } : {}),
      ...(tokenEnv ? { token: resolveEnv(tokenEnv) ?? "" } : {}),
      projectId,
      mergeRequestIid,
      ...(reviewEvent?.baseSha ? { baseSha: reviewEvent.baseSha } : {}),
      ...(reviewEvent?.baseSha ? { startSha: reviewEvent.baseSha } : {}),
      ...(reviewEvent?.headSha ? { headSha: reviewEvent.headSha } : {}),
      channelName: channel.name,
    });

    return {
      handlesRendering: true,
      noProblemsAction,
      async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
        return dispatcher.publishProblem(rendering.renderProblem(problem));
      },
    };
  }

  if (channel.kind === "gitea_issue") {
    if (!baseUrl || !owner || !repo || pullNumber === undefined) {
      return undefined;
    }

    const dispatcher = createGiteaIssueDispatcher({
      baseUrl,
      ...(tokenEnv ? { token: resolveEnv(tokenEnv) ?? "" } : {}),
      owner,
      repo,
      indexNumber: pullNumber,
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
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[]): Promise<DispatchResult> {
        const renderedProblems = summaryProblems ?? problems;
        return dispatcher.publishAggregatedProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems),
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
    const labelIds = Array.isArray(channelConfig.label_ids) && channelConfig.label_ids.every((value) => typeof value === "number")
      ? channelConfig.label_ids as readonly number[]
      : undefined;
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl,
      ...(tokenEnv ? { token: resolveEnv(tokenEnv) ?? "" } : {}),
      owner,
      repo,
      channelName: channel.name,
      ...(markerPrefix ? { markerPrefix } : {}),
      ...(markerLabel ? { markerLabel } : {}),
      ...(labelIds ? { labelIds } : {}),
      ...(resolvedAction === "none" || resolvedAction === "close" || resolvedAction === "delete" ? { resolvedAction } : {}),
    });

    return {
      handlesRendering: true,
      publishesProblems: false,
      noProblemsAction,
      publishEmptySummary,
      async publishProblem(): Promise<DispatchResult> {
        return { channel: channel.name, status: "published", raw: { collected: true } };
      },
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[]): Promise<readonly DispatchResult[]> {
        const renderedProblems = (summaryProblems ?? []).map((problem) => rendering.renderProblem(problem));
        return dispatcher.reconcileProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems),
        );
      },
    };
  }

  if (channel.kind === "feishu_bot") {
    const webhookUrlEnv = channelConfig.webhook_url_env as string | undefined;
    const webhookUrl = webhookUrlEnv ? resolveEnv(webhookUrlEnv) : undefined;
    if (!webhookUrl) {
      return undefined;
    }

    const feishuSecretEnv = channelConfig.secret_env as string | undefined;
    const feishuSecret = feishuSecretEnv ? resolveEnv(feishuSecretEnv) : undefined;
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
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[]): Promise<DispatchResult> {
        const renderedProblems = summaryProblems ?? problems;
        return dispatcher.publishAggregatedProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems),
          rendering.mentionText || undefined,
        );
      },
    };
  }

  if (channel.kind === "wecom_bot") {
    const webhookUrlEnv = channelConfig.webhook_url_env as string | undefined;
    const webhookUrl = webhookUrlEnv ? resolveEnv(webhookUrlEnv) : undefined;
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
      async publishSummary(summary: string, summaryProblems?: readonly ReviewProblem[]): Promise<DispatchResult> {
        const renderedProblems = summaryProblems ?? problems;
        return dispatcher.publishAggregatedProblems(
          renderedProblems,
          rendering.renderSummary(summary, renderedProblems),
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
  const workspace = config.workspaces.instances[context.reviewEvent.workspaceId];
  const workspaceChannels = workspace?.outputs?.[key];
  if (workspaceChannels && workspaceChannels.length > 0) {
    return uniqueChannelNames(workspaceChannels);
  }

  const routeChannels = config.outputs.routes?.rules
    .find((route) => routeMatchesEvent(route, context))
    ?.[key];
  if (routeChannels && routeChannels.length > 0) {
    return uniqueChannelNames(routeChannels);
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

export function createOutputPublisherResolverFromConfig(
  config: AppConfig,
  options: OutputPublisherConfigOptions = {},
): ReviewOutputPublisherResolver {
  return (context) => {
    const pullNumber = extractPullNumber(context.payload);
    const baseDir = options.baseDir ?? process.cwd();
    const linePublishers = resolveOutputChannelNames(config, context, "line_comments")
      .map((name) => createOutputPublisherFromConfig(
        config,
        name,
        pullNumber,
        context.reviewEvent.workspaceId,
        context.reviewEvent,
        baseDir,
      ))
      .filter((publisher): publisher is ReviewOutputPublisher => Boolean(publisher));
    const summaryPublishers = resolveOutputChannelNames(config, context, "summary")
      .map((name) => createOutputPublisherFromConfig(
        config,
        name,
        pullNumber,
        context.reviewEvent.workspaceId,
        context.reviewEvent,
        baseDir,
      ))
      .filter((publisher): publisher is ReviewOutputPublisher => Boolean(publisher));

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
): GitVcsAdapter | P4VcsAdapter {
  const p4Trigger = triggerName
    ? config.triggers.find((t) => t.name === triggerName && t.kind === "p4")
    : config.triggers.find((t) => t.kind === "p4");
  if (p4Trigger) {
    const triggerConfig = p4Trigger as Record<string, unknown>;
    const port = triggerConfig.port as string | undefined;
    const userEnv = triggerConfig.user_env as string | undefined;
    const ticketEnv = triggerConfig.ticket_env as string | undefined;
    const passwordEnv = triggerConfig.password_env as string | undefined;
    const workspace = triggerConfig.workspace as string | undefined;
    const depot = triggerConfig.depot_path as string | undefined;
    const streams = triggerConfig.streams as string[] | undefined;
    const watchPath = triggerConfig.watch_path as string[] | undefined;
    const includeCrFile = triggerConfig.include_cr_file as string[] | undefined;
    const excludeCrFile = triggerConfig.exclude_cr_file as string[] | undefined;

    const password = passwordEnv
      ? resolveEnv(passwordEnv)
      : ticketEnv
        ? resolveEnv(ticketEnv)
        : undefined;
    const user = userEnv ? resolveEnv(userEnv) : undefined;

    return createP4VcsAdapter({
      repositoryDir: resolve(repositoryDir),
      ...(port ? { port } : {}),
      ...(user ? { user } : {}),
      ...(password ? { password } : {}),
      ...(workspace ? { workspace } : {}),
      ...(depot ? { depot } : {}),
      ...(streams?.[0] ? { depot: streams[0] } : {}),
      ...(watchPath ? { watchPath } : {}),
      ...(includeCrFile ? { includeCrFile } : {}),
      ...(excludeCrFile ? { excludeCrFile } : {}),
    });
  }

  const gitTrigger = triggerName
    ? config.triggers.find((t) => t.name === triggerName && isGitRemoteTriggerKind(t.kind))
    : undefined;
  const gitTriggerConfig = gitTrigger as Record<string, unknown> | undefined;
  const remoteUrl = buildGitRemoteUrl(gitTriggerConfig?.base_url as string | undefined, repoRef);
  const tokenEnv = gitTriggerConfig?.token_env as string | undefined;
  const token = tokenEnv ? resolveEnv(tokenEnv) : undefined;

  return createGitVcsAdapter({
    repositoryDir: resolve(repositoryDir),
    allowDeepen: config.review.git?.allow_deepen ?? false,
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(token ? { token } : {}),
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

function resolveSummarizeModelFromConfig(config: AppConfig): ModelSpec | undefined {
  const summarizeRole = config.compression?.summarize_model_role ?? "light";
  const providers = config.llm.providers;
  if (providers.length === 0) return undefined;

  const fallbackEntry = config.llm.fallback_chain.find((entry) => entry.role === summarizeRole);
  if (!fallbackEntry) {
    return config.llm.fallback_chain.length > 0
      ? resolveModelSpecFromConfig(config, config.llm.fallback_chain[0]!.provider)
      : undefined;
  }

  return resolveModelSpecFromConfig(config, fallbackEntry.provider);
}

export async function bootstrapServerApp(options: BootstrapServerOptions): Promise<ServerAppOptions> {
  const { config, baseSystemPrompt, baseDir = process.cwd(), jobHandler } = options;

  const giteaConfig = resolveGiteaWebhookConfig(config);
  const githubConfig = resolveGenericWebhookConfig(config, "github");
  const gitlabConfig = resolveGenericWebhookConfig(config, "gitlab");
  const p4Config = resolveP4TriggerConfig(config);

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

  const compressionConfig = toCompressionConfig(config.compression);
  const summarizeModel = compressionConfig ? resolveSummarizeModelFromConfig(config) : undefined;
  const summarizeClient = summarizeModel ? createLlmClientFromModelSpec(summarizeModel) : undefined;

  const sourceRootResolver = buildSourceRootResolver(baseDir);
  const sandbox = await createSandboxBackendFromConfig(config);
  const agentAdapter = resolveAgentAdapterFromConfig(config);

  const orchestrationOptions: ServerReviewOrchestrationOptions = {
    baseSystemPrompt,
    sourceRootResolver,
    vcs: createVcsAdapterFromConfig(config, baseDir),
    vcsFactory: (sourceRoot: string, context: ReviewOrchestrationContext) =>
      createVcsAdapterFromConfig(config, sourceRoot, context.reviewEvent.triggerName, context.reviewEvent.repoRef),
    llm: llmClient,
    model,
    dryRun: false,
    outputPublisherResolver: createOutputPublisherResolverFromConfig(config, { baseDir }),
    sandbox,
    agentAdapter,
    agentTimeoutMs: config.agent.timeout_seconds * 1000,
    ...(compressionConfig ? { compression: compressionConfig } : {}),
    ...(summarizeModel ? { summarizeModel } : {}),
    ...(summarizeClient ? { summarizeClient } : {}),
  };

  const queue = await createQueueFromConfig(config);

  const rateLimiter = config.queue.rate_limit?.per_provider_rps
    ? createMultiProviderRateLimiter(config.queue.rate_limit.per_provider_rps)
    : undefined;

  let worker: QueueWorker | undefined;
  if (jobHandler) {
    const workersConfig = config.queue.workers;
    worker = createQueueWorker(jobHandler, {
      queue,
      concurrency: workersConfig?.concurrency ?? 4,
      perWorkspaceConcurrency: workersConfig?.per_workspace_concurrency ?? 1,
      lockTtlSeconds: workersConfig?.lock_ttl_seconds ?? 1800,
      ...(rateLimiter ? { rateLimiter } : {}),
    });
  }

  const triageOptions = resolveIssueTriageOptions(config, llmClient, model);
  const authConfig = resolveAuthConfig(config);

  return {
    ...(giteaConfig ? { gitea: giteaConfig } : {}),
    ...(githubConfig ? { github: githubConfig } : {}),
    ...(gitlabConfig ? { gitlab: gitlabConfig } : {}),
    ...(p4Config ? { p4: p4Config } : {}),
    reviewOrchestration: orchestrationOptions,
    ...(triageOptions ? { issueTriage: triageOptions } : {}),
    queue,
    ...(worker ? { worker } : {}),
    ...(config.server.path_prefix ? { pathPrefix: config.server.path_prefix } : {}),
    ...(authConfig ? { auth: authConfig } : {}),
    asyncTriggers: true,
  };
}

function resolveIssueTriageOptions(
  config: AppConfig,
  llmClient: ChatCompletionClient,
  model: ModelSpec,
): IssueTriageRuntimeOptions | undefined {
  const anyTriageEnabled = Object.values(config.workspaces.instances).some(
    (instance) => instance.triage?.enabled === true,
  );
  if (!anyTriageEnabled) {
    return undefined;
  }

  const giteaTrigger = config.triggers.find(
    (t) => t.kind === "gitea" || t.kind === "forgejo",
  );
  if (!giteaTrigger) {
    return undefined;
  }

  const triggerConfig = giteaTrigger as Record<string, unknown>;
  const baseUrl = (triggerConfig.base_url as string | undefined) ??
    config.server.base_url;
  const tokenEnv = triggerConfig.token_env as string | undefined;
  const token = tokenEnv ? resolveEnv(tokenEnv) : undefined;

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
