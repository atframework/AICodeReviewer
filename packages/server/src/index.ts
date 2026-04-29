import { Hono } from "hono";
import { ZodError } from "zod";

import {
  prepareReviewPrompt,
  type PreparedReviewPrompt,
  type ReviewEvent,
} from "@aicr/core";
import {
  translateWebhookToReviewEvent,
  type GiteaWebhookConfig,
  verifyWebhookSignature,
} from "./gitea-webhook.js";
import {
  runReviewOrchestration,
  summarizeReviewOrchestrationForWebhook,
  type ServerReviewOrchestrationOptions,
} from "./review-orchestrator.js";

export interface ServerAppOptions {
  readonly gitea?: GiteaWebhookConfig;
  readonly forgejo?: GiteaWebhookConfig;
  readonly reviewPreparation?: ServerReviewPreparationOptions;
  readonly reviewOrchestration?: ServerReviewOrchestrationOptions;
}

export interface ServerReviewPreparationOptions {
  readonly baseSystemPrompt: string;
  readonly sourceRootResolver: (reviewEvent: ReviewEvent) => string | undefined;
  readonly changedPathsResolver?: (context: {
    reviewEvent: ReviewEvent;
    payload: unknown;
    provider: "gitea" | "forgejo";
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
      reviewEvent = translateWebhookToReviewEvent(provider, eventName, decoded, config);
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

    let reviewPreparation;
    if (reviewPreparationOptions) {
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
        const message = error instanceof Error ? error.message : String(error);
        return c.json(
          {
            accepted: false,
            reason: "review_preparation_failed",
            provider,
            eventName,
            message,
          },
          500,
        );
      }
    }

    let reviewRun;
    if (reviewOrchestrationOptions) {
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
        const message = error instanceof Error ? error.message : String(error);
        return c.json(
          {
            accepted: false,
            reason: "review_orchestration_failed",
            provider,
            eventName,
            message,
          },
          500,
        );
      }
    }

    return c.json({ accepted: true, provider, reviewEvent, reviewPreparation, reviewRun }, 202);
  });
}

export function createServerApp(options: ServerAppOptions = {}): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/readyz", (c) => c.text("ready"));

  registerGiteaLikeWebhook(
    app,
    "gitea",
    "/webhooks/gitea",
    options.gitea,
    options.reviewPreparation,
    options.reviewOrchestration,
  );
  registerGiteaLikeWebhook(
    app,
    "forgejo",
    "/webhooks/forgejo",
    options.forgejo,
    options.reviewPreparation,
    options.reviewOrchestration,
  );

  return app;
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
  ServerReviewOrchestrationOptions,
} from "./review-orchestrator.js";

export {
  bootstrapServerApp,
  buildSourceRootResolver,
  createLlmClientFromModelSpec,
  createOutputPublisherFromConfig,
  createVcsAdapterFromConfig,
  resolveGiteaWebhookConfig,
  resolveModelSpecFromConfig,
} from "./bootstrap.js";
export type { BootstrapServerOptions } from "./bootstrap.js";

export { serve, serveAsync } from "./node-serve.js";
export type { ServeOptions } from "./node-serve.js";