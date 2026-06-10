import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appConfigSchema,
  loadConfigFile,
  loadWorkspaceConfigFile,
  mergeConfigLayers,
  resolveWorkspaceConfig,
  workspaceConfigFileSchema,
  workspaceRootKeys,
} from "../src/config.js";

describe("mergeConfigLayers", () => {
  it("deep merges defaults, system config, and workspace overrides", () => {
    const merged = mergeConfigLayers(
      {
        agent: {
          default: "kilo",
          sandbox: {
            kind: "docker",
            engine: "auto",
          },
        },
        workspaces: {
          cache: {
            max_total_gb: 50,
            eviction: "lru",
            ttl_days: 30,
          },
          defaults: {
            review: {
              commit_strategy: "aggregate",
            },
          },
          instances: {},
        },
      },
      {
        agent: {
          timeout_seconds: 900,
        },
        outputs: {
          template_engine: "handlebars",
        },
      },
      {
        workspaces: {
          instances: {
            "gitea-internal-owent-example": {
              agent: {
                default: "claude-code",
              },
              review: {
                exclude: ["docs/**"],
              },
            },
          },
        },
      },
    );

    expect(merged.agent.default).toBe("kilo");
    expect(merged.agent.timeout_seconds).toBe(900);
    expect(merged.workspaces.instances["gitea-internal-owent-example"]?.agent?.default).toBe(
      "claude-code",
    );
    expect(merged.workspaces.cache.max_total_gb).toBe(50);
    expect(merged.outputs.template_engine).toBe("handlebars");
  });

  it("rejects deprecated workspace keys at the top level", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        cache: {
          max_total_gb: 50,
          eviction: "lru",
          ttl_days: 30,
        },
        legacyWorkspace: {},
      },
    });

    expect(result.success).toBe(false);
  });

  it.each(workspaceRootKeys)(
    "rejects reserved workspace_id %s under workspaces.instances (Plan §3.10 D14)",
    (reservedId) => {
      const result = appConfigSchema.safeParse({
        workspaces: {
          instances: {
            [reservedId]: {},
          },
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes("instances"))).toBe(true);
      }
    },
  );

  it("applies built-in defaults when given an empty config", () => {
    const merged = mergeConfigLayers({});

    expect(merged.agent.default).toBe("kilo");
    expect(merged.agent.timeout_seconds).toBe(600);
    expect(merged.agent.auto_approve).toBe(true);
    expect(merged.agent.sandbox.kind).toBe("docker");
    expect(merged.agent.sandbox.engine).toBe("auto");
    expect(merged.outputs.template_engine).toBe("handlebars");
    expect(merged.queue.kind).toBe("memory");
    expect(merged.workspaces.cache.max_total_gb).toBe(50);
    expect(merged.workspaces.cache.eviction).toBe("lru");
    expect(merged.workspaces.instances).toEqual({});
    expect(merged.review.incremental).toBe(true);
  });

  it("replaces arrays wholesale instead of concatenating during merge", () => {
    const merged = mergeConfigLayers(
      {
        triggers: [{ name: "gitea-internal", kind: "gitea" }],
      },
      {
        triggers: [{ name: "github-saas", kind: "github" }],
      },
    );

    expect(merged.triggers).toHaveLength(1);
    expect(merged.triggers[0]?.name).toBe("github-saas");
  });

  it("rejects an unknown sandbox kind in workspace overrides", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        instances: {
          example: {
            sandbox: { kind: "vm-magic" },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts the forgejo trigger kind alias for Gitea-compatible deployments", () => {
    const merged = mergeConfigLayers({
      triggers: [{ name: "forgejo-community", kind: "forgejo" }],
    });

    expect(merged.triggers[0]?.kind).toBe("forgejo");
  });

  it("loads an empty YAML file as the default config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-config-"));
    const filePath = join(tempDir, "config.yaml");

    try {
      await writeFile(filePath, "\n", "utf8");

      const loaded = await loadConfigFile(filePath);

      expect(loaded.agent.default).toBe("kilo");
      expect(loaded.outputs.template_engine).toBe("handlebars");
      expect(loaded.workspaces.instances).toEqual({});
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a YAML document whose root is not an object", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-config-"));
    const filePath = join(tempDir, "config.yaml");

    try {
      await writeFile(filePath, "- not-an-object\n", "utf8");

      await expect(loadConfigFile(filePath)).rejects.toThrow(
        "Config file root must be a YAML mapping/object.",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("merges multiple workspace instances independently", () => {
    const merged = mergeConfigLayers(
      {
        workspaces: {
          instances: {
            "ws-a": {
              agent: { default: "kilo" },
              review: { commit_strategy: "aggregate" as const },
            },
          },
        },
      },
      {
        workspaces: {
          instances: {
            "ws-b": {
              agent: { default: "claude-code" },
              sandbox: { kind: "docker" as const },
            },
          },
        },
      },
    );

    expect(merged.workspaces.instances["ws-a"]?.agent?.default).toBe("kilo");
    expect(merged.workspaces.instances["ws-b"]?.agent?.default).toBe("claude-code");
    expect(merged.workspaces.instances["ws-b"]?.sandbox?.kind).toBe("docker");
  });

  it("accepts all LLM provider kinds from Plan.md §3.7.3", () => {
    const providerKinds = [
      "openai_compatible",
      "azure_openai",
      "anthropic",
      "vertex_ai",
      "bedrock",
      "google_ai_studio",
      "ollama",
      "copilot",
    ];

    for (const kind of providerKinds) {
      const result = appConfigSchema.safeParse({
        llm: {
          providers: [{ id: `test-${kind}`, kind }],
        },
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an LLM provider with an unknown kind", () => {
    const result = appConfigSchema.safeParse({
      llm: {
        providers: [{ id: "bad", kind: "unknown_provider" }],
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts all queue kinds from Plan.md §3.10", () => {
    const queueKinds = ["memory", "sqlite", "redis", "rabbitmq"];

    for (const kind of queueKinds) {
      const result = appConfigSchema.safeParse({ queue: { kind } });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown queue kind", () => {
    const result = appConfigSchema.safeParse({ queue: { kind: "kafka" } });
    expect(result.success).toBe(false);
  });

  it("accepts all output template engine options", () => {
    for (const engine of ["handlebars", "eta"]) {
      const result = appConfigSchema.safeParse({
        outputs: { template_engine: engine },
      });
      expect(result.success).toBe(true);
    }
  });

  it("deep merges nested objects across layers", () => {
    const merged = mergeConfigLayers(
      {
        agent: {
          default: "kilo",
          timeout_seconds: 600,
          sandbox: { kind: "docker" as const, engine: "auto" as const },
        },
      },
      {
        agent: {
          timeout_seconds: 900,
        },
      },
    );

    expect(merged.agent.default).toBe("kilo");
    expect(merged.agent.timeout_seconds).toBe(900);
    expect(merged.agent.sandbox.kind).toBe("docker");
  });

  it("rejects non-positive timeout_seconds", () => {
    const result = appConfigSchema.safeParse({
      agent: { timeout_seconds: 0 },
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-positive max_total_gb", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        cache: { max_total_gb: -1 },
      },
    });

    expect(result.success).toBe(false);
  });

  it("handles mergeValue with undefined override values", () => {
    const merged = mergeConfigLayers(
      { agent: { default: "kilo" } },
      { agent: { default: undefined } },
    );

    expect(merged.agent.default).toBe("kilo");
  });

  it("replaces arrays wholesale when override has a different array", () => {
    const merged = mergeConfigLayers(
      { llm: { providers: [{ id: "a", kind: "openai_compatible" }] } },
      { llm: { providers: [{ id: "b", kind: "anthropic" }] } },
    );

    expect(merged.llm.providers).toHaveLength(1);
    expect(merged.llm.providers[0]!.id).toBe("b");
  });

  it("preserves primitive values when override is a primitive", () => {
    const merged = mergeConfigLayers(
      { review: { incremental: true } },
      { review: { incremental: false } },
    );

    expect(merged.review.incremental).toBe(false);
  });

  it("loads a full YAML config file with all sections", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-config-full-"));
    const filePath = join(tempDir, "config.yaml");

    try {
      await writeFile(
        filePath,
        [
          "llm:",
          "  providers:",
          "    - { id: test-openai, kind: openai_compatible, base_url: https://api.openai.com/v1 }",
          "triggers:",
          "  - { name: gitea-test, kind: gitea }",
          "outputs:",
          "  template_engine: handlebars",
          "  channels:",
          "    - { name: gitea-pr, kind: gitea_pr_review }",
          "queue:",
          "  kind: memory",
          "agent:",
          "  default: kilo",
          "  timeout_seconds: 300",
          "  auto_approve: true",
          "review:",
          "  incremental: true",
          "  skip_lgtm: true",
        ].join("\n"),
        "utf8",
      );

      const loaded = await loadConfigFile(filePath);

      expect(loaded.llm.providers).toHaveLength(1);
      expect(loaded.llm.providers[0]!.id).toBe("test-openai");
      expect(loaded.triggers).toHaveLength(1);
      expect(loaded.agent.timeout_seconds).toBe(300);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a YAML document with non-object root (list)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-config-null-"));
    const filePath = join(tempDir, "config.yaml");

    try {
      await writeFile(filePath, "- not-an-object\n", "utf8");
      await expect(loadConfigFile(filePath)).rejects.toThrow(
        "Config file root must be a YAML mapping/object.",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts an empty YAML file (null root) as default config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-config-empty-"));
    const filePath = join(tempDir, "config.yaml");

    try {
      await writeFile(filePath, "\n", "utf8");
      const loaded = await loadConfigFile(filePath);
      expect(loaded.agent.default).toBe("kilo");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts all sandbox kinds from Plan.md §3.8", () => {
    const sandboxKinds = ["native", "docker", "podman", "docker_socket", "k8s_pod"] as const;

    for (const kind of sandboxKinds) {
      const result = appConfigSchema.safeParse({
        agent: { sandbox: { kind } },
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all sandbox engine options from Plan.md §3.8", () => {
    const engines = ["auto", "docker", "podman"] as const;

    for (const engine of engines) {
      const result = appConfigSchema.safeParse({
        agent: { sandbox: { engine } },
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts workspace instances with optional fields omitted", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        instances: {
          "minimal-workspace": {},
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts workspace instances with source_repo", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        instances: {
          "my-workspace": {
            source_repo: { trigger: "gitea-internal", repo: "owent/example" },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts workspace instances with outputs routing", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        instances: {
          "my-workspace": {
            outputs: {
              line_comments: ["gitea-pr-internal"],
              summary: ["feishu-team-a"],
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts all trigger kinds from Plan.md §3.1", () => {
    const triggerKinds = [
      "gitea",
      "forgejo",
      "github",
      "gitlab",
      "p4",
      "svn",
      "scheduled",
      "manual",
    ];

    for (const kind of triggerKinds) {
      const result = appConfigSchema.safeParse({
        triggers: [{ name: `test-${kind}`, kind }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects workspace instances with unknown fields", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        instances: {
          "my-workspace": {
            unknown_field: true,
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts LLM fallback chain entries with valid roles", () => {
    const result = appConfigSchema.safeParse({
      llm: {
        providers: [{ id: "openai-prod", kind: "openai_compatible" }],
        fallback_chain: [
          { provider: "openai-prod", model: "gpt-4o-mini", role: "light" },
          { provider: "openai-prod", model: "gpt-4o", role: "heavy" },
          { provider: "ollama-local", model: "qwen2.5:14b", role: "any" },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects LLM fallback chain entries with invalid roles", () => {
    const result = appConfigSchema.safeParse({
      llm: {
        providers: [{ id: "openai-prod", kind: "openai_compatible" }],
        fallback_chain: [
          { provider: "openai-prod", model: "gpt-4o", role: "super" },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts LLM retry configuration from Plan §3.5", () => {
    const result = appConfigSchema.safeParse({
      llm: {
        providers: [{ id: "openai-prod", kind: "openai_compatible" }],
        retry: {
          max_attempts: 5,
          respect_retry_after: true,
          backoff: {
            kind: "exponential",
            base_ms: 1000,
            max_ms: 60000,
            jitter: true,
          },
          give_up_after_seconds: 300,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts LLM budget configuration from Plan §3.5", () => {
    const result = appConfigSchema.safeParse({
      llm: {
        providers: [{ id: "openai-prod", kind: "openai_compatible" }],
        budget: {
          per_run_usd: 0.50,
          per_repo_daily_usd: 20,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts review configuration with all §3.10 fields", () => {
    const result = appConfigSchema.safeParse({
      review: {
        languages_auto_detect: true,
        include: ["**/*"],
        exclude: ["**/vendor/**"],
        max_files: 50,
        max_patch_bytes: 200000,
        incremental: true,
        skip_lgtm: true,
        output_language: "zh-CN",
        commit_strategy: "aggregate",
        git: { allow_deepen: true },
        labels: {
          ignore: ["aicr:ignore", "aicr-ignore"],
          auto_tag: "aicr",
          reviewed_tag: "aicr:reviewed",
        },
        problem_issue: {
          max_recent_issues: 20,
        },
        fetch_extra: {
          max_bytes: 524288,
          max_files: 5,
          allow_paths: ["**/*"],
        },
        reflection: { enabled: true, mode: "light" },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts bounded managed problem issue fetch limits with workspace overrides", () => {
    const merged = mergeConfigLayers({
      review: {
        problem_issue: { max_recent_issues: 25 },
      },
      workspaces: {
        defaults: {
          review: {
            problem_issue: { max_recent_issues: 30 },
          },
        },
        instances: {
          "my-workspace": {
            review: {
              problem_issue: { max_recent_issues: 7 },
            },
          },
          "defaulted-workspace": {},
        },
      },
    });

    expect(merged.review.problem_issue?.max_recent_issues).toBe(25);
    expect(resolveWorkspaceConfig(merged, "my-workspace").review?.problem_issue?.max_recent_issues).toBe(7);
    expect(resolveWorkspaceConfig(merged, "defaulted-workspace").review?.problem_issue?.max_recent_issues).toBe(30);
  });

  it("rejects managed problem issue fetch limits outside the supported API page size", () => {
    expect(appConfigSchema.safeParse({ review: { problem_issue: { max_recent_issues: 0 } } }).success).toBe(false);
    expect(appConfigSchema.safeParse({ review: { problem_issue: { max_recent_issues: 101 } } }).success).toBe(false);
  });

  it("accepts review reflection modes from Plan §3.12", () => {
    for (const mode of ["off", "light", "thorough"]) {
      const result = appConfigSchema.safeParse({
        review: { reflection: { enabled: true, mode } },
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an invalid review reflection mode", () => {
    const result = appConfigSchema.safeParse({
      review: { reflection: { enabled: true, mode: "deep" } },
    });

    expect(result.success).toBe(false);
  });

  it("accepts review labels configuration with ignore/auto_tag/reviewed_tag", () => {
    const result = appConfigSchema.safeParse({
      review: {
        labels: {
          ignore: ["aicr:ignore", "aicr-ignore"],
          auto_tag: "aicr",
          reviewed_tag: "aicr:reviewed",
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts workspace-level review labels overrides", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        defaults: {
          review: {
            labels: {
              ignore: ["aicr:ignore"],
              auto_tag: "aicr",
              reviewed_tag: "aicr:reviewed",
            },
          },
        },
        instances: {
          "my-workspace": {
            review: {
              labels: {
                ignore: ["custom-ignore"],
                auto_tag: "my-auto-tag",
                reviewed_tag: "my-reviewed-tag",
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts output channel configuration with trigger reference", () => {
    const result = appConfigSchema.safeParse({
      outputs: {
        channels: [
          { name: "gitea-pr-internal", kind: "gitea_pr_review", trigger: "gitea-internal", mention_author: true },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts no_problems policies across global, channel, and workspace layers", () => {
    const result = appConfigSchema.safeParse({
      outputs: {
        no_problems: { action: "suppress" },
        channels: [
          {
            name: "feishu-team",
            kind: "feishu_bot",
            no_problems: { action: "publish" },
          },
        ],
      },
      workspaces: {
        defaults: {
          outputs: {
            no_problems: { action: "suppress" },
            channel_overrides: {
              "feishu-team": { no_problems: { action: "publish" } },
            },
          },
        },
        instances: {
          "my-workspace": {
            outputs: {
              summary: ["feishu-team"],
              no_problems: { action: "publish" },
              channel_overrides: {
                "feishu-team": { no_problems: { action: "suppress" } },
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects removed no_findings aliases", () => {
    const result = appConfigSchema.safeParse({
      outputs: {
        no_findings: { action: "publish" },
        channels: [
          { name: "legacy", kind: "feishu_bot", no_findings: { action: "suppress" } },
        ],
      },
      workspaces: {
        instances: {
          "legacy-workspace": {
            outputs: {
              no_findings: { action: "publish" },
              channel_overrides: {
                legacy: { no_findings: { action: "suppress" } },
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects removed gitea_finding_issue channel kind", () => {
    const result = appConfigSchema.safeParse({
      outputs: {
        channels: [
          { name: "legacy-managed", kind: "gitea_finding_issue" },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid no_problems actions", () => {
    const result = appConfigSchema.safeParse({
      outputs: {
        no_problems: { action: "skip" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts publish_if_summary as a no_problems action", () => {
    const result = appConfigSchema.safeParse({
      outputs: {
        channels: [
          {
            name: "feishu-team",
            kind: "feishu_bot",
            no_problems: { action: "publish_if_summary" },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts trigger and channel URL templates for non-PR targets", () => {
    const result = appConfigSchema.safeParse({
      triggers: [
        {
          name: "p4-main",
          kind: "p4",
          change_url_template: "https://swarm.example.com/changes/{{revision}}",
        },
      ],
      outputs: {
        channels: [
          {
            name: "feishu-team",
            kind: "feishu_bot",
            revision_url_template: "https://review.example.com/revisions/{{revision}}",
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts output channel with mention_fallback from Plan §3.9.2", () => {
    for (const fallback of ["all", "skip"]) {
      const result = appConfigSchema.safeParse({
        outputs: {
          channels: [
            { name: "feishu-team", kind: "feishu_bot", mention_fallback: fallback },
          ],
        },
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts output author resolution mappings and email blacklist", () => {
    const result = appConfigSchema.safeParse({
      outputs: {
        author_resolution: {
          email_mappings: {
            "dev@example.com": "ou_dev",
          },
          email_blacklist: ["bot@example.com"],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts output routes configuration from Plan §3.10", () => {
    const result = appConfigSchema.safeParse({
      outputs: {
        channels: [
          { name: "gitea-pr-internal", kind: "gitea_pr_review" },
        ],
        routes: {
          default: {
            line_comments: ["gitea-pr-internal"],
            summary: ["gitea-pr-internal"],
          },
          rules: [
            {
              match: { trigger: "gitea-internal", target_kind: "pull_request" },
              line_comments: ["gitea-pr-internal"],
              summary: ["gitea-pr-internal"],
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("normalizes the Plan §3.10 output route target_kind alias pr to pull_request", () => {
    const merged = mergeConfigLayers({
      outputs: {
        channels: [
          { name: "gitea-pr-internal", kind: "gitea_pr_review" },
        ],
        routes: {
          rules: [
            {
              match: { trigger: "gitea-internal", target_kind: "pr" },
              line_comments: ["gitea-pr-internal"],
            },
          ],
        },
      },
    });

    expect(merged.outputs.routes?.rules[0]?.match?.target_kind).toBe("pull_request");
  });

  it("accepts LLM retry with linear backoff", () => {
    const result = appConfigSchema.safeParse({
      llm: {
        providers: [{ id: "test", kind: "openai_compatible" }],
        retry: {
          backoff: {
            kind: "linear",
            base_ms: 2000,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts LLM retry with constant backoff", () => {
    const result = appConfigSchema.safeParse({
      llm: {
        providers: [{ id: "test", kind: "openai_compatible" }],
        retry: {
          backoff: {
            kind: "constant",
            base_ms: 3000,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("defaults review fields match Plan §3.10 baseline", () => {
    const merged = mergeConfigLayers({});
    expect(merged.review.languages_auto_detect).toBe(true);
    expect(merged.review.include).toEqual(["**/*"]);
    expect(merged.review.exclude).toEqual(["**/vendor/**", "**/*.min.js", "**/*.lock"]);
    expect(merged.review.max_files).toBe(50);
    expect(merged.review.max_patch_bytes).toBe(200000);
    expect(merged.review.output_language).toBe("zh-CN");
    expect(merged.review.commit_strategy).toBe("aggregate");
  });

  it("accepts compression configuration from Plan §3.3", () => {
    const result = appConfigSchema.safeParse({
      compression: {
        trigger_tokens: 131072,
        max_input_ratio: 0.6,
        summarize_model_role: "light",
        keep_hunks_top_k: 30,
        context_lines: 5,
        per_model_overrides: {
          "anthropic:claude-sonnet-4.6": { trigger_tokens: 393216 },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects compression max_input_ratio outside [0,1]", () => {
    const result = appConfigSchema.safeParse({
      compression: { max_input_ratio: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts queue workers, rate_limit, retry, and dead_letter from Plan §3.10", () => {
    const result = appConfigSchema.safeParse({
      queue: {
        kind: "redis",
        workers: {
          concurrency: 4,
          per_workspace_concurrency: 1,
          lock_ttl_seconds: 1800,
        },
        rate_limit: {
          per_provider_rps: { "gitea-internal": 5, "github-saas": 3 },
        },
        retry: {
          attempts: 3,
          backoff: {
            kind: "exponential",
            base_ms: 2000,
            max_ms: 60000,
            jitter: true,
          },
        },
        dead_letter: {
          enabled: true,
          max_age_hours: 72,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts review reflection memory configuration from Plan §3.12", () => {
    const result = appConfigSchema.safeParse({
      review: {
        reflection: {
          enabled: true,
          mode: "light",
          memory: {
            max_size_kb: 64,
            max_entries: 20,
            retention_days: 180,
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts workspaces.defaults.agent configuration", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        defaults: {
          agent: { default: "claude-code" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts llm per_provider_overrides from Plan §3.5", () => {
    const result = appConfigSchema.safeParse({
      llm: {
        providers: [{ id: "openai-prod", kind: "openai_compatible" }],
        per_provider_overrides: {
          "openai-prod": { max_attempts: 3 },
          "anthropic-prod": { give_up_after_seconds: 180 },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields inside workspaces.defaults.agent", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        defaults: {
          agent: { unknown_field: true },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("deep merges compression settings across layers", () => {
    const merged = mergeConfigLayers(
      {
        compression: {
          trigger_tokens: 131072,
          max_input_ratio: 0.6,
        },
      },
      {
        compression: {
          context_lines: 10,
        },
      },
    );
    expect(merged.compression?.trigger_tokens).toBe(131072);
    expect(merged.compression?.max_input_ratio).toBe(0.6);
    expect(merged.compression?.context_lines).toBe(10);
  });

  it("deep merges queue settings across layers", () => {
    const merged = mergeConfigLayers(
      {
        queue: {
          kind: "redis",
          workers: { concurrency: 4 },
        },
      },
      {
        queue: {
          workers: { per_workspace_concurrency: 2 },
          retry: { attempts: 5 },
        },
      },
    );
    expect(merged.queue?.kind).toBe("redis");
    expect(merged.queue?.workers?.concurrency).toBe(4);
    expect(merged.queue?.workers?.per_workspace_concurrency).toBe(2);
    expect(merged.queue?.retry?.attempts).toBe(5);
  });

  it("resolves workspace defaults with instance overrides from Plan §3.10", () => {
    const merged = mergeConfigLayers({
      workspaces: {
        defaults: {
          sandbox: { kind: "docker", engine: "auto" },
          review: {
            commit_strategy: "aggregate",
            exclude: ["**/vendor/**"],
          },
          agent: { default: "kilo" },
          outputs: {
            no_problems: { action: "suppress" },
            channel_overrides: {
              "feishu-team": { no_problems: { action: "suppress" } },
            },
          },
        },
        instances: {
          "gitea-internal-owent-example": {
            source_repo: { trigger: "gitea-internal", repo: "owent/example" },
            agent: { default: "claude-code" },
            review: { exclude: ["docs/**"] },
            outputs: {
              channel_overrides: {
                "feishu-team": { no_problems: { action: "publish" } },
              },
            },
          },
        },
      },
    });

    const workspace = resolveWorkspaceConfig(merged, "gitea-internal-owent-example");

    expect(workspace.source_repo?.repo).toBe("owent/example");
    expect(workspace.agent?.default).toBe("claude-code");
    expect(workspace.sandbox?.kind).toBe("docker");
    expect(workspace.sandbox?.engine).toBe("auto");
    expect(workspace.review?.commit_strategy).toBe("aggregate");
    expect(workspace.review?.exclude).toEqual(["docs/**"]);
    expect(workspace.outputs?.no_problems?.action).toBe("suppress");
    expect(workspace.outputs?.channel_overrides?.["feishu-team"]?.no_problems?.action).toBe("publish");
  });

  it("throws a clear error when resolving an unknown workspace", () => {
    const merged = mergeConfigLayers({});

    expect(() => resolveWorkspaceConfig(merged, "missing")).toThrow(
      "Workspace missing is not configured.",
    );
  });

  it("accepts only workspace-level fields in a workspace config file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-workspace-config-"));
    const filePath = join(tempDir, "config.yaml");

    try {
      await writeFile(
        filePath,
        [
          "source_repo: { trigger: gitea-internal, repo: owent/example }",
          "agent: { default: claude-code }",
          "review: { exclude: [docs/**] }",
          "outputs:",
          "  summary: [feishu-team-a]",
        ].join("\n"),
        "utf8",
      );

      const loaded = await loadWorkspaceConfigFile(filePath);

      expect(loaded.source_repo?.repo).toBe("owent/example");
      expect(loaded.agent?.default).toBe("claude-code");
      expect(loaded.review?.exclude).toEqual(["docs/**"]);
      expect(loaded.outputs?.summary).toEqual(["feishu-team-a"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

it("rejects system-only fields in workspace config files per Plan §3.10", () => {
    for (const config of [
      { queue: { kind: "redis" } },
      { agent: { auto_approve: true } },
      { sandbox: { kind: "native" } },
    ]) {
      expect(workspaceConfigFileSchema.safeParse(config).success).toBe(false);
    }
  });

  it("accepts all commit_strategy values from Plan §3.10", () => {
    for (const strategy of ["per_commit", "aggregate", "head_only"]) {
      const result = appConfigSchema.safeParse({
        review: { commit_strategy: strategy },
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an invalid commit_strategy", () => {
    const result = appConfigSchema.safeParse({
      review: { commit_strategy: "per_file" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts review git.allow_deepen: false", () => {
    const result = appConfigSchema.safeParse({
      review: { git: { allow_deepen: false } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields in review git section", () => {
    const result = appConfigSchema.safeParse({
      review: { git: { unknown_field: true } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in review fetch_extra section", () => {
    const result = appConfigSchema.safeParse({
      review: { fetch_extra: { unknown_field: true } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts workspace config file with only source_repo", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-workspace-src-only-"));
    const filePath = join(tempDir, "config.yaml");

    try {
      await writeFile(filePath, "source_repo: { trigger: gitea-internal, repo: owent/example }\n", "utf8");
      const loaded = await loadWorkspaceConfigFile(filePath);
      expect(loaded.source_repo?.trigger).toBe("gitea-internal");
      expect(loaded.review).toBeUndefined();
      expect(loaded.outputs).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("workspace config file rejects unknown trigger kinds", () => {
    const result = workspaceConfigFileSchema.safeParse({
      triggers: [{ name: "test", kind: "bitbucket" }],
    });
    expect(result.success).toBe(false);
  });

  it("resolves workspace defaults merge with no instance overrides", () => {
    const merged = mergeConfigLayers({
      workspaces: {
        defaults: {
          sandbox: { kind: "docker", engine: "auto" },
          review: { commit_strategy: "aggregate" },
          agent: { default: "kilo" },
        },
        instances: {
          "bare-workspace": {},
        },
      },
    });

    const workspace = resolveWorkspaceConfig(merged, "bare-workspace");
    expect(workspace.sandbox?.kind).toBe("docker");
    expect(workspace.sandbox?.engine).toBe("auto");
    expect(workspace.review?.commit_strategy).toBe("aggregate");
    expect(workspace.agent?.default).toBe("kilo");
  });

  it("accepts workspace instances with sandbox override that upgrades isolation", () => {
    const result = appConfigSchema.safeParse({
      workspaces: {
        instances: {
          "contractor-workspace": {
            sandbox: { kind: "docker_socket", engine: "podman" },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("server config", () => {
  it("provides defaults for server config", () => {
    const result = appConfigSchema.parse({});
    expect(result.server.port).toBe(8080);
    expect(result.server.hostname).toBe("0.0.0.0");
    expect(result.server.trust_proxy).toBe(false);
    expect(result.server.base_url).toBeUndefined();
    expect(result.server.path_prefix).toBeUndefined();
  });

  it("accepts server config with trust_proxy true", () => {
    const result = appConfigSchema.parse({
      server: { trust_proxy: true },
    });
    expect(result.server.trust_proxy).toBe(true);
  });

  it("accepts server config with trust_proxy loopback", () => {
    const result = appConfigSchema.parse({
      server: { trust_proxy: "loopback" },
    });
    expect(result.server.trust_proxy).toBe("loopback");
  });

  it("accepts server config with trust_proxy CIDR array", () => {
    const result = appConfigSchema.parse({
      server: { trust_proxy: ["192.168.1.0/24", "10.0.0.0/8"] },
    });
    expect(result.server.trust_proxy).toEqual(["192.168.1.0/24", "10.0.0.0/8"]);
  });

  it("accepts server config with base_url and path_prefix", () => {
    const result = appConfigSchema.parse({
      server: {
        trust_proxy: "loopback",
        base_url: "https://aicr.example.com/aicr",
        path_prefix: "/aicr",
        port: 9090,
        hostname: "127.0.0.1",
      },
    });
    expect(result.server.base_url).toBe("https://aicr.example.com/aicr");
    expect(result.server.path_prefix).toBe("/aicr");
    expect(result.server.port).toBe(9090);
    expect(result.server.hostname).toBe("127.0.0.1");
  });

  it("merges server config across layers", () => {
    const merged = mergeConfigLayers(
      { server: { port: 8080, trust_proxy: false } },
      { server: { trust_proxy: "loopback" } },
    );
    expect(merged.server.port).toBe(8080);
    expect(merged.server.trust_proxy).toBe("loopback");
  });
});

describe("problem issue output config", () => {
  it("accepts configurable markers and resolved actions for Gitea managed issues", () => {
    const result = appConfigSchema.parse({
      outputs: {
        channels: [
          {
            name: "gitea-problem-issues",
            kind: "gitea_problem_issue",
            trigger: "gitea-internal",
            marker_prefix: "[AICR Managed]",
            marker_label: "aicr-managed",
            label_ids: [1, 2],
            resolved_action: "delete",
          },
        ],
      },
    });

    expect(result.outputs.channels[0]).toMatchObject({
      marker_prefix: "[AICR Managed]",
      marker_label: "aicr-managed",
      label_ids: [1, 2],
      resolved_action: "delete",
    });
  });

  it("accepts assignee, severity label, and Feishu notification fields", () => {
    const result = appConfigSchema.parse({
      outputs: {
        channels: [
          {
            name: "gitea-problem-issues",
            kind: "gitea_problem_issue",
            assign_committer: true,
            owners_file: "CODEOWNERS",
            add_owners_as_assignees: false,
            severity_label_prefix: "aicr:problem:",
            severity_label_colors: { high: "e11d48", critical: "b60205" },
            notify_feishu: {
              webhook_url_env: "FEISHU_NOTIFY_URL",
              secret_env: "FEISHU_NOTIFY_SECRET",
            },
          },
        ],
      },
    });

    const channel = result.outputs.channels[0]!;
    expect(channel.assign_committer).toBe(true);
    expect(channel.owners_file).toBe("CODEOWNERS");
    expect(channel.add_owners_as_assignees).toBe(false);
    expect(channel.severity_label_prefix).toBe("aicr:problem:");
    expect(channel.severity_label_colors).toEqual({ high: "e11d48", critical: "b60205" });
    expect(channel.notify_feishu).toEqual({
      webhook_url_env: "FEISHU_NOTIFY_URL",
      secret_env: "FEISHU_NOTIFY_SECRET",
    });
  });

  it("accepts review_mode and review_event for PR review channels", () => {
    const result = appConfigSchema.parse({
      outputs: {
        channels: [
          {
            name: "gitea-pr-review",
            kind: "gitea_pr_review",
            review_mode: "auto",
            review_event: "REQUEST_CHANGES",
          },
        ],
      },
    });

    const channel = result.outputs.channels[0]!;
    expect(channel.review_mode).toBe("auto");
    expect(channel.review_event).toBe("REQUEST_CHANGES");
  });

  it("accepts review_update_strategy for PR review channels", () => {
    const result = appConfigSchema.parse({
      outputs: {
        channels: [
          {
            name: "gitea-pr-review",
            kind: "gitea_pr_review",
            review_update_strategy: "update_existing",
          },
        ],
      },
    });

    const channel = result.outputs.channels[0]!;
    expect(channel.review_update_strategy).toBe("update_existing");
  });

  it("accepts string labels for GitHub managed problem issues", () => {
    const result = appConfigSchema.parse({
      outputs: {
        channels: [
          {
            name: "github-problem-issues",
            kind: "github_problem_issue",
            labels: ["bug", "aicr-managed"],
            resolved_action: "close",
          },
        ],
      },
    });

    expect(result.outputs.channels[0]).toMatchObject({
      labels: ["bug", "aicr-managed"],
      resolved_action: "close",
    });
  });

  it("accepts issue_mode for consolidated problem issue creation", () => {
    const result = appConfigSchema.parse({
      outputs: {
        channels: [
          {
            name: "gitea-problem-issues",
            kind: "gitea_problem_issue",
            issue_mode: "consolidated",
            resolved_action: "close",
          },
        ],
      },
    });

    expect(result.outputs.channels[0]).toMatchObject({
      issue_mode: "consolidated",
    });
  });
});

describe("triage config", () => {
  it("defaults triage to disabled", () => {
    const result = appConfigSchema.parse({});
    const instance = result.workspaces.instances["default"];
    expect(instance).toBeUndefined();
  });

  it("accepts workspace triage config with all fields", () => {
    const result = appConfigSchema.parse({
      workspaces: {
        instances: {
          myws: {
            source_repo: { trigger: "gitea", repo: "owner/repo" },
            triage: {
              enabled: true,
              actions: ["close"],
              categories_close: ["spam", "invalid", "duplicate"],
              events: ["issues"],
              dry_run: true,
              custom_prompt: "Custom triage rules",
            },
          },
        },
      },
    });
    const triage = result.workspaces.instances.myws!.triage!;
    expect(triage.enabled).toBe(true);
    expect(triage.actions).toEqual(["close"]);
    expect(triage.categories_close).toEqual(["spam", "invalid", "duplicate"]);
    expect(triage.events).toEqual(["issues"]);
    expect(triage.dry_run).toBe(true);
    expect(triage.custom_prompt).toBe("Custom triage rules");
  });

  it("provides default triage values", () => {
    const result = appConfigSchema.parse({
      workspaces: {
        instances: {
          myws: {
            source_repo: { trigger: "gitea", repo: "owner/repo" },
            triage: {
              enabled: true,
            },
          },
        },
      },
    });
    const triage = result.workspaces.instances.myws!.triage!;
    expect(triage.enabled).toBe(true);
    expect(triage.actions).toEqual(["close"]);
    expect(triage.categories_close).toEqual(["spam", "invalid"]);
    expect(triage.events).toEqual(["issues"]);
    expect(triage.dry_run).toBe(false);
  });

  it("merges triage config across layers", () => {
    const merged = mergeConfigLayers(
      {
        workspaces: {
          instances: {
            myws: {
              source_repo: { trigger: "gitea", repo: "owner/repo" },
              triage: { enabled: true, categories_close: ["spam"] },
            },
          },
        },
      },
      {
        workspaces: {
          instances: {
            myws: {
              triage: { dry_run: true },
            },
          },
        },
      },
    );
    const triage = merged.workspaces.instances.myws!.triage!;
    expect(triage.enabled).toBe(true);
    expect(triage.categories_close).toEqual(["spam"]);
    expect(triage.dry_run).toBe(true);
  });

  it("parses storage config with defaults", () => {
    const config = mergeConfigLayers({});
    expect(config.storage.database.kind).toBe("sqlite");
    expect(config.storage.database.sqlite.path).toBe("/app/data/aicr.sqlite");
    expect(config.storage.cache.kind).toBe("memory");
    expect(config.storage.object.kind).toBe("filesystem");
    expect(config.storage.object.filesystem.root).toBe("/app/data/objects");
    expect(config.storage.retention.deleted_project_grace_days).toBe(30);
  });

  it("parses storage config with overrides", () => {
    const config = mergeConfigLayers({
      storage: {
        database: {
          kind: "postgres",
          postgres: { url_env: "DATABASE_URL" },
        },
        cache: {
          kind: "redis",
          redis: { url_env: "REDIS_URL" },
          ttl_seconds: 300,
        },
        retention: { deleted_project_grace_days: 7 },
      },
    });
    expect(config.storage.database.kind).toBe("postgres");
    expect(config.storage.cache.kind).toBe("redis");
    expect(config.storage.retention.deleted_project_grace_days).toBe(7);
  });

  it("parses admin auth config", () => {
    const config = mergeConfigLayers({
      admin: {
        username_env: "AICR_ADMIN_USER",
        password_env: "AICR_ADMIN_PASS",
        password_hash_env: "AICR_ADMIN_PASS_HASH",
        session_ttl_seconds: 7200,
      },
    });
    expect(config.admin).toBeDefined();
    expect(config.admin!.username_env).toBe("AICR_ADMIN_USER");
    expect(config.admin!.password_env).toBe("AICR_ADMIN_PASS");
    expect(config.admin!.password_hash_env).toBe("AICR_ADMIN_PASS_HASH");
    expect(config.admin!.session_ttl_seconds).toBe(7200);
  });

  it("admin defaults to env-backed super-admin settings", () => {
    const config = mergeConfigLayers({});
    expect(config.admin).toMatchObject({
      username_env: "AICR_ADMIN_USERNAME",
      password_env: "AICR_ADMIN_PASSWORD",
      session_ttl_seconds: 86400,
    });
  });

  describe("workspace prompt override", () => {
    it("accepts prompt.base_system_prompt_file in workspace instance", () => {
      const result = appConfigSchema.safeParse({
        workspaces: {
          instances: {
            "my-repo": {
              prompt: {
                base_system_prompt_file: "prompts/system/custom-reviewer.system.md",
              },
            },
          },
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const ws = result.data.workspaces.instances["my-repo"]!;
      expect(ws.prompt?.base_system_prompt_file).toBe("prompts/system/custom-reviewer.system.md");
    });

    it("accepts prompt.force_skills in workspace instance", () => {
      const result = appConfigSchema.safeParse({
        workspaces: {
          instances: {
            "my-repo": {
              prompt: {
                force_skills: ["security-audit", "api-review"],
              },
            },
          },
        },
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const ws = result.data.workspaces.instances["my-repo"]!;
      expect(ws.prompt?.force_skills).toEqual(["security-audit", "api-review"]);
    });

    it("accepts prompt in workspaces.defaults", () => {
      const result = appConfigSchema.safeParse({
        workspaces: {
          defaults: {
            prompt: {
              base_system_prompt_file: "prompts/system/default.system.md",
              force_skills: ["repo-conventions"],
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("merges workspace defaults prompt into instance prompt", () => {
      const config = mergeConfigLayers(
        {
          workspaces: {
            defaults: {
              prompt: {
                base_system_prompt_file: "prompts/system/default.system.md",
                force_skills: ["repo-conventions"],
              },
            },
            instances: {
              "my-repo": {
                prompt: {
                  force_skills: ["security-audit"],
                },
              },
            },
          },
        },
      );
      const ws = resolveWorkspaceConfig(config, "my-repo");
      expect(ws.prompt?.base_system_prompt_file).toBe("prompts/system/default.system.md");
      expect(ws.prompt?.force_skills).toEqual(["security-audit"]);
    });

    it("rejects unknown fields in prompt schema", () => {
      const result = appConfigSchema.safeParse({
        workspaces: {
          instances: {
            "my-repo": {
              prompt: {
                unknown_field: true,
              },
            },
          },
        },
      });
      expect(result.success).toBe(false);
    });
  });
});
