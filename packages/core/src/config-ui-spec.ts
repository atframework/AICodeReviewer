/**
 * ConfigUiSpec builder (P6, architecture §3.16). Derives the serializable dashboard
 * spec from CONFIG_FIELD_INVENTORY, the appConfigSchema / routingRuleSchema
 * leaves, and the capability matrices; the only hand-written input is the
 * PAGE_LAYOUT table (pages → sections → path-prefix assignment, labels,
 * optionsSource, visibleWhen). Node-side module: never browser-served, so
 * runtime imports stay limited to the schema/inventory/capability sources.
 *
 * Conventions (frozen with CoreRuntime):
 * - Entity-scope field id: "<entityKind>:<record-relative path>" (e.g.
 *   "provider:kind", "workspace:review.max_files"); path tokens are relative
 *   to the entity record root.
 * - Globals-scope field id: "<firstPathToken>:<rest>" (e.g.
 *   "llm:default_model_chain", "workspaces:defaults.review.max_files"); path
 *   tokens are the FULL document path so encodeChanges can emit set/unset
 *   verbatim.
 * - decodeDraft partitions by id: entity-scope ⟺ id starts with
 *   "<page.entity.kind>:".
 * - Map collections (model_group, workspace) get a synthetic "<kind>:$name"
 *   text field with path [] bound to the record name/key; the model_group
 *   record value (an array) is the single "model_group:entries" ordered-list
 *   field (also path []).
 * - Layered rows (defaults/workspace inheritance layers, route analysis
 *   overrides) use binding "inherit-or-override"; a row's chainOf surfaces in
 *   the capability note as "inherits from <chainOf>".
 */

import {
  CHANNEL_DECLARED_KIND_FIELDS,
  CHANNEL_KINDS,
  CHANNEL_KIND_FIELDS,
  CHANNEL_RESOLVED_ACTION_VALUES,
  PROVIDER_KIND_FIELDS,
  TRIGGER_DECLARED_KIND_FIELDS,
  TRIGGER_KIND_FIELDS,
} from "./config-capabilities.js";
import {
  CONFIG_FIELD_INVENTORY,
  CONFIG_FIELD_INVENTORY_BY_PATH,
  MODEL_CATALOG_FIELD_ROWS,
  collectSchemaFieldPaths,
  valueKindFromSchemaType,
  type ConfigFieldSpec,
  type SchemaFieldLeaf,
} from "./config-components.js";
import { ConfigError } from "./config-format.js";
import { appConfigSchema, llmProviderSchema, routingRuleSchema, triggerSchema } from "./config.js";
import type {
  ConfigUiControlKind,
  ConfigUiEntityKind,
  ConfigUiField,
  ConfigUiOption,
  ConfigUiPage,
  ConfigUiSection,
  ConfigUiSpec,
  ConfigUiValueKind,
  ConfigUiVisibleWhen,
} from "./config-ui-runtime.js";

// ---------------------------------------------------------------------------
// Static option tables (schema enums the walker cannot surface: enum[] array
// elements, free-form strings with a de-facto value set, inline enums).
// Parity with the source schemas is asserted by config-ui-spec.test.ts.
// ---------------------------------------------------------------------------

/** review.output_language is a free-form string; these are the supported prompts. */
const OUTPUT_LANGUAGE_VALUES = ["zh-CN", "en-US"] as const;

/** Model chain entry roles (mirrors the llmModelChainEntrySchema role enum). */
const MODEL_ROLE_VALUES = ["light", "heavy", "any"] as const;

/** Mirrors SCHEDULE_WEEKDAYS in weekly-schedule.ts (test asserts parity). */
const SCHEDULE_WEEKDAY_VALUES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Mirrors reviewTargetKindSchema in review-event.ts (test asserts parity). */
const REVIEW_TARGET_KIND_VALUES = ["pull_request", "push", "commit", "issue", "manual", "scheduled"] as const;

/** Mirrors the inline triageSchema enums in config.ts (test asserts parity). */
const TRIAGE_ACTION_VALUES = ["close"] as const;
const TRIAGE_CATEGORY_VALUES = ["spam", "invalid", "duplicate", "resolved", "out_of_scope", "stale"] as const;
const TRIAGE_EVENT_VALUES = ["issues"] as const;

/** Scalar arm of the tool_choice union (record payloads stay free-form). */
const TOOL_CHOICE_VALUES = ["auto", "none", "required"] as const;

/** Static options keyed by canonical (chainOf-resolved) inventory path. */
const STATIC_OPTIONS_BY_CANONICAL_PATH: Readonly<Record<string, readonly string[]>> = {
  "review.output_language": OUTPUT_LANGUAGE_VALUES,
  "review.auto_commit.schedule.rules[].days": SCHEDULE_WEEKDAY_VALUES,
  "review.pull_request.schedule.rules[].days": SCHEDULE_WEEKDAY_VALUES,
  "compression.summarize_model_role": MODEL_ROLE_VALUES,
};

/** Static options keyed by exact inventory path (no canonical twin). */
const STATIC_OPTIONS_BY_EXACT_PATH: Readonly<Record<string, readonly string[]>> = {
  "outputs.channels[].kind": CHANNEL_KINDS,
  "workspaces.instances.*.triage.actions": TRIAGE_ACTION_VALUES,
  "workspaces.instances.*.triage.categories_close": TRIAGE_CATEGORY_VALUES,
  "workspaces.instances.*.triage.events": TRIAGE_EVENT_VALUES,
  "llm.model_chain.*[].overrides.tool_choice": TOOL_CHOICE_VALUES,
};

/** Static options keyed by routing leaf path (no inventory twin at all). */
const STATIC_OPTIONS_BY_ROUTING_PATH: Readonly<Record<string, readonly string[]>> = {
  "match.target_kinds": REVIEW_TARGET_KIND_VALUES,
};

// ---------------------------------------------------------------------------
// Dynamic options sources (served by GET /options/:source; design §4)
// ---------------------------------------------------------------------------

const OPTIONS_SOURCES = [
  { id: "providers", label: "Providers" },
  { id: "model_groups", label: "Model groups" },
  { id: "triggers", label: "Triggers" },
  { id: "channels", label: "Channels" },
  { id: "workspaces", label: "Workspaces" },
  { id: "secret_envs", label: "Secret environment variables" },
  { id: "path_template_variables", label: "Path template variables" },
] as const;

/** Model group reference fields, compared by canonical (chainOf) path. */
const MODEL_GROUP_REF_CANONICALS: Readonly<Record<string, true>> = {
  "llm.default_model_chain": true,
  "llm.triage_model_chain": true,
};

/** Trigger reference fields, compared by exact inventory path. */
const TRIGGER_REF_PATHS: Readonly<Record<string, true>> = {
  "outputs.channels[].trigger": true,
  "outputs.routes.default.match.trigger": true,
  "outputs.routes.rules[].match.trigger": true,
  "workspaces.instances.*.source_repo.trigger": true,
  "workspaces.instances.*.match[].triggers": true,
};

/** Channel reference fields, compared by exact inventory path. */
const CHANNEL_REF_PATHS: Readonly<Record<string, true>> = {
  "outputs.routes.default.line_comments": true,
  "outputs.routes.default.summary": true,
  "outputs.routes.rules[].line_comments": true,
  "outputs.routes.rules[].summary": true,
  "workspaces.defaults.outputs.line_comments": true,
  "workspaces.defaults.outputs.summary": true,
  "workspaces.instances.*.outputs.line_comments": true,
  "workspaces.instances.*.outputs.summary": true,
};

/** Routing leaf → options source (reference fields with no inventory twin). */
const ROUTING_OPTIONS_SOURCE: Readonly<Record<string, string>> = {
  "match.triggers": "triggers",
  workspace: "workspaces",
  "analysis.model_chain": "model_groups",
  "analysis.triage_model_chain": "model_groups",
  "outputs.line_comments": "channels",
  "outputs.summary": "channels",
};

// ---------------------------------------------------------------------------
// Readonly rules (design §3: bootstrap-owned + unwired rows are display-only)
// ---------------------------------------------------------------------------

const BOOTSTRAP_READONLY_REASON = "bootstrap-owned; edit the config file";

function isBootstrapReadonly(row: ConfigFieldSpec): boolean {
  // workspaces.root is bootstrap-owned even though the row rides the workspace entity.
  return row.ownership === "bootstrap" || row.path === "workspaces.root";
}

function readonlyReasonForRow(row: ConfigFieldSpec): string | undefined {
  if (!row.wired) {
    return row.status;
  }
  if (isBootstrapReadonly(row)) {
    return BOOTSTRAP_READONLY_REASON;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// visibleWhen assignments (kept minimal per design §3)
// ---------------------------------------------------------------------------

const VISIBLE_WHEN_RULES: readonly { readonly page: string; readonly prefix: string; readonly field: string; readonly equals: string | boolean }[] = [
  // Multiselect contains semantics: visible when providers CONTAINS "searxng".
  { page: "agent", prefix: "agent.web_search.searxng.", field: "agent:web_search.providers", equals: "searxng" },
  { page: "review", prefix: "review.reflection.memory.", field: "review:reflection.enabled", equals: true },
];

function visibleWhenFor(pageId: string, displayPath: string): ConfigUiVisibleWhen | undefined {
  const rule = VISIBLE_WHEN_RULES.find((candidate) => candidate.page === pageId && displayPath.startsWith(candidate.prefix));
  if (rule === undefined) {
    return undefined;
  }
  return { field: rule.field, equals: rule.equals };
}

// ---------------------------------------------------------------------------
// Kind applicability (capability matrices inverted to field → kinds)
// ---------------------------------------------------------------------------

type FieldKindLookup = ReadonlyMap<string, readonly string[]>;

function buildFieldKindLookup(
  kindFields: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  declared: Readonly<Record<string, readonly string[]>>,
): FieldKindLookup {
  const out = new Map<string, string[]>();
  const push = (key: string, kind: string): void => {
    const existing = out.get(key);
    if (existing === undefined) {
      out.set(key, [kind]);
    } else if (!existing.includes(kind)) {
      existing.push(kind);
    }
  };
  for (const [kind, fields] of Object.entries(kindFields)) {
    for (const key of Object.keys(fields)) {
      push(key, kind);
    }
  }
  for (const [key, kinds] of Object.entries(declared)) {
    for (const kind of kinds) {
      push(key, kind);
    }
  }
  return out;
}

const PROVIDER_FIELD_KINDS = buildFieldKindLookup(PROVIDER_KIND_FIELDS, { api_version: ["azure_openai"] });
const TRIGGER_FIELD_KINDS = buildFieldKindLookup(TRIGGER_KIND_FIELDS, TRIGGER_DECLARED_KIND_FIELDS);
const CHANNEL_FIELD_KINDS = buildFieldKindLookup(CHANNEL_KIND_FIELDS, CHANNEL_DECLARED_KIND_FIELDS);

function lookupKinds(lookup: FieldKindLookup, relativePath: string): readonly string[] | undefined {
  const withoutWildcard = relativePath.endsWith(".*") ? relativePath.slice(0, -2) : relativePath;
  const dot = withoutWildcard.indexOf(".");
  const parent = dot > 0 ? withoutWildcard.slice(0, dot) : withoutWildcard;
  return lookup.get(relativePath) ?? lookup.get(withoutWildcard) ?? lookup.get(parent);
}

function kindOptionsForPage(pageId: string): readonly string[] {
  if (pageId === "providers") {
    return [...llmProviderSchema.shape.kind.options];
  }
  if (pageId === "triggers") {
    return [...triggerSchema.shape.kind.options];
  }
  return [...CHANNEL_KINDS];
}

interface FieldKindData {
  readonly lookup: FieldKindLookup;
  readonly allKinds: readonly string[];
}

const KIND_DATA_BY_PAGE: Readonly<Record<string, FieldKindData>> = {
  providers: { lookup: PROVIDER_FIELD_KINDS, allKinds: kindOptionsForPage("providers") },
  triggers: { lookup: TRIGGER_FIELD_KINDS, allKinds: kindOptionsForPage("triggers") },
  channels: { lookup: CHANNEL_FIELD_KINDS, allKinds: kindOptionsForPage("channels") },
};

function kindsForField(pageId: string, scope: "entity" | "globals", relativePath: string): readonly string[] | undefined {
  if (scope !== "entity") {
    return undefined;
  }
  const data = KIND_DATA_BY_PAGE[pageId];
  if (data === undefined) {
    return undefined;
  }
  const kinds = lookupKinds(data.lookup, relativePath);
  if (kinds === undefined) {
    return undefined;
  }
  // A field every kind accepts carries no restriction.
  if (data.allKinds.every((kind) => kinds.includes(kind))) {
    return undefined;
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// Capability notes
// ---------------------------------------------------------------------------

function capabilityForRow(row: ConfigFieldSpec, pageId: string, scope: "entity" | "globals", relativePath: string): string | undefined {
  const parts: string[] = [];
  if (row.capability !== undefined) {
    parts.push(row.capability);
  }
  if (pageId === "channels" && scope === "entity" && relativePath === "resolved_action") {
    const perKind = Object.entries(CHANNEL_RESOLVED_ACTION_VALUES)
      .map(([kind, values]) => `${kind} allows ${values.join("/")}`)
      .join("; ");
    parts.push(`resolved_action values per kind: ${perKind} (the server enforces the per-kind set)`);
  }
  if (row.chainOf !== undefined) {
    parts.push(`inherits from ${row.chainOf}`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Options derivation
// ---------------------------------------------------------------------------

function toOptions(values: readonly string[]): readonly ConfigUiOption[] {
  return values.map((value) => ({ value }));
}

/** Options for an inventory row: schema leaf enums → canonical statics → exact statics. */
function optionsForRow(row: ConfigFieldSpec, leavesByPath: ReadonlyMap<string, SchemaFieldLeaf>): readonly ConfigUiOption[] | undefined {
  const leaf = leavesByPath.get(row.path);
  if (leaf?.enumValues !== undefined) {
    return toOptions(leaf.enumValues);
  }
  const canonical = row.chainOf ?? row.path;
  const staticCanonical = STATIC_OPTIONS_BY_CANONICAL_PATH[canonical];
  if (staticCanonical !== undefined) {
    return toOptions(staticCanonical);
  }
  const staticExact = STATIC_OPTIONS_BY_EXACT_PATH[row.path];
  if (staticExact !== undefined) {
    return toOptions(staticExact);
  }
  return undefined;
}

function controlBasedOptionsSource(control: ConfigUiControlKind): string | undefined {
  if (control === "secret-ref") {
    return "secret_envs";
  }
  if (control === "path-template") {
    return "path_template_variables";
  }
  return undefined;
}

function optionsSourceForRow(row: ConfigFieldSpec, control: ConfigUiControlKind): string | undefined {
  const canonical = row.chainOf ?? row.path;
  if (MODEL_GROUP_REF_CANONICALS[canonical] === true) {
    return "model_groups";
  }
  if (TRIGGER_REF_PATHS[row.path] === true) {
    return "triggers";
  }
  if (CHANNEL_REF_PATHS[row.path] === true) {
    return "channels";
  }
  return controlBasedOptionsSource(control);
}

// ---------------------------------------------------------------------------
// Page layout table (the only hand-written input; design §3)
// ---------------------------------------------------------------------------

export interface ConfigUiSectionLayout {
  readonly id: string;
  readonly label: string;
  readonly scope: "entity" | "globals";
  /** First matching prefix wins; display paths are entity-relative or full. */
  readonly match: readonly string[];
  readonly collapsed?: boolean;
}

export interface ConfigUiEntityLayout {
  readonly kind: ConfigUiEntityKind;
  readonly collection: string;
  readonly idField: string | null;
  readonly valueShape: "object" | "array";
  readonly kindField?: string;
}

export interface ConfigUiPageLayout {
  readonly id: string;
  readonly label: string;
  readonly entity?: ConfigUiEntityLayout;
  readonly globals?: boolean;
  readonly sections: readonly ConfigUiSectionLayout[];
}

/** Provider catalog-hint field names (passthrough keys consumed into ModelSpec). */
const PROVIDER_CATALOG_MATCHES: readonly string[] = [
  "catalog_provider",
  "catalog_id",
  ...MODEL_CATALOG_FIELD_ROWS.map(([suffix]) => (suffix === "model_links.*" ? "model_links" : suffix)),
];

export const PAGE_LAYOUT: readonly ConfigUiPageLayout[] = [
  {
    id: "providers",
    label: "Providers",
    entity: { kind: "provider", collection: "providers", idField: "id", valueShape: "object", kindField: "kind" },
    sections: [
      { id: "identity", label: "Identity", scope: "entity", match: ["id", "kind"] },
      { id: "connection", label: "Connection", scope: "entity", match: ["base_url", "api_key_env", "api_version", "organization", "http_proxy", "timeout_ms", "max_retries"] },
      { id: "kind-specific", label: "Kind-specific", scope: "entity", match: ["vertex_", "aws_", "anthropic_", "cache_control"], collapsed: true },
      { id: "catalog", label: "Catalog metadata", scope: "entity", match: PROVIDER_CATALOG_MATCHES, collapsed: true },
      { id: "overrides", label: "Request overrides", scope: "entity", match: [""], collapsed: true },
    ],
  },
  {
    id: "model-groups",
    label: "Model groups",
    entity: { kind: "model_group", collection: "model_groups", idField: null, valueShape: "array" },
    globals: true,
    sections: [
      { id: "identity", label: "Group", scope: "entity", match: ["$name"] },
      { id: "entries", label: "Model entries", scope: "entity", match: ["entries"] },
      { id: "chains", label: "Model chains", scope: "globals", match: ["llm.default_model_chain", "llm.triage_model_chain"] },
      { id: "retry", label: "Retry & per-provider overrides", scope: "globals", match: ["llm.retry", "llm.per_provider_overrides"] },
      { id: "budget", label: "Budget", scope: "globals", match: ["llm.budget"] },
      { id: "catalog", label: "Model catalog", scope: "globals", match: ["llm.model_catalog"], collapsed: true },
    ],
  },
  {
    id: "triggers",
    label: "Triggers",
    entity: { kind: "trigger", collection: "triggers", idField: "name", valueShape: "object", kindField: "kind" },
    sections: [
      { id: "identity", label: "Identity", scope: "entity", match: ["name", "kind", "enabled"] },
      { id: "urls", label: "URL templates", scope: "entity", match: ["commit_url_template", "revision_url_template", "change_url_template"] },
      { id: "filters", label: "File filters", scope: "entity", match: ["watch_path", "include_cr_file", "exclude_cr_file"], collapsed: true },
      { id: "github", label: "GitHub App", scope: "entity", match: ["app"], collapsed: true },
      { id: "git", label: "Git servers", scope: "entity", match: ["token_env", "webhook_secret_env", "base_url", "repos"], collapsed: true },
      { id: "p4", label: "Perforce", scope: "entity", match: ["port", "user_env", "ticket_env", "password_env", "depot_path", "streams", "workspace"], collapsed: true },
      { id: "svn", label: "Subversion", scope: "entity", match: ["repository_url", "trust_server_cert"], collapsed: true },
    ],
  },
  {
    id: "channels",
    label: "Channels",
    entity: { kind: "channel", collection: "channels", idField: "name", valueShape: "object", kindField: "kind" },
    globals: true,
    sections: [
      { id: "identity", label: "Identity", scope: "entity", match: ["name", "kind", "trigger"] },
      { id: "mentions", label: "Mentions", scope: "entity", match: ["mention_author", "mention_fallback"] },
      { id: "policy", label: "Policies", scope: "entity", match: ["no_problems", "no_findings"] },
      { id: "urls", label: "URL templates", scope: "entity", match: ["commit_url_template", "revision_url_template", "change_url_template"] },
      { id: "problem", label: "Problem issues", scope: "entity", match: ["marker_prefix", "marker_label", "label_ids", "labels", "issue_mode", "resolved_action", "assign_committer", "owners_file", "add_owners_as_assignees", "notify_feishu"], collapsed: true },
      { id: "review", label: "PR review", scope: "entity", match: ["severity_label_prefix", "severity_label_colors", "review_mode", "review_event", "review_update_strategy"], collapsed: true },
      { id: "delivery", label: "Delivery", scope: "entity", match: [""], collapsed: true },
      { id: "rendering", label: "Rendering", scope: "globals", match: ["outputs.template_engine"] },
      { id: "policy-globals", label: "No-problems policy", scope: "globals", match: ["outputs.no_problems", "outputs.no_findings"] },
      { id: "authors", label: "Author resolution", scope: "globals", match: ["outputs.author_resolution"] },
      { id: "routes", label: "Legacy routes", scope: "globals", match: ["outputs.routes"], collapsed: true },
    ],
  },
  {
    id: "routing",
    label: "Routing",
    entity: { kind: "route", collection: "routes", idField: "id", valueShape: "object" },
    sections: [
      { id: "rule", label: "Rule", scope: "entity", match: ["id", "enabled", "priority", "workspace"] },
      { id: "match", label: "Match", scope: "entity", match: ["match"] },
      { id: "analysis", label: "Analysis", scope: "entity", match: ["analysis.model_chain", "analysis.triage_model_chain"] },
      { id: "compression", label: "Compression", scope: "entity", match: ["analysis.compression"], collapsed: true },
      { id: "agent", label: "Agent & sandbox", scope: "entity", match: ["analysis.agent", "analysis.sandbox"], collapsed: true },
      { id: "review", label: "Review overrides", scope: "entity", match: ["analysis.review"], collapsed: true },
      { id: "outputs", label: "Outputs", scope: "entity", match: ["outputs"] },
    ],
  },
  {
    id: "agent",
    label: "Agent",
    globals: true,
    sections: [
      { id: "general", label: "General", scope: "globals", match: ["agent.default", "agent.timeout_seconds", "agent.auto_approve"] },
      { id: "sandbox", label: "Sandbox", scope: "globals", match: ["agent.sandbox"] },
      { id: "compaction", label: "Context compaction", scope: "globals", match: ["agent.context_compaction"] },
      { id: "search", label: "Web search", scope: "globals", match: ["agent.web_search"] },
      { id: "compression", label: "Compression", scope: "globals", match: ["compression"] },
    ],
  },
  {
    id: "review",
    label: "Review",
    globals: true,
    sections: [
      { id: "general", label: "General", scope: "globals", match: ["review.languages_auto_detect", "review.include", "review.exclude", "review.max_files", "review.max_patch_bytes", "review.incremental", "review.skip_lgtm", "review.output_language", "review.commit_strategy", "review.log_thinking"] },
      { id: "auto-commit", label: "Auto commit", scope: "globals", match: ["review.auto_commit"], collapsed: true },
      { id: "pull-request", label: "Pull requests", scope: "globals", match: ["review.pull_request"], collapsed: true },
      { id: "git", label: "Git", scope: "globals", match: ["review.git"] },
      { id: "labels", label: "Labels", scope: "globals", match: ["review.labels"] },
      { id: "problem", label: "Problem issues", scope: "globals", match: ["review.problem_issue"] },
      { id: "fetch", label: "Fetch extra", scope: "globals", match: ["review.fetch_extra"] },
      { id: "reflection", label: "Reflection", scope: "globals", match: ["review.reflection"] },
    ],
  },
  {
    id: "workspaces",
    label: "Workspaces",
    entity: { kind: "workspace", collection: "workspaces", idField: null, valueShape: "object" },
    globals: true,
    sections: [
      { id: "layout", label: "Layout & cache", scope: "globals", match: ["workspaces.root", "workspaces.cache"] },
      { id: "defaults", label: "Defaults", scope: "globals", match: ["workspaces.defaults.model_chain", "workspaces.defaults.triage_model_chain", "workspaces.defaults.prompt"] },
      { id: "defaults-review", label: "Default review", scope: "globals", match: ["workspaces.defaults.review"], collapsed: true },
      { id: "defaults-agent", label: "Default agent & sandbox", scope: "globals", match: ["workspaces.defaults.agent", "workspaces.defaults.sandbox"], collapsed: true },
      { id: "defaults-outputs", label: "Default outputs", scope: "globals", match: ["workspaces.defaults.outputs"], collapsed: true },
      { id: "defaults-repos", label: "Default context repositories", scope: "globals", match: ["workspaces.defaults.context_repositories[]"], collapsed: true },
      { id: "identity", label: "Identity", scope: "entity", match: ["$name", "enabled", "source_repo", "work_path"] },
      { id: "models", label: "Models", scope: "entity", match: ["model_chain", "triage_model_chain", "agent.default"] },
      { id: "match", label: "Match rules", scope: "entity", match: ["match[]"] },
      { id: "triage", label: "Issue triage", scope: "entity", match: ["triage"], collapsed: true },
      { id: "prompt", label: "Prompt", scope: "entity", match: ["prompt"] },
      { id: "auth", label: "Authentication", scope: "entity", match: ["auth"] },
      { id: "review", label: "Review overrides", scope: "entity", match: ["review"], collapsed: true },
      { id: "agent", label: "Agent & sandbox overrides", scope: "entity", match: ["agent", "sandbox"], collapsed: true },
      { id: "outputs", label: "Output overrides", scope: "entity", match: ["outputs"], collapsed: true },
      { id: "repos", label: "Context repositories", scope: "entity", match: ["context_repositories[]"], collapsed: true },
    ],
  },
  {
    id: "queue",
    label: "Queue",
    globals: true,
    sections: [
      { id: "workers", label: "Workers", scope: "globals", match: ["queue.workers"] },
      { id: "rate", label: "Rate limits", scope: "globals", match: ["queue.rate_limit"] },
      { id: "retry", label: "Retry", scope: "globals", match: ["queue.retry"] },
      { id: "dead-letter", label: "Dead letter", scope: "globals", match: ["queue.dead_letter"] },
      { id: "backend", label: "Backend (read-only)", scope: "globals", match: ["queue.kind", "queue.sqlite"] },
    ],
  },
  {
    id: "advanced",
    label: "Advanced",
    globals: true,
    sections: [
      { id: "server", label: "Server", scope: "globals", match: ["server"] },
      { id: "admin", label: "Admin", scope: "globals", match: ["admin"] },
      { id: "sources", label: "Config sources", scope: "globals", match: ["config_sources"] },
      { id: "storage", label: "Storage", scope: "globals", match: ["storage"] },
    ],
  },
  { id: "versions", label: "Versions", globals: false, sections: [] },
];

// ---------------------------------------------------------------------------
// Assignment rules (inventory path prefix → page; design §3)
// ---------------------------------------------------------------------------

const PAGE_ASSIGNMENT: readonly (readonly [string, string])[] = [
  ["llm.providers[].", "providers"],
  ["llm.", "model-groups"],
  ["triggers[].", "triggers"],
  ["outputs.channels[].", "channels"],
  ["outputs.", "channels"],
  ["review.", "review"],
  ["agent.", "agent"],
  ["compression.", "agent"],
  ["workspaces.", "workspaces"],
  ["queue.", "queue"],
  ["server.", "advanced"],
  ["admin.", "advanced"],
  ["config_sources.", "advanced"],
  ["storage.", "advanced"],
];

function pageIdForRow(row: ConfigFieldSpec): string | undefined {
  for (const [prefix, pageId] of PAGE_ASSIGNMENT) {
    if (row.path.startsWith(prefix)) {
      return pageId;
    }
  }
  /* v8 ignore next -- unreachable while PAGE_ASSIGNMENT covers the inventory; the U24 test is the completeness gate */
  return undefined;
}

/** Record path prefix per entity page (stripped to get record-relative paths). */
const ENTITY_PATH_PREFIX: Readonly<Record<string, string>> = {
  providers: "llm.providers[].",
  triggers: "triggers[].",
  channels: "outputs.channels[].",
  workspaces: "workspaces.instances.*.",
};

/** Entity record keys the schema requires (absent is NOT valid). */
const REQUIRED_ENTITY_KEYS: Readonly<Record<string, readonly string[]>> = {
  providers: ["id", "kind"],
  triggers: ["name", "kind"],
  channels: ["name", "kind"],
};

// ---------------------------------------------------------------------------
// Path + label helpers
// ---------------------------------------------------------------------------

/** "a.b[].c.*" → ["a", "b", "[]", "c", "*"] */
function tokensOf(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split(".")) {
    if (part.endsWith("[]")) {
      out.push(part.slice(0, -2), "[]");
    } else {
      out.push(part);
    }
  }
  return out;
}

/** ["a", "b", "[]", "c"] → "a.b[].c" */
function dotted(tokens: readonly string[]): string {
  let out = "";
  for (const token of tokens) {
    if (token === "[]") {
      out += "[]";
    } else {
      out = out === "" ? token : `${out}.${token}`;
    }
  }
  return out;
}

const WORD_DISPLAY: Readonly<Record<string, string>> = {
  id: "ID",
  api: "API",
  url: "URL",
  uri: "URI",
  http: "HTTP",
  json: "JSON",
  rps: "RPS",
  ttl: "TTL",
  s3: "S3",
  gb: "GB",
  mb: "MB",
  kb: "KB",
  usd: "USD",
  vcs: "VCS",
  iid: "IID",
  npm: "NPM",
  p4: "P4",
  svn: "SVN",
  llm: "LLM",
  sqlite: "SQLite",
  postgres: "PostgreSQL",
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
  forgejo: "Forgejo",
  feishu: "Feishu",
  wecom: "WeCom",
  searxng: "SearXNG",
  azure: "Azure",
  aws: "AWS",
  anthropic: "Anthropic",
  vertex: "Vertex",
  ollama: "Ollama",
  copilot: "Copilot",
  bedrock: "Bedrock",
};

/**
 * Concrete path tokens for spec fields: the "[]" (array item) and "*"
 * (record wildcard) markers are NOT valid tokens per the runtime's
 * classifyPathToken, so field.path drops them; the canonical family form
 * stays in the field id (e.g. id "workspace:match[].triggers" with path
 * ["match", "triggers"]).
 */
function concreteTokensOf(path: string): string[] {
  return tokensOf(path).filter((token) => token !== "[]" && token !== "*");
}

function humanize(token: string): string {
  const words = token.split("_").map((word) => WORD_DISPLAY[word] ?? word);
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** English label from the last meaningful path token. */
function labelFor(displayPath: string): string {
  const tokens = tokensOf(displayPath).filter((token) => token !== "*" && token !== "[]");
  // Every display path has at least one meaningful token (inventory/leaf paths).
  return humanize(tokens[tokens.length - 1]!);
}

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

function mapValueKindFor(control: ConfigUiControlKind, valueKind: ConfigFieldSpec["valueKind"]): "string" | "number" | "record" | undefined {
  if (control !== "map") {
    return undefined;
  }
  if (valueKind === "string" || valueKind === "number") {
    return valueKind;
  }
  return "record";
}

interface InventoryFieldContext {
  readonly leavesByPath: ReadonlyMap<string, SchemaFieldLeaf>;
  readonly pageId: string;
  readonly scope: "entity" | "globals";
  readonly displayPath: string;
  readonly fieldId: string;
  readonly pathTokens: readonly string[];
  readonly sectionId: string;
}

/**
 * Passthrough rows are schema-untyped (valueKind "record") but the inventory
 * control pins the effective value shape; the spec valueKind follows the
 * control for scalar controls so validateUiSpec control parity holds.
 */
const SCALAR_VALUE_KIND_BY_CONTROL: Readonly<Record<string, ConfigUiValueKind>> = {
  text: "string",
  number: "number",
  toggle: "boolean",
  select: "string",
  multiselect: "string[]",
  "secret-ref": "string",
  "path-template": "string",
};

function valueKindForRow(row: ConfigFieldSpec): ConfigUiValueKind {
  // A map field's value is the whole record; the entry type is mapValueKind.
  if (row.uiControl === "map") {
    return "record";
  }
  if (row.valueKind !== "record") {
    return row.valueKind;
  }
  return SCALAR_VALUE_KIND_BY_CONTROL[row.uiControl] ?? "record";
}

const TRIGGER_REPOS_ITEM_FIELDS_BASE = [
  { key: "match", label: "Match", control: "text" as const },
  { key: "workspace", label: "Workspace", control: "select" as const },
];

function buildInventoryField(row: ConfigFieldSpec, ctx: InventoryFieldContext): ConfigUiField {
  // Scalar lists stay scalar arrays (design §2): ordered-list is for row objects.
  const control = row.uiControl === "ordered-list" && row.valueKind !== "record" ? "multiselect" : row.uiControl;
  const options = optionsForRow(row, ctx.leavesByPath);
  const optionsSource = optionsSourceForRow(row, control);
  const visibleWhen = visibleWhenFor(ctx.pageId, ctx.displayPath);
  const kinds = kindsForField(ctx.pageId, ctx.scope, ctx.displayPath);
  const capability = capabilityForRow(row, ctx.pageId, ctx.scope, ctx.displayPath);
  const readonlyReason = readonlyReasonForRow(row);
  const mapValueKind = mapValueKindFor(control, row.valueKind);
  const required = REQUIRED_ENTITY_KEYS[ctx.pageId];
  const isRepos = ctx.pageId === "triggers" && ctx.displayPath === "repos";
  return {
    id: ctx.fieldId,
    path: ctx.pathTokens,
    control,
    valueKind: valueKindForRow(row),
    labelKey: ctx.fieldId,
    label: labelFor(ctx.displayPath),
    section: ctx.sectionId,
    optional: ctx.scope === "globals" || required === undefined || !required.includes(ctx.displayPath),
    binding: row.inheritance.includes("defaults") || row.inheritance.includes("workspace") ? "inherit-or-override" : "value",
    hasDefault: row.hasDefault,
    ...("defaultValue" in row ? { defaultValue: row.defaultValue } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(optionsSource !== undefined ? { optionsSource } : {}),
    ...(visibleWhen !== undefined ? { visibleWhen } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(readonlyReason !== undefined ? { readonlyReason } : {}),
    ...(mapValueKind !== undefined ? { mapValueKind } : {}),
    ...(isRepos ? { itemFields: buildTriggerReposItemFields(ctx.sectionId) } : {}),
  };
}

function buildTriggerReposItemFields(sectionId: string): readonly ConfigUiField[] {
  return TRIGGER_REPOS_ITEM_FIELDS_BASE.map((base) => ({
    id: `trigger:repos[].${base.key}`,
    path: [base.key],
    control: base.control,
    valueKind: "string" as const,
    labelKey: `trigger:repos[].${base.key}`,
    label: base.label,
    section: sectionId,
    optional: false,
    binding: "value" as const,
    hasDefault: false,
    ...(base.key === "workspace" ? { optionsSource: "workspaces" } : {}),
  }));
}

/** Synthetic map-collection name field (record key is the id; value holds no name). */
function syntheticNameField(kind: "model_group" | "workspace", sectionId: string): ConfigUiField {
  return {
    id: `${kind}:$name`,
    path: [],
    control: "text",
    valueKind: "string",
    labelKey: `${kind}:$name`,
    label: "Name",
    section: sectionId,
    optional: false,
    binding: "value",
    hasDefault: false,
  };
}

const MODEL_CHAIN_ROW_PREFIX = "llm.model_chain.*[].";
const MODEL_ENTRY_REQUIRED: Readonly<Record<string, true>> = { provider: true, model: true, role: true };

/** The single ordered-list field that IS the model_group record value (array). */
function buildModelGroupEntriesField(
  rows: readonly ConfigFieldSpec[],
  leavesByPath: ReadonlyMap<string, SchemaFieldLeaf>,
  sectionId: string,
): ConfigUiField {
  const itemFields: ConfigUiField[] = rows.map((row) => {
    const rel = row.path.slice(MODEL_CHAIN_ROW_PREFIX.length);
    const control = row.uiControl;
    const options = optionsForRow(row, leavesByPath);
    const optionsSource = rel === "provider" ? "providers" : controlBasedOptionsSource(control);
    const mapValueKind = mapValueKindFor(control, row.valueKind);
    return {
      id: `model_group:entries[].${rel}`,
      path: concreteTokensOf(rel),
      control,
      valueKind: valueKindForRow(row),
      labelKey: `model_group:entries[].${rel}`,
      label: labelFor(rel),
      section: sectionId,
      optional: MODEL_ENTRY_REQUIRED[rel] !== true,
      binding: "value" as const,
      hasDefault: row.hasDefault,
      ...(options !== undefined ? { options } : {}),
      ...(optionsSource !== undefined ? { optionsSource } : {}),
      ...(mapValueKind !== undefined ? { mapValueKind } : {}),
    };
  });
  return {
    id: "model_group:entries",
    path: [],
    control: "ordered-list",
    valueKind: "record",
    labelKey: "model_group:entries",
    label: "Model entries",
    section: sectionId,
    optional: false,
    binding: "value",
    hasDefault: false,
    itemFields,
  };
}

// ---------------------------------------------------------------------------
// Routing page (no inventory rows; derived from routingRuleSchema leaves)
// ---------------------------------------------------------------------------

/** Route analysis leaves mirror global config trees; map to the canonical row. */
const ROUTING_CANONICAL_EXACT: Readonly<Record<string, string>> = {
  "analysis.model_chain": "llm.default_model_chain",
  "analysis.triage_model_chain": "llm.triage_model_chain",
};

const ROUTING_CANONICAL_PREFIXES: readonly (readonly [string, string])[] = [
  ["analysis.review.", "review."],
  ["analysis.agent.", "agent."],
  ["analysis.sandbox.", "agent.sandbox."],
  ["analysis.compression.", "compression."],
];

function canonicalForRoutingPath(path: string): string | undefined {
  const exact = ROUTING_CANONICAL_EXACT[path];
  if (exact !== undefined) {
    return exact;
  }
  for (const [from, to] of ROUTING_CANONICAL_PREFIXES) {
    if (path.startsWith(from)) {
      return to + path.slice(from.length);
    }
  }
  return undefined;
}

/** Leaves that need a control the value kind alone cannot pick. */
const ROUTING_CONTROL_OVERRIDES: Readonly<Record<string, ConfigUiControlKind>> = {
  "match.source.repo_ref": "matcher",
  workspace: "select",
};

const DEFAULT_CONTROL_BY_VALUE_KIND: Readonly<Record<string, ConfigUiControlKind>> = {
  boolean: "toggle",
  number: "number",
  enum: "select",
  "string[]": "multiselect",
  "number[]": "multiselect",
  "enum[]": "multiselect",
  record: "map",
  union: "matcher",
};

const ROUTE_REQUIRED_PATHS: Readonly<Record<string, true>> = { id: true, workspace: true };

function optionsForRoutingLeaf(leaf: SchemaFieldLeaf, canonical: string | undefined): readonly ConfigUiOption[] | undefined {
  if (leaf.enumValues !== undefined) {
    return toOptions(leaf.enumValues);
  }
  if (canonical !== undefined) {
    const staticCanonical = STATIC_OPTIONS_BY_CANONICAL_PATH[canonical];
    if (staticCanonical !== undefined) {
      return toOptions(staticCanonical);
    }
  }
  const staticExact = STATIC_OPTIONS_BY_ROUTING_PATH[leaf.path];
  if (staticExact !== undefined) {
    return toOptions(staticExact);
  }
  return undefined;
}

function buildRoutingField(leaf: SchemaFieldLeaf, sectionId: string): ConfigUiField {
  const valueKind = valueKindFromSchemaType(leaf.typeName);
  const canonical = canonicalForRoutingPath(leaf.path);
  const canonicalRow = canonical === undefined ? undefined : CONFIG_FIELD_INVENTORY_BY_PATH.get(canonical);
  const control =
    ROUTING_CONTROL_OVERRIDES[leaf.path] ?? canonicalRow?.uiControl ?? DEFAULT_CONTROL_BY_VALUE_KIND[valueKind] ?? "text";
  const options = optionsForRoutingLeaf(leaf, canonical);
  const optionsSource = ROUTING_OPTIONS_SOURCE[leaf.path] ?? controlBasedOptionsSource(control);
  const tokens = concreteTokensOf(leaf.path);
  const capability = canonicalRow?.capability;
  return {
    id: `route:${leaf.path}`,
    path: tokens,
    control,
    valueKind,
    labelKey: `route:${leaf.path}`,
    label: labelFor(leaf.path),
    section: sectionId,
    optional: leaf.hasDefault || ROUTE_REQUIRED_PATHS[leaf.path] !== true,
    binding: leaf.path.startsWith("analysis.") ? "inherit-or-override" : "value",
    hasDefault: leaf.hasDefault,
    ...("defaultValue" in leaf ? { defaultValue: leaf.defaultValue } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(optionsSource !== undefined ? { optionsSource } : {}),
    ...(capability !== undefined ? { capability } : {}),
  };
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

interface BuildContext {
  readonly leavesByPath: ReadonlyMap<string, SchemaFieldLeaf>;
  readonly routingLeaves: readonly SchemaFieldLeaf[];
}

interface MutableSection {
  readonly id: string;
  readonly label: string;
  readonly scope: "entity" | "globals";
  readonly match: readonly string[];
  readonly collapsed?: boolean;
  readonly fields: ConfigUiField[];
}

function buildEntityMeta(pageId: string, layout: ConfigUiEntityLayout): NonNullable<ConfigUiPage["entity"]> {
  return {
    kind: layout.kind,
    collection: layout.collection,
    idField: layout.idField,
    valueShape: layout.valueShape,
    ...(layout.kindField !== undefined ? { kindField: layout.kindField, kindOptions: kindOptionsForPage(pageId) } : {}),
  };
}

function buildPage(layout: ConfigUiPageLayout, ctx: BuildContext): ConfigUiPage {
  const sections: MutableSection[] = layout.sections.map((section) => ({ ...section, fields: [] }));
  const place = (scope: "entity" | "globals", displayPath: string): MutableSection =>
    sections.find((section) => section.scope === scope && section.match.some((prefix) => displayPath.startsWith(prefix)))!;

  if (layout.entity?.kind === "route") {
    for (const leaf of ctx.routingLeaves) {
      const section = place("entity", leaf.path);
      section.fields.push(buildRoutingField(leaf, section.id));
    }
  } else {
    for (const row of CONFIG_FIELD_INVENTORY) {
      if (pageIdForRow(row) !== layout.id) {
        continue;
      }
      if (layout.id === "model-groups" && row.path.startsWith(MODEL_CHAIN_ROW_PREFIX)) {
        continue; // materialized as itemFields of the entries ordered-list
      }
      const entity = layout.entity;
      const scope: "entity" | "globals" =
        entity !== undefined && row.entityKind === entity.kind && !isBootstrapReadonly(row) ? "entity" : "globals";
      const displayPath = scope === "entity" ? row.path.slice(ENTITY_PATH_PREFIX[layout.id]!.length) : row.path;
      const tokens = tokensOf(row.path);
      const fieldId =
        scope === "entity" ? `${entity!.kind}:${displayPath}` : `${tokens[0]!}:${dotted(tokens.slice(1))}`;
      const section = place(scope, displayPath);
      section.fields.push(
        buildInventoryField(row, {
          leavesByPath: ctx.leavesByPath,
          pageId: layout.id,
          scope,
          displayPath,
          fieldId,
          pathTokens: scope === "entity" ? concreteTokensOf(displayPath) : concreteTokensOf(row.path),
          sectionId: section.id,
        }),
      );
    }
    if (layout.id === "model-groups") {
      const nameSection = place("entity", "$name");
      nameSection.fields.push(syntheticNameField("model_group", nameSection.id));
      const entryRows = CONFIG_FIELD_INVENTORY.filter((row) => row.path.startsWith(MODEL_CHAIN_ROW_PREFIX));
      const entriesSection = place("entity", "entries");
      entriesSection.fields.push(buildModelGroupEntriesField(entryRows, ctx.leavesByPath, entriesSection.id));
    }
    if (layout.id === "workspaces") {
      const nameSection = place("entity", "$name");
      nameSection.fields.push(syntheticNameField("workspace", nameSection.id));
    }
  }

  const finalSections: ConfigUiSection[] = sections.map((section) => ({
    id: section.id,
    label: section.label,
    ...(section.collapsed === true ? { collapsed: true } : {}),
    fields: nestCollectionFields(section.fields),
  }));
  return {
    id: layout.id,
    label: layout.label,
    ...(layout.entity !== undefined ? { entity: buildEntityMeta(layout.id, layout.entity) } : {}),
    ...(layout.globals === true ? { globals: true } : {}),
    sections: finalSections,
  };
}

/** Turn schema family paths into actual array/map controls, retaining every leaf id. */
function nestCollectionFields(fields: readonly ConfigUiField[], prefix = ""): ConfigUiField[] {
  const result: ConfigUiField[] = [];
  const groups = new Map<string, { marker: string; fields: ConfigUiField[] }>();
  for (const field of fields) {
    const relative = field.id.slice(prefix.length);
    const match = /\[\]\.|\.\*\./u.exec(relative);
    if (!match) {
      // A wildcard leaf edits the entire map, e.g. workspace match.source.*.
      result.push(field.id.endsWith(".*") && field.control !== "map" ? { ...field, control: "map", valueKind: "record", mapValueKind: "record" } : field);
      continue;
    }
    const id = prefix + relative.slice(0, match.index);
    const group = groups.get(id);
    if (group) group.fields.push(field);
    else groups.set(id, { marker: match[0], fields: [field] });
  }
  for (const [id, group] of groups) {
    const first = group.fields[0]!;
    const relative = id.slice(prefix.length).replace(/^[^:]+:/u, "");
    const childPrefix = id + group.marker;
    const path = first.path.slice(0, first.path.length - concreteTokensOf(first.id.slice(childPrefix.length)).length);
    result.push({
      id, path, label: labelFor(relative), labelKey: id, section: first.section,
      control: group.marker === "[]." ? "ordered-list" : "map", valueKind: "record",
      optional: true, binding: first.binding, hasDefault: false,
      ...(first.readonlyReason ? { readonlyReason: first.readonlyReason } : {}),
      ...(group.marker === ".*." ? { mapValueKind: "record" as const } : {}),
      itemFields: nestCollectionFields(group.fields.map(field => ({
        ...field, path: concreteTokensOf(field.id.slice(childPrefix.length)), binding: "value" as const,
      })), childPrefix),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

/**
 * Derives the serializable ConfigUiSpec. Deterministic: two calls produce
 * stableSerialize-equal output. Throws ConfigError(invalid_spec) when the
 * page layout leaves an inventory row unassigned (the U24 test asserts
 * completeness with a diff instead of relying on this guard).
 */
export function buildConfigUiSpec(): ConfigUiSpec {
  const leavesByPath = new Map<string, SchemaFieldLeaf>(
    collectSchemaFieldPaths(appConfigSchema).map((leaf) => [leaf.path, leaf]),
  );
  const routingLeaves = collectSchemaFieldPaths(routingRuleSchema);
  const unassigned = CONFIG_FIELD_INVENTORY.filter((row) => pageIdForRow(row) === undefined);
  /* v8 ignore next -- builder-side guard (design §3); unreachable while PAGE_ASSIGNMENT covers the inventory */
  if (unassigned.length > 0) {
    throw new ConfigError(
      "invalid_spec",
      `config UI page layout does not cover inventory rows: ${unassigned.map((row) => row.path).join(", ")}`,
    );
  }
  const ctx: BuildContext = { leavesByPath, routingLeaves };
  const pages = PAGE_LAYOUT.map((layout) => buildPage(layout, ctx));
  return { protocolVersion: 1, pages, optionsSources: OPTIONS_SOURCES };
}
