/**
 * Literal credential support in the agent materialization layer: a config
 * literal (`api_key`, `{ value }` search credential) is injected directly
 * into the per-run spawn environment/bundle instead of a `${VAR}` reference.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ModelSpec } from "@aicr/llm";

import { createKiloAdapter } from "../src/kilo.js";
import { createPiAdapter } from "../src/pi.js";
import { buildOmpWebSearchEnvVars } from "../src/oh-my-pi.js";
import { PI_FAMILY_LITERAL_API_KEY_ENV } from "../src/pi-family.js";
import { createAnthropicTranslator, createBedrockTranslator } from "../src/model-translator.js";
import { buildWebSearchCredentialEnvVars } from "../src/web-search.js";

describe("literal provider keys", () => {
  it("injects a literal key for the anthropic translator instead of an env reference", () => {
    const translated = createAnthropicTranslator("anthropic-main").translate({
      providerKind: "anthropic",
      providerId: "anthropic-main",
      modelId: "claude-sonnet-4-5",
      apiKey: "sk-ant-literal",
      contextWindow: 200000,
      maxOutputTokens: 64000,
    });
    expect(translated.envVars.ANTHROPIC_API_KEY).toBe("sk-ant-literal");
  });

  it("injects bedrock literals for the bedrock translator", () => {
    const translated = createBedrockTranslator("bedrock-main").translate({
      providerKind: "bedrock",
      providerId: "bedrock-main",
      modelId: "anthropic.claude-3-5-sonnet",
      awsAccessKey: "AKIA_LITERAL",
      awsSecretKey: "aws-secret-literal",
      contextWindow: 200000,
      maxOutputTokens: 8192,
    });
    expect(translated.envVars.AWS_ACCESS_KEY_ID).toBe("AKIA_LITERAL");
    expect(translated.envVars.AWS_SECRET_ACCESS_KEY).toBe("aws-secret-literal");
  });

  it("writes a literal key into the kilo bundle and the per-provider env var", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-kilo-literal-"));
    try {
      const adapter = createKiloAdapter();
      const model: ModelSpec = {
        providerKind: "openai_compatible",
        providerId: "custom-gateway",
        modelId: "gpt-4o",
        baseUrl: "https://llm.example/v1",
        apiKey: "sk-literal",
        contextWindow: 128000,
        maxOutputTokens: 8192,
      };
      const result = await adapter.materializeConfig(model, tempDir);
      const kiloJson = JSON.parse(result.configFiles.get(".kilo/kilo.json") ?? "{}");
      expect(kiloJson.provider?.["custom-gateway"]?.options?.apiKey).toBe("sk-literal");
      expect(result.envVars.KILO_API_KEY).toBe("sk-literal");
      expect(result.envVars.KILO_API_KEY_CUSTOM_GATEWAY).toBe("sk-literal");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("references the synthetic env var for a literal key in the pi-family bundle", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-pi-literal-"));
    try {
      const adapter = createPiAdapter();
      const model: ModelSpec = {
        providerKind: "anthropic",
        providerId: "anthropic-main",
        modelId: "claude-sonnet-4-5",
        apiKey: "sk-ant-literal",
        contextWindow: 200000,
        maxOutputTokens: 64000,
      };
      const result = await adapter.materializeConfig(model, tempDir);
      const modelsJson = JSON.parse(result.configFiles.get(".pi-agent/models.json") ?? "{}");
      // pi resolves `$ENV` references, so the materialized config points at
      // the synthetic env var that carries the literal in the spawn env.
      expect(modelsJson.providers["anthropic-main"].apiKey).toBe(`$${PI_FAMILY_LITERAL_API_KEY_ENV}`);
      expect(result.envVars[PI_FAMILY_LITERAL_API_KEY_ENV]).toBe("sk-ant-literal");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("literal web_search credentials", () => {
  it("injects { value } literals directly and keeps env names as references", () => {
    const envVars = buildWebSearchCredentialEnvVars(
      { enabled: true, credentials: { exa: { value: "exa-literal" }, tavily: "AICR_SEARCH_TAVILY_KEY" } },
      { exa: "EXA_API_KEY", tavily: "TAVILY_API_KEY" },
    );
    expect(envVars.EXA_API_KEY).toBe("exa-literal");
    expect(envVars.TAVILY_API_KEY).toBe("${AICR_SEARCH_TAVILY_KEY}");
  });

  it("injects { value } literals for omp-native env names", () => {
    const envVars = buildOmpWebSearchEnvVars({ enabled: true, credentials: { exa: { value: "exa-literal" } } });
    expect(envVars.EXA_API_KEY).toBe("exa-literal");
  });

  it("still rejects unsupported credential providers", () => {
    expect(() => buildOmpWebSearchEnvVars({ enabled: true, credentials: { google: { value: "x" } } })).toThrow(RangeError);
  });
});
