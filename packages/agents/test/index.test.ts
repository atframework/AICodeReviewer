import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentPackageName,
  createKiloAdapter,
  createClaudeCodeAdapter,
  createCopilotCliAdapter,
  createOpencodeAdapter,
  createRooAdapter,
  createOpenAICompatibleTranslator,
  createAnthropicTranslator,
  createVertexAiTranslator,
  createBedrockTranslator,
  createAgentAdapter,
} from "../src/index.js";

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

  it("creates a roo adapter", () => {
    const adapter = createAgentAdapter({ kind: "roo" });
    expect(adapter.kind).toBe("roo");
  });

  it("creates a copilot-cli adapter", () => {
    const adapter = createAgentAdapter({ kind: "copilot-cli" });
    expect(adapter.kind).toBe("copilot-cli");
  });

  it("creates a claude-code adapter", () => {
    const adapter = createAgentAdapter({ kind: "claude-code" });
    expect(adapter.kind).toBe("claude-code");
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
      expect(cmd).toContain("--dangerously-skip-permissions");
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

  it("includes anthropicVersion env var", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      anthropicVersion: "2025-01-01",
    });

    expect(result.envVars.ANTHROPIC_VERSION).toBe("2025-01-01");
  });

  it("includes anthropicBeta env var", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      anthropicBeta: ["prompt-caching-tool", "output-128k"],
    });

    expect(result.envVars.ANTHROPIC_BETA).toBe("prompt-caching-tool,output-128k");
  });

  it("includes thinking budget tokens env var", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      thinking: { enabled: true, budgetTokens: 4096 },
    });

    expect(result.envVars.ANTHROPIC_THINKING_BUDGET_TOKENS).toBe("4096");
    expect(result.cliFlags).toContain("--thinking");
  });

  it("includes max_tokens from extraParams", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      extraParams: { max_tokens: 8192, temperature: 0.7 },
    });

    expect(result.envVars.ANTHROPIC_MAX_TOKENS).toBe("8192");

    const config = JSON.parse(result.configJson);
    expect(config.temperature).toBe(0.7);
    expect(config.max_tokens).toBe(8192);
  });

  it("does not include thinking flag when thinking is not enabled", () => {
    const translator = createAnthropicTranslator("p");
    const result = translator.translate({
      providerKind: "anthropic",
      providerId: "p",
      modelId: "m",
      thinking: { enabled: false, budgetTokens: 4096 },
    });

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
    it("builds command with model and cwd", () => {
      const adapter = createClaudeCodeAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        timeoutMs: 300_000,
        model: {
          providerKind: "anthropic",
          providerId: "anthropic-prod",
          modelId: "claude-sonnet-4",
        },
      });

      expect(cmd[0]).toBe("claude");
      expect(cmd).toContain("--model");
      expect(cmd).toContain("claude-sonnet-4");
      expect(cmd).toContain("--cwd");
      expect(cmd).toContain("/workspace");
    });

    it("passes the thinking flag when Anthropic thinking is enabled", () => {
      const adapter = createClaudeCodeAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        model: {
          providerKind: "anthropic",
          providerId: "anthropic-prod",
          modelId: "claude-sonnet-4",
          thinking: { enabled: true, budgetTokens: 4096 },
        },
      });

      expect(cmd).toContain("--thinking");
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

    it("returns advanced Anthropic env vars", async () => {
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
        },
        "/tmp/test",
      );

      expect(result.envVars.ANTHROPIC_VERSION).toBe("2025-01-01");
      expect(result.envVars.ANTHROPIC_BETA).toBe("prompt-caching,output-128k");
      expect(result.envVars.ANTHROPIC_THINKING_BUDGET_TOKENS).toBe("8192");
      expect(result.envVars.ANTHROPIC_MAX_TOKENS).toBe("16384");
    });

    it("returns empty config when no API key env", async () => {
      const adapter = createClaudeCodeAdapter();
      const result = await adapter.materializeConfig(
        {
          providerKind: "anthropic",
          providerId: "p",
          modelId: "m",
        },
        "/tmp/test",
      );

      expect(Object.keys(result.envVars)).toHaveLength(0);
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
    it("builds gh copilot suggest command", () => {
      const adapter = createCopilotCliAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        model: {
          providerKind: "copilot",
          providerId: "copilot",
          modelId: "gpt-4o",
        },
      });

      expect(cmd[0]).toBe("gh");
      expect(cmd).toContain("copilot");
      expect(cmd).toContain("suggest");
      expect(cmd).toContain("--cwd");
      expect(cmd).toContain("/workspace");
    });
  });

  describe("materializeConfig", () => {
    it("returns GH_TOKEN env var when apiKeyEnv is set", async () => {
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

      expect(result.envVars.GH_TOKEN).toBe("${GITHUB_TOKEN}");
    });
  });
});

describe("createOpencodeAdapter", () => {
  it("creates adapter with default binary", () => {
    const adapter = createOpencodeAdapter();
    expect(adapter.kind).toBe("opencode");
  });

  describe("buildCommand", () => {
    it("builds command with auto-approve and model", () => {
      const adapter = createOpencodeAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        timeoutMs: 300_000,
        model: {
          providerKind: "openai_compatible",
          providerId: "test-provider",
          modelId: "gpt-4o",
        },
      });

      expect(cmd[0]).toBe("opencode");
      expect(cmd).toContain("run");
      expect(cmd).toContain("--auto");
      expect(cmd).toContain("--model");
      expect(cmd).toContain("gpt-4o");
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
            extraParams: { temperature: 0.7 },
          },
          tempDir,
        );

        expect(result.configFiles.has(".opencode/config.json")).toBe(true);
        const configJson = result.configFiles.get(".opencode/config.json") ?? "{}";
        const parsed = JSON.parse(configJson);
        expect(parsed.provider).toHaveLength(1);
        expect(parsed.provider[0]?.name).toBe("openai-prod");
        expect(parsed.provider[0]?.baseURL).toBe("https://api.openai.com/v1");
        expect(parsed.provider[0]?.options?.temperature).toBe(0.7);
        expect(result.envVars.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

describe("createRooAdapter", () => {
  it("creates adapter with default binary", () => {
    const adapter = createRooAdapter();
    expect(adapter.kind).toBe("roo");
  });

  describe("buildCommand", () => {
    it("builds command with model and cwd", () => {
      const adapter = createRooAdapter();
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
      expect(cmd).toContain("run");
      expect(cmd).toContain("--model");
      expect(cmd).toContain("gpt-4o");
    });
  });

  describe("materializeConfig", () => {
    it("writes roo settings.json", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "aicr-roo-adapter-"));

      try {
        const adapter = createRooAdapter();
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
  });
});
