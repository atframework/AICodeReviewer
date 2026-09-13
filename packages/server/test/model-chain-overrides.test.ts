/**
 * Model chain entry override wiring tests (P4/H02): resolveModelSpecFromChain
 * merges entry-level request overrides over provider fields — maps by key,
 * arrays/scalars replace, provider identity fields are untouchable.
 */
import { describe, expect, it } from "vitest";

import type { AppConfig } from "@aicr/core";
import { resolveModelSpecFromConfig } from "../src/bootstrap.js";

interface ChainEntry {
  readonly provider: string;
  readonly model: string;
  readonly role?: string;
  readonly overrides?: Record<string, unknown>;
}

function makeConfig(chain: readonly ChainEntry[]): AppConfig {
  return {
    llm: {
      providers: [
        {
          id: "openai-prod",
          kind: "openai_compatible",
          base_url: "https://api.openai.com/v1",
          api_key_env: "OPENAI_API_KEY",
          extra_params: { shared_probe: "provider", keep_me: "provider-value" },
          extra_headers: { "X-Provider": "provider" },
          timeout_ms: 30_000,
        },
      ],
      model_chain: { default: chain as never },
    },
    workspaces: { cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 }, defaults: {}, instances: {} },
  } as unknown as AppConfig;
}

describe("resolveModelSpecFromConfig entry overrides (H02)", () => {
  it("merges logit_bias by token while preserving the provider map", () => {
    const config = makeConfig([{ provider: "openai-prod", model: "m", overrides: { logit_bias: { "1": 5 } } }]);
    config.llm.providers[0]!.logit_bias = { "1": 1, "2": -2 };
    expect(resolveModelSpecFromConfig(config).logitBias).toEqual({ "1": 5, "2": -2 });
    expect(config.llm.providers[0]!.logit_bias).toEqual({ "1": 1, "2": -2 });
  });
  it("returns the plain provider spec without overrides", () => {
    const spec = resolveModelSpecFromConfig(makeConfig([{ provider: "openai-prod", model: "gpt-4o" }]));
    expect(spec.providerId).toBe("openai-prod");
    expect(spec.modelId).toBe("gpt-4o");
    expect(spec.extraParams).toEqual({ shared_probe: "provider", keep_me: "provider-value" });
    expect(spec.timeoutMs).toBe(30_000);
  });

  it("merges extra_params by key over the provider map", () => {
    const spec = resolveModelSpecFromConfig(makeConfig([{
      provider: "openai-prod",
      model: "gpt-4o",
      overrides: { extra_params: { shared_probe: "entry" } },
    }]));
    expect(spec.extraParams).toEqual({ shared_probe: "entry", keep_me: "provider-value" });
  });

  it("replaces arrays wholesale (drop_params) and sets scalar request fields", () => {
    const spec = resolveModelSpecFromConfig(makeConfig([{
      provider: "openai-prod",
      model: "gpt-4o",
      overrides: {
        drop_params: ["temperature"],
        reasoning_effort: "high",
        thinking_level: "medium",
        thinking_budget_tokens: 2048,
        parallel_tool_calls: false,
        seed: 42,
        allowed_openai_params: ["reasoning_effort"],
      },
    }]));
    expect(spec.dropParams).toEqual(["temperature"]);
    expect(spec.reasoningEffort).toBe("high");
    expect(spec.thinkingLevel).toBe("medium");
    expect(spec.thinkingBudgetTokens).toBe(2048);
    expect(spec.parallelToolCalls).toBe(false);
    expect(spec.seed).toBe(42);
    expect(spec.allowedOpenaiParams).toEqual(["reasoning_effort"]);
  });

  it("merges extra_headers and extra_body maps by key", () => {
    const spec = resolveModelSpecFromConfig(makeConfig([{
      provider: "openai-prod",
      model: "gpt-4o",
      overrides: {
        extra_headers: { "X-Entry": "entry" },
        extra_body: { custom_field: 1 },
      },
    }]));
    expect(spec.extraHeaders).toEqual({ "X-Provider": "provider", "X-Entry": "entry" });
    expect(spec.extraBody).toEqual({ custom_field: 1 });
  });

  it("maps tool_choice string and function-name record forms", () => {
    const stringSpec = resolveModelSpecFromConfig(makeConfig([{
      provider: "openai-prod",
      model: "gpt-4o",
      overrides: { tool_choice: "required" },
    }]));
    expect(stringSpec.toolChoice).toBe("required");

    const namedSpec = resolveModelSpecFromConfig(makeConfig([{
      provider: "openai-prod",
      model: "gpt-4o",
      overrides: { tool_choice: { function: { name: "report_issue" } } },
    }]));
    expect(namedSpec.toolChoice).toEqual({ name: "report_issue" });
  });

  it("never lets overrides change provider identity, model, or credentials", () => {
    const spec = resolveModelSpecFromConfig(makeConfig([{
      provider: "openai-prod",
      model: "gpt-4o",
      overrides: {
        // These keys are not part of the request-override schema, but even
        // hand-built chains cannot retarget identity through the merge.
        provider: "other-provider",
        model: "other-model",
        api_key_env: "OTHER_KEY",
        base_url: "https://evil.example.com",
      } as Record<string, unknown>,
    }]));
    expect(spec.providerId).toBe("openai-prod");
    expect(spec.modelId).toBe("gpt-4o");
    expect(spec.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(spec.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("provider selection takes the first matching entry; later entries resolve standalone (agent fallback)", () => {
    // providerId picks the FIRST chain entry that matches (documented
    // first-match semantics), so the override on the first entry applies.
    const spec = resolveModelSpecFromConfig(makeConfig([
      { provider: "openai-prod", model: "gpt-4o", overrides: { reasoning_effort: "medium" } },
      { provider: "openai-prod", model: "gpt-4o-mini", overrides: { reasoning_effort: "low" } },
    ]), "openai-prod");
    expect(spec.modelId).toBe("gpt-4o");
    expect(spec.reasoningEffort).toBe("medium");

    // The agent fallback chain resolves each entry standalone (bootstrap
    // maps [entry] through the same resolver), where its own overrides win.
    const miniSpec = resolveModelSpecFromConfig(makeConfig([
      { provider: "openai-prod", model: "gpt-4o-mini", overrides: { reasoning_effort: "low" } },
    ]));
    expect(miniSpec.modelId).toBe("gpt-4o-mini");
    expect(miniSpec.reasoningEffort).toBe("low");
  });
});
