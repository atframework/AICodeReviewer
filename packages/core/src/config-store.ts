/**
 * Backend-neutral ConfigStore contract (spec §4.3/§9.3, P2).
 *
 * The store persists immutable configuration revisions with a CAS head
 * pointer per namespace, atomic audit entries, durable runtime snapshots,
 * workspace bindings, and admin sessions. Three backends share this
 * contract: SQLite (app store file), PostgreSQL (app store service), and
 * Redis (hash-tagged immutable generations). The memory implementation is
 * for tests only (S10: explicitly non-persistent).
 *
 * Invariants every backend MUST keep (conformance-tested):
 * - Revisions are immutable and per-namespace monotonic from 1; the first
 *   commit requires `baseRevision: null`, later commits require the current
 *   head (S01/S02). A mismatch yields `{ status: "revision_conflict" }`,
 *   never a silent fork.
 * - `(namespace, operationId)` is unique: a retry with identical content
 *   returns the original revision (`duplicate: true`); identical id with
 *   different content throws `operation_conflict` (S03).
 * - Audit entries commit atomically with their revision (S06); they never
 *   contain secret values (callers pass already-redacted diffs).
 * - `generation` is a decimal string so cross-backend integers never lose
 *   precision (S11); it increments on every head move.
 * - Snapshot reads return copies; pin/refcounted snapshots are never
 *   reported as unreferenced (S05).
 * - Bindings are idempotent per full identity; a `relativeRoot` owned by a
 *   different identity throws `binding_conflict` (S08).
 * - Sessions store only the token hash; revocation is durable so a logout
 *   is visible to every replica (S12).
 * - `close()` is idempotent; operations afterwards throw
 *   `store_unavailable` — bounded errors, never silent fallbacks (S13).
 */

import { createHash } from "node:crypto";
import { ConfigError, stableSerialize } from "./config-format.js";
import type { DatabaseConfigDocument } from "./config-source.js";

// ---------------------------------------------------------------------------
// Revisions and head
// ---------------------------------------------------------------------------

export interface ConfigRevisionRecord {
  readonly namespace: string;
  /** Per-namespace monotonic revision, starting at 1. */
  readonly revision: number;
  readonly parentRevision: number | null;
  /** Document format contract version (spec §9.1: distinct from schemaVersion). */
  readonly formatVersion: number;
  /** Database-owned configuration only; never resolved secrets. */
  readonly document: DatabaseConfigDocument;
  readonly contentHash: string;
  readonly fileDigest: string | null;
  /** Milliseconds since epoch (UTC). */
  readonly createdAt: number;
  readonly actor: string;
  readonly operationId: string;
}

export interface ConfigHeadState {
  readonly namespace: string;
  readonly activeRevision: number;
  /** Decimal string; safe across backends that cannot represent u64 (S11). */
  readonly generation: string;
}

export interface ConfigAuditInput {
  readonly action: string;
  readonly entityRefs: readonly string[];
  /** Already redacted; the store never sees secret material (S06). */
  readonly redactedDiff: unknown;
}

export interface ConfigAuditRecord extends ConfigAuditInput {
  readonly namespace: string;
  /** Backend-assigned unique id. */
  readonly id: string;
  readonly operationId: string;
  readonly beforeRevision: number | null;
  readonly afterRevision: number;
  readonly actor: string;
  readonly timestamp: number;
}

export interface CommitChangesetInput {
  readonly namespace: string;
  /** `null` expects an empty namespace; otherwise the current head revision. */
  readonly baseRevision: number | null;
  readonly fileDigest: string | null;
  readonly operationId: string;
  readonly actor: string;
  readonly document: DatabaseConfigDocument;
  readonly formatVersion: number;
  readonly audit: ConfigAuditInput;
  readonly now: number;
}

export type CommitChangesetResult =
  | {
      readonly status: "committed";
      readonly revision: ConfigRevisionRecord;
      readonly head: ConfigHeadState;
      /** True when the operationId was already committed with identical content (S03). */
      readonly duplicate: boolean;
    }
  | {
      readonly status: "revision_conflict";
      readonly head: ConfigHeadState;
    };

// ---------------------------------------------------------------------------
// Runtime snapshots
// ---------------------------------------------------------------------------

export interface ConfigRuntimeSnapshotRecord {
  readonly id: string;
  readonly namespace: string;
  readonly fileDigest: string | null;
  readonly databaseRevision: number;
  readonly resolverVersion: number;
  /** Effective config with secrets stripped; safe to persist and reload. */
  readonly sanitizedEffectiveConfig: unknown;
  readonly contentHash: string;
  readonly createdAt: number;
  /** Durable pin (operator/retention); independent of the live refcount. */
  readonly pinned: boolean;
  /** References held by pending/running tasks (S05). */
  readonly refCount: number;
}

export interface WriteSnapshotInput {
  readonly id: string;
  readonly namespace: string;
  readonly fileDigest: string | null;
  readonly databaseRevision: number;
  readonly resolverVersion: number;
  readonly sanitizedEffectiveConfig: unknown;
  readonly contentHash: string;
  readonly now: number;
}

// ---------------------------------------------------------------------------
// Workspace bindings
// ---------------------------------------------------------------------------

export type WorkspaceBindingState = "active" | "disabled";

export interface WorkspaceBindingRecord {
  /** Full instance identity (spec §5.5); idempotent upsert key. */
  readonly instanceId: string;
  readonly definitionId: string;
  readonly canonicalProjectKey: string;
  readonly layoutVersion: number;
  /** Workspace-relative root; unique across all bindings (S08). */
  readonly relativeRoot: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly state: WorkspaceBindingState;
}

export interface UpsertBindingInput {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly canonicalProjectKey: string;
  readonly layoutVersion: number;
  readonly relativeRoot: string;
  readonly now: number;
}

// ---------------------------------------------------------------------------
// Admin sessions
// ---------------------------------------------------------------------------

export interface AdminSessionRecord {
  /** sha256 hex of the bearer token; plaintext tokens are never stored (S12). */
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

export interface ListRevisionsOptions {
  /** Return revisions strictly below this cursor. */
  readonly before?: number | undefined;
  readonly limit?: number | undefined;
}

export interface ListAuditOptions {
  readonly operationId?: string | undefined;
  readonly beforeTimestamp?: number | undefined;
  readonly limit?: number | undefined;
}

export interface ConfigStore {
  readonly backendKind: "memory" | "sqlite" | "postgres" | "redis";

  /** Current head; `null` when the namespace has no revision yet (S01). */
  readHead(namespace: string): Promise<ConfigHeadState | null>;

  /** Immutable copy of one revision; `null` when unknown (S01). */
  readRevision(namespace: string, revision: number): Promise<ConfigRevisionRecord | null>;

  /** Newest-first listing for history UI. */
  listRevisions(namespace: string, options?: ListRevisionsOptions): Promise<readonly ConfigRevisionRecord[]>;

  /** Operation lookup for lost responses / retries (S03). */
  readOperation(namespace: string, operationId: string): Promise<ConfigRevisionRecord | null>;

  /**
   * Linearization point of a publish: validate CAS, write revision + audit,
   * move head — atomically per namespace (S02/S04).
   */
  commitChangeset(input: CommitChangesetInput): Promise<CommitChangesetResult>;

  /** Audit history, newest first (S06). */
  readAudit(namespace: string, options?: ListAuditOptions): Promise<readonly ConfigAuditRecord[]>;

  /** Idempotent per id; identical content returns the stored record. */
  writeSnapshot(input: WriteSnapshotInput): Promise<ConfigRuntimeSnapshotRecord>;

  /** Copy of the snapshot; `null` when unknown (S05 reopen). */
  readSnapshot(id: string): Promise<ConfigRuntimeSnapshotRecord | null>;

  /** Adjust the live reference count; negative deltas never drop below zero. */
  adjustSnapshotRefCount(id: string, delta: number): Promise<ConfigRuntimeSnapshotRecord | null>;

  /** Durable pin/unpin for retention protection (S05). */
  setSnapshotPinned(id: string, pinned: boolean): Promise<ConfigRuntimeSnapshotRecord | null>;

  /**
   * Candidates for retention GC: unpinned, refcount zero, created at or
   * before `olderThan`. Pinned/referenced snapshots are never listed (S05).
   */
  listUnreferencedSnapshots(namespace: string, olderThan: number, limit?: number): Promise<readonly ConfigRuntimeSnapshotRecord[]>;

  /** Delete one snapshot; pinned or referenced snapshots throw `snapshot_invalid`. */
  deleteSnapshot(id: string): Promise<void>;

  /** Idempotent for the same full identity; root conflict throws (S08). */
  upsertWorkspaceBinding(input: UpsertBindingInput): Promise<WorkspaceBindingRecord>;

  readWorkspaceBinding(instanceId: string): Promise<WorkspaceBindingRecord | null>;

  listWorkspaceBindings(namespace: string): Promise<readonly WorkspaceBindingRecord[]>;

  setWorkspaceBindingState(instanceId: string, state: WorkspaceBindingState, now: number): Promise<WorkspaceBindingRecord | null>;

  /** Create/refresh a session keyed by token hash (S12). */
  saveAdminSession(record: AdminSessionRecord): Promise<void>;

  /** Live session for the hash; `null` when unknown or expired. */
  readAdminSession(tokenHash: string, now: number): Promise<AdminSessionRecord | null>;

  /** Revoke; durable so every replica sees the logout (S12). */
  deleteAdminSession(tokenHash: string): Promise<void>;

  /** Bounded purge of expired sessions; returns the removed count. */
  deleteExpiredAdminSessions(now: number, limit?: number): Promise<number>;

  /** Idempotent. Later operations throw `store_unavailable` (S13). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function assertNamespace(namespace: string): void {
  if (typeof namespace !== "string" || namespace.length === 0 || namespace.length > 128) {
    throw new ConfigError("store_unavailable", `Config namespace must be 1..128 chars; got ${JSON.stringify(namespace)}.`);
  }
}

export function assertStoreOpen(closed: boolean, backend: string): void {
  if (closed) {
    throw new ConfigError("store_unavailable", `${backend} config store is closed.`);
  }
}

/** Deep structural copy so callers can never mutate stored records (S01). */
export function copyConfigValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRevision(record: ConfigRevisionRecord): ConfigRevisionRecord {
  return { ...record, document: copyConfigValue(record.document) };
}

function cloneAudit(record: ConfigAuditRecord): ConfigAuditRecord {
  return { ...record, entityRefs: [...record.entityRefs], redactedDiff: copyConfigValue(record.redactedDiff) };
}

function cloneSnapshot(record: ConfigRuntimeSnapshotRecord): ConfigRuntimeSnapshotRecord {
  return { ...record, sanitizedEffectiveConfig: copyConfigValue(record.sanitizedEffectiveConfig) };
}

// ---------------------------------------------------------------------------
// Memory backend (tests only; S10: explicitly non-persistent)
// ---------------------------------------------------------------------------

interface MemoryNamespaceState {
  revisions: ConfigRevisionRecord[];
  head: ConfigHeadState | null;
  generation: number;
  operations: Map<string, ConfigRevisionRecord>;
  audit: ConfigAuditRecord[];
  auditSeq: number;
}

function emptyNamespace(): MemoryNamespaceState {
  return {
    revisions: [],
    head: null,
    generation: 0,
    operations: new Map(),
    audit: [],
    auditSeq: 0,
  };
}

export function createMemoryConfigStore(): ConfigStore {
  let closed = false;
  const namespaces = new Map<string, MemoryNamespaceState>();
  const snapshots = new Map<string, ConfigRuntimeSnapshotRecord>();
  const bindings = new Map<string, WorkspaceBindingRecord>();
  const sessions = new Map<string, AdminSessionRecord>();

  const stateOf = (namespace: string): MemoryNamespaceState => {
    assertNamespace(namespace);
    let state = namespaces.get(namespace);
    if (state === undefined) {
      state = emptyNamespace();
      namespaces.set(namespace, state);
    }
    return state;
  };
  const peek = (namespace: string): MemoryNamespaceState | undefined => {
    assertNamespace(namespace);
    return namespaces.get(namespace);
  };
  const open = (): void => assertStoreOpen(closed, "memory");

  return {
    backendKind: "memory",

    async readHead(namespace) {
      open();
      const head = peek(namespace)?.head ?? null;
      return Promise.resolve(head === null ? null : { ...head });
    },

    async readRevision(namespace, revision) {
      open();
      const found = peek(namespace)?.revisions.find((entry) => entry.revision === revision);
      return Promise.resolve(found === undefined ? null : cloneRevision(found));
    },

    async listRevisions(namespace, options = {}) {
      open();
      const all = [...(peek(namespace)?.revisions ?? [])]
        .filter((entry) => options.before === undefined || entry.revision < options.before)
        .sort((a, b) => b.revision - a.revision);
      const limited = options.limit !== undefined ? all.slice(0, options.limit) : all;
      return Promise.resolve(limited.map(cloneRevision));
    },

    async readOperation(namespace, operationId) {
      open();
      const found = peek(namespace)?.operations.get(operationId);
      return Promise.resolve(found === undefined ? null : cloneRevision(found));
    },

    async commitChangeset(input) {
      open();
      const state = stateOf(input.namespace);

      const existing = state.operations.get(input.operationId);
      if (existing !== undefined) {
        // Content identity is the document hash of the committed revision.
        if (sameConfigOperation(existing, input)) {
          return Promise.resolve({
            status: "committed",
            revision: cloneRevision(existing),
            head: { ...state.head! },
            duplicate: true,
          });
        }
        throw new ConfigError(
          "operation_conflict",
          `Operation "${input.operationId}" was already committed with different content (namespace "${input.namespace}").`,
        );
      }

      const head = state.head;
      const expectedBase = head === null ? null : head.activeRevision;
      if (input.baseRevision !== expectedBase) {
        return Promise.resolve({
          status: "revision_conflict",
          head: head === null
            ? { namespace: input.namespace, activeRevision: 0, generation: "0" }
            : { ...head },
        });
      }

      const revision: ConfigRevisionRecord = {
        namespace: input.namespace,
        revision: expectedBase === null ? 1 : expectedBase + 1,
        parentRevision: expectedBase,
        formatVersion: input.formatVersion,
        document: copyConfigValue(input.document),
        contentHash: contentHashOf(input.document),
        fileDigest: input.fileDigest,
        createdAt: input.now,
        actor: input.actor,
        operationId: input.operationId,
      };
      state.generation += 1;
      state.revisions.push(revision);
      state.operations.set(input.operationId, revision);
      state.head = {
        namespace: input.namespace,
        activeRevision: revision.revision,
        generation: String(state.generation),
      };
      state.auditSeq += 1;
      state.audit.push({
        ...input.audit,
        entityRefs: [...input.audit.entityRefs],
        redactedDiff: copyConfigValue(input.audit.redactedDiff),
        namespace: input.namespace,
        id: `audit-${state.auditSeq}`,
        operationId: input.operationId,
        beforeRevision: expectedBase,
        afterRevision: revision.revision,
        actor: input.actor,
        timestamp: input.now,
      });
      return Promise.resolve({
        status: "committed",
        revision: cloneRevision(revision),
        head: { ...state.head },
        duplicate: false,
      });
    },

    async readAudit(namespace, options = {}) {
      open();
      const all = [...(peek(namespace)?.audit ?? [])]
        .filter((entry) => options.operationId === undefined || entry.operationId === options.operationId)
        .filter((entry) => options.beforeTimestamp === undefined || entry.timestamp < options.beforeTimestamp)
        .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
      const limited = options.limit !== undefined ? all.slice(0, options.limit) : all;
      return Promise.resolve(limited.map(cloneAudit));
    },

    async writeSnapshot(input) {
      open();
      const existing = snapshots.get(input.id);
      if (existing !== undefined) {
        if (sameSnapshotContent(existing, input)) {
          return Promise.resolve(cloneSnapshot(existing));
        }
        throw new ConfigError("snapshot_invalid", `Snapshot "${input.id}" already exists with different content.`);
      }
      const record: ConfigRuntimeSnapshotRecord = {
        id: input.id,
        namespace: input.namespace,
        fileDigest: input.fileDigest,
        databaseRevision: input.databaseRevision,
        resolverVersion: input.resolverVersion,
        sanitizedEffectiveConfig: copyConfigValue(input.sanitizedEffectiveConfig),
        contentHash: input.contentHash,
        createdAt: input.now,
        pinned: false,
        refCount: 0,
      };
      snapshots.set(input.id, record);
      return Promise.resolve(cloneSnapshot(record));
    },

    async readSnapshot(id) {
      open();
      const found = snapshots.get(id);
      return Promise.resolve(found === undefined ? null : cloneSnapshot(found));
    },

    async adjustSnapshotRefCount(id, delta) {
      open();
      const found = snapshots.get(id);
      if (found === undefined) return Promise.resolve(null);
      const updated = { ...found, refCount: Math.max(0, found.refCount + delta) };
      snapshots.set(id, updated);
      return Promise.resolve(cloneSnapshot(updated));
    },

    async setSnapshotPinned(id, pinned) {
      open();
      const found = snapshots.get(id);
      if (found === undefined) return Promise.resolve(null);
      const updated = { ...found, pinned };
      snapshots.set(id, updated);
      return Promise.resolve(cloneSnapshot(updated));
    },

    async listUnreferencedSnapshots(namespace, olderThan, limit = 100) {
      open();
      const result = [...snapshots.values()]
        .filter((entry) => entry.namespace === namespace)
        .filter((entry) => !entry.pinned && entry.refCount === 0 && entry.createdAt <= olderThan)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit)
        .map(cloneSnapshot);
      return Promise.resolve(result);
    },

    async deleteSnapshot(id) {
      open();
      const found = snapshots.get(id);
      if (found === undefined) return Promise.resolve();
      if (found.pinned || found.refCount > 0) {
        throw new ConfigError("snapshot_invalid", `Snapshot "${id}" is still referenced and cannot be deleted.`);
      }
      snapshots.delete(id);
      return Promise.resolve();
    },

    async upsertWorkspaceBinding(input) {
      open();
      const existing = bindings.get(input.instanceId);
      if (existing !== undefined) {
        if (existing.relativeRoot !== input.relativeRoot) {
          throw new ConfigError(
            "binding_conflict",
            `Binding "${input.instanceId}" already owns root "${existing.relativeRoot}".`,
          );
        }
        const updated: WorkspaceBindingRecord = {
          ...existing,
          definitionId: input.definitionId,
          canonicalProjectKey: input.canonicalProjectKey,
          layoutVersion: input.layoutVersion,
          lastSeenAt: input.now,
        };
        bindings.set(input.instanceId, updated);
        return Promise.resolve({ ...updated });
      }
      for (const other of bindings.values()) {
        if (other.relativeRoot === input.relativeRoot) {
          throw new ConfigError(
            "binding_conflict",
            `Root "${input.relativeRoot}" is already owned by binding "${other.instanceId}" (S08).`,
          );
        }
      }
      const record: WorkspaceBindingRecord = {
        instanceId: input.instanceId,
        definitionId: input.definitionId,
        canonicalProjectKey: input.canonicalProjectKey,
        layoutVersion: input.layoutVersion,
        relativeRoot: input.relativeRoot,
        createdAt: input.now,
        lastSeenAt: input.now,
        state: "active",
      };
      bindings.set(input.instanceId, record);
      return Promise.resolve({ ...record });
    },

    async readWorkspaceBinding(instanceId) {
      open();
      const found = bindings.get(instanceId);
      return Promise.resolve(found === undefined ? null : { ...found });
    },

    async listWorkspaceBindings(namespace) {
      void namespace;
      open();
      return Promise.resolve([...bindings.values()].map((record) => ({ ...record })));
    },

    async setWorkspaceBindingState(instanceId, state, now) {
      open();
      const found = bindings.get(instanceId);
      if (found === undefined) return Promise.resolve(null);
      const updated = { ...found, state, lastSeenAt: now };
      bindings.set(instanceId, updated);
      return Promise.resolve({ ...updated });
    },

    async saveAdminSession(record) {
      open();
      sessions.set(record.tokenHash, { ...record });
      return Promise.resolve();
    },

    async readAdminSession(tokenHash, now) {
      open();
      const found = sessions.get(tokenHash);
      if (found === undefined || found.expiresAt <= now) return Promise.resolve(null);
      return Promise.resolve({ ...found });
    },

    async deleteAdminSession(tokenHash) {
      open();
      sessions.delete(tokenHash);
      return Promise.resolve();
    },

    async deleteExpiredAdminSessions(now, limit = 500) {
      open();
      let removed = 0;
      for (const [hash, record] of sessions) {
        if (removed >= limit) break;
        if (record.expiresAt <= now) {
          sessions.delete(hash);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },

    async close() {
      closed = true;
      return Promise.resolve();
    },
  };
}

/** Deterministic content identity of a database document (stable key order). */
export function contentHashOf(document: unknown): string {
  return createHash("sha256").update(stableStringify(document)).digest("hex");
}

/** Operation identity includes the file and format that determine its meaning. */
export function sameConfigOperation(existing: ConfigRevisionRecord, input: CommitChangesetInput): boolean {
  return existing.contentHash === contentHashOf(input.document) && existing.fileDigest === input.fileDigest && existing.formatVersion === input.formatVersion;
}

/** A caller-supplied digest cannot authorize changing a snapshot's identity. */
export function sameSnapshotContent(existing: ConfigRuntimeSnapshotRecord, input: WriteSnapshotInput): boolean {
  return existing.namespace === input.namespace && existing.fileDigest === input.fileDigest &&
    existing.databaseRevision === input.databaseRevision && existing.resolverVersion === input.resolverVersion &&
    existing.contentHash === input.contentHash && stableSerialize(existing.sanitizedEffectiveConfig) === stableSerialize(input.sanitizedEffectiveConfig);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}
