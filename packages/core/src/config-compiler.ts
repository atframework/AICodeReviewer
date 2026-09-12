/**
 * Execution graph compiler (spec §6, P3c). Unifies workspace analysis
 * parameters and output channel selection for both graphs:
 *
 * - v2 routing graph (`routing.rules`): explicit priority, AND conditions
 *   with OR list elements, `[]` closes an output kind, missing inherits;
 *   ties at the top priority with conflicting outcomes raise
 *   `ambiguous_route`; no match raises `no_route` — never a silent
 *   first-workspace/first-channel fallback (R01/R02/R06).
 * - legacy compatibility graph: reproduces the pre-routing runtime exactly —
 *   first matching `outputs.routes.rules` entry (array order) with non-empty
 *   lists, then workspace instance, then `outputs.routes.default`, then the
 *   `*_pr_review` line-comments fallback; empty arrays fall through (R05).
 *
 * Route rules NARROW trigger-admitted traffic: admission (trigger binding
 * and repo authorization) always runs before route selection, so a rule can
 * never widen a trigger's repository scope (W09).
 */

import {
  compileConfigMatcher,
  type CompiledConfigMatcher,
} from "./config-matcher.js";
import { ConfigError, stableSerialize } from "./config-format.js";
import type {
  AppConfig,
  EffectiveConfigV2,
  RoutingRule,
} from "./config.js";
import type { ReviewTargetKind } from "./review-event.js";
import { isPlainObject } from "./utils.js";

export interface RoutingEventContext {
  readonly triggerName: string;
  readonly targetKind: ReviewTargetKind;
  readonly repoRef?: string | undefined;
}

export interface CompiledRoutingRule {
  readonly id: string;
  readonly priority: number;
  readonly workspace: string;
  readonly analysis?: RoutingRule["analysis"] | undefined;
  readonly outputs?: RoutingRule["outputs"] | undefined;
  readonly matches: (event: RoutingEventContext) => boolean;
}

export interface ExecutionGraph {
  readonly mode: "v2" | "legacy";
  /** v2 rules sorted by priority descending (stable for equal priorities). */
  readonly rules: readonly CompiledRoutingRule[];
}

export type OutputChannelKey = "line_comments" | "summary";

const PR_INLINE_KINDS = new Set(["gitea_pr_review", "github_pr_review", "gitlab_mr_review"]);

// ---------------------------------------------------------------------------
// Validation (publish precheck, R03/R07/R12)
// ---------------------------------------------------------------------------

/**
 * Validates the routing section of an effective config: unique rule ids,
 * existing workspace/model-group/channel/trigger references, legacy∩v2
 * trigger conflicts, and channel/target-kind compatibility. Throws the
 * first issue as a ConfigError with the entity path; never mutates.
 */
export function validateRoutingConfig(config: EffectiveConfigV2): void {
  const rules = config.routing?.rules ?? [];
  const seen = new Set<string>();
  const triggerNames = new Set(config.triggers.map((trigger) => trigger.name));
  const channelKindByName = new Map(config.outputs.channels.map((channel) => [channel.name, channel.kind]));
  const legacyRules = config.outputs.routes?.rules ?? [];
  const legacyTriggerControls = new Set(legacyRules.flatMap((route) =>
    route.match?.trigger === undefined ? [...triggerNames] : [route.match.trigger]));

  for (const [index, rule] of rules.entries()) {
    const path = ["routing", "rules", String(index)];
    if (seen.has(rule.id)) {
      throw new ConfigError("duplicate_entity", `Routing rule id "${rule.id}" is duplicated.`, { path: [...path, "id"] });
    }
    seen.add(rule.id);

    if (!Object.hasOwn(config.workspaces.instances, rule.workspace)) {
      throw new ConfigError(
        "invalid_reference",
        `Routing rule "${rule.id}" targets workspace "${rule.workspace}", which is not defined in workspaces.instances (R03).`,
        { path: [...path, "workspace"] },
      );
    }
    for (const [field, group] of [
      ["model_chain", rule.analysis?.model_chain],
      ["triage_model_chain", rule.analysis?.triage_model_chain],
    ] as const) {
      if (group !== undefined && !Object.hasOwn(config.llm.model_chain, group)) {
        throw new ConfigError(
          "invalid_reference",
          `Routing rule "${rule.id}" references model chain group "${group}", which is not defined in llm.model_chain.`,
          { path: [...path, "analysis", field] },
        );
      }
    }
    for (const key of ["line_comments", "summary"] as const) {
      for (const name of rule.outputs?.[key] ?? []) {
        if (!channelKindByName.has(name)) {
          throw new ConfigError(
            "invalid_reference",
            `Routing rule "${rule.id}" selects unknown output channel "${name}".`,
            { path: [...path, "outputs", key] },
          );
        }
      }
    }

    // R07: inline PR/MR channels need a pull_request target; a rule pinned
    // to non-PR targets must not select them for line comments.
    const targetKinds = rule.match?.target_kinds;
    if (targetKinds !== undefined && !targetKinds.includes("pull_request")) {
      for (const name of rule.outputs?.line_comments ?? []) {
        const kind = channelKindByName.get(name);
        if (kind !== undefined && PR_INLINE_KINDS.has(kind)) {
          throw new ConfigError(
            "routing_invalid",
            `Routing rule "${rule.id}" selects inline channel "${name}" (${kind}) for non-pull_request targets; inline reviews require a PR/MR number (R07).`,
            { path: [...path, "outputs", "line_comments"] },
          );
        }
      }
    }

    // R12: one trigger must not be controlled by both routing generations.
    for (const trigger of rule.match?.triggers ?? [...triggerNames]) {
      if (!triggerNames.has(trigger)) {
        throw new ConfigError(
          "invalid_reference",
          `Routing rule "${rule.id}" matches unknown trigger "${trigger}".`,
          { path: [...path, "match", "triggers"] },
        );
      }
      if (rule.enabled && legacyTriggerControls.has(trigger)) {
        throw new ConfigError(
          "routing_conflict",
          `Trigger "${trigger}" is controlled by both v2 routing rule "${rule.id}" and a legacy outputs.routes rule; split generations must not steer the same trigger (R12).`,
          { path: [...path, "match", "triggers"] },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Compiles the routing section into an executable graph. Validation runs
 * first; matcher compilation (glob/regex) is RE2-safe via config-matcher.
 */
export function compileExecutionGraph(config: EffectiveConfigV2): ExecutionGraph {
  validateRoutingConfig(config);
  const rules = config.routing?.rules ?? [];
  if (config.routing === undefined) {
    return { mode: "legacy", rules: [] };
  }

  const compiled: CompiledRoutingRule[] = rules
    .filter((rule) => rule.enabled)
    .map((rule) => {
      const repoRefMatcher: CompiledConfigMatcher | undefined =
        rule.match?.source?.repo_ref !== undefined
          ? compileConfigMatcher(rule.match.source.repo_ref, ["routing", "rules", rule.id, "match", "source", "repo_ref"])
          : undefined;
      const triggers = rule.match?.triggers !== undefined ? new Set(rule.match.triggers) : undefined;
      const targetKinds = rule.match?.target_kinds !== undefined ? new Set<string>(rule.match.target_kinds) : undefined;
      return {
        id: rule.id,
        priority: rule.priority,
        workspace: rule.workspace,
        ...(rule.analysis !== undefined ? { analysis: rule.analysis } : {}),
        ...(rule.outputs !== undefined ? { outputs: rule.outputs } : {}),
        matches: (event: RoutingEventContext): boolean => {
          // AND across present conditions; OR within each list.
          if (triggers !== undefined && !triggers.has(event.triggerName)) return false;
          if (targetKinds !== undefined && !targetKinds.has(event.targetKind)) return false;
          if (repoRefMatcher !== undefined) {
            if (event.repoRef === undefined) return false;
            if (!repoRefMatcher(event.repoRef)) return false;
          }
          return true;
        },
      };
    });

  // Priority descending; stable for equal priorities (config order).
  const sorted = compiled.map((rule, index) => ({ rule, index }));
  sorted.sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index);
  return { mode: "v2", rules: sorted.map(({ rule }) => rule) };
}

// ---------------------------------------------------------------------------
// Route resolution (R01/R02/R06/R11)
// ---------------------------------------------------------------------------

export type RouteResolution =
  | { readonly status: "matched"; readonly rule: CompiledRoutingRule }
  | { readonly status: "none" };

/**
 * Resolves at most one rule for an event: highest priority wins; equal top
 * priorities with conflicting outcomes raise `ambiguous_route` (R02); no
 * match yields `none` — one event executes at most one analysis (R11).
 */
export function resolveRouteForEvent(graph: ExecutionGraph, event: RoutingEventContext): RouteResolution {
  const matches = graph.rules.filter((rule) => rule.matches(event));
  if (matches.length === 0) {
    return { status: "none" };
  }
  const top = matches[0]!;
  const tied = matches.filter((rule) => rule.priority === top.priority);
  if (tied.length > 1) {
    const signature = (rule: CompiledRoutingRule): string =>
      stableSerialize({ workspace: rule.workspace, analysis: rule.analysis ?? null, outputs: rule.outputs ?? null });
    const first = signature(top);
    const conflict = tied.find((rule) => signature(rule) !== first);
    if (conflict !== undefined) {
      throw new ConfigError(
        "ambiguous_route",
        `Routing rules "${top.id}" and "${conflict.id}" tie at priority ${top.priority} with conflicting outcomes (R02).`,
        { entity: { kind: "route", id: top.id } },
      );
    }
  }
  return { status: "matched", rule: top };
}

// ---------------------------------------------------------------------------
// Analysis layering (R04): global → workspace defaults → instance → route
// ---------------------------------------------------------------------------

function deepMergeAnalysis(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = key in result ? deepMergeAnalysis(result[key], value) : value;
    }
    return result;
  }
  return override;
}

type WorkspaceAgentSelection = NonNullable<AppConfig["workspaces"]["defaults"]["agent"]>;

export interface ResolvedAnalysisSelection {
  readonly modelChain: string;
  readonly triageModelChain: string;
  readonly agent?: WorkspaceAgentSelection | undefined;
  readonly sandbox?: AppConfig["agent"]["sandbox"] | undefined;
  readonly review: unknown;
  readonly compression: unknown;
}

/** Layered analysis selection for one event (R04). */
export function resolveAnalysisSelection(
  config: EffectiveConfigV2,
  workspaceId: string,
  rule?: CompiledRoutingRule | undefined,
): ResolvedAnalysisSelection {
  const instance = config.workspaces.instances[workspaceId];
  const defaults = config.workspaces.defaults;
  const analysis = rule?.analysis;

  const modelChain =
    analysis?.model_chain ?? instance?.model_chain ?? defaults.model_chain ?? config.llm.default_model_chain ?? "default";
  const triageModelChain =
    analysis?.triage_model_chain ??
    instance?.triage_model_chain ??
    defaults.triage_model_chain ??
    config.llm.triage_model_chain ??
    modelChain;

  return {
    modelChain,
    triageModelChain,
    agent: { default: analysis?.agent?.default ?? instance?.agent?.default ?? defaults.agent?.default ?? config.agent.default },
    sandbox: deepMergeAnalysis(deepMergeAnalysis(deepMergeAnalysis(config.agent.sandbox, defaults.sandbox), instance?.sandbox), analysis?.sandbox) as ResolvedAnalysisSelection["sandbox"],
    review: deepMergeAnalysis(
      deepMergeAnalysis(deepMergeAnalysis(config.review, defaults.review), instance?.review),
      analysis?.review,
    ),
    // compression has no workspace layer; only global → route (spec §6).
    compression: deepMergeAnalysis(config.compression, analysis?.compression),
  };
}

// ---------------------------------------------------------------------------
// Output channel selection (R05/R06)
// ---------------------------------------------------------------------------

function uniqueNames(names: readonly string[]): readonly string[] {
  return [...new Set(names)];
}

/**
 * v2 channel selection: route → instance → workspace defaults →
 * outputs.routes.default; an explicit `[]` closes the kind, only `undefined`
 * inherits (R05). No implicit first-channel fallback (R06).
 */
export function resolveOutputChannelsV2(
  config: EffectiveConfigV2,
  workspaceId: string,
  key: OutputChannelKey,
  rule?: CompiledRoutingRule | undefined,
): readonly string[] {
  const selected =
    rule?.outputs?.[key] ??
    config.workspaces.instances[workspaceId]?.outputs?.[key] ??
    config.workspaces.defaults.outputs?.[key] ??
    config.outputs.routes?.default?.[key];
  return selected === undefined ? [] : uniqueNames(selected);
}

/**
 * Legacy compatibility selection: first matching outputs.routes rule with a
 * non-empty list, then instance, then default, then the *_pr_review
 * line-comments fallback; empty arrays fall through (pre-routing runtime).
 */
export function resolveOutputChannelsLegacy(
  config: AppConfig,
  event: RoutingEventContext,
  workspaceId: string,
  key: OutputChannelKey,
): readonly string[] {
  const legacyMatch = (route: {
    readonly match?: { readonly trigger?: string | undefined; readonly target_kind?: string | undefined } | undefined;
  }): boolean => {
    if (route.match?.trigger !== undefined && route.match.trigger !== event.triggerName) return false;
    if (route.match?.target_kind !== undefined && route.match.target_kind !== event.targetKind) return false;
    return true;
  };

  const routeChannels = (config.outputs.routes?.rules ?? []).find(legacyMatch)?.[key];
  if (routeChannels !== undefined && routeChannels.length > 0) {
    return uniqueNames(routeChannels);
  }
  const workspaceChannels = config.workspaces.instances[workspaceId]?.outputs?.[key];
  if (workspaceChannels !== undefined && workspaceChannels.length > 0) {
    return uniqueNames(workspaceChannels);
  }
  const defaultChannels = config.outputs.routes?.default?.[key];
  if (defaultChannels !== undefined && defaultChannels.length > 0) {
    return uniqueNames(defaultChannels);
  }
  if (key === "line_comments") {
    const fallback = config.outputs.channels.find((channel) => PR_INLINE_KINDS.has(channel.kind));
    return fallback !== undefined ? [fallback.name] : [];
  }
  return [];
}

/**
 * Unified channel selection entry point: v2 graph semantics when the config
 * carries routing rules, legacy compatibility otherwise.
 */
export function resolveOutputChannelsForEvent(
  config: EffectiveConfigV2,
  graph: ExecutionGraph,
  event: RoutingEventContext,
  workspaceId: string,
  key: OutputChannelKey,
  rule?: CompiledRoutingRule | undefined,
): readonly string[] {
  if (graph.mode === "v2") {
    return resolveOutputChannelsV2(config, workspaceId, key, rule);
  }
  return resolveOutputChannelsLegacy(config, event, workspaceId, key);
}
