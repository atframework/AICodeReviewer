import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@aicr/core";
import { closeStoreDb, createStoreDb, getProjectStats, insertReviewRun } from "@aicr/store";

import {
  resolveModelSpecFromConfig,
  resolveGiteaWebhookConfig,
  resolveGenericWebhookConfigs,
  resolveP4TriggerConfig,
  createOutputPublisherFromConfig,
  createOutputPublisherResolverFromConfig,
  createVcsAdapterFromConfig,
  bootstrapServerApp,
  buildSourceRootResolver,
  normalizeModelCatalogOverrides,
} from "../src/bootstrap.js";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    llm: {
      providers: [
        {
          id: "openai-prod",
          kind: "openai_compatible",
          base_url: "https://api.openai.com/v1",
          api_key_env: "OPENAI_API_KEY",
        },
      ],
      fallback_chain: [
        { provider: "openai-prod", model: "gpt-4o", role: "heavy" },
      ],
      model_catalog: {
        enabled: false,
        source_url: "https://models.dev/api.json",
        refresh_interval_hours: 24,
        fetch_timeout_ms: 10000,
        offline: false,
        apply_to_model_spec: true,
        cache: { backend: "sqlite" },
        overrides: {},
      },
    },
    triggers: [
      {
        name: "gitea-internal",
        kind: "gitea",
        base_url: "https://gitea.example.com",
        token_env: "GITEA_TOKEN",
        webhook_secret_env: "GITEA_SECRET",
      },
    ],
    outputs: {
      template_engine: "handlebars",
      channels: [
        {
          name: "gitea-pr",
          kind: "gitea_pr_review",
          trigger: "gitea-internal",
          base_url: "https://gitea.example.com",
          token_env: "GITEA_TOKEN",
          owner: "owent",
          repo: "example",
        },
      ],
    },
    queue: { kind: "memory" },
    agent: {
      default: "kilo",
      timeout_seconds: 600,
      auto_approve: true,
      sandbox: { kind: "native" },
    },
    review: {
      incremental: true,
      skip_lgtm: true,
      languages_auto_detect: true,
      include: ["**/*"],
      exclude: [],
      max_files: 50,
      max_patch_bytes: 200_000,
      output_language: "en",
      commit_strategy: "aggregate",
    },
    workspaces: {
      cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
      defaults: {},
      instances: {
        "test-workspace": {
          source_repo: { trigger: "gitea-internal", repo: "owent/example" },
        },
      },
    },
    server: {
      port: 8080,
      hostname: "0.0.0.0",
      trust_proxy: false,
    },
    ...overrides,
  } as AppConfig;
}

type OutputPublisher = NonNullable<ReturnType<typeof createOutputPublisherFromConfig>>;
type ProblemPublisher = OutputPublisher & { readonly publishProblem: NonNullable<OutputPublisher["publishProblem"]> };
type SummaryPublisher = OutputPublisher & { readonly publishSummary: NonNullable<OutputPublisher["publishSummary"]> };

function assertProblemPublisher(publisher: OutputPublisher | undefined): asserts publisher is ProblemPublisher {
  expect(typeof publisher?.publishProblem).toBe("function");
}

function assertSummaryPublisher(publisher: OutputPublisher | undefined): asserts publisher is SummaryPublisher {
  expect(typeof publisher?.publishSummary).toBe("function");
}

describe("normalizeModelCatalogOverrides", () => {
  it("maps snake_case config keys to camelCase service keys including MTok pricing", () => {
    const normalized = normalizeModelCatalogOverrides({
      "openai/gpt-4o": {
        context_window: 128000,
        max_output_tokens: 16384,
        catalog_id: "openai/gpt-4o",
        supports_tool_call: true,
        supports_vision: true,
        supports_logprobs: true,
        supports_computer_use: false,
        supported_reasoning_efforts: ["low", "high"],
        default_reasoning_effort: "low",
        thinking_modes: ["effort"],
        native_tool_capabilities: ["web_search"],
        supported_request_parameters: ["temperature"],
        unsupported_request_parameters: ["presence_penalty"],
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        cost_input_per_mtok: 2.5,
        cost_output_per_mtok: 10,
        cost_input_audio_per_mtok: 30,
        cost_output_audio_per_mtok: 60,
        cost_cache_read_per_mtok: 1.25,
        cost_cache_write_per_mtok: 2.5,
        cost_reasoning_per_mtok: 0.5,
        display_name: "GPT-4o",
        family: "gpt",
        model_status: "preview",
        model_links: { docs: "https://example.com/model" },
        provider_env_vars: ["OPENAI_API_KEY"],
        provider_api_base_url: "https://api.openai.com/v1",
        provider_docs_url: "https://platform.openai.com/docs",
        provider_model_aliases: ["gpt4o"],
        provider_model_ids: ["gpt-4o"],
        priority_tier_supported: true,
        concurrency_limit: 4,
        throughput_hint_tokens_per_second: 100,
      },
    });

    const fields = normalized["openai/gpt-4o"]!;
    expect(fields.contextWindow).toBe(128000);
    expect(fields.maxOutputTokens).toBe(16384);
    expect(fields.catalogId).toBe("openai/gpt-4o");
    expect(fields.supportsToolCall).toBe(true);
    expect(fields.supportsVision).toBe(true);
    expect(fields.supportsLogprobs).toBe(true);
    expect(fields.supportedReasoningEfforts).toEqual(["low", "high"]);
    expect(fields.nativeToolCapabilities).toEqual(["web_search"]);
    expect(fields.supportedRequestParameters).toEqual(["temperature"]);
    expect(fields.costInputPerMTok).toBe(2.5);
    expect(fields.costOutputPerMTok).toBe(10);
    expect(fields.costInputAudioPerMTok).toBe(30);
    expect(fields.costCacheReadPerMTok).toBe(1.25);
    expect(fields.costCacheWritePerMTok).toBe(2.5);
    expect(fields.costReasoningPerMTok).toBe(0.5);
    expect(fields.displayName).toBe("GPT-4o");
    expect(fields.family).toBe("gpt");
    expect(fields.modelLinks).toEqual({ docs: "https://example.com/model" });
    expect(fields.providerEnvVars).toEqual(["OPENAI_API_KEY"]);
    expect(fields.concurrencyLimit).toBe(4);
  });

  it("preserves already-camelCase keys", () => {
    const normalized = normalizeModelCatalogOverrides({
      "anthropic/claude": { contextWindow: 200000, costInputPerMTok: 3 },
    });
    expect(normalized["anthropic/claude"]!.contextWindow).toBe(200000);
    expect(normalized["anthropic/claude"]!.costInputPerMTok).toBe(3);
  });

  it("returns an empty record for no overrides", () => {
    expect(normalizeModelCatalogOverrides({})).toEqual({});
  });
});

describe("resolveModelSpecFromConfig", () => {
  it("returns a ModelSpec from the first provider and matching fallback", () => {
    const config = makeConfig();
    const model = resolveModelSpecFromConfig(config);

    expect(model.providerKind).toBe("openai_compatible");
    expect(model.providerId).toBe("openai-prod");
    expect(model.modelId).toBe("gpt-4o");
    expect(model.baseUrl).toBe("https://api.openai.com/v1");
    expect(model.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  it("uses the first fallback_chain entry as the default model route", () => {
    const config = makeConfig({
      llm: {
        providers: [
          { id: "ollama-local", kind: "ollama", base_url: "http://localhost:11434/v1" },
          { id: "openai-prod", kind: "openai_compatible", base_url: "https://api.openai.com/v1" },
        ],
        fallback_chain: [{ provider: "openai-prod", model: "gpt-4o", role: "heavy" }],
      },
    } as Partial<AppConfig>);

    const model = resolveModelSpecFromConfig(config);

    expect(model.providerId).toBe("openai-prod");
    expect(model.modelId).toBe("gpt-4o");
    expect(model.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("throws when the first fallback_chain provider is not configured", () => {
    const config = makeConfig({
      llm: {
        providers: [{ id: "openai-prod", kind: "openai_compatible" }],
        fallback_chain: [{ provider: "missing-provider", model: "gpt-4o", role: "heavy" }],
      },
    } as Partial<AppConfig>);

    expect(() => resolveModelSpecFromConfig(config)).toThrow('LLM provider "missing-provider" not found');
  });

  it("falls back to gpt-4o-mini when no fallback entry matches", () => {
    const config = makeConfig({
      llm: {
        providers: [{ id: "p1", kind: "ollama" }],
        fallback_chain: [],
      },
    } as Partial<AppConfig>);
    const model = resolveModelSpecFromConfig(config);

    expect(model.modelId).toBe("gpt-4o-mini");
  });

  it("throws when no providers are configured", () => {
    const config = makeConfig({
      llm: { providers: [], fallback_chain: [] },
    } as Partial<AppConfig>);

    expect(() => resolveModelSpecFromConfig(config)).toThrow("No LLM providers configured");
  });

  it("throws when the requested provider is not found", () => {
    const config = makeConfig();

    expect(() => resolveModelSpecFromConfig(config, "missing")).toThrow("not found");
  });

  it("selects a specific provider by id", () => {
    const config = makeConfig({
      llm: {
        providers: [
          { id: "p1", kind: "openai_compatible" },
          { id: "p2", kind: "ollama", base_url: "http://localhost:11434/v1" },
        ],
        fallback_chain: [{ provider: "p2", model: "llama3", role: "any" }],
      },
    } as Partial<AppConfig>);
    const model = resolveModelSpecFromConfig(config, "p2");

    expect(model.providerId).toBe("p2");
    expect(model.modelId).toBe("llama3");
  });

  it("maps Plan ModelSpec provider fields from config", () => {
    const config = makeConfig({
      llm: {
        providers: [
          {
            id: "azure-prod",
            kind: "azure_openai",
            base_url: "https://azure.example.com/openai",
            api_key_env: "AZURE_KEY",
            api_version: "2025-01-01-preview",
            organization: "org-1",
            extra_headers: { "x-test": "yes" },
            extra_body: { safety: true },
            extra_params: { temperature: 0.2 },
            thinking_level: "high",
            reasoning_effort: "medium",
            response_format: { kind: "json_object" },
            tool_choice: "auto",
            parallel_tool_calls: false,
            context_window: 128000,
            max_output_tokens: 8192,
            cost_input_per_mtok: 1.5,
            cost_output_per_mtok: 6,
            supports_vision: true,
            supports_structured_output: true,
            supports_logprobs: true,
            supported_reasoning_efforts: ["low", "medium"],
            default_reasoning_effort: "medium",
            native_tool_capabilities: ["web_search"],
            supported_request_parameters: ["temperature"],
            unsupported_request_parameters: ["presence_penalty"],
            display_name: "Azure deployment A",
            model_links: { docs: "https://example.com/model" },
          },
        ],
        fallback_chain: [{ provider: "azure-prod", model: "deployment-a", role: "heavy" }],
      },
    } as Partial<AppConfig>);

    const model = resolveModelSpecFromConfig(config);

    expect(model.providerKind).toBe("azure_openai");
    expect(model.modelId).toBe("deployment-a");
    expect(model.baseUrl).toBe("https://azure.example.com/openai");
    expect(model.apiKeyEnv).toBe("AZURE_KEY");
    expect(model.apiVersion).toBe("2025-01-01-preview");
    expect(model.organization).toBe("org-1");
    expect(model.extraHeaders).toEqual({ "x-test": "yes" });
    expect(model.extraBody).toEqual({ safety: true });
    expect(model.extraParams).toEqual({ temperature: 0.2 });
    expect(model.thinkingLevel).toBe("high");
    expect(model.reasoningEffort).toBe("medium");
    expect(model.responseFormat).toEqual({ kind: "json_object" });
    expect(model.toolChoice).toBe("auto");
    expect(model.parallelToolCalls).toBe(false);
    expect(model.contextWindow).toBe(128000);
    expect(model.maxOutputTokens).toBe(8192);
    expect(model.costInputPerMTok).toBe(1.5);
    expect(model.costOutputPerMTok).toBe(6);
    expect(model.supportsVision).toBe(true);
    expect(model.supportsStructuredOutput).toBe(true);
    expect(model.supportsLogprobs).toBe(true);
    expect(model.supportedReasoningEfforts).toEqual(["low", "medium"]);
    expect(model.defaultReasoningEffort).toBe("medium");
    expect(model.nativeToolCapabilities).toEqual(["web_search"]);
    expect(model.supportedRequestParameters).toEqual(["temperature"]);
    expect(model.unsupportedRequestParameters).toEqual(["presence_penalty"]);
    expect(model.displayName).toBe("Azure deployment A");
    expect(model.modelLinks).toEqual({ docs: "https://example.com/model" });
  });
});

describe("resolveGiteaWebhookConfig", () => {
  it("returns config for the first gitea trigger", () => {
    const originalSecret = process.env.GITEA_SECRET;
    process.env.GITEA_SECRET = "test-secret";
    try {
      const config = makeConfig();
      const result = resolveGiteaWebhookConfig(config);

      expect(result).toBeDefined();
      expect(result?.triggerName).toBe("gitea-internal");
      expect(result?.webhookSecret).toBe("test-secret");
    } finally {
      if (originalSecret === undefined) {
        delete process.env.GITEA_SECRET;
      } else {
        process.env.GITEA_SECRET = originalSecret;
      }
    }
  });

  it("returns undefined when no gitea trigger exists", () => {
    const config = makeConfig({ triggers: [] });
    const result = resolveGiteaWebhookConfig(config);

    expect(result).toBeUndefined();
  });

  it("resolves workspaceId from matching workspace instance", () => {
    const config = makeConfig();
    const result = resolveGiteaWebhookConfig(config);

    expect(result?.workspaceId).toBe("test-workspace");
  });

  it("finds a specific trigger by name", () => {
    const config = makeConfig({
      triggers: [
        { name: "t1", kind: "github" },
        { name: "t2", kind: "gitea" },
      ],
    } as Partial<AppConfig>);
    const result = resolveGiteaWebhookConfig(config, "t2");

    expect(result?.triggerName).toBe("t2");
  });
});

describe("resolveGenericWebhookConfigs", () => {
  it("returns all matching GitHub webhook configs with repo identities", () => {
    const originalAtframeworkSecret = process.env.GITHUB_ATFRAMEWORK_SECRET;
    const originalOwentSecret = process.env.GITHUB_OWENT_SECRET;
    process.env.GITHUB_ATFRAMEWORK_SECRET = "atframework-secret";
    process.env.GITHUB_OWENT_SECRET = "owent-secret";

    try {
      const config = makeConfig({
        triggers: [
          {
            name: "github-atframework",
            kind: "github",
            webhook_secret_env: "GITHUB_ATFRAMEWORK_SECRET",
          },
          {
            name: "github-owent",
            kind: "github",
            webhook_secret_env: "GITHUB_OWENT_SECRET",
          },
        ],
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "github-atsf4g-co": {
              source_repo: { trigger: "github-atframework", repo: "atframework/atsf4g-co" },
            },
            "github-libatapp": {
              source_repo: { trigger: "github-owent", repo: "owent/libatapp" },
            },
          },
        },
      } as Partial<AppConfig>);

      const result = resolveGenericWebhookConfigs(config, "github");

      expect(result).toMatchObject([
        {
          triggerName: "github-atframework",
          workspaceId: "github-atsf4g-co",
          repoRef: "atframework/atsf4g-co",
          webhookSecret: "atframework-secret",
        },
        {
          triggerName: "github-owent",
          workspaceId: "github-libatapp",
          repoRef: "owent/libatapp",
          webhookSecret: "owent-secret",
        },
      ]);
    } finally {
      if (originalAtframeworkSecret === undefined) {
        delete process.env.GITHUB_ATFRAMEWORK_SECRET;
      } else {
        process.env.GITHUB_ATFRAMEWORK_SECRET = originalAtframeworkSecret;
      }
      if (originalOwentSecret === undefined) {
        delete process.env.GITHUB_OWENT_SECRET;
      } else {
        process.env.GITHUB_OWENT_SECRET = originalOwentSecret;
      }
    }
  });
});

describe("createOutputPublisherFromConfig", () => {
  it("returns undefined when no channels are configured", () => {
    const config = makeConfig({
      outputs: { template_engine: "handlebars", channels: [] },
    } as Partial<AppConfig>);
    const result = createOutputPublisherFromConfig(config);

    expect(result).toBeUndefined();
  });

  it("returns undefined when the channel kind is not gitea_pr_review", () => {
    const config = makeConfig({
      outputs: {
        template_engine: "handlebars",
        channels: [{ name: "feishu", kind: "feishu_bot" }],
      },
    } as Partial<AppConfig>);
    const result = createOutputPublisherFromConfig(config);

    expect(result).toBeUndefined();
  });

  it("returns undefined when required fields are missing", () => {
    const config = makeConfig({
      triggers: [],
      outputs: {
        template_engine: "handlebars",
        channels: [{ name: "gitea-pr", kind: "gitea_pr_review" }],
      },
    } as Partial<AppConfig>);
    const result = createOutputPublisherFromConfig(config, "gitea-pr", 42);

    expect(result).toBeUndefined();
  });

  it("returns a publisher when all required fields are present", () => {
    const config = makeConfig();
    const result = createOutputPublisherFromConfig(config, "gitea-pr", 42);

    expect(result).toBeDefined();
    expect(typeof result?.publishProblem).toBe("function");
  });

  it("derives Gitea target from channel trigger and workspace source repo", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ id: 321 });
    });

    const originalToken = process.env.GITEA_TOKEN;
    process.env.GITEA_TOKEN = "token-from-trigger";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            { name: "plan-gitea-pr", kind: "gitea_pr_review", trigger: "gitea-internal", review_update_strategy: "always_new" },
          ],
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(config, "plan-gitea-pr", 42, "test-workspace");

      assertProblemPublisher(publisher);
      assertSummaryPublisher(publisher);
      await publisher.publishProblem({
        file: "src/app.ts",
        line: 7,
        severity: "high",
        category: "correctness",
        message: "Issue.",
      });
      const result = await publisher.publishSummary!("", []);
      const firstResult = Array.isArray(result) ? result[0] : result;

      expect(firstResult?.externalId).toBe("321");
      expect(calls[0]?.url).toBe("https://gitea.example.com/api/v1/repos/owent/example/pulls/42/reviews");
      expect(calls[0]?.init.headers).toMatchObject({ authorization: "token token-from-trigger" });
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITEA_TOKEN;
      } else {
        process.env.GITEA_TOKEN = originalToken;
      }
    }
  });

  it("renders and publishes Gitea PR summaries through the configured publisher", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ id: 789 });
    });

    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            {
               name: "gitea-pr",
               kind: "gitea_pr_review",
               trigger: "gitea-internal",
               no_problems: { action: "publish" },
               review_update_strategy: "always_new",
             },
          ],
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(
        config,
        "gitea-pr",
        42,
        "test-workspace",
        {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "pull_request",
          repoRef: "owent/example",
          title: "Fix parser",
          url: "https://gitea.example.com/owent/example/pulls/42",
          author: { username: "owent", displayName: "OwEnt" },
          reason: "gitea:opened",
        },
      );

      expect(publisher?.publishEmptySummary).toBe(true);
      const result = await publisher?.publishSummary?.(
        "Review summary",
        [
          { file: "src/app.ts", line: 3, severity: "medium", category: "correctness", message: "Issue." },
        ],
        { title: "Focused summary title" },
      );

      expect(result).toMatchObject({ channel: "gitea-pr", status: "published", externalId: "789" });
      expect(calls[0]?.url).toBe("https://gitea.example.com/api/v1/repos/owent/example/pulls/42/reviews");
      const body = JSON.parse(calls[0]?.init.body ?? "{}");
      expect(body.event).toBe("COMMENT");
      expect(body.body).toContain("AI Code Review Summary");
      expect(body.body).toContain("Focused summary title");
      expect(body.body).toContain("Fix parser");
      expect(body.body).toContain("**Author**: @owent (OwEnt)");
      expect(body.body).toContain("**Reviewers**: @owent (OwEnt)");
      expect(body.body).toContain("Review summary");
      expect(body.body).toContain("src/app.ts:3");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates a GitHub PR publisher from channel trigger and workspace source repo", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ id: 987 });
    });

    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "github-token";
    try {
      const config = makeConfig({
        triggers: [{ name: "github-saas", kind: "github", token_env: "GITHUB_TOKEN" }],
        outputs: {
          template_engine: "handlebars",
          channels: [{ name: "github-pr", kind: "github_pr_review", trigger: "github-saas", review_update_strategy: "always_new" }],
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "github-saas", repo: "owent/example" },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(config, "github-pr", 42, "test-workspace");

      assertProblemPublisher(publisher);
      assertSummaryPublisher(publisher);
      await publisher.publishProblem({
        file: "src/app.ts",
        line: 7,
        severity: "high",
        category: "correctness",
        message: "Issue.",
      });
      const result = await publisher.publishSummary!("", []);
      const firstResult = Array.isArray(result) ? result[0] : result;

      expect(firstResult?.externalId).toBe("987");
      expect(calls[0]?.url).toBe("https://api.github.com/repos/owent/example/pulls/42/reviews");
      expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer github-token" });
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });

  it("creates a GitHub issue publisher from channel trigger and workspace", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ id: 555 });
    });

    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-issue-token";
    try {
      const config = makeConfig({
        triggers: [{ name: "github-saas", kind: "github", token_env: "GITHUB_TOKEN" }],
        outputs: {
          template_engine: "handlebars",
          channels: [{ name: "github-issue", kind: "github_issue", trigger: "github-saas" }],
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "github-saas", repo: "my-org/my-repo" },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(config, "github-issue", 10, "test-workspace");

      expect(publisher).toBeDefined();
      assertProblemPublisher(publisher);
      assertSummaryPublisher(publisher);
      await publisher.publishProblem({
        file: "src/app.ts",
        line: 7,
        severity: "high",
        category: "correctness",
        message: "Issue.",
      });
      await publisher.publishSummary("Review summary");

      expect(calls[0]?.url).toBe("https://api.github.com/repos/my-org/my-repo/issues/10/comments");
      expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer gh-issue-token" });
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });

  it("renders GitHub issue summary problems passed directly", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-templates-"));
    const calls: { url: string; init: { body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ id: 556 });
    });

    try {
      const templatesDir = join(tempDir, "workspaces", "test-workspace", "templates");
      await mkdir(templatesDir, { recursive: true });
      await writeFile(
        join(templatesDir, "problem.hbs"),
        "CUSTOM PROBLEM {{problem.location}} :: {{problem.message}}",
        "utf8",
      );
      const config = makeConfig({
        triggers: [{ name: "github-saas", kind: "github" }],
        outputs: {
          template_engine: "handlebars",
          channels: [{ name: "github-issue", kind: "github_issue", trigger: "github-saas" }],
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "github-saas", repo: "my-org/my-repo" },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(config, "github-issue", 10, "test-workspace", {
        triggerName: "github-saas",
        provider: "github",
        workspaceId: "test-workspace",
        targetKind: "pull_request",
        repoRef: "my-org/my-repo",
        author: { username: "octocat" },
        reason: "github:opened",
      }, tempDir);

      await publisher!.publishSummary?.("Review summary", [
        { file: "src/app.ts", line: 7, severity: "high", category: "correctness", message: "Issue." },
      ]);

      const body = JSON.parse(calls[0]?.init.body ?? "{}");
      expect(body.body).toContain("AI Code Review Summary");
      expect(body.body).toContain("Reviewers");
      expect(body.body).toContain("@octocat");
      expect(body.body).toContain("CUSTOM PROBLEM src/app.ts:7 :: Issue.");
    } finally {
      vi.unstubAllGlobals();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a GitHub problem issue publisher from channel config", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string; method?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
      calls.push({ url, init: init ?? {} });
      if (url.includes("/issues?state=open")) {
        return response([]);
      }
      return response({ id: 600, number: 30, html_url: "https://github.com/my-org/my-repo/issues/30" });
    });

    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-problem-token";
    try {
      const config = makeConfig({
        triggers: [{ name: "github-saas", kind: "github", token_env: "GITHUB_TOKEN" }],
        outputs: {
          template_engine: "handlebars",
          channels: [{
            name: "github-problem-issues",
            kind: "github_problem_issue",
            trigger: "github-saas",
            marker_prefix: "[AICR]",
            marker_label: "aicr-managed",
          }],
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "github-saas", repo: "my-org/my-repo" },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(config, "github-problem-issues", undefined, "test-workspace");

      expect(publisher).toBeDefined();
      expect(publisher!.publishesProblems).toBe(false);
      expect(publisher!.publishEmptySummary).toBe(true);
      assertProblemPublisher(publisher);
      assertSummaryPublisher(publisher);

      await publisher.publishProblem({
        file: "src/app.ts",
        line: 7,
        severity: "high",
        category: "correctness",
        message: "Issue.",
      });

      const results = await publisher.publishSummary(
        "Review summary",
        [{ file: "src/app.ts", line: 7, severity: "high", category: "correctness", message: "Issue." }],
        { title: "Focused summary title" },
      );

      expect(Array.isArray(results)).toBe(true);
      const issueCall = calls.find((c) => c.url.endsWith("/repos/my-org/my-repo/issues") && c.init?.method === "POST");
      expect(issueCall).toBeDefined();
      expect(issueCall?.init.headers).toMatchObject({ authorization: "Bearer gh-problem-token" });
      const body = JSON.parse(issueCall?.init.body ?? "{}");
      expect(body.title).toBe("[AICR] [HIGH] src/app.ts:7 · Issue");
      expect(body.title).not.toContain("Focused summary title");
      expect(body.body).toContain("Focused summary title");
      expect(calls[0]?.url).toBe("https://api.github.com/repos/my-org/my-repo/issues?state=open&sort=updated&direction=desc&per_page=20&page=1");
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });

  it("passes issue_mode per_problem to GitHub problem issue publishers", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string; method?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
      calls.push({ url, init: init ?? {} });
      if (url.includes("/issues?state=open")) {
        return response([]);
      }
      return response({ id: 600 + calls.length, number: 30 + calls.length, html_url: `https://github.com/my-org/my-repo/issues/${30 + calls.length}` });
    });

    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-problem-token";
    try {
      const config = makeConfig({
        triggers: [{ name: "github-saas", kind: "github", token_env: "GITHUB_TOKEN" }],
        outputs: {
          template_engine: "handlebars",
          channels: [{
            name: "github-problem-issues",
            kind: "github_problem_issue",
            trigger: "github-saas",
            issue_mode: "per_problem",
            marker_prefix: "[AICR]",
            marker_label: "aicr-managed",
          }],
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "github-saas", repo: "my-org/my-repo" },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(config, "github-problem-issues", undefined, "test-workspace");
      assertSummaryPublisher(publisher);

      const results = await publisher.publishSummary(
        "Review summary",
        [
          { file: "src/app.ts", line: 7, severity: "high", category: "correctness", message: "First issue." },
          { file: "src/lib.ts", line: 9, severity: "medium", category: "style", message: "Second issue." },
        ],
      );

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(2);
      const issueCalls = calls.filter((c) => c.url.endsWith("/repos/my-org/my-repo/issues") && c.init?.method === "POST");
      expect(issueCalls).toHaveLength(2);
      const bodies = issueCalls.map((call) => JSON.parse(call.init.body ?? "{}"));
      expect(bodies.every((body) => typeof body.title === "string" && !body.body.includes("<!-- aicr:consolidated=true -->"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    }
  });

  it("creates a GitLab MR publisher with base/head SHAs from the review event", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ id: 654 });
    });

    const originalToken = process.env.GITLAB_TOKEN;
    process.env.GITLAB_TOKEN = "gitlab-token";
    try {
      const config = makeConfig({
        triggers: [
          { name: "gitlab-main", kind: "gitlab", base_url: "https://gitlab.example", token_env: "GITLAB_TOKEN" },
        ],
        outputs: {
          template_engine: "handlebars",
          channels: [{ name: "gitlab-mr", kind: "gitlab_mr_review", trigger: "gitlab-main" }],
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "gitlab-main", repo: "owent/example" },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(
        config,
        "gitlab-mr",
        9,
        "test-workspace",
        {
          triggerName: "gitlab-main",
          provider: "gitlab",
          workspaceId: "test-workspace",
          targetKind: "pull_request",
          repoRef: "owent/example",
          baseSha: "base-sha",
          headSha: "head-sha",
          author: {},
          reason: "gitlab:merge_request",
        },
      );

      assertProblemPublisher(publisher);
      await publisher.publishProblem({
        file: "src/app.ts",
        line: 7,
        severity: "medium",
        category: "correctness",
        message: "Issue.",
      });

      expect(calls[0]?.url).toBe("https://gitlab.example/api/v4/projects/owent%2Fexample/merge_requests/9/discussions");
      expect(calls[0]?.init.headers).toMatchObject({ "private-token": "gitlab-token" });
      expect(JSON.parse(calls[0]?.init.body ?? "{}").position).toMatchObject({
        base_sha: "base-sha",
        head_sha: "head-sha",
        new_line: 7,
      });
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITLAB_TOKEN;
      } else {
        process.env.GITLAB_TOKEN = originalToken;
      }
    }
  });

  it("creates a Gitea problem issue lifecycle publisher without a pull number", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string; method?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
      calls.push({ url, init: init ?? {} });
      return calls.length === 1 ? response([]) : response({ id: 88, number: 12 });
    });

    const originalToken = process.env.GITEA_TOKEN;
    process.env.GITEA_TOKEN = "resolver-token";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            {
              name: "gitea-problem-issues",
              kind: "gitea_problem_issue",
              trigger: "gitea-internal",
              marker_prefix: "[AICR Managed]",
              marker_label: "aicr-managed",
              resolved_action: "close",
            },
          ],
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(
        config,
        "gitea-problem-issues",
        undefined,
        "test-workspace",
        {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "owent/example",
          author: {},
          reason: "gitea:push",
        },
      );

      expect(publisher).toBeDefined();
      expect(publisher?.publishesProblems).toBe(false);
      expect(publisher?.publishEmptySummary).toBe(true);
      assertSummaryPublisher(publisher);
      const results = await publisher.publishSummary(
        "",
        [{ file: "src/app.ts", line: 3, severity: "high", category: "security", message: "Issue." }],
        { title: "Focused summary title" },
      );

      expect(Array.isArray(results)).toBe(true);
      expect(calls[0]?.url).toBe("https://gitea.example.com/api/v1/repos/owent/example/issues?state=open&type=issues&limit=20&page=1");
      expect(calls[1]?.url).toBe("https://gitea.example.com/api/v1/repos/owent/example/issues");
      expect(calls[1]?.init.headers).toMatchObject({ authorization: "token resolver-token" });
      const body = JSON.parse(calls[1]?.init.body ?? "{}");
      expect(body.title).toBe("[AICR Managed] [HIGH] src/app.ts:3 · Issue");
      expect(body.title).not.toContain("Focused summary title");
      expect(body.body).toContain("Focused summary title");
      expect(body.title).not.toContain(" - ");
      expect(body.body).toContain("<!-- aicr:managed=problem-issue -->");
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITEA_TOKEN;
      } else {
        process.env.GITEA_TOKEN = originalToken;
      }
    }
  });

  it("passes issue_mode per_problem to Gitea problem issue publishers", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string; method?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
      calls.push({ url, init: init ?? {} });
      if (url.includes("/issues?state=open&type=issues")) {
        return response([]);
      }
      return response({ id: 80 + calls.length, number: 10 + calls.length });
    });

    const originalToken = process.env.GITEA_TOKEN;
    process.env.GITEA_TOKEN = "resolver-token";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            {
              name: "gitea-problem-issues",
              kind: "gitea_problem_issue",
              trigger: "gitea-internal",
              issue_mode: "per_problem",
              marker_prefix: "[AICR Managed]",
              marker_label: "aicr-managed",
              resolved_action: "close",
            },
          ],
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(
        config,
        "gitea-problem-issues",
        undefined,
        "test-workspace",
        {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "owent/example",
          author: {},
          reason: "gitea:push",
        },
      );
      assertSummaryPublisher(publisher);

      const results = await publisher.publishSummary(
        "Review summary",
        [
          { file: "src/app.ts", line: 3, severity: "high", category: "security", message: "First issue." },
          { file: "src/lib.ts", line: 5, severity: "medium", category: "style", message: "Second issue." },
        ],
      );

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(2);
      const issueCalls = calls.filter((c) => c.url === "https://gitea.example.com/api/v1/repos/owent/example/issues" && c.init?.method === "POST");
      expect(issueCalls).toHaveLength(2);
      const bodies = issueCalls.map((call) => JSON.parse(call.init.body ?? "{}"));
      expect(bodies.every((body) => typeof body.title === "string" && !body.body.includes("<!-- aicr:consolidated=true -->"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITEA_TOKEN;
      } else {
        process.env.GITEA_TOKEN = originalToken;
      }
    }
  });

  it("passes workspace managed issue fetch limit overrides to problem issue publishers", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string; method?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response([]);
    });

    const base = makeConfig();
    const config = makeConfig({
      triggers: [{ name: "github-saas", kind: "github" }],
      review: {
        ...base.review,
        problem_issue: { max_recent_issues: 50 },
      },
      outputs: {
        template_engine: "handlebars",
        channels: [{ name: "github-problem-issues", kind: "github_problem_issue", trigger: "github-saas" }],
      },
      workspaces: {
        cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
        defaults: {},
        instances: {
          "test-workspace": {
            source_repo: { trigger: "github-saas", repo: "my-org/my-repo" },
            review: { problem_issue: { max_recent_issues: 7 } },
          },
        },
      },
    } as Partial<AppConfig>);

    try {
      const publisher = createOutputPublisherFromConfig(
        config,
        "github-problem-issues",
        undefined,
        "test-workspace",
        {
          triggerName: "github-saas",
          provider: "github",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "my-org/my-repo",
          author: {},
          reason: "github:push",
        },
      );

      expect(publisher).toBeDefined();
      await publisher?.publishSummary?.("", []);

      expect(calls[0]?.url).toBe("https://api.github.com/repos/my-org/my-repo/issues?state=open&sort=updated&direction=desc&per_page=7&page=1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes configured Feishu author mappings as mention text", async () => {
    const calls: { url: string; init: { body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ code: 0 });
    });

    const originalWebhook = process.env.FEISHU_WEBHOOK;
    process.env.FEISHU_WEBHOOK = "https://open.feishu.cn/hook/test";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          author_resolution: {
            email_mappings: { "dev@example.com": "ou_dev" },
            email_blacklist: [],
          },
          channels: [
            {
              name: "feishu-team",
              kind: "feishu_bot",
              webhook_url_env: "FEISHU_WEBHOOK",
              mention_author: true,
            },
          ],
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(
        config,
        "feishu-team",
        undefined,
        "test-workspace",
        {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "pull_request",
          repoRef: "owent/example",
          author: { email: "dev@example.com" },
          reason: "gitea:opened",
        },
      );

      await publisher?.publishSummary?.("Review summary", []);

      const body = JSON.parse(calls[0]?.init.body ?? "{}");
      const elements = (body.card as { elements: Array<{ content?: string }> }).elements;
      expect(elements.some((element) => element.content?.includes('<at user_id="ou_dev"></at>'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      if (originalWebhook === undefined) {
        delete process.env.FEISHU_WEBHOOK;
      } else {
        process.env.FEISHU_WEBHOOK = originalWebhook;
      }
    }
  });

  it("honors Feishu mention_fallback all and mention_author false", async () => {
    const calls: { init: { body?: string } }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
      calls.push({ init: init ?? {} });
      return response({ code: 0 });
    });

    const originalWebhook = process.env.FEISHU_WEBHOOK;
    process.env.FEISHU_WEBHOOK = "https://open.feishu.cn/hook/test";
    try {
      const baseConfig = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            {
              name: "feishu-team",
              kind: "feishu_bot",
              webhook_url_env: "FEISHU_WEBHOOK",
              mention_author: true,
              mention_fallback: "all",
            },
          ],
        },
      } as Partial<AppConfig>);
      const reviewEvent = {
        triggerName: "gitea-internal",
        provider: "gitea" as const,
        workspaceId: "test-workspace",
        targetKind: "pull_request" as const,
        repoRef: "owent/example",
        author: { email: "unknown@example.com" },
        reason: "gitea:opened",
      };

      await createOutputPublisherFromConfig(
        baseConfig,
        "feishu-team",
        undefined,
        "test-workspace",
        reviewEvent,
      )?.publishSummary?.("Review summary", []);
      const fallbackBody = JSON.parse(calls[0]?.init.body ?? "{}");
      const fallbackElements = (fallbackBody.card as { elements: Array<{ content?: string }> }).elements;
      expect(fallbackElements.some((element) => element.content?.includes('<at user_id="all"></at>'))).toBe(true);

      const noMentionConfig = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            {
              name: "feishu-team",
              kind: "feishu_bot",
              webhook_url_env: "FEISHU_WEBHOOK",
              mention_author: false,
              mention_fallback: "all",
            },
          ],
        },
      } as Partial<AppConfig>);
      await createOutputPublisherFromConfig(
        noMentionConfig,
        "feishu-team",
        undefined,
        "test-workspace",
        reviewEvent,
      )?.publishSummary?.("Review summary", []);
      const disabledBody = JSON.parse(calls[1]?.init.body ?? "{}");
      const disabledElements = (disabledBody.card as { elements: Array<{ content?: string }> }).elements;
      expect(disabledElements.some((element) => element.content?.includes("<at"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      if (originalWebhook === undefined) {
        delete process.env.FEISHU_WEBHOOK;
      } else {
        process.env.FEISHU_WEBHOOK = originalWebhook;
      }
    }
  });
});

describe("createOutputPublisherResolverFromConfig", () => {
  it("creates a publisher from pull request payload and workspace route", async () => {
    const calls: { url: string; init: { headers?: Record<string, string>; body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ id: 654 });
    });

    const originalToken = process.env.GITEA_TOKEN;
    process.env.GITEA_TOKEN = "resolver-token";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            { name: "gitea-pr", kind: "gitea_pr_review", trigger: "gitea-internal", review_update_strategy: "always_new" },
          ],
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "gitea-internal", repo: "owent/example" },
              outputs: {
                line_comments: ["gitea-pr"],
                summary: ["gitea-pr"],
              },
            },
          },
        },
      } as Partial<AppConfig>);
      const resolver = createOutputPublisherResolverFromConfig(config);
      const publisher = resolver({
        reviewEvent: {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "pull_request",
          repoRef: "owent/example",
          author: {},
          reason: "gitea:opened",
        },
        payload: { pull_request: { number: 77 } },
        provider: "gitea",
        eventName: "pull_request",
      });

      assertSummaryPublisher(publisher);
      await publisher.publishSummary("Review summary", [
        { file: "src/app.ts", line: 3, severity: "medium", category: "correctness", message: "Issue." },
      ]);

      expect(calls[0]?.url).toBe("https://gitea.example.com/api/v1/repos/owent/example/pulls/77/reviews");
      expect(calls[0]?.init.headers).toMatchObject({ authorization: "token resolver-token" });
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITEA_TOKEN;
      } else {
        process.env.GITEA_TOKEN = originalToken;
      }
    }
  });

  it("routes line comments and summaries to separate configured channels", async () => {
    const calls: { url: string; init: { body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ id: calls.length, code: 0 });
    });

    const originalGiteaToken = process.env.GITEA_TOKEN;
    const originalFeishuWebhook = process.env.FEISHU_WEBHOOK;
    process.env.GITEA_TOKEN = "resolver-token";
    process.env.FEISHU_WEBHOOK = "https://open.feishu.cn/hook/test";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            { name: "gitea-pr", kind: "gitea_pr_review", trigger: "gitea-internal", review_update_strategy: "always_new" },
            { name: "feishu-team", kind: "feishu_bot", webhook_url_env: "FEISHU_WEBHOOK" },
          ],
          routes: {
            default: {
              line_comments: ["gitea-pr"],
              summary: ["feishu-team"],
            },
            rules: [],
          },
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "gitea-internal", repo: "owent/example" },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherResolverFromConfig(config)({
        reviewEvent: {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "pull_request",
          repoRef: "owent/example",
          author: {},
          reason: "gitea:opened",
        },
        payload: { pull_request: { number: 77 } },
        provider: "gitea",
        eventName: "pull_request",
      });

      assertProblemPublisher(publisher);
      await publisher.publishProblem({
        file: "src/app.ts",
        line: 3,
        severity: "medium",
        category: "correctness",
        message: "Issue.",
      });
      await publisher?.publishSummary?.("Summary.", [
        { file: "src/app.ts", line: 3, severity: "medium", category: "correctness", message: "Issue." },
      ]);

      expect(calls.map((call) => call.url)).toEqual([
        "https://gitea.example.com/api/v1/repos/owent/example/pulls/77/reviews",
        "https://open.feishu.cn/hook/test",
      ]);
      const reviewBody = JSON.parse(calls[0]?.init.body ?? "{}");
      expect(reviewBody.comments).toBeUndefined();
      expect(reviewBody.body).toContain("src/app.ts:3");
    } finally {
      vi.unstubAllGlobals();
      if (originalGiteaToken === undefined) {
        delete process.env.GITEA_TOKEN;
      } else {
        process.env.GITEA_TOKEN = originalGiteaToken;
      }
      if (originalFeishuWebhook === undefined) {
        delete process.env.FEISHU_WEBHOOK;
      } else {
        process.env.FEISHU_WEBHOOK = originalFeishuWebhook;
      }
    }
  });

  it("flushes line-comment PR review channels even when no summary route is configured", async () => {
    const calls: { url: string; init: { body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ id: 777 });
    });

    const originalGiteaToken = process.env.GITEA_TOKEN;
    process.env.GITEA_TOKEN = "resolver-token";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            { name: "gitea-pr", kind: "gitea_pr_review", trigger: "gitea-internal", review_update_strategy: "always_new" },
          ],
          routes: {
            default: {
              line_comments: ["gitea-pr"],
            },
            rules: [],
          },
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "gitea-internal", repo: "owent/example" },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherResolverFromConfig(config)({
        reviewEvent: {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "pull_request",
          repoRef: "owent/example",
          author: {},
          reason: "gitea:opened",
        },
        payload: { pull_request: { number: 77 } },
        provider: "gitea",
        eventName: "pull_request",
      });

      assertProblemPublisher(publisher);
      assertSummaryPublisher(publisher);
      await publisher.publishProblem({
        file: "src/app.ts",
        line: 3,
        severity: "medium",
        category: "correctness",
        message: "Issue.",
      });
      const result = await publisher.publishSummary("", [
        { file: "src/app.ts", line: 3, severity: "medium", category: "correctness", message: "Issue." },
      ]);

      expect(calls.map((call) => call.url)).toEqual([
        "https://gitea.example.com/api/v1/repos/owent/example/pulls/77/reviews",
      ]);
      const firstResult = Array.isArray(result) ? result[0] : result;
      expect(firstResult?.status).toBe("published");
      const reviewBody = JSON.parse(calls[0]?.init.body ?? "{}");
      expect(reviewBody.comments).toBeUndefined();
      expect(reviewBody.body).toContain("src/app.ts:3");
    } finally {
      vi.unstubAllGlobals();
      if (originalGiteaToken === undefined) {
        delete process.env.GITEA_TOKEN;
      } else {
        process.env.GITEA_TOKEN = originalGiteaToken;
      }
    }
  });

  it("isolates a failing summary channel and continues publishing later channels", async () => {
    const calls: { url: string; init: { body?: string; method?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string; method?: string }) => {
      calls.push({ url, init: init ?? {} });
      if (url.startsWith("https://api.github.com/")) {
        return response({ message: "Resource not accessible by integration" }, 403);
      }
      return response({ code: 0 });
    });

    const originalGithubToken = process.env.GITHUB_TOKEN;
    const originalFeishuWebhook = process.env.FEISHU_WEBHOOK;
    process.env.GITHUB_TOKEN = "github-token-without-issues-write";
    process.env.FEISHU_WEBHOOK = "https://open.feishu.cn/hook/success";
    try {
      const config = makeConfig({
        triggers: [{ name: "github-saas", kind: "github", token_env: "GITHUB_TOKEN" }],
        outputs: {
          template_engine: "handlebars",
          channels: [
            { name: "github-problem-issues", kind: "github_problem_issue", trigger: "github-saas" },
            { name: "feishu-team", kind: "feishu_bot", webhook_url_env: "FEISHU_WEBHOOK" },
          ],
          routes: {
            default: {},
            rules: [
              { match: { trigger: "github-saas", target_kind: "push" }, summary: ["github-problem-issues", "feishu-team"] },
            ],
          },
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "github-saas", repo: "my-org/my-repo" },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherResolverFromConfig(config)({
        reviewEvent: {
          triggerName: "github-saas",
          provider: "github",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "my-org/my-repo",
          headSha: "abcdef1234567890",
          author: {},
          reason: "github:push",
        },
        payload: {},
        provider: "github",
        eventName: "push",
      });

      expect(publisher).toBeDefined();
      const results = await publisher?.publishSummary?.("Review summary", [
        { file: "src/app.ts", line: 1, severity: "high", category: "correctness", message: "Issue." },
      ]);

      expect(results).toHaveLength(2);
      expect(results?.[0]).toMatchObject({
        channel: "github-problem-issues",
        status: "failed",
        raw: {
          action: "dispatch_failed",
          phase: "summary",
          status: 403,
        },
      });
      expect(String((results?.[0]?.raw as { hint?: unknown } | undefined)?.hint)).toContain("webhook event subscriptions");
      expect(results?.[1]).toMatchObject({ channel: "feishu-team", status: "published" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://api.github.com/repos/my-org/my-repo/issues?state=open&sort=updated&direction=desc&per_page=20&page=1",
        "https://open.feishu.cn/hook/success",
      ]);
    } finally {
      vi.unstubAllGlobals();
      if (originalGithubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalGithubToken;
      }
      if (originalFeishuWebhook === undefined) {
        delete process.env.FEISHU_WEBHOOK;
      } else {
        process.env.FEISHU_WEBHOOK = originalFeishuWebhook;
      }
    }
  });

  it("resolves a problem issue lifecycle channel for push events", async () => {
    const calls: { url: string; init: { body?: string; method?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string; method?: string }) => {
      calls.push({ url, init: init ?? {} });
      return calls.length === 1 ? response([]) : response({ id: 100, number: 20 });
    });

    const originalToken = process.env.GITEA_TOKEN;
    process.env.GITEA_TOKEN = "resolver-token";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            { name: "gitea-problem-issues", kind: "gitea_problem_issue", trigger: "gitea-internal" },
          ],
          routes: {
            default: {},
            rules: [
              { match: { target_kind: "push" }, summary: ["gitea-problem-issues"] },
            ],
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherResolverFromConfig(config)({
        reviewEvent: {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "owent/example",
          author: {},
          reason: "gitea:push",
        },
        payload: {},
        provider: "gitea",
        eventName: "push",
      });

      expect(publisher).toBeDefined();
      await publisher?.publishSummary?.("", [
        { file: "src/app.ts", line: 1, severity: "medium", category: "correctness", message: "Issue." },
      ]);

      expect(calls[1]?.url).toBe("https://gitea.example.com/api/v1/repos/owent/example/issues");
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITEA_TOKEN;
      } else {
        process.env.GITEA_TOKEN = originalToken;
      }
    }
  });

  it("prefers route rules over workspace outputs for push events", async () => {
    const calls: { url: string; init: { body?: string; method?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string; method?: string }) => {
      calls.push({ url, init: init ?? {} });
      return calls.length === 1 ? response([]) : response({ id: 100, number: 20 });
    });

    const originalToken = process.env.GITEA_TOKEN;
    process.env.GITEA_TOKEN = "resolver-token";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            { name: "gitea-pr", kind: "gitea_pr_review", trigger: "gitea-internal" },
            { name: "gitea-problem-issues", kind: "gitea_problem_issue", trigger: "gitea-internal" },
          ],
          routes: {
            default: {},
            rules: [
              { match: { target_kind: "push" }, summary: ["gitea-problem-issues"] },
            ],
          },
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "gitea-internal", repo: "owent/example" },
              outputs: {
                line_comments: ["gitea-pr"],
                summary: ["gitea-pr"],
              },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherResolverFromConfig(config)({
        reviewEvent: {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "owent/example",
          author: {},
          reason: "gitea:push",
        },
        payload: {},
        provider: "gitea",
        eventName: "push",
      });

      expect(publisher).toBeDefined();
      await publisher?.publishSummary?.("", [
        { file: "src/app.ts", line: 1, severity: "medium", category: "correctness", message: "Issue." },
      ]);

      expect(calls[1]?.url).toBe("https://gitea.example.com/api/v1/repos/owent/example/issues");
    } finally {
      vi.unstubAllGlobals();
      if (originalToken === undefined) {
        delete process.env.GITEA_TOKEN;
      } else {
        process.env.GITEA_TOKEN = originalToken;
      }
    }
  });

  it("filters zero-problem summaries per channel no_problems policy", async () => {
    const calls: { url: string; init: { body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ code: 0 });
    });

    const originalSuppressWebhook = process.env.FEISHU_SUPPRESS_WEBHOOK;
    const originalPublishWebhook = process.env.FEISHU_PUBLISH_WEBHOOK;
    process.env.FEISHU_SUPPRESS_WEBHOOK = "https://open.feishu.cn/hook/suppress";
    process.env.FEISHU_PUBLISH_WEBHOOK = "https://open.feishu.cn/hook/publish";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          no_problems: { action: "suppress" },
          channels: [
            {
              name: "feishu-suppress",
              kind: "feishu_bot",
              webhook_url_env: "FEISHU_SUPPRESS_WEBHOOK",
            },
            {
              name: "feishu-publish",
              kind: "feishu_bot",
              webhook_url_env: "FEISHU_PUBLISH_WEBHOOK",
            },
          ],
          routes: {
            default: { summary: ["feishu-suppress", "feishu-publish"] },
            rules: [],
          },
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "gitea-internal", repo: "owent/example" },
              outputs: {
                channel_overrides: {
                  "feishu-publish": { no_problems: { action: "publish" } },
                },
              },
            },
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherResolverFromConfig(config)({
        reviewEvent: {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "owent/example",
          headSha: "abcdef1234567890",
          author: {},
          reason: "gitea:push",
        },
        payload: {},
        provider: "gitea",
        eventName: "push",
      });

      expect(publisher).toBeDefined();
      expect(publisher?.noProblemsAction).toBe("publish");
      const results = await publisher?.publishSummary?.("No actionable problems.", []);

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(1);
      expect(calls.map((call) => call.url)).toEqual([
        "https://open.feishu.cn/hook/publish",
      ]);
      expect(calls[0]?.init.body).toContain("No actionable problems.");
      expect(calls[0]?.init.body).toContain("Commit abcdef123456");
    } finally {
      vi.unstubAllGlobals();
      if (originalSuppressWebhook === undefined) {
        delete process.env.FEISHU_SUPPRESS_WEBHOOK;
      } else {
        process.env.FEISHU_SUPPRESS_WEBHOOK = originalSuppressWebhook;
      }
      if (originalPublishWebhook === undefined) {
        delete process.env.FEISHU_PUBLISH_WEBHOOK;
      } else {
        process.env.FEISHU_PUBLISH_WEBHOOK = originalPublishWebhook;
      }
    }
  });

  it("publishes trigger error reports even when no_problems is suppressed", async () => {
    const calls: { url: string; init: { body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ code: 0 });
    });

    const originalSuppressWebhook = process.env.FEISHU_SUPPRESS_WEBHOOK;
    const originalPublishWebhook = process.env.FEISHU_PUBLISH_WEBHOOK;
    process.env.FEISHU_SUPPRESS_WEBHOOK = "https://open.feishu.cn/hook/suppress";
    process.env.FEISHU_PUBLISH_WEBHOOK = "https://open.feishu.cn/hook/publish";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          no_problems: { action: "suppress" },
          channels: [
            {
              name: "feishu-suppress",
              kind: "feishu_bot",
              webhook_url_env: "FEISHU_SUPPRESS_WEBHOOK",
            },
            {
              name: "feishu-publish",
              kind: "feishu_bot",
              webhook_url_env: "FEISHU_PUBLISH_WEBHOOK",
              no_problems: { action: "publish" },
            },
          ],
          routes: {
            default: { summary: ["feishu-suppress", "feishu-publish"] },
            rules: [],
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherResolverFromConfig(config)({
        reviewEvent: {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "owent/example",
          author: {},
          reason: "gitea:push",
        },
        payload: {},
        provider: "gitea",
        eventName: "push",
      });

      const results = await publisher?.publishSummary?.(
        "## AICodeReviewer trigger processing failed\n\n- reason: test",
        [],
        { bypassNoProblemsPolicy: true },
      );

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(2);
      expect(calls.map((call) => call.url)).toEqual([
        "https://open.feishu.cn/hook/suppress",
        "https://open.feishu.cn/hook/publish",
      ]);
    } finally {
      vi.unstubAllGlobals();
      if (originalSuppressWebhook === undefined) {
        delete process.env.FEISHU_SUPPRESS_WEBHOOK;
      } else {
        process.env.FEISHU_SUPPRESS_WEBHOOK = originalSuppressWebhook;
      }
      if (originalPublishWebhook === undefined) {
        delete process.env.FEISHU_PUBLISH_WEBHOOK;
      } else {
        process.env.FEISHU_PUBLISH_WEBHOOK = originalPublishWebhook;
      }
    }
  });

  it("publishes summary to feishu when publish_if_summary and summary has content", async () => {
    const calls: { url: string; init: { body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ code: 0 });
    });

    const originalWebhook = process.env.FEISHU_IF_SUMMARY_WEBHOOK;
    process.env.FEISHU_IF_SUMMARY_WEBHOOK = "https://open.feishu.cn/hook/if-summary";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            {
              name: "feishu-if-summary",
              kind: "feishu_bot",
              webhook_url_env: "FEISHU_IF_SUMMARY_WEBHOOK",
            },
          ],
          routes: {
            default: { summary: ["feishu-if-summary"] },
            rules: [],
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherResolverFromConfig(config)({
        reviewEvent: {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "owent/example",
          headSha: "abcdef1234567890",
          author: {},
          reason: "gitea:push",
        },
        payload: {},
        provider: "gitea",
        eventName: "push",
      });

      expect(publisher).toBeDefined();
      expect(publisher?.noProblemsAction).toBe("publish_if_summary");
      const results = await publisher?.publishSummary?.("Found a critical issue: runtime error.", []);

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://open.feishu.cn/hook/if-summary");
      expect(calls[0]?.init.body).toContain("critical issue");
    } finally {
      vi.unstubAllGlobals();
      if (originalWebhook === undefined) {
        delete process.env.FEISHU_IF_SUMMARY_WEBHOOK;
      } else {
        process.env.FEISHU_IF_SUMMARY_WEBHOOK = originalWebhook;
      }
    }
  });

  it("suppresses summary to feishu when publish_if_summary and summary is empty", async () => {
    const calls: { url: string; init: { body?: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      calls.push({ url, init: init ?? {} });
      return response({ code: 0 });
    });

    const originalWebhook = process.env.FEISHU_IF_SUMMARY_EMPTY_WEBHOOK;
    process.env.FEISHU_IF_SUMMARY_EMPTY_WEBHOOK = "https://open.feishu.cn/hook/if-summary-empty";
    try {
      const config = makeConfig({
        outputs: {
          template_engine: "handlebars",
          channels: [
            {
              name: "feishu-if-summary-empty",
              kind: "feishu_bot",
              webhook_url_env: "FEISHU_IF_SUMMARY_EMPTY_WEBHOOK",
            },
          ],
          routes: {
            default: { summary: ["feishu-if-summary-empty"] },
            rules: [],
          },
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherResolverFromConfig(config)({
        reviewEvent: {
          triggerName: "gitea-internal",
          provider: "gitea",
          workspaceId: "test-workspace",
          targetKind: "push",
          repoRef: "owent/example",
          headSha: "abcdef1234567890",
          author: {},
          reason: "gitea:push",
        },
        payload: {},
        provider: "gitea",
        eventName: "push",
      });

      expect(publisher).toBeDefined();
      expect(publisher?.noProblemsAction).toBe("publish_if_summary");
      const results = await publisher?.publishSummary?.("", []);

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
      expect(calls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      if (originalWebhook === undefined) {
        delete process.env.FEISHU_IF_SUMMARY_EMPTY_WEBHOOK;
      } else {
        process.env.FEISHU_IF_SUMMARY_EMPTY_WEBHOOK = originalWebhook;
      }
    }
  });

  it("returns undefined when pull number is not present", () => {
    const resolver = createOutputPublisherResolverFromConfig(makeConfig());
    const publisher = resolver({
      reviewEvent: {
        triggerName: "gitea-internal",
        provider: "gitea",
        workspaceId: "test-workspace",
        targetKind: "pull_request",
        repoRef: "owent/example",
        author: {},
        reason: "gitea:opened",
      },
      payload: {},
      provider: "gitea",
      eventName: "pull_request",
    });

    expect(publisher).toBeUndefined();
  });
});

describe("createVcsAdapterFromConfig", () => {
  it("returns a GitVcsAdapter", () => {
    const config = makeConfig();
    const adapter = createVcsAdapterFromConfig(config, "/tmp/repo");

    expect(adapter.kind).toBe("git");
  });
});

describe("buildSourceRootResolver", () => {
  it("returns a function that resolves to workspace/source/repo path", () => {
    const resolver = buildSourceRootResolver("/var/lib/aicr");
    const result = resolver({
      triggerName: "t",
      provider: "gitea",
      workspaceId: "ws1",
      targetKind: "pull_request",
      repoRef: "owent/example",
      author: {},
      reason: "test",
    });

    expect(result).toContain("ws1");
    expect(result).toContain("owent_example");
  });
});

describe("bootstrapServerApp", () => {
  it("returns ServerAppOptions with orchestration", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const config = makeConfig();
      const result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test prompt",
      });

      expect(result.reviewOrchestration).toBeDefined();
      expect(result.reviewOrchestration?.baseSystemPrompt).toBe("test prompt");
      expect(result.reviewOrchestration?.model.providerId).toBe("openai-prod");
      expect(result.reviewOrchestration?.dryRun).toBe(false);
      expect(typeof result.reviewOrchestration?.outputPublisherResolver).toBe("function");
      expect(result.reviewOrchestration?.sandbox?.kind).toBe("native");
      expect(result.reviewOrchestration?.agentAdapter?.kind).toBe("kilo");
      expect(result.reviewOrchestration?.agentTimeoutMs).toBe(600_000);
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it("includes gitea config when a gitea trigger is configured", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    const originalSecret = process.env.GITEA_SECRET;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GITEA_SECRET = "test-secret";
    try {
      const config = makeConfig();
      const result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test",
      });

      expect(result.gitea).toBeDefined();
      expect(result.gitea?.triggerName).toBe("gitea-internal");
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
      if (originalSecret === undefined) {
        delete process.env.GITEA_SECRET;
      } else {
        process.env.GITEA_SECRET = originalSecret;
      }
    }
  });

  it("exposes multiple GitHub webhook configs when several GitHub triggers are configured", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const config = makeConfig({
        triggers: [
          { name: "github-atframework", kind: "github" },
          { name: "github-owent", kind: "github" },
        ],
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "github-atsf4g-co": {
              source_repo: { trigger: "github-atframework", repo: "atframework/atsf4g-co" },
            },
            "github-libatapp": {
              source_repo: { trigger: "github-owent", repo: "owent/libatapp" },
            },
          },
        },
      } as Partial<AppConfig>);

      const result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test",
      });

      expect(Array.isArray(result.github)).toBe(true);
      expect(result.github).toMatchObject([
        {
          triggerName: "github-atframework",
          workspaceId: "github-atsf4g-co",
          repoRef: "atframework/atsf4g-co",
        },
        {
          triggerName: "github-owent",
          workspaceId: "github-libatapp",
          repoRef: "owent/libatapp",
        },
      ]);
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it("passes workspace-specific triage policy into server options", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const config = makeConfig({
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "gitea-internal", repo: "owent/example" },
              triage: {
                enabled: true,
                actions: ["close"],
                categories_close: ["spam", "invalid", "duplicate"],
                events: ["issues"],
                dry_run: true,
              },
            },
          },
        },
      } as Partial<AppConfig>);

      const result = await bootstrapServerApp({ config, baseSystemPrompt: "test" });

      expect(result.issueTriage?.workspacePolicies?.["test-workspace"]).toMatchObject({
        actions: ["close"],
        categoriesClose: ["spam", "invalid", "duplicate"],
        dryRun: true,
      });
      expect(result.issueTriage?.giteaClient).toBeDefined();
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it("normalizes legacy queue retry fields into trigger retry options", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const config = makeConfig({
        queue: {
          kind: "memory",
          retry: {
            max_attempts: 3,
            backoff_seconds: 30,
          },
        },
      } as Partial<AppConfig>);

      const result = await bootstrapServerApp({ config, baseSystemPrompt: "test" });

      expect(result.triggerRetry).toEqual({
        attempts: 3,
        backoff: {
          kind: "constant",
          base_ms: 30000,
          max_ms: 30000,
          jitter: false,
        },
      });
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });
});

describe("resolveP4TriggerConfig", () => {
  it("returns undefined when no p4 trigger configured", () => {
    const config = makeConfig();
    const result = resolveP4TriggerConfig(config);
    expect(result).toBeUndefined();
  });

  it("resolves p4 trigger config from trigger list", () => {
    process.env.P4USER = "testuser";
    process.env.P4TICKET = "testticket";
    try {
      const config = makeConfig({
        triggers: [
          {
            name: "p4-main",
            kind: "p4",
            port: "perforce:1666",
            user_env: "P4USER",
            ticket_env: "P4TICKET",
            depot_path: "//depot/main",
            workspace: "aicr-p4-ws",
            watch_path: ["src/", "include/"],
            include_cr_file: ["**/*.cpp", "**/*.h"],
            exclude_cr_file: ["**/*.gen.cpp"],
          },
        ],
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "p4-workspace": {
              source_repo: { trigger: "p4-main", repo: "//depot/main" },
            },
          },
        },
      } as Partial<AppConfig>);

      const result = resolveP4TriggerConfig(config);
      expect(result).toBeDefined();
      expect(result!.triggerName).toBe("p4-main");
      expect(result!.workspaceId).toBe("p4-workspace");
      expect(result!.port).toBe("perforce:1666");
      expect(result!.user).toBe("testuser");
      expect(result!.password).toBe("testticket");
      expect(result!.depot).toBe("//depot/main");
      expect(result!.workspace).toBe("aicr-p4-ws");
      expect(result!.watchPath).toEqual(["src/", "include/"]);
      expect(result!.includeCrFile).toEqual(["**/*.cpp", "**/*.h"]);
      expect(result!.excludeCrFile).toEqual(["**/*.gen.cpp"]);
    } finally {
      delete process.env.P4USER;
      delete process.env.P4TICKET;
    }
  });

  it("resolves p4 trigger by name", () => {
    const config = makeConfig({
      triggers: [
        { name: "p4-first", kind: "p4", depot_path: "//depot/first" },
        { name: "p4-second", kind: "p4", depot_path: "//depot/second" },
      ],
      workspaces: {
        cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
        defaults: {},
        instances: {},
      },
    } as Partial<AppConfig>);

    const result = resolveP4TriggerConfig(config, "p4-second");
    expect(result).toBeDefined();
    expect(result!.triggerName).toBe("p4-second");
  });

  it("creates P4 VCS adapter when p4 trigger exists", () => {
    process.env.P4USER = "testuser";
    try {
      const config = makeConfig({
        triggers: [
          {
            name: "p4-main",
            kind: "p4",
            port: "perforce:1666",
            user_env: "P4USER",
            depot_path: "//depot/main",
          },
        ],
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {},
        },
      } as Partial<AppConfig>);

      const adapter = createVcsAdapterFromConfig(config, "/tmp/test");
      expect(adapter.kind).toBe("p4");
    } finally {
      delete process.env.P4USER;
    }
  });

  it("creates Git VCS adapter when no p4 trigger", () => {
    const config = makeConfig();
    const adapter = createVcsAdapterFromConfig(config, "/tmp/test");
    expect(adapter.kind).toBe("git");
  });

  it("creates Git VCS adapter for a Gitea trigger when P4 is also configured", () => {
    const config = makeConfig({
      triggers: [
        { name: "gitea-main", kind: "gitea", base_url: "https://git.example.com" },
        { name: "p4-main", kind: "p4", depot_path: "//depot/main" },
      ],
      workspaces: {
        cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
        defaults: {},
        instances: {},
      },
    } as Partial<AppConfig>);

    const adapter = createVcsAdapterFromConfig(config, "/tmp/test", "gitea-main");
    expect(adapter.kind).toBe("git");
  });

  it("creates SVN VCS adapter for an SVN trigger when P4 is also configured", () => {
    const config = makeConfig({
      triggers: [
        { name: "p4-main", kind: "p4", depot_path: "//depot/main" },
        {
          name: "svn-main",
          kind: "svn",
          repository_url: "https://svn.example.com/repos/project/trunk",
          watch_path: ["src/"],
          include_cr_file: ["**/*.ts"],
        },
      ],
      workspaces: {
        cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
        defaults: {},
        instances: {},
      },
    } as Partial<AppConfig>);

    const adapter = createVcsAdapterFromConfig(
      config,
      "/tmp/test",
      "svn-main",
      "https://svn.example.com/repos/project/trunk",
    );
    expect(adapter.kind).toBe("svn");
  });

  it("bootstrapServerApp initializes store and observability when admin auth env vars are set", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-obs-"));
    process.env.AICR_ADMIN_USERNAME = "admin";
    process.env.AICR_ADMIN_PASSWORD = "secret";
    let result: Awaited<ReturnType<typeof bootstrapServerApp>> | undefined;
    try {
      const config = makeConfig({
        admin: {
          username_env: "AICR_ADMIN_USERNAME",
          password_env: "AICR_ADMIN_PASSWORD",
        },
        storage: {
          database: { kind: "sqlite" as const, sqlite: { path: join(tmpDir, "obs.db") } },
          cache: { kind: "memory" as const },
          object: { kind: "filesystem" as const },
          retention: { deleted_project_grace_days: 7 },
        },
      } as Partial<AppConfig>);

      result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test",
        baseDir: tmpDir,
      });

      expect(result.store).toBeDefined();
      expect(result.observability).toBeDefined();
      expect(result.observability!.store).toBe(result.store);
    } finally {
      delete process.env.AICR_ADMIN_USERNAME;
      delete process.env.AICR_ADMIN_PASSWORD;
      if (result?.store) {
        closeStoreDb(result.store);
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("bootstrapServerApp initializes observability from default admin env names", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-default-admin-"));
    process.env.AICR_ADMIN_USERNAME = "admin";
    process.env.AICR_ADMIN_PASSWORD = "secret";
    let result: Awaited<ReturnType<typeof bootstrapServerApp>> | undefined;
    try {
      const config = makeConfig({
        admin: {
          username_env: "AICR_ADMIN_USERNAME",
          password_env: "AICR_ADMIN_PASSWORD",
          session_ttl_seconds: 86400,
        },
        storage: {
          database: { kind: "sqlite" as const, sqlite: { path: join(tmpDir, "obs.db") } },
          cache: { kind: "memory" as const },
          object: { kind: "filesystem" as const },
          retention: { deleted_project_grace_days: 30 },
        },
      } as Partial<AppConfig>);

      result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test",
        baseDir: tmpDir,
      });

      expect(result.store).toBeDefined();
      expect(result.observability?.adminAuth.username).toBe("admin");
    } finally {
      delete process.env.AICR_ADMIN_USERNAME;
      delete process.env.AICR_ADMIN_PASSWORD;
      if (result?.store) {
        closeStoreDb(result.store);
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("bootstrapServerApp rejects non-sqlite observability store backends until implemented", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-postgres-"));
    process.env.AICR_ADMIN_USERNAME = "admin";
    process.env.AICR_ADMIN_PASSWORD = "secret";
    try {
      const config = makeConfig({
        admin: {
          username_env: "AICR_ADMIN_USERNAME",
          password_env: "AICR_ADMIN_PASSWORD",
          session_ttl_seconds: 86400,
        },
        storage: {
          database: { kind: "postgres" as const, sqlite: { path: join(tmpDir, "obs.db") }, postgres: { url_env: "DATABASE_URL" } },
          cache: { kind: "memory" as const },
          object: { kind: "filesystem" as const },
          retention: { deleted_project_grace_days: 30 },
        },
      } as Partial<AppConfig>);

      await expect(bootstrapServerApp({ config, baseSystemPrompt: "test", baseDir: tmpDir })).rejects.toThrow(
        "currently supports sqlite only",
      );
    } finally {
      delete process.env.AICR_ADMIN_USERNAME;
      delete process.env.AICR_ADMIN_PASSWORD;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("bootstrapServerApp hides projects removed from workspace config", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-project-cleanup-"));
    const dbPath = join(tmpDir, "obs.db");
    process.env.AICR_ADMIN_USERNAME = "admin";
    process.env.AICR_ADMIN_PASSWORD = "secret";
    let result: Awaited<ReturnType<typeof bootstrapServerApp>> | undefined;
    const seedStore = createStoreDb(dbPath);
    try {
      insertReviewRun(seedStore, {
        id: "run-active",
        eventId: "evt-active",
        workspaceId: "active-workspace",
        triggerName: "gitea-active",
        repoRef: "owner/active",
        provider: null,
        providerModel: null,
        status: "succeeded",
        startedAt: new Date(),
      });
      insertReviewRun(seedStore, {
        id: "run-removed",
        eventId: "evt-removed",
        workspaceId: "removed-workspace",
        triggerName: "gitea-removed",
        repoRef: "owner/removed",
        provider: null,
        providerModel: null,
        status: "succeeded",
        startedAt: new Date(),
      });
      closeStoreDb(seedStore);

      const config = makeConfig({
        admin: {
          username_env: "AICR_ADMIN_USERNAME",
          password_env: "AICR_ADMIN_PASSWORD",
          session_ttl_seconds: 86400,
        },
        storage: {
          database: { kind: "sqlite" as const, sqlite: { path: dbPath } },
          cache: { kind: "memory" as const },
          object: { kind: "filesystem" as const },
          retention: { deleted_project_grace_days: 30 },
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "active-workspace": {
              source_repo: { trigger: "gitea-active", repo: "owner/active" },
            },
          },
        },
      } as Partial<AppConfig>);

      result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test",
        baseDir: tmpDir,
      });

      expect(getProjectStats(result.store!)).toMatchObject([
        { workspaceId: "active-workspace", repoRef: "owner/active" },
      ]);
    } finally {
      delete process.env.AICR_ADMIN_USERNAME;
      delete process.env.AICR_ADMIN_PASSWORD;
      if (seedStore.sqlite.open) {
        closeStoreDb(seedStore);
      }
      if (result?.store) {
        closeStoreDb(result.store);
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("bootstrapServerApp hides all projects when workspace config is empty", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-empty-project-cleanup-"));
    const dbPath = join(tmpDir, "obs.db");
    process.env.AICR_ADMIN_USERNAME = "admin";
    process.env.AICR_ADMIN_PASSWORD = "secret";
    let result: Awaited<ReturnType<typeof bootstrapServerApp>> | undefined;
    const seedStore = createStoreDb(dbPath);
    try {
      insertReviewRun(seedStore, {
        id: "run-removed-a",
        eventId: "evt-removed-a",
        workspaceId: "removed-workspace-a",
        triggerName: "gitea-removed-a",
        repoRef: "owner/removed-a",
        provider: null,
        providerModel: null,
        status: "succeeded",
        startedAt: new Date(),
      });
      insertReviewRun(seedStore, {
        id: "run-removed-b",
        eventId: "evt-removed-b",
        workspaceId: "removed-workspace-b",
        triggerName: "gitea-removed-b",
        repoRef: "owner/removed-b",
        provider: null,
        providerModel: null,
        status: "succeeded",
        startedAt: new Date(),
      });
      closeStoreDb(seedStore);

      const config = makeConfig({
        admin: {
          username_env: "AICR_ADMIN_USERNAME",
          password_env: "AICR_ADMIN_PASSWORD",
          session_ttl_seconds: 86400,
        },
        storage: {
          database: { kind: "sqlite" as const, sqlite: { path: dbPath } },
          cache: { kind: "memory" as const },
          object: { kind: "filesystem" as const },
          retention: { deleted_project_grace_days: 30 },
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {},
        },
      } as Partial<AppConfig>);

      result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test",
        baseDir: tmpDir,
      });

      expect(getProjectStats(result.store!)).toEqual([]);
    } finally {
      delete process.env.AICR_ADMIN_USERNAME;
      delete process.env.AICR_ADMIN_PASSWORD;
      if (seedStore.sqlite.open) {
        closeStoreDb(seedStore);
      }
      if (result?.store) {
        closeStoreDb(result.store);
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("bootstrapServerApp does not initialize store when admin auth env vars are missing", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-no-obs-"));
    delete process.env.AICR_ADMIN_USERNAME;
    delete process.env.AICR_ADMIN_PASSWORD;
    try {
      const config = makeConfig();

      const result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test",
        baseDir: tmpDir,
      });

      expect(result.store).toBeUndefined();
      expect(result.observability).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("initializes store when model_catalog sqlite backend is enabled even without admin auth", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-catalog-"));
    delete process.env.AICR_ADMIN_USERNAME;
    delete process.env.AICR_ADMIN_PASSWORD;
    try {
      const dbPath = join(tmpDir, "aicr.sqlite");
      const config = makeConfig({
        storage: {
          database: { kind: "sqlite", sqlite: { path: dbPath } },
          cache: { kind: "memory" },
          object: { kind: "filesystem", filesystem: { root: join(tmpDir, "objects") } },
          retention: { deleted_project_grace_days: 30 },
        } as Partial<AppConfig>,
        llm: {
          providers: [
            { id: "openai-prod", kind: "openai_compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY", catalog_provider: "openai" },
          ],
          fallback_chain: [{ provider: "openai-prod", model: "gpt-4o", role: "heavy" }],
          model_catalog: {
            enabled: true,
            source_url: "https://models.dev/api.json",
            refresh_interval_hours: 24,
            fetch_timeout_ms: 10000,
            offline: true,
            apply_to_model_spec: true,
            cache: { backend: "sqlite" },
            overrides: {},
          },
        } as Partial<AppConfig>,
      });

      const result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test",
        baseDir: tmpDir,
      });

      expect(result.store).toBeDefined();
      expect(result.observability).toBeUndefined();
      if (result.store) {
        closeStoreDb(result.store);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not initialize store when model_catalog uses memory backend", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-catalog-mem-"));
    delete process.env.AICR_ADMIN_USERNAME;
    delete process.env.AICR_ADMIN_PASSWORD;
    try {
      const config = makeConfig({
        llm: {
          providers: [
            { id: "openai-prod", kind: "openai_compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" },
          ],
          fallback_chain: [{ provider: "openai-prod", model: "gpt-4o", role: "heavy" }],
          model_catalog: {
            enabled: true,
            source_url: "https://models.dev/api.json",
            refresh_interval_hours: 24,
            fetch_timeout_ms: 10000,
            offline: true,
            apply_to_model_spec: true,
            cache: { backend: "memory" },
            overrides: {},
          },
        } as Partial<AppConfig>,
      });

      const result = await bootstrapServerApp({
        config,
        baseSystemPrompt: "test",
        baseDir: tmpDir,
      });

      expect(result.store).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects redis model_catalog backend at bootstrap with an explicit error", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "aicr-bootstrap-catalog-redis-"));
    delete process.env.AICR_ADMIN_USERNAME;
    delete process.env.AICR_ADMIN_PASSWORD;
    try {
      const config = makeConfig({
        storage: {
          database: { kind: "sqlite", sqlite: { path: join(tmpDir, "aicr.sqlite") } },
          cache: { kind: "redis", redis: { url_env: "REDIS_URL" } },
          object: { kind: "filesystem", filesystem: { root: join(tmpDir, "objects") } },
          retention: { deleted_project_grace_days: 30 },
        } as Partial<AppConfig>,
        llm: {
          providers: [
            { id: "openai-prod", kind: "openai_compatible", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" },
          ],
          fallback_chain: [{ provider: "openai-prod", model: "gpt-4o", role: "heavy" }],
          model_catalog: {
            enabled: true,
            source_url: "https://models.dev/api.json",
            refresh_interval_hours: 24,
            fetch_timeout_ms: 10000,
            offline: true,
            apply_to_model_spec: true,
            cache: { backend: "redis" },
            overrides: {},
          },
        } as Partial<AppConfig>,
      });

      await expect(
        bootstrapServerApp({ config, baseSystemPrompt: "test", baseDir: tmpDir }),
      ).rejects.toThrow(/redis.*not yet implemented/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
