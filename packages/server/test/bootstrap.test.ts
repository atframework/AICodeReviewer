import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@aicr/core";

import {
  resolveModelSpecFromConfig,
  resolveGiteaWebhookConfig,
  createOutputPublisherFromConfig,
  createOutputPublisherResolverFromConfig,
  createVcsAdapterFromConfig,
  bootstrapServerApp,
  buildSourceRootResolver,
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
    ...overrides,
  } as AppConfig;
}

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
            supports_vision: true,
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
    expect(model.supportsVision).toBe(true);
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
    expect(typeof result?.publishFinding).toBe("function");
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
            { name: "plan-gitea-pr", kind: "gitea_pr_review", trigger: "gitea-internal" },
          ],
        },
      } as Partial<AppConfig>);
      const publisher = createOutputPublisherFromConfig(config, "plan-gitea-pr", 42, "test-workspace");

      expect(publisher).toBeDefined();
      const result = await publisher?.publishFinding({
        file: "src/app.ts",
        line: 7,
        severity: "high",
        category: "correctness",
        message: "Issue.",
      });

      expect(result?.externalId).toBe("321");
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
          channels: [{ name: "github-pr", kind: "github_pr_review", trigger: "github-saas" }],
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

      expect(publisher).toBeDefined();
      const result = await publisher?.publishFinding({
        file: "src/app.ts",
        line: 7,
        severity: "high",
        category: "correctness",
        message: "Issue.",
      });

      expect(result?.externalId).toBe("987");
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

      expect(publisher).toBeDefined();
      await publisher?.publishFinding({
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
            { name: "gitea-pr", kind: "gitea_pr_review", trigger: "gitea-internal" },
          ],
        },
        workspaces: {
          cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
          defaults: {},
          instances: {
            "test-workspace": {
              source_repo: { trigger: "gitea-internal", repo: "owent/example" },
              outputs: { line_comments: ["gitea-pr"] },
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

      expect(publisher).toBeDefined();
      await publisher?.publishFinding({
        file: "src/app.ts",
        line: 3,
        severity: "medium",
        category: "correctness",
        message: "Issue.",
      });

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
});
