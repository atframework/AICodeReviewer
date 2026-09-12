/**
 * Workspace multi-project definitions (spec §5.1/§5.5, P1).
 *
 * A definition may declare EITHER a legacy `source_repo` exact binding OR a
 * `match` rule list plus an optional `work_path` template. Match rules are
 * OR-ed; conditions inside one rule (triggers, source fields) are AND-ed and
 * array triggers are OR-ed. Validation runs at config parse/publish time:
 * rule shape, source_repo XOR match, trigger references, duplicate rules,
 * matcher budgets, and template compilation. Cross-definition ambiguity is
 * resolved by routing (P3), not here.
 */

import {
  CONFIG_MATCHER_LIMITS,
  ConfigError,
  computeWorkspaceInstanceId,
  validateWorkspaceDefinitionId,
  type ConfigMatcher,
  type ConfigPath,
} from "./config-format.js";
import {
  compileWorkspaceMatchSource,
  validateWorkspaceMatchSource,
  workspaceMatchExpressionBytes,
  type CompiledWorkspaceMatchSource,
} from "./config-matcher.js";
import {
  compileWorkspacePathTemplate,
  assertSafeWorkPathOutput,
  validateWorkPathTemplateVariables,
  type PathTemplateVariables,
} from "./config-path-template.js";

// ---------------------------------------------------------------------------
// Structural input types (kept local so this module never imports config.ts)
// ---------------------------------------------------------------------------

export interface WorkspaceMatchRuleInput {
  readonly id?: string | undefined;
  readonly triggers?: readonly string[] | undefined;
  readonly source?: Readonly<Record<string, ConfigMatcher>> | undefined;
}

export interface WorkspaceDefinitionInput {
  readonly enabled?: boolean | undefined;
  readonly source_repo?: { readonly trigger: string; readonly repo: string } | undefined;
  readonly match?: readonly WorkspaceMatchRuleInput[] | undefined;
  readonly work_path?: string | undefined;
}

export interface WorkspaceMatchConfigInput {
  readonly triggers?: readonly { readonly name: string; readonly kind?: string }[] | undefined;
  readonly workspaces: {
    readonly instances: Readonly<Record<string, WorkspaceDefinitionInput>>;
  };
}

// ---------------------------------------------------------------------------
// Definition validation (parse/publish time)
// ---------------------------------------------------------------------------

/**
 * Validated form of one definition's match rules with pre-compiled matchers
 * and template. Produced once at parse; reused by the matcher runtime.
 */
export interface ValidatedWorkspaceDefinition {
  readonly definitionId: string;
  readonly rules: readonly (WorkspaceMatchRuleInput & { readonly sourceTest?: CompiledWorkspaceMatchSource })[];
  readonly workPathTemplate: string;
}

/**
 * Validates every definition and returns the runtime-ready match map with
 * pre-compiled source predicates and templates (spec §5.1 compile cache).
 * Bootstrap builds this once per config generation; resolution reuses it.
 */
export function compileWorkspaceMatchDefinitions(
  config: WorkspaceMatchConfigInput,
  path?: ConfigPath,
): ReadonlyMap<string, ValidatedWorkspaceDefinition> {
  const validated = new Map<string, ValidatedWorkspaceDefinition>();
  validateDefinitions(config, path, validated);
  return validated;
}

export function validateWorkspaceDefinitions(config: WorkspaceMatchConfigInput, path?: ConfigPath): void {
  validateDefinitions(config, path, undefined);
}

function validateDefinitions(
  config: WorkspaceMatchConfigInput,
  path: ConfigPath | undefined,
  out: Map<string, ValidatedWorkspaceDefinition> | undefined,
): void {
  const triggerNames = new Set((config.triggers ?? []).map((trigger) => trigger.name));
  for (const [definitionId, definition] of Object.entries(config.workspaces.instances)) {
    const definitionPath: ConfigPath = [...(path ?? []), "workspaces", "instances", definitionId];
    if (definition.source_repo !== undefined && definition.match !== undefined) {
      throw new ConfigError(
        "match_rule_invalid",
        `Workspace definition "${definitionId}" sets both source_repo and match; they are mutually exclusive.`,
        { path: definitionPath },
      );
    }
    if (definition.match === undefined) {
      if (definition.work_path !== undefined) {
        throw new ConfigError(
          "match_rule_invalid",
          `Workspace definition "${definitionId}" sets work_path without match rules; work_path requires the v2 match form.`,
          { path: [...definitionPath, "work_path"] },
        );
      }
      continue;
    }
    validateWorkspaceDefinitionId(definitionId);
    assertSafeWorkPathOutput(definitionId, definitionPath);
    if (definition.match.length === 0) {
      throw new ConfigError(
        "match_rule_invalid",
        `Workspace definition "${definitionId}" declares an empty match list.`,
        { path: [...definitionPath, "match"] },
      );
    }
    if (workspaceMatchExpressionBytes(definition.match) > CONFIG_MATCHER_LIMITS.maxTotalBytes) {
      throw new ConfigError(
        "match_rule_invalid",
        `Workspace definition "${definitionId}" exceeds the ${CONFIG_MATCHER_LIMITS.maxTotalBytes}-byte total matcher budget.`,
        { path: [...definitionPath, "match"] },
      );
    }
    if (definition.match.length > CONFIG_MATCHER_LIMITS.maxRulesPerGroup) {
      throw new ConfigError(
        "match_rule_invalid",
        `Workspace definition "${definitionId}" exceeds the ${CONFIG_MATCHER_LIMITS.maxRulesPerGroup}-rule budget.`,
        { path: [...definitionPath, "match"] },
      );
    }
    const seenRuleIds = new Set<string>();
    const seenRuleShapes = new Set<string>();
    definition.match.forEach((rule, index) => {
      const rulePath = [...definitionPath, "match", String(index)];
      if (rule.id !== undefined) {
        if (seenRuleIds.has(rule.id)) {
          throw new ConfigError(
            "duplicate_entity",
            `Workspace definition "${definitionId}" reuses match rule id "${rule.id}".`,
            { path: rulePath },
          );
        }
        seenRuleIds.add(rule.id);
      }
      for (const triggerName of rule.triggers ?? []) {
        if (!triggerNames.has(triggerName)) {
          throw new ConfigError(
            "invalid_reference",
            `Workspace definition "${definitionId}" match rule references unknown trigger "${triggerName}".`,
            { path: [...rulePath, "triggers"] },
          );
        }
      }
      if (rule.source !== undefined) {
        validateWorkspaceMatchSource(rule.source, [...rulePath, "source"]);
      }
      // Two rules with identical trigger sets and identical source
      // expressions can never be distinguished — report ambiguity instead of
      // picking one. Overlapping-but-different expressions are a routing (P3)
      // concern, not a shape error.
      const sourcePairs = Object.entries(rule.source ?? {})
        .map(
          ([field, matcher]) =>
            [field, "exact" in matcher ? "exact" : "glob" in matcher ? "glob" : "regex",
              "exact" in matcher ? matcher.exact : "glob" in matcher ? matcher.glob : matcher.regex,
              "exact" in matcher ? false : matcher.ignore_case ?? false],
        )
        .sort();
      const shape = JSON.stringify({ triggers: [...(rule.triggers ?? [])].sort(), source: sourcePairs });
      if (seenRuleShapes.has(shape)) {
        throw new ConfigError(
          "ambiguous_route",
          `Workspace definition "${definitionId}" has two match rules with identical trigger/source conditions.`,
          { path: rulePath },
        );
      }
      seenRuleShapes.add(shape);
    });
    if (definition.work_path !== undefined) {
      // Compile at publish so template errors surface before any event arrives.
      compileWorkspacePathTemplate(definition.work_path, [...definitionPath, "work_path"]);
      const triggerKinds = (config.triggers ?? []).filter((trigger) => definition.match!.some((rule) =>
        rule.triggers === undefined || rule.triggers.includes(trigger.name)))
        .flatMap((trigger) => trigger.kind === undefined ? [] : [trigger.kind]);
      validateWorkPathTemplateVariables(definition.work_path, [...definitionPath, "work_path"], triggerKinds);
    }
    if (out !== undefined && definition.match !== undefined) {
      out.set(definitionId, {
        definitionId,
        workPathTemplate: definition.work_path ?? DEFAULT_WORK_PATH_TEMPLATE,
        rules: definition.match.map((rule) => ({
          ...(rule.id !== undefined ? { id: rule.id } : {}),
          ...(rule.triggers !== undefined ? { triggers: rule.triggers } : {}),
          ...(rule.source !== undefined
            ? { sourceTest: compileWorkspaceMatchSource(validateWorkspaceMatchSource(rule.source)) }
            : {}),
        })),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Binding + layout (spec §5.5)
// ---------------------------------------------------------------------------

export type WorkspaceLayoutKind = "legacy_v1" | "isolated_v2";

export interface WorkspaceBinding {
  readonly definitionId: string;
  readonly instanceId: string;
  /** Rendered relative work path (segments joined with `/`). */
  readonly workPath: string;
}

export interface WorkspaceLayout {
  /** Read-only operator assets retained at the definition's legacy location. */
  readonly policyRoot?: string;
  readonly kind: WorkspaceLayoutKind;
  readonly workspacesRoot?: string;
  readonly instanceRoot: string;
  readonly sourceRoot: string;
  readonly agentDir: string;
  readonly tmpDir: string;
  readonly contextReposDir: string;
  readonly templatesDir: string;
}

export const DEFAULT_WORK_PATH_TEMPLATE = "{{workspace.id}}";

export interface WorkspaceBindingInput {
  readonly definitionId: string;
  readonly triggerName: string;
  readonly vcs: string;
  readonly canonicalProjectKey: string;
  /** Template source; defaults to `{{workspace.id}}` (spec §5.5). */
  readonly workPathTemplate?: string | undefined;
}

/**
 * Computes the stable instance identity and renders the work path for one
 * matched project. Git branch never participates in the instance id; the
 * work path may vary per event without changing statistics identity.
 */
export function buildWorkspaceBinding(input: WorkspaceBindingInput, variables: PathTemplateVariables): WorkspaceBinding {
  const instanceId = computeWorkspaceInstanceId({
    definitionId: input.definitionId,
    triggerName: input.triggerName,
    vcs: input.vcs,
    canonicalProjectKey: input.canonicalProjectKey,
  });
  const render = compileWorkspacePathTemplate(input.workPathTemplate ?? DEFAULT_WORK_PATH_TEMPLATE);
  return {
    definitionId: input.definitionId,
    instanceId,
    workPath: render({ ...variables, workspace: { id: input.definitionId, instance_id: instanceId } }),
  };
}

function joinPath(...segments: readonly string[]): string {
  return segments.join("/");
}

/**
 * Computes the explicit directory layout for a binding (spec §5.5). Paths use
 * `/` separators; runtime consumers convert for the host and enforce
 * resolve/realpath containment. `legacy_v1` mirrors the historical layout
 * (`<root>/<definitionId>/source/<repoRef with /: → _>` plus agent/tmp/
 * context-repos/templates siblings) and never changes identity;
 * `isolated_v2` nests everything under `<root>/<workPath>/<instanceId>`.
 */
export function computeWorkspaceLayout(
  workspacesRoot: string,
  binding: WorkspaceBinding,
  kind: WorkspaceLayoutKind,
): WorkspaceLayout {
  if (kind === "legacy_v1") {
    const instanceRoot = joinPath(workspacesRoot, binding.definitionId);
    const legacyRepoDir = binding.workPath.replace(/[/:]/g, "_");
    return {
      kind,
      workspacesRoot,
      instanceRoot,
      sourceRoot: joinPath(instanceRoot, "source", legacyRepoDir),
      agentDir: joinPath(instanceRoot, "agent"),
      tmpDir: joinPath(instanceRoot, "tmp"),
      contextReposDir: joinPath(instanceRoot, "context-repos"),
      templatesDir: joinPath(instanceRoot, "templates"),
      policyRoot: instanceRoot,
    };
  }
  const instanceRoot = joinPath(workspacesRoot, binding.workPath, binding.instanceId);
  return {
    kind,
    workspacesRoot,
    instanceRoot,
    sourceRoot: joinPath(instanceRoot, "source"),
    agentDir: joinPath(instanceRoot, "agent"),
    tmpDir: joinPath(instanceRoot, "tmp"),
    contextReposDir: joinPath(instanceRoot, "context-repos"),
    templatesDir: joinPath(instanceRoot, "templates"),
    policyRoot: joinPath(workspacesRoot, binding.definitionId),
  };
}
