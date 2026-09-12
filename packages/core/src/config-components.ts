import { z } from "zod";

import type { ConfigEntityKind } from "./config-format.js";
import { isPlainObject } from "./utils.js";

/**
 * Permanent config field inventory and the schema walk that keeps it
 * complete (spec §8.2, test U24): every schema-accepted leaf has exactly one
 * inventory row carrying value kind, default, source ownership, inheritance,
 * capability, resolver, consumer, UI control, and test id. The walker uses
 * Zod 3 accessors and version-specific `_def` metadata for this audit gate,
 * and fails closed on schema constructs it does not
 * understand, so new fields cannot slip past the inventory gate unnoticed.
 *
 * `wired`/`consumer` reflect the audited runtime state (2026-09-12):
 * schema acceptance alone never marks a field wired. Unwired fields carry a
 * `status` and must not be exposed as editable until their wiring lands.
 */

// ---------------------------------------------------------------------------
// Schema walker
// ---------------------------------------------------------------------------

export interface SchemaFieldLeaf {
  /** Canonical schema path: object keys dotted, `[]` after arrays, `*` for records. */
  readonly path: string;
  /** Zod first-party type name of the leaf (ZodString, ZodEnum, ZodNever, …). */
  readonly typeName: string;
  /** True when the schema declares a default for this exact path. */
  readonly hasDefault: boolean;
  /** Schema default value (only present when hasDefault). */
  readonly defaultValue?: unknown;
  /** Enum options for ZodEnum leaves. */
  readonly enumValues?: readonly string[];
}

interface UnwrapResult {
  readonly schema: z.ZodTypeAny;
  readonly hasDefault: boolean;
  readonly defaultValue?: unknown;
}

function unwrapSchema(schema: z.ZodTypeAny): UnwrapResult {
  let current = schema;
  let hasDefault = false;
  let defaultValue: unknown;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      if (!hasDefault) {
        hasDefault = true;
        defaultValue = current._def.defaultValue();
      }
      current = current.removeDefault();
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }
    if (current instanceof z.ZodCatch) {
      current = current.removeCatch();
      continue;
    }
    if (current instanceof z.ZodReadonly) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodBranded) {
      current = current.unwrap();
      continue;
    }
    if (defaultValue === undefined) {
      return { schema: current, hasDefault };
    }
    return { schema: current, hasDefault, defaultValue };
  }
}

const PRIMITIVE_LEAF_TYPES: ReadonlySet<string> = new Set([
  z.ZodFirstPartyTypeKind.ZodString,
  z.ZodFirstPartyTypeKind.ZodNumber,
  z.ZodFirstPartyTypeKind.ZodBoolean,
  z.ZodFirstPartyTypeKind.ZodEnum,
  z.ZodFirstPartyTypeKind.ZodNativeEnum,
  z.ZodFirstPartyTypeKind.ZodLiteral,
  z.ZodFirstPartyTypeKind.ZodNever,
  z.ZodFirstPartyTypeKind.ZodUnknown,
  z.ZodFirstPartyTypeKind.ZodAny,
  z.ZodFirstPartyTypeKind.ZodVoid,
  z.ZodFirstPartyTypeKind.ZodUndefined,
  z.ZodFirstPartyTypeKind.ZodNull,
  z.ZodFirstPartyTypeKind.ZodDate,
  z.ZodFirstPartyTypeKind.ZodBigInt,
]);

function joinSchemaPath(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    if (part === "[]") {
      out += "[]";
    } else {
      out = out === "" ? part : `${out}.${part}`;
    }
  }
  return out;
}

function leafFrom(path: readonly string[], unwrapped: UnwrapResult, typeName: string): SchemaFieldLeaf {
  const base = {
    path: joinSchemaPath(path),
    typeName,
    hasDefault: unwrapped.hasDefault,
  };
  const withDefault =
    unwrapped.hasDefault && unwrapped.defaultValue !== undefined ? { ...base, defaultValue: unwrapped.defaultValue } : base;
  if (unwrapped.schema instanceof z.ZodEnum) {
    return { ...withDefault, enumValues: unwrapped.schema.options as readonly string[] };
  }
  return withDefault;
}

/**
 * Collects the settable leaf paths of a config schema. Unions of primitives,
 * arrays of primitives, passthrough objects, and open records are leaves
 * (managed as a whole, e.g. trust_proxy or tool_choice); strict object
 * options inside unions fail closed because their sub-fields would need
 * individual inventory rows.
 */
export function collectSchemaFieldPaths(root: z.ZodTypeAny): readonly SchemaFieldLeaf[] {
  const leaves: SchemaFieldLeaf[] = [];

  const visit = (schema: z.ZodTypeAny, path: string[], inheritedDefault: unknown): void => {
    const unwrapped = unwrapSchema(schema);
    // An ancestor's explicit value becomes this field's input; its own
    // default runs only when that input is undefined, as in Zod parsing.
    const effective: UnwrapResult =
      inheritedDefault === undefined
        ? unwrapped
        : { schema: unwrapped.schema, hasDefault: true, defaultValue: inheritedDefault };
    const node = effective.schema;
    const typeName: string = node._def.typeName;

    if (PRIMITIVE_LEAF_TYPES.has(typeName)) {
      leaves.push(leafFrom(path, effective, typeName));
      return;
    }
    if (node instanceof z.ZodObject) {
      const childDefaults =
        effective.hasDefault && isPlainObject(effective.defaultValue)
          ? (effective.defaultValue as Record<string, unknown>)
          : undefined;
      for (const [key, child] of Object.entries(node.shape as Record<string, z.ZodTypeAny>)) {
        visit(child, [...path, key], childDefaults?.[key]);
      }
      return;
    }
    if (node instanceof z.ZodArray) {
      const element = unwrapSchema(node.element);
      const elementType: string = element.schema._def.typeName;
      if (PRIMITIVE_LEAF_TYPES.has(elementType)) {
        leaves.push(leafFrom(path, effective, `${elementType}[]`));
        return;
      }
      visit(node.element, [...path, "[]"], undefined);
      return;
    }
    if (node instanceof z.ZodRecord) {
      visit(node.valueSchema, [...path, "*"], undefined);
      return;
    }
    if (node instanceof z.ZodUnion) {
      const options = node.options as z.ZodTypeAny[];
      const allLeaves = options.every((option) => {
        const inner = unwrapSchema(option).schema;
        const innerType: string = inner._def.typeName;
        if (PRIMITIVE_LEAF_TYPES.has(innerType)) {
          return true;
        }
        if (inner instanceof z.ZodArray) {
          const element = unwrapSchema(inner.element).schema;
          return PRIMITIVE_LEAF_TYPES.has(element._def.typeName as string);
        }
        if (inner instanceof z.ZodObject) {
          // Strip/strict objects carry a ZodNever catchall; anything else is
          // an opaque managed surface (passthrough or explicit catchall).
          if ((inner._def.catchall as z.ZodTypeAny)._def.typeName !== z.ZodFirstPartyTypeKind.ZodNever) {
            return true;
          }
          // Strict objects are value leaves only when every field is a
          // primitive scalar (e.g. the exact/glob/regex matcher alternatives);
          // otherwise the union mixes structural containers and stays guarded.
          return Object.values(inner.shape as Record<string, z.ZodTypeAny>).every((field) =>
            PRIMITIVE_LEAF_TYPES.has(unwrapSchema(field).schema._def.typeName as string),
          );
        }
        // Open maps (e.g. tool_choice function payloads) are opaque too.
        return inner instanceof z.ZodRecord;
      });
      if (allLeaves) {
        leaves.push(leafFrom(path, effective, "union"));
        return;
      }
      throw new TypeError(`collectSchemaFieldPaths: union with strict object options at ${joinSchemaPath(path)} needs explicit walker support.`);
    }
    throw new TypeError(`collectSchemaFieldPaths: unsupported schema type ${String(typeName)} at ${joinSchemaPath(path)}.`);
  };

  visit(root, [], undefined);
  return leaves;
}

// ---------------------------------------------------------------------------
// Field inventory
// ---------------------------------------------------------------------------

export type ConfigUiControlKind =
  | "text"
  | "number"
  | "toggle"
  | "select"
  | "multiselect"
  | "ordered-list"
  | "map"
  | "secret-ref"
  | "matcher"
  | "path-template";

export type ConfigFieldOwnership = "bootstrap" | "business" | "entity";

export type ConfigInheritanceLayer = "global" | "defaults" | "workspace" | "route";

export type ConfigFieldValueKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "string[]"
  | "number[]"
  | "enum[]"
  | "record"
  | "union"
  | "never";

/** Maps a walker typeName to the inventory value kind (U24 asserts equality). */
export function valueKindFromSchemaType(typeName: string): ConfigFieldValueKind {
  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
    case "ZodNativeEnum":
      return "enum";
    case "ZodString[]":
      return "string[]";
    case "ZodNumber[]":
      return "number[]";
    case "ZodEnum[]":
      return "enum[]";
    case "ZodUnknown":
    case "ZodAny":
      return "record";
    case "union":
      return "union";
    case "ZodNever":
      return "never";
    default:
      throw new TypeError(`valueKindFromSchemaType: no mapping for ${typeName}.`);
  }
}

export interface ConfigFieldSpec {
  /** Canonical schema path (collectSchemaFieldPaths) or managed passthrough path. */
  readonly path: string;
  readonly valueKind: ConfigFieldValueKind;
  readonly hasDefault: boolean;
  /** Static schema default; only present when hasDefault is true. */
  readonly defaultValue?: unknown;
  readonly ownership: ConfigFieldOwnership;
  readonly entityKind?: ConfigEntityKind;
  /** Layer this physical path belongs to. */
  readonly inheritance: readonly ConfigInheritanceLayer[];
  /** Canonical global path when this row is a defaults/workspace layer instance. */
  readonly chainOf?: string;
  /** declared = schema shape; passthrough = managed extension; removed = rejected legacy. */
  readonly schemaStatus: "declared" | "passthrough" | "removed";
  /** Kind-scoped applicability or capability limits (evidence-backed). */
  readonly capability?: string;
  /** Resolution function symbol, when the field participates in inheritance. */
  readonly resolver?: string;
  /** Runtime consumer `file:symbol`; omitted when schema-only. */
  readonly consumer?: string;
  /** True only when a runtime consumer provably reads the value. */
  readonly wired: boolean;
  /** Why the field is unwired or when wiring lands (e.g. "P4"). */
  readonly status?: string;
  readonly uiControl: ConfigUiControlKind;
  /** Acceptance test id from the workspace-config test plan. */
  readonly testId?: string;
}

const GLOBAL_ONLY = ["global"] as const;
const DEFAULTS_ONLY = ["defaults"] as const;
const WORKSPACE_ONLY = ["workspace"] as const;

interface RowSpec {
  /** Walker typeName (declared rows) or inventory-only kind marker. */
  readonly t: string;
  /** Schema default; presence means hasDefault. */
  readonly d?: unknown;
  readonly own: ConfigFieldOwnership;
  readonly ent?: ConfigEntityKind;
  readonly ss?: "passthrough" | "removed";
  readonly cap?: string;
  readonly res?: string;
  readonly con?: string;
  readonly wir: boolean;
  readonly st?: string;
  readonly ui: ConfigUiControlKind;
  readonly tid?: string;
}

function row(path: string, layer: readonly ConfigInheritanceLayer[], chainOf: string | undefined, s: RowSpec): ConfigFieldSpec {
  const workspaceEntity = path.startsWith("workspaces.instances.*.");
  return {
    path,
    valueKind: valueKindFromSchemaType(s.t),
    hasDefault: s.d !== undefined,
    ...(s.d !== undefined ? { defaultValue: s.d } : {}),
    ownership: workspaceEntity ? "entity" : s.own,
    ...(workspaceEntity ? { entityKind: "workspace" as const } : s.ent !== undefined ? { entityKind: s.ent } : {}),
    inheritance: layer,
    ...(chainOf !== undefined ? { chainOf } : {}),
    schemaStatus: s.ss ?? "declared",
    ...(s.cap !== undefined ? { capability: s.cap } : {}),
    ...(s.res !== undefined ? { resolver: s.res } : {}),
    ...(s.con !== undefined ? { consumer: s.con } : {}),
    wired: s.wir,
    ...(s.st !== undefined ? { status: s.st } : {}),
    uiControl: s.ui,
    ...(s.tid !== undefined ? { testId: s.tid } : {}),
  };
}

/** Global-layer row (no chain). */
const g = (path: string, s: RowSpec): ConfigFieldSpec => row(path, GLOBAL_ONLY, undefined, s);

// ---------------------------------------------------------------------------
// review tree: identical shape at global / workspaces.defaults / instances.*
// ---------------------------------------------------------------------------

const SCHEMA_ONLY_REVIEW = "schema-only; no runtime consumer (P4 wires review filters)";
const LAYER_NOT_CONSUMED = "workspace layer accepted but not consumed";

/** [suffix, type, meta] — defaults (`d`) apply to the global row only. */
const REVIEW_TREE: readonly (readonly [string, string, Omit<RowSpec, "t">])[] = [
  ["languages_auto_detect", "ZodBoolean", { d: true, own: "business", wir: false, st: SCHEMA_ONLY_REVIEW, ui: "toggle", tid: "H05" }],
  ["include", "ZodString[]", { d: ["**/*"], own: "business", wir: false, st: "schema-only; trigger-level include_cr_file is the wired filter", ui: "multiselect", tid: "H05" }],
  ["exclude", "ZodString[]", { d: ["**/vendor/**", "**/*.min.js", "**/*.lock"], own: "business", wir: false, st: "schema-only; trigger-level exclude_cr_file is the wired filter", ui: "multiselect", tid: "H05" }],
  ["max_files", "ZodNumber", { d: 50, own: "business", wir: false, st: SCHEMA_ONLY_REVIEW, ui: "number", tid: "H05" }],
  ["max_patch_bytes", "ZodNumber", { d: 200000, own: "business", wir: false, st: "schema-only; only referenced by an error hint", ui: "number", tid: "H05" }],
  ["incremental", "ZodBoolean", { d: true, own: "business", wir: false, st: SCHEMA_ONLY_REVIEW, ui: "toggle", tid: "H05" }],
  ["skip_lgtm", "ZodBoolean", { d: true, own: "business", wir: false, st: SCHEMA_ONLY_REVIEW, ui: "toggle", tid: "H05" }],
  ["output_language", "ZodString", { d: "zh-CN", own: "business", wir: true, con: "packages/server/src/bootstrap.ts review prompt options", cap: "workspace layer accepted but not consumed", ui: "select", tid: "H05" }],
  ["commit_strategy", "ZodEnum", { d: "aggregate", own: "business", wir: false, st: SCHEMA_ONLY_REVIEW, ui: "select", tid: "H05" }],
  ["auto_commit.delay_seconds", "ZodNumber", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/auto-commit-policy.ts:resolveAutoCommitPolicy", ui: "number" }],
  ["auto_commit.schedule.timezone", "ZodString", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/weekly-schedule.ts", ui: "text" }],
  ["auto_commit.schedule.rules[].days", "ZodEnum[]", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/weekly-schedule.ts", ui: "multiselect" }],
  ["auto_commit.schedule.rules[].windows[].start", "ZodString", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/weekly-schedule.ts", ui: "text" }],
  ["auto_commit.schedule.rules[].windows[].end", "ZodString", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/weekly-schedule.ts", ui: "text" }],
  ["auto_commit.exclude_sources[].id", "ZodString", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/auto-commit-exclusion.ts", ui: "text" }],
  ["auto_commit.exclude_sources[].vcs", "ZodEnum", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/auto-commit-exclusion.ts", ui: "select" }],
  ["auto_commit.include_branches", "ZodString[]", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/auto-commit-policy.ts", ui: "multiselect" }],
  ["pull_request.schedule.timezone", "ZodString", { own: "business", wir: true, res: "resolvePullRequestPolicy", con: "packages/core/src/weekly-schedule.ts", ui: "text" }],
  ["pull_request.schedule.rules[].days", "ZodEnum[]", { own: "business", wir: true, res: "resolvePullRequestPolicy", con: "packages/core/src/weekly-schedule.ts", ui: "multiselect" }],
  ["pull_request.schedule.rules[].windows[].start", "ZodString", { own: "business", wir: true, res: "resolvePullRequestPolicy", con: "packages/core/src/weekly-schedule.ts", ui: "text" }],
  ["pull_request.schedule.rules[].windows[].end", "ZodString", { own: "business", wir: true, res: "resolvePullRequestPolicy", con: "packages/core/src/weekly-schedule.ts", ui: "text" }],
  ["pull_request.include_target_branches", "ZodString[]", { own: "business", wir: true, res: "resolvePullRequestPolicy", con: "packages/core/src/pull-request-policy.ts", ui: "multiselect" }],
  ["log_thinking", "ZodBoolean", { own: "business", wir: true, con: "packages/server/src/review-orchestrator.ts thinking log gate", cap: "workspace layer accepted but not consumed", ui: "toggle", tid: "H05" }],
  ["git.allow_deepen", "ZodBoolean", { own: "business", wir: true, con: "packages/vcs/src/git.ts allowDeepen", cap: "workspace layer accepted but not consumed", ui: "toggle", tid: "H05" }],
  ["labels.ignore", "ZodString[]", { own: "business", wir: true, res: "review labels resolver", con: "packages/server/src/bootstrap.ts review labels resolver", ui: "multiselect", tid: "H05" }],
  ["labels.auto_tag", "ZodString", { own: "business", wir: true, res: "review labels resolver", con: "packages/server/src/bootstrap.ts review labels resolver", ui: "text", tid: "H05" }],
  ["labels.reviewed_tag", "ZodString", { own: "business", wir: true, res: "review labels resolver", con: "packages/server/src/bootstrap.ts review labels resolver", ui: "text", tid: "H05" }],
  ["problem_issue.max_recent_issues", "ZodNumber", { own: "business", wir: true, res: "resolveProblemIssueMaxRecentIssues", con: "packages/server/src/bootstrap.ts:resolveProblemIssueMaxRecentIssues", ui: "number", tid: "H05" }],
  ["fetch_extra.max_bytes", "ZodNumber", { own: "business", wir: false, st: "schema-only; agent-driven fetchExtraContext has no config budget wiring", ui: "number", tid: "H05" }],
  ["fetch_extra.max_files", "ZodNumber", { own: "business", wir: false, st: SCHEMA_ONLY_REVIEW, ui: "number", tid: "H05" }],
  ["fetch_extra.allow_paths", "ZodString[]", { own: "business", wir: false, st: SCHEMA_ONLY_REVIEW, ui: "multiselect", tid: "H05" }],
  ["reflection.enabled", "ZodBoolean", { own: "business", wir: true, con: "packages/server/src/bootstrap.ts reflection wiring", cap: "workspace layer accepted but not consumed", ui: "toggle" }],
  ["reflection.mode", "ZodEnum", { own: "business", wir: true, con: "packages/server/src/bootstrap.ts reflection wiring", cap: "workspace layer accepted but not consumed", ui: "select" }],
  ["reflection.memory.max_size_kb", "ZodNumber", { own: "business", wir: false, st: "schema-only; compaction reads entries/days only", ui: "number" }],
  ["reflection.memory.max_entries", "ZodNumber", { own: "business", wir: true, con: "packages/store/src/reflection.ts:compactReflectionMemory", cap: "workspace layer accepted but not consumed", ui: "number" }],
  ["reflection.memory.retention_days", "ZodNumber", { own: "business", wir: true, con: "packages/store/src/reflection.ts:compactReflectionMemory", cap: "workspace layer accepted but not consumed", ui: "number" }],
];

/** exclude_sources match triples: author_name/author_email/committer_name/committer_email/user/client/author × glob/regex/ignore_case. */
const EXCLUDE_SOURCE_MATCH_FIELDS = ["author_name", "author_email", "committer_name", "committer_email", "user", "client", "author"] as const;

const REVIEW_TREE_EXPANDED: readonly (readonly [string, string, Omit<RowSpec, "t">])[] = [
  ...REVIEW_TREE,
  ...EXCLUDE_SOURCE_MATCH_FIELDS.flatMap(
    (field): readonly (readonly [string, string, Omit<RowSpec, "t">])[] => [
      [`auto_commit.exclude_sources[].match.${field}.glob`, "ZodString", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/auto-commit-exclusion.ts", ui: "text" }],
      [`auto_commit.exclude_sources[].match.${field}.regex`, "ZodString", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/auto-commit-exclusion.ts", ui: "text" }],
      [`auto_commit.exclude_sources[].match.${field}.ignore_case`, "ZodBoolean", { own: "business", wir: true, res: "resolveAutoCommitPolicy", con: "packages/core/src/auto-commit-exclusion.ts", ui: "toggle" }],
    ],
  ),
];

/** Suffixes whose defaults/workspace layer instances are not consumed. */
const REVIEW_LAYER_UNWIRED = new Set([
  "output_language",
  "log_thinking",
  "git.allow_deepen",
  "reflection.enabled",
  "reflection.mode",
  "reflection.memory.max_entries",
  "reflection.memory.retention_days",
]);

function reviewTreeRows(): ConfigFieldSpec[] {
  const rows: ConfigFieldSpec[] = [];
  for (const [suffix, type, meta] of REVIEW_TREE_EXPANDED) {
    rows.push(row(`review.${suffix}`, GLOBAL_ONLY, undefined, { ...meta, t: type }));
    for (const [prefix, layer] of [
      ["workspaces.defaults.review", DEFAULTS_ONLY],
      ["workspaces.instances.*.review", WORKSPACE_ONLY],
    ] as const) {
    const layered: RowSpec = { ...meta, t: type };
      // Layer instances never carry schema defaults of their own.
      delete (layered as { d?: unknown }).d;
      if (REVIEW_LAYER_UNWIRED.has(suffix)) {
        rows.push(row(`${prefix}.${suffix}`, layer, `review.${suffix}`, { ...layered, wir: false, st: LAYER_NOT_CONSUMED }));
      } else if (meta.wir) {
        rows.push(row(`${prefix}.${suffix}`, layer, `review.${suffix}`, layered));
      } else {
        rows.push(row(`${prefix}.${suffix}`, layer, `review.${suffix}`, layered));
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// outputs tree at workspaces.defaults / workspaces.instances.* (no global twin
// for line_comments/summary; channel_overrides mirror the global no_problems)
// ---------------------------------------------------------------------------

function workspaceOutputsRows(): ConfigFieldSpec[] {
  const rows: ConfigFieldSpec[] = [];
  const entries: readonly (readonly [string, string, Omit<RowSpec, "t">, string | undefined])[] = [
    ["line_comments", "ZodString[]", { own: "business", wir: true, res: "resolveOutputChannelNames", con: "packages/server/src/bootstrap.ts:resolveOutputChannelNames", ui: "multiselect" }, undefined],
    ["summary", "ZodString[]", { own: "business", wir: true, res: "resolveOutputChannelNames", con: "packages/server/src/bootstrap.ts:resolveOutputChannelNames", ui: "multiselect" }, undefined],
    ["no_problems.action", "ZodEnum", { own: "business", wir: true, res: "resolveNoProblemsAction", con: "packages/server/src/bootstrap.ts:resolveNoProblemsAction", ui: "select", tid: "R09" }, "outputs.no_problems.action"],
    ["no_findings", "ZodNever", { own: "business", wir: false, ss: "removed", st: "removed alias; rejected by schema", ui: "toggle", tid: "B03" }, "outputs.no_findings"],
    ["channel_overrides.*.no_problems.action", "ZodEnum", { own: "business", wir: true, res: "resolveNoProblemsAction", con: "packages/server/src/bootstrap.ts:resolveNoProblemsAction", cap: "per-channel override", ui: "select", tid: "R09" }, "outputs.no_problems.action"],
    ["channel_overrides.*.no_findings", "ZodNever", { own: "business", wir: false, ss: "removed", st: "removed alias; rejected by schema", ui: "toggle", tid: "B03" }, "outputs.no_findings"],
  ];
  for (const [prefix, layer] of [
    ["workspaces.defaults.outputs", DEFAULTS_ONLY],
    ["workspaces.instances.*.outputs", WORKSPACE_ONLY],
  ] as const) {
    for (const [suffix, type, meta, chain] of entries) {
      rows.push(row(`${prefix}.${suffix}`, layer, chain, { ...meta, t: type }));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// sandbox tree at workspaces.defaults / workspaces.instances.* (unwired)
// ---------------------------------------------------------------------------

function workspaceSandboxRows(): ConfigFieldSpec[] {
  const meta: Omit<RowSpec, "t" | "ui"> = {
    own: "business",
    wir: false,
    st: "schema-only; workspace-layer sandbox has no consumer (P4 wires it)",
  };
  const entries: readonly (readonly [string, string, ConfigUiControlKind])[] = [
    ["kind", "ZodEnum", "select"],
    ["engine", "ZodEnum", "select"],
    ["image", "ZodString", "text"],
  ];
  const rows: ConfigFieldSpec[] = [];
  for (const [prefix, layer] of [
    ["workspaces.defaults.sandbox", DEFAULTS_ONLY],
    ["workspaces.instances.*.sandbox", WORKSPACE_ONLY],
  ] as const) {
    for (const [suffix, type, ui] of entries) {
      rows.push(row(`${prefix}.${suffix}`, layer, `agent.sandbox.${suffix}`, { ...meta, t: type, ui, tid: "H04" }));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// context_repositories at workspaces.defaults / workspaces.instances.*
// ---------------------------------------------------------------------------

function contextRepositoryRows(): ConfigFieldSpec[] {
  const con = "packages/server/src/bootstrap.ts context repositories resolver";
  const entries: readonly (readonly [string, string, Omit<RowSpec, "t" | "own" | "wir" | "con">])[] = [
    ["alias", "ZodString", { ui: "text" }],
    ["kind", "ZodEnum", { ui: "select", cap: "per-kind field exclusivity enforced by schema" }],
    ["url", "ZodString", { ui: "text", cap: "git kinds" }],
    ["ref", "ZodString", { ui: "text", cap: "git kinds" }],
    ["token_env", "ZodString", { ui: "secret-ref", cap: "git kinds" }],
    ["repository_url", "ZodString", { ui: "text", cap: "svn only" }],
    ["revision", "union", { ui: "text", cap: "svn only" }],
    ["port", "ZodString", { ui: "text", cap: "p4 only" }],
    ["user_env", "ZodString", { ui: "secret-ref", cap: "p4 only" }],
    ["ticket_env", "ZodString", { ui: "secret-ref", cap: "p4 only" }],
    ["password_env", "ZodString", { ui: "secret-ref", cap: "p4 only" }],
    ["depot_path", "ZodString", { ui: "text", cap: "p4 only" }],
    ["max_mb", "ZodNumber", { ui: "number" }],
  ];
  const rows: ConfigFieldSpec[] = [];
  for (const [prefix, layer, own, ent] of [
    ["workspaces.defaults.context_repositories[]", DEFAULTS_ONLY, "business", undefined],
    ["workspaces.instances.*.context_repositories[]", WORKSPACE_ONLY, "entity", "workspace"],
  ] as const) {
    for (const [suffix, type, meta] of entries) {
      rows.push(
        row(`${prefix}.${suffix}`, layer, undefined, {
          ...meta,
          t: type,
          own: own as ConfigFieldOwnership,
          ...(ent !== undefined ? { ent: ent as ConfigEntityKind } : {}),
          wir: true,
          con,
        }),
      );
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// llm.model_catalog.overrides.* — 58 declared metadata leaves, one consumer
// ---------------------------------------------------------------------------

// Catalog metadata fields. The same key set appears as declared leaves under
// llm.model_catalog.overrides.* and as consumed passthrough keys on provider
// records (MODEL_CATALOG_FIELD_KEY_MAP, bootstrap applyModelCatalogProviderFields).
export const MODEL_CATALOG_FIELD_ROWS: readonly (readonly [string, string, ConfigUiControlKind])[] = [
  ["catalog_id", "ZodString", "text"],
  ["context_window", "ZodNumber", "number"],
  ["max_input_tokens", "ZodNumber", "number"],
  ["max_output_tokens", "ZodNumber", "number"],
  ["cost_input_per_mtok", "ZodNumber", "number"],
  ["cost_output_per_mtok", "ZodNumber", "number"],
  ["cost_cache_read_per_mtok", "ZodNumber", "number"],
  ["cost_cache_write_per_mtok", "ZodNumber", "number"],
  ["cost_reasoning_per_mtok", "ZodNumber", "number"],
  ["cost_input_audio_per_mtok", "ZodNumber", "number"],
  ["cost_output_audio_per_mtok", "ZodNumber", "number"],
  ["supports_tool_call", "ZodBoolean", "toggle"],
  ["supports_attachment", "ZodBoolean", "toggle"],
  ["supports_vision", "ZodBoolean", "toggle"],
  ["supports_cache_prompt", "ZodBoolean", "toggle"],
  ["supports_reasoning", "ZodBoolean", "toggle"],
  ["supported_reasoning_efforts", "ZodEnum[]", "multiselect"],
  ["default_reasoning_effort", "ZodEnum", "select"],
  ["thinking_modes", "ZodString[]", "multiselect"],
  ["supports_interleaved_reasoning", "ZodBoolean", "toggle"],
  ["interleaved_reasoning_field", "ZodString", "text"],
  ["supports_structured_output", "ZodBoolean", "toggle"],
  ["supports_temperature", "ZodBoolean", "toggle"],
  ["supports_streaming", "ZodBoolean", "toggle"],
  ["supports_logprobs", "ZodBoolean", "toggle"],
  ["supports_search", "ZodBoolean", "toggle"],
  ["supports_computer_use", "ZodBoolean", "toggle"],
  ["native_tool_capabilities", "ZodString[]", "multiselect"],
  ["supported_request_parameters", "ZodString[]", "multiselect"],
  ["unsupported_request_parameters", "ZodString[]", "multiselect"],
  ["input_modalities", "ZodString[]", "multiselect"],
  ["output_modalities", "ZodString[]", "multiselect"],
  ["display_name", "ZodString", "text"],
  ["family", "ZodString", "text"],
  ["knowledge_cutoff", "ZodString", "text"],
  ["training_cutoff", "ZodString", "text"],
  ["release_date", "ZodString", "text"],
  ["last_updated", "ZodString", "text"],
  ["model_status", "ZodEnum", "select"],
  ["open_weights", "ZodBoolean", "toggle"],
  ["license", "ZodString", "text"],
  ["model_links.*", "ZodString", "text"],
  ["provider_display_name", "ZodString", "text"],
  ["provider_npm_package", "ZodString", "text"],
  ["provider_env_vars", "ZodString[]", "multiselect"],
  ["provider_api_base_url", "ZodString", "text"],
  ["provider_docs_url", "ZodString", "text"],
  ["provider_model_aliases", "ZodString[]", "multiselect"],
  ["provider_model_ids", "ZodString[]", "multiselect"],
  ["preferred_endpoint", "ZodString", "text"],
  ["latency_class", "ZodString", "text"],
  ["priority_tier_supported", "ZodBoolean", "toggle"],
  ["rate_limit_tier", "ZodString", "text"],
  ["concurrency_limit", "ZodNumber", "number"],
  ["throughput_hint_tokens_per_second", "ZodNumber", "number"],
];

function modelCatalogOverrideRows(): ConfigFieldSpec[] {
  const meta = {
    own: "business" as const,
    wir: true,
    res: "normalizeModelCatalogOverrides",
    con: "packages/server/src/bootstrap.ts:normalizeModelCatalogOverrides",
  };
  return MODEL_CATALOG_FIELD_ROWS.map(([suffix, type, ui]) =>
    row(`llm.model_catalog.overrides.*.${suffix}`, GLOBAL_ONLY, undefined, { ...meta, t: type, ui }),
  );
}

/**
 * Provider-level catalog hints: llmProviderSchema is passthrough and
 * bootstrap.applyModelCatalogProviderFields reads every
 * MODEL_CATALOG_FIELD_KEY_MAP key from the raw provider record into the
 * ModelSpec. catalog_id is declared on the provider schema, so only the
 * passthrough remainder is emitted here.
 */
function providerCatalogFieldRows(): ConfigFieldSpec[] {
  return MODEL_CATALOG_FIELD_ROWS.filter(([suffix]) => suffix !== "catalog_id").map(([suffix, , ui]) =>
    row(`llm.providers[].${suffix === "model_links.*" ? "model_links" : suffix}`, GLOBAL_ONLY, undefined, {
      t: "ZodUnknown",
      own: "entity",
      ent: "provider",
      ss: "passthrough",
      cap: "catalog hint consumed into ModelSpec (MODEL_CATALOG_FIELD_KEY_MAP)",
      con: "packages/server/src/bootstrap.ts:applyModelCatalogProviderFields",
      wir: true,
      ui: suffix === "model_links.*" ? "map" : ui,
    }),
  );
}

// ---------------------------------------------------------------------------
// model chain entry overrides (schema-accepted; resolver wiring lands in P4)
// ---------------------------------------------------------------------------

const OVERRIDES_P4 = "schema-accepted at P0; resolveModelSpecFromChain wiring lands in P4";

function modelChainOverrideRows(): ConfigFieldSpec[] {
  const meta = { own: "entity" as const, ent: "model_group" as const, wir: false, st: OVERRIDES_P4, tid: "H02" };
  const entries: readonly (readonly [string, string, ConfigUiControlKind])[] = [
    ["extra_params.*", "ZodUnknown", "map"],
    ["extra_body.*", "ZodUnknown", "map"],
    ["extra_headers.*", "ZodString", "map"],
    ["reasoning_effort", "ZodEnum", "select"],
    ["thinking_level", "ZodEnum", "select"],
    ["thinking_budget_tokens", "ZodNumber", "number"],
    ["thinking.enabled", "ZodBoolean", "toggle"],
    ["response_format.kind", "ZodEnum", "select"],
    ["tool_choice", "union", "select"],
    ["parallel_tool_calls", "ZodBoolean", "toggle"],
    ["seed", "ZodNumber", "number"],
    ["logit_bias.*", "ZodNumber", "map"],
    ["drop_params", "ZodString[]", "multiselect"],
    ["allowed_openai_params", "ZodString[]", "multiselect"],
  ];
  return entries.map(([suffix, type, ui]) =>
    row(`llm.model_chain.*[].overrides.${suffix}`, GLOBAL_ONLY, undefined, { ...meta, t: type, ui }),
  );
}

// ---------------------------------------------------------------------------
// The permanent inventory
// ---------------------------------------------------------------------------

export const CONFIG_FIELD_INVENTORY: readonly ConfigFieldSpec[] = [
  // ------------------------------------------------------- server (bootstrap)
  g("server.port", { t: "ZodNumber", d: 8080, own: "bootstrap", res: "node-serve", con: "packages/server/src/node-serve.ts", wir: true, ui: "number" }),
  g("server.hostname", { t: "ZodString", d: "0.0.0.0", own: "bootstrap", res: "node-serve", con: "packages/server/src/node-serve.ts", wir: true, ui: "text" }),
  g("server.trust_proxy", { t: "union", d: false, own: "bootstrap", res: "node-serve", con: "packages/server/src/node-serve.ts", wir: true, ui: "select" }),
  g("server.base_url", { t: "ZodString", own: "bootstrap", con: "packages/server/src/bootstrap.ts webhook URL composition", wir: true, ui: "text" }),
  g("server.path_prefix", { t: "ZodString", own: "bootstrap", res: "node-serve", con: "packages/server/src/node-serve.ts", wir: true, ui: "text" }),
  g("server.auth.api_key_env", { t: "ZodString", own: "bootstrap", res: "resolveAuthConfig", con: "packages/server/src/bootstrap.ts:resolveAuthConfig", wir: true, ui: "secret-ref" }),
  g("server.auth.enabled", { t: "ZodBoolean", d: true, own: "bootstrap", res: "resolveAuthConfig", con: "packages/server/src/bootstrap.ts:resolveAuthConfig", wir: true, ui: "toggle" }),

  // ------------------------------------------------------- admin (bootstrap)
  g("admin.username_env", { t: "ZodString", d: "AICR_ADMIN_USERNAME", own: "bootstrap", con: "packages/server/src/admin-auth.ts", wir: true, ui: "secret-ref" }),
  g("admin.password_env", { t: "ZodString", d: "AICR_ADMIN_PASSWORD", own: "bootstrap", con: "packages/server/src/admin-auth.ts", wir: true, ui: "secret-ref" }),
  g("admin.password_hash_env", { t: "ZodString", own: "bootstrap", con: "packages/server/src/admin-auth.ts", wir: true, ui: "secret-ref" }),
  g("admin.session_ttl_seconds", { t: "ZodNumber", d: 86400, own: "bootstrap", con: "packages/server/src/admin-auth.ts", wir: true, ui: "number" }),

  // ------------------------------------------------------- storage (bootstrap)
  g("storage.database.kind", { t: "ZodEnum", d: "sqlite", own: "bootstrap", cap: "postgres requires the P2 store service", con: "packages/server/src/bootstrap.ts store wiring", wir: true, st: "postgres kind is rejected at bootstrap until P2", ui: "select" }),
  g("storage.database.sqlite.path", { t: "ZodString", d: "/app/data/aicr.sqlite", own: "bootstrap", con: "packages/store/src/database.ts", wir: true, ui: "text" }),
  g("storage.database.postgres.url_env", { t: "ZodString", own: "bootstrap", wir: false, st: "schema-only until the P2 PostgreSQL store", ui: "secret-ref" }),
  g("storage.cache.kind", { t: "ZodEnum", d: "memory", own: "bootstrap", con: "packages/server/src/bootstrap.ts catalog cache", wir: true, ui: "select" }),
  g("storage.cache.redis.url_env", { t: "ZodString", own: "bootstrap", con: "packages/server/src/bootstrap.ts redis wiring", wir: true, ui: "secret-ref" }),
  g("storage.cache.ttl_seconds", { t: "ZodNumber", own: "bootstrap", wir: false, st: "schema-only; no consumer reads the cache TTL", ui: "number" }),
  g("storage.object.kind", { t: "ZodEnum", d: "filesystem", own: "bootstrap", wir: false, st: "schema-only; object storage is not wired", ui: "select" }),
  g("storage.object.filesystem.root", { t: "ZodString", d: "/app/data/objects", own: "bootstrap", wir: false, st: "schema-only; object storage is not wired", ui: "text" }),
  g("storage.object.s3.endpoint_url_env", { t: "ZodString", own: "bootstrap", wir: false, st: "schema-only; object storage is not wired", ui: "secret-ref" }),
  g("storage.object.s3.bucket", { t: "ZodString", own: "bootstrap", wir: false, st: "schema-only; object storage is not wired", ui: "text" }),
  g("storage.object.s3.region_env", { t: "ZodString", own: "bootstrap", wir: false, st: "schema-only; object storage is not wired", ui: "secret-ref" }),
  g("storage.object.s3.access_key_id_env", { t: "ZodString", own: "bootstrap", wir: false, st: "schema-only; object storage is not wired", ui: "secret-ref" }),
  g("storage.object.s3.secret_access_key_env", { t: "ZodString", own: "bootstrap", wir: false, st: "schema-only; object storage is not wired", ui: "secret-ref" }),
  g("storage.object.s3.force_path_style", { t: "ZodBoolean", own: "bootstrap", wir: false, st: "schema-only; object storage is not wired", ui: "toggle" }),
  g("storage.retention.deleted_project_grace_days", { t: "ZodNumber", d: 30, own: "bootstrap", con: "packages/store/src retention sweep", wir: true, ui: "number" }),

  // ------------------------------------------------------- llm providers (entity)
  g("llm.providers[].id", { t: "ZodString", own: "entity", ent: "provider", res: "resolveModelSpecFromChain", con: "packages/server/src/bootstrap.ts provider lookup", wir: true, ui: "text", tid: "C01" }),
  g("llm.providers[].kind", { t: "ZodEnum", own: "entity", ent: "provider", cap: "direct LLM client implements openai_compatible/ollama/azure_openai/anthropic/google_ai_studio; vertex_ai/bedrock/copilot throw at createChatClientFromModelSpec", con: "packages/llm/src/index.ts:createChatClientFromModelSpec", wir: true, ui: "select" }),
  g("llm.providers[].base_url", { t: "ZodString", own: "entity", ent: "provider", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "text" }),
  g("llm.providers[].api_key_env", { t: "ZodString", own: "entity", ent: "provider", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "secret-ref" }),
  g("llm.providers[].api_version", { t: "ZodString", own: "entity", ent: "provider", cap: "azure_openai only", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "text" }),
  g("llm.providers[].catalog_provider", { t: "ZodString", own: "entity", ent: "provider", con: "packages/server/src/bootstrap.ts providerHints", wir: true, ui: "text" }),
  g("llm.providers[].catalog_id", { t: "ZodString", own: "entity", ent: "provider", con: "packages/server/src/bootstrap.ts providerHints", wir: true, ui: "text" }),
  g("llm.providers[].organization", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "text" }),
  g("llm.providers[].extra_headers", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "map" }),
  g("llm.providers[].extra_body", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "map" }),
  g("llm.providers[].extra_params", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "terminal depth varies by agent adapter (zoo reads temperature/top_p only)", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "map" }),
  g("llm.providers[].http_proxy", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "text" }),
  g("llm.providers[].timeout_ms", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "number" }),
  g("llm.providers[].max_retries", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "number" }),
  g("llm.providers[].vertex_project", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "vertex_ai only", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "text" }),
  g("llm.providers[].vertex_location", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "vertex_ai only", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "text" }),
  ...providerCatalogFieldRows(),
  g("llm.providers[].aws_access_key_env", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "bedrock only", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "secret-ref" }),
  g("llm.providers[].aws_secret_key_env", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "bedrock only", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "secret-ref" }),
  g("llm.providers[].aws_session_token_env", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "bedrock only", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "secret-ref" }),
  g("llm.providers[].aws_profile", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "bedrock only", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "text" }),
  g("llm.providers[].anthropic_version", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "anthropic only", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "text" }),
  g("llm.providers[].anthropic_beta", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "anthropic only", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "text" }),
  g("llm.providers[].cache_control", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", cap: "anthropic prompt caching", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "map" }),
  g("llm.providers[].reasoning_effort", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "select" }),
  g("llm.providers[].thinking_level", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "select" }),
  g("llm.providers[].thinking_budget_tokens", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "number" }),
  g("llm.providers[].thinking", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:readThinking", wir: true, ui: "map" }),
  g("llm.providers[].response_format", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:readResponseFormat", wir: true, ui: "map" }),
  g("llm.providers[].tool_choice", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:readToolChoice", wir: true, ui: "select" }),
  g("llm.providers[].parallel_tool_calls", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "toggle" }),
  g("llm.providers[].seed", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "number" }),
  g("llm.providers[].logit_bias", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "map" }),
  g("llm.providers[].drop_params", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "multiselect" }),
  g("llm.providers[].allowed_openai_params", { t: "ZodUnknown", own: "entity", ent: "provider", ss: "passthrough", con: "packages/server/src/bootstrap.ts:resolveModelProviderFields", wir: true, ui: "multiselect" }),

  // ------------------------------------------------------- llm model groups (entity)
  g("llm.model_chain.*[].provider", { t: "ZodString", own: "entity", ent: "model_group", res: "resolveModelSpecFromChain", con: "packages/server/src/bootstrap.ts:resolveModelSpecFromChain", wir: true, ui: "select" }),
  g("llm.model_chain.*[].model", { t: "ZodString", own: "entity", ent: "model_group", res: "resolveModelSpecFromChain", con: "packages/server/src/bootstrap.ts:resolveModelSpecFromChain", wir: true, ui: "text" }),
  g("llm.model_chain.*[].role", { t: "ZodEnum", own: "entity", ent: "model_group", res: "resolveSummarizeModelFromChain", con: "packages/server/src/bootstrap.ts:resolveSummarizeModelFromChain", wir: true, ui: "select" }),
  ...modelChainOverrideRows(),

  // ------------------------------------------------------- llm globals
  g("llm.default_model_chain", { t: "ZodString", d: "default", own: "business", res: "resolveModelChainNames", con: "packages/server/src/bootstrap.ts:resolveModelChainNames", wir: true, ui: "select" }),
  g("llm.triage_model_chain", { t: "ZodString", own: "business", res: "resolveModelChainNames", con: "packages/server/src/bootstrap.ts:resolveIssueTriageModelSpecFromConfig", wir: true, ui: "select" }),
  g("llm.retry.max_attempts", { t: "ZodNumber", own: "business", res: "toGatewayRetry", con: "packages/server/src/bootstrap.ts:toGatewayRetry", wir: true, ui: "number" }),
  g("llm.retry.respect_retry_after", { t: "ZodBoolean", own: "business", res: "toGatewayRetry", con: "packages/server/src/bootstrap.ts:toGatewayRetry", wir: true, ui: "toggle" }),
  g("llm.retry.backoff.kind", { t: "ZodEnum", own: "business", res: "toGatewayRetry", con: "packages/server/src/bootstrap.ts:toGatewayRetry", wir: true, ui: "select" }),
  g("llm.retry.backoff.base_ms", { t: "ZodNumber", own: "business", res: "toGatewayRetry", con: "packages/server/src/bootstrap.ts:toGatewayRetry", wir: true, ui: "number" }),
  g("llm.retry.backoff.max_ms", { t: "ZodNumber", own: "business", res: "toGatewayRetry", con: "packages/server/src/bootstrap.ts:toGatewayRetry", wir: true, ui: "number" }),
  g("llm.retry.backoff.jitter", { t: "ZodBoolean", own: "business", res: "toGatewayRetry", con: "packages/server/src/bootstrap.ts:toGatewayRetry", wir: true, ui: "toggle" }),
  g("llm.retry.give_up_after_seconds", { t: "ZodNumber", own: "business", res: "toGatewayRetry", con: "packages/server/src/bootstrap.ts:toGatewayRetry", wir: true, ui: "number" }),
  g("llm.per_provider_overrides.*.max_attempts", { t: "ZodNumber", own: "business", res: "toGatewayPerProviderOverrides", con: "packages/server/src/bootstrap.ts:toGatewayPerProviderOverrides", wir: true, ui: "number" }),
  g("llm.per_provider_overrides.*.give_up_after_seconds", { t: "ZodNumber", own: "business", res: "toGatewayPerProviderOverrides", con: "packages/server/src/bootstrap.ts:toGatewayPerProviderOverrides", wir: true, ui: "number" }),
  g("llm.budget.per_run_usd", { t: "ZodNumber", own: "business", res: "toGatewayBudget", con: "packages/server/src/bootstrap.ts:toGatewayBudget", wir: true, ui: "number" }),
  g("llm.budget.per_repo_daily_usd", { t: "ZodNumber", own: "business", res: "toGatewayBudget", con: "packages/server/src/bootstrap.ts:toGatewayBudget", wir: true, ui: "number" }),

  // ------------------------------------------------------- llm model catalog
  g("llm.model_catalog.enabled", { t: "ZodBoolean", d: false, own: "business", con: "packages/server/src/model-catalog-service.ts", wir: true, ui: "toggle" }),
  g("llm.model_catalog.source_url", { t: "ZodString", d: "https://models.dev/api.json", own: "business", con: "packages/server/src/model-catalog-service.ts", wir: true, ui: "text" }),
  g("llm.model_catalog.refresh_interval_hours", { t: "ZodNumber", d: 24, own: "business", con: "packages/server/src/model-catalog-service.ts", wir: true, ui: "number" }),
  g("llm.model_catalog.fetch_timeout_ms", { t: "ZodNumber", d: 10000, own: "business", con: "packages/server/src/model-catalog-service.ts", wir: true, ui: "number" }),
  g("llm.model_catalog.offline", { t: "ZodBoolean", d: false, own: "business", con: "packages/server/src/model-catalog-service.ts", wir: true, ui: "toggle" }),
  g("llm.model_catalog.apply_to_model_spec", { t: "ZodBoolean", d: true, own: "business", res: "buildGatewayModelPricing", con: "packages/server/src/bootstrap.ts:buildGatewayModelPricing", wir: true, ui: "toggle" }),
  g("llm.model_catalog.cache.backend", { t: "ZodEnum", d: "sqlite", own: "business", con: "packages/server/src/model-catalog-service.ts", wir: true, ui: "select" }),
  ...modelCatalogOverrideRows(),

  // ------------------------------------------------------- triggers (entity)
  g("triggers[].name", { t: "ZodString", own: "entity", ent: "trigger", con: "packages/server/src/bootstrap.ts triggerByName", wir: true, ui: "text" }),
  g("triggers[].kind", { t: "ZodEnum", own: "entity", ent: "trigger", cap: "scheduled/manual kinds have no resolver; accepted but inert", con: "packages/server/src/bootstrap.ts trigger resolvers", wir: true, st: "scheduled and manual kinds are schema-only until a trusted envelope exists", ui: "select" }),
  g("triggers[].enabled", { t: "ZodBoolean", own: "entity", ent: "trigger", con: "packages/server/src/bootstrap.ts:triggerAdmitsNewWork", wir: true, ui: "toggle", tid: "W12" }),
  g("triggers[].watch_path", { t: "ZodString[]", own: "entity", ent: "trigger", cap: "wired for p4/svn only; unread on gitea/forgejo/github/gitlab", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "multiselect" }),
  g("triggers[].include_cr_file", { t: "ZodString[]", own: "entity", ent: "trigger", cap: "wired for p4/svn only; unread on git kinds", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "multiselect" }),
  g("triggers[].exclude_cr_file", { t: "ZodString[]", own: "entity", ent: "trigger", cap: "wired for p4/svn only; unread on git kinds", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "multiselect" }),
  g("triggers[].commit_url_template", { t: "ZodString", own: "entity", ent: "trigger", con: "packages/server/src/bootstrap.ts channel template fallback", wir: true, ui: "path-template" }),
  g("triggers[].revision_url_template", { t: "ZodString", own: "entity", ent: "trigger", con: "packages/server/src/bootstrap.ts channel template fallback", wir: true, ui: "path-template" }),
  g("triggers[].change_url_template", { t: "ZodString", own: "entity", ent: "trigger", con: "packages/server/src/bootstrap.ts channel template fallback", wir: true, ui: "path-template" }),
  g("triggers[].app.app_id", { t: "union", own: "entity", ent: "trigger", cap: "github only", con: "packages/server/src/github-app-token.ts:resolveGithubAppTriggerAuth", wir: true, ui: "text" }),
  g("triggers[].app.client_id", { t: "ZodString", own: "entity", ent: "trigger", cap: "github only", con: "packages/server/src/github-app-token.ts:resolveGithubAppTriggerAuth", wir: true, ui: "text" }),
  g("triggers[].app.private_key_env", { t: "ZodString", own: "entity", ent: "trigger", cap: "github only; mutually exclusive with private_key_path", con: "packages/server/src/github-app-token.ts:resolveGithubAppTriggerAuth", wir: true, ui: "secret-ref" }),
  g("triggers[].app.private_key_path", { t: "ZodString", own: "entity", ent: "trigger", cap: "github only; mutually exclusive with private_key_env", con: "packages/server/src/github-app-token.ts:resolveGithubAppTriggerAuth", wir: true, ui: "text" }),
  g("triggers[].app.installation_id", { t: "union", own: "entity", ent: "trigger", cap: "github only", con: "packages/server/src/github-app-token.ts:resolveGithubAppTriggerAuth", wir: true, ui: "text" }),
  g("triggers[].token_env", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "git kinds outbound auth; mutually exclusive with app", con: "packages/server/src/bootstrap.ts:buildWebhookConfigFromTrigger", wir: true, ui: "secret-ref" }),
  g("triggers[].webhook_secret_env", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "git kinds inbound signature", con: "packages/server/src/webhook-common.ts:verifyWebhookSignature", wir: true, ui: "secret-ref" }),
  g("triggers[].base_url", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", con: "packages/server/src/bootstrap.ts:buildWebhookConfigFromTrigger", wir: true, ui: "text" }),
  g("triggers[].repos", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "legacy exact/suffix match; never reinterpreted as glob", res: "withRepoMappings", con: "packages/server/src/bootstrap.ts:resolveRepoMappings", wir: true, ui: "ordered-list", tid: "W10" }),
  g("triggers[].port", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "p4 only", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "text" }),
  g("triggers[].user_env", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "p4 only", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "secret-ref" }),
  g("triggers[].ticket_env", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "p4 only", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "secret-ref" }),
  g("triggers[].password_env", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "p4 only", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "secret-ref" }),
  g("triggers[].depot_path", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "p4 only", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "text" }),
  g("triggers[].streams", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "p4 only; streams[0] must not scope every event", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "multiselect" }),
  g("triggers[].workspace", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "p4 service client", con: "packages/server/src/bootstrap.ts:resolveP4TriggerConfig", wir: true, ui: "text" }),
  g("triggers[].repository_url", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "svn only; whitelist-bound", con: "packages/server/src/bootstrap.ts:resolveSvnTriggerConfig", wir: true, ui: "text" }),
  g("triggers[].trust_server_cert", { t: "ZodUnknown", own: "entity", ent: "trigger", ss: "passthrough", cap: "svn only", con: "packages/server/src/bootstrap.ts:createSvnVcsAdapter", wir: true, ui: "toggle" }),

  // ------------------------------------------------------- outputs globals
  g("outputs.template_engine", { t: "ZodEnum", d: "handlebars", own: "business", con: "packages/outputs/src template engine", wir: true, ui: "select" }),
  g("outputs.no_problems.action", { t: "ZodEnum", own: "business", res: "resolveNoProblemsAction", con: "packages/server/src/bootstrap.ts:resolveNoProblemsAction", wir: true, ui: "select", tid: "R09" }),
  g("outputs.no_findings", { t: "ZodNever", own: "business", ss: "removed", wir: false, st: "removed alias; rejected by schema", ui: "toggle", tid: "B03" }),
  g("outputs.author_resolution.email_mappings.*", { t: "ZodString", own: "business", res: "buildAuthorResolutionOptions", con: "packages/server/src/bootstrap.ts:buildAuthorResolutionOptions", wir: true, ui: "text" }),
  g("outputs.author_resolution.email_blacklist", { t: "ZodString[]", own: "business", res: "buildAuthorResolutionOptions", con: "packages/server/src/bootstrap.ts:buildAuthorResolutionOptions", wir: true, ui: "multiselect" }),
  g("outputs.routes.default.match.trigger", { t: "ZodString", own: "business", res: "routeMatchesEvent", con: "packages/server/src/bootstrap.ts:routeMatchesEvent", wir: true, ui: "select", tid: "B02" }),
  g("outputs.routes.default.match.target_kind", { t: "ZodEnum", own: "business", cap: "alias pr normalizes to pull_request", res: "routeMatchesEvent", con: "packages/server/src/bootstrap.ts:routeMatchesEvent", wir: true, ui: "select", tid: "B02" }),
  g("outputs.routes.default.line_comments", { t: "ZodString[]", own: "business", cap: "empty array currently falls back; v2 makes [] an explicit disable", res: "resolveOutputChannelNames", con: "packages/server/src/bootstrap.ts:resolveOutputChannelNames", wir: true, ui: "multiselect", tid: "R05" }),
  g("outputs.routes.default.summary", { t: "ZodString[]", own: "business", res: "resolveOutputChannelNames", con: "packages/server/src/bootstrap.ts:resolveOutputChannelNames", wir: true, ui: "multiselect", tid: "B02" }),
  g("outputs.routes.rules[].match.trigger", { t: "ZodString", own: "business", cap: "ordered legacy rules; order is significant", res: "routeMatchesEvent", con: "packages/server/src/bootstrap.ts:routeMatchesEvent", wir: true, ui: "select", tid: "B02" }),
  g("outputs.routes.rules[].match.target_kind", { t: "ZodEnum", own: "business", res: "routeMatchesEvent", con: "packages/server/src/bootstrap.ts:routeMatchesEvent", wir: true, ui: "select", tid: "B02" }),
  g("outputs.routes.rules[].line_comments", { t: "ZodString[]", own: "business", res: "resolveOutputChannelNames", con: "packages/server/src/bootstrap.ts:resolveOutputChannelNames", wir: true, ui: "multiselect", tid: "B02" }),
  g("outputs.routes.rules[].summary", { t: "ZodString[]", own: "business", res: "resolveOutputChannelNames", con: "packages/server/src/bootstrap.ts:resolveOutputChannelNames", wir: true, ui: "multiselect", tid: "B02" }),

  // ------------------------------------------------------- channels (entity)
  g("outputs.channels[].name", { t: "ZodString", own: "entity", ent: "channel", res: "resolveOutputChannelNames", con: "packages/server/src/bootstrap.ts:resolveOutputChannelNames", wir: true, ui: "text" }),
  g("outputs.channels[].kind", { t: "ZodString", own: "entity", ent: "channel", cap: "9 built-in kinds; unknown kinds silently publish nothing today", con: "packages/server/src/bootstrap.ts:createChannelPublisherFromConfig", wir: true, ui: "select" }),
  g("outputs.channels[].trigger", { t: "ZodString", own: "entity", ent: "channel", con: "packages/server/src/bootstrap.ts channel trigger lookup", wir: true, ui: "select" }),
  g("outputs.channels[].mention_author", { t: "ZodBoolean", own: "entity", ent: "channel", res: "shouldMentionAuthor", con: "packages/server/src/bootstrap.ts:shouldMentionAuthor", wir: true, ui: "toggle" }),
  g("outputs.channels[].mention_fallback", { t: "ZodEnum", own: "entity", ent: "channel", res: "buildAuthorResolutionOptions", con: "packages/server/src/bootstrap.ts:buildAuthorResolutionOptions", wir: true, ui: "select" }),
  g("outputs.channels[].no_problems.action", { t: "ZodEnum", own: "entity", ent: "channel", res: "resolveNoProblemsAction", con: "packages/server/src/bootstrap.ts:resolveNoProblemsAction", wir: true, ui: "select", tid: "R09" }),
  g("outputs.channels[].no_findings", { t: "ZodNever", own: "entity", ent: "channel", ss: "removed", wir: false, st: "removed alias; rejected by schema", ui: "toggle", tid: "B03" }),
  g("outputs.channels[].commit_url_template", { t: "ZodString", own: "entity", ent: "channel", con: "packages/server/src/bootstrap.ts:createChannelRendering", wir: true, ui: "path-template" }),
  g("outputs.channels[].revision_url_template", { t: "ZodString", own: "entity", ent: "channel", con: "packages/server/src/bootstrap.ts:createChannelRendering", wir: true, ui: "path-template" }),
  g("outputs.channels[].change_url_template", { t: "ZodString", own: "entity", ent: "channel", con: "packages/server/src/bootstrap.ts:createChannelRendering", wir: true, ui: "path-template" }),
  g("outputs.channels[].marker_prefix", { t: "ZodString", own: "entity", ent: "channel", cap: "problem issue kinds", con: "packages/server/src/bootstrap.ts problem issue dispatchers", wir: true, ui: "text" }),
  g("outputs.channels[].marker_label", { t: "ZodString", own: "entity", ent: "channel", cap: "problem issue kinds", con: "packages/server/src/bootstrap.ts problem issue dispatchers", wir: true, ui: "text" }),
  g("outputs.channels[].label_ids", { t: "ZodNumber[]", own: "entity", ent: "channel", cap: "gitea_problem_issue only; unread on github_problem_issue", con: "packages/server/src/bootstrap.ts:createGiteaProblemIssueDispatcher", wir: true, ui: "multiselect" }),
  g("outputs.channels[].labels", { t: "ZodString[]", own: "entity", ent: "channel", cap: "github_problem_issue only; unread on gitea_problem_issue", con: "packages/server/src/bootstrap.ts:createGithubProblemIssueDispatcher", wir: true, ui: "multiselect" }),
  g("outputs.channels[].issue_mode", { t: "ZodEnum", own: "entity", ent: "channel", cap: "problem issue kinds", con: "packages/server/src/bootstrap.ts problem issue dispatchers", wir: true, ui: "select" }),
  g("outputs.channels[].resolved_action", { t: "ZodEnum", own: "entity", ent: "channel", cap: "delete is gitea_problem_issue only", con: "packages/server/src/bootstrap.ts problem issue dispatchers", wir: true, ui: "select" }),
  g("outputs.channels[].assign_committer", { t: "ZodBoolean", own: "entity", ent: "channel", cap: "problem issue kinds", con: "packages/server/src/bootstrap.ts problem issue dispatchers", wir: true, ui: "toggle" }),
  g("outputs.channels[].owners_file", { t: "ZodString", own: "entity", ent: "channel", cap: "problem issue kinds", con: "packages/server/src/bootstrap.ts problem issue dispatchers", wir: true, ui: "text" }),
  g("outputs.channels[].add_owners_as_assignees", { t: "ZodBoolean", own: "entity", ent: "channel", cap: "problem issue kinds", con: "packages/server/src/bootstrap.ts problem issue dispatchers", wir: true, ui: "toggle" }),
  g("outputs.channels[].severity_label_prefix", { t: "ZodString", own: "entity", ent: "channel", cap: "pr review and problem issue kinds; unread on plain issue kinds", con: "packages/server/src/bootstrap.ts pr review dispatchers", wir: true, ui: "text" }),
  g("outputs.channels[].severity_label_colors.*", { t: "ZodString", own: "entity", ent: "channel", cap: "pr review and problem issue kinds", con: "packages/server/src/bootstrap.ts pr review dispatchers", wir: true, ui: "text" }),
  g("outputs.channels[].review_mode", { t: "ZodEnum", own: "entity", ent: "channel", cap: "gitea_pr_review/github_pr_review only", con: "packages/server/src/bootstrap.ts pr review dispatchers", wir: true, ui: "select" }),
  g("outputs.channels[].review_event", { t: "ZodEnum", own: "entity", ent: "channel", cap: "gitea_pr_review/github_pr_review only", con: "packages/server/src/bootstrap.ts pr review dispatchers", wir: true, ui: "select" }),
  g("outputs.channels[].review_update_strategy", { t: "ZodEnum", own: "entity", ent: "channel", cap: "gitea_pr_review/github_pr_review only", con: "packages/server/src/bootstrap.ts pr review dispatchers", wir: true, ui: "select" }),
  g("outputs.channels[].notify_feishu.webhook_url_env", { t: "ZodString", own: "entity", ent: "channel", cap: "problem issue kinds", con: "packages/server/src/bootstrap.ts problem issue dispatchers", wir: true, ui: "secret-ref" }),
  g("outputs.channels[].notify_feishu.secret_env", { t: "ZodString", own: "entity", ent: "channel", cap: "problem issue kinds", con: "packages/server/src/bootstrap.ts problem issue dispatchers", wir: true, ui: "secret-ref" }),
  g("outputs.channels[].base_url", { t: "ZodUnknown", own: "entity", ent: "channel", ss: "passthrough", con: "packages/server/src/bootstrap.ts channel base_url override", wir: true, ui: "text" }),
  g("outputs.channels[].token_env", { t: "ZodUnknown", own: "entity", ent: "channel", ss: "passthrough", con: "packages/server/src/bootstrap.ts channel token override", wir: true, ui: "secret-ref" }),
  g("outputs.channels[].owner", { t: "ZodUnknown", own: "entity", ent: "channel", ss: "passthrough", con: "packages/server/src/bootstrap.ts channel owner override", wir: true, ui: "text" }),
  g("outputs.channels[].repo", { t: "ZodUnknown", own: "entity", ent: "channel", ss: "passthrough", con: "packages/server/src/bootstrap.ts channel repo override", wir: true, ui: "text" }),
  g("outputs.channels[].webhook_url_env", { t: "ZodUnknown", own: "entity", ent: "channel", ss: "passthrough", cap: "feishu_bot/wecom_bot", con: "packages/server/src/bootstrap.ts bot dispatchers", wir: true, ui: "secret-ref" }),
  g("outputs.channels[].secret_env", { t: "ZodUnknown", own: "entity", ent: "channel", ss: "passthrough", cap: "feishu_bot only; unread on wecom_bot", con: "packages/server/src/bootstrap.ts:createFeishuBotDispatcher", wir: true, ui: "secret-ref" }),
  g("outputs.channels[].mentioned_mobile_list", { t: "ZodUnknown", own: "entity", ent: "channel", ss: "passthrough", cap: "wecom_bot only", con: "packages/server/src/bootstrap.ts:createWeComBotDispatcher", wir: true, ui: "multiselect" }),
  g("outputs.channels[].project_id", { t: "ZodUnknown", own: "entity", ent: "channel", ss: "passthrough", cap: "gitlab_mr_review only", con: "packages/server/src/bootstrap.ts:createGitlabMergeRequestReviewDispatcher", wir: true, ui: "text" }),
  g("outputs.channels[].merge_request_iid", { t: "ZodUnknown", own: "entity", ent: "channel", ss: "passthrough", cap: "gitlab_mr_review only", con: "packages/server/src/bootstrap.ts:createGitlabMergeRequestReviewDispatcher", wir: true, ui: "number" }),

  // ------------------------------------------------------- queue
  g("queue.kind", { t: "ZodEnum", d: "memory", own: "bootstrap", cap: "rabbitmq reserved; rejected at bootstrap", con: "packages/core/src/queue-factory.ts:createQueueFromConfig", wir: true, ui: "select" }),
  g("queue.sqlite.path", { t: "ZodString", own: "bootstrap", con: "packages/core/src/sqlite-queue.ts", wir: true, ui: "text" }),
  g("queue.sqlite.lock_ttl_seconds", { t: "ZodNumber", own: "bootstrap", con: "packages/core/src/sqlite-queue.ts", wir: true, ui: "number" }),
  g("queue.workers.concurrency", { t: "ZodNumber", own: "business", res: "claim-time limiter", con: "packages/server/src/bootstrap.ts worker options", wir: true, ui: "number", tid: "H17" }),
  g("queue.workers.per_workspace_concurrency", { t: "ZodNumber", own: "business", con: "packages/server/src/bootstrap.ts worker options", wir: true, ui: "number", tid: "H17" }),
  g("queue.workers.lock_ttl_seconds", { t: "ZodNumber", own: "business", con: "packages/server/src/bootstrap.ts worker options", wir: true, ui: "number" }),
  g("queue.rate_limit.per_provider_rps.*", { t: "ZodNumber", own: "business", con: "packages/server/src/bootstrap.ts rate limiter wiring", wir: true, ui: "number", tid: "H17" }),
  g("queue.retry.attempts", { t: "ZodNumber", own: "business", res: "resolveTriggerRetryConfig", con: "packages/server/src/bootstrap.ts:resolveTriggerRetryConfig", wir: true, ui: "number" }),
  g("queue.retry.backoff.kind", { t: "ZodEnum", own: "business", res: "resolveTriggerRetryConfig", con: "packages/server/src/bootstrap.ts:resolveTriggerRetryConfig", wir: true, ui: "select" }),
  g("queue.retry.backoff.base_ms", { t: "ZodNumber", own: "business", res: "resolveTriggerRetryConfig", con: "packages/server/src/bootstrap.ts:resolveTriggerRetryConfig", wir: true, ui: "number" }),
  g("queue.retry.backoff.max_ms", { t: "ZodNumber", own: "business", res: "resolveTriggerRetryConfig", con: "packages/server/src/bootstrap.ts:resolveTriggerRetryConfig", wir: true, ui: "number" }),
  g("queue.retry.backoff.jitter", { t: "ZodBoolean", own: "business", res: "resolveTriggerRetryConfig", con: "packages/server/src/bootstrap.ts:resolveTriggerRetryConfig", wir: true, ui: "toggle" }),
  g("queue.dead_letter.enabled", { t: "ZodBoolean", own: "business", con: "packages/server/src/bootstrap.ts dead letter wiring", wir: true, ui: "toggle" }),
  g("queue.dead_letter.max_age_hours", { t: "ZodNumber", own: "business", con: "packages/server/src/bootstrap.ts dead letter wiring", wir: true, ui: "number" }),

  // ------------------------------------------------------- agent / sandbox / search
  g("agent.default", { t: "ZodEnum", d: "kilo", own: "business", res: "resolveAgentAdapterFromConfig", con: "packages/server/src/bootstrap.ts:resolveAgentAdapterFromConfig", wir: true, ui: "select", tid: "H03" }),
  g("agent.timeout_seconds", { t: "ZodNumber", d: 1800, own: "business", con: "packages/server/src/bootstrap.ts agent options", wir: true, ui: "number" }),
  g("agent.auto_approve", { t: "ZodBoolean", d: true, own: "business", wir: false, st: "schema-only; review-orchestrator hardcodes autoApprove: true", ui: "toggle", tid: "H03" }),
  g("agent.sandbox.kind", { t: "ZodEnum", d: "docker", own: "business", cap: "k8s_pod/firecracker reserved; explicit container kinds must not silently fall back to native", res: "createSandboxBackendFromConfig", con: "packages/server/src/bootstrap.ts:createSandboxBackendFromConfig", wir: true, ui: "select", tid: "H04" }),
  g("agent.sandbox.engine", { t: "ZodEnum", d: "auto", own: "business", res: "createSandboxBackendFromConfig", con: "packages/server/src/bootstrap.ts:createSandboxBackendFromConfig", wir: true, ui: "select" }),
  g("agent.sandbox.image", { t: "ZodString", own: "business", res: "createSandboxBackendFromConfig", con: "packages/server/src/bootstrap.ts:createSandboxBackendFromConfig", wir: true, ui: "text" }),
  g("agent.context_compaction.auto", { t: "ZodBoolean", d: true, own: "business", con: "packages/server/src/bootstrap.ts agent options", wir: true, ui: "toggle" }),
  g("agent.context_compaction.threshold_percent", { t: "ZodNumber", own: "business", con: "packages/server/src/bootstrap.ts agent options", wir: true, ui: "number" }),
  g("agent.context_compaction.prune", { t: "ZodBoolean", d: true, own: "business", con: "packages/server/src/bootstrap.ts agent options", wir: true, ui: "toggle" }),
  g("agent.web_search.enabled", { t: "ZodBoolean", d: false, own: "business", cap: "adapter support varies (kilo=exa, opencode=exa/parallel, oh-my-pi full, claude-code/copilot-cli switch-only, zoo/pi none)", con: "packages/agents/src/web-search.ts", wir: true, ui: "toggle", tid: "H03" }),
  g("agent.web_search.providers", { t: "ZodString[]", d: [], own: "business", con: "packages/agents/src/web-search.ts", wir: true, ui: "multiselect" }),
  g("agent.web_search.exclude", { t: "ZodString[]", d: [], own: "business", con: "packages/agents/src/web-search.ts", wir: true, ui: "multiselect" }),
  g("agent.web_search.timeout_seconds", { t: "ZodNumber", own: "business", cap: "oh-my-pi only", con: "packages/agents/src/oh-my-pi.ts", wir: true, ui: "number" }),
  g("agent.web_search.credentials.*", { t: "ZodString", own: "business", con: "packages/agents/src/web-search.ts", wir: true, ui: "secret-ref" }),
  g("agent.web_search.searxng.endpoint", { t: "ZodString", own: "business", cap: "oh-my-pi only", con: "packages/agents/src/oh-my-pi.ts", wir: true, ui: "text" }),
  g("agent.web_search.searxng.categories", { t: "ZodString", own: "business", cap: "oh-my-pi only", con: "packages/agents/src/oh-my-pi.ts", wir: true, ui: "text" }),
  g("agent.web_search.searxng.engines", { t: "ZodString", own: "business", cap: "oh-my-pi only", con: "packages/agents/src/oh-my-pi.ts", wir: true, ui: "text" }),
  g("agent.web_search.searxng.language", { t: "ZodString", own: "business", cap: "oh-my-pi only", con: "packages/agents/src/oh-my-pi.ts", wir: true, ui: "text" }),
  g("agent.web_search.searxng.safesearch", { t: "ZodNumber", own: "business", cap: "oh-my-pi only", con: "packages/agents/src/oh-my-pi.ts", wir: true, ui: "number" }),

  // ------------------------------------------------------- compression
  g("compression.trigger_tokens", { t: "ZodNumber", own: "business", res: "toCompressionConfig", con: "packages/server/src/bootstrap.ts:toCompressionConfig", wir: true, ui: "number" }),
  g("compression.max_input_ratio", { t: "ZodNumber", own: "business", res: "toCompressionConfig", con: "packages/server/src/bootstrap.ts:toCompressionConfig", wir: true, ui: "number" }),
  g("compression.summarize_model_role", { t: "ZodString", own: "business", res: "resolveSummarizeModelFromChain", con: "packages/server/src/bootstrap.ts:resolveSummarizeModelFromChain", wir: true, ui: "select" }),
  g("compression.keep_hunks_top_k", { t: "ZodNumber", own: "business", res: "toCompressionConfig", con: "packages/server/src/bootstrap.ts:toCompressionConfig", wir: true, ui: "number" }),
  g("compression.context_lines", { t: "ZodNumber", own: "business", res: "toCompressionConfig", con: "packages/server/src/bootstrap.ts:toCompressionConfig", wir: true, ui: "number" }),
  g("compression.per_model_overrides.*.trigger_tokens", { t: "ZodNumber", own: "business", res: "toCompressionConfig", con: "packages/server/src/bootstrap.ts:toCompressionConfig", wir: true, ui: "number" }),

  // ------------------------------------------------------- review tree (×3 layers)
  ...reviewTreeRows(),

  // ------------------------------------------------------- workspaces
  g("workspaces.cache.max_total_gb", { t: "ZodNumber", d: 50, own: "business", wir: false, st: "schema-only; workspace cache GC is not implemented", ui: "number" }),
  g("workspaces.cache.eviction", { t: "ZodEnum", d: "lru", own: "business", wir: false, st: "schema-only; workspace cache GC is not implemented", ui: "select" }),
  g("workspaces.cache.ttl_days", { t: "ZodNumber", d: 30, own: "business", wir: false, st: "schema-only; workspace cache GC is not implemented", ui: "number" }),
  row("workspaces.defaults.model_chain", DEFAULTS_ONLY, "llm.default_model_chain", { t: "ZodString", own: "business", res: "resolveModelChainNames", con: "packages/server/src/bootstrap.ts:resolveModelChainNames", wir: true, ui: "select" }),
  row("workspaces.defaults.triage_model_chain", DEFAULTS_ONLY, "llm.triage_model_chain", { t: "ZodString", own: "business", res: "resolveModelChainNames", con: "packages/server/src/bootstrap.ts:resolveModelChainNames", wir: true, ui: "select" }),
  row("workspaces.defaults.agent.default", DEFAULTS_ONLY, "agent.default", { t: "ZodEnum", own: "business", wir: false, st: "schema-only; workspace-layer agent.default has no consumer", ui: "select", tid: "H03" }),
  row("workspaces.defaults.prompt.base_system_prompt_file", DEFAULTS_ONLY, undefined, { t: "ZodString", own: "business", con: "packages/server/src/bootstrap.ts prompt loader", wir: true, ui: "text" }),
  row("workspaces.defaults.prompt.force_skills", DEFAULTS_ONLY, undefined, { t: "ZodString[]", own: "business", con: "packages/server/src/bootstrap.ts prompt loader", wir: true, ui: "multiselect" }),
  row("workspaces.instances.*.model_chain", WORKSPACE_ONLY, "llm.default_model_chain", { t: "ZodString", own: "entity", ent: "workspace", res: "resolveModelChainNames", con: "packages/server/src/bootstrap.ts:resolveModelChainNames", wir: true, ui: "select" }),
  row("workspaces.instances.*.enabled", WORKSPACE_ONLY, undefined, { t: "ZodBoolean", own: "entity", ent: "workspace", con: "packages/core/src/config-resolution.ts:resolveWorkspaceForSource", wir: true, ui: "toggle", tid: "W12" }),
  row("workspaces.instances.*.triage_model_chain", WORKSPACE_ONLY, "llm.triage_model_chain", { t: "ZodString", own: "entity", ent: "workspace", res: "resolveModelChainNames", con: "packages/server/src/bootstrap.ts:resolveModelChainNames", wir: true, ui: "select" }),
  row("workspaces.instances.*.source_repo.trigger", WORKSPACE_ONLY, undefined, { t: "ZodString", own: "entity", ent: "workspace", cap: "legacy exact binding; mutually exclusive with v2 match", res: "resolveWorkspaceIdFromTrigger", con: "packages/server/src/bootstrap.ts:resolveWorkspaceIdFromTrigger", wir: true, ui: "select", tid: "W10" }),
  row("workspaces.instances.*.source_repo.repo", WORKSPACE_ONLY, undefined, { t: "ZodString", own: "entity", ent: "workspace", res: "resolveWorkspaceIdFromTrigger", con: "packages/server/src/bootstrap.ts:resolveWorkspaceIdFromTrigger", wir: true, ui: "text", tid: "W10" }),
  g("workspaces.root", { t: "ZodString", own: "entity", ent: "workspace", cap: "layout root for v2 isolated instances; relative paths resolve against the server base directory", con: "packages/server/src/workspace-runtime.ts:createWorkspaceRuntime", wir: true, ui: "text", tid: "L01" }),
  row("workspaces.instances.*.match[].id", WORKSPACE_ONLY, undefined, { t: "ZodString", own: "entity", ent: "workspace", con: "packages/core/src/config-resolution.ts:resolveWorkspaceForSource", wir: true, ui: "text", tid: "W01" }),
  row("workspaces.instances.*.match[].triggers", WORKSPACE_ONLY, undefined, { t: "ZodString[]", own: "entity", ent: "workspace", con: "packages/core/src/config-resolution.ts:resolveWorkspaceForSource", wir: true, ui: "multiselect", tid: "W01" }),
  row("workspaces.instances.*.match[].source.*", WORKSPACE_ONLY, undefined, { t: "union", own: "entity", ent: "workspace", cap: "source field allowlist + budgets enforced (config-matcher)", con: "packages/core/src/config-resolution.ts:resolveWorkspaceForSource", wir: true, ui: "matcher", tid: "W01" }),
  row("workspaces.instances.*.work_path", WORKSPACE_ONLY, undefined, { t: "ZodString", own: "entity", ent: "workspace", cap: "compiled at parse with AST whitelist", con: "packages/core/src/config-workspace.ts:buildWorkspaceBinding", wir: true, ui: "path-template", tid: "L01" }),
  row("workspaces.instances.*.agent.default", WORKSPACE_ONLY, "agent.default", { t: "ZodEnum", own: "entity", ent: "workspace", wir: false, st: "schema-only; workspace-layer agent.default has no consumer", ui: "select", tid: "H03" }),
  row("workspaces.instances.*.triage.enabled", WORKSPACE_ONLY, undefined, { t: "ZodBoolean", d: false, own: "entity", ent: "workspace", res: "resolveIssueTriageOptions", con: "packages/server/src/bootstrap.ts:resolveIssueTriageOptions", wir: true, ui: "toggle" }),
  row("workspaces.instances.*.triage.actions", WORKSPACE_ONLY, undefined, { t: "ZodEnum[]", d: ["close"], own: "entity", ent: "workspace", res: "resolveIssueTriageOptions", con: "packages/server/src/bootstrap.ts:resolveIssueTriageOptions", wir: true, ui: "multiselect" }),
  row("workspaces.instances.*.triage.categories_close", WORKSPACE_ONLY, undefined, { t: "ZodEnum[]", d: ["spam", "invalid"], own: "entity", ent: "workspace", res: "resolveIssueTriageOptions", con: "packages/server/src/bootstrap.ts:resolveIssueTriageOptions", wir: true, ui: "multiselect" }),
  row("workspaces.instances.*.triage.events", WORKSPACE_ONLY, undefined, { t: "ZodEnum[]", d: ["issues"], own: "entity", ent: "workspace", res: "resolveIssueTriageOptions", con: "packages/server/src/bootstrap.ts:resolveIssueTriageOptions", wir: true, ui: "multiselect" }),
  row("workspaces.instances.*.triage.custom_prompt", WORKSPACE_ONLY, undefined, { t: "ZodString", own: "entity", ent: "workspace", res: "resolveIssueTriageOptions", con: "packages/server/src/bootstrap.ts:resolveIssueTriageOptions", wir: true, ui: "text" }),
  row("workspaces.instances.*.triage.dry_run", WORKSPACE_ONLY, undefined, { t: "ZodBoolean", d: false, own: "entity", ent: "workspace", res: "resolveIssueTriageOptions", con: "packages/server/src/bootstrap.ts:resolveIssueTriageOptions", wir: true, ui: "toggle" }),
  row("workspaces.instances.*.prompt.base_system_prompt_file", WORKSPACE_ONLY, undefined, { t: "ZodString", own: "entity", ent: "workspace", con: "packages/server/src/bootstrap.ts prompt loader", wir: true, ui: "text" }),
  row("workspaces.instances.*.prompt.force_skills", WORKSPACE_ONLY, undefined, { t: "ZodString[]", own: "entity", ent: "workspace", con: "packages/server/src/bootstrap.ts prompt loader", wir: true, ui: "multiselect" }),
  row("workspaces.instances.*.auth.api_key_env", WORKSPACE_ONLY, undefined, { t: "ZodString", own: "entity", ent: "workspace", res: "resolveAuthConfig", con: "packages/server/src/bootstrap.ts:resolveAuthConfig", wir: true, ui: "secret-ref" }),
  row("workspaces.instances.*.auth.enabled", WORKSPACE_ONLY, undefined, { t: "ZodBoolean", d: true, own: "entity", ent: "workspace", res: "resolveAuthConfig", con: "packages/server/src/bootstrap.ts:resolveAuthConfig", wir: true, ui: "toggle" }),
  ...workspaceOutputsRows(),
  ...workspaceSandboxRows(),
  ...contextRepositoryRows(),
];

/**
 * Inventory lookup by canonical path. Presence in this map is the U24 gate:
 * a schema field without an entry fails the consistency test, and so does an
 * entry without a schema field (except managed passthrough/removed rows).
 */
export const CONFIG_FIELD_INVENTORY_BY_PATH: ReadonlyMap<string, ConfigFieldSpec> = new Map(
  CONFIG_FIELD_INVENTORY.map((spec) => [spec.path, spec]),
);
