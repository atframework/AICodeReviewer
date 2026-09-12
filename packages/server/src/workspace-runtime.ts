/**
 * Unified workspace runtime: one place that turns (config, trigger, source
 * or event) into a workspace resolution and an explicit directory layout.
 *
 * Replaces the three parallel legacy derivations (bootstrap sourceRoot
 * resolver, auto-commit metadataDir, orchestrator shape inference) with
 * `computeWorkspaceLayout`: legacy definitions keep byte-identical paths,
 * match-resolved projects get the `isolated_v2` layout. Layout is a pure
 * function of config + ReviewEvent fields, so receive-time translation and
 * execution-time directory derivation always agree without persisting
 * paths in queue payloads.
 */

import { resolve } from "node:path";

import {
  compileWorkspaceMatchDefinitions,
  computeWorkspaceLayout,
  triggerKindToVcs,
  type AppConfig,
  type ReviewEventResolution,
  type ValidatedWorkspaceDefinition,
  type WorkspaceBinding,
  type WorkspaceLayout,
  type WorkspaceResolution,
  type WorkspaceResolutionEventContext,
  type WorkspaceResolutionRequest,
  type WorkspaceSourceValues,
  resolveWorkspaceForSource,
} from "@aicr/core";

export interface WorkspaceRuntimeEvent {
  readonly triggerName: string;
  readonly workspaceId: string;
  readonly repoRef: string;
  readonly branch?: string | undefined;
  readonly targetBranch?: string | undefined;
  readonly targetKind?: string | undefined;
  /** Resolution snapshot pinned by the receive path (routing receipts). */
  readonly resolution?: ReviewEventResolution | undefined;
}

export interface WorkspaceRuntime {
  /** Validated match definitions (compiled once per config generation). */
  readonly matchDefinitions: ReadonlyMap<string, ValidatedWorkspaceDefinition>;
  /** Absolute workspaces layout root (config.workspaces.root or <baseDir>/workspaces). */
  readonly workspacesRoot: string;
  /** Full resolution for an authenticated source (receive path). */
  readonly resolveForSource: (
    triggerName: string,
    source: WorkspaceSourceValues,
    event?: WorkspaceResolutionEventContext,
    request?: WorkspaceResolutionRequest,
  ) => WorkspaceResolution;
  /** True when any match rule could apply to this trigger. */
  readonly isMatchReferenced: (triggerName: string) => boolean;
  /** Explicit layout for an accepted event (execution path, deterministic). */
  readonly layoutForEvent: (event: WorkspaceRuntimeEvent) => WorkspaceLayout;
}

/**
 * Layout paths are specified with "/" separators (spec §5.4); runtime
 * consumers convert to host form. resolve() normalizes separators and
 * collapses duplicate slashes on both platforms.
 */
function toHostLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return {
    ...layout,
    instanceRoot: resolve(layout.instanceRoot),
    sourceRoot: resolve(layout.sourceRoot),
    agentDir: resolve(layout.agentDir),
    tmpDir: resolve(layout.tmpDir),
    contextReposDir: resolve(layout.contextReposDir),
    templatesDir: resolve(layout.templatesDir),
  };
}

function legacyLayout(workspacesRoot: string, workspaceId: string, repoRef: string): WorkspaceLayout {
  const binding: WorkspaceBinding = { definitionId: workspaceId, instanceId: "", workPath: repoRef };
  return toHostLayout(computeWorkspaceLayout(workspacesRoot, binding, "legacy_v1"));
}

export function createWorkspaceRuntime(config: AppConfig, baseDir: string): WorkspaceRuntime {
  const matchDefinitions = compileWorkspaceMatchDefinitions(config);
  const workspacesRoot = resolve(baseDir, config.workspaces.root ?? "workspaces");

  const resolveForSource: WorkspaceRuntime["resolveForSource"] = (triggerName, source, event, request) =>
    resolveWorkspaceForSource(config, matchDefinitions, triggerName, source, event, request);

  const isMatchReferenced = (triggerName: string): boolean => {
    for (const definition of matchDefinitions.values()) {
      for (const rule of definition.rules) {
        if (rule.triggers === undefined || rule.triggers.includes(triggerName)) {
          return true;
        }
      }
    }
    return false;
  };

  const layoutForEvent = (event: WorkspaceRuntimeEvent): WorkspaceLayout => {
    // Pinned receive-time resolution (spec §5.2 stage C): the execution
    // directory must equal what admission resolved, even if config changed
    // between accept and run. Recompute remains for events without a snapshot.
    if (event.resolution?.kind === "match") {
      return toHostLayout(computeWorkspaceLayout(workspacesRoot, event.resolution.binding, "isolated_v2"));
    }
    if (event.resolution?.kind === "legacy_binding") {
      return legacyLayout(workspacesRoot, event.resolution.definitionId, event.repoRef);
    }
    const definition = config.workspaces.instances[event.workspaceId];
    if (definition?.match === undefined) {
      return legacyLayout(workspacesRoot, event.workspaceId, event.repoRef);
    }

    // Match-resolved definition: re-derive the binding from the event the
    // same way the receive path derived it from the payload (deterministic).
    const trigger = config.triggers.find((entry) => entry.name === event.triggerName);
    const vcs = trigger !== undefined ? triggerKindToVcs(trigger.kind) : undefined;
    if (trigger === undefined || vcs === undefined) {
      return legacyLayout(workspacesRoot, event.workspaceId, event.repoRef);
    }
    const resolution = resolveForSource(
      event.triggerName,
      {
        vcs,
        repo_ref: event.repoRef,
        branch: event.branch ?? null,
        ref: null,
      },
      {
        base_branch: event.targetBranch ?? null,
        head_branch: event.targetKind === "pull_request" ? event.branch ?? null : null,
      },
    );
    if (resolution.kind !== "match") {
      // The event reached execution, so it matched at receive time; a
      // different outcome here means the config changed underneath the run.
      // Fail closed onto the legacy shape instead of inventing a new one.
      return legacyLayout(workspacesRoot, event.workspaceId, event.repoRef);
    }
    return toHostLayout(computeWorkspaceLayout(workspacesRoot, resolution.binding, "isolated_v2"));
  };

  return { matchDefinitions, workspacesRoot, resolveForSource, isMatchReferenced, layoutForEvent };
}
