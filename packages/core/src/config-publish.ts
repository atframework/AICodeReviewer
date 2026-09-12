/**
 * Config publish service (spec §7.1, P3d). Orchestrates the atomic publish:
 * changeset → merge → effective schema parse → reference resolution → graph
 * compile → capability/secret checks → CAS commit with audit → immutable
 * runtime snapshot → local generation install.
 *
 * Boundaries:
 * - prepare is pure: no network, no review dispatch, no webhook creation, no
 *   model calls, no image pulls. Credential reachability stays `unverified`.
 * - The ConfigStore commit (revision + audit + head CAS) is the
 *   linearization point. Prepare failure commits nothing.
 * - operationId retries return the committed result (store dedupe, S03);
 *   `getConfigOperation` answers response-loss queries (H14).
 * - Post-commit install/snapshot failure reports `committed_activating` —
 *   the revision is durable and never fake-rolled-back.
 * - Restore re-validates the historical document against the CURRENT file
 *   locks/capabilities/secret rules and publishes a higher revision; it is
 *   never a head downgrade (C12, S07).
 */

import {
  compileExecutionGraph,
  type ExecutionGraph,
} from "./config-compiler.js";
import { ConfigError, stableSerialize } from "./config-format.js";
import { parseEffectiveConfig, type AppConfigInput, type EffectiveConfigV2 } from "./config.js";
import {
  applyConfigChangeset,
  assertNoSecretEnvIssues,
  collectEntityReferences,
  collectFileEntityIds,
  mergeConfigSources,
  validateDatabaseDocument,
  type ConfigChangesetOperation,
  type DatabaseConfigDocument,
  type MergedConfig,
} from "./config-source.js";
import { contentHashOf, type ConfigRevisionRecord, type ConfigStore } from "./config-store.js";

/** Bump when the snapshot content/shape contract changes. */
export const CONFIG_RESOLVER_VERSION = 1;

/** Shared by publication and readiness; namespaced, file-aware identity. */
export function configSnapshotId(revision: Pick<ConfigRevisionRecord, "namespace" | "revision" | "contentHash" | "fileDigest" | "formatVersion">): string {
  return `cfg-${contentHashOf({ namespace: revision.namespace, revision: revision.revision, contentHash: revision.contentHash,
    fileDigest: revision.fileDigest, formatVersion: revision.formatVersion, resolverVersion: CONFIG_RESOLVER_VERSION })}`;
}

// ---------------------------------------------------------------------------
// Prepare (pure)
// ---------------------------------------------------------------------------

export interface ConfigPublishInput {
  readonly namespace: string;
  /** Expected head (`null` = empty namespace); CAS base. */
  readonly baseRevision: number | null;
  readonly operationId: string;
  readonly actor: string;
  /** Raw file document (already YAML-parsed; never mutated). */
  readonly file?: AppConfigInput | undefined;
  /** SHA-256 hex of the exact file bytes this publish merges against. */
  readonly fileDigest: string;
  /** Current database document the changeset applies to. */
  readonly current: DatabaseConfigDocument;
  readonly operations: readonly ConfigChangesetOperation[];
  readonly formatVersion?: number | undefined;
  /** Audit action label, e.g. "publish" or "restore". */
  readonly action?: string | undefined;
  readonly now?: (() => number) | undefined;
}

export interface PreparedConfigPublication {
  readonly input: ConfigPublishInput;
  /** The new database document after the changeset. */
  readonly document: DatabaseConfigDocument;
  readonly merged: MergedConfig;
  readonly effective: EffectiveConfigV2;
  readonly graph: ExecutionGraph;
  readonly audit: { readonly action: string; readonly entityRefs: readonly string[]; readonly redactedDiff: unknown };
  readonly formatVersion: number;
}

function collectionDiff(
  before: DatabaseConfigDocument,
  after: DatabaseConfigDocument,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const collection of ["providers", "model_groups", "triggers", "channels", "workspaces", "routes"] as const) {
    const a = before.entities?.[collection] ?? {};
    const b = after.entities?.[collection] ?? {};
    for (const [id, record] of Object.entries(b)) {
      const previous = a[id];
      if (previous === undefined) {
        added.push(`${collection}/${record.name}`);
      } else if (stableSerialize(previous) !== stableSerialize(record)) {
        changed.push(`${collection}/${record.name}`);
      }
    }
    for (const id of Object.keys(a)) {
      if (b[id] === undefined) {
        removed.push(`${collection}/${a[id]!.name}`);
      }
    }
  }
  return { added, removed, changed };
}

function globalDiff(operations: readonly ConfigChangesetOperation[]): { set: string[]; unset: string[] } {
  const set: string[] = [];
  const unset: string[] = [];
  for (const operation of operations) {
    if (operation.op === "set") {
      set.push(operation.path.join("."));
    } else if (operation.op === "unset") {
      unset.push(operation.path.join("."));
    }
  }
  return { set, unset };
}

/**
 * Pure preparation: applies the changeset, merges sources, parses the
 * effective config, resolves every cross-entity reference, compiles the
 * routing graph, and re-checks secret env conventions. On any error nothing
 * is committed — the caller can surface the failure directly.
 */
export function prepareConfigPublication(input: ConfigPublishInput): PreparedConfigPublication {
  const formatVersion = input.formatVersion ?? 1;
  const base = validateDatabaseDocument(input.current, formatVersion);
  const fileEntityIds = collectFileEntityIds(input.file ?? {});
  const { fileLocks } = mergeConfigSources({ file: input.file ?? {}, database: base, formatVersion });

  const document = applyConfigChangeset(base, input.operations, { fileEntityIds, fileLocks, formatVersion });
  const merged = mergeConfigSources({ file: input.file ?? {}, database: document, formatVersion });
  const effective = parseEffectiveConfig(merged.document, formatVersion);

  // Cross-entity reference resolution (C02/C03): every reference must point
  // at an entity that exists in the effective document. Deleting a referenced
  // entity in this changeset therefore fails atomically here.
  const available = {
    provider: new Set(effective.llm.providers.map((provider) => provider.id)),
    model_group: new Set(Object.keys(effective.llm.model_chain)),
    trigger: new Set(effective.triggers.map((trigger) => trigger.name)),
    channel: new Set(effective.outputs.channels.map((channel) => channel.name)),
    workspace: new Set(Object.keys(effective.workspaces.instances)),
    route: new Set((effective.routing?.rules ?? []).map((rule) => rule.id)),
  };
  for (const reference of collectEntityReferences(merged.document)) {
    if (!available[reference.to.kind].has(reference.to.id)) {
      throw new ConfigError(
        "invalid_reference",
        `${reference.from} references ${reference.to.kind} "${reference.to.id}", which does not exist after this changeset; fix the reference in the same changeset (C02/C03).`,
        { entity: reference.to },
      );
    }
  }

  const graph = compileExecutionGraph(effective);
  assertNoSecretEnvIssues(effective);

  const diff = collectionDiff(base, document);
  const globals = globalDiff(input.operations);
  const entityRefs = [
    ...diff.added.map((entry) => `+${entry}`),
    ...diff.changed.map((entry) => `~${entry}`),
    ...diff.removed.map((entry) => `-${entry}`),
    ...globals.set.map((path) => `set:${path}`),
    ...globals.unset.map((path) => `unset:${path}`),
  ];
  return {
    input,
    document,
    merged,
    effective,
    graph,
    audit: {
      action: input.action ?? "publish",
      entityRefs,
      // Names and paths only — records hold env var *names*, never values (S06).
      redactedDiff: { entities: diff, globals },
    },
    formatVersion,
  };
}

// ---------------------------------------------------------------------------
// Publish (CAS linearization + snapshot + install)
// ---------------------------------------------------------------------------

export type ConfigPublishResult =
  | { readonly status: "committed"; readonly revision: ConfigRevisionRecord; readonly snapshotId: string }
  | { readonly status: "conflict"; readonly headRevision: number | null; readonly message: string }
  | {
      readonly status: "committed_activating";
      readonly revision: ConfigRevisionRecord;
      /** Which post-commit step failed: runtime snapshot write or generation install. */
      readonly stage: "snapshot" | "install";
      readonly message: string;
    };

export interface PublishConfigOptions {
  /** Local generation install hook (P4 RuntimeConfigManager). */
  readonly install?: ((prepared: PreparedConfigPublication, revision: ConfigRevisionRecord) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Commits a prepared publication. CAS conflicts and operationId retries map
 * to the store contract; post-commit failures never roll back.
 */
export async function publishConfig(
  store: ConfigStore,
  prepared: PreparedConfigPublication,
  options: PublishConfigOptions = {},
): Promise<ConfigPublishResult> {
  const now = options.now ?? Date.now;
  const result = await store.commitChangeset({
    namespace: prepared.input.namespace,
    baseRevision: prepared.input.baseRevision,
    fileDigest: prepared.input.fileDigest,
    operationId: prepared.input.operationId,
    actor: prepared.input.actor,
    document: prepared.document,
    formatVersion: prepared.formatVersion,
    audit: prepared.audit,
    now: now(),
  });

  if (result.status === "revision_conflict") {
    return {
      status: "conflict",
      headRevision: result.head.activeRevision,
      message: `Namespace "${prepared.input.namespace}" advanced to revision ${result.head.activeRevision}; rebase the changeset and retry (revision_conflict).`,
    };
  }

  const { revision } = result;
  const snapshotId = configSnapshotId(revision);
  try {
    await store.writeSnapshot({
      id: snapshotId,
      namespace: prepared.input.namespace,
      fileDigest: prepared.input.fileDigest,
      databaseRevision: revision.revision,
      resolverVersion: CONFIG_RESOLVER_VERSION,
      // Env var *names* are references, not secrets; the store never sees
      // resolved secret material (spec §4.3 snapshot contract).
      sanitizedEffectiveConfig: prepared.effective,
      contentHash: contentHashOf(prepared.effective),
      now: now(),
    });
  } catch (error) {
    return {
      status: "committed_activating",
      revision,
      stage: "snapshot",
      message: `Revision ${revision.revision} committed but the runtime snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // A retry may refer to a revision superseded while its response was lost.
  // It can repair that revision's snapshot, but must not roll back activation.
  if (options.install !== undefined) {
    try {
      if ((await store.readHead(revision.namespace))?.activeRevision === revision.revision) {
        await options.install(prepared, revision);
      }
    } catch (error) {
      return {
        status: "committed_activating",
        revision,
        stage: "install",
        message: `Revision ${revision.revision} committed but local activation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { status: "committed", revision, snapshotId };
}

// ---------------------------------------------------------------------------
// Operation query (response-loss recovery, H14)
// ---------------------------------------------------------------------------

export type ConfigOperationStatus =
  | { readonly status: "not_found" }
  | { readonly status: "committed"; readonly revision: ConfigRevisionRecord };

/** Answers "did my publish land?" after a lost response — by operationId. */
export async function getConfigOperation(
  store: ConfigStore,
  namespace: string,
  operationId: string,
): Promise<ConfigOperationStatus> {
  const revision = await store.readOperation(namespace, operationId);
  return revision === null ? { status: "not_found" } : { status: "committed", revision };
}

// ---------------------------------------------------------------------------
// Restore (C12/S07): historical document → re-validated higher revision
// ---------------------------------------------------------------------------

export interface RestoreConfigInput {
  readonly namespace: string;
  /** Historical revision to restore from. */
  readonly revision: number;
  readonly operationId: string;
  readonly actor: string;
  readonly file?: AppConfigInput | undefined;
  readonly fileDigest: string;
  /** Expected current head (CAS base). */
  readonly baseRevision: number | null;
  readonly formatVersion?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Prepares a restore: loads the historical document and re-validates it
 * against the CURRENT file. File-owned entities shadow as usual, but
 * historical globals intersecting a current file lock conflict (file_owned)
 * instead of silently bypassing the lock (C12).
 */
export async function prepareConfigRestore(store: ConfigStore, input: RestoreConfigInput): Promise<PreparedConfigPublication> {
  const historical = await store.readRevision(input.namespace, input.revision);
  if (historical === null) {
    throw new ConfigError("entity_not_found", `Namespace "${input.namespace}" has no revision ${input.revision} to restore.`);
  }
  const formatVersion = input.formatVersion ?? historical.formatVersion;
  const document = validateDatabaseDocument(historical.document, formatVersion);
  const { fileLocks } = mergeConfigSources({ file: input.file ?? {}, database: document, formatVersion });

  // C12: historical globals must not intersect a CURRENT file lock.
  const visit = (value: unknown, path: string[]): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0) {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, [...path, key]);
      }
      return;
    }
    const formatted = path.join(".");
    for (const lock of fileLocks) {
      if (formatted === lock || formatted.startsWith(`${lock}.`) || lock.startsWith(`${formatted}.`)) {
        throw new ConfigError(
          "file_owned",
          `Cannot restore revision ${input.revision}: historical global "${formatted}" is locked by the current config file at "${lock}" (C12).`,
          { path },
        );
      }
    }
  };
  if (document.globals !== undefined) {
    visit(document.globals, []);
  }

  const prepared = prepareConfigPublication({
    namespace: input.namespace,
    baseRevision: input.baseRevision,
    operationId: input.operationId,
    actor: input.actor,
    ...(input.file !== undefined ? { file: input.file } : {}),
    fileDigest: input.fileDigest,
    current: document,
    operations: [],
    formatVersion,
    action: "restore",
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const previous = input.baseRevision === null ? null : await store.readRevision(input.namespace, input.baseRevision);
  if (input.baseRevision !== null && previous === null) throw new ConfigError("entity_not_found", "Restore base revision does not exist.");
  const before = previous?.document ?? {};
  const entities = collectionDiff(before, document);
  const beforeGlobals = before.globals ?? {};
  const afterGlobals = document.globals ?? {};
  const globals = {
    set: Object.keys(afterGlobals).filter((key) => !(key in beforeGlobals) || stableSerialize(beforeGlobals[key]) !== stableSerialize(afterGlobals[key])),
    unset: Object.keys(beforeGlobals).filter((key) => !(key in afterGlobals)),
  };
  return { ...prepared, audit: {
    action: "restore",
    entityRefs: [...entities.added.map((key) => `+${key}`), ...entities.removed.map((key) => `-${key}`), ...entities.changed.map((key) => `~${key}`),
      ...globals.set.map((key) => `set:${key}`), ...globals.unset.map((key) => `unset:${key}`)],
    redactedDiff: { entities, globals, restoredFromRevision: historical.revision },
  } };
}
