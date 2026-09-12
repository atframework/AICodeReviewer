import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { reviewTargetKindSchema } from "./review-event.js";
import { CONFIG_MATCHER_LIMITS, configMatcherSchema, reasoningEffortSchema } from "./config-format.js";
import { validateWorkspaceDefinitions } from "./config-workspace.js";
import { autoCommitConfigSchema, type AutoCommitConfig } from "./auto-commit-policy.js";
import { pullRequestConfigSchema, type PullRequestConfig } from "./pull-request-policy.js";
import { isPlainObject } from "./utils.js";
import { workspaceRootKeys } from "./config-format.js";

import {
  assertNoSecretEnvIssues,
  convertLegacyConfigDocument,
  parseRawConfigSource,
  type ConfigConversionChange,
  type ConfigSourceMap,
  type ParseRawConfigOptions,
} from "./config-source.js";

export { workspaceRootKeys };

const reservedWorkspaceIds: Record<string, true> = { cache: true, defaults: true, instances: true };

export const workspaceIdSchema = z
  .string()
  .min(1)
  .refine((value) => reservedWorkspaceIds[value] !== true, {
    message:
      "workspace_id must not collide with reserved keys (cache, defaults, instances); see Plan.md §3.10 D14",
  });

export const llmProviderSchema = z
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
    catalog_provider: z.string().min(1).optional(),
    catalog_id: z.string().min(1).optional(),
  })
  .passthrough();


/**
 * Request-level overrides on a single model-chain entry (spec §4.2). Accepted
 * by the schema from P0; resolveModelSpecFromChain ignores them until the
 * runtime generation wiring (P4) — setting them changes no client behavior
 * yet. Maps merge by key, arrays replace wholesale; disabling a parameter is
 * expressed through drop_params, never JSON null.
 */
export const modelRequestOverridesSchema = z
  .object({
    extra_params: z.record(z.string().min(1), z.unknown()).optional(),
    extra_body: z.record(z.string().min(1), z.unknown()).optional(),
    extra_headers: z.record(z.string().min(1), z.string()).optional(),
    reasoning_effort: reasoningEffortSchema.optional(),
    thinking_level: z.enum(["off", "minimal", "low", "medium", "high", "max"]).optional(),
    thinking_budget_tokens: z.number().int().positive().optional(),
    thinking: z.object({ enabled: z.boolean() }).passthrough().optional(),
    response_format: z
      .object({ kind: z.enum(["json_schema", "json_object", "text"]) })
      .passthrough()
      .optional(),
    tool_choice: z
      .union([z.enum(["auto", "none", "required"]), z.record(z.string().min(1), z.unknown())])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    seed: z.number().int().optional(),
    logit_bias: z.record(z.string().min(1), z.number()).optional(),
    drop_params: z.array(z.string().min(1)).optional(),
    allowed_openai_params: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const llmModelChainEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    role: z.enum(["light", "heavy", "any"]),
    overrides: modelRequestOverridesSchema.optional(),
  })
  .passthrough();

export const modelChainReferenceSchema = z
  .string({
    invalid_type_error: "Model chain references must be group names; move the model list into llm.model_chain.<group> and reference that group",
  })
  .min(1)
  .refine((name) => name.trim() === name, {
    message: "Model chain group names must not have leading or trailing whitespace",
  });

export const llmRetrySchema = z
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

export const llmBudgetSchema = z
  .object({
    per_run_usd: z.number().nonnegative().optional(),
    per_repo_daily_usd: z.number().nonnegative().optional(),
  })
  .passthrough()
  .optional();

export const llmPerProviderOverridesSchema = z
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

export const modelStatusSchema = z.enum([
  "stable",
  "preview",
  "experimental",
  "alpha",
  "beta",
  "deprecated",
  "shutdown",
]);

export const modelCatalogOverrideSchema = z
  .object({
    catalog_id: z.string().min(1).optional(),
    context_window: z.number().int().positive().optional(),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    cost_input_per_mtok: z.number().nonnegative().optional(),
    cost_output_per_mtok: z.number().nonnegative().optional(),
    cost_cache_read_per_mtok: z.number().nonnegative().optional(),
    cost_cache_write_per_mtok: z.number().nonnegative().optional(),
    cost_reasoning_per_mtok: z.number().nonnegative().optional(),
    cost_input_audio_per_mtok: z.number().nonnegative().optional(),
    cost_output_audio_per_mtok: z.number().nonnegative().optional(),
    supports_tool_call: z.boolean().optional(),
    supports_attachment: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
    supports_cache_prompt: z.boolean().optional(),
    supports_reasoning: z.boolean().optional(),
    supported_reasoning_efforts: z.array(reasoningEffortSchema).optional(),
    default_reasoning_effort: reasoningEffortSchema.optional(),
    thinking_modes: z.array(z.string().min(1)).optional(),
    supports_interleaved_reasoning: z.boolean().optional(),
    interleaved_reasoning_field: z.string().min(1).optional(),
    supports_structured_output: z.boolean().optional(),
    supports_temperature: z.boolean().optional(),
    supports_streaming: z.boolean().optional(),
    supports_logprobs: z.boolean().optional(),
    supports_search: z.boolean().optional(),
    supports_computer_use: z.boolean().optional(),
    native_tool_capabilities: z.array(z.string().min(1)).optional(),
    supported_request_parameters: z.array(z.string().min(1)).optional(),
    unsupported_request_parameters: z.array(z.string().min(1)).optional(),
    input_modalities: z.array(z.string().min(1)).optional(),
    output_modalities: z.array(z.string().min(1)).optional(),
    display_name: z.string().min(1).optional(),
    family: z.string().min(1).optional(),
    knowledge_cutoff: z.string().min(1).optional(),
    training_cutoff: z.string().min(1).optional(),
    release_date: z.string().min(1).optional(),
    last_updated: z.string().min(1).optional(),
    model_status: modelStatusSchema.optional(),
    open_weights: z.boolean().optional(),
    license: z.string().min(1).optional(),
    model_links: z.record(z.string().min(1), z.string().min(1)).optional(),
    provider_display_name: z.string().min(1).optional(),
    provider_npm_package: z.string().min(1).optional(),
    provider_env_vars: z.array(z.string().min(1)).optional(),
    provider_api_base_url: z.string().url().optional(),
    provider_docs_url: z.string().url().optional(),
    provider_model_aliases: z.array(z.string().min(1)).optional(),
    provider_model_ids: z.array(z.string().min(1)).optional(),
    preferred_endpoint: z.string().min(1).optional(),
    latency_class: z.string().min(1).optional(),
    priority_tier_supported: z.boolean().optional(),
    rate_limit_tier: z.string().min(1).optional(),
    concurrency_limit: z.number().int().positive().optional(),
    throughput_hint_tokens_per_second: z.number().positive().optional(),
  })
  .passthrough();

export const modelCatalogSchema = z
  .object({
    enabled: z.boolean().default(false),
    source_url: z.string().url().default("https://models.dev/api.json"),
    refresh_interval_hours: z.number().int().positive().default(24),
    fetch_timeout_ms: z.number().int().positive().default(10000),
    offline: z.boolean().default(false),
    apply_to_model_spec: z.boolean().default(true),
    cache: z
      .object({
        backend: z.enum(["sqlite", "redis", "memory"]).default("sqlite"),
      })
      .passthrough()
      .default({ backend: "sqlite" }),
    overrides: z.record(z.string().min(1), modelCatalogOverrideSchema).default({}),
  })
  .passthrough()
  .default({
    enabled: false,
    source_url: "https://models.dev/api.json",
    refresh_interval_hours: 24,
    fetch_timeout_ms: 10000,
    offline: false,
    apply_to_model_spec: true,
    cache: { backend: "sqlite" },
    overrides: {},
  });


export const compressionSchema = z
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

export const githubAppIdSchema = z.union([z.string().min(1), z.number().int().positive()]);

export const githubAppAuthSchema = z
  .object({
    app_id: githubAppIdSchema.optional(),
    client_id: z.string().min(1).optional(),
    private_key_env: z.string().min(1).optional(),
    private_key_path: z.string().min(1).optional(),
    installation_id: githubAppIdSchema.optional(),
  })
  .passthrough();

export const triggerSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["gitea", "forgejo", "github", "gitlab", "p4", "svn", "scheduled", "manual"]),
    enabled: z.boolean().optional(),
    watch_path: z.array(z.string().min(1)).optional(),
    include_cr_file: z.array(z.string().min(1)).optional(),
    exclude_cr_file: z.array(z.string().min(1)).optional(),
    commit_url_template: z.string().min(1).optional(),
    revision_url_template: z.string().min(1).optional(),
    change_url_template: z.string().min(1).optional(),
    app: githubAppAuthSchema.optional(),
  })
  .passthrough();

export const noProblemsPolicySchema = z
  .object({
    action: z.enum(["publish", "suppress", "publish_if_summary"]),
  })
  .strict();

export const outputChannelOverrideSchema = z
  .object({
    no_problems: noProblemsPolicySchema.optional(),
    no_findings: z.never().optional(),
  })
  .passthrough();

export const outputChannelSchema = z
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
    issue_mode: z.enum(["per_problem", "consolidated", "per_commit"]).optional(),
    resolved_action: z.enum(["none", "close", "mark_resolved", "delete"]).optional(),
    assign_committer: z.boolean().optional(),
    owners_file: z.string().min(1).optional(),
    add_owners_as_assignees: z.boolean().optional(),
    severity_label_prefix: z.string().min(1).optional(),
    severity_label_colors: z.record(z.string().min(1), z.string().min(1)).optional(),
    review_mode: z.enum(["auto", "review", "comment"]).optional(),
    review_event: z.enum(["COMMENT", "REQUEST_CHANGES"]).optional(),
    review_update_strategy: z.enum(["always_new", "update_existing"]).optional(),
    notify_feishu: z
      .object({
        webhook_url_env: z.string().min(1),
        secret_env: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const workspaceOutputsSchema = z
  .object({
    line_comments: z.array(z.string()).optional(),
    summary: z.array(z.string()).optional(),
    no_problems: noProblemsPolicySchema.optional(),
    no_findings: z.never().optional(),
    channel_overrides: z.record(z.string().min(1), outputChannelOverrideSchema).optional(),
  })
  .strict();

export const outputAuthorResolutionSchema = z
  .object({
    email_mappings: z.record(z.string().min(1), z.string().min(1)).optional(),
    email_blacklist: z.array(z.string().email()).optional(),
  })
  .passthrough()
  .optional();

export const outputRouteTargetKindSchema = z.preprocess((value) => {
  return value === "pr" ? "pull_request" : value;
}, reviewTargetKindSchema);

export const outputRouteSchema = z
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

export const sandboxSchema = z
  .object({
    kind: z.enum(["native", "docker", "podman", "docker_socket", "k8s_pod", "firecracker"]).optional(),
    engine: z.enum(["auto", "docker", "podman"]).optional(),
    image: z.string().min(1).optional(),
  })
  .strict();
export const agentKindSchema = z.enum(["kilo", "opencode", "zoo", "copilot-cli", "claude-code", "pi", "oh-my-pi"]);

export const contextCompactionSchema = z
  .object({
    auto: z.boolean().default(true),
    threshold_percent: z.number().int().min(1).max(100).optional(),
    prune: z.boolean().default(true),
  })
  .strict();

/**
 * Credential providers whose omp-native env var name is verified for AICR
 * env-name indirection (omp 18.0.6, `docs/tools/web_search.md` + binary strings;
 * `packages/agents/src/oh-my-pi.ts` holds the env-name mapping and must stay in
 * sync). OAuth-stored providers (perplexity/gemini/codex OAuth) are excluded:
 * the per-run `PI_CODING_AGENT_DIR` bundle has no auth store.
 */
export const agentWebSearchCredentialProviderSchema = z.enum([
  "tavily",
  "brave",
  "exa",
  "jina",
  "kagi",
  "parallel",
  "kimi",
  "perplexity",
  "zai",
  "xai",
  "anthropic",
  "tinyfish",
  "firecrawl",
  "searxng_token",
  "searxng_basic_username",
  "searxng_basic_password",
]);

export const agentWebSearchSearxngSchema = z
  .object({
    endpoint: z.string().min(1).optional(),
    categories: z.string().min(1).optional(),
    engines: z.string().min(1).optional(),
    language: z.string().min(1).optional(),
    safesearch: z.number().int().min(0).max(2).optional(),
  })
  .strict();

export const agentWebSearchSchema = z
  .object({
    enabled: z.boolean().default(false),
    providers: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    timeout_seconds: z.number().int().min(1).max(300).optional(),
    credentials: z
      .record(agentWebSearchCredentialProviderSchema, z.string().min(1))
      .default({}),
    searxng: agentWebSearchSearxngSchema.optional(),
  })
  .strict()
  .default({ enabled: false, providers: [], exclude: [], credentials: {} });

export const triageSchema = z
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

/**
 * Explicit portable shape of the `review` section. The schema below is reused
 * at three layers of the app config; without a named type the serialized
 * declaration triples every nested union and exceeds the compiler's
 * declaration-emit limit (TS7056).
 */
export interface ReviewConfig {
  languages_auto_detect?: boolean | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  max_files?: number | undefined;
  max_patch_bytes?: number | undefined;
  incremental?: boolean | undefined;
  skip_lgtm?: boolean | undefined;
  output_language?: string | undefined;
  commit_strategy?: "per_commit" | "aggregate" | "head_only" | undefined;
  auto_commit?: AutoCommitConfig | undefined;
  pull_request?: PullRequestConfig | undefined;
  log_thinking?: boolean | undefined;
  git?: { allow_deepen?: boolean | undefined } | undefined;
  labels?: {
    ignore?: string[] | undefined;
    auto_tag?: string | undefined;
    reviewed_tag?: string | undefined;
  } | undefined;
  problem_issue?: { max_recent_issues?: number | undefined } | undefined;
  fetch_extra?: {
    max_bytes?: number | undefined;
    max_files?: number | undefined;
    allow_paths?: string[] | undefined;
  } | undefined;
  reflection?: {
    enabled?: boolean | undefined;
    mode?: "off" | "light" | "thorough" | undefined;
    memory?: {
      max_size_kb?: number | undefined;
      max_entries?: number | undefined;
      retention_days?: number | undefined;
    } | undefined;
  } | undefined;
  [key: string]: unknown;
}

const reviewSchema: z.ZodType<ReviewConfig> = z
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
    auto_commit: autoCommitConfigSchema.optional(),
    pull_request: pullRequestConfigSchema.optional(),
    log_thinking: z.boolean().optional(),
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
        max_recent_issues: z.number().int().min(1).max(200).optional(),
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
            max_entries: z.number().int().positive().optional(),
            retention_days: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export const contextRepositoryAliasSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, {
    message: "context repository alias must be path-safe (letters, digits, '.', '_', '-'; no slashes)",
  });

export const contextRepositorySchema = z
  .object({
    alias: contextRepositoryAliasSchema,
    kind: z.enum(["git", "p4", "svn"]),
    url: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    token_env: z.string().min(1).optional(),
    repository_url: z.string().min(1).optional(),
    revision: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    port: z.string().min(1).optional(),
    user_env: z.string().min(1).optional(),
    ticket_env: z.string().min(1).optional(),
    password_env: z.string().min(1).optional(),
    depot_path: z.string().min(1).optional(),
    max_mb: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((repo, ctx) => {
    const forbid = (fields: readonly string[], allowedBy: string) => {
      for (const field of fields) {
        if (repo[field as keyof typeof repo] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `context_repositories field '${field}' is only valid for kind: ${allowedBy}; see docs/ai/architecture.md §3.2.2`,
            path: [field],
          });
        }
      }
    };

    if (repo.kind === "git") {
      if (!repo.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "kind: git context repository requires url; see docs/ai/architecture.md §3.2.2",
          path: ["url"],
        });
      }
      forbid(["repository_url", "revision", "port", "user_env", "ticket_env", "password_env", "depot_path"], "svn/p4");
    } else if (repo.kind === "svn") {
      if (!repo.repository_url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "kind: svn context repository requires repository_url; see docs/ai/architecture.md §3.2.2",
          path: ["repository_url"],
        });
      }
      forbid(["url", "ref", "token_env", "port", "user_env", "ticket_env", "password_env", "depot_path"], "git/p4");
    } else {
      if (!repo.depot_path) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "kind: p4 context repository requires depot_path; see docs/ai/architecture.md §3.2.2",
          path: ["depot_path"],
        });
      }
      forbid(["url", "ref", "token_env", "repository_url"], "git/svn");
    }
  });

export const contextRepositoriesSchema = z
  .array(contextRepositorySchema)
  .superRefine((repos, ctx) => {
    const seen = new Set<string>();
    repos.forEach((repo, index) => {
      if (seen.has(repo.alias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate context repository alias '${repo.alias}'; aliases must be unique per workspace`,
          path: [index, "alias"],
        });
      }
      seen.add(repo.alias);
    });
  });

export const workspacePromptSchema = z
  .object({
    base_system_prompt_file: z.string().min(1).optional(),
    force_skills: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .optional();

/** Workspace-layer agent selection (defaults and instances share this shape). */
export const workspaceAgentSelectionSchema = z
  .object({
    default: agentKindSchema.optional(),
  })
  .strict();

/**
 * One workspace match rule (spec §5.1): rules are OR-ed; triggers/source
 * conditions inside a rule are AND-ed; array triggers are OR-ed. At least one
 * condition is required.
 */
export const workspaceMatchRuleSchema = z
  .object({
    id: z.string().min(1).optional(),
    triggers: z.array(z.string().min(1)).min(1).optional(),
    source: z.record(z.string().min(1), configMatcherSchema).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.triggers === undefined && rule.source === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "match rule must set at least one of triggers or source",
      });
    }
  });

export const workspaceInstanceSchema = z
  .object({
    enabled: z.boolean().optional(),
    model_chain: modelChainReferenceSchema.optional(),
    triage_model_chain: modelChainReferenceSchema.optional(),
    source_repo: z
      .object({
        trigger: z.string().min(1),
        repo: z.string().min(1),
      })
      .strict()
      .optional(),
    // v2 multi-project form (spec §5.1); mutually exclusive with source_repo,
    // enforced together with trigger references by validateWorkspaceDefinitions.
    match: z.array(workspaceMatchRuleSchema).max(CONFIG_MATCHER_LIMITS.maxRulesPerGroup).optional(),
    work_path: z.string().min(1).optional(),
    agent: workspaceAgentSelectionSchema.optional(),
    review: reviewSchema.optional(),
    outputs: workspaceOutputsSchema.optional(),
    sandbox: sandboxSchema.optional(),
    triage: triageSchema.optional(),
    prompt: workspacePromptSchema,
    context_repositories: contextRepositoriesSchema.optional(),
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

export const trustProxyValueSchema: z.ZodType<
  boolean | "loopback" | "linklocal" | "uniquelocal" | readonly string[],
  z.ZodTypeDef,
  unknown
> = z.union([
  z.boolean(),
  z.enum(["loopback", "linklocal", "uniquelocal"]),
  z.array(z.string().min(1)),
]);

export const authSchema = z
  .object({
    api_key_env: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
  })
  .passthrough()
  .optional();

export const serverSchema = z
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

export const storageDatabaseSchema = z
  .object({
    kind: z.enum(["sqlite", "postgres"]).default("sqlite"),
    /**
     * Startup migration mode (P2/M19): `auto` applies pending schema steps
     * through the shared MigrationRunner at open; `verify` refuses to start
     * when the ledger is behind, drifted, or newer than this program.
     */
    migrate: z.enum(["auto", "verify"]).default("auto"),
    sqlite: z
      .object({
        path: z.string().min(1).default("/app/data/aicr.sqlite"),
      })
      .passthrough()
      .default({ path: "/app/data/aicr.sqlite" }),
    postgres: z
      .object({
        url_env: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .default({ kind: "sqlite", sqlite: { path: "/app/data/aicr.sqlite" } });

export const storageCacheSchema = z
  .object({
    kind: z.enum(["memory", "redis", "none"]).default("memory"),
    redis: z
      .object({
        url_env: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    ttl_seconds: z.number().int().positive().optional(),
  })
  .passthrough()
  .default({ kind: "memory" });

export const storageObjectSchema = z
  .object({
    kind: z.enum(["filesystem", "s3"]).default("filesystem"),
    filesystem: z
      .object({
        root: z.string().min(1).default("/app/data/objects"),
      })
      .passthrough()
      .default({ root: "/app/data/objects" }),
    s3: z
      .object({
        endpoint_url_env: z.string().min(1).optional(),
        bucket: z.string().min(1).optional(),
        region_env: z.string().min(1).optional(),
        access_key_id_env: z.string().min(1).optional(),
        secret_access_key_env: z.string().min(1).optional(),
        force_path_style: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .default({ kind: "filesystem", filesystem: { root: "/app/data/objects" } });

export const storageSchema = z
  .object({
    database: storageDatabaseSchema,
    cache: storageCacheSchema,
    object: storageObjectSchema,
    retention: z
      .object({
        deleted_project_grace_days: z.number().int().nonnegative().default(30),
      })
      .passthrough()
      .default({ deleted_project_grace_days: 30 }),
  })
  .passthrough()
  .default({});

export const adminAuthSchema = z
  .object({
    username_env: z.string().min(1).default("AICR_ADMIN_USERNAME"),
    password_env: z.string().min(1).default("AICR_ADMIN_PASSWORD"),
    password_hash_env: z.string().min(1).optional(),
    session_ttl_seconds: z.number().int().positive().default(86400),
  })
  .passthrough()
  .default({});

export const llmConfigSchema = z
  .object({
    providers: z.array(llmProviderSchema).default([]),
    model_chain: z.record(
      modelChainReferenceSchema,
      z.array(llmModelChainEntrySchema).min(1),
      { invalid_type_error: "llm.model_chain must be a mapping of group names to model lists; move the old array to llm.model_chain.default" },
    ).default({}),
    default_model_chain: modelChainReferenceSchema.default("default"),
    triage_model_chain: modelChainReferenceSchema.optional(),
    retry: llmRetrySchema,
    per_provider_overrides: llmPerProviderOverridesSchema,
    budget: llmBudgetSchema,
    model_catalog: modelCatalogSchema,
  })
  .passthrough();

export const outputsConfigSchema = z
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
  .passthrough();

export const queueConfigSchema = z
  .object({
    kind: z.enum(["memory", "sqlite", "redis", "rabbitmq"]).default("memory"),
    sqlite: z
      .object({
        path: z.string().min(1).optional(),
        lock_ttl_seconds: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
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
  .passthrough();

export const agentConfigSchema = z
  .object({
    default: agentKindSchema.default("kilo"),
    timeout_seconds: z.number().int().positive().default(1800),
    auto_approve: z.boolean().default(true),
    sandbox: sandboxSchema.default({ kind: "docker", engine: "auto" }),
    context_compaction: contextCompactionSchema.default({ auto: true, prune: true }),
    web_search: agentWebSearchSchema,
  })
  .strict();

export const workspacesCacheSchema = z
  .object({
    max_total_gb: z.number().positive().default(50),
    eviction: z.enum(["lru", "mru", "ttl"]).default("lru"),
    ttl_days: z.number().int().positive().default(30),
  })
  .strict();

export const workspacesDefaultsSchema = z
  .object({
    model_chain: modelChainReferenceSchema.optional(),
    triage_model_chain: modelChainReferenceSchema.optional(),
    sandbox: sandboxSchema.optional(),
    review: reviewSchema.optional(),
    agent: workspaceAgentSelectionSchema.optional(),
    outputs: workspaceOutputsSchema.optional(),
    prompt: workspacePromptSchema,
    context_repositories: contextRepositoriesSchema.optional(),
  })
  .strict();

export const workspacesConfigSchema = z
  .object({
    // Layout root for workspace instances (spec §5.5). Relative paths resolve
    // against the server base directory; when unset the historical
    // `<baseDir>/workspaces` root is used. Consumed by the runtime matcher
    // wiring (P1b).
    root: z.string().min(1).optional(),
    cache: workspacesCacheSchema.default({ max_total_gb: 50, eviction: "lru", ttl_days: 30 }),
    defaults: workspacesDefaultsSchema.default({}),
    instances: z.record(workspaceIdSchema, workspaceInstanceSchema).default({}),
  })
  .strict();

// ---------------------------------------------------------------------------
// v2 routing rules (spec §6). The v1 file schema does NOT accept `routing`;
// the merged effective document (file + database, format version 2) may carry
// it when database route records exist. Route records narrow trigger-admitted
// traffic; they can never widen a trigger's repository authorization, because
// admission runs before route selection.
// ---------------------------------------------------------------------------

/** Analysis overrides allowed on a routing rule (spec §6; inheritable subset). */
export const routingRuleAnalysisSchema = z
  .object({
    model_chain: modelChainReferenceSchema.optional(),
    triage_model_chain: modelChainReferenceSchema.optional(),
    agent: workspaceAgentSelectionSchema.optional(),
    sandbox: sandboxSchema.optional(),
    review: reviewSchema.optional(),
    compression: compressionSchema.optional(),
  })
  .strict();

/** Output channel selection on a routing rule; `[]` explicitly closes a kind. */
export const routingRuleOutputsSchema = z
  .object({
    line_comments: z.array(z.string().min(1)).optional(),
    summary: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const routingRuleMatchSchema = z
  .object({
    triggers: z.array(z.string().min(1)).min(1).optional(),
    target_kinds: z.array(reviewTargetKindSchema).min(1).optional(),
    source: z
      .object({
        repo_ref: configMatcherSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const routingRuleSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean().default(true),
    priority: z.number().int().default(0),
    match: routingRuleMatchSchema.optional(),
    workspace: z.string().min(1),
    analysis: routingRuleAnalysisSchema.optional(),
    outputs: routingRuleOutputsSchema.optional(),
  })
  .strict();

export const routingConfigSchema = z
  .object({
    rules: z.array(routingRuleSchema).default([]),
  })
  .strict();

export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

const appConfigObjectSchema = z
  .object({
    storage: storageSchema,
    admin: adminAuthSchema,
    server: serverSchema,
    llm: llmConfigSchema.default({ providers: [], model_chain: {} }),
    triggers: z.array(triggerSchema).default([]),
    outputs: outputsConfigSchema.default({ template_engine: "handlebars", channels: [] }),
    queue: queueConfigSchema.default({ kind: "memory" }),
    agent: agentConfigSchema.default({
      default: "kilo",
      timeout_seconds: 1800,
      auto_approve: true,
      sandbox: { kind: "docker", engine: "auto" },
      context_compaction: { auto: true, prune: true },
      web_search: { enabled: false, providers: [], exclude: [], credentials: {} },
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
    workspaces: workspacesConfigSchema.default({
      cache: { max_total_gb: 50, eviction: "lru", ttl_days: 30 },
      defaults: {},
      instances: {},
    }),
  })
  .strict();

type AppConfigRefinementTarget = z.infer<typeof appConfigObjectSchema>;

const appConfigRefinement = (config: AppConfigRefinementTarget, ctx: z.RefinementCtx): void => {
    const llmRaw = config.llm as Record<string, unknown>;
    for (const legacyKey of ["fallback_chain", "triage_fallback_chain"] as const) {
      if (legacyKey in llmRaw) {
        const renamedTo =
          legacyKey === "fallback_chain" ? "model_chain" : "triage_model_chain";
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `llm.${legacyKey} was renamed to llm.${renamedTo}; rename the key in your config file`,
          path: ["llm", legacyKey],
        });
      }
    }

    // Duplicate entity ids are rejected with the exact entity path (test C01);
    // map collections (model_chain, workspaces.instances) cannot duplicate
    // because YAML parsing already enforces unique mapping keys.
    const checkDuplicateEntityIds = (
      entries: readonly Record<string, unknown>[],
      idField: "id" | "name",
      collectionPath: [string, ...string[]],
    ): void => {
      const seen = new Map<string, number>();
      entries.forEach((entry, index) => {
        const id = entry[idField];
        if (typeof id !== "string" || id.length === 0) {
          return;
        }
        const firstIndex = seen.get(id);
        if (firstIndex !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate ${idField} "${id}": entries ${firstIndex} and ${index} in ${collectionPath.join(".")} must be unique`,
            path: [...collectionPath, index, idField],
          });
          return;
        }
        seen.set(id, index);
      });
    };
    checkDuplicateEntityIds(config.llm.providers, "id", ["llm", "providers"]);
    checkDuplicateEntityIds(config.triggers, "name", ["triggers"]);
    checkDuplicateEntityIds(config.outputs.channels, "name", ["outputs", "channels"]);

    const checkModelChainReference = (name: string | undefined, path: string[]): void => {
      if (name !== undefined && !Object.hasOwn(config.llm.model_chain, name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Model chain group "${name}" is not defined in llm.model_chain`,
          path,
        });
      }
    };
    // Preserve provider-only configurations, but never infer a group from map order.
    if (Object.keys(config.llm.model_chain).length > 0 || config.llm.default_model_chain !== "default") {
      checkModelChainReference(config.llm.default_model_chain, ["llm", "default_model_chain"]);
    }
    checkModelChainReference(config.llm.triage_model_chain, ["llm", "triage_model_chain"]);
    for (const field of ["model_chain", "triage_model_chain"] as const) {
      checkModelChainReference(config.workspaces.defaults[field], ["workspaces", "defaults", field]);
      for (const [workspaceId, instance] of Object.entries(config.workspaces.instances)) {
        checkModelChainReference(instance[field], ["workspaces", "instances", workspaceId, field]);
      }
    }

    const catalog = config.llm.model_catalog;
    if (catalog.enabled && catalog.cache.backend === "redis") {
      if (config.storage.cache.kind !== "redis") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "llm.model_catalog.cache.backend 'redis' requires storage.cache.kind 'redis'; see Plan.md §3.13 / D31",
          path: ["llm", "model_catalog", "cache", "backend"],
        });
      }
      if (!config.storage.cache.redis?.url_env) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "llm.model_catalog.cache.backend 'redis' requires storage.cache.redis.url_env; see Plan.md §3.13 / D31",
          path: ["storage", "cache", "redis", "url_env"],
        });
      }
    }

    config.triggers.forEach((trigger, index) => {
      const triggerConfig = trigger as Record<string, unknown>;
      const tokenEnv = triggerConfig.token_env;
      const hasTokenEnv = typeof tokenEnv === "string" && tokenEnv.length > 0;
      const appConfig = trigger.app;
      const hasApp = isPlainObject(appConfig);

      if (trigger.kind !== "github") {
        if (hasApp) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `app auth is only supported for kind: github, not kind: ${trigger.kind}; see docs/ai/architecture.md §3.2.1`,
            path: ["triggers", index, "app"],
          });
        }
        return;
      }

      if (!hasApp) {
        return;
      }

      const app = appConfig as Record<string, unknown>;
      const hasAppId = app.app_id !== undefined && app.app_id !== "";
      const hasClientId = app.client_id !== undefined && app.client_id !== "";
      const hasPrivateKeyEnv = typeof app.private_key_env === "string" && app.private_key_env.length > 0;
      const hasPrivateKeyPath = typeof app.private_key_path === "string" && app.private_key_path.length > 0;

      if (!hasAppId && !hasClientId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "github app auth requires at least one of app_id or client_id; see docs/ai/architecture.md §3.2.1",
          path: ["triggers", index, "app", "app_id"],
        });
      }

      if (!hasPrivateKeyEnv && !hasPrivateKeyPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "github app auth requires exactly one of private_key_env or private_key_path; see docs/ai/architecture.md §3.2.1",
          path: ["triggers", index, "app", "private_key_env"],
        });
      }

      if (hasPrivateKeyEnv && hasPrivateKeyPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "github app auth accepts only one of private_key_env or private_key_path, not both; see docs/ai/architecture.md §3.2.1",
          path: ["triggers", index, "app", "private_key_path"],
        });
      }

      if (hasTokenEnv) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "github trigger cannot specify both token_env and app; they are mutually exclusive outbound auth methods; see docs/ai/architecture.md §3.2.1",
          path: ["triggers", index, "token_env"],
        });
      }
    });
};

const appConfigSchema = appConfigObjectSchema.superRefine(appConfigRefinement);

/**
 * v2 effective document schema: same object + refinement plus the optional
 * `routing` section. Used to validate a merged file+database effective
 * document at format version 2; plain config files stay on the v1 schema
 * (`routing` is rejected there as an unknown key, spec §6).
 */
export const effectiveConfigV2Schema = appConfigObjectSchema
  .extend({ routing: routingConfigSchema.optional() })
  .strict()
  .superRefine(appConfigRefinement);

export type EffectiveConfigV2 = z.infer<typeof effectiveConfigV2Schema>;

/** Parses an effective (merged) config document at the given format version. */
export function parseEffectiveConfig(input: unknown, formatVersion = 1): EffectiveConfigV2 {
  return (formatVersion >= 2 ? effectiveConfigV2Schema : appConfigSchema).parse(input) as EffectiveConfigV2;
}

export type AppConfig = z.infer<typeof appConfigSchema>;
export type AppConfigInput = Record<string, unknown>;
export type WorkspaceConfig = z.infer<typeof workspaceInstanceSchema>;
export type WorkspaceConfigFile = z.infer<typeof workspaceConfigFileSchema>;
export type ContextRepositoryConfig = z.infer<typeof contextRepositorySchema>;

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

export interface LoadedConfigDocument {
  readonly config: AppConfig;
  /** Historical format conversions applied in memory; the file is never rewritten. */
  readonly changes: readonly ConfigConversionChange[];
  readonly sourceMap: ConfigSourceMap;
  /** SHA-256 hex of the exact input bytes. */
  readonly digest: string;
  readonly formatVersion: number;
}

/**
 * Full config document pipeline (spec §4.2): raw YAML with source locations →
 * in-memory legacy format conversion → one schema parse (defaults applied
 * exactly once) → secret reference validation. Historical `model_chain` array
 * and `fallback_chain`/`triage_fallback_chain` aliases are converted by the
 * versioned converter only; the latest schema itself still rejects them.
 */
export function parseConfigDocumentText(text: string, options?: ParseRawConfigOptions): LoadedConfigDocument {
  const raw = parseRawConfigSource(text, options);
  const { document, changes } = convertLegacyConfigDocument(raw.root);
  const config = appConfigSchema.parse(document);
  assertNoSecretEnvIssues(config);
  validateWorkspaceDefinitions(config);
  return {
    config,
    changes,
    sourceMap: raw.sourceMap,
    digest: raw.digest,
    formatVersion: raw.formatVersion,
  };
}

export async function loadConfigFile(path: string): Promise<AppConfig> {
  const raw = await readFile(path, "utf8");
  return parseConfigDocumentText(raw, { fileName: path }).config;
}

export async function loadWorkspaceConfigFile(path: string): Promise<WorkspaceConfigFile> {
  const raw = await readFile(path, "utf8");
  const parsed = normalizeConfigDocument(parseYaml(raw));

  return workspaceConfigFileSchema.parse(parsed);
}

export { appConfigSchema, workspaceConfigFileSchema };

export { reasoningEffortSchema };
