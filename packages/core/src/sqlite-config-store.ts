/**
 * SQLite ConfigStore — durable configuration revisions on local disk.
 *
 * Shares the deployment's app SQLite file (WAL allows concurrent readers)
 * and owns the `config` namespace of the `schema_migrations` ledger
 * (spec §4.3/§9.3). Every mutation runs in a BEGIN IMMEDIATE transaction;
 * the migration step re-reads the ledger inside that transaction so two
 * processes racing at boot apply the DDL exactly once (M04).
 *
 * Version discipline (M16): the ledger records each applied migration's
 * checksum; a drifted checksum or an unknown higher `to_version` stops the
 * store with `schema_version_unsupported` instead of writing into an
 * incompatible shape.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { ConfigError } from "./config-format.js";
import type {
  AdminSessionRecord,
  CommitChangesetInput,
  CommitChangesetResult,
  ConfigAuditRecord,
  ConfigHeadState,
  ConfigRevisionRecord,
  ConfigRuntimeSnapshotRecord,
  ConfigStore,
  WorkspaceBindingRecord,
  WorkspaceBindingState,
} from "./config-store.js";
import {
  assertNamespace,
  assertStoreOpen,
  contentHashOf,
  sameConfigOperation,
  sameSnapshotContent,
} from "./config-store.js";
import type { MigrationStep, NamespaceMigrationPlan } from "./migration-runner.js";
import { MigrationRunner } from "./migration-runner.js";
import { createSqliteMigrationStore, sqliteSqlStep } from "./sqlite-migration-store.js";

// ---------------------------------------------------------------------------
// better-sqlite3 loading (optional dependency, mirrors sqlite queue/store)
// ---------------------------------------------------------------------------

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  prepare(source: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T & { immediate: T };
  close(): void;
}

interface SqliteModule {
  new (path: string, options?: { readonly?: boolean }): SqliteDatabase;
}

// Dynamic import: better-sqlite3 is an optionalDependency whose native build
// may be absent; a static import would crash every startup on such hosts
// instead of failing only when the SQLite backend is selected.
async function loadBetterSqlite3(): Promise<SqliteModule> {
  try {
    const mod = (await import("better-sqlite3")) as unknown as { default: SqliteModule };
    return mod.default;
  } catch {
    throw new ConfigError(
      "store_unavailable",
      "better-sqlite3 is not installed. Install it with: pnpm add better-sqlite3",
    );
  }
}

// ---------------------------------------------------------------------------
// Migration ledger (config namespace)
// ---------------------------------------------------------------------------

export const CONFIG_STORE_NAMESPACE = "config";
export const CONFIG_STORE_SCHEMA_VERSION = 1;

const CONFIG_STORE_SQL_001 = `
      CREATE TABLE IF NOT EXISTS config_revisions (
        namespace TEXT NOT NULL,
        revision INTEGER NOT NULL,
        parent_revision INTEGER,
        format_version INTEGER NOT NULL,
        document TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        file_digest TEXT,
        created_at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        PRIMARY KEY (namespace, revision)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_config_revisions_operation
        ON config_revisions(namespace, operation_id);

      CREATE TABLE IF NOT EXISTS config_heads (
        namespace TEXT PRIMARY KEY,
        active_revision INTEGER NOT NULL,
        generation INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_audit (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        before_revision INTEGER,
        after_revision INTEGER NOT NULL,
        action TEXT NOT NULL,
        entity_refs TEXT NOT NULL,
        redacted_diff TEXT NOT NULL,
        actor TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_config_audit_ns
        ON config_audit(namespace, timestamp);

      CREATE TABLE IF NOT EXISTS config_runtime_snapshots (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        file_digest TEXT,
        database_revision INTEGER NOT NULL,
        resolver_version INTEGER NOT NULL,
        sanitized_effective_config TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        ref_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_config_snapshots_ns
        ON config_runtime_snapshots(namespace, created_at);

      CREATE TABLE IF NOT EXISTS workspace_bindings (
        instance_id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL,
        canonical_project_key TEXT NOT NULL,
        layout_version INTEGER NOT NULL,
        relative_root TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        state TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
        ON admin_sessions(expires_at);
`;

/** Config-namespace steps; shared with the CLI migrate command (M17-M20). */
export const CONFIG_STORE_MIGRATIONS: readonly MigrationStep[] = [
  sqliteSqlStep("001_config_initial", 0, 1, CONFIG_STORE_SQL_001),
];

export function createConfigStoreMigrationPlan(): NamespaceMigrationPlan {
  return {
    namespace: CONFIG_STORE_NAMESPACE,
    targetVersion: CONFIG_STORE_SCHEMA_VERSION,
    steps: CONFIG_STORE_MIGRATIONS,
  };
}

// ---------------------------------------------------------------------------
// Row mappings
// ---------------------------------------------------------------------------

interface RevisionRow {
  namespace: string;
  revision: number;
  parent_revision: number | null;
  format_version: number;
  document: string;
  content_hash: string;
  file_digest: string | null;
  created_at: number;
  actor: string;
  operation_id: string;
}

interface HeadRow {
  namespace: string;
  active_revision: number;
  generation: number;
}

interface AuditRow {
  id: string;
  namespace: string;
  operation_id: string;
  before_revision: number | null;
  after_revision: number;
  action: string;
  entity_refs: string;
  redacted_diff: string;
  actor: string;
  timestamp: number;
}

interface SnapshotRow {
  id: string;
  namespace: string;
  file_digest: string | null;
  database_revision: number;
  resolver_version: number;
  sanitized_effective_config: string;
  content_hash: string;
  created_at: number;
  pinned: number;
  ref_count: number;
}

interface BindingRow {
  instance_id: string;
  definition_id: string;
  canonical_project_key: string;
  layout_version: number;
  relative_root: string;
  created_at: number;
  last_seen_at: number;
  state: string;
}

interface SessionRow {
  token_hash: string;
  created_at: number;
  expires_at: number;
}

function rowToRevision(row: RevisionRow): ConfigRevisionRecord {
  return {
    namespace: row.namespace,
    revision: row.revision,
    parentRevision: row.parent_revision,
    formatVersion: row.format_version,
    document: JSON.parse(row.document) as ConfigRevisionRecord["document"],
    contentHash: row.content_hash,
    fileDigest: row.file_digest,
    createdAt: row.created_at,
    actor: row.actor,
    operationId: row.operation_id,
  };
}

function rowToHead(row: HeadRow): ConfigHeadState {
  return {
    namespace: row.namespace,
    activeRevision: row.active_revision,
    // Decimal string at the API boundary so u64-capable backends never
    // coerce differently (S11); SQLite integers stay exact here.
    generation: String(row.generation),
  };
}

function rowToAudit(row: AuditRow): ConfigAuditRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    operationId: row.operation_id,
    beforeRevision: row.before_revision,
    afterRevision: row.after_revision,
    action: row.action,
    entityRefs: JSON.parse(row.entity_refs) as string[],
    redactedDiff: JSON.parse(row.redacted_diff) as unknown,
    actor: row.actor,
    timestamp: row.timestamp,
  };
}

function rowToSnapshot(row: SnapshotRow): ConfigRuntimeSnapshotRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    fileDigest: row.file_digest,
    databaseRevision: row.database_revision,
    resolverVersion: row.resolver_version,
    sanitizedEffectiveConfig: JSON.parse(row.sanitized_effective_config) as unknown,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    pinned: row.pinned !== 0,
    refCount: row.ref_count,
  };
}

function rowToBinding(row: BindingRow): WorkspaceBindingRecord {
  return {
    instanceId: row.instance_id,
    definitionId: row.definition_id,
    canonicalProjectKey: row.canonical_project_key,
    layoutVersion: row.layout_version,
    relativeRoot: row.relative_root,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    state: row.state as WorkspaceBindingState,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface SqliteConfigStoreOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * `auto` applies pending migrations at open (default); `verify` refuses to
   * open when the ledger is behind, drifted, or newer than this program
   * (M19 startup gate).
   */
  readonly migrationMode?: "auto" | "verify" | undefined;
}

export async function createSqliteConfigStore(options: SqliteConfigStoreOptions): Promise<ConfigStore> {
  const Database = await loadBetterSqlite3();
  if (options.migrationMode === "verify") {
    if (!existsSync(options.path)) throw new ConfigError("migration_failed", "Config database does not exist; apply migrations before verify startup.");
    const probe = new Database(options.path, { readonly: true });
    try {
      const check = await new MigrationRunner(createSqliteMigrationStore(probe), [createConfigStoreMigrationPlan()]).check();
      if (check.needsMigration.length > 0) throw new ConfigError("migration_failed", "Config schema is behind this program; apply migrations before verify startup.");
    } finally { probe.close(); }
  }
  mkdirSync(dirname(options.path), { recursive: true });
  const db: SqliteDatabase = new Database(options.path);
  let closed = false;
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    db.pragma("synchronous = NORMAL");
    // Shared-ledger runner: BEGIN IMMEDIATE + in-lock ledger re-read (M04/M06).
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [createConfigStoreMigrationPlan()], { now: options.now });
    if (options.migrationMode === "verify") {
      const check = await runner.check();
      if (check.needsMigration.length > 0) {
        throw new ConfigError(
          "migration_failed",
          `Config store schema is behind this program (pending namespaces: ${check.needsMigration.join(", ")}); run \`aicr migrate --apply\` or set storage.database.migrate=auto.`,
        );
      }
    } else {
      await runner.apply();
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const stmtHead = db.prepare("SELECT * FROM config_heads WHERE namespace = ?");
  const stmtRevision = db.prepare("SELECT * FROM config_revisions WHERE namespace = ? AND revision = ?");
  const stmtRevisionByOperation = db.prepare("SELECT * FROM config_revisions WHERE namespace = ? AND operation_id = ?");

  const open = (): void => assertStoreOpen(closed, "sqlite");

  const txCommit = db.transaction((input: CommitChangesetInput): CommitChangesetResult => {
    const existing = stmtRevisionByOperation.get(input.namespace, input.operationId) as RevisionRow | undefined;
    if (existing !== undefined) {
      if (sameConfigOperation(rowToRevision(existing), input)) {
        const head = stmtHead.get(input.namespace) as HeadRow;
        return { status: "committed", revision: rowToRevision(existing), head: rowToHead(head), duplicate: true };
      }
      throw new ConfigError(
        "operation_conflict",
        `Operation "${input.operationId}" was already committed with different content (namespace "${input.namespace}").`,
      );
    }

    const headRow = stmtHead.get(input.namespace) as HeadRow | undefined;
    const expectedBase = headRow === undefined ? null : headRow.active_revision;
    if (input.baseRevision !== expectedBase) {
      return {
        status: "revision_conflict",
        head: headRow === undefined
          ? { namespace: input.namespace, activeRevision: 0, generation: "0" }
          : rowToHead(headRow),
      };
    }

    const revision = expectedBase === null ? 1 : expectedBase + 1;
    db.prepare(
      `INSERT INTO config_revisions (
         namespace, revision, parent_revision, format_version, document, content_hash,
         file_digest, created_at, actor, operation_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.namespace,
      revision,
      expectedBase,
      input.formatVersion,
      JSON.stringify(input.document),
      contentHashOf(input.document),
      input.fileDigest,
      input.now,
      input.actor,
      input.operationId,
    );
    db.prepare(
      `INSERT INTO config_heads (namespace, active_revision, generation) VALUES (?, ?, 1)
       ON CONFLICT(namespace) DO UPDATE SET active_revision = excluded.active_revision,
         generation = config_heads.generation + 1`,
    ).run(input.namespace, revision);
    db.prepare(
      `INSERT INTO config_audit (
         id, namespace, operation_id, before_revision, after_revision, action,
         entity_refs, redacted_diff, actor, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.namespace,
      input.operationId,
      expectedBase,
      revision,
      input.audit.action,
      JSON.stringify(input.audit.entityRefs),
      JSON.stringify(input.audit.redactedDiff),
      input.actor,
      input.now,
    );
    const head = stmtHead.get(input.namespace) as HeadRow;
    const stored = stmtRevision.get(input.namespace, revision) as RevisionRow;
    return { status: "committed", revision: rowToRevision(stored), head: rowToHead(head), duplicate: false };
  });

  return {
    backendKind: "sqlite",

    async readHead(namespace) {
      open();
      assertNamespace(namespace);
      const row = stmtHead.get(namespace) as HeadRow | undefined;
      return row === undefined ? null : rowToHead(row);
    },

    async readRevision(namespace, revision) {
      open();
      assertNamespace(namespace);
      const row = stmtRevision.get(namespace, revision) as RevisionRow | undefined;
      return row === undefined ? null : rowToRevision(row);
    },

    async listRevisions(namespace, listOptions = {}) {
      open();
      assertNamespace(namespace);
      const rows = db.prepare(
        `SELECT * FROM config_revisions
          WHERE namespace = ? AND (? IS NULL OR revision < ?)
          ORDER BY revision DESC
          LIMIT ?`,
      ).all(
        namespace,
        listOptions.before ?? null,
        listOptions.before ?? null,
        listOptions.limit ?? 1000,
      ) as RevisionRow[];
      return rows.map(rowToRevision);
    },

    async readOperation(namespace, operationId) {
      open();
      assertNamespace(namespace);
      const row = stmtRevisionByOperation.get(namespace, operationId) as RevisionRow | undefined;
      return row === undefined ? null : rowToRevision(row);
    },

    async commitChangeset(input) {
      open();
      assertNamespace(input.namespace);
      return txCommit.immediate(input);
    },

    async readAudit(namespace, readOptions = {}) {
      open();
      assertNamespace(namespace);
      const rows = db.prepare(
        `SELECT * FROM config_audit
          WHERE namespace = ?
            AND (? IS NULL OR operation_id = ?)
            AND (? IS NULL OR timestamp < ?)
          ORDER BY timestamp DESC, id DESC
          LIMIT ?`,
      ).all(
        namespace,
        readOptions.operationId ?? null,
        readOptions.operationId ?? null,
        readOptions.beforeTimestamp ?? null,
        readOptions.beforeTimestamp ?? null,
        readOptions.limit ?? 1000,
      ) as AuditRow[];
      return rows.map(rowToAudit);
    },

    async writeSnapshot(input) {
      open();
      // INSERT OR IGNORE first (atomic idempotency per config-store.ts
      // writeSnapshot): two racing writers of the same id fold into one row
      // instead of the loser dying on the primary key; the loser re-reads
      // and compares content hashes.
      for (;;) {
        const inserted = db.prepare(
          `INSERT OR IGNORE INTO config_runtime_snapshots (
             id, namespace, file_digest, database_revision, resolver_version,
             sanitized_effective_config, content_hash, created_at, pinned, ref_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        ).run(
          input.id,
          input.namespace,
          input.fileDigest,
          input.databaseRevision,
          input.resolverVersion,
          JSON.stringify(input.sanitizedEffectiveConfig),
          input.contentHash,
          input.now,
        );
        const row = db.prepare("SELECT * FROM config_runtime_snapshots WHERE id = ?").get(input.id) as SnapshotRow | undefined;
        if (inserted.changes > 0) return rowToSnapshot(row as SnapshotRow); // present: this connection just inserted it
        if (row === undefined) continue; // a concurrent delete won the gap; retry the insert
        if (sameSnapshotContent(rowToSnapshot(row), input)) return rowToSnapshot(row);
        throw new ConfigError("snapshot_invalid", `Snapshot "${input.id}" already exists with different content.`);
      }
    },

    async readSnapshot(id) {
      open();
      const row = db.prepare("SELECT * FROM config_runtime_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
      return row === undefined ? null : rowToSnapshot(row);
    },

    async adjustSnapshotRefCount(id, delta) {
      open();
      db.prepare(
        `UPDATE config_runtime_snapshots
            SET ref_count = MAX(0, ref_count + ?)
          WHERE id = ?`,
      ).run(delta, id);
      const row = db.prepare("SELECT * FROM config_runtime_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
      return row === undefined ? null : rowToSnapshot(row);
    },

    async setSnapshotPinned(id, pinned) {
      open();
      db.prepare("UPDATE config_runtime_snapshots SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
      const row = db.prepare("SELECT * FROM config_runtime_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
      return row === undefined ? null : rowToSnapshot(row);
    },

    async listUnreferencedSnapshots(namespace, olderThan, limit = 100) {
      open();
      assertNamespace(namespace);
      const rows = db.prepare(
        `SELECT * FROM config_runtime_snapshots
          WHERE namespace = ? AND pinned = 0 AND ref_count = 0 AND created_at <= ?
          ORDER BY created_at ASC
          LIMIT ?`,
      ).all(namespace, olderThan, limit) as SnapshotRow[];
      return rows.map(rowToSnapshot);
    },

    async deleteSnapshot(id) {
      open();
      // Single atomic conditional delete (spec §7.2): a ref-count landing
      // between a check-then-delete pair can no longer orphan a signed-out
      // task's snapshot. The follow-up SELECT only classifies the miss:
      // row gone = idempotent no-op, row present = still referenced.
      const deleted = db.prepare(
        "DELETE FROM config_runtime_snapshots WHERE id = ? AND pinned = 0 AND ref_count = 0",
      ).run(id);
      if (deleted.changes > 0) return;
      const row = db.prepare("SELECT pinned, ref_count FROM config_runtime_snapshots WHERE id = ?").get(id) as
        { pinned: number; ref_count: number } | undefined;
      if (row === undefined) return;
      throw new ConfigError("snapshot_invalid", `Snapshot "${id}" is still referenced and cannot be deleted.`);
    },

    async upsertWorkspaceBinding(input) {
      open();
      return db.transaction((): WorkspaceBindingRecord => {
        const existing = db.prepare("SELECT * FROM workspace_bindings WHERE instance_id = ?").get(input.instanceId) as BindingRow | undefined;
        if (existing !== undefined) {
          if (existing.relative_root !== input.relativeRoot) {
            throw new ConfigError(
              "binding_conflict",
              `Binding "${input.instanceId}" already owns root "${existing.relative_root}".`,
            );
          }
          db.prepare(
            `UPDATE workspace_bindings
                SET definition_id = ?, canonical_project_key = ?, layout_version = ?, last_seen_at = ?
              WHERE instance_id = ?`,
          ).run(input.definitionId, input.canonicalProjectKey, input.layoutVersion, input.now, input.instanceId);
          return rowToBinding(db.prepare("SELECT * FROM workspace_bindings WHERE instance_id = ?").get(input.instanceId) as BindingRow);
        }
        const owner = db.prepare("SELECT * FROM workspace_bindings WHERE relative_root = ?").get(input.relativeRoot) as BindingRow | undefined;
        if (owner !== undefined) {
          throw new ConfigError(
            "binding_conflict",
            `Root "${input.relativeRoot}" is already owned by binding "${owner.instance_id}" (S08).`,
          );
        }
        db.prepare(
          `INSERT INTO workspace_bindings (
             instance_id, definition_id, canonical_project_key, layout_version,
             relative_root, created_at, last_seen_at, state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        ).run(
          input.instanceId,
          input.definitionId,
          input.canonicalProjectKey,
          input.layoutVersion,
          input.relativeRoot,
          input.now,
          input.now,
        );
        return rowToBinding(db.prepare("SELECT * FROM workspace_bindings WHERE instance_id = ?").get(input.instanceId) as BindingRow);
      }).immediate();
    },

    async readWorkspaceBinding(instanceId) {
      open();
      const row = db.prepare("SELECT * FROM workspace_bindings WHERE instance_id = ?").get(instanceId) as BindingRow | undefined;
      return row === undefined ? null : rowToBinding(row);
    },

    async listWorkspaceBindings(_namespace) {
      open();
      const rows = db.prepare("SELECT * FROM workspace_bindings ORDER BY created_at ASC").all() as BindingRow[];
      return rows.map(rowToBinding);
    },

    async setWorkspaceBindingState(instanceId, state, now) {
      open();
      db.prepare("UPDATE workspace_bindings SET state = ?, last_seen_at = ? WHERE instance_id = ?").run(state, now, instanceId);
      const row = db.prepare("SELECT * FROM workspace_bindings WHERE instance_id = ?").get(instanceId) as BindingRow | undefined;
      return row === undefined ? null : rowToBinding(row);
    },

    async saveAdminSession(record: AdminSessionRecord) {
      open();
      db.prepare(
        `INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET created_at = excluded.created_at, expires_at = excluded.expires_at`,
      ).run(record.tokenHash, record.createdAt, record.expiresAt);
    },

    async readAdminSession(tokenHash, now) {
      open();
      const row = db.prepare("SELECT * FROM admin_sessions WHERE token_hash = ?").get(tokenHash) as SessionRow | undefined;
      if (row === undefined || row.expires_at <= now) return null;
      return { tokenHash: row.token_hash, createdAt: row.created_at, expiresAt: row.expires_at };
    },

    async deleteAdminSession(tokenHash) {
      open();
      db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
    },

    async deleteExpiredAdminSessions(now, limit = 500) {
      open();
      const result = db.prepare(
        `DELETE FROM admin_sessions WHERE token_hash IN (
           SELECT token_hash FROM admin_sessions WHERE expires_at <= ? LIMIT ?
         )`,
      ).run(now, limit);
      return result.changes;
    },

    close() {
      if (closed) return Promise.resolve();
      closed = true;
      db.close();
      return Promise.resolve();
    },
  };
}
