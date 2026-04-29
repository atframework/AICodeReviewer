import { resolve } from "node:path";

import { isPlainObject, type AppConfig, type ReviewEvent } from "@aicr/core";
import { createAgentAdapter, type AgentAdapter, type AgentKind } from "@aicr/agents";
import {
  createOpenAICompatibleChatClient,
  type ChatCompletionClient,
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

  const provider = providerId
    ? providers.find((p) => p.id === providerId)
    : providers[0];

  if (!provider) {
    throw new TypeError(`LLM provider "${providerId}" not found in configuration.`);
  }

  const fallbackEntry = config.llm.fallback_chain.find((entry) => entry.provider === provider.id);
  const modelId = fallbackEntry?.model ?? "gpt-4o-mini";

  return {
    providerKind: provider.kind as ModelProviderKind,
    providerId: provider.id,
    modelId,
    ...(provider.base_url ? { baseUrl: provider.base_url } : {}),
    ...(provider.api_key_env ? { apiKeyEnv: provider.api_key_env } : {}),
  };
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

export function bootstrapServerApp(options: BootstrapServerOptions): ServerAppOptions {
  const { config, baseSystemPrompt, baseDir = process.cwd() } = options;

  const giteaConfig = resolveGiteaWebhookConfig(config);

  const model = resolveModelSpecFromConfig(config);
  const llmClient = createLlmClientFromModelSpec(model);

  const sourceRootResolver = buildSourceRootResolver(baseDir);

  const orchestrationOptions: ServerReviewOrchestrationOptions = {
    baseSystemPrompt,
    sourceRootResolver,
    vcs: createVcsAdapterFromConfig(config, baseDir),
    llm: llmClient,
    model,
    dryRun: false,
    outputPublisherResolver: createOutputPublisherResolverFromConfig(config),
  };

  return {
    ...(giteaConfig ? { gitea: giteaConfig } : {}),
    reviewOrchestration: orchestrationOptions,
  };
}
