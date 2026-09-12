/**
 * Config preview and readiness diagnostics (spec §7.3/§8.4, P3e).
 *
 * - `previewConfigChangeset` validates a changeset against the current head
 *   and returns the impact view — affected entities, shadowed records,
 *   effective values — WITHOUT committing, writing snapshots, calling
 *   models, or touching the network/filesystem (R13/R14 boundary).
 * - `previewConfigRoute` explains one fixture event end-to-end: route match
 *   (or why not), workspace binding, the FULL rendered directory layout,
 *   model group selection, and output channels. It calls the exact same
 *   resolution functions as runtime admission, so preview and execution
 *   cannot drift (R13).
 * - `diagnoseConfigReadiness` reports config_sources off / store
 *   unreachable / empty namespace / file digest mismatch / missing runtime
 *   snapshot states with a stable status vocabulary.
 */

import {
  compileExecutionGraph,
  resolveAnalysisSelection,
  resolveOutputChannelsForEvent,
  resolveRouteForEvent,
  type CompiledRoutingRule,
  type ExecutionGraph,
  type RoutingEventContext,
} from "./config-compiler.js";
import { ConfigError } from "./config-format.js";
import type { EffectiveConfigV2 } from "./config.js";
import {
  prepareConfigPublication,
  configSnapshotId,
  CONFIG_RESOLVER_VERSION,
  type ConfigPublishInput,
  type PreparedConfigPublication,
} from "./config-publish.js";
import {
  resolveWorkspaceForSource,
  triggerKindToVcs,
  type WorkspaceResolutionConfigInput,
  type WorkspaceResolutionEventContext,
  type WorkspaceSourceValues,
} from "./config-resolution.js";
import type { DatabaseConfigDocument } from "./config-source.js";
import type { ConfigStore } from "./config-store.js";
import {
  compileWorkspaceMatchDefinitions,
  computeWorkspaceLayout,
  type WorkspaceLayout,
  type WorkspaceLayoutKind,
} from "./config-workspace.js";
import type { PathTemplateVariables } from "./config-path-template.js";

// ---------------------------------------------------------------------------
// Changeset preview (POST /validate backing service)
// ---------------------------------------------------------------------------

export interface ConfigChangesetPreviewInput {
  readonly store: ConfigStore;
  readonly namespace: string;
  readonly file?: ConfigPublishInput["file"] | undefined;
  readonly fileDigest: string;
  readonly operations: ConfigPublishInput["operations"];
  readonly formatVersion?: number | undefined;
}

export type ConfigChangesetPreview =
  | {
      readonly valid: true;
      readonly baseRevision: number | null;
      /** Redacted name/path diff; identical to what the publish audit stores. */
      readonly diff: PreparedConfigPublication["audit"]["redactedDiff"];
      /** Database records shadowed by file entities after this changeset. */
      readonly shadowedEntities: readonly { readonly kind: string; readonly id: string }[];
      /** Effective values for the entity collections touched by the changeset. */
      readonly affected: readonly { readonly kind: string; readonly id: string; readonly value: unknown }[];
    }
  | {
      readonly valid: false;
      readonly baseRevision: number | null;
      readonly issue: {
        readonly code: string;
        readonly message: string;
        readonly path?: readonly string[] | undefined;
        readonly entity?: { readonly kind: string; readonly id: string } | undefined;
      };
    };

/** Validates a changeset and computes its impact view; never commits. */
export async function previewConfigChangeset(input: ConfigChangesetPreviewInput): Promise<ConfigChangesetPreview> {
  const head = await input.store.readHead(input.namespace);
  const baseRevision = head?.activeRevision ?? null;
  try {
    const revision = head === null ? null : await input.store.readRevision(input.namespace, head.activeRevision);
    if (head !== null && revision === null) throw new ConfigError("store_unavailable", "Config head references a missing revision.");
    const current: DatabaseConfigDocument = revision?.document ?? {};
    const prepared = prepareConfigPublication({
      namespace: input.namespace,
      baseRevision,
      operationId: "preview",
      actor: "preview",
      ...(input.file !== undefined ? { file: input.file } : {}),
      fileDigest: input.fileDigest,
      current,
      operations: input.operations,
      ...(input.formatVersion !== undefined ? { formatVersion: input.formatVersion } : {}),
    });
    const touched = new Set(
      input.operations
        .map((operation) => ("collection" in operation ? `${operation.collection}` : null))
        .filter((value): value is string => value !== null),
    );
    const affected: { kind: string; id: string; value: unknown }[] = [];
    const effective = prepared.effective;
    const entities = {
      providers: effective.llm.providers.map((value) => ({ id: value.id, value })),
      model_groups: Object.entries(effective.llm.model_chain).map(([id, value]) => ({ id, value })),
      triggers: effective.triggers.map((value) => ({ id: value.name, value })),
      channels: effective.outputs.channels.map((value) => ({ id: value.name, value })),
      workspaces: Object.entries(effective.workspaces.instances).map(([id, value]) => ({ id, value })),
      routes: (effective.routing?.rules ?? []).map((value) => ({ id: value.id, value })),
    };
    for (const collection of ["providers", "model_groups", "triggers", "channels", "workspaces", "routes"] as const) {
      if (!touched.has(collection)) {
        continue;
      }
      for (const record of entities[collection]) {
        affected.push({ kind: collection, id: record.id, value: record.value });
      }
    }
    return {
      valid: true,
      baseRevision,
      diff: prepared.audit.redactedDiff,
      shadowedEntities: prepared.merged.shadowedEntities.map((ref) => ({ kind: ref.kind, id: ref.id })),
      affected,
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      return {
        valid: false,
        baseRevision,
        issue: {
          code: error.code,
          message: error.message,
          path: error.path,
          entity: error.entity === undefined ? undefined : { kind: error.entity.kind, id: error.entity.id },
        },
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Route preview (POST /preview-route backing service)
// ---------------------------------------------------------------------------

export interface ConfigRoutePreviewEvent extends RoutingEventContext {
  /** Git branch/ref facts used for workspace path variables. */
  readonly branch?: string | undefined;
  readonly ref?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly headBranch?: string | undefined;
  /** Fixture facts corresponding to authenticated/verified runtime descriptors. */
  readonly providerFields?: WorkspaceResolutionEventContext["provider_fields"];
  readonly defaultBranch?: string | undefined;
}

export type ConfigRoutePreview =
  | {
      readonly status: "matched";
      readonly graphMode: "v2" | "legacy";
      readonly routeRuleId?: string | undefined;
      readonly workspace: string;
      readonly workspaceInstanceId?: string | undefined;
      readonly layoutKind: WorkspaceLayoutKind;
      /** Full final directories — never just template fragments (spec §5.5). */
      readonly layout: WorkspaceLayout;
      readonly variables?: PathTemplateVariables | undefined;
      readonly analysis: {
        readonly modelChain: string;
        readonly triageModelChain: string;
        readonly review: unknown;
      };
      readonly outputs: { readonly line_comments: readonly string[]; readonly summary: readonly string[] };
    }
  | {
      readonly status: "no_match" | "ambiguous" | "unbound";
      readonly graphMode: "v2" | "legacy";
      readonly detail: string;
      readonly candidates?: readonly string[] | undefined;
    };

function triggerProfiles(config: EffectiveConfigV2): WorkspaceResolutionConfigInput["triggers"] {
  return config.triggers.map((trigger) => {
    const baseUrl = typeof trigger.base_url === "string" ? trigger.base_url : undefined;
    return {
      name: trigger.name,
      kind: trigger.kind,
      enabled: trigger.enabled,
      ...(typeof trigger.repository_url === "string" ? { repository_url: trigger.repository_url } : {}),
      ...(typeof trigger.port === "string" ? { port: trigger.port } : {}),
      ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
    };
  });
}

function resolutionConfigInput(config: EffectiveConfigV2): WorkspaceResolutionConfigInput {
  return {
    triggers: triggerProfiles(config),
    workspaces: { instances: config.workspaces.instances },
  };
}

/**
 * Explains the routing + workspace + model + outputs chain for one fixture
 * event. Pure: no network, no filesystem writes, no model calls.
 */
export function previewConfigRoute(config: EffectiveConfigV2, event: ConfigRoutePreviewEvent): ConfigRoutePreview {
  const graph: ExecutionGraph = compileExecutionGraph(config);
  const validated = compileWorkspaceMatchDefinitions(resolutionConfigInput(config));
  // Matches the runtime default `<baseDir>/workspaces` when root is unset.
  const workspacesRoot = config.workspaces.root ?? "workspaces";

  // v2 explicit routing first (R13: identical to the admission path).
  const v2Route =
    graph.mode === "v2"
      ? resolveRouteForEvent(graph, {
          triggerName: event.triggerName,
          targetKind: event.targetKind,
          ...(event.repoRef !== undefined ? { repoRef: event.repoRef } : {}),
        })
      : undefined;
  if (v2Route?.status === "none") {
    return {
      status: "no_match",
      graphMode: "v2",
      detail: `No enabled routing rule matched trigger "${event.triggerName}" (${graph.rules.length} rules evaluated).`,
    };
  }

  let workspaceId: string | undefined;
  let rule: CompiledRoutingRule | undefined;
  if (v2Route?.status === "matched") {
    rule = v2Route.rule;
    workspaceId = v2Route.rule.workspace;
  }

  const vcs = triggerKindToVcs(
    config.triggers.find((trigger) => trigger.name === event.triggerName)?.kind ?? "",
  );
  const source: WorkspaceSourceValues | undefined =
    event.repoRef !== undefined && vcs !== undefined
      ? {
          vcs,
          repo_ref: event.repoRef,
          ...(event.branch !== undefined ? { branch: event.branch } : {}),
          ...(event.ref !== undefined ? { ref: event.ref } : {}),
        }
      : undefined;
  const eventContext: WorkspaceResolutionEventContext = {
    ...(event.providerFields !== undefined ? { provider_fields: event.providerFields } : {}),
    ...(event.defaultBranch !== undefined ? { default_branch: event.defaultBranch } : {}),
    ...(event.baseBranch !== undefined ? { base_branch: event.baseBranch } : {}),
    ...(event.headBranch !== undefined ? { head_branch: event.headBranch } : {}),
  };

  // Workspace resolution: v2 explicit workspace still resolves its binding
  // through the SAME matcher machinery (rules may narrow by source); legacy
  // mode relies on it entirely.
  const resolution =
    source === undefined
      ? undefined
      : resolveWorkspaceForSource(
          resolutionConfigInput(config),
          validated,
          event.triggerName,
          source,
          eventContext,
          workspaceId === undefined ? undefined : { workspaceId },
        );

  if (resolution === undefined) {
    return { status: "unbound", graphMode: graph.mode, detail: "Event carries no repository source; no workspace can bind." };
  }
  switch (resolution.kind) {
    case "legacy_binding":
    case "match":
      workspaceId = resolution.definitionId;
      break;
    case "ambiguous":
      return { status: "ambiguous", graphMode: graph.mode, detail: "Multiple workspaces match this source.", candidates: resolution.definitionIds };
    case "route_denied":
      return { status: "unbound", graphMode: graph.mode, detail: `Workspace route denied: ${resolution.reason}.` };
    case "no_match":
      return { status: "no_match", graphMode: graph.mode, detail: "No workspace rule matched this source." };
    case "unbound":
      return { status: "unbound", graphMode: graph.mode, detail: "Trigger is not bound to any workspace." };
  }

  const analysis = resolveAnalysisSelection(config, workspaceId, rule);
  const outputs = {
    line_comments: resolveOutputChannelsForEvent(
      config,
      graph,
      { triggerName: event.triggerName, targetKind: event.targetKind, ...(event.repoRef !== undefined ? { repoRef: event.repoRef } : {}) },
      workspaceId,
      "line_comments",
      rule,
    ),
    summary: resolveOutputChannelsForEvent(
      config,
      graph,
      { triggerName: event.triggerName, targetKind: event.targetKind, ...(event.repoRef !== undefined ? { repoRef: event.repoRef } : {}) },
      workspaceId,
      "summary",
      rule,
    ),
  };

  const binding = resolution !== undefined && resolution.kind === "match" ? resolution.binding : undefined;
  const layoutKind: WorkspaceLayoutKind = binding ? "isolated_v2" : "legacy_v1";
  const layout = computeWorkspaceLayout(
    workspacesRoot,
    binding ?? {
      definitionId: workspaceId,
      instanceId: "(legacy binding — resolved at admission)",
      workPath: event.repoRef ?? workspaceId,
    },
    layoutKind,
  );
  return {
    status: "matched",
    graphMode: graph.mode,
    ...(rule !== undefined ? { routeRuleId: rule.id } : {}),
    workspace: workspaceId,
    ...(binding !== undefined ? { workspaceInstanceId: binding.instanceId } : {}),
    layoutKind,
    layout,
    ...(resolution !== undefined && resolution.kind === "match" ? { variables: resolution.variables } : {}),
    analysis: { modelChain: analysis.modelChain, triageModelChain: analysis.triageModelChain, review: analysis.review },
    outputs,
  };
}

// ---------------------------------------------------------------------------
// Readiness diagnostics (GET /status backing service)
// ---------------------------------------------------------------------------

export type ConfigReadinessStatus =
  | { readonly status: "disabled"; readonly detail: string }
  | { readonly status: "store_unavailable"; readonly detail: string }
  | { readonly status: "empty"; readonly namespace: string }
  | {
      readonly status: "file_config_mismatch";
      readonly namespace: string;
      readonly headFileDigest: string | null;
      readonly fileDigest: string;
    }
  | { readonly status: "snapshot_missing"; readonly namespace: string; readonly headRevision: number; readonly snapshotId: string }
  | {
      readonly status: "ready";
      readonly namespace: string;
      readonly headRevision: number;
      readonly generation: string;
      readonly fileDigest: string | null;
    };

export interface ConfigReadinessInput {
  /** Undefined store means config_sources is off for this deployment. */
  readonly store?: ConfigStore | undefined;
  readonly namespace: string;
  /** Digest of the file this process actually loaded; compared with head. */
  readonly fileDigest?: string | undefined;
  /** Snapshot id derivation shared with the publish service. */
  readonly snapshotIdFor?: ((revision: { contentHash: string; revision: number }) => string) | undefined;
}

/** Structured readiness for the config subsystem (spec §8.4 GET /status). */
export async function diagnoseConfigReadiness(input: ConfigReadinessInput): Promise<ConfigReadinessStatus> {
  if (input.store === undefined) {
    return { status: "disabled", detail: "config_sources is off; configuration is file-only." };
  }
  try {
    const head = await input.store.readHead(input.namespace);
    if (head === null) return { status: "empty", namespace: input.namespace };
    const revision = await input.store.readRevision(input.namespace, head.activeRevision);
    if (revision === null) return { status: "store_unavailable", detail: "Config head references a missing revision." };
    if (input.fileDigest !== undefined && revision.fileDigest !== null && revision.fileDigest !== input.fileDigest) {
      return { status: "file_config_mismatch", namespace: input.namespace, headFileDigest: revision.fileDigest, fileDigest: input.fileDigest };
    }
    const snapshotIdFor = input.snapshotIdFor ?? configSnapshotId;
    const snapshotId = snapshotIdFor(revision);
    const snapshot = await input.store.readSnapshot(snapshotId);
    if (snapshot === null) {
      return { status: "snapshot_missing", namespace: input.namespace, headRevision: head.activeRevision, snapshotId };
    }
    if (snapshot.namespace !== input.namespace || snapshot.databaseRevision !== head.activeRevision || snapshot.fileDigest !== revision.fileDigest || snapshot.resolverVersion !== CONFIG_RESOLVER_VERSION) {
      return { status: "store_unavailable", detail: "Runtime snapshot does not match the active revision." };
    }
    return { status: "ready", namespace: input.namespace, headRevision: head.activeRevision, generation: head.generation, fileDigest: revision.fileDigest };
  } catch {
    // Driver messages may contain connection strings; diagnostics expose state.
    return { status: "store_unavailable", detail: "Config store could not read the active revision and snapshot." };
  }
}
