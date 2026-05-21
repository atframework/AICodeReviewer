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
  resolveModelSpecFromConfig,
  serve,
  serveAsync,
  createReviewDeduplicator,
  GiteaApiClient,
  triageIssue,
  DEFAULT_TRIAGE_SYSTEM_PROMPT,
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
});
