import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MODEL_PROVIDER_PRESETS, getModelCatalogBundledSnapshotPath,
  parseModelsDevApiJson, mapCatalogEntryToModelSpecFields, type ModelSpec,
} from "@aicr/llm";
import { createAgentAdapter, materializeRuntimeBundle } from "../src/index.js";

const catalog = parseModelsDevApiJson(JSON.parse(await readFile(getModelCatalogBundledSnapshotPath(), "utf8")));
let root: string;
beforeAll(async () => {
  const parent = resolve("build/tmp");
  await mkdir(parent, { recursive: true });
  root = await mkdtemp(join(parent, "provider-bundles-"));
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe.each(MODEL_PROVIDER_PRESETS)("$id runtime configuration", preset => {
  const modelId = preset.suggestedModels[0]!;
  const entry = catalog.get(`${preset.catalogProvider}/${modelId}`)!;
  const model: ModelSpec = {
    ...mapCatalogEntryToModelSpecFields(entry, "bundled"),
    providerId: `custom-${preset.id}`, providerKind: preset.kind, modelId,
    baseUrl: preset.baseUrl, apiKeyEnv: preset.apiKeyEnv,
    extraHeaders: { "X-Review-Tenant": "fixture" },
  };
  it.each(["kilo", "opencode"] as const)("%s chooses the configured protocol despite catalog npm and preserves native model limits", async kind => {
    const adapter = createAgentAdapter({ kind });
    const workingDir = join(root, preset.id, kind);
    const result = await materializeRuntimeBundle({ adapter, model, workingDir });
    const configPath = kind === "kilo" ? ".kilo/kilo.json" : "opencode.json";
    const config = JSON.parse(await readFile(join(workingDir, configPath), "utf8"));
    const provider = config.provider[model.providerId];
    expect(provider.npm).toBe(preset.kind === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible");
    expect(provider.options).toMatchObject({
      baseURL: `${preset.baseUrl}${preset.kind === "anthropic" ? "/v1" : ""}`,
      apiKey: `{env:${preset.apiKeyEnv}}`, headers: { "X-Review-Tenant": "fixture" },
    });
    expect(provider.models[modelId].limit).toMatchObject({ context: model.contextWindow, output: model.maxOutputTokens });
    expect(result.envVars[preset.apiKeyEnv]).toBe(`\${${preset.apiKeyEnv}}`);
    expect(result.manifest.model.metadataInjection).toBe("injected");
    expect(result.manifest.envKeys).toContain(preset.apiKeyEnv);
    expect(adapter.buildCommand("review", { workingDir, model }).join(" ")).toContain(`${model.providerId}/${modelId}`);
  });

  it.each(["pi", "oh-my-pi"] as const)("%s keeps the Anthropic SDK root and the correct wire protocol", async kind => {
    const result = await materializeRuntimeBundle({ adapter: createAgentAdapter({ kind }), model, workingDir: join(root, preset.id, kind) });
    const text = [...result.configFiles].find(([path]) => /models\.(json|yml)$/u.test(path))?.[1];
    expect(text).toBeDefined();
    const api = preset.kind === "anthropic" ? "anthropic-messages" : "openai-completions";
    if (kind === "pi") {
      expect(JSON.parse(text!).providers[model.providerId]).toMatchObject({ api, baseUrl: preset.baseUrl, apiKey: `$${preset.apiKeyEnv}` });
    } else {
      expect(text).toContain(`baseUrl: ${JSON.stringify(preset.baseUrl)}`);
      expect(text).toContain(`api: ${JSON.stringify(api)}`);
      expect(text).toContain(`apiKey: ${JSON.stringify(preset.apiKeyEnv)}`);
    }
    expect(result.manifest.envKeys).toContain(preset.apiKeyEnv);
  });

  if (preset.kind === "anthropic") {
    it("Claude Code keeps the root URL and forwards the selected key and model", async () => {
      const adapter = createAgentAdapter({ kind: "claude-code" });
      const workingDir = join(root, preset.id, "claude");
      const result = await materializeRuntimeBundle({ adapter, model, workingDir });
      expect(result.envVars).toMatchObject({ ANTHROPIC_BASE_URL: preset.baseUrl, ANTHROPIC_API_KEY: `\${${preset.apiKeyEnv}}` });
      expect(adapter.buildCommand("review", { workingDir, model })).toContain(modelId);
    });
  }
});

it("Zoo rejects Anthropic instead of sending its credentials to an OpenAI transport", async () => {
  await expect(createAgentAdapter({ kind: "zoo" }).materializeConfig({
    providerKind: "anthropic", providerId: "compatible", modelId: "glm-5.3",
  }, join(root, "unsupported"))).rejects.toThrow("does not support Anthropic-compatible");
});
