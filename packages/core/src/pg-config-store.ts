/**
 * PostgreSQL ConfigStore — durable configuration revisions on the app
 * PostgreSQL service (spec §4.3/§9.3, P2).
 *
 * Mirrors the SQLite backend's table shape with PG-native types (JSONB for
 * documents/diffs, BIGINT for epoch millis and the head generation) and owns
 * the `config` namespace of the shared `schema_migrations` ledger. Mutations
 * that must be atomic (changeset commit, binding upsert) run in one
 * transaction on a single dedicated client — never interleaved pool queries
 * (M07); the changeset transaction additionally takes a per-namespace
 * advisory transaction lock and locks the head row FOR UPDATE, so a
 * concurrent commit observes the winner and reports `revision_conflict`
 * instead of forking (S02/S04).
 *
 * Migration discipline (M04/M06): every apply batch runs BEGIN →
 * pg_advisory_xact_lock → in-lock ledger re-read → DDL + ledger writes →
 * COMMIT on one client, so a crash or a bad step rolls the whole batch back
 * and a restart retries cleanly. M16 checksum drift / unknown-higher-version
 * refusal is enforced by the shared MigrationRunner.
 */

import { createHash, randomUUID } from "node:crypto";

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
  ListAuditOptions,
  ListRevisionsOptions,
  UpsertBindingInput,
  WorkspaceBindingRecord,
  WorkspaceBindingState,
  WriteSnapshotInput,
} from "./config-store.js";
import {
  assertNamespace,
  assertStoreOpen,
  contentHashOf,
  sameConfigOperation,
  sameSnapshotContent,
} from "./config-store.js";
import type {
  AppliedMigration,
  MigrationStep,
  MigrationStore,
  NamespaceMigrationPlan,
} from "./migration-runner.js";
import { MigrationRunner } from "./migration-runner.js";
import { CONFIG_STORE_NAMESPACE, CONFIG_STORE_SCHEMA_VERSION } from "./sqlite-config-store.js";

import type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";

// ---------------------------------------------------------------------------
// pg loading (optional dependency, mirrors better-sqlite3/ioredis loaders)
// ---------------------------------------------------------------------------

type PgPoolCtor = new (config: PoolConfig) => Pool;

// Dynamic import: pg is an optionalDependency that is absent unless the
// PostgreSQL backend is configured; a static import would crash other
// backends at module load (same pattern as redis-config-store.ts).
async function loadPg(): Promise<PgPoolCtor> {
  try {
    const mod = (await import("pg")) as unknown as {
      Pool?: PgPoolCtor;
      default?: { Pool?: PgPoolCtor };
    };
    const ctor = mod.Pool ?? mod.default?.Pool;
    if (ctor === undefined) throw new Error("pg Pool export not found");
    return ctor;
  } catch (error) {
    throw new ConfigError(
      "store_unavailable",
      "pg is not installed; the PostgreSQL config store requires it (pnpm add pg).",
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// Migration ledger (config namespace) — PG executor
// ---------------------------------------------------------------------------

/**
 * Transaction-scoped advisory lock key serializing config migrations across
 * processes. Shared with the business store because both create the same
 * schema and migration ledger, including on concurrent fresh startup.
 */
export const PG_CONFIG_MIGRATION_LOCK_KEY = 0x61696372;

/** Minimal async client shape the executor relies on (pg.PoolClient). */
export interface PgConfigMigrationClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface LedgerRow {
  id: string;
  checksum: string | null;
  from_version: number;
  to_version: number;
  app_version: string | null;
  applied_at: string | number;
}

/** Builds a SQL step whose checksum pins the body (M16 drift detection). */
export function pgConfigSqlStep(id: string, fromVersion: number, toVersion: number, sql: string, description?: string): MigrationStep {
  return {
    id,
    fromVersion,
    toVersion,
    checksum: createHash("sha256").update(`${id}\n${sql}`).digest("hex"),
    description,
    payload: { sql },
  };
}

function sqlOf(step: MigrationStep): string {
  const payload = step.payload as { sql?: unknown } | undefined;
  if (payload === undefined || typeof payload.sql !== "string") {
    throw new Error(`postgres config migration store cannot apply non-SQL step "${step.id}"`);
  }
  return payload.sql;
}

/**
 * node-postgres executor for the MigrationRunner contract. Every apply batch
 * runs in one transaction on a single dedicated client (never interleaved
 * pool queries): BEGIN → pg_advisory_xact_lock → DDL + ledger writes →
 * COMMIT; any failure rolls the whole batch back (M06).
 */
export function createPgConfigMigrationStore(client: PgConfigMigrationClient): MigrationStore {
  return {
    backendKind: "postgres",

    async ensureLedger() {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          namespace text NOT NULL,
          id text NOT NULL,
          checksum text,
          from_version integer NOT NULL,
          to_version integer NOT NULL,
          app_version text,
          applied_at bigint NOT NULL,
          PRIMARY KEY (namespace, id)
        );
      `);
    },

    /**
     * Read-only ledger probe for the verify path: no DDL. Resolves through
     * the session search_path, so a missing schema or table reads as an
     * empty ledger and the runner reports every step pending.
     */
    async ledgerExists() {
      const result = await client.query(
        `SELECT to_regclass('schema_migrations') IS NOT NULL AS exists`,
      );
      return (result.rows[0] as { exists: boolean } | undefined)?.exists === true;
    },

    async withMigrationLock(fn) {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT pg_advisory_xact_lock(${PG_CONFIG_MIGRATION_LOCK_KEY})`);
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    },

    async readApplied(namespace) {
      const result = await client.query(
        `SELECT id, checksum, from_version, to_version, app_version, applied_at
           FROM schema_migrations
          WHERE namespace = $1
          ORDER BY to_version ASC`,
        [namespace],
      );
      return (result.rows as unknown as LedgerRow[]).map((row): AppliedMigration => ({
        id: row.id,
        checksum: row.checksum,
        fromVersion: row.from_version,
        toVersion: row.to_version,
        appVersion: row.app_version,
        appliedAt: Number(row.applied_at),
      }));
    },

    async applyStep(step) {
      await client.query(sqlOf(step));
    },

    async recordApplied(namespace, step, appVersion, now) {
      await client.query(
        `INSERT INTO schema_migrations
           (namespace, id, checksum, from_version, to_version, app_version, applied_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [namespace, step.id, step.checksum, step.fromVersion, step.toVersion, appVersion, now],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Migration plan (config namespace)
// ---------------------------------------------------------------------------

/**
 * Mirrors the SQLite CONFIG_STORE_SQL_001 shape with PG dialect: JSONB for
 * documents/diffs/snapshot configs, BIGINT for epoch millis and generation,
 * BOOLEAN for the snapshot pin. The step id/checksum differ from SQLite's
 * because the SQL dialect differs; each backend owns its own ledger chain.
 */
export const PG_CONFIG_STORE_SQL_001 = `
      CREATE TABLE IF NOT EXISTS config_revisions (
        namespace TEXT NOT NULL,
        revision INTEGER NOT NULL,
        parent_revision INTEGER,
        format_version INTEGER NOT NULL,
        document JSONB NOT NULL,
        content_hash TEXT NOT NULL,
        file_digest TEXT,
        created_at BIGINT NOT NULL,
        actor TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        PRIMARY KEY (namespace, revision)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_config_revisions_operation
        ON config_revisions(namespace, operation_id);

      CREATE TABLE IF NOT EXISTS config_heads (
        namespace TEXT PRIMARY KEY,
        active_revision INTEGER NOT NULL,
        generation BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_audit (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        before_revision INTEGER,
        after_revision INTEGER NOT NULL,
        action TEXT NOT NULL,
        entity_refs JSONB NOT NULL,
        redacted_diff JSONB NOT NULL,
        actor TEXT NOT NULL,
        timestamp BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_config_audit_ns
        ON config_audit(namespace, timestamp);

      CREATE TABLE IF NOT EXISTS config_runtime_snapshots (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        file_digest TEXT,
        database_revision INTEGER NOT NULL,
        resolver_version INTEGER NOT NULL,
        sanitized_effective_config JSONB NOT NULL,
        content_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
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
        created_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        state TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
        ON admin_sessions(expires_at);
`;

/** Config-namespace steps; shared with the CLI migrate command (M17-M20). */
export const PG_CONFIG_STORE_MIGRATIONS: readonly MigrationStep[] = [
  pgConfigSqlStep("001_pg_config_initial", 0, 1, PG_CONFIG_STORE_SQL_001),
];

export function createPgConfigStoreMigrationPlan(): NamespaceMigrationPlan {
  return {
    namespace: CONFIG_STORE_NAMESPACE,
    targetVersion: CONFIG_STORE_SCHEMA_VERSION,
    steps: PG_CONFIG_STORE_MIGRATIONS,
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
  document: unknown;
  content_hash: string;
  file_digest: string | null;
  created_at: string | number;
  actor: string;
  operation_id: string;
}

interface HeadRow {
  namespace: string;
  active_revision: number;
  generation: string | number;
}

interface AuditRow {
  id: string;
  namespace: string;
  operation_id: string;
  before_revision: number | null;
  after_revision: number;
  action: string;
  entity_refs: unknown;
  redacted_diff: unknown;
  actor: string;
  timestamp: string | number;
}

interface SnapshotRow {
  id: string;
  namespace: string;
  file_digest: string | null;
  database_revision: number;
  resolver_version: number;
  sanitized_effective_config: unknown;
  content_hash: string;
  created_at: string | number;
  pinned: boolean;
  ref_count: number;
}

interface BindingRow {
  instance_id: string;
  definition_id: string;
  canonical_project_key: string;
  layout_version: number;
  relative_root: string;
  created_at: string | number;
  last_seen_at: string | number;
  state: string;
}

interface SessionRow {
  token_hash: string;
  created_at: string | number;
  expires_at: string | number;
}

function rowToRevision(row: RevisionRow): ConfigRevisionRecord {
  return {
    namespace: row.namespace,
    revision: Number(row.revision),
    parentRevision: row.parent_revision,
    formatVersion: Number(row.format_version),
    // JSONB comes back already parsed by the driver; a fresh object per read.
    document: row.document as ConfigRevisionRecord["document"],
    contentHash: row.content_hash,
    fileDigest: row.file_digest,
    createdAt: Number(row.created_at),
    actor: row.actor,
    operationId: row.operation_id,
  };
}

function rowToHead(row: HeadRow): ConfigHeadState {
  return {
    namespace: row.namespace,
    activeRevision: Number(row.active_revision),
    // int8 arrives as a string from the driver; keep the decimal text so u64
    // generations never pass through a float at the API boundary (S11).
    generation: String(row.generation),
  };
}

function rowToAudit(row: AuditRow): ConfigAuditRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    operationId: row.operation_id,
    beforeRevision: row.before_revision,
    afterRevision: Number(row.after_revision),
    action: row.action,
    entityRefs: row.entity_refs as string[],
    redactedDiff: row.redacted_diff,
    actor: row.actor,
    timestamp: Number(row.timestamp),
  };
}

function rowToSnapshot(row: SnapshotRow): ConfigRuntimeSnapshotRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    fileDigest: row.file_digest,
    databaseRevision: Number(row.database_revision),
    resolverVersion: Number(row.resolver_version),
    sanitizedEffectiveConfig: row.sanitized_effective_config,
    contentHash: row.content_hash,
    createdAt: Number(row.created_at),
    pinned: row.pinned,
    refCount: Number(row.ref_count),
  };
}

function rowToBinding(row: BindingRow): WorkspaceBindingRecord {
  return {
    instanceId: row.instance_id,
    definitionId: row.definition_id,
    canonicalProjectKey: row.canonical_project_key,
    layoutVersion: Number(row.layout_version),
    relativeRoot: row.relative_root,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    state: row.state as WorkspaceBindingState,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface PgConfigStoreOptions {
  readonly connection: {
    readonly url: string;
  };
  /**
   * Optional schema created (if absent) and pinned as every connection's
   * search_path; used by tests to isolate each store instance. Must be a
   * plain SQL identifier.
   */
  readonly schema?: string | undefined;
  /** Pool size ceiling; small by default (config traffic is low). */
  readonly maxPoolSize?: number | undefined;
  readonly now?: (() => number) | undefined;
  /** `auto` applies pending migrations at open (default); `verify` refuses when behind/drifted (M19). */
  readonly migrationMode?: "auto" | "verify" | undefined;
}

const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export async function createPgConfigStore(options: PgConfigStoreOptions): Promise<ConfigStore> {
  const schema = options.schema ?? null;
  if (schema !== null && !SCHEMA_NAME_PATTERN.test(schema)) {
    throw new ConfigError(
      "store_unavailable",
      `PostgreSQL config schema must be a plain identifier; got ${JSON.stringify(schema)}.`,
    );
  }
  const PgPool = await loadPg();
  const pool = new PgPool({
    connectionString: options.connection.url,
    max: options.maxPoolSize ?? 4,
    ...(schema !== null ? { options: `-c search_path="${schema}"` } : {}),
  });

  let closed = false;
  const open = (): void => assertStoreOpen(closed, "postgres");

  /** Maps driver/connection failures to bounded ConfigErrors; never swallows. */
  async function guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(
        "store_unavailable",
        `PostgreSQL config store ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  try {
    await guarded("connect", async () => {
      const client = await pool.connect();
      try {
        // Session-level advisory lock covers schema creation (auto mode)
        // plus the whole migration batch: CREATE SCHEMA IF NOT EXISTS races
        // two fresh processes on pg_namespace, and only one process may own
        // the upgrade (M04) — same pattern as packages/store/src/database.ts.
        await client.query(`SELECT pg_advisory_lock(${PG_CONFIG_MIGRATION_LOCK_KEY})`);
        try {
          // One dedicated client for the whole migration batch (M07): BEGIN →
          // advisory xact lock → in-lock ledger re-read → DDL + ledger → COMMIT.
          const runner = new MigrationRunner(
            createPgConfigMigrationStore(client),
            [createPgConfigStoreMigrationPlan()],
            { now: options.now },
          );
          if (options.migrationMode === "verify") {
            // Read-only gate: the runner probes the ledger (to_regclass) and
            // a missing schema/ledger computes as all-pending — this path
            // executes no CREATE of any kind.
            const check = await runner.check();
            if (check.needsMigration.length > 0) {
              throw new ConfigError(
                "migration_failed",
                `Config store schema is behind this program (pending namespaces: ${check.needsMigration.join(", ")}); run \`aicr migrate --apply\` or set storage.database.migrate=auto.`,
              );
            }
          } else {
            // Schema creation is an apply-time write; verify stays read-only.
            if (schema !== null) {
              await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
            }
            await runner.apply();
          }
        } finally {
          await client.query(`SELECT pg_advisory_unlock(${PG_CONFIG_MIGRATION_LOCK_KEY})`).catch(() => {});
        }
      } finally {
        client.release();
      }
    });
  } catch (error) {
    closed = true;
    await pool.end().catch(() => {});
    throw error;
  }

  async function queryRows<T extends QueryResultRow>(
    operation: string,
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return guarded(operation, () => pool.query<T>(text, params as unknown[]));
  }

  /**
   * One transaction on a single dedicated client for multi-statement atomic
   * mutations; any failure rolls back, the client always returns to the pool.
   */
  async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function readHeadRow(client: PoolClient, namespace: string): Promise<HeadRow | null> {
    const result = await client.query(
      "SELECT * FROM config_heads WHERE namespace = $1 FOR UPDATE",
      [namespace],
    );
    const row = result.rows[0] as HeadRow | undefined;
    return row === undefined ? null : row;
  }

  return {
    backendKind: "postgres",

    async readHead(namespace) {
      open();
      assertNamespace(namespace);
      const result = await queryRows<HeadRow>(
        "readHead",
        "SELECT * FROM config_heads WHERE namespace = $1",
        [namespace],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToHead(row);
    },

    async readRevision(namespace, revision) {
      open();
      assertNamespace(namespace);
      const result = await queryRows<RevisionRow>(
        "readRevision",
        "SELECT * FROM config_revisions WHERE namespace = $1 AND revision = $2",
        [namespace, revision],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToRevision(row);
    },

    async listRevisions(namespace, listOptions: ListRevisionsOptions = {}) {
      open();
      assertNamespace(namespace);
      const result = await queryRows<RevisionRow>(
        "listRevisions",
        `SELECT * FROM config_revisions
          WHERE namespace = $1 AND ($2::integer IS NULL OR revision < $2)
          ORDER BY revision DESC
          LIMIT $3`,
        [namespace, listOptions.before ?? null, listOptions.limit ?? 1000],
      );
      return result.rows.map(rowToRevision);
    },

    async readOperation(namespace, operationId) {
      open();
      assertNamespace(namespace);
      const result = await queryRows<RevisionRow>(
        "readOperation",
        "SELECT * FROM config_revisions WHERE namespace = $1 AND operation_id = $2",
        [namespace, operationId],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToRevision(row);
    },

    async commitChangeset(input: CommitChangesetInput) {
      open();
      assertNamespace(input.namespace);
      return guarded("commitChangeset", () =>
        withTx(async (client): Promise<CommitChangesetResult> => {
          // Serialize commits per namespace for the whole transaction so the
          // first-commit race (no head row to lock yet) cannot fork either.
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.namespace]);

          // Dedupe precedes base validation (S03): a retry carrying the
          // identical operationId returns the original committed revision.
          const existingResult = await client.query(
            "SELECT * FROM config_revisions WHERE namespace = $1 AND operation_id = $2",
            [input.namespace, input.operationId],
          );
          const existing = existingResult.rows[0] as RevisionRow | undefined;
          if (existing !== undefined) {
            if (sameConfigOperation(rowToRevision(existing), input)) {
              const head = await readHeadRow(client, input.namespace);
              if (head === null) {
                throw new ConfigError(
                  "store_unavailable",
                  `Revision "${input.operationId}" exists but namespace "${input.namespace}" has no head.`,
                );
              }
              return { status: "committed", revision: rowToRevision(existing), head: rowToHead(head), duplicate: true };
            }
            throw new ConfigError(
              "operation_conflict",
              `Operation "${input.operationId}" was already committed with different content (namespace "${input.namespace}").`,
            );
          }

          const headRow = await readHeadRow(client, input.namespace);
          const expectedBase = headRow === null ? null : Number(headRow.active_revision);
          if (input.baseRevision !== expectedBase) {
            return {
              status: "revision_conflict",
              head: headRow === null
                ? { namespace: input.namespace, activeRevision: 0, generation: "0" }
                : rowToHead(headRow),
            };
          }

          const revision = expectedBase === null ? 1 : expectedBase + 1;
          const insertedRevision = await client.query(
            `INSERT INTO config_revisions (
               namespace, revision, parent_revision, format_version, document, content_hash,
               file_digest, created_at, actor, operation_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
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
            ],
          );
          const insertedHead = await client.query(
            `INSERT INTO config_heads (namespace, active_revision, generation) VALUES ($1, $2, 1)
             ON CONFLICT(namespace) DO UPDATE SET active_revision = excluded.active_revision,
               generation = config_heads.generation + 1
             RETURNING *`,
            [input.namespace, revision],
          );
          // Audit commits atomically with the revision in this transaction (S06).
          await client.query(
            `INSERT INTO config_audit (
               id, namespace, operation_id, before_revision, after_revision, action,
               entity_refs, redacted_diff, actor, timestamp
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
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
            ],
          );
          return {
            status: "committed",
            revision: rowToRevision(insertedRevision.rows[0] as RevisionRow),
            head: rowToHead(insertedHead.rows[0] as HeadRow),
            duplicate: false,
          };
        }),
      );
    },

    async readAudit(namespace, readOptions: ListAuditOptions = {}) {
      open();
      assertNamespace(namespace);
      const result = await queryRows<AuditRow>(
        "readAudit",
        `SELECT * FROM config_audit
          WHERE namespace = $1
            AND ($2::text IS NULL OR operation_id = $2)
            AND ($3::bigint IS NULL OR timestamp < $3)
          ORDER BY timestamp DESC, id DESC
          LIMIT $4`,
        [
          namespace,
          readOptions.operationId ?? null,
          readOptions.beforeTimestamp ?? null,
          readOptions.limit ?? 1000,
        ],
      );
      return result.rows.map(rowToAudit);
    },

    async writeSnapshot(input: WriteSnapshotInput) {
      open();
      return guarded("writeSnapshot", async () => {
        // INSERT-first under ON CONFLICT (id) DO NOTHING: two racing writers
        // of the same id fold into one row instead of the loser dying on the
        // primary key; the loser re-reads and applies the idempotency
        // contract (config-store.ts writeSnapshot: identical content returns
        // the stored record, different content throws snapshot_invalid).
        for (;;) {
          const inserted = await pool.query(
            `INSERT INTO config_runtime_snapshots (
               id, namespace, file_digest, database_revision, resolver_version,
               sanitized_effective_config, content_hash, created_at, pinned, ref_count
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, 0)
             ON CONFLICT (id) DO NOTHING
             RETURNING *`,
            [
              input.id,
              input.namespace,
              input.fileDigest,
              input.databaseRevision,
              input.resolverVersion,
              JSON.stringify(input.sanitizedEffectiveConfig),
              input.contentHash,
              input.now,
            ],
          );
          const insertedRow = inserted.rows[0] as SnapshotRow | undefined;
          if (insertedRow !== undefined) return rowToSnapshot(insertedRow);
          const existingResult = await pool.query(
            "SELECT * FROM config_runtime_snapshots WHERE id = $1",
            [input.id],
          );
          const existing = existingResult.rows[0] as SnapshotRow | undefined;
          if (existing === undefined) continue; // a concurrent delete won the gap; retry the insert
          if (sameSnapshotContent(rowToSnapshot(existing), input)) return rowToSnapshot(existing);
          throw new ConfigError("snapshot_invalid", `Snapshot "${input.id}" already exists with different content.`);
        }
      });
    },

    async readSnapshot(id) {
      open();
      const result = await queryRows<SnapshotRow>(
        "readSnapshot",
        "SELECT * FROM config_runtime_snapshots WHERE id = $1",
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToSnapshot(row);
    },

    async adjustSnapshotRefCount(id, delta) {
      open();
      const result = await queryRows<SnapshotRow>(
        "adjustSnapshotRefCount",
        `UPDATE config_runtime_snapshots
            SET ref_count = GREATEST(0, ref_count + $2)
          WHERE id = $1
          RETURNING *`,
        [id, delta],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToSnapshot(row);
    },

    async setSnapshotPinned(id, pinned) {
      open();
      const result = await queryRows<SnapshotRow>(
        "setSnapshotPinned",
        "UPDATE config_runtime_snapshots SET pinned = $2 WHERE id = $1 RETURNING *",
        [id, pinned],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToSnapshot(row);
    },

    async listUnreferencedSnapshots(namespace, olderThan, limit = 100) {
      open();
      assertNamespace(namespace);
      const result = await queryRows<SnapshotRow>(
        "listUnreferencedSnapshots",
        `SELECT * FROM config_runtime_snapshots
          WHERE namespace = $1 AND pinned = FALSE AND ref_count = 0 AND created_at <= $2
          ORDER BY created_at ASC
          LIMIT $3`,
        [namespace, olderThan, limit],
      );
      return result.rows.map(rowToSnapshot);
    },

    async deleteSnapshot(id) {
      open();
      return guarded("deleteSnapshot", async () => {
        // Single atomic conditional delete (spec §7.2): a ref-count landing
        // between a check-then-delete pair can no longer orphan a signed-out
        // task's snapshot. The follow-up SELECT only classifies the miss:
        // row gone = idempotent no-op, row present = still referenced.
        const deleted = await pool.query(
          "DELETE FROM config_runtime_snapshots WHERE id = $1 AND pinned = FALSE AND ref_count = 0",
          [id],
        );
        if ((deleted.rowCount ?? 0) > 0) return;
        const existingResult = await pool.query(
          "SELECT pinned, ref_count FROM config_runtime_snapshots WHERE id = $1",
          [id],
        );
        const existing = existingResult.rows[0] as { pinned: boolean; ref_count: number } | undefined;
        if (existing === undefined) return;
        throw new ConfigError("snapshot_invalid", `Snapshot "${id}" is still referenced and cannot be deleted.`);
      });
    },

    async upsertWorkspaceBinding(input: UpsertBindingInput) {
      open();
      return guarded("upsertWorkspaceBinding", () =>
        withTx(async (client): Promise<WorkspaceBindingRecord> => {
          const existingResult = await client.query(
            "SELECT * FROM workspace_bindings WHERE instance_id = $1 FOR UPDATE",
            [input.instanceId],
          );
          const existing = existingResult.rows[0] as BindingRow | undefined;
          if (existing !== undefined) {
            if (existing.relative_root !== input.relativeRoot) {
              throw new ConfigError(
                "binding_conflict",
                `Binding "${input.instanceId}" already owns root "${existing.relative_root}".`,
              );
            }
            const updated = await client.query(
              `UPDATE workspace_bindings
                  SET definition_id = $2, canonical_project_key = $3, layout_version = $4, last_seen_at = $5
                WHERE instance_id = $1
                RETURNING *`,
              [input.instanceId, input.definitionId, input.canonicalProjectKey, input.layoutVersion, input.now],
            );
            return rowToBinding(updated.rows[0] as BindingRow);
          }
          const ownerResult = await client.query(
            "SELECT * FROM workspace_bindings WHERE relative_root = $1",
            [input.relativeRoot],
          );
          const owner = ownerResult.rows[0] as BindingRow | undefined;
          if (owner !== undefined) {
            throw new ConfigError(
              "binding_conflict",
              `Root "${input.relativeRoot}" is already owned by binding "${owner.instance_id}" (S08).`,
            );
          }
          const inserted = await client.query(
            `INSERT INTO workspace_bindings (
               instance_id, definition_id, canonical_project_key, layout_version,
               relative_root, created_at, last_seen_at, state
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
             RETURNING *`,
            [
              input.instanceId,
              input.definitionId,
              input.canonicalProjectKey,
              input.layoutVersion,
              input.relativeRoot,
              input.now,
              input.now,
            ],
          );
          return rowToBinding(inserted.rows[0] as BindingRow);
        }),
      );
    },

    async readWorkspaceBinding(instanceId) {
      open();
      const result = await queryRows<BindingRow>(
        "readWorkspaceBinding",
        "SELECT * FROM workspace_bindings WHERE instance_id = $1",
        [instanceId],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToBinding(row);
    },

    async listWorkspaceBindings(_namespace) {
      open();
      const result = await queryRows<BindingRow>(
        "listWorkspaceBindings",
        "SELECT * FROM workspace_bindings ORDER BY created_at ASC",
      );
      return result.rows.map(rowToBinding);
    },

    async setWorkspaceBindingState(instanceId, state, now) {
      open();
      const result = await queryRows<BindingRow>(
        "setWorkspaceBindingState",
        "UPDATE workspace_bindings SET state = $2, last_seen_at = $3 WHERE instance_id = $1 RETURNING *",
        [instanceId, state, now],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToBinding(row);
    },

    async saveAdminSession(record: AdminSessionRecord) {
      open();
      await queryRows(
        "saveAdminSession",
        `INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT(token_hash) DO UPDATE SET created_at = excluded.created_at, expires_at = excluded.expires_at`,
        [record.tokenHash, record.createdAt, record.expiresAt],
      );
    },

    async readAdminSession(tokenHash, now) {
      open();
      const result = await queryRows<SessionRow>(
        "readAdminSession",
        "SELECT * FROM admin_sessions WHERE token_hash = $1",
        [tokenHash],
      );
      const row = result.rows[0];
      if (row === undefined || Number(row.expires_at) <= now) return null;
      return {
        tokenHash: row.token_hash,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
      };
    },

    async deleteAdminSession(tokenHash) {
      open();
      await queryRows(
        "deleteAdminSession",
        "DELETE FROM admin_sessions WHERE token_hash = $1",
        [tokenHash],
      );
    },

    async deleteExpiredAdminSessions(now, limit = 500) {
      open();
      const result = await queryRows(
        "deleteExpiredAdminSessions",
        `DELETE FROM admin_sessions WHERE token_hash IN (
           SELECT token_hash FROM admin_sessions WHERE expires_at <= $1 LIMIT $2
         )`,
        [now, limit],
      );
      return result.rowCount ?? 0;
    },

    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
