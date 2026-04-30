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
    it("builds command with auto-approve flag", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review this", {
        workingDir: "/workspace",
        timeoutMs: 300_000,
      });

      expect(cmd[0]).toBe("kilo");
      expect(cmd).toContain("run");
      expect(cmd).toContain("--auto");
      expect(cmd).toContain("/workspace");
    });

    it("includes model flags when model is provided", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review", {
        workingDir: "/ws",
        model: {
          providerKind: "openai_compatible",
          providerId: "test-provider",
          modelId: "gpt-4o",
        },
      });

      expect(cmd).toContain("--provider");
      expect(cmd).toContain("test-provider");
      expect(cmd).toContain("--model");
      expect(cmd).toContain("gpt-4o");
    });

    it("calculates timeout in seconds", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review", {
        workingDir: "/ws",
        timeoutMs: 300_000,
      });

      const timeoutIdx = cmd.indexOf("--timeout");
      expect(timeoutIdx).toBeGreaterThan(-1);
      expect(cmd[timeoutIdx + 1]).toBe("300");
    });

    it("uses default timeout of 600s when not specified", () => {
      const adapter = createKiloAdapter();
      const cmd = adapter.buildCommand("review", {
        workingDir: "/ws",
      });

      const timeoutIdx = cmd.indexOf("--timeout");
      expect(timeoutIdx).toBeGreaterThan(-1);
      expect(cmd[timeoutIdx + 1]).toBe("600");
    });
  });

  describe("materializeConfig", () => {
    it("returns config files map with providers.json", async () => {
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

      expect(result.configFiles.has(".kilo/providers.json")).toBe(true);
      const configJson = result.configFiles.get(".kilo/providers.json");
      expect(configJson).toBeDefined();

      const parsed = JSON.parse(configJson ?? "{}");
      expect(parsed.providers).toHaveLength(1);
      expect(parsed.providers[0]?.id).toBe("my-provider");
      expect(parsed.providers[0]?.baseUrl).toBe("https://api.openai.com/v1");
    });

    it("includes organization in provider config", async () => {
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

      const configJson = result.configFiles.get(".kilo/providers.json") ?? "{}";
      const parsed = JSON.parse(configJson);
      expect(parsed.providers[0]?.organization).toBe("org-123");
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

    it("writes providers.json to the working directory", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "aicr-kilo-adapter-"));

      try {
        const adapter = createKiloAdapter();
        await adapter.materializeConfig(
          {
            providerKind: "openai_compatible",
            providerId: "openai-prod",
            modelId: "gpt-4o",
            apiVersion: "2025-01-01-preview",
            thinkingLevel: "high",
            responseFormat: { kind: "json_object" },
          },
          tempDir,
        );

        const configJson = await readFile(join(tempDir, ".kilo", "providers.json"), "utf8");
        const parsed = JSON.parse(configJson);
        expect(parsed.providers[0]?.id).toBe("openai-prod");
        expect(parsed.providers[0]?.apiVersion).toBe("2025-01-01-preview");
        expect(parsed.providers[0]?.thinkingLevel).toBe("high");
        expect(parsed.providers[0]?.responseFormat).toEqual({ kind: "json_object" });
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
