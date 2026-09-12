/**
 * Workspace work_path templates (spec §5.3/§5.4, P1).
 *
 * An isolated `Handlebars.create()` instance compiles path templates with an
 * AST whitelist: plain variables, the four whitelisted helpers
 * (segment/default/hash/lower), and restricted subexpressions only — no
 * block, partial, decorator, comment, `lookup`, `log`, dynamic helpers,
 * `@data`, `../`, prototype paths, or arbitrary JS. Compilation uses
 * `strict: true`, `knownHelpersOnly: true`, `noEscape: true` with proto
 * access explicitly off at render time. Rendered output is validated as a
 * portable relative path (no absolute/drive/UNC/backslash/`%`/empty or
 * dot segments); containment and realpath checks are enforced by the runtime
 * consumer, not here.
 */

import Handlebars from "handlebars";

import {
  ConfigError,
  PATH_TEMPLATE_HELPERS,
  PATH_TEMPLATE_LIMITS,
  isPrototypeKey,
  stableConfigHash,
  type ConfigPath,
} from "./config-format.js";

/** Variables allowed as direct (unwrapped) template output (spec §5.4). */
export const PATH_TEMPLATE_SAFE_VARIABLES = ["workspace.id", "workspace.instance_id"] as const;

// ---------------------------------------------------------------------------
// Minimal structural AST types (Handlebars bundled d.ts does not expose them)
// ---------------------------------------------------------------------------

interface AstPath {
  readonly type: "PathExpression";
  readonly original: string;
  readonly parts: readonly string[];
  readonly depth: number;
  readonly data?: boolean;
}

interface AstLiteral {
  readonly type: "StringLiteral" | "NumberLiteral" | "BooleanLiteral" | "NullLiteral" | "UndefinedLiteral";
  readonly value: unknown;
}

interface AstSubExpression {
  readonly type: "SubExpression";
  readonly path: AstPath;
  readonly params: readonly AstNode[];
  readonly hash?: { readonly pairs: readonly unknown[] };
}

interface AstMustache {
  readonly type: "MustacheStatement";
  readonly path: AstPath | AstLiteral;
  readonly params: readonly AstNode[];
  readonly escaped: boolean;
  readonly hash?: { readonly pairs: readonly unknown[] };
}

interface AstContent {
  readonly type: "ContentStatement";
  readonly value: string;
}

type AstNode = AstPath | AstLiteral | AstSubExpression | AstMustache | AstContent | { readonly type: string };

interface AstProgram {
  readonly type: "Program";
  readonly body: readonly AstNode[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function templateError(message: string, path?: ConfigPath): ConfigError {
  return new ConfigError("template_invalid", message, { path });
}

// ---------------------------------------------------------------------------
// Helpers (spec §5.4 contracts)
// ---------------------------------------------------------------------------

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;

/** Characters replaced by the fixed `_xHH_` encoding inside segment. */
const SEGMENT_REPLACE_PATTERN = /[/\\:*?"<>|]/u;

function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0)!;
  return code < 0x20 || code === 0x7f;
}

/**
 * Converts a scalar to one portable path segment. NUL/control characters,
 * `.`/`..`, device names, and trailing dots/spaces are rejected; hostile
 * printable characters are replaced with the fixed `_xHH_` encoding and the
 * original value's hash is appended so distinct sources stay distinguishable.
 */
export function pathTemplateSegment(value: unknown): string {
  if (value === null || value === undefined) {
    throw templateError("segment received null; wrap the variable in `default` to declare a fallback.");
  }
  const text = String(value);
  if (text.length === 0) {
    throw templateError("segment received an empty value; wrap the variable in `default`.");
  }
  if (text === "." || text === "..") {
    throw templateError(`segment rejects the dot segment "${text}".`);
  }
  if (WINDOWS_DEVICE_NAME.test(text)) {
    throw templateError(`segment rejects the reserved device name "${text}".`);
  }
  if (text !== text.trimEnd() || text.endsWith(".")) {
    throw templateError(`segment rejects trailing dots or spaces in "${text}".`);
  }
  let encoded = "";
  let replaced = false;
  for (const char of text) {
    if (isControlCharacter(char)) {
      throw templateError(`segment rejects NUL/control characters in "${text}".`);
    }
    if (SEGMENT_REPLACE_PATTERN.test(char)) {
      encoded += `_x${char.codePointAt(0)!.toString(16).toUpperCase()}_`;
      replaced = true;
    } else {
      encoded += char;
    }
  }
  if (encoded.length === 0) {
    throw templateError(`segment cannot encode "${text}".`);
  }
  return replaced ? `${encoded}~${stableConfigHash(text).slice(0, 12)}` : encoded;
}

/** null/undefined/empty-string fallback; 0 and false are real values. */
export function pathTemplateDefault(value: unknown, literal: unknown): unknown {
  return value === null || value === undefined || value === "" ? literal : value;
}

/** Full SHA-256 hex of the stably serialized value. */
export function pathTemplateHash(value: unknown): string {
  if (value === null || value === undefined) {
    throw templateError("hash received null; wrap the variable in `default` to declare a fallback.");
  }
  return stableConfigHash(value);
}

/** Display-only lowercasing; must be nested inside `segment` (AST-enforced). */
export function pathTemplateLower(value: unknown): string {
  if (value === null || value === undefined) {
    throw templateError("lower received null; wrap the variable in `default` to declare a fallback.");
  }
  return String(value).toLowerCase();
}

// ---------------------------------------------------------------------------
// AST whitelist validation
// ---------------------------------------------------------------------------

function pathOriginal(node: AstPath): string {
  return node.original;
}

function assertVariablePath(node: AstPath, allowDirect: boolean, path?: ConfigPath): void {
  if (node.data === true) {
    throw templateError(`Path templates do not allow @data references ("${node.original}").`, path);
  }
  if (node.depth !== 0) {
    throw templateError(`Path templates do not allow "../" traversal ("${node.original}").`, path);
  }
  if (node.parts.length === 0 || node.parts.some((part) => part === "this" || isPrototypeKey(part))) {
    throw templateError(`Path templates do not allow this/prototype paths ("${node.original}").`, path);
  }
  if (allowDirect) {
    return;
  }
  const original = pathOriginal(node);
  if (!(PATH_TEMPLATE_SAFE_VARIABLES as readonly string[]).includes(original)) {
    throw templateError(
      `Direct output of "${original}" is not allowed; wrap event variables in segment/hash. Safe: ${PATH_TEMPLATE_SAFE_VARIABLES.join(", ")}.`,
      path,
    );
  }
}

function assertHelperName(node: AstPath, path?: ConfigPath): string {
  if (node.depth !== 0 || node.data === true || node.original !== node.parts[0] || node.parts.length !== 1 || !(PATH_TEMPLATE_HELPERS as readonly string[]).includes(node.parts[0]!)) {
    throw templateError(
      `Path templates only allow the helpers ${PATH_TEMPLATE_HELPERS.join("/")}; got "${node.original}".`,
      path,
    );
  }
  return node.parts[0]!;
}

function assertParams(params: readonly AstNode[], parentHelper: string | null, budget: { nodes: number }, depth: number, path?: ConfigPath): void {
  for (const param of params) {
    assertNode(param, parentHelper, budget, depth, path);
  }
}

function assertInvocation(node: AstSubExpression | AstMustache, helper: string, path?: ConfigPath): void {
  if ((node.hash?.pairs.length ?? 0) > 0) {
    throw templateError("Path templates do not allow hash arguments.", path);
  }
  const expected = helper === "default" ? 2 : 1;
  if (node.params.length !== expected) {
    throw templateError(`${helper} requires exactly ${expected} argument(s).`, path);
  }
  if (helper === "default" && !["StringLiteral", "NumberLiteral", "BooleanLiteral"].includes(node.params[1]!.type)) {
    throw templateError("default requires a scalar literal fallback.", path);
  }
}

function assertNode(node: AstNode, parentHelper: string | null, budget: { nodes: number }, depth: number, path?: ConfigPath): void {
  budget.nodes += 1;
  if (budget.nodes > PATH_TEMPLATE_LIMITS.maxAstNodes) {
    throw templateError(`Path template exceeds the ${PATH_TEMPLATE_LIMITS.maxAstNodes}-node AST budget.`, path);
  }
  if (depth > PATH_TEMPLATE_LIMITS.maxAstDepth) {
    throw templateError(`Path template exceeds the ${PATH_TEMPLATE_LIMITS.maxAstDepth}-level AST depth budget.`, path);
  }
  switch (node.type) {
    case "ContentStatement":
      return;
    case "StringLiteral":
    case "NumberLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
    case "UndefinedLiteral":
      return;
    case "PathExpression":
      // Bare paths are only valid as helper params (checked by the parent).
      assertVariablePath(node as AstPath, true, path);
      return;
    case "SubExpression": {
      const sub = node as AstSubExpression;
      const helper = assertHelperName(sub.path, path);
      assertInvocation(sub, helper, path);
      if (helper === "lower" && parentHelper !== "segment") {
        throw templateError("lower must be nested inside segment.", path);
      }
      assertParams(sub.params, helper, budget, depth + 1, path);
      return;
    }
    case "MustacheStatement": {
      const mustache = node as AstMustache;
      if ((mustache.hash?.pairs.length ?? 0) > 0) {
        throw templateError("Path templates do not allow hash arguments.", path);
      }
      if (mustache.path.type !== "PathExpression") {
        throw templateError("Path templates do not allow literal-output mustaches.", path);
      }
      const pathNode = mustache.path as AstPath;
      if (mustache.params.length > 0 && !(pathNode.parts.length === 1 && (PATH_TEMPLATE_HELPERS as readonly string[]).includes(pathNode.parts[0]!))) {
        throw templateError(`Unknown helper "${pathNode.original}" (only ${PATH_TEMPLATE_HELPERS.join("/")} exist).`, path);
      }
      if (pathNode.parts.length === 1 && (PATH_TEMPLATE_HELPERS as readonly string[]).includes(pathNode.parts[0]!)) {
        const helper = assertHelperName(pathNode, path);
        assertInvocation(mustache, helper, path);
        if (helper === "default") {
          throw templateError("default output must be wrapped in segment/hash.", path);
        }
        if (helper === "lower") {
          throw templateError("lower must be nested inside segment.", path);
        }
        assertParams(mustache.params, helper, budget, depth + 1, path);
        return;
      }
      assertVariablePath(pathNode, false, path);
      if (mustache.params.length > 0) {
        throw templateError(`Unknown helper "${pathNode.original}" (only ${PATH_TEMPLATE_HELPERS.join("/")} exist).`, path);
      }
      return;
    }
    default:
      throw templateError(`Path templates do not allow the AST node "${node.type}" (no block/partial/decorator/comment).`, path);
  }
}

// ---------------------------------------------------------------------------
// Isolated instance, compile, render
// ---------------------------------------------------------------------------

const pathTemplateHandlebars = Handlebars.create();
pathTemplateHandlebars.registerHelper("segment", pathTemplateSegment);
pathTemplateHandlebars.registerHelper("default", pathTemplateDefault);
pathTemplateHandlebars.registerHelper("hash", pathTemplateHash);
pathTemplateHandlebars.registerHelper("lower", pathTemplateLower);

export type PathTemplateVariables = Readonly<Record<string, unknown>>;
export type CompiledPathTemplate = (variables: PathTemplateVariables) => string;

/**
 * Validates and compiles a work_path template at publish time. Throws
 * ConfigError(template_invalid) on syntax errors, whitelist violations, or
 * budget overflows.
 */
export function compileWorkspacePathTemplate(source: string, path?: ConfigPath): CompiledPathTemplate {
  if (Buffer.byteLength(source, "utf8") > PATH_TEMPLATE_LIMITS.maxLengthBytes) {
    throw templateError(`Path template exceeds the ${PATH_TEMPLATE_LIMITS.maxLengthBytes}-byte budget.`, path);
  }
  let program: AstProgram;
  try {
    program = Handlebars.parse(source) as unknown as AstProgram;
  } catch (error) {
    throw templateError(`Path template syntax error: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  const budget = { nodes: 0 };
  for (const node of program.body) {
    assertNode(node, null, budget, 1, path);
  }
  if (program.body.every((node) => node.type === "ContentStatement")) assertSafeWorkPathOutput(source, path);
  let compiled: Handlebars.TemplateDelegate;
  try {
    compiled = pathTemplateHandlebars.compile(source, {
      strict: true,
      knownHelpersOnly: true,
      // knownHelpersOnly consults this map, not instance registrations.
      knownHelpers: { segment: true, default: true, hash: true, lower: true },
      noEscape: true,
    });
  } catch (error) {
    throw templateError(`Path template compile error: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  return (variables) => {
    try {
      const rendered = compiled(variables as Record<string, unknown>, {
        allowProtoPropertiesByDefault: false,
        allowProtoMethodsByDefault: false,
      });
      return assertSafeWorkPathOutput(rendered, path);
    } catch (error) {
      throw templateError(`Path template render error: ${error instanceof Error ? error.message : String(error)}`, path);
    }
  };
}

/** Output-side portable relative path validation (spec §5.4). */
export function assertSafeWorkPathOutput(rendered: string, path?: ConfigPath): string {
  if (Buffer.byteLength(rendered, "utf8") > PATH_TEMPLATE_LIMITS.maxOutputBytes) {
    throw templateError("Work path exceeds the output byte budget.", path);
  }
  if (rendered.length === 0) {
    throw templateError("Path template rendered an empty work path.", path);
  }
  if (rendered.includes("\\")) {
    throw templateError(`Work path must use "/" separators, got "${rendered}".`, path);
  }
  if (rendered.includes("%")) {
    throw templateError(`Work path must not contain "%" (no double decoding): "${rendered}".`, path);
  }
  if (rendered.startsWith("/") || /^[A-Za-z]:/u.test(rendered) || rendered.startsWith("~")) {
    throw templateError(`Work path must be relative (no absolute/drive/home prefix): "${rendered}".`, path);
  }
  for (const char of rendered) {
    if (isControlCharacter(char)) {
      throw templateError(`Work path contains NUL/control characters: "${rendered}".`, path);
    }
  }
  const segments = rendered.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw templateError(`Work path has an empty or dot segment: "${rendered}".`, path);
    }
    if (/[\\:*?"<>|]/u.test(segment) || WINDOWS_DEVICE_NAME.test(segment) || /[. ]$/u.test(segment)) {
      throw templateError(`Work path has a nonportable segment: "${segment}".`, path);
    }
    if (Buffer.byteLength(segment, "utf8") > PATH_TEMPLATE_LIMITS.maxSegmentBytes) {
      throw templateError("Work path segment exceeds the 255-byte budget.", path);
    }
  }
  return rendered;
}

// ---------------------------------------------------------------------------
// work_path variable registry (spec §5.3, P1b extraction status)
// ---------------------------------------------------------------------------

export type WorkPathVariableAvailability = "extracted" | "unavailable" | "forbidden";

export interface WorkPathVariableDescriptor {
  /** Dotted template path, e.g. "git.branch". */
  readonly path: string;
  readonly availability: WorkPathVariableAvailability;
  /** True when the value can be null for some event kinds (use `default`). */
  readonly nullable: boolean;
  readonly note?: string;
}

const EXTRACTED_COMMON: readonly (readonly [string, boolean])[] = [
  ["trigger.name", false],
  ["trigger.kind", false],
  ["trigger.host", true],
  ["source.vcs", false],
  ["source.repo_ref", false],
  ["source.repository", true],
  ["source.namespace", true],
  ["source.project_key", false],
  ["source.branch", true],
  ["source.ref", true],
  ["workspace.id", false],
  ["workspace.instance_id", false],
  ["git.owner", true],
  ["git.repository", false],
  ["git.full_name", false],
  ["git.namespace", true],
  ["git.branch", true],
  ["git.ref", true],
  ["git.base_branch", true],
  ["git.head_branch", true],
  ["git.head_repository", true],
  ["git.head_owner", true],
];

const EXTRACTED_GITHUB_LIKE: readonly (readonly [string, boolean])[] = [
  ["owner", true],
  ["repository", false],
  ["full_name", false],
  ["branch", true],
  ["base_branch", true],
  ["head_branch", true],
];

const EXTRACTED_GITLAB: readonly (readonly [string, boolean])[] = [
  ["namespace", true],
  ["project", false],
  ["path_with_namespace", false],
  ["branch", true],
  ["source_branch", true],
  ["target_branch", true],
];

/** Registered variables that P1b does not extract yet (spec §5.3 remainder). */
const UNAEXTRACTED: readonly string[] = [
  "git.default_branch",
  "github.repository_id",
  "github.pull_number",
  "github.issue_number",
  "github.installation_id",
  "gitea.repository_id",
  "gitea.pull_number",
  "gitea.issue_number",
  "forgejo.repository_id",
  "forgejo.pull_number",
  "forgejo.issue_number",
  "gitlab.project_id",
  "gitlab.source_project_id",
  "gitlab.target_project_id",
  "gitlab.merge_request_iid",
  "gitlab.issue_iid",
  "p4.server",
  "p4.depot",
  "p4.depot_path",
  "p4.stream",
  "p4.stream_name",
  "p4.client",
  "p4.service_client",
  "p4.user",
  "p4.change",
  "p4.scope",
  "svn.repository_url",
  "svn.repository_root",
  "svn.repository_uuid",
  "svn.repository",
  "svn.project_path",
  "svn.branch",
  "svn.revision",
  "svn.author",
  "scheduled.job_id",
  "scheduled.schedule_id",
  "scheduled.scheduled_at",
  "scheduled.timezone",
];

/** event.* is registered in the spec but forbidden in work_path templates. */
/** manual.* extraction: trusted authenticated-request/CLI fields only (V11). */
const EXTRACTED_MANUAL: readonly (readonly [string, boolean])[] = [
  ["request_id", true],
  ["requested_workspace", true],
  ["requested_by", true],
];

const EVENT_VARIABLES: readonly string[] = [
  "event.provider",
  "event.kind",
  "event.name",
  "event.action",
  "event.target_id",
  "event.base_revision",
  "event.head_revision",
  "event.actor",
];

function buildRegistry(): readonly WorkPathVariableDescriptor[] {
  const entries: WorkPathVariableDescriptor[] = [];
  for (const [path, nullable] of EXTRACTED_COMMON) {
    entries.push({ path, availability: "extracted", nullable });
  }
  for (const kind of ["github", "gitea", "forgejo"] as const) {
    for (const [field, nullable] of EXTRACTED_GITHUB_LIKE) {
      entries.push({ path: `${kind}.${field}`, availability: "extracted", nullable });
    }
  }
  for (const [field, nullable] of EXTRACTED_GITLAB) {
    entries.push({ path: `gitlab.${field}`, availability: "extracted", nullable });
  }
  for (const [field, nullable] of EXTRACTED_MANUAL) {
    entries.push({ path: `manual.${field}`, availability: "extracted", nullable });
  }
  for (const path of UNAEXTRACTED) {
    entries.push({
      path,
      availability: "unavailable",
      nullable: true,
      note: "registered in spec §5.3; extraction lands with the provider descriptor slice",
    });
  }
  for (const path of EVENT_VARIABLES) {
    entries.push({
      path,
      availability: "forbidden",
      nullable: true,
      note: "event fields are unstable between receive and execution; work_path must use stable project identity",
    });
  }
  return entries;
}

/** work_path template variable catalog (V13: one registry drives validation + docs). */
export const WORK_PATH_TEMPLATE_VARIABLES: readonly WorkPathVariableDescriptor[] = buildRegistry();

const WORK_PATH_VARIABLE_INDEX: ReadonlyMap<string, WorkPathVariableDescriptor> = new Map(
  WORK_PATH_TEMPLATE_VARIABLES.map((entry) => [entry.path, entry]),
);

/** Collects every dotted variable path referenced by a template (helper params and direct output). */
export function collectPathTemplateVariables(source: string): readonly string[] {
  let program: AstProgram;
  try {
    program = Handlebars.parse(source) as unknown as AstProgram;
  } catch {
    return [];
  }
  const found = new Set<string>();
  const visit = (node: AstNode): void => {
    if (node.type === "PathExpression") {
      const path = node as AstPath;
      const isHelper = path.parts.length === 1 && (PATH_TEMPLATE_HELPERS as readonly string[]).includes(path.parts[0]!);
      if (!isHelper && path.data !== true && path.depth === 0 && path.parts.length > 0) {
        found.add(path.parts.join("."));
      }
      return;
    }
    if (node.type === "SubExpression") {
      for (const param of (node as AstSubExpression).params) {
        visit(param);
      }
      return;
    }
    if (node.type === "MustacheStatement") {
      const mustache = node as AstMustache;
      if (mustache.path.type === "PathExpression") {
        visit(mustache.path);
      }
      for (const param of mustache.params) {
        visit(param);
      }
    }
  };
  for (const node of program.body) {
    visit(node);
  }
  return [...found].sort();
}

/**
 * Validates that every variable a work_path template references is in the
 * extracted registry (spec §5.3). Unknown paths, registered-but-unextracted
 * fields, and event.* all fail with template_invalid at publish time.
 */
export function validateWorkPathTemplateVariables(source: string, path?: ConfigPath, triggerKinds?: readonly string[]): void {
  for (const variable of collectPathTemplateVariables(source)) {
    const descriptor = WORK_PATH_VARIABLE_INDEX.get(variable);
    if (descriptor === undefined) {
      const root = variable.split(".")[0] ?? variable;
      throw templateError(
        `Unknown work_path variable "${variable}". Known roots: trigger, source, workspace, git, github, gitea, forgejo, gitlab (root "${root}" has no field "${variable.slice(root.length + 1)}").`,
        path,
      );
    }
    if (descriptor.availability === "forbidden") {
      throw templateError(
        `work_path must not use "${variable}": ${descriptor.note ?? "forbidden"}.`,
        path,
      );
    }
    if (descriptor.availability === "unavailable") {
      throw templateError(
        `work_path variable "${variable}" is registered but not yet extracted by the runtime (spec §5.3).`,
        path,
      );
    }
    const namespace = variable.split(".")[0]!;
    if (triggerKinds?.length && ["git", "github", "gitea", "forgejo", "gitlab"].includes(namespace)) {
      const supported = namespace === "git" ? ["github", "gitea", "forgejo", "gitlab"] : [namespace];
      if (triggerKinds.some((kind) => !supported.includes(kind))) {
        throw templateError(`work_path variable "${variable}" is unavailable for one or more matched trigger kinds.`, path);
      }
    }
  }
}
