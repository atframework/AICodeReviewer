import { describe, expect, it } from "vitest";

import {
  llmPackageName,
  createOpenAICompatibleChatClient,
  createChatClientFromModelSpec,
  createAnthropicChatClient,
  createGoogleAiStudioChatClient,
  LlmProviderError,
  createResilientChatClient,
  DailyBudgetTracker,
  LlmBudgetExceededError,
  LlmFallbackExhaustedError,
  buildCompactedDiff,
  compressDiff,
  estimatePromptTokenCount,
  generatePerFileSummaries,
  scoreAndSelectHunks,
  shouldTriggerCompression,
} from "../src/index.js";

describe("@aicr/llm", () => {
  it("exports the package name", () => {
    expect(llmPackageName).toBe("@aicr/llm");
  });

  it("exports chat client creators", () => {
    expect(createOpenAICompatibleChatClient).toBeDefined();
    expect(createChatClientFromModelSpec).toBeDefined();
    expect(createAnthropicChatClient).toBeDefined();
    expect(createGoogleAiStudioChatClient).toBeDefined();
  });

  it("exports LlmProviderError", () => {
    expect(LlmProviderError).toBeDefined();
  });

  it("exports gateway utilities", () => {
    expect(createResilientChatClient).toBeDefined();
    expect(DailyBudgetTracker).toBeDefined();
    expect(LlmBudgetExceededError).toBeDefined();
    expect(LlmFallbackExhaustedError).toBeDefined();
  });

  it("exports compression utilities", () => {
    expect(buildCompactedDiff).toBeDefined();
    expect(compressDiff).toBeDefined();
    expect(estimatePromptTokenCount).toBeDefined();
    expect(generatePerFileSummaries).toBeDefined();
    expect(scoreAndSelectHunks).toBeDefined();
    expect(shouldTriggerCompression).toBeDefined();
  });
});
