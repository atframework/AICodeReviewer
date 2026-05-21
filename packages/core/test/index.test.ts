import { describe, expect, it } from "vitest";

import {
  workspaceRootKeys,
  mergeConfigLayers,
  resolveWorkspaceConfig,
  loadConfigFile,
  loadWorkspaceConfigFile,
  appConfigSchema,
  workspaceConfigFileSchema,
  fixMarkdown,
  fixAndValidateMarkdown,
  createDefaultLogger,
  createOtelSdk,
  discoverRepoPromptAssets,
  assemblePrompt,
  createInMemoryQueue,
  computeBackoffDelay,
  createQueueFromConfig,
  toRedisQueueOptions,
  createQueueWorker,
  createTokenBucketRateLimiter,
  createMultiProviderRateLimiter,
  createRedisQueue,
  reviewProviderSchema,
  reviewTargetKindSchema,
  reviewActorSchema,
  reviewEventSchema,
  createReviewEvent,
  prepareReviewPrompt,
  loadSystemPromptTemplate,
  buildReviewTaskContext,
  summarizePreparedReviewPrompt,
  scrubText,
  scrubDiff,
  scrubPromptMessages,
  isPlainObject,
  normalizePath,
  normalizeChangedPath,
} from "../src/index.js";

describe("@aicr/core", () => {
  it("exports workspaceRootKeys", () => {
    expect(workspaceRootKeys).toEqual(["cache", "defaults", "instances"]);
  });

  it("exports config utilities", () => {
    expect(mergeConfigLayers).toBeDefined();
    expect(resolveWorkspaceConfig).toBeDefined();
    expect(loadConfigFile).toBeDefined();
    expect(loadWorkspaceConfigFile).toBeDefined();
    expect(appConfigSchema).toBeDefined();
    expect(workspaceConfigFileSchema).toBeDefined();
  });

  it("exports markdown fixers", () => {
    expect(fixMarkdown).toBeDefined();
    expect(fixAndValidateMarkdown).toBeDefined();
  });

  it("exports observability utilities", () => {
    expect(createDefaultLogger).toBeDefined();
    expect(createOtelSdk).toBeDefined();
  });

  it("exports prompt manager utilities", () => {
    expect(discoverRepoPromptAssets).toBeDefined();
    expect(assemblePrompt).toBeDefined();
  });

  it("exports queue utilities", () => {
    expect(createInMemoryQueue).toBeDefined();
    expect(computeBackoffDelay).toBeDefined();
    expect(createQueueFromConfig).toBeDefined();
    expect(toRedisQueueOptions).toBeDefined();
    expect(createQueueWorker).toBeDefined();
    expect(createRedisQueue).toBeDefined();
  });

  it("exports rate limiter utilities", () => {
    expect(createTokenBucketRateLimiter).toBeDefined();
    expect(createMultiProviderRateLimiter).toBeDefined();
  });

  it("exports review event utilities", () => {
    expect(reviewProviderSchema).toBeDefined();
    expect(reviewTargetKindSchema).toBeDefined();
    expect(reviewActorSchema).toBeDefined();
    expect(reviewEventSchema).toBeDefined();
    expect(createReviewEvent).toBeDefined();
  });

  it("exports review preparation utilities", () => {
    expect(prepareReviewPrompt).toBeDefined();
    expect(loadSystemPromptTemplate).toBeDefined();
    expect(buildReviewTaskContext).toBeDefined();
    expect(summarizePreparedReviewPrompt).toBeDefined();
  });

  it("exports secret scrubber utilities", () => {
    expect(scrubText).toBeDefined();
    expect(scrubDiff).toBeDefined();
    expect(scrubPromptMessages).toBeDefined();
  });

  it("exports general utilities", () => {
    expect(isPlainObject).toBeDefined();
    expect(normalizePath).toBeDefined();
    expect(normalizeChangedPath).toBeDefined();
  });
});
