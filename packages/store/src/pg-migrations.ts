/**
 * PostgreSQL migration plan for the store namespace (spec §9.3, matrix
 * M01/M04/M06/M16). The nine steps are field-level translations of the
 * SQLite MIGRATIONS 001-009 in database.ts; differences are limited to the
 * dialect (identity columns, bigint epoch-ms timestamps, native boolean,
 * double precision, GREATEST-compatible types).
 *
 * Execution rides the shared MigrationRunner contract (@aicr/core) with the
 * `schema_migrations` ledger (namespace "store"): every apply batch runs in
 * one transaction guarded by pg_advisory_xact_lock, the ledger is re-read
 * inside the lock (M04), a crash rolls the whole batch back so a restart
 * retries cleanly (M06), and checksum drift or an unknown higher version
 * refuses startup with schema_version_unsupported (M16).
 */

import { createHash } from "node:crypto";
import { PG_CONFIG_MIGRATION_LOCK_KEY } from "@aicr/core";

import type {
  AppliedMigration,
  MigrationStep,
  MigrationStore,
  NamespaceMigrationPlan,
} from "@aicr/core";

/**
 * Transaction-scoped advisory lock key serializing store migrations across
 * processes. Arbitrary constant; must match every program that migrates the
 * store namespace ("aicr" as big-endian ASCII, kept under int4 range).
 */
export const STORE_MIGRATION_LOCK_KEY = PG_CONFIG_MIGRATION_LOCK_KEY;

export const STORE_MIGRATION_NAMESPACE = "store";

/** Minimal async client shape the executor relies on (pg.PoolClient). */
export interface PgMigrationClient {
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
export function pgSqlStep(id: string, fromVersion: number, toVersion: number, sql: string, description?: string): MigrationStep {
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
    throw new Error(`postgres migration store cannot apply non-SQL step "${step.id}"`);
  }
  return payload.sql;
}

/**
 * node-postgres executor for the MigrationRunner contract. Every apply batch
 * runs in one transaction on a single dedicated client (never interleaved
 * pool queries): BEGIN → pg_advisory_xact_lock → DDL + ledger writes →
 * COMMIT; any failure rolls the whole batch back (M06).
 */
export function createPgMigrationStore(client: PgMigrationClient): MigrationStore {
  return {
    backendKind: "postgres",

    async ledgerExists() {
      const result = await client.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS exists");
      return result.rows[0]?.exists === true;
    },

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

    async withMigrationLock(fn) {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT pg_advisory_xact_lock(${STORE_MIGRATION_LOCK_KEY})`);
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

const MIGRATION_001_INITIAL = `
CREATE TABLE IF NOT EXISTS projects (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  workspace_id text NOT NULL,
  trigger_name text NOT NULL,
  repo_ref text NOT NULL,
  display_name text,
  created_at bigint NOT NULL,
  deleted_at bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_identity
  ON projects(workspace_id, trigger_name, repo_ref)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS review_runs (
  id text PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  workspace_id text NOT NULL,
  trigger_name text,
  provider text,
  provider_model text,
  status text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  started_at bigint,
  finished_at bigint,
  cost_usd double precision,
  tokens_in integer,
  tokens_out integer,
  error text,
  skip_reason text,
  compressed boolean,
  original_token_estimate integer,
  compressed_token_estimate integer,
  diff_file_count integer,
  changed_file_count integer,
  problem_count integer NOT NULL DEFAULT 0,
  summary_count integer NOT NULL DEFAULT 0,
  dispatch_count integer NOT NULL DEFAULT 0,
  duration_ms integer,
  target_kind text,
  target_url text,
  branch text,
  head_sha text
);

CREATE INDEX IF NOT EXISTS idx_review_runs_project
  ON review_runs(project_id);

CREATE INDEX IF NOT EXISTS idx_review_runs_started
  ON review_runs(started_at);

CREATE INDEX IF NOT EXISTS idx_review_runs_status
  ON review_runs(status);

CREATE TABLE IF NOT EXISTS code_metrics (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  run_id text NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  files_changed integer NOT NULL DEFAULT 0,
  lines_added integer NOT NULL DEFAULT 0,
  lines_deleted integer NOT NULL DEFAULT 0,
  bytes_analyzed integer NOT NULL DEFAULT 0,
  files_analyzed integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  run_id text NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  request_count integer NOT NULL DEFAULT 1,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  tokens_total integer NOT NULL DEFAULT 0,
  cost_usd double precision,
  retry_count integer NOT NULL DEFAULT 0,
  fallback_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  latency_ms integer
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_provider_model
  ON llm_usage(provider_id, model_id);

CREATE TABLE IF NOT EXISTS output_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  run_id text NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  channel_kind text NOT NULL,
  event_type text NOT NULL,
  issue_created boolean NOT NULL DEFAULT false,
  comment_created boolean NOT NULL DEFAULT false,
  "timestamp" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_output_events_timestamp
  ON output_events("timestamp");

CREATE TABLE IF NOT EXISTS daily_rollups (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date text NOT NULL,
  review_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  skip_count integer NOT NULL DEFAULT 0,
  problem_run_count integer NOT NULL DEFAULT 0,
  problem_total integer NOT NULL DEFAULT 0,
  issue_created_count integer NOT NULL DEFAULT 0,
  files_changed integer NOT NULL DEFAULT 0,
  lines_added integer NOT NULL DEFAULT 0,
  lines_deleted integer NOT NULL DEFAULT 0,
  bytes_analyzed integer NOT NULL DEFAULT 0,
  llm_request_count integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  tokens_total integer NOT NULL DEFAULT 0,
  cost_usd double precision
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_rollups_project_date
  ON daily_rollups(project_id, date);
`;

const MIGRATION_002_REFLECTION_MEMORY = `
CREATE TABLE IF NOT EXISTS reflection_memory (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  workspace_id text NOT NULL,
  fingerprint text NOT NULL,
  content text NOT NULL,
  source_run_id text,
  created_at bigint NOT NULL,
  expires_at bigint
);

CREATE INDEX IF NOT EXISTS idx_reflection_memory_workspace
  ON reflection_memory(workspace_id);

CREATE INDEX IF NOT EXISTS idx_reflection_memory_expires
  ON reflection_memory(expires_at)
  WHERE expires_at IS NOT NULL;
`;

const MIGRATION_003_MODEL_CATALOG = `
CREATE TABLE IF NOT EXISTS model_catalog (
  catalog_id text PRIMARY KEY,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  data text NOT NULL,
  source text,
  fetched_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_catalog_provider_model
  ON model_catalog(provider_id, model_id);

CREATE INDEX IF NOT EXISTS idx_model_catalog_model
  ON model_catalog(model_id);

CREATE TABLE IF NOT EXISTS model_catalog_source (
  source_url text PRIMARY KEY,
  last_refreshed_at bigint NOT NULL,
  etag text
);
`;

const MIGRATION_004_REFLECTION_OCCURRENCE = `
ALTER TABLE reflection_memory ADD COLUMN occurrence_count integer NOT NULL DEFAULT 1;
`;

const MIGRATION_005_REVIEW_RUN_PROMPT_ESTIMATE = `
ALTER TABLE review_runs ADD COLUMN prompt_token_estimate integer;
`;

const MIGRATION_006_LLM_USAGE_CACHE_TOKENS = `
ALTER TABLE llm_usage ADD COLUMN cached_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE llm_usage ADD COLUMN cache_creation_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE daily_rollups ADD COLUMN cached_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE daily_rollups ADD COLUMN cache_creation_tokens integer NOT NULL DEFAULT 0;
`;

const MIGRATION_007_WEBHOOK_EVENTS = `
CREATE TABLE IF NOT EXISTS webhook_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  received_at bigint NOT NULL,
  provider text,
  event_name text,
  workspace_id text,
  trigger_name text,
  repo_ref text,
  target_kind text,
  target_url text,
  branch text,
  decision text NOT NULL,
  reason text,
  detail text
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received
  ON webhook_events(received_at);
`;

const MIGRATION_008_REVIEW_DEFERRALS = `
CREATE TABLE IF NOT EXISTS review_deferrals (
  dedup_key text PRIMARY KEY,
  workspace_id text NOT NULL,
  provider text NOT NULL,
  event_name text NOT NULL,
  review_event text NOT NULL,
  payload text,
  not_before bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_deferrals_due
  ON review_deferrals(status, not_before);
`;

const MIGRATION_009_REVIEW_RUN_VCS_STAMP = `
ALTER TABLE review_runs ADD COLUMN vcs_kind text;
ALTER TABLE review_runs ADD COLUMN head_committed_at bigint;
`;

export const STORE_MIGRATION_STEPS: readonly MigrationStep[] = [
  pgSqlStep("001_initial", 0, 1, MIGRATION_001_INITIAL),
  pgSqlStep("002_reflection_memory", 1, 2, MIGRATION_002_REFLECTION_MEMORY),
  pgSqlStep("003_model_catalog", 2, 3, MIGRATION_003_MODEL_CATALOG),
  pgSqlStep("004_reflection_occurrence", 3, 4, MIGRATION_004_REFLECTION_OCCURRENCE),
  pgSqlStep("005_review_run_prompt_estimate", 4, 5, MIGRATION_005_REVIEW_RUN_PROMPT_ESTIMATE),
  pgSqlStep("006_llm_usage_cache_tokens", 5, 6, MIGRATION_006_LLM_USAGE_CACHE_TOKENS),
  pgSqlStep("007_webhook_events", 6, 7, MIGRATION_007_WEBHOOK_EVENTS),
  pgSqlStep("008_review_deferrals", 7, 8, MIGRATION_008_REVIEW_DEFERRALS),
  pgSqlStep("009_review_run_vcs_stamp", 8, 9, MIGRATION_009_REVIEW_RUN_VCS_STAMP),
];

export const STORE_MIGRATION_PLAN: NamespaceMigrationPlan = {
  namespace: STORE_MIGRATION_NAMESPACE,
  targetVersion: 9,
  steps: STORE_MIGRATION_STEPS,
};
