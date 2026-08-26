import type { ModelProviderKind, ModelSpec } from "@aicr/llm";

/**
 * Shared model/provider translation for the pi family of CLIs: pi
 * (`@earendil-works/pi-coding-agent`) and oh-my-pi (`omp`, a pi fork). Both read a
 * custom provider catalog from `<configDir>/models.json|models.yml` with the same
 * `{ providers: { <id>: { baseUrl, api, apiKey, models: [...] } } }` shape, verified
 * against pi docs/custom-provider.md and omp docs/models.md (2026-08).
 */

export const PI_FAMILY_AGENT_KINDS = ["pi", "oh-my-pi"] as const;
export type PiFamilyAgentKind = (typeof PI_FAMILY_AGENT_KINDS)[number];

/**
 * Provider kinds whose credential/parameter pipeline is verified for pi/omp custom
 * providers (baseUrl + apiKey only). azure_openai/vertex_ai/bedrock/copilot need
 * provider-specific auth plumbing (api-version, ADC, SigV4, Copilot tokens) that the
 * upstream docs do not cover for custom-provider entries; fail visibly instead of
 * guessing.
 */
const PI_FAMILY_API_BY_KIND: Partial<Record<ModelProviderKind, string>> = {
  openai_compatible: "openai-completions",
  ollama: "openai-completions",
  anthropic: "anthropic-messages",
  google_ai_studio: "google-generative-ai",
};

export function resolvePiFamilyApi(providerKind: ModelProviderKind): string | undefined {
  return PI_FAMILY_API_BY_KIND[providerKind];
}

export function assertPiFamilyModelSupported(model: ModelSpec, agentKind: PiFamilyAgentKind): void {
  const api = resolvePiFamilyApi(model.providerKind);
  if (!api) {
    throw new RangeError(
      `Agent ${agentKind} does not support llm provider kind "${model.providerKind}" ` +
        `(supported: ${Object.keys(PI_FAMILY_API_BY_KIND).join(", ")}). ` +
        `Use the kilo/opencode/claude-code adapter or route the provider through an OpenAI-compatible gateway.`,
    );
  }
}

export function resolvePiFamilyBaseUrl(model: ModelSpec): string | undefined {
  if (model.baseUrl) {
    return model.baseUrl;
  }
  switch (model.providerKind) {
    case "openai_compatible":
      return "https://api.openai.com/v1";
    case "ollama":
      return "http://127.0.0.1:11434/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    case "google_ai_studio":
      return "https://generativelanguage.googleapis.com/v1beta";
    default:
      return undefined;
  }
}

/**
 * pi/omp both accept thinking levels off|minimal|low|medium|high|xhigh|max; the AICR
 * ReasoningEffort set is a strict subset, so values pass through unchanged.
 */
export function resolvePiFamilyThinking(model: ModelSpec): string | undefined {
  return model.reasoningEffort ?? model.defaultReasoningEffort;
}

function buildPiFamilyInputModalities(model: ModelSpec): string[] {
  const fromCatalog = model.inputModalities?.filter((m) => m === "text" || m === "image");
  if (fromCatalog && fromCatalog.length > 0) {
    return [...fromCatalog];
  }
  return model.supportsVision ? ["text", "image"] : ["text"];
}

/**
 * Builds the custom model entry shared by pi models.json and omp models.yml.
 * `contextWindow`/`maxTokens` are load-bearing for both CLIs (context management and
 * request shaping); when the catalog cannot supply them we fail with actionable
 * guidance instead of fabricating limits.
 */
export function buildPiFamilyModelEntry(model: ModelSpec, agentKind: PiFamilyAgentKind): Record<string, unknown> {
  if (model.contextWindow === undefined || model.maxOutputTokens === undefined) {
    throw new TypeError(
      `Agent ${agentKind} requires model contextWindow and maxOutputTokens for ${model.providerId}/${model.modelId}. ` +
        `Enable llm.model_catalog (or set context_window / max_output_tokens in llm.model_catalog.overrides) ` +
        `so the adapter can materialize verified limits.`,
    );
  }
  return {
    id: model.modelId,
    name: model.displayName ?? model.modelId,
    reasoning: model.supportsReasoning ?? false,
    input: buildPiFamilyInputModalities(model),
    // Cost fields are display-only for the CLI (AICR computes cost from its own
    // catalog); 0 is the honest "unknown" placeholder.
    cost: {
      input: model.costInputPerMTok ?? 0,
      output: model.costOutputPerMTok ?? 0,
      cacheRead: model.costCacheReadPerMTok ?? 0,
      cacheWrite: model.costCacheWritePerMTok ?? 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutputTokens,
  };
}

export interface PiFamilyProviderConfig {
  readonly baseUrl: string;
  readonly api: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly modelEntry: Record<string, unknown>;
}

/**
 * Resolves the shared provider config. `apiKey` never carries a secret literal: pi
 * resolves `$ENV`/`${ENV}` references, omp resolves env-var names first. Keyless
 * providers (ollama without api_key_env) use omp's documented `auth: none`; pi has
 * no keyless marker and gets a harmless literal placeholder instead.
 */
export function buildPiFamilyProviderConfig(model: ModelSpec, agentKind: PiFamilyAgentKind): PiFamilyProviderConfig {
  assertPiFamilyModelSupported(model, agentKind);
  const baseUrl = resolvePiFamilyBaseUrl(model);
  if (!baseUrl) {
    throw new TypeError(
      `Agent ${agentKind} requires a base URL for provider ${model.providerId}; set llm.providers[].base_url.`,
    );
  }
  return {
    baseUrl,
    api: resolvePiFamilyApi(model.providerKind)!,
    ...(model.apiKeyEnv ? { apiKey: model.apiKeyEnv } : {}),
    ...(model.extraHeaders ? { headers: model.extraHeaders } : {}),
    modelEntry: buildPiFamilyModelEntry(model, agentKind),
  };
}

/** Provider key env passthrough so the sandbox inherits the host secret by name. */
export function buildPiFamilyEnvVars(model: ModelSpec): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (model.apiKeyEnv) {
    envVars[model.apiKeyEnv] = `\${${model.apiKeyEnv}}`;
  }
  return envVars;
}

export function formatPiFamilyModel(model: ModelSpec): string {
  return `${model.providerId}/${model.modelId}`;
}
