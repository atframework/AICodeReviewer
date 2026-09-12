import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type BetterSqlite3 from "better-sqlite3";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { ConfigError, MigrationRunner } from "@aicr/core";

import * as schema from "./schema.js";
import * as pgSchema from "./schema.pg.js";
import { createPgMigrationStore, STORE_MIGRATION_LOCK_KEY, STORE_MIGRATION_PLAN } from "./pg-migrations.js";

export interface SqliteStoreDb {
  readonly kind: "sqlite";
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly sqlite: BetterSqlite3.Database;
}

export interface PgStoreDb {
  readonly kind: "postgres";
  readonly db: NodePgDatabase<typeof pgSchema>;
  readonly pool: pg.Pool;
}

/**
 * Dual-backend store handle. Every consumer function dispatches on `kind`:
 * the sqlite branch keeps the historical synchronous better-sqlite3 behavior
 * under an async wrapper, the postgres branch runs equivalent drizzle
 * node-postgres queries against the pool.
 */
export type StoreDb = SqliteStoreDb | PgStoreDb;

export type StoreDbConfig =
  | { readonly kind: "sqlite"; readonly path: string; readonly migrationMode?: "auto" | "verify" }
  | {
      readonly kind: "postgres";
      readonly url: string;
      /** Database schema to create/search; defaults to the connection default. */
      readonly schema?: string;
      /** Pool size; small by default, the store is dashboard-grade traffic. */
      readonly poolSize?: number;
      readonly migrationMode?: "auto" | "verify";
    };

export function createStoreDb(dbPath: string): SqliteStoreDb;
export function createStoreDb(config: { readonly kind: "sqlite"; readonly path: string; readonly migrationMode?: "auto" | "verify" }): SqliteStoreDb;
export function createStoreDb(config: {
  readonly kind: "postgres";
  readonly url: string;
  readonly schema?: string;
  readonly poolSize?: number;
  readonly migrationMode?: "auto" | "verify";
}): Promise<PgStoreDb>;
export function createStoreDb(config: string | StoreDbConfig): SqliteStoreDb | Promise<PgStoreDb> {
  if (typeof config === "string" || config.kind === "sqlite") {
    return createSqliteStoreDb(typeof config === "string" ? config : config.path, typeof config === "string" ? "auto" : config.migrationMode);
  }
  return createPostgresStoreDb(config);
}

export async function closeStoreDb(store: StoreDb): Promise<void> {
  if (store.kind === "postgres") {
    await store.pool.end();
    return;
  }
  store.sqlite.close();
}

function createSqliteStoreDb(dbPath: string, migrationMode: "auto" | "verify" = "auto"): SqliteStoreDb {
  if (migrationMode === "verify") {
    if (!existsSync(dbPath)) throw new ConfigError("migration_failed", "Store database does not exist; apply migrations before verify startup.");
    const probe = new Database(dbPath, { readonly: true });
    try { verifySqliteStoreMigrations(probe); } finally { probe.close(); }
  }
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const sqlite = new Database(dbPath);

  try {
    readSqliteStoreMigrationPrefix(sqlite);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("synchronous = NORMAL");
    if (migrationMode === "auto") runMigrations(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return { kind: "sqlite", db: drizzleSqlite(sqlite, { schema }), sqlite };
}

const PG_SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function createPostgresStoreDb(config: {
  readonly url: string;
  readonly schema?: string;
  readonly poolSize?: number;
  readonly migrationMode?: "auto" | "verify";
}): Promise<PgStoreDb> {
  if (config.schema !== undefined && !PG_SCHEMA_NAME_PATTERN.test(config.schema)) {
    throw new ConfigError(
      "store_unavailable",
      `Invalid PostgreSQL schema name "${config.schema}"; expected a plain identifier.`,
    );
  }

  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolSize ?? 4,
    // Startup option so every pooled client resolves unqualified names into
    // the configured schema (test isolation and non-public deployments).
    ...(config.schema !== undefined ? { options: `-c search_path="${config.schema}"` } : {}),
  });
  try {
    const client = await pool.connect();
    try {
      // Session-level lock covers schema creation plus the whole migration
      // batch: CREATE SCHEMA IF NOT EXISTS races two fresh databases on
      // pg_namespace, and only one process may own the upgrade (M04).
      await client.query(`SELECT pg_advisory_lock(${STORE_MIGRATION_LOCK_KEY})`);
      try {
        if (config.schema !== undefined && config.migrationMode !== "verify") {
          await client.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
        }
        const runner = new MigrationRunner(createPgMigrationStore(client), [STORE_MIGRATION_PLAN]);
        if (config.migrationMode === "verify") {
          const check = await runner.check();
          if (check.needsMigration.length > 0) throw new ConfigError("migration_failed", "Store schema is behind this program; apply migrations before verify startup.");
        } else {
          await runner.apply();
        }
      } finally {
        await client.query(`SELECT pg_advisory_unlock(${STORE_MIGRATION_LOCK_KEY})`).catch(() => {});
      }
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end().catch(() => {});
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(
      "store_unavailable",
      `PostgreSQL store unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { kind: "postgres", db: drizzlePg(pool, { schema: pgSchema }), pool };
}

function runMigrations(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
    const applied = readSqliteStoreMigrationPrefix(sqlite);
    for (const migration of STORE_SQLITE_MIGRATIONS) {
      if (applied.has(migration.name)) continue;
      sqlite.exec(migration.sql);
      sqlite.prepare("INSERT INTO _migrations (name) VALUES (?)").run(migration.name);
    }
  }).immediate();
}

/** The historical name-only ledger must still be a known contiguous prefix. */
function readSqliteStoreMigrationPrefix(sqlite: Database.Database): Set<string> {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations'").get();
  const names = exists ? (sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[]).map((row) => row.name) : [];
  const known = STORE_SQLITE_MIGRATIONS.map((step) => step.name);
  if (names.some((name, index) => name !== known[index])) throw new ConfigError("schema_version_unsupported", "Store migration ledger is unknown or not a contiguous prefix.");
  return new Set(names);
}

export function verifySqliteStoreMigrations(sqlite: Database.Database): void {
  if (readSqliteStoreMigrationPrefix(sqlite).size !== STORE_SQLITE_MIGRATIONS.length) throw new ConfigError("migration_failed", "Store schema is behind this program; apply migrations before verify startup.");
}

/**
 * Append-only sqlite store migrations. Historical steps (001–006) are frozen:
 * their DDL text is the M02 fixture baseline — never edit a shipped step,
 * only append. Verified byte-identical against the pre-007 commit.
 */
export const STORE_SQLITE_MIGRATIONS = [
  {
    name: "001_initial",
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        trigger_name TEXT NOT NULL,
        repo_ref TEXT NOT NULL,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_identity
        ON projects(workspace_id, trigger_name, repo_ref)
        WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS review_runs (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        trigger_name TEXT,
        provider TEXT,
        provider_model TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER,
        finished_at INTEGER,
        cost_usd REAL,
        tokens_in INTEGER,
        tokens_out INTEGER,
        error TEXT,
        skip_reason TEXT,
        compressed INTEGER,
        original_token_estimate INTEGER,
        compressed_token_estimate INTEGER,
        diff_file_count INTEGER,
        changed_file_count INTEGER,
        problem_count INTEGER NOT NULL DEFAULT 0,
        summary_count INTEGER NOT NULL DEFAULT 0,
        dispatch_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        target_kind TEXT,
        target_url TEXT,
        branch TEXT,
        head_sha TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_review_runs_project
        ON review_runs(project_id);

      CREATE INDEX IF NOT EXISTS idx_review_runs_started
        ON review_runs(started_at);

      CREATE INDEX IF NOT EXISTS idx_review_runs_status
        ON review_runs(status);

      CREATE TABLE IF NOT EXISTS code_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
        files_changed INTEGER NOT NULL DEFAULT 0,
        lines_added INTEGER NOT NULL DEFAULT 0,
        lines_deleted INTEGER NOT NULL DEFAULT 0,
        bytes_analyzed INTEGER NOT NULL DEFAULT 0,
        files_analyzed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS llm_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 1,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        fallback_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_llm_usage_provider_model
        ON llm_usage(provider_id, model_id);

      CREATE TABLE IF NOT EXISTS output_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
        channel_kind TEXT NOT NULL,
        event_type TEXT NOT NULL,
        issue_created INTEGER NOT NULL DEFAULT 0,
        comment_created INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_output_events_timestamp
        ON output_events(timestamp);

      CREATE TABLE IF NOT EXISTS daily_rollups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        review_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        skip_count INTEGER NOT NULL DEFAULT 0,
        problem_run_count INTEGER NOT NULL DEFAULT 0,
        problem_total INTEGER NOT NULL DEFAULT 0,
        issue_created_count INTEGER NOT NULL DEFAULT 0,
        files_changed INTEGER NOT NULL DEFAULT 0,
        lines_added INTEGER NOT NULL DEFAULT 0,
        lines_deleted INTEGER NOT NULL DEFAULT 0,
        bytes_analyzed INTEGER NOT NULL DEFAULT 0,
        llm_request_count INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_rollups_project_date
        ON daily_rollups(project_id, date);
    `,
  },
  {
    name: "002_reflection_memory",
    sql: `
      CREATE TABLE IF NOT EXISTS reflection_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        content TEXT NOT NULL,
        source_run_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_reflection_memory_workspace
        ON reflection_memory(workspace_id);

      CREATE INDEX IF NOT EXISTS idx_reflection_memory_expires
        ON reflection_memory(expires_at)
        WHERE expires_at IS NOT NULL;
    `,
  },
  {
    name: "003_model_catalog",
    sql: `
      CREATE TABLE IF NOT EXISTS model_catalog (
        catalog_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        data TEXT NOT NULL,
        source TEXT,
        fetched_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_model_catalog_provider_model
        ON model_catalog(provider_id, model_id);

      CREATE INDEX IF NOT EXISTS idx_model_catalog_model
        ON model_catalog(model_id);

      CREATE TABLE IF NOT EXISTS model_catalog_source (
        source_url TEXT PRIMARY KEY,
        last_refreshed_at INTEGER NOT NULL,
        etag TEXT
      );
    `,
  },
  {
    name: "004_reflection_occurrence",
    sql: `
      ALTER TABLE reflection_memory ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    // Persist the local prompt token estimate per run so the dashboard can surface it
    // alongside real LLM usage. Real provider-reported usage lives in llm_usage; this column
    // is the fallback signal shown when agent runs cannot report real tokens.
    name: "005_review_run_prompt_estimate",
    sql: `
      ALTER TABLE review_runs ADD COLUMN prompt_token_estimate INTEGER;
    `,
  },
  {
    // Provider-reported prompt cache split. cached_tokens = cache-hit input tokens,
    // cache_creation_tokens = cache-write input tokens (Anthropic cache creation, kilo
    // cache.write); both are already included in tokens_in, so non-cached input =
    // tokens_in - cached_tokens - cache_creation_tokens and the dashboard hit rate is
    // cached_tokens / tokens_in. daily_rollups gets the same columns so the pre-aggregated
    // cache stays a faithful rollup of the raw signal.
    name: "006_llm_usage_cache_tokens",
    sql: `
      ALTER TABLE llm_usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE llm_usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE daily_rollups ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE daily_rollups ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Append-only log of received webhook/trigger events with the receipt-time
    // decision (executed/deferred/queued/duplicate/deduplicated/ignored/rejected).
    // Not part of daily rollups; retention is capped by pruneWebhookEvents.
    name: "007_webhook_events",
    sql: `
      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at INTEGER NOT NULL,
        provider TEXT,
        event_name TEXT,
        workspace_id TEXT,
        trigger_name TEXT,
        repo_ref TEXT,
        target_kind TEXT,
        target_url TEXT,
        branch TEXT,
        decision TEXT NOT NULL,
        reason TEXT,
        detail TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_events_received
        ON webhook_events(received_at);
    `,
  },
  {
    // Execution-window deferrals for the async trigger path (PR/MR, issue,
    // comment flows). One row per dedup target; the latest event replaces the
    // stored envelope while `not_before` never moves earlier. `claimed` rows
    // are reset to `pending` on startup so a restart cannot strand a deferral.
    name: "008_review_deferrals",
    sql: `
      CREATE TABLE IF NOT EXISTS review_deferrals (
        dedup_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        event_name TEXT NOT NULL,
        review_event TEXT NOT NULL,
        payload TEXT,
        not_before INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_deferrals_due
        ON review_deferrals(status, not_before);
    `,
  },
  {
    // VCS stamp of the analyzed head revision for the dashboard Recent Runs /
    // Recent Activity panels: the VCS family (git/svn/p4, drives revision
    // formatting) and the head commit time resolved best-effort at run time
    // (null when the adapter could not read it). Both are display-only and
    // never feed rollups.
    name: "009_review_run_vcs_stamp",
    sql: `
      ALTER TABLE review_runs ADD COLUMN vcs_kind TEXT;
      ALTER TABLE review_runs ADD COLUMN head_committed_at INTEGER;
    `,
  },
];
