import { describe, expect, it } from "vitest";

import {
  createServerApp,
  formatParsedDiffForPrompt,
  runReviewOrchestration,
  summarizeReviewOrchestrationForWebhook,
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
  resolveSvnTriggerConfig,
  resolveModelSpecFromConfig,
  resolveTriggerRetryConfig,
  serve,
  serveAsync,
  createReviewDeduplicator,
  GiteaApiClient,
  triageIssue,
  DEFAULT_TRIAGE_SYSTEM_PROMPT,
  resolveAdminAuthConfig,
  createAdminAuthMiddleware,
} from "../src/index.js";

describe("@aicr/server", () => {
  it("exports createServerApp", () => {
    expect(createServerApp).toBeDefined();
  });

  it("exports review orchestration utilities", () => {
    expect(formatParsedDiffForPrompt).toBeDefined();
    expect(runReviewOrchestration).toBeDefined();
    expect(summarizeReviewOrchestrationForWebhook).toBeDefined();
  });

  it("exports bootstrap utilities", () => {
    expect(bootstrapServerApp).toBeDefined();
    expect(buildSourceRootResolver).toBeDefined();
    expect(createLlmClientFromModelSpec).toBeDefined();
    expect(createOutputPublisherFromConfig).toBeDefined();
    expect(createOutputPublisherResolverFromConfig).toBeDefined();
    expect(createSandboxBackendFromConfig).toBeDefined();
    expect(createVcsAdapterFromConfig).toBeDefined();
    expect(resolveAgentAdapterFromConfig).toBeDefined();
    expect(resolveGiteaWebhookConfig).toBeDefined();
    expect(resolveGenericWebhookConfig).toBeDefined();
    expect(resolveGenericWebhookConfigs).toBeDefined();
    expect(resolveP4TriggerConfig).toBeDefined();
    expect(resolveSvnTriggerConfig).toBeDefined();
    expect(resolveModelSpecFromConfig).toBeDefined();
  });

  it("exports server utilities", () => {
    expect(serve).toBeDefined();
    expect(serveAsync).toBeDefined();
  });

  it("exports deduplicator", () => {
    expect(createReviewDeduplicator).toBeDefined();
  });

  it("exports issue triage utilities", () => {
    expect(GiteaApiClient).toBeDefined();
    expect(triageIssue).toBeDefined();
    expect(DEFAULT_TRIAGE_SYSTEM_PROMPT).toBeDefined();
  });

  it("exports admin auth utilities", () => {
    expect(resolveAdminAuthConfig).toBeDefined();
    expect(createAdminAuthMiddleware).toBeDefined();
  });
});

describe("resolveTriggerRetryConfig", () => {
  it("returns undefined without queue.retry", () => {
    expect(resolveTriggerRetryConfig({})).toBeUndefined();
    expect(resolveTriggerRetryConfig({ queue: { kind: "memory" } } as never)).toBeUndefined();
  });

  it("normalizes canonical attempts/backoff", () => {
    expect(
      resolveTriggerRetryConfig({
        queue: {
          kind: "memory",
          retry: { attempts: 5, backoff: { kind: "linear", base_ms: 1000, max_ms: 9000, jitter: false } },
        },
      } as never),
    ).toEqual({
      attempts: 5,
      backoff: { kind: "linear", base_ms: 1000, max_ms: 9000, jitter: false },
    });
  });

  it("maps legacy max_attempts/backoff_seconds aliases", () => {
    expect(
      resolveTriggerRetryConfig({
        queue: { kind: "memory", retry: { max_attempts: 4, backoff_seconds: 20 } },
      } as never),
    ).toEqual({
      attempts: 4,
      backoff: { kind: "constant", base_ms: 20000, max_ms: 20000, jitter: false },
    });
  });

  it("prefers canonical fields over legacy aliases", () => {
    expect(
      resolveTriggerRetryConfig({
        queue: {
          kind: "memory",
          retry: { attempts: 2, max_attempts: 9, backoff: { base_ms: 500 }, backoff_seconds: 30 },
        },
      } as never),
    ).toEqual({ attempts: 2, backoff: { base_ms: 500 } });
  });

  it("drops non-positive legacy values and floors fractional attempts", () => {
    expect(
      resolveTriggerRetryConfig({
        queue: { kind: "memory", retry: { max_attempts: 2.7, backoff_seconds: -1 } },
      } as never),
    ).toEqual({ attempts: 2 });
  });
});
