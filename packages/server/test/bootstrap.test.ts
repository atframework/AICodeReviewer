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
      sandbox: { kind: "docker", engine: "auto" },
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
  it("returns ServerAppOptions with orchestration", () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const config = makeConfig();
      const result = bootstrapServerApp({
        config,
        baseSystemPrompt: "test prompt",
      });

      expect(result.reviewOrchestration).toBeDefined();
      expect(result.reviewOrchestration?.baseSystemPrompt).toBe("test prompt");
      expect(result.reviewOrchestration?.model.providerId).toBe("openai-prod");
      expect(result.reviewOrchestration?.dryRun).toBe(false);
      expect(typeof result.reviewOrchestration?.outputPublisherResolver).toBe("function");
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it("includes gitea config when a gitea trigger is configured", () => {
    const originalKey = process.env.OPENAI_API_KEY;
    const originalSecret = process.env.GITEA_SECRET;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GITEA_SECRET = "test-secret";
    try {
      const config = makeConfig();
      const result = bootstrapServerApp({
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
