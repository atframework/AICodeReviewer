import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { reviewTargetKindSchema } from "./review-event.js";
import { isPlainObject } from "./utils.js";

export const workspaceRootKeys = ["cache", "defaults", "instances"] as const;

const reservedWorkspaceIds = new Set<string>(workspaceRootKeys);

const workspaceIdSchema = z
  .string()
  .min(1)
  .refine((value) => !reservedWorkspaceIds.has(value), {
    message:
      "workspace_id must not collide with reserved keys (cache, defaults, instances); see Plan.md §3.10 D14",
  });

const llmProviderSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "openai_compatible",
      "azure_openai",
      "anthropic",
      "vertex_ai",
      "bedrock",
      "google_ai_studio",
      "ollama",
      "copilot",
    ]),
    base_url: z.string().url().optional(),
    api_key_env: z.string().min(1).optional(),
    api_version: z.string().min(1).optional(),
  })
  .passthrough();

const llmFallbackEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    role: z.enum(["light", "heavy", "any"]),
  })
  .passthrough();

const llmRetrySchema = z
  .object({
    max_attempts: z.number().int().positive().optional(),
    respect_retry_after: z.boolean().optional(),
    backoff: z
      .object({
        kind: z.enum(["exponential", "linear", "constant"]),
        base_ms: z.number().positive().optional(),
        max_ms: z.number().positive().optional(),
        jitter: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    give_up_after_seconds: z.number().positive().optional(),
  })
  .passthrough()
  .optional();

const llmBudgetSchema = z
  .object({
    per_run_usd: z.number().nonnegative().optional(),
    per_repo_daily_usd: z.number().nonnegative().optional(),
  })
  .passthrough()
  .optional();

const llmPerProviderOverridesSchema = z
  .record(
    z.string().min(1),
    z
      .object({
        max_attempts: z.number().int().positive().optional(),
        give_up_after_seconds: z.number().positive().optional(),
      })
      .passthrough()
      .optional(),
  )
  .optional();

const compressionSchema = z
  .object({
    trigger_tokens: z.number().int().positive().optional(),
    max_input_ratio: z.number().min(0).max(1).optional(),
    summarize_model_role: z.string().min(1).optional(),
    keep_hunks_top_k: z.number().int().positive().optional(),
    context_lines: z.number().int().positive().optional(),
    per_model_overrides: z
      .record(
        z.string().min(1),
        z
          .object({
            trigger_tokens: z.number().int().positive().optional(),
          })
          .passthrough()
          .optional(),
      )
      .optional(),
  })
  .passthrough()
  .optional();

const triggerSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["gitea", "forgejo", "github", "gitlab", "p4", "svn", "scheduled", "manual"]),
    watch_path: z.array(z.string().min(1)).optional(),
    include_cr_file: z.array(z.string().min(1)).optional(),
    exclude_cr_file: z.array(z.string().min(1)).optional(),
    commit_url_template: z.string().min(1).optional(),
    revision_url_template: z.string().min(1).optional(),
    change_url_template: z.string().min(1).optional(),
  })
  .passthrough();

const noProblemsPolicySchema = z
  .object({
    action: z.enum(["publish", "suppress"]),
  })
  .strict();

const outputChannelOverrideSchema = z
  .object({
    no_problems: noProblemsPolicySchema.optional(),
    no_findings: z.never().optional(),
  })
  .passthrough();

const outputChannelSchema = z
  .object({
    name: z.string().min(1),
    kind: z.string().min(1).refine((value) => value !== "gitea_finding_issue", {
      message: "gitea_finding_issue has been removed; use gitea_problem_issue.",
    }),
    trigger: z.string().min(1).optional(),
    mention_author: z.boolean().optional(),
    mention_fallback: z.enum(["all", "skip"]).optional(),
    no_problems: noProblemsPolicySchema.optional(),
    no_findings: z.never().optional(),
    commit_url_template: z.string().min(1).optional(),
    revision_url_template: z.string().min(1).optional(),
    change_url_template: z.string().min(1).optional(),
    marker_prefix: z.string().min(1).optional(),
    marker_label: z.string().min(1).optional(),
    label_ids: z.array(z.number().int().positive()).optional(),
    labels: z.array(z.string().min(1)).optional(),
    resolved_action: z.enum(["none", "close", "delete"]).optional(),
    assign_committer: z.boolean().optional(),
    owners_file: z.string().min(1).optional(),
    add_owners_as_assignees: z.boolean().optional(),
    severity_label_prefix: z.string().min(1).optional(),
    severity_label_colors: z.record(z.string().min(1), z.string().min(1)).optional(),
    notify_feishu: z
      .object({
        webhook_url_env: z.string().min(1),
        secret_env: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const workspaceOutputsSchema = z
  .object({
    line_comments: z.array(z.string()).optional(),
    summary: z.array(z.string()).optional(),
    no_problems: noProblemsPolicySchema.optional(),
    no_findings: z.never().optional(),
    channel_overrides: z.record(z.string().min(1), outputChannelOverrideSchema).optional(),
  })
  .strict();

const outputAuthorResolutionSchema = z
  .object({
    email_mappings: z.record(z.string().min(1), z.string().min(1)).optional(),
    email_blacklist: z.array(z.string().email()).optional(),
  })
  .passthrough()
  .optional();

const outputRouteTargetKindSchema = z.preprocess((value) => {
  return value === "pr" ? "pull_request" : value;
}, reviewTargetKindSchema);

const outputRouteSchema = z
  .object({
    match: z
      .object({
        trigger: z.string().min(1).optional(),
        target_kind: outputRouteTargetKindSchema.optional(),
      })
      .passthrough()
      .optional(),
    line_comments: z.array(z.string()).optional(),
    summary: z.array(z.string()).optional(),
  })
  .passthrough();

const sandboxSchema = z
  .object({
    kind: z.enum(["native", "docker", "podman", "docker_socket", "k8s_pod"]).optional(),
    engine: z.enum(["auto", "docker", "podman"]).optional(),
    image: z.string().min(1).optional(),
  })
  .strict();

const triageSchema = z
  .object({
    enabled: z.boolean().default(false),
    actions: z
      .array(z.enum(["close"]))
      .default(["close"]),
    categories_close: z
      .array(
        z.enum([
          "spam",
          "invalid",
          "duplicate",
          "resolved",
          "out_of_scope",
          "stale",
        ]),
      )
      .default(["spam", "invalid"]),
    events: z
      .array(z.enum(["issues"]))
      .default(["issues"]),
    custom_prompt: z.string().min(1).optional(),
    dry_run: z.boolean().default(false),
  })
  .passthrough()
  .default({ enabled: false, actions: ["close"], categories_close: ["spam", "invalid"], events: ["issues"], dry_run: false });

const reviewSchema = z
  .object({
    languages_auto_detect: z.boolean().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    max_files: z.number().int().positive().optional(),
    max_patch_bytes: z.number().int().positive().optional(),
    incremental: z.boolean().optional(),
    skip_lgtm: z.boolean().optional(),
    output_language: z.string().min(1).optional(),
    commit_strategy: z.enum(["per_commit", "aggregate", "head_only"]).optional(),
    git: z
      .object({
        allow_deepen: z.boolean().optional(),
      })
      .strict()
      .optional(),
    labels: z
      .object({
        ignore: z.array(z.string().min(1)).optional(),
        auto_tag: z.string().min(1).optional(),
        reviewed_tag: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    problem_issue: z
      .object({
        max_recent_issues: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    fetch_extra: z
      .object({
        max_bytes: z.number().int().positive().optional(),
        max_files: z.number().int().positive().optional(),
        allow_paths: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    reflection: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(["off", "light", "thorough"]).optional(),
        memory: z
          .object({
            max_size_kb: z.number().int().positive().optional(),
            compact_after_runs: z.number().int().positive().optional(),
            retention_days: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

const workspaceInstanceSchema = z
  .object({
    source_repo: z
      .object({
        trigger: z.string().min(1),
        repo: z.string().min(1),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        default: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    review: reviewSchema.optional(),
    outputs: workspaceOutputsSchema.optional(),
    sandbox: sandboxSchema.optional(),
    triage: triageSchema.optional(),
    auth: z
      .object({
        api_key_env: z.string().min(1).optional(),
        enabled: z.boolean().default(true),
      })
      .passthrough()
      .optional(),
  })
  .strict();

const workspaceConfigFileSchema = workspaceInstanceSchema.omit({ sandbox: true }).strict();

const trustProxyValueSchema: z.ZodType<
  boolean | "loopback" | "linklocal" | "uniquelocal" | readonly string[],
  z.ZodTypeDef,
  unknown
> = z.union([
  z.boolean(),
  z.enum(["loopback", "linklocal", "uniquelocal"]),
  z.array(z.string().min(1)),
]);

const authSchema = z
  .object({
    api_key_env: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
  })
  .passthrough()
  .optional();

const serverSchema = z
  .object({
    port: z.number().int().positive().default(8080),
    hostname: z.string().min(1).default("0.0.0.0"),
    trust_proxy: trustProxyValueSchema.default(false),
    base_url: z.string().min(1).optional(),
    path_prefix: z.string().min(1).optional(),
    auth: authSchema,
  })
  .passthrough()
  .default({ port: 8080, hostname: "0.0.0.0", trust_proxy: false });

const appConfigSchema = z
  .object({
    server: serverSchema,
    llm: z
      .object({
        providers: z.array(llmProviderSchema).default([]),
        fallback_chain: z.array(llmFallbackEntrySchema).default([]),
        retry: llmRetrySchema,
        per_provider_overrides: llmPerProviderOverridesSchema,
        budget: llmBudgetSchema,
      })
      .passthrough()
      .default({ providers: [], fallback_chain: [] }),
    triggers: z.array(triggerSchema).default([]),
    outputs: z
      .object({
        template_engine: z.enum(["handlebars", "eta"]).default("handlebars"),
        no_problems: noProblemsPolicySchema.optional(),
        no_findings: z.never().optional(),
        channels: z.array(outputChannelSchema).default([]),
        author_resolution: outputAuthorResolutionSchema,
        routes: z
          .object({
            default: outputRouteSchema.optional(),
            rules: z.array(outputRouteSchema).default([]),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .default({ template_engine: "handlebars", channels: [] }),
    queue: z
      .object({
        kind: z.enum(["memory", "sqlite", "redis", "rabbitmq"]).default("memory"),
        workers: z
          .object({
            concurrency: z.number().int().positive().optional(),
            per_workspace_concurrency: z.number().int().positive().optional(),
            lock_ttl_seconds: z.number().int().positive().optional(),
          })
          .passthrough()
          .optional(),
        rate_limit: z
          .object({
            per_provider_rps: z.record(z.string().min(1), z.number().positive()).optional(),
          })
          .passthrough()
          .optional(),
        retry: z
          .object({
            attempts: z.number().int().positive().optional(),
            backoff: z
              .object({
                kind: z.enum(["exponential", "linear", "constant"]),
                base_ms: z.number().positive().optional(),
                max_ms: z.number().positive().optional(),
                jitter: z.boolean().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
        dead_letter: z
          .object({
            enabled: z.boolean().optional(),
            max_age_hours: z.number().int().positive().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .default({ kind: "memory" }),
    agent: z
      .object({
        default: z.string().min(1).default("kilo"),
        timeout_seconds: z.number().int().positive().default(600),
        auto_approve: z.boolean().default(true),
        sandbox: sandboxSchema.default({ kind: "docker", engine: "auto" }),
      })
      .strict()
      .default({
        default: "kilo",
        timeout_seconds: 600,
        auto_approve: true,
        sandbox: { kind: "docker", engine: "auto" },
      }),
    compression: compressionSchema,
    review: reviewSchema.default({
      incremental: true,
      skip_lgtm: true,
      languages_auto_detect: true,
      include: ["**/*"],
      exclude: ["**/vendor/**", "**/*.min.js", "**/*.lock"],
      max_files: 50,
      max_patch_bytes: 200_000,
      output_language: "zh-CN",
      commit_strategy: "aggregate",
    }),
    workspaces: z
      .object({
        cache: z
          .object({
            max_total_gb: z.number().positive().default(50),
            eviction: z.enum(["lru", "mru", "ttl"]).default("lru"),
            ttl_days: z.number().int().positive().default(30),
          })
          .strict()
          .default({ max_total_gb: 50, eviction: "lru", ttl_days: 30 }),
        defaults: z
          .object({
            sandbox: sandboxSchema.optional(),
            review: reviewSchema.optional(),
            agent: z
              .object({
                default: z.string().min(1).optional(),
              })
              .strict()
              .optional(),
            outputs: workspaceOutputsSchema.optional(),
          })
          .strict()
          .default({}),
        instances: z.record(workspaceIdSchema, workspaceInstanceSchema).default({}),
      })
      .strict()
      .default({
        cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
        defaults: {},
        instances: {},
      }),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;
export type AppConfigInput = Record<string, unknown>;
export type WorkspaceConfig = z.infer<typeof workspaceInstanceSchema>;
export type WorkspaceConfigFile = z.infer<typeof workspaceConfigFileSchema>;

function mergeValue(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return base;
  }

  if (Array.isArray(base) && Array.isArray(override)) {
    return override;
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      result[key] = mergeValue(base[key], value);
    }

    return result;
  }

  return override;
}

export function mergeConfigLayers(...layers: AppConfigInput[]): AppConfig {
  const merged = layers.reduce<Record<string, unknown>>((acc, layer) => {
    return mergeValue(acc, layer) as Record<string, unknown>;
  }, {});

  return appConfigSchema.parse(merged);
}

export function resolveWorkspaceConfig(config: AppConfig, workspaceId: string): WorkspaceConfig {
  const instance = config.workspaces.instances[workspaceId];

  if (!instance) {
    throw new RangeError(`Workspace ${workspaceId} is not configured.`);
  }

  return workspaceInstanceSchema.parse(mergeValue(config.workspaces.defaults, instance));
}

function normalizeConfigDocument(parsed: unknown): AppConfigInput {
  if (parsed == null) {
    return {};
  }

  if (!isPlainObject(parsed)) {
    throw new TypeError("Config file root must be a YAML mapping/object.");
  }

  return parsed;
}

export async function loadConfigFile(path: string): Promise<AppConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = normalizeConfigDocument(parseYaml(raw));

  return appConfigSchema.parse(parsed);
}

export async function loadWorkspaceConfigFile(path: string): Promise<WorkspaceConfigFile> {
  const raw = await readFile(path, "utf8");
  const parsed = normalizeConfigDocument(parseYaml(raw));

  return workspaceConfigFileSchema.parse(parsed);
}

export { appConfigSchema, workspaceConfigFileSchema };
