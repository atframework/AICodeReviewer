import { z } from "zod";

import { ConfigError, formatConfigPath, reasoningEffortSchema, type ConfigEntityKind, type ConfigEntityRef } from "./config-format.js";

// ---------------------------------------------------------------------------
// Typed passthrough DTO + kind capability validation (P0 closeout)
//
// trigger/channel/provider schemas are `.passthrough()`: unknown keys are
// preserved losslessly, so the Zod layer alone cannot type-check KNOWN
// extension fields or reject a known field attached to a kind whose runtime
// consumer never reads it. This module is the publish-time gate for database
// records (spec §6 capability matrix, §7.1 prepare). Field sets and types are
// verified against the consumers in packages/server/src/bootstrap.ts
// (resolveModelProviderFields, resolveP4TriggerConfig, resolveSvnTriggerConfig,
// createChannelPublisherFromConfig) and packages/server/src/*-webhook.ts.
// Unknown keys are NOT rejected here — they are preserved unmanaged extensions.
// ---------------------------------------------------------------------------

const nonEmptyString = z.string().min(1);
const stringArray = z.array(nonEmptyString);
const stringRecord = z.record(nonEmptyString, z.string());

type FieldMap = Readonly<Record<string, z.ZodTypeAny>>;

// ---------------------------------------------------------------------------
// Providers (consumer: bootstrap.ts resolveModelProviderFields +
// applyModelCatalogProviderFields; LLM client factory packages/llm/src/index.ts)
// ---------------------------------------------------------------------------

/**
 * Catalog metadata hints mirrored from server MODEL_CATALOG_FIELD_KEY_MAP
 * (packages/server/src/model-catalog-service.ts). Keep in sync with
 * MODEL_CATALOG_FIELD_ROWS in config-components.ts — the inventory gate test
 * asserts key-set parity. `catalog_id` is declared on the provider schema.
 */
export const MODEL_CATALOG_HINT_FIELDS: FieldMap = {
  context_window: z.number().positive(),
  max_input_tokens: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  cost_input_per_mtok: z.number().nonnegative(),
  cost_output_per_mtok: z.number().nonnegative(),
  cost_cache_read_per_mtok: z.number().nonnegative(),
  cost_cache_write_per_mtok: z.number().nonnegative(),
  cost_reasoning_per_mtok: z.number().nonnegative(),
  cost_input_audio_per_mtok: z.number().nonnegative(),
  cost_output_audio_per_mtok: z.number().nonnegative(),
  supports_tool_call: z.boolean(),
  supports_attachment: z.boolean(),
  supports_vision: z.boolean(),
  supports_cache_prompt: z.boolean(),
  supports_reasoning: z.boolean(),
  supported_reasoning_efforts: z.array(reasoningEffortSchema),
  default_reasoning_effort: reasoningEffortSchema,
  thinking_modes: stringArray,
  supports_interleaved_reasoning: z.boolean(),
  interleaved_reasoning_field: nonEmptyString,
  supports_structured_output: z.boolean(),
  supports_temperature: z.boolean(),
  supports_streaming: z.boolean(),
  supports_logprobs: z.boolean(),
  supports_search: z.boolean(),
  supports_computer_use: z.boolean(),
  native_tool_capabilities: stringArray,
  supported_request_parameters: stringArray,
  unsupported_request_parameters: stringArray,
  input_modalities: stringArray,
  output_modalities: stringArray,
  display_name: nonEmptyString,
  family: nonEmptyString,
  knowledge_cutoff: nonEmptyString,
  training_cutoff: nonEmptyString,
  release_date: nonEmptyString,
  last_updated: nonEmptyString,
  // Enum values live in packages/llm (core cannot import it); membership is
  // enforced by the consumer's readStringEnum, the DTO pins the scalar type.
  model_status: nonEmptyString,
  open_weights: z.boolean(),
  license: nonEmptyString,
  model_links: stringRecord,
  provider_display_name: nonEmptyString,
  provider_npm_package: nonEmptyString,
  provider_env_vars: stringArray,
  provider_api_base_url: nonEmptyString,
  provider_docs_url: nonEmptyString,
  provider_model_aliases: stringArray,
  provider_model_ids: stringArray,
  preferred_endpoint: nonEmptyString,
  latency_class: nonEmptyString,
  priority_tier_supported: z.boolean(),
  rate_limit_tier: nonEmptyString,
  concurrency_limit: z.number().int().positive(),
  throughput_hint_tokens_per_second: z.number().positive(),
};

/**
 * Kind-agnostic provider passthrough fields. Request-level override types
 * mirror modelRequestOverridesSchema (config.ts) — keep the shapes aligned.
 */
export const PROVIDER_PASSTHROUGH_FIELDS: FieldMap = {
  organization: nonEmptyString,
  extra_headers: stringRecord,
  extra_body: z.record(nonEmptyString, z.unknown()),
  extra_params: z.record(nonEmptyString, z.unknown()),
  http_proxy: nonEmptyString,
  timeout_ms: z.number().positive(),
  max_retries: z.number().int().nonnegative(),
  reasoning_effort: reasoningEffortSchema,
  thinking_level: z.enum(["off", "minimal", "low", "medium", "high", "max"]),
  thinking_budget_tokens: z.number().int().positive(),
  thinking: z.object({ enabled: z.boolean() }).passthrough(),
  response_format: z.object({ kind: z.enum(["json_schema", "json_object", "text"]) }).passthrough(),
  tool_choice: z.union([z.enum(["auto", "none", "required"]), z.record(nonEmptyString, z.unknown())]),
  parallel_tool_calls: z.boolean(),
  seed: z.number().int(),
  logit_bias: z.record(nonEmptyString, z.number()),
  drop_params: stringArray,
  allowed_openai_params: stringArray,
  ...MODEL_CATALOG_HINT_FIELDS,
};

/** Kind-conditional provider fields (spec §6 provider row). */
export const PROVIDER_KIND_FIELDS: Readonly<Record<string, FieldMap>> = {
  vertex_ai: {
    vertex_project: nonEmptyString,
    vertex_location: nonEmptyString,
    google_application_credentials_env: nonEmptyString,
  },
  bedrock: {
    aws_region: nonEmptyString,
    aws_access_key_env: nonEmptyString,
    aws_secret_key_env: nonEmptyString,
    aws_session_token_env: nonEmptyString,
    aws_profile: nonEmptyString,
  },
  anthropic: {
    anthropic_version: nonEmptyString,
    anthropic_beta: stringArray,
    cache_control: z.enum(["ephemeral", "off"]),
  },
};

// ---------------------------------------------------------------------------
// Triggers (consumers: bootstrap.ts buildWebhookConfigFromTrigger,
// resolveP4TriggerConfig, resolveSvnTriggerConfig, withRepoMappings,
// createVcsAdapterFromConfig; github-app-token.ts resolveGithubAppTriggerAuth)
// ---------------------------------------------------------------------------

/** Declared on triggerSchema but consumed only by p4/svn adapters. */
const TRIGGER_FILE_FILTER_FIELDS: FieldMap = {
  watch_path: stringArray,
  include_cr_file: stringArray,
  exclude_cr_file: stringArray,
};

const TRIGGER_GIT_FIELDS: FieldMap = {
  webhook_secret_env: nonEmptyString,
  token_env: nonEmptyString,
  base_url: nonEmptyString,
  repos: z.array(z.object({ match: nonEmptyString, workspace: nonEmptyString }).passthrough()),
};

export const TRIGGER_KIND_FIELDS: Readonly<Record<string, FieldMap>> = {
  gitea: TRIGGER_GIT_FIELDS,
  forgejo: TRIGGER_GIT_FIELDS,
  github: TRIGGER_GIT_FIELDS,
  gitlab: TRIGGER_GIT_FIELDS,
  p4: {
    port: nonEmptyString,
    user_env: nonEmptyString,
    ticket_env: nonEmptyString,
    password_env: nonEmptyString,
    depot_path: nonEmptyString,
    streams: stringArray,
    workspace: nonEmptyString,
    ...TRIGGER_FILE_FILTER_FIELDS,
  },
  svn: {
    repository_url: nonEmptyString,
    username_env: nonEmptyString,
    password_env: nonEmptyString,
    trust_server_cert: z.boolean(),
    ...TRIGGER_FILE_FILTER_FIELDS,
  },
  // scheduled/manual have no runtime resolvers yet (schema-only kinds); only
  // schema-declared fields are managed, so the capability map is empty.
  scheduled: {},
  manual: {},
};

/** Declared fields whose consumer set is narrower than the schema allows. */
const TRIGGER_DECLARED_KIND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // app is declared on triggerSchema; only the github kind consumes it.
  app: ["github"],
  // File filters are declared for every kind but only p4/svn read them.
  watch_path: ["p4", "svn"],
  include_cr_file: ["p4", "svn"],
  exclude_cr_file: ["p4", "svn"],
};

// ---------------------------------------------------------------------------
// Channels (consumer: bootstrap.ts createChannelPublisherFromConfig kind
// branches + shared rendering block; 9 publishable kinds)
// ---------------------------------------------------------------------------

/** Kinds with a publisher implementation; anything else can never publish. */
export const CHANNEL_KINDS = [
  "gitea_pr_review",
  "github_pr_review",
  "github_issue",
  "github_problem_issue",
  "gitlab_mr_review",
  "gitea_issue",
  "gitea_problem_issue",
  "feishu_bot",
  "wecom_bot",
] as const;

/** Passthrough keys shared by every channel kind (rendering/token/repoRef). */
const CHANNEL_COMMON_PASSTHROUGH_FIELDS: FieldMap = {
  base_url: nonEmptyString,
  token_env: nonEmptyString,
  owner: nonEmptyString,
  repo: nonEmptyString,
};


const GIT_PR_REVIEW_FIELDS: FieldMap = {
  ...CHANNEL_COMMON_PASSTHROUGH_FIELDS,
};
const GITHUB_PROBLEM_ISSUE_FIELDS: FieldMap = {
  ...CHANNEL_COMMON_PASSTHROUGH_FIELDS,
  labels: stringArray,
};
const GITLAB_MR_REVIEW_FIELDS: FieldMap = {
  ...CHANNEL_COMMON_PASSTHROUGH_FIELDS,
  project_id: z.union([nonEmptyString, z.number().int().positive()]),
  merge_request_iid: z.number().int().positive(),
};
const GITEA_PROBLEM_ISSUE_FIELDS: FieldMap = {
  ...CHANNEL_COMMON_PASSTHROUGH_FIELDS,
  // label_ids is schema-declared (number[]), so no passthrough DTO needed.
};
const FEISHU_BOT_FIELDS: FieldMap = {
  ...CHANNEL_COMMON_PASSTHROUGH_FIELDS,
  webhook_url_env: nonEmptyString,
  secret_env: nonEmptyString,
};
const WECOM_BOT_FIELDS: FieldMap = {
  ...CHANNEL_COMMON_PASSTHROUGH_FIELDS,
  webhook_url_env: nonEmptyString,
  mentioned_mobile_list: stringArray,
};

export const CHANNEL_KIND_FIELDS: Readonly<Record<string, FieldMap>> = {
  gitea_pr_review: GIT_PR_REVIEW_FIELDS,
  github_pr_review: GIT_PR_REVIEW_FIELDS,
  github_issue: { ...CHANNEL_COMMON_PASSTHROUGH_FIELDS },
  github_problem_issue: GITHUB_PROBLEM_ISSUE_FIELDS,
  gitlab_mr_review: GITLAB_MR_REVIEW_FIELDS,
  gitea_issue: { ...CHANNEL_COMMON_PASSTHROUGH_FIELDS },
  gitea_problem_issue: GITEA_PROBLEM_ISSUE_FIELDS,
  feishu_bot: FEISHU_BOT_FIELDS,
  wecom_bot: WECOM_BOT_FIELDS,
};

/** Declared channel fields allowed per kind (consumer-verified matrix). */
const CHANNEL_DECLARED_KIND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  severity_label_prefix: ["gitea_pr_review", "github_pr_review", "github_problem_issue", "gitlab_mr_review", "gitea_problem_issue"],
  severity_label_colors: ["gitea_pr_review", "github_pr_review", "github_problem_issue", "gitlab_mr_review", "gitea_problem_issue"],
  review_mode: ["gitea_pr_review", "github_pr_review"],
  review_event: ["gitea_pr_review", "github_pr_review"],
  review_update_strategy: ["gitea_pr_review", "github_pr_review"],
  marker_prefix: ["github_problem_issue", "gitea_problem_issue"],
  marker_label: ["github_problem_issue", "gitea_problem_issue"],
  issue_mode: ["github_problem_issue", "gitea_problem_issue"],
  resolved_action: ["github_problem_issue", "gitea_problem_issue"],
  assign_committer: ["github_problem_issue", "gitea_problem_issue"],
  owners_file: ["github_problem_issue", "gitea_problem_issue"],
  add_owners_as_assignees: ["github_problem_issue", "gitea_problem_issue"],
  notify_feishu: ["github_problem_issue", "gitea_problem_issue"],
  labels: ["github_problem_issue"],
  label_ids: ["gitea_problem_issue"],
};

/** resolved_action values each problem-issue dispatcher actually honors. */
const CHANNEL_RESOLVED_ACTION_VALUES: Readonly<Record<string, readonly string[]>> = {
  github_problem_issue: ["none", "close", "mark_resolved"],
  gitea_problem_issue: ["none", "close", "mark_resolved", "delete"],
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface CapabilityContext {
  readonly entity: ConfigEntityRef;
  readonly path: readonly string[];
}

function unsupported(context: CapabilityContext, field: string, kind: string): never {
  throw new ConfigError(
    "unsupported_capability",
    `${context.entity.kind} "${context.entity.id}" (kind "${kind}") has no runtime consumer for "${field}"; the field would be silently ignored.`,
    { entity: context.entity, path: [...context.path, field] },
  );
}

function checkDeclaredKindFields(
  value: Record<string, unknown>,
  kind: string,
  declared: Readonly<Record<string, readonly string[]>>,
  context: CapabilityContext,
): void {
  for (const [field, kinds] of Object.entries(declared)) {
    if (value[field] !== undefined && !kinds.includes(kind)) {
      unsupported(context, field, kind);
    }
  }
}

function checkPassthroughFields(
  value: Record<string, unknown>,
  kind: string,
  kindFields: FieldMap,
  otherKindFields: readonly FieldMap[],
  context: CapabilityContext,
): void {
  for (const [field, schema] of Object.entries(kindFields)) {
    const fieldValue = value[field];
    if (fieldValue === undefined) {
      continue;
    }
    const parsed = schema.safeParse(fieldValue);
    if (!parsed.success) {
      throw new ConfigError(
        "invalid_field_type",
        `${context.entity.kind} "${context.entity.id}" field "${formatConfigPath([...context.path, field])}" has an invalid value: ${parsed.error.issues[0]?.message ?? "type mismatch"}.`,
        { entity: context.entity, path: [...context.path, field], cause: parsed.error },
      );
    }
  }
  // A managed passthrough field of a DIFFERENT kind is dead config here.
  for (const other of otherKindFields) {
    for (const field of Object.keys(other)) {
      if (kindFields[field] === undefined && value[field] !== undefined) {
        unsupported(context, field, kind);
      }
    }
  }
}

function validateProviderCapabilities(value: Record<string, unknown>, context: CapabilityContext): void {
  const kind = typeof value.kind === "string" ? value.kind : "";
  checkPassthroughFields(
    value,
    kind,
    { ...PROVIDER_PASSTHROUGH_FIELDS, ...(PROVIDER_KIND_FIELDS[kind] ?? {}) },
    Object.values(PROVIDER_KIND_FIELDS),
    context,
  );
}

function validateTriggerCapabilities(value: Record<string, unknown>, context: CapabilityContext): void {
  const kind = typeof value.kind === "string" ? value.kind : "";
  checkDeclaredKindFields(value, kind, TRIGGER_DECLARED_KIND_FIELDS, context);
  checkPassthroughFields(value, kind, TRIGGER_KIND_FIELDS[kind] ?? {}, Object.values(TRIGGER_KIND_FIELDS), context);
}

function validateChannelCapabilities(value: Record<string, unknown>, context: CapabilityContext): void {
  const kind = typeof value.kind === "string" ? value.kind : "";
  if (!(CHANNEL_KINDS as readonly string[]).includes(kind)) {
    throw new ConfigError(
      "unsupported_capability",
      `channel "${context.entity.id}" has unknown kind "${kind}"; no publisher exists for it.`,
      { entity: context.entity, path: [...context.path, "kind"] },
    );
  }
  checkDeclaredKindFields(value, kind, CHANNEL_DECLARED_KIND_FIELDS, context);
  const resolvedAction = value.resolved_action;
  if (typeof resolvedAction === "string" && kind in CHANNEL_RESOLVED_ACTION_VALUES) {
    const allowed = CHANNEL_RESOLVED_ACTION_VALUES[kind]!;
    if (!allowed.includes(resolvedAction)) {
      throw new ConfigError(
        "unsupported_capability",
        `channel "${context.entity.id}" (kind "${kind}") does not honor resolved_action "${resolvedAction}".`,
        { entity: context.entity, path: [...context.path, "resolved_action"] },
      );
    }
  }
  checkPassthroughFields(value, kind, CHANNEL_KIND_FIELDS[kind] ?? {}, Object.values(CHANNEL_KIND_FIELDS), context);
}

/**
 * Publish-time typed DTO + kind capability validation for one entity record
 * value (spec §6 matrix). Applies to provider/trigger/channel records; other
 * collections have no passthrough surface and are skipped. Unknown extension
 * keys are preserved and not rejected.
 */
export function validateEntityCapabilities(kind: ConfigEntityKind, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.name === "string" ? record.name : typeof record.id === "string" ? record.id : "?";
  const context: CapabilityContext = { entity: { kind, id }, path: [] };
  if (kind === "provider") {
    validateProviderCapabilities(record, context);
  } else if (kind === "trigger") {
    validateTriggerCapabilities(record, context);
  } else if (kind === "channel") {
    validateChannelCapabilities(record, context);
  }
}
