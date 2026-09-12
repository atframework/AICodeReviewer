import { randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
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
  isTransientIoError,
  nextAllowedInstant,
  prepareReviewPrompt,
  vcsKindForProvider,
  type CompiledWeeklySchedule,
  type PreparedReviewPrompt,
  type QueueWorker,
  type ReviewEvent,
  type ReviewQueue,
  type ReviewProvider,
} from "@aicr/core";
import type { ReviewDeduplicator } from "./review-deduplicator.js";
import type { LiveRunRegistry } from "./live-runs.js";
import type { AutoCommitStore } from "@aicr/core";
import { isContextOverflowError, LlmFallbackExhaustedError } from "@aicr/llm";
import {
  extractWebhookRepositoryRef,
  matchesWebhookRepo,
  translateWebhookToReviewEvent,
  type VcsWebhookConfig,
  verifyWebhookSignature,
} from "./webhook-translator.js";
import {
  enrichP4ReviewEvent,
  translateP4TriggerToReviewEvent,
  type P4TriggerConfig,
} from "./p4-webhook.js";
import {
  translateSvnTriggerToReviewEvent,
  type SvnTriggerConfig,
} from "./svn-webhook.js";
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
  type ReviewOutputPublisher,
  type ServerReviewOrchestrationOptions,
} from "./review-orchestrator.js";
import {
  isAutomaticCommitEvent,
  type AutoCommitAcceptor,
} from "./auto-commit-runtime.js";
import {
  recordWebhookEvent,
  webhookEventFields,
} from "./webhook-events.js";
import type {
  ReviewDeferralManager,
} from "./deferral-manager.js";

type GenericWebhookProvider = "github" | "gitlab";

/** Provider delivery-id headers used for receipt deduplication. */
function deliveryIdForProvider(c: Context, provider: ReviewProvider): string | undefined {
  switch (provider) {
    case "github":
      return c.req.header("x-github-delivery");
    case "gitlab":
      return c.req.header("x-gitlab-event-uuid");
    case "gitea":
      return c.req.header("x-gitea-delivery");
    case "forgejo":
      return c.req.header("x-forgejo-delivery") ?? c.req.header("x-gitea-delivery");
    default:
      return undefined;
  }
}
type GenericWebhookConfigInput = VcsWebhookConfig | readonly VcsWebhookConfig[];

export interface TriggerRetryConfig {
  readonly attempts?: number;
  readonly backoff?: {
    readonly kind?: "exponential" | "linear" | "constant";
    readonly base_ms?: number;
    readonly max_ms?: number;
    readonly jitter?: boolean;
  };
}

export interface ServerAppOptions {
  readonly gitea?: VcsWebhookConfig;
  readonly forgejo?: VcsWebhookConfig;
  readonly github?: GenericWebhookConfigInput;
  readonly gitlab?: GenericWebhookConfigInput;
  readonly p4?: P4TriggerConfig;
  readonly svn?: SvnTriggerConfig;
  readonly reviewPreparation?: ServerReviewPreparationOptions;
  readonly reviewOrchestration?: ServerReviewOrchestrationOptions;
  readonly issueTriage?: IssueTriageRuntimeOptions;
  readonly queue?: ReviewQueue;
  readonly worker?: QueueWorker;
  readonly pathPrefix?: string;
  readonly auth?: AuthConfig;
  readonly asyncTriggers?: boolean;
  readonly deduplicator?: ReviewDeduplicator;
  readonly triggerRetry?: TriggerRetryConfig;
  readonly runsDir?: string;
  readonly metrics?: AicrMetrics;
  readonly observability?: ObservabilityApiOptions;
  /**
   * Automatic-commit receive path. When present, push/change-commit/
   * post-commit events are persisted as receipts and scheduled through the
   * auto-commit store instead of the in-memory timer path.
   */
  readonly autoCommit?: AutoCommitAcceptor;
  /** Auto-commit receipt store backing the admin receipt query API. */
  readonly autoCommitStore?: AutoCommitStore;
  /** Stop receipt execution, drain the active batch, then close its store. */
  readonly closeAutoCommit?: () => Promise<void>;
  /**
   * Weekly execution-window lookup. Receives the workspace and the event's
   * targetKind: pull_request events prefer the resolved
   * `review.pull_request.schedule` and fall back to the resolved
   * `review.auto_commit.schedule`; every other async target kind uses the
   * auto-commit schedule directly. Async trigger processing (PR/issue/comment
   * flows) defers the first attempt and every retry to the next allowed
   * instant; automatic-commit receipts are gated separately by the scheduler.
   * Omitted = every instant is allowed.
   */
  readonly getExecutionSchedule?: (workspaceId: string, targetKind?: string) => CompiledWeeklySchedule | undefined;
  /**
   * Branch allowlist lookup for automatic commit events, resolved from the
   * layered `review.auto_commit.include_branches` config. When the resolved
   * list is non-empty, push/change-commit/post-commit events whose branch is
   * not listed are ignored at receive time (decision `branch_not_watched`);
   * branchless events (P4/SVN hooks) are not filtered. Omitted = every
   * branch is accepted.
   */
  readonly getAutoCommitBranches?: (workspaceId: string) => readonly string[] | undefined;
  /**
   * Target-branch allowlist lookup for PR/MR analysis, resolved from the
   * layered `review.pull_request.include_target_branches` config. When the
   * resolved list is non-empty, pull_request events whose `targetBranch`
   * (base branch) is not listed are ignored at receive time (decision
   * `target_branch_not_watched`); events with an unknown target branch are
   * allowed through. Omitted = every target branch is accepted.
   */
  readonly getPullRequestTargetBranches?: (workspaceId: string) => readonly string[] | undefined;
  /**
   * Execution-window deferral registry for the async trigger path. When
   * present, window-deferred events persist (or memorize) and resume through
   * it instead of a bare setTimeout, so a restart can recover them.
   */
  readonly deferralManager?: ReviewDeferralManager;
  readonly store?: StoreDb;
  /**
   * In-memory registry of currently running analyses backing the dashboard
   * Live panel (`GET /api/admin/runs/live`). Bootstrap wires the same
   * instance into `reviewOrchestration.liveRuns` so runs report themselves.
   */
  readonly liveRuns?: LiveRunRegistry;
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
  config: VcsWebhookConfig | undefined,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  issueTriageOptions: IssueTriageRuntimeOptions | undefined,
  asyncTriggers: boolean,
  deduplicator: ReviewDeduplicator | undefined,
  runsDir: string | undefined,
  metrics: AicrMetrics,
  store: StoreDb | undefined,
  triggerRetry?: TriggerRetryConfig,
  autoCommit?: AutoCommitAcceptor,
  getExecutionSchedule?: (workspaceId: string, targetKind?: string) => CompiledWeeklySchedule | undefined,
  deferralManager?: ReviewDeferralManager,
  getAutoCommitBranches?: (workspaceId: string) => readonly string[] | undefined,
  getPullRequestTargetBranches?: (workspaceId: string) => readonly string[] | undefined,
): void {
  app.post(path, async (c) => {
    if (!config) {
      recordWebhookEvent(store, { provider, decision: "rejected", reason: "trigger_not_configured" });
      return c.json({ accepted: false, reason: "trigger_not_configured", provider }, 503);
    }

    const payload = await c.req.text();
    const signature =
      c.req.header("x-gitea-signature-256") ?? c.req.header("x-gitea-signature") ?? undefined;

    if (!verifyWebhookSignature(payload, config.webhookSecret, signature)) {
      recordWebhookEvent(store, { provider, decision: "rejected", reason: "invalid_signature" });
      return c.json({ accepted: false, reason: "invalid_signature", provider }, 401);
    }

    const normalizedEventName = c.req.header("x-gitea-event");
    const eventTypeName = c.req.header("x-gitea-event-type");
    const eventName = eventTypeName === "pull_request_review_request"
      ? eventTypeName
      : normalizedEventName;

    if (!eventName) {
      recordWebhookEvent(store, { provider, decision: "rejected", reason: "missing_event_name" });
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
      recordWebhookEvent(store, { provider, eventName, decision: "rejected", reason: "invalid_json" });
      return c.json({ accepted: false, reason: "invalid_json", provider }, 400);
    }

    let reviewEvent;
    try {
      reviewEvent = await translateWebhookToReviewEvent(provider, eventName, decoded, config);
    } catch (error) {
      if (error instanceof ZodError) {
        recordWebhookEvent(store, {
          provider,
          eventName,
          decision: "rejected",
          reason: "invalid_payload",
          detail: { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        });
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
      recordWebhookEvent(store, { provider, eventName, decision: "ignored", reason: "unsupported_event" });
      return c.json({ accepted: false, reason: "unsupported_event", provider, eventName }, 202);
    }

    const ignoredLabels = shouldIgnoreByLabels(reviewEvent, reviewOrchestrationOptions?.ignoreLabelsResolver);
    if (ignoredLabels) {
      recordWebhookEvent(store, {
        provider,
        eventName,
        decision: "ignored",
        reason: "ignored_by_label",
        detail: { matchedLabels: ignoredLabels },
        ...webhookEventFields(reviewEvent),
      });
      return c.json({ accepted: false, reason: "ignored_by_label", provider, eventName, matchedLabels: ignoredLabels }, 200);
    }

    return handleReviewOrchestration(c, provider, eventName, decoded, reviewEvent, reviewPreparationOptions, reviewOrchestrationOptions, issueTriageOptions, asyncTriggers, deduplicator, runsDir, metrics, store, triggerRetry, autoCommit, getExecutionSchedule, deferralManager, getAutoCommitBranches, getPullRequestTargetBranches);
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
  triggerRetry?: TriggerRetryConfig,
  autoCommit?: AutoCommitAcceptor,
  getExecutionSchedule?: (workspaceId: string, targetKind?: string) => CompiledWeeklySchedule | undefined,
  deferralManager?: ReviewDeferralManager,
  getAutoCommitBranches?: (workspaceId: string) => readonly string[] | undefined,
  getPullRequestTargetBranches?: (workspaceId: string) => readonly string[] | undefined,
): void {
  app.post("/triggers/p4", async (c) => {
    if (!config) {
      recordWebhookEvent(store, { provider: "p4", decision: "rejected", reason: "trigger_not_configured" });
      return c.json({ accepted: false, reason: "trigger_not_configured", provider: "p4" }, 503);
    }

    const contentType = c.req.header("content-type") ?? "";
    let payload: unknown;

    if (contentType.includes("application/json")) {
      const rawPayload = await c.req.text();
      try {
        payload = JSON.parse(rawPayload) as unknown;
      } catch {
        recordWebhookEvent(store, { provider: "p4", decision: "rejected", reason: "invalid_json" });
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
        recordWebhookEvent(store, {
          provider: "p4",
          eventName: "change-commit",
          decision: "rejected",
          reason: "invalid_payload",
          detail: { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        });
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
      recordWebhookEvent(store, { provider: "p4", eventName: "change-commit", decision: "rejected", reason: "missing_changelist" });
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
      triggerRetry,
      autoCommit,
      getExecutionSchedule,
      deferralManager,
      getAutoCommitBranches,
      getPullRequestTargetBranches,
    );
  });
}

function registerSvnTrigger(
  app: Hono,
  config: SvnTriggerConfig | undefined,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  asyncTriggers: boolean,
  deduplicator: ReviewDeduplicator | undefined,
  runsDir: string | undefined,
  metrics: AicrMetrics,
  store: StoreDb | undefined,
  triggerRetry?: TriggerRetryConfig,
  autoCommit?: AutoCommitAcceptor,
  getExecutionSchedule?: (workspaceId: string, targetKind?: string) => CompiledWeeklySchedule | undefined,
  deferralManager?: ReviewDeferralManager,
  getAutoCommitBranches?: (workspaceId: string) => readonly string[] | undefined,
  getPullRequestTargetBranches?: (workspaceId: string) => readonly string[] | undefined,
): void {
  app.post("/triggers/svn", async (c) => {
    if (!config) {
      recordWebhookEvent(store, { provider: "svn", decision: "rejected", reason: "trigger_not_configured" });
      return c.json({ accepted: false, reason: "trigger_not_configured", provider: "svn" }, 503);
    }

    const contentType = c.req.header("content-type") ?? "";
    let payload: unknown;

    if (contentType.includes("application/json")) {
      const rawPayload = await c.req.text();
      try {
        payload = JSON.parse(rawPayload) as unknown;
      } catch {
        recordWebhookEvent(store, { provider: "svn", decision: "rejected", reason: "invalid_json" });
        return c.json({ accepted: false, reason: "invalid_json", provider: "svn" }, 400);
      }
    } else {
      const form = await c.req.parseBody();
      const revision = typeof form.revision === "string"
        ? form.revision
        : typeof form.rev === "string"
          ? form.rev
          : typeof form.r === "string"
            ? form.r
            : "";
      const author = typeof form.author === "string" ? form.author : typeof form.user === "string" ? form.user : "";
      const baseRevision = typeof form.base_revision === "string"
        ? form.base_revision
        : typeof form.base_rev === "string"
          ? form.base_rev
          : typeof form.old_revision === "string"
            ? form.old_revision
            : "";
      const filesRaw = typeof form.changed_files === "string"
        ? form.changed_files
        : typeof form.files === "string"
          ? form.files
          : "";
      const files = filesRaw
        ? filesRaw.split(/\r?\n/u).map((line: string) => line.trim()).filter(Boolean)
        : [];
      payload = {
        revision,
        author,
        base_revision: baseRevision,
        files,
      };
    }

    let reviewEvent;
    try {
      reviewEvent = translateSvnTriggerToReviewEvent(payload, config);
    } catch (error) {
      if (error instanceof ZodError) {
        recordWebhookEvent(store, {
          provider: "svn",
          eventName: "post-commit",
          decision: "rejected",
          reason: "invalid_payload",
          detail: { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        });
        return c.json(
          {
            accepted: false,
            reason: "invalid_payload",
            provider: "svn",
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
      recordWebhookEvent(store, { provider: "svn", eventName: "post-commit", decision: "rejected", reason: "missing_revision" });
      return c.json({ accepted: false, reason: "missing_revision", provider: "svn" }, 400);
    }

    const decoded = payload;

    return handleReviewOrchestration(
      c, "svn", "post-commit", decoded, reviewEvent,
      reviewPreparationOptions, reviewOrchestrationOptions, undefined, asyncTriggers, deduplicator,
      runsDir,
      metrics,
      store,
      triggerRetry,
      autoCommit,
      getExecutionSchedule,
      deferralManager,
      getAutoCommitBranches,
      getPullRequestTargetBranches,
    );
  });
}

function normalizeGenericWebhookConfigs(
  config: GenericWebhookConfigInput | undefined,
): readonly VcsWebhookConfig[] {
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
): config is readonly VcsWebhookConfig[] {
  return Array.isArray(config);
}

function matchesGenericWebhookCredential(
  provider: GenericWebhookProvider,
  payload: string,
  config: VcsWebhookConfig,
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
  configs: readonly VcsWebhookConfig[],
  credential: string | undefined,
): { readonly config?: VcsWebhookConfig; readonly reason?: "invalid_signature" | "repository_not_configured" } {
  const repoRef = decoded === undefined ? undefined : extractWebhookRepositoryRef(provider, decoded);

  // Repo scoping applies when several profiles share the route OR any profile
  // declares repo constraints: a single constrained profile must reject
  // unlisted repositories instead of acting as a catch-all.
  const repoScopeEnforced = configs.length > 1 ||
    configs.some((entry) => entry.repoRef !== undefined || (entry.repoMappings?.length ?? 0) > 0);
  if (repoRef && repoScopeEnforced) {
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
  triggerRetry?: TriggerRetryConfig,
  autoCommit?: AutoCommitAcceptor,
  getExecutionSchedule?: (workspaceId: string, targetKind?: string) => CompiledWeeklySchedule | undefined,
  deferralManager?: ReviewDeferralManager,
  getAutoCommitBranches?: (workspaceId: string) => readonly string[] | undefined,
  getPullRequestTargetBranches?: (workspaceId: string) => readonly string[] | undefined,
): void {
  app.post(path, async (c) => {
    const configs = normalizeGenericWebhookConfigs(config);
    if (configs.length === 0) {
      recordWebhookEvent(store, { provider, decision: "rejected", reason: "trigger_not_configured" });
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
      recordWebhookEvent(store, {
        provider,
        decision: selected.reason === "repository_not_configured" ? "ignored" : "rejected",
        reason: selected.reason ?? "invalid_signature",
      });
      return c.json({ accepted: false, reason: selected.reason, provider }, status);
    }

    const webhookConfig = selected.config;

    const eventName = provider === "github"
      ? c.req.header("x-github-event")
      : c.req.header("x-gitlab-event");

    if (!eventName) {
      recordWebhookEvent(store, { provider, decision: "rejected", reason: "missing_event_name" });
      return c.json({ accepted: false, reason: "missing_event_name", provider }, 400);
    }

    if (decoded === undefined) {
      recordWebhookEvent(store, { provider, eventName, decision: "rejected", reason: "invalid_json" });
      return c.json({ accepted: false, reason: "invalid_json", provider }, 400);
    }

    let reviewEvent;
    try {
      reviewEvent = await translateWebhookToReviewEvent(provider, eventName, decoded, webhookConfig);
    } catch (error) {
      if (error instanceof ZodError) {
        recordWebhookEvent(store, {
          provider,
          eventName,
          decision: "rejected",
          reason: "invalid_payload",
          detail: { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        });
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
      recordWebhookEvent(store, { provider, eventName, decision: "ignored", reason: "unsupported_event" });
      return c.json({ accepted: false, reason: "unsupported_event", provider, eventName }, 202);
    }

    const ignoredLabels = shouldIgnoreByLabels(reviewEvent, reviewOrchestrationOptions?.ignoreLabelsResolver);
    if (ignoredLabels) {
      recordWebhookEvent(store, {
        provider,
        eventName,
        decision: "ignored",
        reason: "ignored_by_label",
        detail: { matchedLabels: ignoredLabels },
        ...webhookEventFields(reviewEvent),
      });
      return c.json({ accepted: false, reason: "ignored_by_label", provider, eventName, matchedLabels: ignoredLabels }, 200);
    }
    return handleReviewOrchestration(c, provider, eventName, decoded, reviewEvent, reviewPreparationOptions, reviewOrchestrationOptions, issueTriageOptions, asyncTriggers, deduplicator, runsDir, metrics, store, triggerRetry, autoCommit, getExecutionSchedule, deferralManager, getAutoCommitBranches, getPullRequestTargetBranches);
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

export type TriggerOutcome = "reviewed" | "triaged" | "prepared" | "skipped";

export interface TriggerProcessingResult {
  readonly outcome: TriggerOutcome;
  readonly skipReason?: string;
  readonly reviewPreparation?: ReturnType<typeof summarizePreparedReviewPromptForWebhook>;
  readonly reviewRun?: ReturnType<typeof summarizeReviewOrchestrationForWebhook>;
  readonly triage?: TriageResult;
}

class TriggerProcessingError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly status: ContentfulStatusCode,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
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
  let publisher: ReviewOutputPublisher | undefined;
  try {
    publisher = (await reviewOrchestrationOptions?.outputPublisherResolver?.(context)) ?? reviewOrchestrationOptions?.outputPublisher;
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed to resolve output publisher for trigger error report",
      runId,
      reason,
      error: toErrorMessage(error),
    }));
    return;
  }
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
    await publisher.publishSummary(summary, [], { bypassNoProblemsPolicy: true, skipReconcile: true });
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

export async function runTriggerProcessing(
  provider: ReviewProvider,
  eventName: string,
  decoded: unknown,
  reviewEvent: ReviewEvent,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  issueTriageOptions: IssueTriageRuntimeOptions | undefined,
  /** Identity of the scheduled execution; threaded into orchestration for live-run reporting. */
  execution?: { readonly runId: string; readonly attempt?: number },
): Promise<TriggerProcessingResult> {
  let triageResult: TriageResult | undefined;
  // The triage client speaks the Gitea/Forgejo API, so only Gitea-family issue
  // events may be triaged through it. Gate on the EVENT provider family rather
  // than a tag derived from trigger kind: a Forgejo trigger is served via the
  // Gitea route (provider "gitea"), so an equality check against the trigger
  // kind would silently skip Forgejo triage. GitHub/GitLab/P4 issues must be
  // skipped, otherwise they are triaged through an incompatible (and often
  // unreachable) Gitea client and surface as `fetch failed`.
  if (
    reviewEvent.targetKind === "issue" &&
    issueTriageOptions &&
    (provider === "gitea" || provider === "forgejo")
  ) {
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
            ...issueTriageOptions.modelOptionsResolver?.(reviewEvent.workspaceId),
            ...(workspacePolicy?.actions ? { actions: workspacePolicy.actions } : {}),
            ...(workspacePolicy?.categoriesClose ? { categoriesClose: workspacePolicy.categoriesClose } : {}),
            ...(workspacePolicy?.dryRun !== undefined ? { dryRun: workspacePolicy.dryRun } : {}),
            ...(workspacePolicy?.customPrompt ? { customPrompt: workspacePolicy.customPrompt } : {}),
          });
        }
      }
    } catch (error) {
      throw new TriggerProcessingError("issue_triage_failed", toErrorMessage(error), 500, error);
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
      throw new TriggerProcessingError("review_preparation_failed", toErrorMessage(error), 500, error);
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
          ...(execution
            ? {
              runId: execution.runId,
              ...(execution.attempt !== undefined ? { attempt: execution.attempt } : {}),
            }
            : {}),
        },
        reviewOrchestrationOptions,
      );
      reviewRun = summarizeReviewOrchestrationForWebhook(result);
    } catch (error) {
      const reason = error instanceof Error && error.name === "AgentContextOverflowError"
        ? "context_overflow"
        : error instanceof LlmFallbackExhaustedError && isContextOverflowError(error.lastError)
          ? "context_overflow"
          : "review_orchestration_failed";
      throw new TriggerProcessingError(reason, toErrorMessage(error), 500, error);
    }
  }

  let outcome: TriggerOutcome;
  let skipReason: string | undefined;
  if (triageResult) {
    outcome = "triaged";
  } else if (reviewRun) {
    outcome = "reviewed";
  } else if (reviewPreparation) {
    outcome = "prepared";
  } else {
    outcome = "skipped";
    skipReason = resolveTriggerSkipReason(
      reviewEvent,
      provider,
      issueTriageOptions,
      reviewPreparationOptions,
      reviewOrchestrationOptions,
    );
  }

  return {
    outcome,
    ...(skipReason ? { skipReason } : {}),
    ...(reviewPreparation ? { reviewPreparation } : {}),
    ...(reviewRun ? { reviewRun } : {}),
    ...(triageResult ? { triage: triageResult } : {}),
  };
}

function resolveTriggerSkipReason(
  reviewEvent: ReviewEvent,
  provider: ReviewProvider,
  issueTriageOptions: IssueTriageRuntimeOptions | undefined,
  reviewPreparationOptions: ServerReviewPreparationOptions | undefined,
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
): string {
  if (reviewEvent.targetKind === "issue") {
    const triageEligible = provider === "gitea" || provider === "forgejo";
    if (!triageEligible) {
      return `issue_triage_unsupported_provider:${provider}`;
    }
    if (!issueTriageOptions) {
      return "issue_triage_not_configured";
    }
    return "issue_triage_no_target_ref";
  }
  if (!reviewPreparationOptions && !reviewOrchestrationOptions) {
    return "review_pipeline_not_configured";
  }
  return "no_review_target_resolved";
}

function buildTriggerEventLogFields(reviewEvent: ReviewEvent): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    targetKind: reviewEvent.targetKind,
    action: reviewEvent.reason,
  };
  const issueNumber = reviewEvent.targetKind === "issue" ? reviewEvent.changedFiles?.[0] : undefined;
  if (issueNumber !== undefined) {
    fields.number = issueNumber;
  }
  if (reviewEvent.title) fields.title = reviewEvent.title;
  if (reviewEvent.url) fields.url = reviewEvent.url;
  if (reviewEvent.labels?.length) fields.labels = reviewEvent.labels;
  if (reviewEvent.headSha) fields.headSha = reviewEvent.headSha;
  if (reviewEvent.baseSha) fields.baseSha = reviewEvent.baseSha;
  if (reviewEvent.branch) fields.branch = reviewEvent.branch;
  if (reviewEvent.author?.username) fields.author = reviewEvent.author.username;
  if (reviewEvent.author?.email) fields.authorEmail = reviewEvent.author.email;
  return fields;
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

export function persistReviewRunToStore(
  store: StoreDb | undefined,
  runId: string,
  reviewEvent: ReviewEvent,
  reviewRun: NonNullable<TriggerProcessingResult["reviewRun"]>,
  durationMs: number,
  startMs: number,
  strict = false,
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
      promptTokenEstimate: reviewRun.promptTokenEstimate,
      diffFileCount: reviewRun.diffFileCount ?? null,
      changedFileCount: reviewRun.changedFileCount ?? null,
      targetKind: reviewEvent.targetKind ?? null,
      targetUrl: reviewEvent.url ?? null,
      branch: reviewEvent.branch ?? null,
      headSha: reviewRun.headSha ?? reviewEvent.headSha ?? null,
      vcsKind: reviewRun.vcsKind ?? vcsKindForProvider(reviewEvent.provider) ?? null,
      headCommittedAt: reviewRun.headCommittedAt ? new Date(reviewRun.headCommittedAt) : null,
      codeMetrics: {
        filesChanged: reviewRun.changedFileCount,
        filesAnalyzed: reviewRun.diffFileCount,
      },
      llmUsages: reviewRun.model ? [{
        providerId: reviewRun.model.providerId,
        modelId: reviewRun.model.modelId,
        // Prefer real provider-reported usage; absent for agent runs without parseable
        // step-finish events, in which case the store falls back to 0 and the dashboard
        // surfaces promptTokenEstimate separately rather than mixing it in here.
        ...(reviewRun.llmUsage?.promptTokens !== undefined ? { tokensIn: reviewRun.llmUsage.promptTokens } : {}),
        ...(reviewRun.llmUsage?.completionTokens !== undefined ? { tokensOut: reviewRun.llmUsage.completionTokens } : {}),
        ...(reviewRun.llmUsage?.totalTokens !== undefined ? { tokensTotal: reviewRun.llmUsage.totalTokens } : {}),
        ...(reviewRun.llmUsage?.cachedPromptTokens !== undefined ? { cachedTokens: reviewRun.llmUsage.cachedPromptTokens } : {}),
        ...(reviewRun.llmUsage?.cacheCreationTokens !== undefined ? { cacheCreationTokens: reviewRun.llmUsage.cacheCreationTokens } : {}),
        ...(reviewRun.estimatedCostUsd !== undefined ? { costUsd: reviewRun.estimatedCostUsd } : {}),
        ...(reviewRun.requestCount !== undefined ? { requestCount: reviewRun.requestCount } : {}),
        ...(reviewRun.retryCount !== undefined ? { retryCount: reviewRun.retryCount } : {}),
        ...(reviewRun.fallbackCount !== undefined ? { fallbackCount: reviewRun.fallbackCount } : {}),
      }] : [],
    });
  } catch (err: unknown) {
    if (strict) throw err;
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
      vcsKind: vcsKindForProvider(reviewEvent.provider) ?? null,
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

function computeBackoff(
  baseMs: number,
  maxMs: number,
  attempt: number,
  kind: "exponential" | "linear" | "constant",
  jitter: boolean,
): number {
  let delay: number;
  if (kind === "exponential") {
    delay = baseMs * Math.pow(2, attempt - 1);
  } else if (kind === "linear") {
    delay = baseMs * attempt;
  } else {
    delay = baseMs;
  }
  if (jitter) {
    delay = delay * (0.5 + Math.random() * 0.5);
  }
  return Math.min(Math.round(delay), maxMs);
}

/**
 * Reply on the PR/MR when a comment-command review is deferred by the
 * execution window, telling the requester when the run will start. Uses the
 * same output-publisher channel as trigger error reports; failures only log.
 */
async function publishDeferralNotice(
  context: {
    readonly reviewEvent: ReviewEvent;
    readonly payload: unknown;
    readonly provider: ReviewProvider;
    readonly eventName: string;
  },
  reviewOrchestrationOptions: ServerReviewOrchestrationOptions | undefined,
  runId: string,
  resumeAtMs: number,
  timezone: string | undefined,
): Promise<void> {
  let publisher: ReviewOutputPublisher | undefined;
  try {
    publisher = (await reviewOrchestrationOptions?.outputPublisherResolver?.(context)) ?? reviewOrchestrationOptions?.outputPublisher;
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed to resolve output publisher for deferral notice",
      runId,
      error: toErrorMessage(error),
    }));
    return;
  }
  if (!publisher?.publishSummary) {
    return;
  }

  const resumeAt = new Date(resumeAtMs);
  const summary = [
    "## AICodeReviewer review deferred",
    "",
    "This review request was received outside the configured execution window and will start at the next allowed instant.",
    "",
    `- scheduled start: ${resumeAt.toISOString()}${timezone ? ` (${timezone})` : ""}`,
    `- runId: ${runId}`,
    `- provider: ${context.provider}`,
    `- event: ${context.eventName}`,
    `- trigger: ${context.reviewEvent.triggerName}`,
    `- workspace: ${context.reviewEvent.workspaceId}`,
    `- repo: ${context.reviewEvent.repoRef}`,
  ].join("\n");

  try {
    await publisher.publishSummary(summary, [], { bypassNoProblemsPolicy: true, skipReconcile: true });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      msg: "failed to publish deferral notice",
      runId,
      error: toErrorMessage(error),
    }));
  }
}

/** Node setTimeout clamps delays above the signed 32-bit range; stay below. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Clamp a planned timer delay so the attempt starts inside the workspace
 * execution window. A planned instant that is already allowed is returned
 * unchanged; otherwise the attempt waits for the next window to open. The
 * schedule is consulted only through this helper, so the retry path and the
 * first-attempt path share one gate.
 */
function clampDelayToExecutionWindow(
  schedule: CompiledWeeklySchedule | undefined,
  plannedDelayMs: number,
  now: number,
): { delayMs: number; resumeAt: number; deferred: boolean } {
  const plannedAt = now + Math.max(0, plannedDelayMs);
  if (!schedule) {
    return { delayMs: Math.max(0, plannedDelayMs), resumeAt: plannedAt, deferred: false };
  }
  const resumeAt = nextAllowedInstant(schedule, plannedAt);
  return {
    delayMs: Math.min(Math.max(0, resumeAt - now), MAX_TIMER_DELAY_MS),
    resumeAt,
    deferred: resumeAt > plannedAt,
  };
}

export type TriggerDisposition = "scheduled" | "deduplicated" | "deferred";

export interface TriggerSchedulingResult {
  readonly runId: string;
  readonly disposition: TriggerDisposition;
  /** Next allowed instant (ms epoch) when disposition is "deferred". */
  readonly resumeAt?: number;
}

export interface TriggerSchedulingExtras {
  readonly getExecutionSchedule?: (workspaceId: string, targetKind?: string) => CompiledWeeklySchedule | undefined;
  readonly deferralManager?: ReviewDeferralManager;
  /**
   * Internal: set when re-entering from a fired deferral timer. The window
   * clamp still applies (a window that closed during a process pause simply
   * re-defers), but the comment-command deferral notice is not re-published.
   */
  readonly deferralResume?: boolean;
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
  triggerRetry?: TriggerRetryConfig,
  extras?: TriggerSchedulingExtras,
): TriggerSchedulingResult {
  const runId = randomUUID();
  const context = { reviewEvent, payload: decoded, provider, eventName };
  // Resolved once per scheduling round: config is static for the process
  // lifetime, and every timer this function arms passes through the window
  // clamp below.
  const executionSchedule = extras?.getExecutionSchedule?.(reviewEvent.workspaceId, reviewEvent.targetKind);
  const initial = clampDelayToExecutionWindow(executionSchedule, 0, Date.now());

  // Persist outside-window arrivals even when another review is still
  // running. Waiting must not acquire or release that run's dedup ownership.
  if (deduplicator && !(initial.deferred && extras?.deferralManager)) {
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
        ...buildTriggerEventLogFields(reviewEvent),
      }));
      return { runId, disposition: "deduplicated" };
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
    ...buildTriggerEventLogFields(reviewEvent),
  }));

  const maxAttempts = triggerRetry?.attempts ?? 3;
  const backoffBaseMs = triggerRetry?.backoff?.base_ms ?? 5000;
  const backoffMaxMs = triggerRetry?.backoff?.max_ms ?? 60000;
  const backoffKind = triggerRetry?.backoff?.kind ?? "exponential";
  const backoffJitter = triggerRetry?.backoff?.jitter ?? true;

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
        triggerRetry,
        extras,
      );
    }
  }

  function runAttempt(attemptNumber: number): void {
    // Timers may fire after a pause or clock adjustment. Check the actual
    // start instant too, including retries and the no-manager fallback.
    const windowed = clampDelayToExecutionWindow(executionSchedule, 0, Date.now());
    if (windowed.deferred) {
      if (attemptNumber === 1 && extras?.deferralManager) {
        extras.deferralManager.defer({ provider, eventName, decoded, reviewEvent }, windowed.resumeAt);
        onCompleted();
      } else {
        setTimeout(() => runAttempt(attemptNumber), windowed.delayMs);
      }
      return;
    }
    const startMs = Date.now();
    void runTriggerProcessing(
      provider,
      eventName,
      decoded,
      reviewEvent,
      reviewPreparationOptions,
      reviewOrchestrationOptions,
      issueTriageOptions,
      { runId, attempt: attemptNumber },
    ).then((result) => {
      const durationMs = Date.now() - startMs;
      if (result.reviewRun) {
        recordCompletedReviewRun(metrics, result.reviewRun, durationMs);
        void saveCompletedRunSnapshot(runsDir, runId, reviewEvent, result.reviewRun);
        persistReviewRunToStore(store, runId, reviewEvent, result.reviewRun, durationMs, startMs);
      }
      console.info(JSON.stringify({
        level: "info",
        msg: result.outcome === "skipped"
          ? "trigger processing skipped"
          : "trigger processing completed",
        runId,
        provider,
        eventName,
        triggerName: reviewEvent.triggerName,
        workspaceId: reviewEvent.workspaceId,
        repoRef: reviewEvent.repoRef,
        outcome: result.outcome,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
        ...buildTriggerEventLogFields(reviewEvent),
        ...(result.reviewRun ? { reviewRun: result.reviewRun } : {}),
        ...(result.triage ? { triage: result.triage } : {}),
      }));
      onCompleted();
    }).catch((error) => {
      const durationMs = Date.now() - startMs;
      const reason = error instanceof TriggerProcessingError ? error.reason : "trigger_processing_failed";
      const message = toErrorMessage(error);
      // TriggerProcessingError.status is the local webhook response status, not
      // an upstream IO status. Classify the preserved cause and use the message
      // only for legacy/custom errors that have no cause.
      const retryTarget = error instanceof TriggerProcessingError
        ? error.cause ?? new Error(error.message)
        : error;
      const retryable = reason !== "context_overflow"
        && isTransientIoError(retryTarget);

      if (retryable && attemptNumber < maxAttempts) {
        const backoffMs = computeBackoff(backoffBaseMs, backoffMaxMs, attemptNumber, backoffKind, backoffJitter);
        // Retries start new work: clamp the planned backoff to the execution
        // window instead of letting a window close mid-retry-chain.
        const windowed = clampDelayToExecutionWindow(executionSchedule, backoffMs, Date.now());
        console.warn(JSON.stringify({
          level: "warn",
          msg: "trigger processing failed, retrying",
          runId,
          attempt: attemptNumber,
          maxAttempts,
          nextRetryInMs: windowed.delayMs,
          ...(windowed.deferred
            ? { windowDeferred: true, resumeAt: new Date(windowed.resumeAt).toISOString() }
            : {}),
          provider,
          eventName,
          triggerName: reviewEvent.triggerName,
          workspaceId: reviewEvent.workspaceId,
          repoRef: reviewEvent.repoRef,
          ...buildTriggerEventLogFields(reviewEvent),
          reason,
          error: message,
        }));
        setTimeout(() => runAttempt(attemptNumber + 1), windowed.delayMs);
        return;
      }

      recordReviewResult(metrics, { status: "failed", durationMs });
      persistFailedRunToStore(store, runId, reviewEvent, durationMs, startMs, error);
      console.error(JSON.stringify({
        level: "error",
        msg: "trigger processing failed",
        runId,
        provider,
        eventName,
        triggerName: reviewEvent.triggerName,
        workspaceId: reviewEvent.workspaceId,
        repoRef: reviewEvent.repoRef,
        ...buildTriggerEventLogFields(reviewEvent),
        reason,
        error: message,
        ...(attemptNumber > 1 ? { attempts: attemptNumber } : {}),
      }));
      void publishTriggerErrorReport(context, reviewOrchestrationOptions, runId, reason, message);
      onCompleted();
    });
  }

  if (initial.deferred) {
    console.info(JSON.stringify({
      level: "info",
      msg: "trigger processing deferred by execution window",
      runId,
      deferMs: initial.delayMs,
      resumeAt: new Date(initial.resumeAt).toISOString(),
      provider,
      eventName,
      triggerName: reviewEvent.triggerName,
      workspaceId: reviewEvent.workspaceId,
      repoRef: reviewEvent.repoRef,
      ...buildTriggerEventLogFields(reviewEvent),
    }));
    // Persist (or memorize) through the deferral manager when available so a
    // restart can recover the pending run; otherwise the bare timer below is
    // the pre-persistence in-memory behavior.
    if (extras?.deferralManager) {
      extras.deferralManager.defer({ provider, eventName, decoded, reviewEvent }, initial.resumeAt);
    } else {
      setTimeout(() => runAttempt(1), initial.delayMs);
    }
    // A comment-command review is an explicit user request: reply on the
    // PR/MR with the scheduled start so the requester is not left guessing.
    // Resumed deferrals already notified on first receipt.
    if (!extras?.deferralResume && reviewEvent.reason.endsWith(":comment_review")) {
      void publishDeferralNotice(context, reviewOrchestrationOptions, runId, initial.resumeAt, executionSchedule?.timezone);
    }
    return { runId, disposition: "deferred", resumeAt: initial.resumeAt };
  }
  // A fresh in-window event supersedes any deferral still pending for the
  // same target: this execution reviews the newest state.
  extras?.deferralManager?.cancel(reviewEvent);
  setTimeout(() => runAttempt(1), 0);

  return { runId, disposition: "scheduled" };
}

async function handleReviewOrchestration(
  c: Context,
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
  triggerRetry?: TriggerRetryConfig,
  autoCommit?: AutoCommitAcceptor,
  getExecutionSchedule?: (workspaceId: string, targetKind?: string) => CompiledWeeklySchedule | undefined,
  deferralManager?: ReviewDeferralManager,
  getAutoCommitBranches?: (workspaceId: string) => readonly string[] | undefined,
  getPullRequestTargetBranches?: (workspaceId: string) => readonly string[] | undefined,
): Promise<Response> {
  // Branch allowlist gate for automatic commit events: a workspace that
  // resolves `review.auto_commit.include_branches` only accepts receipts for
  // the listed branches. The check runs before persistence so off-branch
  // pushes leave no receipts behind; PR/issue/comment flows are unaffected,
  // and branchless hooks (P4/SVN) cannot be misclassified.
  if (isAutomaticCommitEvent(reviewEvent, eventName) && reviewEvent.branch) {
    const watchedBranches = getAutoCommitBranches?.(reviewEvent.workspaceId);
    if (watchedBranches && watchedBranches.length > 0 && !watchedBranches.includes(reviewEvent.branch)) {
      recordWebhookEvent(store, {
        provider,
        eventName,
        decision: "ignored",
        reason: "branch_not_watched",
        detail: { branch: reviewEvent.branch },
        ...webhookEventFields(reviewEvent),
      });
      return c.json({ accepted: false, reason: "branch_not_watched", provider, eventName, branch: reviewEvent.branch }, 200);
    }
  }
  // Target-branch allowlist gate for PR/MR analysis: a workspace that
  // resolves `review.pull_request.include_target_branches` only analyzes
  // PRs/MRs whose base branch is listed. The check runs at receive time,
  // before dedup/scheduling, so off-target PRs leave no runs behind; push,
  // issue, and manual flows are unaffected. An unknown target branch
  // (comment-command enrichment failure) fails open so an explicit user
  // command is never dropped by a transient fetch error.
  if (reviewEvent.targetKind === "pull_request" && reviewEvent.targetBranch) {
    const watchedTargetBranches = getPullRequestTargetBranches?.(reviewEvent.workspaceId);
    if (watchedTargetBranches && watchedTargetBranches.length > 0 && !watchedTargetBranches.includes(reviewEvent.targetBranch)) {
      recordWebhookEvent(store, {
        provider,
        eventName,
        decision: "ignored",
        reason: "target_branch_not_watched",
        detail: { branch: reviewEvent.targetBranch },
        ...webhookEventFields(reviewEvent),
      });
      return c.json({ accepted: false, reason: "target_branch_not_watched", provider, eventName, branch: reviewEvent.targetBranch }, 200);
    }
  }
  // Automatic commit events (push/change-commit/post-commit) take the
  // persistent receive path: one bounded write, then 202 with the receipt.
  // PR/issue/comment/manual flows keep the existing direct/async handling.
  if (autoCommit && isAutomaticCommitEvent(reviewEvent, eventName)) {
    try {
      const deliveryId = deliveryIdForProvider(c, provider);
      const result = await autoCommit.accept({
        provider,
        eventName,
        reviewEvent,
        ...(deliveryId ? { deliveryId } : {}),
        now: Date.now(),
      });
      recordWebhookEvent(store, {
        provider,
        eventName,
        decision: result.duplicate ? "duplicate" : "queued",
        detail: {
          receiptId: result.receipt.receiptId,
          // Eligibility is a lower bound: metadata, earlier batches and
          // capacity can delay execution further.
          notBefore: new Date(clampDelayToExecutionWindow(
            getExecutionSchedule?.(reviewEvent.workspaceId, reviewEvent.targetKind),
            0,
            Math.max(Date.now(), result.receipt.firstAcceptedAt + result.receipt.delaySeconds * 1000),
          ).resumeAt).toISOString(),
        },
        ...webhookEventFields(reviewEvent),
      });
      return c.json({
        accepted: true,
        provider,
        eventName,
        reviewEvent,
        processing: {
          mode: "queued",
          // runId is retained as the receive-receipt number (design §7.1);
          // one push may split into several runs and several pushes may
          // merge into one, so it no longer denotes an execution unit.
          runId: result.receipt.receiptId,
          receiptId: result.receipt.receiptId,
          status: result.duplicate ? "duplicate" : "queued",
        },
      }, 202);
    } catch (error) {
      // Persistence failure is a retryable 503 — never a false acceptance.
      recordWebhookEvent(store, {
        provider,
        eventName,
        decision: "rejected",
        reason: "auto_commit_receive_failed",
        detail: { message: toErrorMessage(error) },
        ...webhookEventFields(reviewEvent),
      });
      return c.json(
        {
          accepted: false,
          reason: "auto_commit_receive_failed",
          provider,
          eventName,
          message: toErrorMessage(error),
        },
        503,
      );
    }
  }
  if (asyncTriggers) {
    const scheduled = scheduleTriggerProcessing(
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
      triggerRetry,
      { ...(getExecutionSchedule ? { getExecutionSchedule } : {}), ...(deferralManager ? { deferralManager } : {}) },
    );

    if (scheduled.disposition === "deferred") {
      recordWebhookEvent(store, {
        provider,
        eventName,
        decision: "deferred",
        reason: "execution_window",
        detail: {
          runId: scheduled.runId,
          ...(scheduled.resumeAt ? { resumeAt: new Date(scheduled.resumeAt).toISOString() } : {}),
        },
        ...webhookEventFields(reviewEvent),
      });
    } else if (scheduled.disposition === "deduplicated") {
      recordWebhookEvent(store, {
        provider,
        eventName,
        decision: "deduplicated",
        detail: { runId: scheduled.runId },
        ...webhookEventFields(reviewEvent),
      });
    } else {
      recordWebhookEvent(store, {
        provider,
        eventName,
        decision: "executed",
        detail: { mode: "background", runId: scheduled.runId },
        ...webhookEventFields(reviewEvent),
      });
    }

    return c.json({
      accepted: true,
      provider,
      eventName,
      reviewEvent,
      processing: {
        mode: "background",
        runId: scheduled.runId,
        status: scheduled.disposition,
        ...(scheduled.resumeAt ? { resumeAt: new Date(scheduled.resumeAt).toISOString() } : {}),
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
      { runId, attempt: 1 },
    );
  } catch (error) {
    const durationMs = Date.now() - startMs;
    recordReviewResult(metrics, { status: "failed", durationMs });
    const reason = error instanceof TriggerProcessingError ? error.reason : "trigger_processing_failed";
    const status = error instanceof TriggerProcessingError ? error.status : 500;
    recordWebhookEvent(store, {
      provider,
      eventName,
      decision: "rejected",
      reason,
      detail: { mode: "inline", runId, message: toErrorMessage(error) },
      ...webhookEventFields(reviewEvent),
    });
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

  recordWebhookEvent(store, {
    provider,
    eventName,
    decision: "executed",
    detail: { mode: "inline", runId, outcome: result.outcome },
    ...webhookEventFields(reviewEvent),
  });

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
    const observabilityApi = createObservabilityApi({
      ...options.observability,
      ...(options.autoCommitStore ? { autoCommitStore: options.autoCommitStore } : {}),
      ...(options.liveRuns ? { liveRuns: options.liveRuns } : {}),
    });
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
    options.triggerRetry,
    options.autoCommit,
    options.getExecutionSchedule,
    options.deferralManager,
    options.getAutoCommitBranches,
    options.getPullRequestTargetBranches,
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
    options.triggerRetry,
    options.autoCommit,
    options.getExecutionSchedule,
    options.deferralManager,
    options.getAutoCommitBranches,
    options.getPullRequestTargetBranches,
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
    options.triggerRetry,
    options.autoCommit,
    options.getExecutionSchedule,
    options.deferralManager,
    options.getAutoCommitBranches,
    options.getPullRequestTargetBranches,
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
    options.triggerRetry,
    options.autoCommit,
    options.getExecutionSchedule,
    options.deferralManager,
    options.getAutoCommitBranches,
    options.getPullRequestTargetBranches,
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
    options.triggerRetry,
    options.autoCommit,
    options.getExecutionSchedule,
    options.deferralManager,
    options.getAutoCommitBranches,
    options.getPullRequestTargetBranches,
  );
  registerSvnTrigger(
    app,
    options.svn,
    options.reviewPreparation,
    options.reviewOrchestration,
    asyncTriggers,
    options.deduplicator,
    runsDir,
    metrics,
    options.store,
    options.triggerRetry,
    options.autoCommit,
    options.getExecutionSchedule,
    options.deferralManager,
    options.getAutoCommitBranches,
    options.getPullRequestTargetBranches,
  );

  // Deferred events resume through the same scheduling path they arrived on,
  // with the window clamp still in force; recovery re-arms whatever a
  // previous process left pending.
  const deferralManager = options.deferralManager;
  if (deferralManager) {
    deferralManager.resumeHandler = (target) => {
      scheduleTriggerProcessing(
        target.provider,
        target.eventName,
        target.decoded,
        target.reviewEvent,
        options.reviewPreparation,
        options.reviewOrchestration,
        options.issueTriage,
        options.deduplicator,
        metrics,
        runsDir,
        options.store,
        options.triggerRetry,
        {
          ...(options.getExecutionSchedule ? { getExecutionSchedule: options.getExecutionSchedule } : {}),
          deferralManager,
          deferralResume: true,
        },
      );
    };
    deferralManager.recover();
  }
}

export {
  formatParsedDiffForPrompt,
  runReviewOrchestration,
  summarizeReviewOrchestrationForWebhook,
} from "./review-orchestrator.js";
export {
  AutoCommitRuntime,
  isAutomaticCommitEvent,
} from "./auto-commit-runtime.js";
export type {
  AutoCommitAcceptor,
  AutoCommitAcceptInput,
  AutoCommitRuntimeOptions,
} from "./auto-commit-runtime.js";
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
  normalizeModelCatalogOverrides,
  resolveAgentAdapterFromConfig,
  resolveGiteaWebhookConfig,
  resolveGenericWebhookConfig,
  resolveGenericWebhookConfigs,
  resolveP4TriggerConfig,
  resolveSvnTriggerConfig,
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
  ReviewDeferralManager,
  computeDeferralKey,
} from "./deferral-manager.js";
export type {
  DeferredTriggerTarget,
  DeferralResumeHandler,
  ReviewDeferralManagerOptions,
} from "./deferral-manager.js";
export {
  recordWebhookEvent,
  webhookEventFields,
} from "./webhook-events.js";

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
