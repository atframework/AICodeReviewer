import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type BetterSqlite3 from "better-sqlite3";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

export interface StoreDb {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: BetterSqlite3.Database;
}

export function createStoreDb(dbPath: string): StoreDb {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const sqlite = new Database(dbPath);

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });

  runMigrations(sqlite);

  return { db, sqlite };
}

export function closeStoreDb(store: StoreDb): void {
  store.sqlite.close();
}

function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);

  const applied = new Set(
    sqlite
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((row: unknown) => (row as Record<string, string>).name),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    sqlite.exec(migration.sql);
    sqlite.prepare("INSERT INTO _migrations (name) VALUES (?)").run(migration.name);
  }
}

const MIGRATIONS = [
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
];
