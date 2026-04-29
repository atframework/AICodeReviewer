import { describe, expect, it } from "vitest";

import {
  agentPackageName,
  createKiloAdapter,
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

  it("throws for unimplemented agent kinds", () => {
    expect(() => createAgentAdapter({ kind: "opencode" })).toThrow("not yet implemented");
    expect(() => createAgentAdapter({ kind: "roo" })).toThrow("not yet implemented");
    expect(() => createAgentAdapter({ kind: "copilot-cli" })).toThrow("not yet implemented");
    expect(() => createAgentAdapter({ kind: "claude-code" })).toThrow("not yet implemented");
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
      const adapter = createKiloAdapter();
      const result = await adapter.detect();
      expect(typeof result.available).toBe("boolean");
      expect(result.binary).toBe("kilo");
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
