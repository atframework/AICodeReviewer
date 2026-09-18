/**
 * U24 spec-completeness + derivation parity tests for config-ui-spec.ts
 * (architecture §3.16, test plan §6 U24). The spec is derived, not duplicated: every
 * inventory row and every routing leaf must surface as exactly one spec
 * field, and every spec field must resolve back to its source row/leaf.
 */

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { CHANNEL_RESOLVED_ACTION_VALUES } from "../src/config-capabilities.js";
import {
  CONFIG_FIELD_INVENTORY,
  CONFIG_FIELD_INVENTORY_BY_PATH,
  collectSchemaFieldPaths,
  type ConfigFieldSpec,
  type ConfigUiControlKind as InventoryControlKind,
} from "../src/config-components.js";
import { stableSerialize } from "../src/config-format.js";
import { appConfigSchema, routingRuleSchema, triageSchema } from "../src/config.js";
import { PAGE_LAYOUT, buildConfigUiSpec, type ConfigUiPageLayout } from "../src/config-ui-spec.js";
import {
  validateUiSpec,
  type ConfigUiControlKind as RuntimeControlKind,
  type ConfigUiField,
  type ConfigUiPage,
  type ConfigUiSpec,
} from "../src/config-ui-runtime.js";
import { reviewTargetKindSchema } from "../src/review-event.js";
import { SCHEDULE_WEEKDAYS } from "../src/weekly-schedule.js";

const spec = buildConfigUiSpec();

// ---------------------------------------------------------------------------
// Spec traversal helpers
// ---------------------------------------------------------------------------

function findPage(id: string): ConfigUiPage {
  const page = spec.pages.find((candidate) => candidate.id === id);
  if (page === undefined) {
    throw new Error(`page ${id} missing from spec`);
  }
  return page;
}

interface FieldRef {
  readonly page: ConfigUiPage;
  readonly field: ConfigUiField;
  /** Set when the field is nested inside another field's itemFields. */
  readonly parent?: ConfigUiField;
}

function* iterateFields(page: ConfigUiPage): Generator<FieldRef> {
  function* walk(field: ConfigUiField, parent?: ConfigUiField): Generator<FieldRef> {
    yield { page, field, ...(parent ? { parent } : {}) };
    for (const item of field.itemFields ?? []) yield* walk(item, field);
  }
  for (const section of page.sections) {
    for (const field of section.fields) {
      yield* walk(field);
    }
  }
}

function fieldsById(page: ConfigUiPage, id: string): FieldRef[] {
  return [...iterateFields(page)].filter((ref) => ref.field.id === id);
}

function findField(pageId: string, fieldId: string): ConfigUiField {
  const matches = fieldsById(findPage(pageId), fieldId);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one field ${fieldId} on page ${pageId}, got ${matches.length}`);
  }
  return matches[0]!.field;
}

function optionValues(field: ConfigUiField): readonly string[] | undefined {
  return field.options?.map((option) => option.value);
}

// ---------------------------------------------------------------------------
// Independent re-derivation of the row → field assignment (audit side;
// intentionally NOT imported from the module under test)
// ---------------------------------------------------------------------------

const AUDIT_PAGE_ASSIGNMENT: readonly (readonly [string, string])[] = [
  ["llm.providers[].", "providers"],
  ["llm.", "model-groups"],
  ["triggers[].", "triggers"],
  ["outputs.channels[].", "channels"],
  ["outputs.templates.", "templates"],
  ["outputs.", "channels"],
  ["prompts.", "prompts"],
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

const AUDIT_ENTITY_PREFIX: Readonly<Record<string, string>> = {
  provider: "llm.providers[].",
  trigger: "triggers[].",
  channel: "outputs.channels[].",
  workspace: "workspaces.instances.*.",
  template: "outputs.templates.",
  prompt: "prompts.system.",
};

const AUDIT_ENTITY_PAGE: Readonly<Record<string, string>> = {
  provider: "providers",
  model_group: "model-groups",
  trigger: "triggers",
  channel: "channels",
  workspace: "workspaces",
  route: "routing",
  template: "templates",
  prompt: "prompts",
};

const MODEL_CHAIN_ROW_PREFIX = "llm.model_chain.*[].";

interface ExpectedLocation {
  readonly pageId: string;
  readonly fieldId: string;
}

function expectedLocationForRow(row: ConfigFieldSpec): ExpectedLocation {
  if (row.path.startsWith(MODEL_CHAIN_ROW_PREFIX)) {
    return { pageId: "model-groups", fieldId: `model_group:entries[].${row.path.slice(MODEL_CHAIN_ROW_PREFIX.length)}` };
  }
  const entityKind = row.entityKind;
  if (entityKind !== undefined && row.path !== "workspaces.root") {
    const prefix = AUDIT_ENTITY_PREFIX[entityKind];
    if (prefix !== undefined && row.path.startsWith(prefix)) {
      return { pageId: AUDIT_ENTITY_PAGE[entityKind]!, fieldId: `${entityKind}:${row.path.slice(prefix.length)}` };
    }
  }
  for (const [prefix, pageId] of AUDIT_PAGE_ASSIGNMENT) {
    if (row.path.startsWith(prefix)) {
      const tokens = row.path.split(".");
      return { pageId, fieldId: `${tokens[0]!}:${tokens.slice(1).join(".")}` };
    }
  }
  throw new Error(`audit: no page assignment for ${row.path}`);
}

/**
 * Family-path normalization matching the spec's concrete-token rule: the
 * "[]" and "*" markers are dropped from field.path (the canonical family
 * form survives only in field ids).
 */
function normalizeFamilyPath(path: string): string {
  return path
    .split(".")
    .filter((part) => part !== "*")
    .map((part) => (part.endsWith("[]") ? part.slice(0, -2) : part))
    .join(".");
}

/** Field ids that exist by construction (no inventory row / routing leaf). */
const SYNTHETIC_FIELD_IDS: Readonly<Record<string, true>> = {
  "model_group:$name": true,
  "workspace:$name": true,
  "template:$name": true,
  "prompt:$name": true,
  "model_group:entries": true,
};

// ---------------------------------------------------------------------------
// U24: completeness (both directions, diff-style failures)
// ---------------------------------------------------------------------------

describe("U24 spec completeness", () => {
  it("assigns every inventory row to exactly one spec field", () => {
    const problems: string[] = [];
    for (const row of CONFIG_FIELD_INVENTORY) {
      const expected = expectedLocationForRow(row);
      const page = spec.pages.find((candidate) => candidate.id === expected.pageId);
      if (page === undefined) {
        problems.push(`${row.path}: expected page ${expected.pageId} does not exist`);
        continue;
      }
      const matches = fieldsById(page, expected.fieldId);
      if (matches.length === 0) {
        problems.push(`${row.path}: unassigned (expected field ${expected.fieldId} on page ${expected.pageId})`);
      } else if (matches.length > 1) {
        problems.push(`${row.path}: assigned ${matches.length} times as ${expected.fieldId} on page ${expected.pageId}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("assigns every routingRuleSchema leaf to a route field", () => {
    const routing = findPage("routing");
    const problems: string[] = [];
    for (const leaf of collectSchemaFieldPaths(routingRuleSchema)) {
      const matches = fieldsById(routing, `route:${leaf.path}`);
      if (matches.length !== 1) {
        problems.push(`${leaf.path}: expected exactly one route field, got ${matches.length}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("resolves every spec field back to an inventory row or routing leaf", () => {
    const routingLeafPaths = new Set(collectSchemaFieldPaths(routingRuleSchema).map((leaf) => leaf.path));
    const normalizedLeafPaths = new Set(collectSchemaFieldPaths(routingRuleSchema).map((leaf) => normalizeFamilyPath(leaf.path)));
    const normalizedInventoryPaths = new Set(CONFIG_FIELD_INVENTORY.map((row) => normalizeFamilyPath(row.path)));
    const problems: string[] = [];
    const declaredIds = new Set(CONFIG_FIELD_INVENTORY.map(row => expectedLocationForRow(row).fieldId));
    for (const leaf of routingLeafPaths) declaredIds.add(`route:${leaf}`);
    for (const page of spec.pages) {
      for (const ref of iterateFields(page)) {
        const { field, parent } = ref;
        if (SYNTHETIC_FIELD_IDS[field.id] === true) {
          continue;
        }
        if (field.itemFields && field.id !== "trigger:repos") {
          const marker = field.control === "map" ? ".*." : "[].";
          const children = [...iterateFields(page)].filter(ref => ref.field.id.startsWith(field.id + marker));
          expect(children.some(ref => declaredIds.has(ref.field.id)), field.id).toBe(true);
          expect(field.itemFields.every(child => child.id.startsWith(field.id + marker)), field.id).toBe(true);
          continue;
        }
        if (parent !== undefined) {
          if (parent.id === "model_group:entries") {
            const rel = field.id.slice("model_group:entries[].".length);
            if (!CONFIG_FIELD_INVENTORY_BY_PATH.has(`${MODEL_CHAIN_ROW_PREFIX}${rel}`)) {
              problems.push(`${page.id}/${field.id}: no inventory row ${MODEL_CHAIN_ROW_PREFIX}${rel}`);
            }
            continue;
          }
          if (parent.id === "trigger:repos") {
            if (field.id !== "trigger:repos[].match" && field.id !== "trigger:repos[].workspace") {
              problems.push(`${page.id}/${field.id}: unexpected repos item field`);
            }
            continue;
          }
          if (!declaredIds.has(field.id)) problems.push(`${page.id}/${field.id}: no declared leaf`);
          const relative = field.id.slice(parent.id.length + 3);
          expect(field.path.join("."), field.id).toBe(normalizeFamilyPath(relative));
          continue;
        }
        if (page.entity?.kind === "route") {
          const leafPath = field.id.slice("route:".length);
          if (!routingLeafPaths.has(leafPath) || !normalizedLeafPaths.has(field.path.join("."))) {
            problems.push(`routing/${field.id}: not a routingRuleSchema leaf`);
          }
          continue;
        }
        const entity = page.entity;
        if (entity !== undefined && field.id.startsWith(`${entity.kind}:`)) {
          const prefix = AUDIT_ENTITY_PREFIX[entity.kind];
          const rel = field.id.slice(`${entity.kind}:`.length);
          if (prefix === undefined || !CONFIG_FIELD_INVENTORY_BY_PATH.has(`${prefix}${rel}`)) {
            problems.push(`${page.id}/${field.id}: no inventory row ${prefix ?? "?"}${rel}`);
          }
          continue;
        }
        const dotted = field.path.join(".");
        if (!normalizedInventoryPaths.has(dotted)) {
          problems.push(`${page.id}/${field.id}: globals path ${dotted} is not an inventory row`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("passes validateUiSpec with zero issues", () => {
    expect(validateUiSpec(spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("serialization", () => {
  it("survives a JSON round-trip unchanged (no undefined leaves, functions, or maps)", () => {
    expect(JSON.parse(JSON.stringify(spec)) as ConfigUiSpec).toEqual(spec);
  });

  it("is deterministic across builds (stableSerialize-equal)", () => {
    expect(stableSerialize(buildConfigUiSpec())).toBe(stableSerialize(spec));
  });
});

// ---------------------------------------------------------------------------
// Enum + control parity
// ---------------------------------------------------------------------------

/** Unwrap ZodDefault/ZodArray wrappers down to a ZodEnum and read its options. */
function innerEnumValues(schema: z.ZodTypeAny): readonly string[] {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
      continue;
    }
    if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodArray) {
      current = current.element;
      continue;
    }
    break;
  }
  if (current instanceof z.ZodEnum) {
    return current.options as readonly string[];
  }
  throw new Error("schema is not an enum (array)");
}

describe("enum parity", () => {
  it("offers the direct LLM mode at every agent selection layer", () => {
    for (const [page, id] of [
      ["agent", "agent:default"],
      ["workspaces", "workspaces:defaults.agent.default"],
      ["workspaces", "workspace:agent.default"],
      ["routing", "route:analysis.agent.default"],
    ] as const) {
      expect(optionValues(findField(page, id)), `${page} ${id}`).toContain("native-llm");
    }
  });

  it("gives every leaf-backed spec field options equal to the schema leaf enumValues", () => {
    const appLeaves = new Map(collectSchemaFieldPaths(appConfigSchema).map((leaf) => [leaf.path, leaf]));
    const problems: string[] = [];
    for (const row of CONFIG_FIELD_INVENTORY) {
      const leaf = appLeaves.get(row.path);
      if (leaf?.enumValues === undefined) {
        continue;
      }
      const expected = expectedLocationForRow(row);
      const field = findField(expected.pageId, expected.fieldId);
      const values = optionValues(field);
      if (values === undefined || stableSerialize(values) !== stableSerialize(leaf.enumValues)) {
        problems.push(`${row.path}: options ${JSON.stringify(values ?? null)} != leaf ${JSON.stringify(leaf.enumValues)}`);
      }
    }
    for (const leaf of collectSchemaFieldPaths(routingRuleSchema)) {
      if (leaf.enumValues === undefined) {
        continue;
      }
      const field = findField("routing", `route:${leaf.path}`);
      const values = optionValues(field);
      if (values === undefined || stableSerialize(values) !== stableSerialize(leaf.enumValues)) {
        problems.push(`routing ${leaf.path}: options ${JSON.stringify(values ?? null)} != leaf ${JSON.stringify(leaf.enumValues)}`);
      }
    }
    expect(problems).toEqual([]);
  });
  it("keeps hand-maintained static tables in parity with their source schemas", () => {
    const triageShape = triageSchema.removeDefault().shape;
    expect(optionValues(findField("routing", "route:match.target_kinds"))).toEqual([...reviewTargetKindSchema.options]);
    expect(optionValues(findField("review", "review:auto_commit.schedule.rules[].days"))).toEqual([...SCHEDULE_WEEKDAYS]);
    expect(optionValues(findField("review", "review:pull_request.schedule.rules[].days"))).toEqual([...SCHEDULE_WEEKDAYS]);
    expect(optionValues(findField("workspaces", "workspace:triage.actions"))).toEqual(innerEnumValues(triageShape.actions));
    expect(optionValues(findField("workspaces", "workspace:triage.categories_close"))).toEqual(
      innerEnumValues(triageShape.categories_close),
    );
    expect(optionValues(findField("workspaces", "workspace:triage.events"))).toEqual(innerEnumValues(triageShape.events));
  });

  it("embeds the documented static option sets", () => {
    expect(optionValues(findField("review", "review:output_language"))).toEqual(["zh-CN", "en-US"]);
    expect(optionValues(findField("agent", "compression:summarize_model_role"))).toEqual(["light", "heavy", "any"]);
    expect(optionValues(findField("routing", "route:analysis.review.output_language"))).toEqual(["zh-CN", "en-US"]);
    expect(optionValues(findField("routing", "route:analysis.compression.summarize_model_role"))).toEqual(["light", "heavy", "any"]);
    expect(optionValues(findField("model-groups", "model_group:entries[].role"))).toEqual(["light", "heavy", "any"]);
  });
});

describe("control parity", () => {
  const CONTROL_KINDS = [
    "text",
    "document",
    "number",
    "toggle",
    "select",
    "multiselect",
    "ordered-list",
    "map",
    "secret-ref",
    "secret-value",
    "matcher",
    "path-template",
  ] as const;

  // Compile-time parity between the runtime and inventory control unions.
  type ControlUnionParity = RuntimeControlKind extends InventoryControlKind
    ? InventoryControlKind extends RuntimeControlKind
      ? true
      : never
    : never;
  const CONTROL_UNION_PARITY: ControlUnionParity = true;
  void CONTROL_UNION_PARITY;

  it("uses only declared control kinds, covering the same set as the inventory", () => {
    const specControls = new Set<string>();
    for (const page of spec.pages) {
      for (const ref of iterateFields(page)) {
        specControls.add(ref.field.control);
      }
    }
    const inventoryControls = new Set<string>(CONFIG_FIELD_INVENTORY.map((row) => row.uiControl));
    for (const control of specControls) {
      expect(CONTROL_KINDS).toContain(control);
    }
    expect([...specControls].sort()).toEqual([...inventoryControls].sort());
    expect([...specControls].sort()).toEqual([...CONTROL_KINDS].sort());
  });
});

// ---------------------------------------------------------------------------
// Kinds applicability + capability notes
// ---------------------------------------------------------------------------

describe("kinds applicability", () => {
  it("scopes provider kind-conditional fields", () => {
    expect(findField("providers", "provider:api_version").kinds).toEqual(["azure_openai"]);
    expect(findField("providers", "provider:vertex_project").kinds).toEqual(["vertex_ai"]);
    expect(findField("providers", "provider:aws_access_key_env").kinds).toEqual(["bedrock"]);
    expect(findField("providers", "provider:anthropic_beta").kinds).toEqual(["anthropic"]);
    expect(findField("providers", "provider:cache_control").kinds).toEqual(["anthropic"]);
    expect(findField("providers", "provider:base_url").kinds).toBeUndefined();
  });

  it("scopes trigger kind-conditional fields", () => {
    expect(findField("triggers", "trigger:app.app_id").kinds).toEqual(["github"]);
    expect(findField("triggers", "trigger:app.private_key_env").kinds).toEqual(["github"]);
    expect(findField("triggers", "trigger:watch_path").kinds).toEqual(["p4", "svn"]);
    expect(findField("triggers", "trigger:port").kinds).toEqual(["p4"]);
    expect(findField("triggers", "trigger:repository_url").kinds).toEqual(["svn"]);
    expect(findField("triggers", "trigger:name").kinds).toBeUndefined();
  });

  it("scopes channel kind-conditional fields", () => {
    expect(findField("channels", "channel:labels").kinds).toEqual(["github_problem_issue"]);
    expect(findField("channels", "channel:label_ids").kinds).toEqual(["gitea_problem_issue"]);
    expect(findField("channels", "channel:review_mode").kinds).toEqual(["gitea_pr_review", "github_pr_review"]);
    expect(findField("channels", "channel:notify_feishu.webhook_url_env").kinds).toEqual([
      "github_problem_issue",
      "gitea_problem_issue",
    ]);
    expect(findField("channels", "channel:name").kinds).toBeUndefined();
  });

  it("documents per-kind resolved_action values, including gitea-only delete", () => {
    const field = findField("channels", "channel:resolved_action");
    expect(optionValues(field)).toEqual(["none", "close", "mark_resolved", "delete"]);
    for (const [kind, values] of Object.entries(CHANNEL_RESOLVED_ACTION_VALUES)) {
      expect(field.capability).toContain(kind);
      expect(field.capability).toContain(values.join("/"));
    }
    expect(field.capability).toContain("delete is gitea_problem_issue only");
    expect(field.kinds).toEqual(["github_problem_issue", "gitea_problem_issue"]);
  });
});

// ---------------------------------------------------------------------------
// readonlyReason coverage
// ---------------------------------------------------------------------------

describe("readonlyReason coverage", () => {
  it("marks every unwired inventory row readonly with its status", () => {
    const problems: string[] = [];
    for (const row of CONFIG_FIELD_INVENTORY) {
      if (row.wired) {
        continue;
      }
      const expected = expectedLocationForRow(row);
      const field = findField(expected.pageId, expected.fieldId);
      if (field.readonlyReason !== row.status) {
        problems.push(`${row.path}: readonlyReason ${JSON.stringify(field.readonlyReason ?? null)} != status ${JSON.stringify(row.status ?? null)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("marks bootstrap-owned prefixes readonly on the advanced/owning pages", () => {
    const reason = "bootstrap-owned; edit the config file";
    const problems: string[] = [];
    for (const row of CONFIG_FIELD_INVENTORY) {
      if (!row.wired || (row.ownership !== "bootstrap" && row.path !== "workspaces.root")) {
        continue;
      }
      const expected = expectedLocationForRow(row);
      const field = findField(expected.pageId, expected.fieldId);
      if (field.readonlyReason !== reason) {
        problems.push(`${row.path}: expected bootstrap readonlyReason, got ${JSON.stringify(field.readonlyReason ?? null)}`);
      }
    }
    expect(problems).toEqual([]);
    // Spot checks for the named bootstrap surfaces.
    for (const [page, id] of [
      ["advanced", "server:port"],
      ["advanced", "admin:username_env"],
      ["advanced", "config_sources:database.enabled"],
      ["advanced", "storage:database.kind"],
      ["queue", "queue:kind"],
      ["queue", "queue:sqlite.path"],
      ["workspaces", "workspaces:root"],
    ] as const) {
      expect(findField(page, id).readonlyReason).toBe(reason);
    }
    // Wired business fields stay editable.
    expect(findField("review", "review:max_files").readonlyReason).toBeUndefined();
    expect(findField("providers", "provider:base_url").readonlyReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Page / section sanity
// ---------------------------------------------------------------------------

describe("page and section sanity", () => {
  it("orders nav per the design doc", () => {
    expect(spec.pages.map((page) => page.id)).toEqual([
      "providers",
      "model-groups",
      "triggers",
      "channels",
      "routing",
      "templates",
      "prompts",
      "agent",
      "review",
      "workspaces",
      "queue",
      "advanced",
      "versions",
    ]);
  });

  it("keeps every section non-empty except the versions page", () => {
    const versions = findPage("versions");
    expect(versions.sections).toEqual([]);
    expect(versions.entity).toBeUndefined();
    expect(versions.globals ?? false).toBe(false);
    const problems: string[] = [];
    for (const page of spec.pages) {
      if (page.id === "versions") {
        continue;
      }
      for (const section of page.sections) {
        if (section.fields.length === 0) {
          problems.push(`${page.id}/${section.id}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("carries the entity metadata of each editor page", () => {
    expect(findPage("providers").entity).toMatchObject({ kind: "provider", collection: "providers", idField: "id", valueShape: "object", kindField: "kind" });
    expect(findPage("model-groups").entity).toMatchObject({ kind: "model_group", collection: "model_groups", idField: null, valueShape: "array" });
    expect(findPage("model-groups").entity).not.toHaveProperty("kindField");
    expect(findPage("triggers").entity).toMatchObject({ kind: "trigger", collection: "triggers", idField: "name", kindField: "kind" });
    expect(findPage("channels").entity).toMatchObject({ kind: "channel", collection: "channels", idField: "name", kindField: "kind" });
    expect(findPage("routing").entity).toMatchObject({ kind: "route", collection: "routes", idField: "id", valueShape: "object" });
    expect(findPage("routing").entity).not.toHaveProperty("kindField");
    expect(findPage("templates").entity).toMatchObject({ kind: "template", collection: "templates", idField: null, valueShape: "string" });
    expect(findPage("prompts").entity).toMatchObject({ kind: "prompt", collection: "prompts", idField: null, valueShape: "string" });
    expect(findPage("workspaces").entity).toMatchObject({ kind: "workspace", collection: "workspaces", idField: null, valueShape: "object" });
    expect(findPage("providers").entity?.kindOptions).toEqual(optionValues(findField("providers", "provider:kind")));
    expect(findPage("triggers").entity?.kindOptions).toEqual(optionValues(findField("triggers", "trigger:kind")));
    expect(findPage("channels").entity?.kindOptions).toEqual(optionValues(findField("channels", "channel:kind")));
  });

  it("flags exactly the globals-editing pages", () => {
    const globalsPages = spec.pages.filter((page) => page.globals === true).map((page) => page.id);
    expect(globalsPages).toEqual(["model-groups", "channels", "agent", "review", "workspaces", "queue", "advanced"]);
  });

  it("mirrors the PAGE_LAYOUT page/section structure in the built spec", () => {
    expect(spec.pages.map((page) => page.id)).toEqual(PAGE_LAYOUT.map((layout: ConfigUiPageLayout) => layout.id));
  });
});

// ---------------------------------------------------------------------------
// visibleWhen + optionsSource assignments
// ---------------------------------------------------------------------------

describe("visibleWhen", () => {
  it("gates the searxng group on the web_search.providers multiselect", () => {
    const agent = findPage("agent");
    const gated = [...iterateFields(agent)].filter((ref) => ref.field.id.startsWith("agent:web_search.searxng."));
    expect(gated.length).toBeGreaterThan(0);
    for (const ref of gated) {
      expect(ref.field.visibleWhen).toEqual({ field: "agent:web_search.providers", equals: "searxng" });
    }
    expect(findField("agent", "agent:web_search.providers").visibleWhen).toBeUndefined();
    expect(findField("agent", "agent:web_search.timeout_seconds").visibleWhen).toBeUndefined();
    expect(findField("agent", "agent:web_search.timeout_seconds").capability).toContain("oh-my-pi");
  });

  it("gates reflection.memory on reflection.enabled", () => {
    const review = findPage("review");
    const gated = [...iterateFields(review)].filter((ref) => ref.field.id.startsWith("review:reflection.memory."));
    expect(gated.length).toBeGreaterThan(0);
    for (const ref of gated) {
      expect(ref.field.visibleWhen).toEqual({ field: "review:reflection.enabled", equals: true });
    }
    expect(findField("review", "review:reflection.mode").visibleWhen).toBeUndefined();
  });
});

describe("optionsSource assignments", () => {
  it("registers the nine dynamic options sources", () => {
    expect(spec.optionsSources.map((source) => source.id)).toEqual([
      "providers",
      "model_groups",
      "triggers",
      "channels",
      "workspaces",
      "templates",
      "prompts",
      "secret_envs",
      "path_template_variables",
    ]);
    for (const source of spec.optionsSources) {
      expect(source.label.length).toBeGreaterThan(0);
    }
  });

  it("wires reference fields to their sources", () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ["model-groups", "llm:default_model_chain", "model_groups"],
      ["model-groups", "llm:triage_model_chain", "model_groups"],
      ["workspaces", "workspaces:defaults.model_chain", "model_groups"],
      ["workspaces", "workspace:model_chain", "model_groups"],
      ["routing", "route:analysis.model_chain", "model_groups"],
      ["routing", "route:analysis.triage_model_chain", "model_groups"],
      ["channels", "channel:trigger", "triggers"],
      ["channels", "outputs:routes.default.match.trigger", "triggers"],
      ["workspaces", "workspace:source_repo.trigger", "triggers"],
      ["workspaces", "workspace:match[].triggers", "triggers"],
      ["routing", "route:match.triggers", "triggers"],
      ["routing", "route:workspace", "workspaces"],
      ["routing", "route:outputs.line_comments", "channels"],
      ["routing", "route:outputs.summary", "channels"],
      ["channels", "outputs:routes.default.line_comments", "channels"],
      ["workspaces", "workspaces:defaults.outputs.summary", "channels"],
      ["channels", "channel:templates.problem", "templates"],
      ["channels", "channel:templates.summary", "templates"],
      ["workspaces", "workspaces:defaults.prompt.system_prompt", "prompts"],
      ["workspaces", "workspaces:defaults.prompt.extra_system_prompt", "prompts"],
      ["workspaces", "workspace:prompt.system_prompt", "prompts"],
      ["workspaces", "workspace:prompt.extra_system_prompt", "prompts"],
      ["providers", "provider:api_key_env", "secret_envs"],
      ["triggers", "trigger:commit_url_template", "path_template_variables"],
    ];
    for (const [pageId, fieldId, source] of cases) {
      expect(findField(pageId, fieldId).optionsSource).toBe(source);
    }
    expect(findField("model-groups", "model_group:entries[].provider").optionsSource).toBe("providers");
    expect(findField("triggers", "trigger:repos[].workspace").optionsSource).toBe("workspaces");
  });

  it("does not leak optionsSource onto plain fields", () => {
    expect(findField("review", "review:max_files").optionsSource).toBeUndefined();
    expect(findField("review", "review:commit_strategy").optionsSource).toBeUndefined();
    expect(findField("model-groups", "model_group:entries[].model").optionsSource).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layered rows, model group entries, route page shape
// ---------------------------------------------------------------------------

describe("layered rows", () => {
  it("uses inherit-or-override binding with the chainOf note", () => {
    const defaultsField = findField("workspaces", "workspaces:defaults.review.max_files");
    expect(defaultsField.binding).toBe("inherit-or-override");
    expect(defaultsField.capability).toContain("inherits from review.max_files");
    const instanceField = findField("workspaces", "workspace:review.max_files");
    expect(instanceField.binding).toBe("inherit-or-override");
    expect(instanceField.capability).toContain("inherits from review.max_files");
    expect(findField("workspaces", "workspace:model_chain").capability).toContain("inherits from llm.default_model_chain");
    // The global twin is a plain value binding with no inherit note.
    const globalField = findField("review", "review:max_files");
    expect(globalField.binding).toBe("value");
    expect(globalField.capability).toBeUndefined();
  });
});

describe("model group page", () => {
  it("materializes the map collection as $name + one ordered-list entries field", () => {
    const name = findField("model-groups", "model_group:$name");
    expect(name.path).toEqual([]);
    expect(name.control).toBe("text");
    const entries = findField("model-groups", "model_group:entries");
    expect(entries.path).toEqual([]);
    expect(entries.control).toBe("ordered-list");
    const itemIds = (entries.itemFields ?? []).map((field) => field.id);
    expect(itemIds).toHaveLength(17);
    expect(itemIds.slice(0, 3)).toEqual(["model_group:entries[].provider", "model_group:entries[].model", "model_group:entries[].role"]);
    const overrideFields = (entries.itemFields ?? []).filter((field) => field.path[0] === "overrides");
    expect(overrideFields).toHaveLength(14);
    const provider = findField("model-groups", "model_group:entries[].provider");
    expect(provider.control).toBe("select");
    expect(provider.optionsSource).toBe("providers");
    expect(provider.optional).toBe(false);
    expect(findField("model-groups", "model_group:entries[].overrides.seed").optional).toBe(true);
  });
});

describe("routing page", () => {
  it("exposes the full rule shape with a collapsed review tree", () => {
    const routing = findPage("routing");
    expect(routing.globals ?? false).toBe(false);
    const reviewSection = routing.sections.find((section) => section.id === "review");
    expect(reviewSection?.collapsed).toBe(true);
    expect(reviewSection?.fields.length).toBeGreaterThan(30);
    expect(findField("routing", "route:id").optional).toBe(false);
    expect(findField("routing", "route:workspace").optional).toBe(false);
    expect(findField("routing", "route:enabled").hasDefault).toBe(true);
    expect(findField("routing", "route:match.source.repo_ref").control).toBe("matcher");
    expect(findField("routing", "route:analysis.review.max_files").binding).toBe("inherit-or-override");
    expect(findField("routing", "route:outputs.line_comments").binding).toBe("value");
    expect(findField("routing", "route:priority").defaultValue).toBe(0);
  });
});
