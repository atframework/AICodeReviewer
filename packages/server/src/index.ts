import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { ZodError } from "zod";

import { createAicrMetrics, formatPrometheusMetrics, recordReviewResult } from "./metrics.js";
import { saveRunSnapshot } from "./run-snapshot.js";
import type { AicrMetrics } from "./metrics.js";
import { createObservabilityApi, type ObservabilityApiOptions } from "./observability-api.js";
import { getDashboardHtml } from "./dashboard/index.js";
import type { StoreDb } from "@aicr/store";
import { insertReviewRun } from "@aicr/store";

const globalMetrics: AicrMetrics = createAicrMetrics();

import {
  prepareReviewPrompt,
  type PreparedReviewPrompt,
  type QueueWorker,
  type ReviewEvent,
  type ReviewQueue,
  type ReviewProvider,
} from "@aicr/core";
import type { ReviewDeduplicator } from "./review-deduplicator.js";
import {
  extractWebhookRepositoryRef,
  matchesWebhookRepo,
  translateWebhookToReviewEvent,
  type GiteaWebhookConfig,
  verifyWebhookSignature,
} from "./gitea-webhook.js";
import {
  enrichP4ReviewEvent,
  translateP4TriggerToReviewEvent,
  type P4TriggerConfig,
} from "./p4-webhook.js";
import {
  type IssueTriageRuntimeOptions,
  triageIssue,
  type TriageResult,
} from "./issue-triage.js";
import {
  createAuthMiddleware,
  type AuthConfig,
} from "./auth.js";
import {
  runReviewOrchestration,
  summarizeReviewOrchestrationForWebhook,
  type ServerReviewOrchestrationOptions,
} from "./review-orchestrator.js";

type GenericWebhookProvider = "github" | "gitlab";
type GenericWebhookConfigInput = GiteaWebhookConfig | readonly GiteaWebhookConfig[];

export interface ServerAppOptions {
  readonly gitea?: GiteaWebhookConfig;
  readonly forgejo?: GiteaWebhookConfig;
  readonly github?: GenericWebhookConfigInput;
  readonly gitlab?: GenericWebhookConfigInput;
  readonly p4?: P4TriggerConfig;
  readonly reviewPreparation?: ServerReviewPreparationOptions;
  readonly reviewOrchestration?: ServerReviewOrchestrationOptions;
  readonly issueTriage?: IssueTriageRuntimeOptions;
  readonly queue?: ReviewQueue;
  readonly worker?: QueueWorker;
  readonly pathPrefix?: string;
  readonly auth?: AuthConfig;
  readonly asyncTriggers?: boolean;
  readonly deduplicator?: ReviewDeduplicator;
  readonly runsDir?: string;
  readonly metrics?: AicrMetrics;
  readonly observability?: ObservabilityApiOptions;
  readonly store?: StoreDb;
}

export interface ServerReviewPreparationOptions {
  readonly baseSystemPrompt: string;
  readonly sourceRootResolver: (reviewEvent: ReviewEvent) => string | undefined;
  readonly changedPathsResolver?: (context: {
    reviewEvent: ReviewEvent;
    payload: unknown;
    provider: ReviewProvider;
    eventName: string;
  }) => readonly string[] | undefined;
  readonly operatorOverrides?: readonly string[];
  readonly memoryHints?: readonly string[];
  readonly maxPromptTokens?: number;
  readonly taskContextBuilder?: (
    reviewEvent: ReviewEvent,
    changedPaths: readonly string[],
  ) => string | undefined;
}

function summarizePreparedReviewPromptForWebhook(preparation: PreparedReviewPrompt): {
  changedPathCount: number;
  promptTokenEstimate: number;
  instructionCount: number;
  skillCount: number;
  droppedAssetCount: number;
} {
  return {
    changedPathCount: preparation.changedPaths.length,
    promptTokenEstimate: preparation.prompt.tokenEstimate,
    instructionCount: preparation.prompt.loadedInstructionRefs.length,
    skillCount: preparation.prompt.activatedSkillRefs.length,
    droppedAssetCount: preparation.prompt.droppedInstructionRefs.length,
  };
}

function registerGiteaLikeWebhook(
  app: Hono,
  provider: "gitea" | "forgejo",
  path: string,
  config: GiteaWebhookConfig | undefined,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  issueTriageOptions: IssueTriageRuntimeOptions | undefined,
  asyncTriggers: boolean,
  deduplicator: ReviewDeduplicator | undefined,
  runsDir: string | undefined,
  metrics: AicrMetrics,
  store: StoreDb | undefined,
): void {
  app.post(path, async (c) => {
    if (!config) {
      return c.json({ accepted: false, reason: "trigger_not_configured", provider }, 503);
    }

    const payload = await c.req.text();
    const signature =
      c.req.header("x-gitea-signature-256") ?? c.req.header("x-gitea-signature") ?? undefined;

    if (!verifyWebhookSignature(payload, config.webhookSecret, signature)) {
      return c.json({ accepted: false, reason: "invalid_signature", provider }, 401);
    }

    const eventName = c.req.header("x-gitea-event");

    if (!eventName) {
      return c.json({ accepted: false, reason: "missing_event_name", provider }, 400);
    }

    const decoded: unknown = (() => {
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        return undefined;
      }
    })();

    if (decoded === undefined) {
      return c.json({ accepted: false, reason: "invalid_json", provider }, 400);
    }

    let reviewEvent;
    try {
      reviewEvent = await translateWebhookToReviewEvent(provider, eventName, decoded, config);
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          {
            accepted: false,
            reason: "invalid_payload",
            provider,
            eventName,
            issues: error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          },
          400,
        );
      }
      throw error;
    }

    if (!reviewEvent) {
      return c.json({ accepted: false, reason: "unsupported_event", provider, eventName }, 202);
    }

    const ignoredLabels = shouldIgnoreByLabels(reviewEvent, reviewOrchestrationOptions?.ignoreLabelsResolver);
    if (ignoredLabels) {
      return c.json({ accepted: false, reason: "ignored_by_label", provider, eventName, matchedLabels: ignoredLabels }, 200);
    }

    return handleReviewOrchestration(c, provider, eventName, decoded, reviewEvent, reviewPreparationOptions, reviewOrchestrationOptions, issueTriageOptions, asyncTriggers, deduplicator, runsDir, metrics, store);
  });
}

function registerP4Trigger(
  app: Hono,
  config: P4TriggerConfig | undefined,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  asyncTriggers: boolean,
  deduplicator: ReviewDeduplicator | undefined,
  runsDir: string | undefined,
  metrics: AicrMetrics,
  store: StoreDb | undefined,
): void {
  app.post("/triggers/p4", async (c) => {
    if (!config) {
      return c.json({ accepted: false, reason: "trigger_not_configured", provider: "p4" }, 503);
    }

    const contentType = c.req.header("content-type") ?? "";
    let payload: unknown;

    if (contentType.includes("application/json")) {
      const rawPayload = await c.req.text();
      try {
        payload = JSON.parse(rawPayload) as unknown;
      } catch {
        return c.json({ accepted: false, reason: "invalid_json", provider: "p4" }, 400);
      }
    } else {
      const form = await c.req.parseBody();
      const change = typeof form.change === "string" ? form.change : typeof form.changelist === "string" ? form.changelist : typeof form.cl === "string" ? form.cl : "";
      const user = typeof form.user === "string" ? form.user : "";
      const client = typeof form.client === "string" ? form.client : "";
      const _description = typeof form.description === "string" ? form.description : "";
      const path = typeof form.path === "string" ? form.path : "";
      const depotPath = typeof form.depot_path === "string" ? form.depot_path : "";
      const oldChange = typeof form.old_change === "string" ? form.old_change : "";
      const filesRaw = typeof form.files === "string" ? form.files : "";
      const files = filesRaw
        ? filesRaw.split(/\r?\n/u).map((line: string) => line.trim()).filter(Boolean)
        : [];
      payload = {
        change,
        user,
        client,
        path,
        depot_path: depotPath,
        old_change: oldChange,
        files,
      };
    }

    let reviewEvent;
    try {
      reviewEvent = translateP4TriggerToReviewEvent(payload, config);
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          {
            accepted: false,
            reason: "invalid_payload",
            provider: "p4",
            issues: error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          },
          400,
        );
      }
      throw error;
    }

    if (!reviewEvent) {
      return c.json({ accepted: false, reason: "missing_changelist", provider: "p4" }, 400);
    }

    reviewEvent = await enrichP4ReviewEvent(reviewEvent, config);

    const decoded = payload;

    return handleReviewOrchestration(
      c, "p4", "change-commit", decoded, reviewEvent,
      reviewPreparationOptions, reviewOrchestrationOptions, undefined, asyncTriggers, deduplicator,
      runsDir,
      metrics,
      store,
    );
  });
}

function normalizeGenericWebhookConfigs(
  config: GenericWebhookConfigInput | undefined,
): readonly GiteaWebhookConfig[] {
  if (!config) {
    return [];
  }

  if (isGenericWebhookConfigArray(config)) {
    return config;
  }

  return [config];
}

function isGenericWebhookConfigArray(
  config: GenericWebhookConfigInput,
): config is readonly GiteaWebhookConfig[] {
  return Array.isArray(config);
}

function matchesGenericWebhookCredential(
  provider: GenericWebhookProvider,
  payload: string,
  config: GiteaWebhookConfig,
  credential: string | undefined,
): boolean {
  if (provider === "github") {
    return verifyWebhookSignature(payload, config.webhookSecret, credential);
  }

  return !config.webhookSecret || credential === config.webhookSecret;
}

function selectGenericWebhookConfig(
  provider: GenericWebhookProvider,
  payload: string,
  decoded: unknown,
  configs: readonly GiteaWebhookConfig[],
  credential: string | undefined,
): { readonly config?: GiteaWebhookConfig; readonly reason?: "invalid_signature" | "repository_not_configured" } {
  const repoRef = decoded === undefined ? undefined : extractWebhookRepositoryRef(provider, decoded);

  if (configs.length > 1 && repoRef) {
    const repoScopedConfigs = configs.filter((entry) => matchesWebhookRepo(entry, repoRef));
    if (repoScopedConfigs.length > 0) {
      const verifiedRepoConfigs = repoScopedConfigs.filter((entry) =>
        matchesGenericWebhookCredential(provider, payload, entry, credential),
      );
      const verifiedRepoConfig = verifiedRepoConfigs[0];

      return verifiedRepoConfig
        ? { config: verifiedRepoConfig }
        : { reason: "invalid_signature" };
    }

    const verifiedConfigs = configs.filter((entry) =>
      matchesGenericWebhookCredential(provider, payload, entry, credential),
    );
    return verifiedConfigs.length > 0
      ? { reason: "repository_not_configured" }
      : { reason: "invalid_signature" };
  }

  const verifiedConfigs = configs.filter((entry) =>
    matchesGenericWebhookCredential(provider, payload, entry, credential),
  );

  if (verifiedConfigs.length === 0) {
    return { reason: "invalid_signature" };
  }

  const verifiedConfig = verifiedConfigs[0];
  return verifiedConfig
    ? { config: verifiedConfig }
    : { reason: "invalid_signature" };
}

function registerGenericWebhook(
  app: Hono,
  provider: GenericWebhookProvider,
  path: string,
  config: GenericWebhookConfigInput | undefined,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  issueTriageOptions: IssueTriageRuntimeOptions | undefined,
  asyncTriggers: boolean,
  deduplicator: ReviewDeduplicator | undefined,
  runsDir: string | undefined,
  metrics: AicrMetrics,
  store: StoreDb | undefined,
): void {
  app.post(path, async (c) => {
    const configs = normalizeGenericWebhookConfigs(config);
    if (configs.length === 0) {
      return c.json({ accepted: false, reason: "trigger_not_configured", provider }, 503);
    }

    const payload = await c.req.text();
    const credential = provider === "github"
      ? c.req.header("x-hub-signature-256") ?? undefined
      : c.req.header("x-gitlab-token") ?? undefined;

    const decoded: unknown = (() => {
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        return undefined;
      }
    })();

    const selected = selectGenericWebhookConfig(provider, payload, decoded, configs, credential);
    if (!selected.config) {
      const status = selected.reason === "repository_not_configured" ? 202 : 401;
      return c.json({ accepted: false, reason: selected.reason, provider }, status);
    }

    const webhookConfig = selected.config;

    const eventName = provider === "github"
      ? c.req.header("x-github-event")
      : c.req.header("x-gitlab-event");

    if (!eventName) {
      return c.json({ accepted: false, reason: "missing_event_name", provider }, 400);
    }

    if (decoded === undefined) {
      return c.json({ accepted: false, reason: "invalid_json", provider }, 400);
    }

    let reviewEvent;
    try {
      reviewEvent = await translateWebhookToReviewEvent(provider, eventName, decoded, webhookConfig);
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          {
            accepted: false,
            reason: "invalid_payload",
            provider,
            eventName,
            issues: error.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          },
          400,
        );
      }
      throw error;
    }

    if (!reviewEvent) {
      return c.json({ accepted: false, reason: "unsupported_event", provider, eventName }, 202);
    }

    const ignoredLabels = shouldIgnoreByLabels(reviewEvent, reviewOrchestrationOptions?.ignoreLabelsResolver);
    if (ignoredLabels) {
      return c.json({ accepted: false, reason: "ignored_by_label", provider, eventName, matchedLabels: ignoredLabels }, 200);
    }

    return handleReviewOrchestration(c, provider, eventName, decoded, reviewEvent, reviewPreparationOptions, reviewOrchestrationOptions, issueTriageOptions, asyncTriggers, deduplicator, runsDir, metrics, store);
  });
}

function shouldIgnoreByLabels(
  reviewEvent: ReviewEvent,
  ignoreLabelsResolver?: (workspaceId: string) => readonly string[],
): readonly string[] | undefined {
  const ignoreLabels = ignoreLabelsResolver?.(reviewEvent.workspaceId) ?? [];
  if (ignoreLabels.length === 0 || !reviewEvent.labels) {
    return undefined;
  }
  const matched = reviewEvent.labels.filter((label) => ignoreLabels.includes(label));
  return matched.length > 0 ? matched : undefined;
}

interface TriggerProcessingResult {
  readonly reviewPreparation?: ReturnType<typeof summarizePreparedReviewPromptForWebhook>;
  readonly reviewRun?: ReturnType<typeof summarizeReviewOrchestrationForWebhook>;
  readonly triage?: TriageResult;
}

class TriggerProcessingError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TriggerProcessingError";
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function publishTriggerErrorReport(
  context: {
    readonly reviewEvent: ReviewEvent;
    readonly payload: unknown;
    readonly provider: ReviewProvider;
    readonly eventName: string;
  },
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  runId: string,
  reason: string,
  message: string,
): Promise<void> {
  const publisher = reviewOrchestrationOptions?.outputPublisherResolver?.(context) ?? reviewOrchestrationOptions?.outputPublisher;
  if (!publisher?.publishSummary) {
    return;
  }

  const summary = [
    "## AICodeReviewer trigger processing failed",
    "",
    `- runId: ${runId}`,
    `- provider: ${context.provider}`,
    `- event: ${context.eventName}`,
    `- trigger: ${context.reviewEvent.triggerName}`,
    `- workspace: ${context.reviewEvent.workspaceId}`,
    `- repo: ${context.reviewEvent.repoRef}`,
    `- reason: ${reason}`,
    `- message: ${message}`,
  ].join("\n");

  try {
    await publisher.publishSummary(summary, [], { bypassNoProblemsPolicy: true });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed to publish trigger error report",
      runId,
      reason,
      error: toErrorMessage(error),
    }));
  }
}

async function runTriggerProcessing(
  provider: ReviewProvider,
  eventName: string,
  decoded: unknown,
  reviewEvent: ReviewEvent,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  issueTriageOptions: IssueTriageRuntimeOptions | undefined,
): Promise<TriggerProcessingResult> {
  let triageResult: TriageResult | undefined;
  if (reviewEvent.targetKind === "issue" && issueTriageOptions) {
    try {
      const issueNumber = reviewEvent.changedFiles?.[0];
      if (issueNumber) {
        const repoParts = reviewEvent.repoRef.split("/");
        const owner = repoParts[0];
        const repo = repoParts[1];
        if (owner && repo) {
          const issue = await issueTriageOptions.giteaClient.getIssue(
            owner,
            repo,
            Number(issueNumber),
          );
          const workspacePolicy = issueTriageOptions.workspacePolicies?.[reviewEvent.workspaceId];
          triageResult = await triageIssue(issue, {
            ...issueTriageOptions,
            ...(workspacePolicy?.actions ? { actions: workspacePolicy.actions } : {}),
            ...(workspacePolicy?.categoriesClose ? { categoriesClose: workspacePolicy.categoriesClose } : {}),
            ...(workspacePolicy?.dryRun !== undefined ? { dryRun: workspacePolicy.dryRun } : {}),
            ...(workspacePolicy?.customPrompt ? { customPrompt: workspacePolicy.customPrompt } : {}),
          });
        }
      }
    } catch (error) {
      throw new TriggerProcessingError("issue_triage_failed", toErrorMessage(error), 500);
    }
  }

  const isIssueEvent = reviewEvent.targetKind === "issue";

  let reviewPreparation;
  if (reviewPreparationOptions && !isIssueEvent) {
    try {
      const changedPaths = [
        ...(reviewPreparationOptions.changedPathsResolver?.({
          reviewEvent,
          payload: decoded,
          provider,
          eventName,
        }) ?? reviewEvent.changedFiles ?? []),
      ];
      const sourceRoot = reviewPreparationOptions.sourceRootResolver(reviewEvent);

      if (sourceRoot) {
        const taskContext = reviewPreparationOptions.taskContextBuilder?.(
          reviewEvent,
          changedPaths,
        );
        const prepared = await prepareReviewPrompt({
          reviewEvent,
          sourceRoot,
          changedPaths,
          baseSystemPrompt: reviewPreparationOptions.baseSystemPrompt,
          ...(reviewPreparationOptions.operatorOverrides
            ? { operatorOverrides: reviewPreparationOptions.operatorOverrides }
            : {}),
          ...(reviewPreparationOptions.memoryHints
            ? { memoryHints: reviewPreparationOptions.memoryHints }
            : {}),
          ...(reviewPreparationOptions.maxPromptTokens !== undefined
            ? { maxPromptTokens: reviewPreparationOptions.maxPromptTokens }
            : {}),
          ...(taskContext ? { taskContext } : {}),
        });
        reviewPreparation = summarizePreparedReviewPromptForWebhook(prepared);
      }
    } catch (error) {
      throw new TriggerProcessingError("review_preparation_failed", toErrorMessage(error), 500);
    }
  }

  let reviewRun;
  if (reviewOrchestrationOptions && !isIssueEvent) {
    try {
      const result = await runReviewOrchestration(
        {
          reviewEvent,
          payload: decoded,
          provider,
          eventName,
        },
        reviewOrchestrationOptions,
      );
      reviewRun = summarizeReviewOrchestrationForWebhook(result);
    } catch (error) {
      throw new TriggerProcessingError("review_orchestration_failed", toErrorMessage(error), 500);
    }
  }

  return {
    ...(reviewPreparation ? { reviewPreparation } : {}),
    ...(reviewRun ? { reviewRun } : {}),
    ...(triageResult ? { triage: triageResult } : {}),
  };
}

function recordCompletedReviewRun(
  metrics: AicrMetrics,
  reviewRun: NonNullable<TriggerProcessingResult["reviewRun"]>,
  durationMs: number,
): void {
  recordReviewResult(metrics, {
    status: reviewRun.status,
    problemCount: reviewRun.problemCount,
    durationMs,
  });
}

async function saveCompletedRunSnapshot(
  runsDir: string | undefined,
  runId: string,
  reviewEvent: ReviewEvent,
  reviewRun: NonNullable<TriggerProcessingResult["reviewRun"]>,
): Promise<void> {
  if (!runsDir) {
    return;
  }

  try {
    await saveRunSnapshot(runsDir, {
      runId,
      timestamp: new Date().toISOString(),
      reviewEvent,
      reviewRun,
    });
  } catch (err: unknown) {
    console.warn(JSON.stringify({
      level: "warn",
      msg: "failed to save run snapshot",
      runId,
      error: toErrorMessage(err),
    }));
  }
}

function persistReviewRunToStore(
  store: StoreDb | undefined,
  runId: string,
  reviewEvent: ReviewEvent,
  reviewRun: NonNullable<TriggerProcessingResult["reviewRun"]>,
  durationMs: number,
  startMs: number,
): void {
  if (!store) return;
  try {
    const status = reviewRun.status === "published"
      ? "succeeded"
      : reviewRun.status === "skipped"
        ? "skipped"
        : "skipped";
    insertReviewRun(store, {
      id: runId,
      eventId: runId,
      workspaceId: reviewEvent.workspaceId,
      triggerName: reviewEvent.triggerName ?? null,
      repoRef: reviewEvent.repoRef ?? null,
      provider: reviewRun.model?.providerId ?? null,
      providerModel: reviewRun.model?.modelId ?? null,
      status,
      startedAt: new Date(startMs),
      finishedAt: new Date(startMs + durationMs),
      durationMs,
      problemCount: reviewRun.problemCount,
      summaryCount: reviewRun.summaryCount,
      dispatchCount: reviewRun.dispatchCount,
      skipReason: reviewRun.skipReason ?? (reviewRun.status === "dry_run" ? "dry_run" : null),
      compressed: reviewRun.compressed ?? null,
      originalTokenEstimate: reviewRun.originalTokenEstimate ?? null,
      compressedTokenEstimate: reviewRun.compressedTokenEstimate ?? null,
      diffFileCount: reviewRun.diffFileCount ?? null,
      changedFileCount: reviewRun.changedFileCount ?? null,
      targetKind: reviewEvent.targetKind ?? null,
      targetUrl: reviewEvent.url ?? null,
      branch: reviewEvent.branch ?? null,
      headSha: reviewEvent.headSha ?? null,
      codeMetrics: {
        filesChanged: reviewRun.changedFileCount,
        filesAnalyzed: reviewRun.diffFileCount,
      },
      llmUsages: reviewRun.model ? [{
        providerId: reviewRun.model.providerId,
        modelId: reviewRun.model.modelId,
        tokensTotal: reviewRun.promptTokenEstimate,
      }] : [],
    });
  } catch (err: unknown) {
    console.warn(JSON.stringify({
      level: "warn",
      msg: "failed to persist review run to store",
      runId,
      error: toErrorMessage(err),
    }));
  }
}

function persistFailedRunToStore(
  store: StoreDb | undefined,
  runId: string,
  reviewEvent: ReviewEvent,
  durationMs: number,
  startMs: number,
  error: unknown,
): void {
  if (!store) return;
  try {
    insertReviewRun(store, {
      id: runId,
      eventId: runId,
      workspaceId: reviewEvent.workspaceId,
      triggerName: reviewEvent.triggerName ?? null,
      repoRef: reviewEvent.repoRef ?? null,
      provider: null,
      providerModel: null,
      status: "failed" as const,
      startedAt: new Date(startMs),
      finishedAt: new Date(startMs + durationMs),
      durationMs,
      error: toErrorMessage(error),
      targetKind: reviewEvent.targetKind ?? null,
      targetUrl: reviewEvent.url ?? null,
      branch: reviewEvent.branch ?? null,
      headSha: reviewEvent.headSha ?? null,
    });
  } catch (err: unknown) {
    console.warn(JSON.stringify({
      level: "warn",
      msg: "failed to persist failed run to store",
      runId,
      error: toErrorMessage(err),
    }));
  }
}

function scheduleTriggerProcessing(
  provider: ReviewProvider,
  eventName: string,
  decoded: unknown,
  reviewEvent: ReviewEvent,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  issueTriageOptions: IssueTriageRuntimeOptions | undefined,
  deduplicator: ReviewDeduplicator | undefined,
  metrics: AicrMetrics,
  runsDir: string | undefined,
  store: StoreDb | undefined,
): string {
  const runId = randomUUID();
  const context = { reviewEvent, payload: decoded, provider, eventName };

  if (deduplicator) {
    const dedupKey = deduplicator.computeKey(reviewEvent);
    const canSchedule = deduplicator.trySchedule(reviewEvent);
    if (!canSchedule) {
      deduplicator.setPending({ provider, eventName, decoded, reviewEvent });
      console.info(JSON.stringify({
        level: "info",
        msg: "trigger processing deduplicated: same target already running, queued for re-review",
        runId,
        dedupKey,
        provider,
        eventName,
        triggerName: reviewEvent.triggerName,
        workspaceId: reviewEvent.workspaceId,
        repoRef: reviewEvent.repoRef,
        ...(reviewEvent.headSha ? { headSha: reviewEvent.headSha } : {}),
        ...(reviewEvent.branch ? { branch: reviewEvent.branch } : {}),
        ...(reviewEvent.author?.username ? { author: reviewEvent.author.username } : {}),
        ...(reviewEvent.author?.email ? { authorEmail: reviewEvent.author.email } : {}),
      }));
      return runId;
    }
  }

  console.info(JSON.stringify({
    level: "info",
    msg: "trigger processing scheduled",
    runId,
    provider,
    eventName,
    triggerName: reviewEvent.triggerName,
    workspaceId: reviewEvent.workspaceId,
    repoRef: reviewEvent.repoRef,
    ...(reviewEvent.headSha ? { headSha: reviewEvent.headSha } : {}),
    ...(reviewEvent.branch ? { branch: reviewEvent.branch } : {}),
    ...(reviewEvent.author?.username ? { author: reviewEvent.author.username } : {}),
    ...(reviewEvent.author?.email ? { authorEmail: reviewEvent.author.email } : {}),
  }));

  function onCompleted(): void {
    if (!deduplicator) return;
    const pending = deduplicator.markCompleted(reviewEvent);
    if (pending) {
      scheduleTriggerProcessing(
        pending.provider,
        pending.eventName,
        pending.decoded,
        pending.reviewEvent,
        reviewPreparationOptions,
        reviewOrchestrationOptions,
        issueTriageOptions,
        deduplicator,
        metrics,
        runsDir,
        store,
      );
    }
  }

  setTimeout(() => {
    const startMs = Date.now();
    void runTriggerProcessing(
      provider,
      eventName,
      decoded,
      reviewEvent,
      reviewPreparationOptions,
      reviewOrchestrationOptions,
      issueTriageOptions,
    ).then((result) => {
      const durationMs = Date.now() - startMs;
      if (result.reviewRun) {
        recordCompletedReviewRun(metrics, result.reviewRun, durationMs);
        void saveCompletedRunSnapshot(runsDir, runId, reviewEvent, result.reviewRun);
        persistReviewRunToStore(store, runId, reviewEvent, result.reviewRun, durationMs, startMs);
      }
      console.info(JSON.stringify({
        level: "info",
        msg: "trigger processing completed",
        runId,
        provider,
        eventName,
        triggerName: reviewEvent.triggerName,
        workspaceId: reviewEvent.workspaceId,
        repoRef: reviewEvent.repoRef,
        ...(reviewEvent.headSha ? { headSha: reviewEvent.headSha } : {}),
        ...(reviewEvent.branch ? { branch: reviewEvent.branch } : {}),
        ...(reviewEvent.author?.username ? { author: reviewEvent.author.username } : {}),
        ...(reviewEvent.author?.email ? { authorEmail: reviewEvent.author.email } : {}),
        ...(result.reviewRun ? { reviewRun: result.reviewRun } : {}),
        ...(result.triage ? { triage: result.triage } : {}),
      }));
    }).catch((error) => {
      const durationMs = Date.now() - startMs;
      recordReviewResult(metrics, { status: "failed", durationMs });
      persistFailedRunToStore(store, runId, reviewEvent, durationMs, startMs, error);
      const reason = error instanceof TriggerProcessingError ? error.reason : "trigger_processing_failed";
      const message = toErrorMessage(error);
      console.error(JSON.stringify({
        level: "error",
        msg: "trigger processing failed",
        runId,
        provider,
        eventName,
        triggerName: reviewEvent.triggerName,
        workspaceId: reviewEvent.workspaceId,
        repoRef: reviewEvent.repoRef,
        ...(reviewEvent.headSha ? { headSha: reviewEvent.headSha } : {}),
        ...(reviewEvent.branch ? { branch: reviewEvent.branch } : {}),
        ...(reviewEvent.author?.username ? { author: reviewEvent.author.username } : {}),
        ...(reviewEvent.author?.email ? { authorEmail: reviewEvent.author.email } : {}),
        reason,
        error: message,
      }));
      void publishTriggerErrorReport(context, reviewOrchestrationOptions, runId, reason, message);
    }).finally(onCompleted);
  }, 0);

  return runId;
}

async function handleReviewOrchestration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  provider: ReviewProvider,
  eventName: string,
  decoded: unknown,
  reviewEvent: ReviewEvent,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  issueTriageOptions: IssueTriageRuntimeOptions | undefined,
  asyncTriggers: boolean,
  deduplicator: ReviewDeduplicator | undefined,
  runsDir: string | undefined,
  metrics: AicrMetrics,
  store: StoreDb | undefined,
): Promise<Response> {
  if (asyncTriggers) {
    const runId = scheduleTriggerProcessing(
      provider,
      eventName,
      decoded,
      reviewEvent,
      reviewPreparationOptions,
      reviewOrchestrationOptions,
      issueTriageOptions,
      deduplicator,
      metrics,
      runsDir,
      store,
    );

    return c.json({
      accepted: true,
      provider,
      eventName,
      reviewEvent,
      processing: {
        mode: "background",
        runId,
        status: "scheduled",
      },
    }, 202);
  }

  const runId = randomUUID();
  const startMs = Date.now();
  let result: TriggerProcessingResult;
  try {
    result = await runTriggerProcessing(
      provider,
      eventName,
      decoded,
      reviewEvent,
      reviewPreparationOptions,
      reviewOrchestrationOptions,
      issueTriageOptions,
    );
  } catch (error) {
    const durationMs = Date.now() - startMs;
    recordReviewResult(metrics, { status: "failed", durationMs });
    const reason = error instanceof TriggerProcessingError ? error.reason : "trigger_processing_failed";
    const status = error instanceof TriggerProcessingError ? error.status : 500;
    return c.json(
      {
        accepted: false,
        reason,
        provider,
        eventName,
        message: toErrorMessage(error),
      },
      status,
    );
  }

  const durationMs = Date.now() - startMs;
  if (result.reviewRun) {
    recordCompletedReviewRun(metrics, result.reviewRun, durationMs);
    await saveCompletedRunSnapshot(runsDir, runId, reviewEvent, result.reviewRun);
    persistReviewRunToStore(store, runId, reviewEvent, result.reviewRun, durationMs, startMs);
  }

  return c.json({
    accepted: true,
    provider,
    reviewEvent,
    ...result,
  }, 202);
}

export function createServerApp(options: ServerAppOptions = {}): Hono {
  const app = new Hono();
  const pathPrefix = options.pathPrefix ? normalizePathPrefix(options.pathPrefix) : undefined;

  if (pathPrefix) {
    registerPathPrefixedDashboardRedirects(app, pathPrefix);
    app.route(pathPrefix, createRoutedApp(options));
  } else {
    mountRoutes(app, options);
  }

  return app;
}

function normalizePathPrefix(pathPrefix: string): string {
  const normalized = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
  const trimmed = normalized.replace(/\/+$/u, "");
  return trimmed || "/";
}

function registerPathPrefixedDashboardRedirects(app: Hono, pathPrefix: string): void {
  if (pathPrefix === "/") {
    return;
  }

  const dashboardPath = `${pathPrefix}/dashboard`;
  app.get("/", (c) => c.redirect(dashboardPath));
  app.get("/dashboard", (c) => c.redirect(dashboardPath));
}

function registerDashboardRoutes(app: Hono, options: ServerAppOptions): void {
  const dashboardHtml = getDashboardHtml({ enabled: Boolean(options.observability) });
  app.get("/dashboard", (c) => c.html(dashboardHtml));
  app.get("/", (c) => c.html(dashboardHtml));
}

function createRoutedApp(options: ServerAppOptions): Hono {
  const sub = new Hono();
  mountRoutes(sub, options);
  return sub;
}

function mountRoutes(app: Hono, options: ServerAppOptions): void {
  const asyncTriggers = options.asyncTriggers ?? false;
  const metrics = options.metrics ?? globalMetrics;

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/readyz", (c) => c.text("ready"));
  app.get("/metrics", (c) => c.text(formatPrometheusMetrics(metrics)));
  registerDashboardRoutes(app, options);

  if (options.observability) {
    const observabilityApi = createObservabilityApi(options.observability);
    app.route("/api/admin", observabilityApi);
  }

  if (options.auth) {
    const authMiddleware = createAuthMiddleware(options.auth);
    app.use("/triggers/*", authMiddleware);
  }

  const runsDir = options.runsDir;

  registerGiteaLikeWebhook(
    app,
    "gitea",
    "/webhooks/gitea",
    options.gitea,
    options.reviewPreparation,
    options.reviewOrchestration,
    options.issueTriage,
    asyncTriggers,
    options.deduplicator,
    runsDir,
    metrics,
    options.store,
  );
  registerGiteaLikeWebhook(
    app,
    "forgejo",
    "/webhooks/forgejo",
    options.forgejo,
    options.reviewPreparation,
    options.reviewOrchestration,
    options.issueTriage,
    asyncTriggers,
    options.deduplicator,
    runsDir,
    metrics,
    options.store,
  );
  registerGenericWebhook(
    app,
    "github",
    "/webhooks/github",
    options.github,
    options.reviewPreparation,
    options.reviewOrchestration,
    options.issueTriage,
    asyncTriggers,
    options.deduplicator,
    runsDir,
    metrics,
    options.store,
  );
  registerGenericWebhook(
    app,
    "gitlab",
    "/webhooks/gitlab",
    options.gitlab,
    options.reviewPreparation,
    options.reviewOrchestration,
    options.issueTriage,
    asyncTriggers,
    options.deduplicator,
    runsDir,
    metrics,
    options.store,
  );
  registerP4Trigger(
    app,
    options.p4,
    options.reviewPreparation,
    options.reviewOrchestration,
    asyncTriggers,
    options.deduplicator,
    runsDir,
    metrics,
    options.store,
  );
}

export {
  formatParsedDiffForPrompt,
  runReviewOrchestration,
  summarizeReviewOrchestrationForWebhook,
} from "./review-orchestrator.js";
export type {
  DiffCapableVcsAdapter,
  ReviewOrchestrationResult,
  ReviewOrchestrationWebhookSummary,
  ReviewOutputPublisher,
  ReviewOutputPublisherResolver,
  ServerReviewOrchestrationOptions,
} from "./review-orchestrator.js";

export {
  bootstrapServerApp,
  buildSourceRootResolver,
  createLlmClientFromModelSpec,
  createOutputPublisherFromConfig,
  createOutputPublisherResolverFromConfig,
  createSandboxBackendFromConfig,
  createVcsAdapterFromConfig,
  resolveAgentAdapterFromConfig,
  resolveGiteaWebhookConfig,
  resolveGenericWebhookConfig,
  resolveGenericWebhookConfigs,
  resolveP4TriggerConfig,
  resolveModelSpecFromConfig,
} from "./bootstrap.js";
export type { BootstrapServerOptions } from "./bootstrap.js";

export { serve, serveAsync } from "./node-serve.js";
export type { ServeOptions } from "./node-serve.js";

export type { ObservabilityApiOptions } from "./observability-api.js";
export type { AdminAuthConfig } from "./admin-auth.js";
export {
  resolveAdminAuthConfig,
  createAdminAuthMiddleware,
} from "./admin-auth.js";

export {
  createReviewDeduplicator,
} from "./review-deduplicator.js";
export type {
  ReviewDeduplicator,
  DeduplicationTarget,
} from "./review-deduplicator.js";

export {
  GiteaApiClient,
  triageIssue,
  DEFAULT_TRIAGE_SYSTEM_PROMPT,
} from "./issue-triage.js";
export type {
  GiteaApiClientOptions,
  IssueComment,
  IssueDetails,
  IssueTriageOptions,
  IssueTriageRuntimeOptions,
  IssueRepository,
  TriageDecision,
  TriageResult,
  WorkspaceIssueTriagePolicy,
} from "./issue-triage.js";