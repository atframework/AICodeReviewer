import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ModelSpec } from "@aicr/llm";

import {
  agentPackageName,
  createKiloAdapter,
  createClaudeCodeAdapter,
  createCopilotCliAdapter,
  createOhMyPiAdapter,
  createOpencodeAdapter,
  createPiAdapter,
  createZooAdapter,
  createOpenAICompatibleTranslator,
  createAnthropicTranslator,
  createVertexAiTranslator,
  createBedrockTranslator,
  createAgentAdapter,
  materializeRuntimeBundle,
  toOhMyPiMcpServersJson,
} from "../src/index.js";
import type { RuntimeBundleInstruction, RuntimeBundleSkill, RuntimeBundleMcpTool, RuntimeBundleMcpServer } from "../src/index.js";

describe("@aicr/agents", () => {
  it("exports the package name", () => {
    expect(agentPackageName).toBe("@aicr/agents");
  });
});

describe("createAgentAdapter", () => {
  it("creates a kilo adapter", () => {
    const adapter = createAgentAdapter({ kind: "kilo" });
    expect(adapter.kind).toBe("kilo");
  });

  it("creates an opencode adapter", () => {
    const adapter = createAgentAdapter({ kind: "opencode" });
    expect(adapter.kind).toBe("opencode");
  });

  it("creates a zoo adapter", () => {
    const adapter = createAgentAdapter({ kind: "zoo" });
    expect(adapter.kind).toBe("zoo");
  });

  it("creates a copilot-cli adapter", () => {
    const adapter = createAgentAdapter({ kind: "copilot-cli" });
    expect(adapter.kind).toBe("copilot-cli");
  });

  it("creates a claude-code adapter", () => {
    const adapter = createAgentAdapter({ kind: "claude-code" });
    expect(adapter.kind).toBe("claude-code");
  });

  it("creates a pi adapter", () => {
    const adapter = createAgentAdapter({ kind: "pi" });
    expect(adapter.kind).toBe("pi");
  });

  it("creates an oh-my-pi adapter", () => {
    const adapter = createAgentAdapter({ kind: "oh-my-pi" });
    expect(adapter.kind).toBe("oh-my-pi");
  });

  it("passes binary option to kilo adapter", () => {
    const adapter = createAgentAdapter({ kind: "kilo", binary: "/custom/kilo" });
    expect(adapter.kind).toBe("kilo");
  });
});

describe("createKiloAdapter", () => {
  it("creates adapter with default binary", () => {
    const adapter = createKiloAdapter();
    expect(adapter.kind).toBe("kilo");
  });

  it("creates adapter with custom binary", () => {
    const adapter = createKiloAdapter({ binary: "/usr/local/bin/kilo" });
    expect(adapter.kind).toBe("kilo");
  });

  describe("detect", () => {
    it("returns a detect result", async () => {
      const adapter = createKiloAdapter({ binary: process.execPath });
      const result = await adapter.detect();
      expect(result.available).toBe(true);
      expect(result.binary).toBe(process.execPath);
      expect(result.version).toContain(process.version);
    });
  });

  describe("buildCommand", () => {
    it("builds command with auto-approve flags, format json, and message", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        timeoutMs: 300_000,
      });

      expect(cmd[0]).toBe("kilo");
      expect(cmd).toContain("run");
      expect(cmd).toContain("--auto");
      expect(cmd).toContain("--format");
      expect(cmd).toContain("json");
      expect(cmd).toContain("--dir");
      expect(cmd).toContain("/workspace");
      expect(cmd).not.toContain("review this");
    });

    it("includes model flag in provider/model format", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review", {
        workingDir: "/ws",
        model: {
          providerKind: "openai_compatible",
          providerId: "test-provider",
          modelId: "gpt-4o",
        },
      });

      expect(cmd).toContain("--model");
      expect(cmd).toContain("test-provider/gpt-4o");
    });

    it("uses bare modelId when it already contains a slash", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review", {
        workingDir: "/ws",
        model: {
          providerKind: "openai_compatible",
          providerId: "test-provider",
          modelId: "other/model",
        },
      });

      expect(cmd).toContain("--model");
      expect(cmd).toContain("other/model");
    });

    it("does not pass task as command line argument", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("do the thing", {
        workingDir: "/ws",
      });

      expect(cmd[cmd.length - 1]).toBe("/ws");
      expect(cmd).not.toContain("do the thing");
    });

    it("passes --variant from defaultReasoningEffort", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review", {
        workingDir: "/ws",
        model: {
          providerKind: "openai_compatible",
          providerId: "zhipu",
          modelId: "glm-5.2",
          supportedReasoningEfforts: ["minimal", "low", "medium", "high", "max"],
          defaultReasoningEffort: "max",
        },
      });

      expect(cmd).toContain("--model");
      expect(cmd).toContain("zhipu/glm-5.2");
      expect(cmd).toContain("--variant");
      expect(cmd[cmd.indexOf("--variant") + 1]).toBe("max");
    });

    it("falls back to reasoningEffort for --variant when no default is set", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review", {
        workingDir: "/ws",
        model: {
          providerKind: "openai_compatible",
          providerId: "p",
          modelId: "m",
          reasoningEffort: "high",
        },
      });

      expect(cmd).toContain("--variant");
      expect(cmd[cmd.indexOf("--variant") + 1]).toBe("high");
    });

    it("omits --variant when no reasoning effort is configured", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review", {
        workingDir: "/ws",
        model: {
          providerKind: "openai_compatible",
          providerId: "p",
          modelId: "m",
        },
      });

      expect(cmd).not.toContain("--variant");
    });
  });

  describe("materializeConfig", () => {
    it("returns config files map with kilo.json", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "openai_compatible",
          providerId: "my-provider",
          modelId: "gpt-4o",
          baseUrl: "https://api.openai.com/v1",
        },
        "/tmp/test-workspace",
      );

      expect(result.configFiles.has(".kilo/kilo.json")).toBe(true);
      const configJson = result.configFiles.get(".kilo/kilo.json");
      expect(configJson).toBeDefined();

      const parsed = JSON.parse(configJson ?? "{}");
      expect(parsed.provider).toBeDefined();
      expect(parsed.provider["my-provider"]).toBeDefined();
      expect(parsed.provider["my-provider"]?.options?.baseURL).toBe("https://api.openai.com/v1");
      expect(parsed.provider["my-provider"]?.models?.["gpt-4o"]).toEqual({});
    });

    it("includes organization in provider options", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "openai_compatible",
          providerId: "org-provider",
          modelId: "gpt-4o",
          organization: "org-123",
        },
        "/tmp/test",
      );

      const configJson = result.configFiles.get(".kilo/kilo.json") ?? "{}";
      const parsed = JSON.parse(configJson);
      expect(parsed.provider["org-provider"]?.options?.organization).toBe("org-123");
    });

    it("includes env vars for API key", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "openai_compatible",
          providerId: "p",
          modelId: "m",
          apiKeyEnv: "OPENAI_API_KEY",
        },
        "/tmp/test",
      );

      expect(result.envVars.KILO_API_KEY).toBe("${OPENAI_API_KEY}");
      expect(result.envVars.KILO_API_KEY_P).toBe("${OPENAI_API_KEY}");
    });

    it("writes kilo.json to the working directory", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "aicr-kilo-adapter-"));

      try {
        const adapter = createKiloAdapter();
        await adapter.materializeConfig(
          {
            providerKind: "openai_compatible",
            providerId: "openai-prod",
            modelId: "gpt-4o",
            baseUrl: "https://api.openai.com/v1",
            apiVersion: "2025-01-01-preview",
          },
          tempDir,
        );

        const configJson = await readFile(join(tempDir, ".kilo", "kilo.json"), "utf8");
        const parsed = JSON.parse(configJson);
        expect(parsed.provider["openai-prod"]).toBeDefined();
        expect(parsed.provider["openai-prod"]?.options?.baseURL).toBe("https://api.openai.com/v1");
        expect(parsed.provider["openai-prod"]?.options?.apiVersion).toBe("2025-01-01-preview");
        expect(parsed.provider["openai-prod"]?.models?.["gpt-4o"]).toEqual({});
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("returns empty env vars when no API key env", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "openai_compatible",
          providerId: "p",
          modelId: "m",
        },
        "/tmp/test",
      );

      expect(Object.keys(result.envVars)).toHaveLength(0);
    });

    it("injects compaction config when context compaction options are provided", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        { providerKind: "openai_compatible", providerId: "p", modelId: "m" },
        "/tmp/test",
        { compaction: { auto: true, thresholdPercent: 80, prune: true } },
      );

      const parsed = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(parsed.compaction).toEqual({ auto: true, threshold_percent: 80, prune: true });
    });

    it("disables compaction when auto is false", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        { providerKind: "openai_compatible", providerId: "p", modelId: "m" },
        "/tmp/test",
        { compaction: { auto: false } },
      );

      const parsed = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(parsed.compaction).toEqual({ auto: false });
    });

    it("omits compaction section when no compaction options are provided", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        { providerKind: "openai_compatible", providerId: "p", modelId: "m" },
        "/tmp/test",
      );

      const parsed = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(parsed.compaction).toBeUndefined();
    });

    it("emits reasoning effort variants into the model entry", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "openai_compatible",
          providerId: "zhipu",
          modelId: "glm-5.2",
          supportedReasoningEfforts: ["minimal", "low", "medium", "high", "max"],
          defaultReasoningEffort: "max",
        },
        "/tmp/test",
      );

      const parsed = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(parsed.provider["zhipu"]?.models?.["glm-5.2"]?.variants).toEqual({
        minimal: { reasoningEffort: "minimal" },
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
        max: { reasoningEffort: "max" },
      });
    });

    it("emits a single variant from reasoningEffort alone", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "openai_compatible",
          providerId: "p",
          modelId: "m",
          reasoningEffort: "high",
        },
        "/tmp/test",
      );

      const parsed = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(parsed.provider["p"]?.models?.["m"]?.variants).toEqual({
        high: { reasoningEffort: "high" },
      });
    });

    it("omits variants when no reasoning effort is configured", async () => {
      const adapter = createKiloAdapter();
      const result = await adapter.materializeConfig(
        { providerKind: "openai_compatible", providerId: "p", modelId: "m" },
        "/tmp/test",
      );

      const parsed = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(parsed.provider["p"]?.models?.["m"]).toEqual({});
    });
  });
});

describe("createOpenAICompatibleTranslator", () => {
  it("translates ModelSpec to ModelConfigTranslation", () => {
    const translator = createOpenAICompatibleTranslator("my-provider");
    const result = translator.translate({
      providerKind: "openai_compatible",
      providerId: "my-provider",
      modelId: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
    });

    expect(result.providerId).toBe("my-provider");
    expect(result.modelId).toBe("gpt-4o");
    expect(result.cliFlags).toContain("--provider");
    expect(result.cliFlags).toContain("my-provider");
    expect(result.cliFlags).toContain("--model");
    expect(result.cliFlags).toContain("gpt-4o");

    const config = JSON.parse(result.configJson);
    expect(config.id).toBe("my-provider");
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("uses options baseUrl as fallback", () => {
    const translator = createOpenAICompatibleTranslator("p", {
      baseUrl: "https://fallback.example.com/v1",
    });
    const result = translator.translate({
      providerKind: "openai_compatible",
      providerId: "p",
      modelId: "m",
    });

    const config = JSON.parse(result.configJson);
    expect(config.baseUrl).toBe("https://fallback.example.com/v1");
  });

  it("prefers model baseUrl over options baseUrl", () => {
    const translator = createOpenAICompatibleTranslator("p", {
      baseUrl: "https://fallback.example.com/v1",
    });
    const result = translator.translate({
      providerKind: "openai_compatible",
      providerId: "p",
      modelId: "m",
      baseUrl: "https://primary.example.com/v1",
    });

    const config = JSON.parse(result.configJson);
    expect(config.baseUrl).toBe("https://primary.example.com/v1");
  });

  it("includes extraParams in config", () => {
    const translator = createOpenAICompatibleTranslator("p");
    const result = translator.translate({
      providerKind: "openai_compatible",
      providerId: "p",
      modelId: "m",
      extraParams: { temperature: 0.7, top_p: 0.9 },
    });

    const config = JSON.parse(result.configJson);
    expect(config.temperature).toBe(0.7);
    expect(config.top_p).toBe(0.9);
  });

  it("includes organization when present", () => {
    const translator = createOpenAICompatibleTranslator("p");
    const result = translator.translate({
      providerKind: "openai_compatible",
      providerId: "p",
      modelId: "m",
      organization: "org-abc",
    });

    const config = JSON.parse(result.configJson);
    expect(config.organization).toBe("org-abc");
  });

  it("uses options apiKeyEnv when model does not override it", () => {
    const translator = createOpenAICompatibleTranslator("p", {
      apiKeyEnv: "OPENAI_API_KEY",
    });
    const result = translator.translate({
      providerKind: "openai_compatible",
      providerId: "p",
      modelId: "m",
    });

    expect(result.envVars.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
  });
});

describe("createAnthropicTranslator", () => {
  it("translates Anthropic ModelSpec with API key env vars", () => {
    const translator = createAnthropicTranslator("anthropic-prod");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "anthropic-prod",
      modelId: "claude-sonnet-4",
      apiKeyEnv: "MY_ANTHROPIC_KEY",
      baseUrl: "https://api.anthropic.com",
    });

    expect(result.providerId).toBe("anthropic-prod");
    expect(result.modelId).toBe("claude-sonnet-4");
    expect(result.envVars.ANTHROPIC_API_KEY).toBe("${MY_ANTHROPIC_KEY}");
    expect(result.envVars.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(result.cliFlags).toContain("--model");
    expect(result.cliFlags).toContain("claude-sonnet-4");
  });

  it("defaults API key to ANTHROPIC_API_KEY when not specified", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
    });

    expect(result.envVars.ANTHROPIC_API_KEY).toBe("${ANTHROPIC_API_KEY}");
  });

  it("uses options baseUrl as fallback", () => {
    const translator = createAnthropicTranslator("p", {
      baseUrl: "https://proxy.example.com",
    });
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
    });

    expect(result.envVars.ANTHROPIC_BASE_URL).toBe("https://proxy.example.com");
  });

  it("prefers model baseUrl over options baseUrl", () => {
    const translator = createAnthropicTranslator("p", {
      baseUrl: "https://proxy.example.com",
    });
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      baseUrl: "https://api.anthropic.com",
    });

    expect(result.envVars.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("does not translate anthropicVersion (no such Claude Code env override)", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      anthropicVersion: "2025-01-01",
    });

    expect(result.envVars.ANTHROPIC_VERSION).toBeUndefined();
  });

  it("includes anthropicBeta as comma-separated ANTHROPIC_BETAS", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      anthropicBeta: ["prompt-caching-tool", "output-128k"],
    });

    expect(result.envVars.ANTHROPIC_BETAS).toBe("prompt-caching-tool,output-128k");
  });

  it("includes thinking budget via MAX_THINKING_TOKENS and pins adaptive thinking off", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      thinking: { enabled: true, budgetTokens: 4096 },
    });

    expect(result.envVars.MAX_THINKING_TOKENS).toBe("4096");
    expect(result.envVars.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBe("1");
    expect(result.cliFlags).not.toContain("--thinking");
  });

  it("includes max_tokens from extraParams as CLAUDE_CODE_MAX_OUTPUT_TOKENS", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      extraParams: { max_tokens: 8192, temperature: 0.7 },
    });

    expect(result.envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8192");

    const config = JSON.parse(result.configJson);
    expect(config.temperature).toBe(0.7);
    expect(config.max_tokens).toBe(8192);
  });

  it("derives Claude Code limits and standalone thinking budget from ModelSpec", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "claude-sonnet-4",
      maxOutputTokens: 64_000,
      contextWindow: 200_000,
      thinkingBudgetTokens: 8_192,
    });

    expect(result.envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
    expect(result.envVars.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("200000");
    expect(result.envVars.MAX_THINKING_TOKENS).toBe("8192");
    expect(result.envVars.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBe("1");
  });

  it("does not include thinking env when thinking is not enabled", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      thinking: { enabled: false, budgetTokens: 4096 },
    });

    expect(result.envVars.MAX_THINKING_TOKENS).toBeUndefined();
    expect(result.envVars.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBeUndefined();
    expect(result.cliFlags).not.toContain("--thinking");
  });

  it("uses options apiKeyEnv when model does not override it", () => {
    const translator = createAnthropicTranslator("p", {
      apiKeyEnv: "CUSTOM_KEY",
    });
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
    });

    expect(result.envVars.ANTHROPIC_API_KEY).toBe("${CUSTOM_KEY}");
  });
});

describe("createVertexAiTranslator", () => {
  it("translates Vertex AI ModelSpec with default credentials env", () => {
    const translator = createVertexAiTranslator("vertex-prod");
    const result = translator.translate({
      providerKind: "vertex_ai",
      providerId: "vertex-prod",
      modelId: "gemini-2.0-flash",
      vertexProject: "my-project",
      vertexLocation: "us-central1",
    });

    expect(result.providerId).toBe("vertex-prod");
    expect(result.modelId).toBe("gemini-2.0-flash");
    expect(result.envVars.GOOGLE_APPLICATION_CREDENTIALS).toBe("${GOOGLE_APPLICATION_CREDENTIALS}");
    expect(result.envVars.GOOGLE_CLOUD_PROJECT).toBe("my-project");
    expect(result.envVars.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
    expect(result.cliFlags).toContain("--project");
    expect(result.cliFlags).toContain("my-project");
    expect(result.cliFlags).toContain("--location");
    expect(result.cliFlags).toContain("us-central1");
  });

  it("uses custom credentials env var", () => {
    const translator = createVertexAiTranslator("p");
    const result = translator.translate({
      providerKind: "vertex_ai",
      providerId: "p",
      modelId: "m",
      googleApplicationCredentialsEnv: "MY_CREDS",
    });

    expect(result.envVars.GOOGLE_APPLICATION_CREDENTIALS).toBe("${MY_CREDS}");
  });

  it("includes extraParams in config", () => {
    const translator = createVertexAiTranslator("p");
    const result = translator.translate({
      providerKind: "vertex_ai",
      providerId: "p",
      modelId: "m",
      extraParams: { temperature: 0.5 },
    });

    const config = JSON.parse(result.configJson);
    expect(config.temperature).toBe(0.5);
  });

  it("does not include project/location flags when not provided", () => {
    const translator = createVertexAiTranslator("p");
    const result = translator.translate({
      providerKind: "vertex_ai",
      providerId: "p",
      modelId: "m",
    });

    expect(result.cliFlags).not.toContain("--project");
    expect(result.cliFlags).not.toContain("--location");
  });
});

describe("createBedrockTranslator", () => {
  it("translates Bedrock ModelSpec with AWS env vars", () => {
    const translator = createBedrockTranslator("bedrock-prod");
    const result = translator.translate({
      providerKind: "bedrock",
      providerId: "bedrock-prod",
      modelId: "claude-v3",
      awsRegion: "us-west-2",
      awsAccessKeyEnv: "AWS_KEY",
      awsSecretKeyEnv: "AWS_SECRET",
      awsSessionTokenEnv: "AWS_SESSION",
      awsProfile: "my-profile",
    });

    expect(result.providerId).toBe("bedrock-prod");
    expect(result.modelId).toBe("claude-v3");
    expect(result.envVars.AWS_REGION).toBe("us-west-2");
    expect(result.envVars.AWS_ACCESS_KEY_ID).toBe("${AWS_KEY}");
    expect(result.envVars.AWS_SECRET_ACCESS_KEY).toBe("${AWS_SECRET}");
    expect(result.envVars.AWS_SESSION_TOKEN).toBe("${AWS_SESSION}");
    expect(result.envVars.AWS_PROFILE).toBe("my-profile");
    expect(result.cliFlags).toContain("--region");
    expect(result.cliFlags).toContain("us-west-2");
  });

  it("includes baseUrl as AWS_ENDPOINT_URL", () => {
    const translator = createBedrockTranslator("p");
    const result = translator.translate({
      providerKind: "bedrock",
      providerId: "p",
      modelId: "m",
      baseUrl: "https://bedrock-runtime.custom.example.com",
    });

    expect(result.envVars.AWS_ENDPOINT_URL).toBe("https://bedrock-runtime.custom.example.com");
  });

  it("includes extraParams in config", () => {
    const translator = createBedrockTranslator("p");
    const result = translator.translate({
      providerKind: "bedrock",
      providerId: "p",
      modelId: "m",
      extraParams: { max_tokens: 4096 },
    });

    const config = JSON.parse(result.configJson);
    expect(config.max_tokens).toBe(4096);
  });

  it("does not include region flag when awsRegion is not provided", () => {
    const translator = createBedrockTranslator("p");
    const result = translator.translate({
      providerKind: "bedrock",
      providerId: "p",
      modelId: "m",
    });

    expect(result.cliFlags).not.toContain("--region");
  });

  it("does not include env vars for missing credentials", () => {
    const translator = createBedrockTranslator("p");
    const result = translator.translate({
      providerKind: "bedrock",
      providerId: "p",
      modelId: "m",
    });

    expect(result.envVars.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(result.envVars.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.envVars.AWS_SESSION_TOKEN).toBeUndefined();
  });
});

describe("createClaudeCodeAdapter", () => {
  it("creates adapter with default binary", () => {
    const adapter = createClaudeCodeAdapter();
    expect(adapter.kind).toBe("claude-code");
  });

  it("creates adapter with custom binary", () => {
    const adapter = createClaudeCodeAdapter({ binary: "/usr/local/bin/claude" });
    expect(adapter.kind).toBe("claude-code");
  });

  describe("detect", () => {
    it("returns a detect result", async () => {
      const adapter = createClaudeCodeAdapter({ binary: process.execPath });
      const result = await adapter.detect();
      expect(result.available).toBe(true);
      expect(result.binary).toBe(process.execPath);
    });
  });

  describe("buildCommand", () => {
    it("builds a print-mode command with model and JSON output", () => {
      const adapter = createClaudeCodeAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        timeoutMs: 300_000,
        model: {
          providerKind: "anthropic",
          providerId: "anthropic-prod",
          modelId: "claude-sonnet-4",
        },
        task: "review this",
      });

      expect(cmd[0]).toBe("claude");
      expect(cmd).toContain("-p");
      expect(cmd).toContain("--output-format");
      expect(cmd).toContain("json");
      expect(cmd).toContain("--model");
      expect(cmd).toContain("claude-sonnet-4");
      expect(cmd).not.toContain("--cwd");
      expect(cmd).not.toContain("--timeout");
      expect(cmd).not.toContain("--thinking");
    });

    it("passes --effort from defaultReasoningEffort and maps minimal to low", () => {
      const adapter = createClaudeCodeAdapter();
      const highCmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        model: {
          providerKind: "anthropic",
          providerId: "p",
          modelId: "m",
          defaultReasoningEffort: "high",
        },
        task: "t",
      });
      expect(highCmd).toContain("--effort");
      expect(highCmd).toContain("high");

      const minimalCmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        model: {
          providerKind: "anthropic",
          providerId: "p",
          modelId: "m",
          reasoningEffort: "minimal",
        },
        task: "t",
      });
      expect(minimalCmd).toContain("--effort");
      expect(minimalCmd).toContain("low");
      expect(minimalCmd).not.toContain("minimal");
    });

    it("adds --dangerously-skip-permissions only when autoApprove is set", () => {
      const adapter = createClaudeCodeAdapter();
      const autoCmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        autoApprove: true,
        task: "t",
      });
      expect(autoCmd).toContain("--dangerously-skip-permissions");

      const manualCmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        task: "t",
      });
      expect(manualCmd).not.toContain("--dangerously-skip-permissions");
    });

    it("wires MCP servers via --mcp-config with strict isolation", () => {
      const adapter = createClaudeCodeAdapter();
      const cmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        task: "t",
        autoApprove: true,
        mcpServers: [
          {
            name: "aicr-output",
            config: {
              type: "local",
              command: ["node", "/app/packages/mcp-output/dist/server.js"],
              environment: { AICR_OUTPUT_STATE_PATH: "/workspace/agent/.aicr-output-state.json" },
            },
          },
        ],
      });

      expect(cmd).toContain("--mcp-config");
      expect(cmd).toContain("--strict-mcp-config");
      const mcpIdx = cmd.indexOf("--mcp-config");
      const mcpJson = JSON.parse(cmd[mcpIdx + 1]!);
      expect(mcpJson.mcpServers["aicr-output"]).toEqual({
        type: "stdio",
        command: "node",
        args: ["/app/packages/mcp-output/dist/server.js"],
        env: { AICR_OUTPUT_STATE_PATH: "/workspace/agent/.aicr-output-state.json" },
      });
    });

    it("omits MCP flags when no MCP servers are configured", () => {
      const adapter = createClaudeCodeAdapter();
      const cmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        task: "t",
      });
      expect(cmd).not.toContain("--mcp-config");
      expect(cmd).not.toContain("--strict-mcp-config");
    });
  });

  describe("materializeConfig", () => {
    it("returns env vars for API key and base URL", async () => {
      const adapter = createClaudeCodeAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "anthropic",
          providerId: "anthropic-prod",
          modelId: "claude-sonnet-4",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          baseUrl: "https://api.anthropic.com",
        },
        "/tmp/test",
      );

      expect(result.envVars.ANTHROPIC_API_KEY).toBe("${ANTHROPIC_API_KEY}");
      expect(result.envVars.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    });

    it("returns verified Claude Code env vars for advanced model options", async () => {
      const adapter = createClaudeCodeAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "anthropic",
          providerId: "anthropic-prod",
          modelId: "claude-sonnet-4",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          anthropicVersion: "2025-01-01",
          anthropicBeta: ["prompt-caching", "output-128k"],
          thinking: { enabled: true, budgetTokens: 8192 },
          extraParams: { max_tokens: 16384 },
          contextWindow: 200_000,
        },
        "/tmp/test",
      );

      expect(result.envVars.ANTHROPIC_VERSION).toBeUndefined();
      expect(result.envVars.ANTHROPIC_BETAS).toBe("prompt-caching,output-128k");
      expect(result.envVars.MAX_THINKING_TOKENS).toBe("8192");
      expect(result.envVars.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBe("1");
      expect(result.envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("16384");
      expect(result.envVars.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("200000");
    });

    it("derives CLAUDE_CODE_MAX_OUTPUT_TOKENS from catalog maxOutputTokens", async () => {
      const adapter = createClaudeCodeAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "anthropic",
          providerId: "p",
          modelId: "m",
          maxOutputTokens: 64000,
        },
        "/tmp/test",
      );

      expect(result.envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
    });

    it("maps standalone thinkingBudgetTokens into the Claude Code budget env", async () => {
      const adapter = createClaudeCodeAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "anthropic",
          providerId: "p",
          modelId: "m",
          thinkingBudgetTokens: 12_288,
        },
        "/tmp/test",
      );

      expect(result.envVars.MAX_THINKING_TOKENS).toBe("12288");
      expect(result.envVars.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBe("1");
    });

    it("sets sandbox hygiene env vars and honors compaction opt-out", async () => {
      const adapter = createClaudeCodeAdapter();
      const result = await adapter.materializeConfig(
        { providerKind: "anthropic", providerId: "p", modelId: "m" },
        "/tmp/test",
        { compaction: { auto: false } },
      );

      expect(result.envVars.DISABLE_AUTOUPDATER).toBe("1");
      expect(result.envVars.DISABLE_TELEMETRY).toBe("1");
      expect(result.envVars.DISABLE_ERROR_REPORTING).toBe("1");
      expect(result.envVars.CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBe("1");
      expect(result.envVars.DISABLE_AUTO_COMPACT).toBe("1");
    });

    it("returns no config files (env and CLI flags carry the configuration)", async () => {
      const adapter = createClaudeCodeAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "anthropic",
          providerId: "p",
          modelId: "m",
        },
        "/tmp/test",
      );

      expect(result.configFiles.size).toBe(0);
    });
  });
});

describe("createCopilotCliAdapter", () => {
  it("creates adapter with default binary", () => {
    const adapter = createCopilotCliAdapter();
    expect(adapter.kind).toBe("copilot-cli");
  });

  it("creates adapter with custom binary", () => {
    const adapter = createCopilotCliAdapter({ binary: "/usr/local/bin/gh" });
    expect(adapter.kind).toBe("copilot-cli");
  });

  describe("buildCommand", () => {
    it("builds a programmatic copilot command with prompt and silent output", () => {
      const adapter = createCopilotCliAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        model: {
          providerKind: "copilot",
          providerId: "copilot",
          modelId: "gpt-4o",
        },
        autoApprove: true,
        task: "review this",
      });

      expect(cmd[0]).toBe("copilot");
      expect(cmd).toContain("--prompt");
      expect(cmd).toContain("review this");
      expect(cmd).toContain("--silent");
      expect(cmd).toContain("--no-ask-user");
      expect(cmd).toContain("--model=gpt-4o");
      expect(cmd).toContain("--allow-all-tools");
      expect(cmd).toContain("--allow-all-paths");
      expect(cmd).not.toContain("suggest");
      expect(cmd).not.toContain("--cwd");
    });

    it("omits permission bypass when autoApprove is not set", () => {
      const adapter = createCopilotCliAdapter();
      const cmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        task: "t",
      });
      expect(cmd).not.toContain("--allow-all-tools");
      expect(cmd).not.toContain("--allow-all-paths");
    });

    it("passes --effort and maps minimal to low", () => {
      const adapter = createCopilotCliAdapter();
      const cmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        model: {
          providerKind: "copilot",
          providerId: "copilot",
          modelId: "gpt-5",
          reasoningEffort: "minimal",
        },
        task: "t",
      });
      expect(cmd).toContain("--effort=low");
    });

    it("wires MCP servers via --additional-mcp-config", () => {
      const adapter = createCopilotCliAdapter();
      const cmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        task: "t",
        autoApprove: true,
        mcpServers: [
          {
            name: "aicr-output",
            config: { type: "local", command: ["node", "/app/packages/mcp-output/dist/server.js"] },
          },
        ],
      });

      const mcpArg = cmd.find((arg) => arg.startsWith("--additional-mcp-config="));
      expect(mcpArg).toBeDefined();
      const mcpJson = JSON.parse(mcpArg!.slice("--additional-mcp-config=".length));
      expect(mcpJson.mcpServers["aicr-output"]).toEqual({
        type: "local",
        command: "node",
        args: ["/app/packages/mcp-output/dist/server.js"],
        tools: ["*"],
      });
    });
  });

  describe("materializeConfig", () => {
    it("returns COPILOT_GITHUB_TOKEN env var when apiKeyEnv is set", async () => {
      const adapter = createCopilotCliAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "copilot",
          providerId: "copilot",
          modelId: "gpt-4o",
          apiKeyEnv: "GITHUB_TOKEN",
        },
        "/tmp/test",
      );

      expect(result.envVars.COPILOT_GITHUB_TOKEN).toBe("${GITHUB_TOKEN}");
    });
  });
});

describe("createOpencodeAdapter", () => {
  it("creates adapter with default binary", () => {
    const adapter = createOpencodeAdapter();
    expect(adapter.kind).toBe("opencode");
  });

  describe("buildCommand", () => {
    it("builds command with auto-approve, json format, dir, and model", () => {
      const adapter = createOpencodeAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        timeoutMs: 300_000,
        model: {
          providerKind: "openai_compatible",
          providerId: "test-provider",
          modelId: "gpt-4o",
        },
        task: "review this",
      });

      expect(cmd[0]).toBe("opencode");
      expect(cmd[1]).toBe("--pure");
      expect(cmd).toContain("run");
      expect(cmd).toContain("--auto");
      expect(cmd).toContain("--format");
      expect(cmd).toContain("json");
      expect(cmd).toContain("--model");
      expect(cmd).toContain("test-provider/gpt-4o");
      expect(cmd).toContain("--dir");
      expect(cmd).toContain("/workspace");
      expect(cmd).not.toContain("--cwd");
      expect(cmd).not.toContain("--timeout");
    });

    it("passes --variant from defaultReasoningEffort", () => {
      const adapter = createOpencodeAdapter();
      const cmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        model: {
          providerKind: "openai_compatible",
          providerId: "p",
          modelId: "m",
          defaultReasoningEffort: "high",
        },
        task: "t",
      });
      expect(cmd).toContain("--variant");
      expect(cmd).toContain("high");
    });

    it("does not duplicate an already provider-qualified model id", () => {
      const adapter = createOpencodeAdapter();
      const cmd = adapter.buildCommand("t", {
        workingDir: "/workspace",
        model: {
          providerKind: "openai_compatible",
          providerId: "openrouter",
          modelId: "openrouter/moonshotai/kimi-k2",
        },
        task: "t",
      });
      expect(cmd).toContain("openrouter/moonshotai/kimi-k2");
      expect(cmd).not.toContain("openrouter/openrouter/moonshotai/kimi-k2");
    });
  });

  describe("materializeConfig", () => {
    it("writes opencode config and returns env vars", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "aicr-opencode-adapter-"));

      try {
        const adapter = createOpencodeAdapter();
        const result = await adapter.materializeConfig(
          {
            providerKind: "openai_compatible",
            providerId: "openai-prod",
            modelId: "gpt-4o",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            extraHeaders: { "X-Tenant": "review" },
            extraParams: { temperature: 0.7 },
            extraBody: { safety: true },
            timeoutMs: 120_000,
          },
          tempDir,
        );

        expect(result.configFiles.has("opencode.json")).toBe(true);
        const configJson = result.configFiles.get("opencode.json") ?? "{}";
        const parsed = JSON.parse(configJson);
        expect(parsed.$schema).toBe("https://opencode.ai/config.json");
        expect(Array.isArray(parsed.provider)).toBe(false);
        const provider = parsed.provider["openai-prod"];
        expect(provider.npm).toBe("@ai-sdk/openai-compatible");
        expect(provider.name).toBe("openai-prod");
        expect(provider.options).toEqual({
          baseURL: "https://api.openai.com/v1",
          apiKey: "{env:OPENAI_API_KEY}",
          headers: { "X-Tenant": "review" },
          timeout: 120_000,
        });
        expect(provider.models["gpt-4o"].options).toEqual({
          temperature: 0.7,
          safety: true,
        });
        expect(parsed.models).toBeUndefined();
        expect(result.envVars.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
        expect(result.envVars.OPENCODE_CONFIG).toBeUndefined();
        expect(result.envVars.OPENCODE_DISABLE_AUTOUPDATE).toBe("true");
        expect(result.envVars.OPENCODE_DISABLE_TERMINAL_TITLE).toBe("true");
        expect(result.envVars.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe("true");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("injects compaction config when provided", async () => {
      const adapter = createOpencodeAdapter();
      const result = await adapter.materializeConfig(
        { providerKind: "openai_compatible", providerId: "p", modelId: "m" },
        "/tmp/test",
        { compaction: { auto: true, prune: true } },
      );

      const parsed = JSON.parse(result.configFiles.get("opencode.json") ?? "{}");
      expect(parsed.compaction).toEqual({ auto: true, prune: true });
    });

    it("disables compaction when auto is false", async () => {
      const adapter = createOpencodeAdapter();
      const result = await adapter.materializeConfig(
        { providerKind: "openai_compatible", providerId: "p", modelId: "m" },
        "/tmp/test",
        { compaction: { auto: false } },
      );

      const parsed = JSON.parse(result.configFiles.get("opencode.json") ?? "{}");
      expect(parsed.compaction).toEqual({ auto: false });
    });
  });
});

describe("createZooAdapter", () => {
  it("creates adapter with default binary", () => {
    const adapter = createZooAdapter();
    expect(adapter.kind).toBe("zoo");
  });

  describe("buildCommand", () => {
    it("builds Zoo stdin-stream command with model and workspace", () => {
      const adapter = createZooAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        timeoutMs: 300_000,
        model: {
          providerKind: "openai_compatible",
          providerId: "test-provider",
          modelId: "gpt-4o",
        },
      });

      expect(cmd[0]).toBe("roo");
      expect(cmd).toContain("--print");
      expect(cmd).toContain("--stdin-prompt-stream");
      expect(cmd).toContain("--workspace");
      expect(cmd).toContain("/workspace");
      expect(cmd).toContain("--model");
      expect(cmd).toContain("gpt-4o");
    });

    it("serializes task stdin as Zoo stdin-stream NDJSON", () => {
      const adapter = createZooAdapter();
      const stdin = adapter.buildStdin?.("review\nthis", {
        workingDir: "/workspace",
        task: "review\nthis",
      });

      expect(stdin).toBeDefined();
      const parsed = JSON.parse(stdin!.trim());
      expect(parsed).toEqual({
        command: "start",
        requestId: "aicr-review",
        prompt: "review\nthis",
      });
    });
  });

  describe("materializeConfig", () => {
    it("writes Zoo-compatible .roo settings.json", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "aicr-zoo-adapter-"));

      try {
        const adapter = createZooAdapter();
        const result = await adapter.materializeConfig(
          {
            providerKind: "openai_compatible",
            providerId: "openai-prod",
            modelId: "gpt-4o",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            extraParams: { temperature: 0.5, top_p: 0.9 },
          },
          tempDir,
        );

        expect(result.configFiles.has(".roo/settings.json")).toBe(true);
        const configJson = result.configFiles.get(".roo/settings.json") ?? "{}";
        const parsed = JSON.parse(configJson);
        expect(parsed.apiConfiguration.openAiModelId).toBe("gpt-4o");
        expect(parsed.apiConfiguration.openAiBaseUrl).toBe("https://api.openai.com/v1");
        expect(parsed.apiConfiguration.modelTemperature).toBe(0.5);
        expect(parsed.apiConfiguration.modelTopP).toBe(0.9);
        expect(result.envVars.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("injects context condensing settings when compaction options are provided", async () => {
      const adapter = createZooAdapter();
      const result = await adapter.materializeConfig(
        { providerKind: "openai_compatible", providerId: "p", modelId: "m" },
        "/tmp/test",
        { compaction: { auto: true, thresholdPercent: 75 } },
      );

      const parsed = JSON.parse(result.configFiles.get(".roo/settings.json") ?? "{}");
      expect(parsed.autoCondenseContext).toBe(true);
      expect(parsed.condenseContextPercentThreshold).toBe(75);
    });

    it("omits context condensing settings when no compaction options are provided", async () => {
      const adapter = createZooAdapter();
      const result = await adapter.materializeConfig(
        { providerKind: "openai_compatible", providerId: "p", modelId: "m" },
        "/tmp/test",
      );

      const parsed = JSON.parse(result.configFiles.get(".roo/settings.json") ?? "{}");
      expect(parsed.autoCondenseContext).toBeUndefined();
    });
  });
});

describe("materializeRuntimeBundle", () => {
  const baseModel = {
    providerKind: "openai_compatible" as const,
    providerId: "test-provider",
    modelId: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
  };

  it("materializes agent config without instructions or skills", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-minimal-"));

    try {
      const adapter = createKiloAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
      });

      expect(result.workingDir).toBe(tempDir);
      expect(result.configFiles.has(".kilo/kilo.json")).toBe(true);
      expect(result.configFiles.has("manifest.json")).toBe(true);
      expect(result.manifest.version).toBe(1);
      expect(result.manifest.agentKind).toBe("kilo");
      expect(result.manifest.model.providerId).toBe("test-provider");
      expect(result.manifest.model.modelId).toBe("gpt-4o");
      expect(result.manifest.instructions).toHaveLength(0);
      expect(result.manifest.skills).toHaveLength(0);
      expect(result.manifest.mcpTools).toHaveLength(0);

      const manifestContent = await readFile(result.manifestPath, "utf8");
      const parsed = JSON.parse(manifestContent);
      expect(parsed.version).toBe(1);
      expect(parsed.agentKind).toBe("kilo");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes instructions as files in the instructions directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-instr-"));

    try {
      const adapter = createKiloAdapter();
      const instructions: RuntimeBundleInstruction[] = [
        { kind: "nearest_agents", label: "src/AGENTS.md", content: "# Rules\nNo console.log", path: "src/AGENTS.md" },
        { kind: "root_agents", label: "AGENTS.md", content: "# Root rules" },
      ];

      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        instructions,
      });

      expect(result.manifest.instructions).toHaveLength(2);
      expect(result.manifest.instructions[0]?.kind).toBe("nearest_agents");
      expect(result.manifest.instructions[1]?.kind).toBe("root_agents");

      const instrFile = await readFile(join(tempDir, "instructions", "0_src_AGENTS.md"), "utf8");
      expect(instrFile).toBe("# Rules\nNo console.log");

      const rootInstrFile = await readFile(join(tempDir, "instructions", "root_agents_1.md"), "utf8");
      expect(rootInstrFile).toBe("# Root rules");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes skills in the canonical .agents/skills/<name>/SKILL.md layout", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-skills-"));

    try {
      const adapter = createKiloAdapter();
      const skills: RuntimeBundleSkill[] = [
        {
          name: "repository-baseline-validation",
          description: "Validate repo baseline conventions",
          content: "---\nname: repository-baseline-validation\n---\n\n# Skill content",
          path: ".agents/skills/repository-baseline-validation/SKILL.md",
        },
        {
          name: "plan-audit",
          description: "Audit plan vs implementation",
          content: "---\nname: plan-audit\n---\n\n# Plan audit skill",
        },
      ];

      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        skills,
      });

      expect(result.manifest.skills).toHaveLength(2);
      expect(result.manifest.skills[0]?.name).toBe("repository-baseline-validation");
      expect(result.manifest.skills[0]?.path).toBe(
        ".agents/skills/repository-baseline-validation/SKILL.md",
      );
      expect(result.manifest.skills[1]?.path).toBe(".agents/skills/plan-audit/SKILL.md");

      const skillFile = await readFile(
        join(tempDir, ".agents", "skills", "repository-baseline-validation", "SKILL.md"),
        "utf8",
      );
      expect(skillFile).toContain("repository-baseline-validation");

      const kiloJson = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(kiloJson.skills).toEqual({ paths: [".agents/skills"] });
      expect(result.manifest.nativeSurfaces?.skills).toContain(".agents/skills");
      expect(result.manifest.nativeSurfaces?.skills).toContain("kilo.json:skills.paths");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects skill names that would overwrite the same normalized directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-skill-collision-"));

    try {
      await expect(materializeRuntimeBundle({
        adapter: createKiloAdapter(),
        model: baseModel,
        workingDir: tempDir,
        skills: [
          { name: "Review Helper", description: "first", content: "first" },
          { name: "review-helper", description: "second", content: "second" },
        ],
      })).rejects.toThrow(/collide after normalization/iu);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes one combined AGENTS.md instruction surface for kilo", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-agentsmd-"));

    try {
      const adapter = createKiloAdapter();
      const instructions: RuntimeBundleInstruction[] = [
        { kind: "nearest_agents", label: "src/AGENTS.md", content: "# Rules\nNo console.log", path: "src/AGENTS.md" },
        { kind: "root_agents", label: "AGENTS.md", content: "# Root rules" },
      ];

      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        instructions,
      });

      const agentsMd = await readFile(join(tempDir, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("## src/AGENTS.md (source: `src/AGENTS.md`)");
      expect(agentsMd).toContain("# Rules\nNo console.log");
      expect(agentsMd).toContain("## AGENTS.md");
      expect(agentsMd).toContain("# Root rules");

      const kiloJson = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(kiloJson.instructions).toBeUndefined();
      expect(result.manifest.nativeSurfaces?.instructions).toEqual(["AGENTS.md"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes CLAUDE.md import and .claude/skills copies for claude-code", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-claude-native-"));

    try {
      const adapter = createClaudeCodeAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: {
          providerKind: "anthropic",
          providerId: "anthropic",
          modelId: "claude-sonnet-4",
        },
        workingDir: tempDir,
        instructions: [
          { kind: "root_agents", label: "AGENTS.md", content: "# Root rules" },
        ],
        skills: [
          {
            name: "plan-audit",
            description: "Audit plan vs implementation",
            content: "---\nname: plan-audit\n---\n\n# Plan audit skill",
          },
        ],
      });

      const claudeMd = await readFile(join(tempDir, "CLAUDE.md"), "utf8");
      expect(claudeMd).toBe("@AGENTS.md\n");

      const claudeSkill = await readFile(
        join(tempDir, ".claude", "skills", "plan-audit", "SKILL.md"),
        "utf8",
      );
      expect(claudeSkill).toContain("plan-audit");

      expect(result.manifest.nativeSurfaces?.instructions).toContain("AGENTS.md");
      expect(result.manifest.nativeSurfaces?.instructions).toContain("CLAUDE.md");
      expect(result.manifest.nativeSurfaces?.skills).toContain(".claude/skills");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("injects mcp and skill permission without duplicating AGENTS.md in opencode.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-opencode-"));

    try {
      const adapter = createOpencodeAdapter();
      const mcpServers: RuntimeBundleMcpServer[] = [
        {
          name: "aicr-output",
          config: { type: "local", command: ["node", "/app/packages/mcp-output/dist/server.js"] },
        },
      ];

      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        instructions: [
          { kind: "root_agents", label: "AGENTS.md", content: "# Root rules" },
        ],
        skills: [
          {
            name: "plan-audit",
            description: "Audit plan vs implementation",
            content: "---\nname: plan-audit\n---\n\n# Plan audit skill",
          },
        ],
        mcpServers,
      });

      const parsed = JSON.parse(result.configFiles.get("opencode.json") ?? "{}");
      expect(parsed.mcp["aicr-output"]).toEqual({
        enabled: true,
        type: "local",
        command: ["node", "/app/packages/mcp-output/dist/server.js"],
      });
      expect(parsed.instructions).toBeUndefined();
      expect(parsed.permission).toEqual({ skill: { "*": "allow" } });
      expect(result.manifest.nativeSurfaces?.instructions).toEqual(["AGENTS.md"]);
      expect(result.manifest.nativeSurfaces?.mcp).toBe("config_file");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records cli_flag MCP surface for claude-code and none for zoo", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-mcp-surface-"));

    try {
      const mcpServers: RuntimeBundleMcpServer[] = [
        {
          name: "aicr-output",
          config: { type: "local", command: ["node", "/app/packages/mcp-output/dist/server.js"] },
        },
      ];

      const claudeResult = await materializeRuntimeBundle({
        adapter: createClaudeCodeAdapter(),
        model: { providerKind: "anthropic", providerId: "p", modelId: "m" },
        workingDir: join(tempDir, "claude"),
        mcpServers,
      });
      expect(claudeResult.manifest.nativeSurfaces?.mcp).toBe("cli_flag");

      const zooResult = await materializeRuntimeBundle({
        adapter: createZooAdapter(),
        model: baseModel,
        workingDir: join(tempDir, "zoo"),
        mcpServers,
      });
      expect(zooResult.manifest.nativeSurfaces?.mcp).toBe("none");

      const noMcpResult = await materializeRuntimeBundle({
        adapter: createKiloAdapter(),
        model: baseModel,
        workingDir: join(tempDir, "kilo"),
      });
      expect(noMcpResult.manifest.nativeSurfaces?.mcp).toBe("none");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes MCP tool names in manifest", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-mcp-"));

    try {
      const adapter = createKiloAdapter();
      const mcpTools: RuntimeBundleMcpTool[] = [
        { name: "aicr.report_problem", description: "Report a code review problem" },
        { name: "aicr.publish_summary", description: "Publish review summary" },
        { name: "aicr.skip", description: "Skip output" },
        { name: "aicr.fetch_more_context", description: "Fetch more source context" },
        { name: "aicr.try_blame", description: "Fetch VCS attribution" },
      ];

      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        mcpTools,
      });

      expect(result.manifest.mcpTools).toHaveLength(5);
      expect(result.manifest.mcpTools).toContain("aicr.report_problem");
      expect(result.manifest.mcpTools).toContain("aicr.publish_summary");
      expect(result.manifest.mcpTools).toContain("aicr.skip");
      expect(result.manifest.mcpTools).toContain("aicr.fetch_more_context");
      expect(result.manifest.mcpTools).toContain("aicr.try_blame");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("merges extra env vars with adapter env vars", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-env-"));

    try {
      const adapter = createKiloAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: { ...baseModel, apiKeyEnv: "OPENAI_API_KEY" },
        workingDir: tempDir,
        extraEnvVars: {
          AICR_RUN_ID: "run-123",
          AICR_WORKSPACE_ID: "ws-main",
        },
      });

      expect(result.envVars.KILO_API_KEY).toBe("${OPENAI_API_KEY}");
      expect(result.envVars.AICR_RUN_ID).toBe("run-123");
      expect(result.envVars.AICR_WORKSPACE_ID).toBe("ws-main");
      expect(result.manifest.envKeys).toContain("KILO_API_KEY");
      expect(result.manifest.envKeys).toContain("AICR_RUN_ID");
      expect(result.manifest.envKeys).toContain("AICR_WORKSPACE_ID");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes runId in manifest when provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-runid-"));

    try {
      const adapter = createKiloAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        runId: "run-abc-456",
      });

      expect(result.manifest.runId).toBe("run-abc-456");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("omits runId from manifest when not provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-norunid-"));

    try {
      const adapter = createKiloAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
      });

      expect(result.manifest.runId).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records contextCompaction in manifest for kilo with compaction enabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-compaction-"));

    try {
      const adapter = createKiloAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        compaction: { auto: true, thresholdPercent: 80, prune: true },
      });

      expect(result.manifest.contextCompaction).toEqual({ enabled: true, mode: "injected" });
      const parsed = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(parsed.compaction?.auto).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records delegated contextCompaction for claude-code", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-compaction-cc-"));

    try {
      const adapter = createClaudeCodeAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: {
          providerKind: "anthropic",
          providerId: "anthropic",
          modelId: "claude-sonnet-4",
        },
        workingDir: tempDir,
        compaction: { auto: true },
      });

      expect(result.manifest.contextCompaction).toEqual({ enabled: true, mode: "delegated" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records disabled delegated contextCompaction for claude-code opt-out", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-compaction-cc-off-"));

    try {
      const adapter = createClaudeCodeAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: {
          providerKind: "anthropic",
          providerId: "anthropic",
          modelId: "claude-sonnet-4",
        },
        workingDir: tempDir,
        compaction: { auto: false },
      });

      expect(result.manifest.contextCompaction).toEqual({ enabled: false, mode: "delegated" });
      expect(result.envVars.DISABLE_AUTO_COMPACT).toBe("1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records not_applicable contextCompaction for copilot-cli", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-compaction-cp-"));

    try {
      const adapter = createCopilotCliAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        compaction: { auto: true },
      });

      expect(result.manifest.contextCompaction).toEqual({ enabled: false, mode: "not_applicable" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("works with claude-code adapter", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-claude-"));

    try {
      const adapter = createClaudeCodeAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: {
          providerKind: "anthropic",
          providerId: "anthropic-prod",
          modelId: "claude-sonnet-4",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
        workingDir: tempDir,
        instructions: [
          { kind: "root_agents", label: "AGENTS.md", content: "# Project rules" },
        ],
      });

      expect(result.manifest.agentKind).toBe("claude-code");
      expect(result.manifest.instructions).toHaveLength(1);
      expect(result.envVars.ANTHROPIC_API_KEY).toBe("${ANTHROPIC_API_KEY}");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates manifest with all config file entries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-all-"));

    try {
      const adapter = createKiloAdapter();
      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        instructions: [
          { kind: "path_instruction", label: "ts rules", content: "strict mode", path: ".github/instructions/ts.instructions.md" },
        ],
        skills: [
          { name: "test-skill", description: "A test skill", content: "skill body" },
        ],
        mcpTools: [
          { name: "aicr.report_problem", description: "Report problem" },
        ],
      });

      expect(result.configFiles.has(".kilo/kilo.json")).toBe(true);
      expect(result.configFiles.has("manifest.json")).toBe(true);
      expect(result.configFiles.size).toBeGreaterThanOrEqual(3);

      const manifestContent = await readFile(result.manifestPath, "utf8");
      const parsed = JSON.parse(manifestContent);
      expect(parsed.instructions).toHaveLength(1);
      expect(parsed.skills).toHaveLength(1);
      expect(parsed.mcpTools).toContain("aicr.report_problem");
      expect(parsed.createdAt).toBeTruthy();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("injects MCP server config into kilo.json when mcpServers provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-mcpserver-"));

    try {
      const adapter = createKiloAdapter();
      const mcpServers: RuntimeBundleMcpServer[] = [
        {
          name: "aicr-output",
          config: {
            type: "local",
            command: ["node", "/app/packages/mcp-output/dist/server.js"],
            enabled: true,
          },
        },
      ];

      const result = await materializeRuntimeBundle({
        adapter,
        model: baseModel,
        workingDir: tempDir,
        mcpServers,
      });

      const kiloConfig = result.configFiles.get(".kilo/kilo.json") ?? "{}";
      const parsed = JSON.parse(kiloConfig);
      expect(parsed.mcp).toBeDefined();
      expect(parsed.mcp["aicr-output"]).toBeDefined();
      expect((parsed.mcp["aicr-output"] as Record<string, unknown>).type).toBe("local");
      expect((parsed.mcp["aicr-output"] as Record<string, unknown>).enabled).toBe(true);

      const diskContent = await readFile(join(tempDir, ".kilo", "kilo.json"), "utf8");
      const diskParsed = JSON.parse(diskContent);
      expect(diskParsed.mcp["aicr-output"]).toBeDefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("model metadata injection (M10 catalog)", () => {
  const enrichedModel: ModelSpec = {
    providerKind: "openai_compatible",
    providerId: "custom-gateway",
    modelId: "gpt-4o",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsVision: true,
    supportsCachePrompt: true,
    costInputPerMTok: 2.5,
    costOutputPerMTok: 10,
    costCacheReadPerMTok: 1.25,
    costCacheWritePerMTok: 3.75,
    catalogSource: "remote",
  };

  it("kilo injects context window, pricing, and capabilities into models entry", async () => {
    const adapter = createKiloAdapter();
    const result = await adapter.materializeConfig(enrichedModel, "/tmp/test");
    const parsed = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
    const modelInfo = parsed.provider["custom-gateway"]?.models?.["gpt-4o"];
    expect(modelInfo).toBeDefined();
    expect(modelInfo.contextWindow).toBe(128000);
    expect(modelInfo.maxTokens).toBe(16384);
    expect(modelInfo.supportsImages).toBe(true);
    expect(modelInfo.supportsPromptCache).toBe(true);
    expect(modelInfo.inputPrice).toBe(2.5);
    expect(modelInfo.outputPrice).toBe(10);
    expect(modelInfo.cacheReadsPrice).toBe(1.25);
    expect(modelInfo.cacheWritesPrice).toBe(3.75);
  });

  it("kilo emits empty models entry when no catalog metadata present", async () => {
    const adapter = createKiloAdapter();
    const result = await adapter.materializeConfig(
      { providerKind: "openai_compatible", providerId: "p", modelId: "m" },
      "/tmp/test",
    );
    const parsed = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
    expect(parsed.provider.p?.models?.m).toEqual({});
  });

  it("zoo injects openAiCustomModelInfo", async () => {
    const adapter = createZooAdapter();
    const result = await adapter.materializeConfig(enrichedModel, "/tmp/test");
    const parsed = JSON.parse(result.configFiles.get(".roo/settings.json") ?? "{}");
    const info = parsed.apiConfiguration?.openAiCustomModelInfo;
    expect(info).toBeDefined();
    expect(info.contextWindow).toBe(128000);
    expect(info.maxTokens).toBe(16384);
    expect(info.supportsImages).toBe(true);
    expect(info.inputPrice).toBe(2.5);
    expect(info.outputPrice).toBe(10);
  });

  it("opencode injects models block for custom providers", async () => {
    const adapter = createOpencodeAdapter();
    const result = await adapter.materializeConfig(enrichedModel, "/tmp/test");
    const parsed = JSON.parse(result.configFiles.get("opencode.json") ?? "{}");
    expect(parsed.models).toBeUndefined();
    const entry = parsed.provider["custom-gateway"]?.models?.["gpt-4o"];
    expect(entry.limit.context).toBe(128000);
    expect(entry.limit.output).toBe(16384);
    expect(entry.cost.input).toBe(2.5);
    expect(entry.cost.output).toBe(10);
    expect(entry.cost.cache_read).toBe(1.25);
  });

  it("opencode does not inject models for known providers (delegates to native catalog)", async () => {
    const adapter = createOpencodeAdapter();
    const result = await adapter.materializeConfig(
      { providerKind: "anthropic", providerId: "anthropic", modelId: "claude-sonnet-4-5", contextWindow: 200000 },
      "/tmp/test",
    );
    const parsed = JSON.parse(result.configFiles.get("opencode.json") ?? "{}");
    expect(parsed.models).toBeUndefined();
    expect(parsed.provider.anthropic?.models).toBeUndefined();
  });

  it("opencode omits schema-invalid partial limit and cost blocks", async () => {
    const adapter = createOpencodeAdapter();
    const result = await adapter.materializeConfig(
      {
        providerKind: "openai_compatible",
        providerId: "custom",
        modelId: "partial",
        contextWindow: 128_000,
        costInputPerMTok: 1,
      },
      "/tmp/test",
    );
    const parsed = JSON.parse(result.configFiles.get("opencode.json") ?? "{}");
    const entry = parsed.provider.custom.models.partial;
    expect(entry.limit).toBeUndefined();
    expect(entry.cost).toBeUndefined();
  });

  it("opencode maps custom model capabilities into its native model schema", async () => {
    const adapter = createOpencodeAdapter();
    const result = await adapter.materializeConfig(
      {
        providerKind: "openai_compatible",
        providerId: "custom",
        modelId: "capable",
        supportsAttachment: true,
        supportsReasoning: true,
        supportsTemperature: false,
        supportsToolCall: true,
        supportsInterleavedReasoning: true,
        interleavedReasoningField: "reasoning_content",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
      },
      "/tmp/test",
    );
    const parsed = JSON.parse(result.configFiles.get("opencode.json") ?? "{}");
    expect(parsed.provider.custom.models.capable).toMatchObject({
      attachment: true,
      reasoning: true,
      temperature: false,
      tool_call: true,
      interleaved: "reasoning_content",
      modalities: { input: ["text", "image"], output: ["text"] },
    });
  });

  it("opencode drops modality values that its config schema does not accept", async () => {
    const adapter = createOpencodeAdapter();
    const result = await adapter.materializeConfig(
      {
        providerKind: "openai_compatible",
        providerId: "custom",
        modelId: "modalities",
        inputModalities: ["text", "repository"],
        outputModalities: ["unknown"],
      },
      "/tmp/test",
    );
    const parsed = JSON.parse(result.configFiles.get("opencode.json") ?? "{}");
    expect(parsed.provider.custom.models.modalities.modalities).toEqual({
      input: ["text"],
    });
  });

  it("claude-code derives CLAUDE_CODE_MAX_OUTPUT_TOKENS from catalog maxOutputTokens when not explicitly set", async () => {
    const adapter = createClaudeCodeAdapter();
    const result = await adapter.materializeConfig(
      { providerKind: "anthropic", providerId: "anthropic", modelId: "claude", maxOutputTokens: 64000 },
      "/tmp/test",
    );
    expect(result.envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
  });

  it("claude-code prefers explicit extraParams max_tokens over catalog", async () => {
    const adapter = createClaudeCodeAdapter();
    const result = await adapter.materializeConfig(
      {
        providerKind: "anthropic",
        providerId: "anthropic",
        modelId: "claude",
        maxOutputTokens: 64000,
        extraParams: { max_tokens: 8192 },
      },
      "/tmp/test",
    );
    expect(result.envVars.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8192");
  });

  it("runtime bundle manifest records metadataInjection status and catalogSource", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-meta-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createKiloAdapter(),
        model: enrichedModel,
        workingDir: tempDir,
      });
      expect(result.manifest.model.catalogSource).toBe("remote");
      expect(result.manifest.model.metadataInjection).toBe("injected");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runtime bundle manifest degrades copilot-cli as not_applicable", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-copilot-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createCopilotCliAdapter(),
        model: enrichedModel,
        workingDir: tempDir,
      });
      expect(result.manifest.model.metadataInjection).toBe("not_applicable");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runtime bundle manifest delegates opencode known provider", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-opencode-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createOpencodeAdapter(),
        model: { providerKind: "anthropic", providerId: "anthropic", modelId: "claude-sonnet-4-5" },
        workingDir: tempDir,
      });
      expect(result.manifest.model.metadataInjection).toBe("delegated");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runtime bundle manifest injects opencode custom provider catalog metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-opencode-injected-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createOpencodeAdapter(),
        model: enrichedModel,
        workingDir: tempDir,
      });
      expect(result.manifest.model.metadataInjection).toBe("injected");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runtime bundle manifest injects zoo custom model info", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-zoo-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createZooAdapter(),
        model: enrichedModel,
        workingDir: tempDir,
      });
      expect(result.manifest.model.metadataInjection).toBe("injected");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runtime bundle manifest delegates claude-code", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-claude-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createClaudeCodeAdapter(),
        model: enrichedModel,
        workingDir: tempDir,
      });
      expect(result.manifest.model.metadataInjection).toBe("delegated");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

const piFamilyModel: ModelSpec = {
  providerKind: "openai_compatible",
  providerId: "test-provider",
  modelId: "gpt-4o",
  baseUrl: "https://gateway.example.com/v1",
  apiKeyEnv: "AICR_TEST_API_KEY",
  contextWindow: 128000,
  maxOutputTokens: 16384,
  supportsReasoning: true,
  supportsVision: true,
  costInputPerMTok: 2.5,
  costOutputPerMTok: 10,
  costCacheReadPerMTok: 0.25,
  costCacheWritePerMTok: 2.5,
};

describe("createPiAdapter", () => {
  it("builds the documented --mode json command with trust and ephemeral session", () => {
    const adapter = createPiAdapter();
    const command = adapter.buildCommand("review this diff", {
      workingDir: "/tmp/agent",
      task: "review this diff",
      model: piFamilyModel,
    });
    expect(command).toEqual([
      "pi",
      "--mode", "json",
      "--approve",
      "--no-session",
      "--model", "test-provider/gpt-4o",
      "--",
      "review this diff",
    ]);
  });

  it("passes --thinking from reasoning effort", () => {
    const adapter = createPiAdapter();
    const command = adapter.buildCommand("t", {
      workingDir: "/tmp/agent",
      task: "t",
      model: { ...piFamilyModel, defaultReasoningEffort: "high" as const },
    });
    expect(command).toContain("--thinking");
    expect(command[command.indexOf("--thinking") + 1]).toBe("high");
  });

  it("prefers an explicit reasoning effort over the catalog default", () => {
    const model = {
      ...piFamilyModel,
      reasoningEffort: "high" as const,
      defaultReasoningEffort: "low" as const,
    };
    for (const adapter of [createPiAdapter(), createOhMyPiAdapter()]) {
      const command = adapter.buildCommand("t", { workingDir: "/tmp/agent", task: "t", model });
      expect(command[command.indexOf("--thinking") + 1]).toBe("high");
    }
  });

  it("keeps stdin empty so the prompt is never double-fed", () => {
    const adapter = createPiAdapter();
    expect(adapter.buildStdin?.("task", { workingDir: "/tmp/agent", task: "task" })).toBe("");
  });

  it("materializes models.json and settings.json with env-indirected credentials", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-pi-materialize-"));
    try {
      const adapter = createPiAdapter();
      const result = await adapter.materializeConfig(piFamilyModel, tempDir, {
        compaction: { auto: true, thresholdPercent: 85 },
      });

      const modelsJson = JSON.parse(result.configFiles.get(".pi-agent/models.json") ?? "{}");
      const provider = modelsJson.providers["test-provider"];
      expect(provider.baseUrl).toBe("https://gateway.example.com/v1");
      expect(provider.api).toBe("openai-completions");
      expect(provider.apiKey).toBe("$AICR_TEST_API_KEY");
      expect(provider.models).toHaveLength(1);
      expect(provider.models[0]).toMatchObject({
        id: "gpt-4o",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 2.5 },
      });

      // pi settings.json has no threshold_percent field; only the on/off state is injected.
      const settings = JSON.parse(result.configFiles.get(".pi-agent/settings.json") ?? "{}");
      expect(settings).toEqual({ compaction: { enabled: true } });

      expect(result.envVars.PI_OFFLINE).toBe("1");
      expect(result.envVars.PI_TELEMETRY).toBe("0");
      expect(result.envVars.AICR_TEST_API_KEY).toBe("${AICR_TEST_API_KEY}");

      const written = await readFile(join(tempDir, ".pi-agent", "models.json"), "utf8");
      expect(JSON.parse(written).providers["test-provider"].api).toBe("openai-completions");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("maps anthropic provider kind to anthropic-messages with the default endpoint", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-pi-anthropic-"));
    try {
      const adapter = createPiAdapter();
      const model: ModelSpec = {
        providerKind: "anthropic",
        providerId: "anthropic-main",
        modelId: "claude-sonnet-4-5",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        contextWindow: 200000,
        maxOutputTokens: 64000,
      };
      const result = await adapter.materializeConfig(model, tempDir);
      const modelsJson = JSON.parse(result.configFiles.get(".pi-agent/models.json") ?? "{}");
      expect(modelsJson.providers["anthropic-main"].api).toBe("anthropic-messages");
      expect(modelsJson.providers["anthropic-main"].baseUrl).toBe("https://api.anthropic.com");
      expect(modelsJson.providers["anthropic-main"].models[0].input).toEqual(["text"]);
      expect(modelsJson.providers["anthropic-main"].models[0].cost).toEqual({
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes a placeholder apiKey for keyless providers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-pi-ollama-"));
    try {
      const adapter = createPiAdapter();
      const model: ModelSpec = {
        providerKind: "ollama",
        providerId: "local-ollama",
        modelId: "qwen2.5-coder",
        contextWindow: 32768,
        maxOutputTokens: 8192,
      };
      const result = await adapter.materializeConfig(model, tempDir);
      const modelsJson = JSON.parse(result.configFiles.get(".pi-agent/models.json") ?? "{}");
      expect(modelsJson.providers["local-ollama"].baseUrl).toBe("http://127.0.0.1:11434/v1");
      expect(modelsJson.providers["local-ollama"].apiKey).toBe("aicr-local-no-auth");
      expect(result.envVars.AICR_TEST_API_KEY).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects provider kinds without a verified custom-provider pipeline", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-pi-unsupported-"));
    try {
      const adapter = createPiAdapter();
      const model: ModelSpec = {
        providerKind: "copilot",
        providerId: "copilot",
        modelId: "gpt-4o",
        contextWindow: 128000,
        maxOutputTokens: 16384,
      };
      await expect(adapter.materializeConfig(model, tempDir)).rejects.toThrow(/does not support/iu);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with actionable guidance when catalog limits are unknown", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-pi-nolimits-"));
    try {
      const adapter = createPiAdapter();
      const model: ModelSpec = {
        providerKind: "openai_compatible",
        providerId: "test-provider",
        modelId: "mystery-model",
        baseUrl: "https://gateway.example.com/v1",
      };
      await expect(adapter.materializeConfig(model, tempDir)).rejects.toThrow(/model_catalog/iu);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("omits compaction settings when no compaction options are provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-pi-nocompact-"));
    try {
      const adapter = createPiAdapter();
      const result = await adapter.materializeConfig(piFamilyModel, tempDir);
      const settings = JSON.parse(result.configFiles.get(".pi-agent/settings.json") ?? "{}");
      expect(settings).toEqual({});
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("injects compaction enabled=false when auto compaction is off", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-pi-compactoff-"));
    try {
      const adapter = createPiAdapter();
      const result = await adapter.materializeConfig(piFamilyModel, tempDir, {
        compaction: { auto: false },
      });
      const settings = JSON.parse(result.configFiles.get(".pi-agent/settings.json") ?? "{}");
      expect(settings).toEqual({ compaction: { enabled: false } });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("createOhMyPiAdapter", () => {
  it("builds the documented -p --mode json command", () => {
    const adapter = createOhMyPiAdapter();
    const command = adapter.buildCommand("review this diff", {
      workingDir: "/tmp/agent",
      task: "review this diff",
      model: { ...piFamilyModel, defaultReasoningEffort: "medium" as const },
    });
    expect(command).toEqual([
      "omp",
      "-p",
      "--mode", "json",
      "--auto-approve",
      "--no-session",
      "--model", "test-provider/gpt-4o",
      "--thinking", "medium",
      "--",
      "review this diff",
    ]);
  });

  it("materializes models.yml with env-name apiKey indirection", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-omp-materialize-"));
    try {
      const adapter = createOhMyPiAdapter();
      const result = await adapter.materializeConfig(piFamilyModel, tempDir, {
        compaction: { auto: true, thresholdPercent: 90 },
      });

      const modelsYaml = result.configFiles.get(".omp-agent/models.yml") ?? "";
      expect(modelsYaml).toContain("providers:");
      expect(modelsYaml).toContain('"test-provider":');
      expect(modelsYaml).toContain('baseUrl: "https://gateway.example.com/v1"');
      expect(modelsYaml).toContain('api: "openai-completions"');
      expect(modelsYaml).toContain('apiKey: "AICR_TEST_API_KEY"');
      expect(modelsYaml).toContain('- id: "gpt-4o"');
      expect(modelsYaml).toContain("reasoning: true");
      expect(modelsYaml).toContain('input: ["text", "image"]');
      expect(modelsYaml).toContain("contextWindow: 128000");
      expect(modelsYaml).toContain("maxTokens: 16384");

      const configYaml = result.configFiles.get(".omp-agent/config.yml") ?? "";
      expect(configYaml).toContain("compaction:");
      expect(configYaml).toContain("enabled: true");
      expect(configYaml).toContain("thresholdPercent: 90");

      expect(result.envVars.AICR_TEST_API_KEY).toBe("${AICR_TEST_API_KEY}");

      const written = await readFile(join(tempDir, ".omp-agent", "models.yml"), "utf8");
      expect(written).toBe(modelsYaml);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks keyless providers as auth none", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-omp-keyless-"));
    try {
      const adapter = createOhMyPiAdapter();
      const model: ModelSpec = {
        providerKind: "ollama",
        providerId: "local-ollama",
        modelId: "qwen2.5-coder",
        contextWindow: 32768,
        maxOutputTokens: 8192,
      };
      const result = await adapter.materializeConfig(model, tempDir);
      const modelsYaml = result.configFiles.get(".omp-agent/models.yml") ?? "";
      expect(modelsYaml).toContain('auth: "none"');
      expect(modelsYaml).not.toContain("apiKey");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects provider kinds without a verified custom-provider pipeline", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-omp-unsupported-"));
    try {
      const adapter = createOhMyPiAdapter();
      const model: ModelSpec = {
        providerKind: "bedrock",
        providerId: "aws",
        modelId: "claude-sonnet-4",
        contextWindow: 200000,
        maxOutputTokens: 64000,
      };
      await expect(adapter.materializeConfig(model, tempDir)).rejects.toThrow(/does not support/iu);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("toOhMyPiMcpServersJson", () => {
  it("converts local and remote servers to the omp mcp.json shape", () => {
    const json = toOhMyPiMcpServersJson([
      {
        name: "aicr-output",
        config: {
          type: "local",
          command: ["node", "/app/packages/mcp-output/dist/server.js"],
          environment: { AICR_OUTPUT_STATE_PATH: "/workspace/agent/.aicr-output-state.json" },
        },
      },
      {
        name: "remote-docs",
        config: { type: "remote", url: "https://mcp.example.com/mcp", headers: { "X-Key": "k" } },
      },
    ]);
    expect(json).toBeDefined();
    const parsed = JSON.parse(json!);
    expect(parsed.mcpServers["aicr-output"]).toEqual({
      command: "node",
      args: ["/app/packages/mcp-output/dist/server.js"],
      env: { AICR_OUTPUT_STATE_PATH: "/workspace/agent/.aicr-output-state.json" },
    });
    expect(parsed.mcpServers["remote-docs"]).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Key": "k" },
    });
  });

  it("returns undefined when nothing converts", () => {
    expect(toOhMyPiMcpServersJson([])).toBeUndefined();
    expect(toOhMyPiMcpServersJson([{
      name: "malformed",
      config: { type: "local", command: ["node", 42, "server.js"] },
    }])).toBeUndefined();
    expect(toOhMyPiMcpServersJson([{
      name: "empty-command",
      config: { type: "local", command: ["  "] },
    }])).toBeUndefined();
    expect(toOhMyPiMcpServersJson([{
      name: "malformed-env",
      config: { type: "local", command: ["node", "server.js"], environment: { TOKEN: 42 } },
    }])).toBeUndefined();
    expect(toOhMyPiMcpServersJson([{
      name: "malformed-headers",
      config: { type: "remote", url: "https://mcp.example", headers: { authorization: 42 } },
    }])).toBeUndefined();
  });
});

describe("runtime bundle pi/oh-my-pi wiring", () => {
  const aicrMcpServer: RuntimeBundleMcpServer = {
    name: "aicr-output",
    config: {
      type: "local",
      command: ["node", "/app/packages/mcp-output/dist/server.js"],
      environment: { AICR_OUTPUT_STATE_PATH: "/workspace/agent/.aicr-output-state.json" },
    },
  };

  it("generates the MCP bridge extension for pi and records the extension surface", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-pi-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createPiAdapter(),
        model: piFamilyModel,
        workingDir: tempDir,
        instructions: [{ kind: "root_agents", label: "AGENTS.md", content: "# Rules" }],
        skills: [{
          name: "repo-checks",
          description: "Repo checks",
          content: "---\nname: repo-checks\n---\n\n# Repo checks",
        }],
        mcpTools: [{ name: "aicr.skip", description: "skip" }],
        mcpServers: [aicrMcpServer],
        compaction: { auto: true, thresholdPercent: 80 },
      });

      const bridge = result.configFiles.get(".pi-agent/extensions/aicr-output.ts") ?? "";
      expect(bridge).toContain("AICR_PI_MCP_SERVERS");
      expect(bridge).toContain("pi.registerTool");
      expect(bridge).toContain('"pi_"');
      const bridgeOnDisk = await readFile(join(tempDir, ".pi-agent", "extensions", "aicr-output.ts"), "utf8");
      expect(bridgeOnDisk).toBe(bridge);

      const specJson = result.envVars.AICR_PI_MCP_SERVERS;
      expect(specJson).toBeDefined();
      const specs = JSON.parse(specJson!);
      expect(specs).toEqual([{
        name: "aicr-output",
        command: ["node", "/app/packages/mcp-output/dist/server.js"],
        environment: { AICR_OUTPUT_STATE_PATH: "/workspace/agent/.aicr-output-state.json" },
      }]);

      expect(result.manifest.nativeSurfaces?.mcp).toBe("extension");
      expect(result.manifest.nativeSurfaces?.instructions).toContain("AGENTS.md");
      expect(result.manifest.nativeSurfaces?.skills).toContain(".agents/skills");
      expect(result.manifest.model.metadataInjection).toBe("injected");
      expect(result.manifest.contextCompaction).toEqual({ enabled: true, mode: "delegated" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips the pi bridge when no MCP servers are configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-pi-nomcp-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createPiAdapter(),
        model: piFamilyModel,
        workingDir: tempDir,
      });
      expect(result.configFiles.has(".pi-agent/extensions/aicr-output.ts")).toBe(false);
      expect(result.envVars.AICR_PI_MCP_SERVERS).toBeUndefined();
      expect(result.manifest.nativeSurfaces?.mcp).toBe("none");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports mcp surface none when pi servers never materialize a bridge", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-pi-remote-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createPiAdapter(),
        model: piFamilyModel,
        workingDir: tempDir,
        mcpServers: [{
          name: "remote-docs",
          config: { type: "remote", url: "https://mcp.example.com/mcp" },
        }],
      });
      // Remote-only servers are not bridged (the extension spawns stdio children),
      // so the manifest must not claim an extension surface.
      expect(result.configFiles.has(".pi-agent/extensions/aicr-output.ts")).toBe(false);
      expect(result.envVars.AICR_PI_MCP_SERVERS).toBeUndefined();
      expect(result.manifest.nativeSurfaces?.mcp).toBe("none");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("writes .omp-agent/mcp.json for oh-my-pi and records the config_file surface", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-omp-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createOhMyPiAdapter(),
        model: piFamilyModel,
        workingDir: tempDir,
        mcpServers: [aicrMcpServer],
        compaction: { auto: true },
      });

      const mcpJson = JSON.parse(result.configFiles.get(".omp-agent/mcp.json") ?? "{}");
      expect(mcpJson.mcpServers["aicr-output"]).toEqual({
        command: "node",
        args: ["/app/packages/mcp-output/dist/server.js"],
        env: { AICR_OUTPUT_STATE_PATH: "/workspace/agent/.aicr-output-state.json" },
      });
      const onDisk = await readFile(join(tempDir, ".omp-agent", "mcp.json"), "utf8");
      expect(JSON.parse(onDisk)).toEqual(mcpJson);
      expect(result.manifest.nativeSurfaces?.mcp).toBe("config_file");
      expect(result.manifest.model.metadataInjection).toBe("injected");
      expect(result.manifest.contextCompaction).toEqual({ enabled: true, mode: "injected" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("starts the generated pi MCP bridge only from session_start and stops it on shutdown", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bundle-pi-lifecycle-"));
    try {
      const result = await materializeRuntimeBundle({
        adapter: createPiAdapter(),
        model: piFamilyModel,
        workingDir: tempDir,
        mcpServers: [aicrMcpServer],
      });
      const bridge = result.configFiles.get(".pi-agent/extensions/aicr-output.ts") ?? "";
      expect(bridge).toContain('Buffer.byteLength(this.buffer, "utf8")');

      const stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
      stdout.setEncoding = vi.fn();
      const stdin = new EventEmitter() as EventEmitter & {
        write: (payload: string) => boolean;
      };
      const kill = vi.fn();
      const child = Object.assign(new EventEmitter(), { stdout, stdin, kill });
      stdin.write = (payload: string): boolean => {
        const request = JSON.parse(payload) as { id?: number; method: string };
        if (request.id === undefined) return true;
        const response = request.method === "tools/list"
          ? {
            tools: [{
              name: "aicr_skip",
              description: "skip",
              inputSchema: { type: "object", properties: {} },
            }],
          }
          : request.method === "tools/call"
            ? { content: [{ type: "text", text: "ok" }] }
            : {};
        queueMicrotask(() => stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response })}\n`));
        return true;
      };
      const spawn = vi.fn(() => child);
      const processStub = {
        env: {
          AICR_PI_MCP_SERVERS: JSON.stringify([{
            name: "aicr-output",
            command: ["node", "server.js"],
          }]),
        },
        on: vi.fn(),
      };
      const executableSource = bridge
        .replace('import { spawn } from "node:child_process";', "const spawn = injectedSpawn;")
        .replace('import { Type } from "typebox";', "const Type = { Unsafe: (schema) => schema };")
        .replace("export default function aicrOutputBridge", "function aicrOutputBridge")
        .concat("\nreturn aicrOutputBridge;");
      const loadFactory = new Function("injectedSpawn", "process", executableSource) as (
        injectedSpawn: typeof spawn,
        injectedProcess: typeof processStub,
      ) => (pi: {
        on: (event: string, handler: () => void | Promise<void>) => void;
        registerTool: (tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => void;
      }) => void;
      const factory = loadFactory(spawn, processStub);
      const handlers = new Map<string, () => void | Promise<void>>();
      const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];

      factory({
        on: (event, handler) => handlers.set(event, handler),
        registerTool: (tool) => tools.push(tool),
      });

      expect(spawn).not.toHaveBeenCalled();
      await handlers.get("session_start")?.();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(tools.map((tool) => tool.name)).toEqual(["pi_aicr_output_aicr_skip"]);
      await expect(tools[0]?.execute("call-1", {})).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
      });

      await handlers.get("session_shutdown")?.();
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
