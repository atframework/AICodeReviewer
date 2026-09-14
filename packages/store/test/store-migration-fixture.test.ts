/**
 * M02 fixture: a database built with the REAL historical 001–006 DDL (the
 * frozen prefix of STORE_SQLITE_MIGRATIONS, byte-identical to the pre-007
 * commit) plus its `_migrations` ledger rows and seeded business data.
 * Opening it with current code must apply only 007–009, preserve every old
 * row, and accept the config namespace tables alongside (spec §9 M02:
 * "先核验真实旧账本，再添加 config/binding/session/audit 表和业务升级").
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteConfigStore } from "@aicr/core";

import { closeStoreDb, createStoreDb, STORE_SQLITE_MIGRATIONS, type SqliteStoreDb } from "../src/database.js";
import { getProjectStats, getRecentRuns, insertReviewRun } from "../src/stats.js";

const require = createRequire(import.meta.url);
interface BetterSqlite3Ctor {
  new (path: string): {
    exec(sql: string): unknown;
    prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
    close(): void;
  };
}
const Database = require("better-sqlite3") as BetterSqlite3Ctor;

const HISTORICAL_STEPS = STORE_SQLITE_MIGRATIONS.slice(0, 6);
const LATER_STEPS = STORE_SQLITE_MIGRATIONS.slice(6);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "aicr-store-m02-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function buildHistoricalDb(path: string): void {
  expect(HISTORICAL_STEPS.map((step) => step.name)).toEqual([
    "001_initial",
    "002_reflection_memory",
    "003_model_catalog",
    "004_reflection_occurrence",
    "005_review_run_prompt_estimate",
    "006_llm_usage_cache_tokens",
  ]);
  expect(LATER_STEPS.length).toBeGreaterThan(0);

  const sqlite = new Database(path);
  sqlite.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));`);
  const mark = sqlite.prepare("INSERT INTO _migrations (name) VALUES (?)");
  for (const step of HISTORICAL_STEPS) {
    sqlite.exec(step.sql);
    mark.run(step.name);
  }

  // Seed business data in the 001-era shape (no vcs_kind/head_committed_at).
  sqlite.prepare(
    `INSERT INTO projects (workspace_id, trigger_name, repo_ref, display_name, created_at)
     VALUES ('ws-legacy', 'gitea', 'owner/legacy', 'Legacy project', 1700000000000)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO review_runs (id, project_id, event_id, workspace_id, trigger_name, provider, provider_model,
       status, attempt, started_at, finished_at, tokens_in, tokens_out, branch, head_sha)
     VALUES ('legacy-run', 1, 'evt-1', 'ws-legacy', 'gitea', 'openai', 'gpt-x',
       'succeeded', 1, 1700000001000, 1700000005000, 111, 22, 'main', 'legacy-sha')`,
  ).run();
  sqlite.close();
}

describe("store migration from a real 001–006 ledger (M02)", () => {
  it("applies only the post-006 steps, preserves business rows, and hosts the config namespace", async () => {
    const dbPath = join(tmpDir, "legacy.db");
    buildHistoricalDb(dbPath);

    const store: SqliteStoreDb = createStoreDb(dbPath);
    try {
      // Only 007+ ran on open; historical rows were not replayed.
      const applied = store.sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[];
      expect(applied.map((row) => row.name)).toEqual(STORE_SQLITE_MIGRATIONS.map((step) => step.name));

      // Business data survived intact and is readable through the current API.
      const projects = await getProjectStats(store);
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({ workspaceId: "ws-legacy", repoRef: "owner/legacy" });
      const runs = await getRecentRuns(store, 5);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        id: "legacy-run",
        branch: "main",
        headSha: "legacy-sha",
        vcsKind: null,
        headCommittedAt: null,
      });
    } finally {
      await closeStoreDb(store);
    }

    // The config namespace appends its tables to the same file without
    // touching the legacy ledger or business rows.
    const configStore = await createSqliteConfigStore({ path: dbPath });
    try {
      expect(await configStore.readHead("default")).toBeNull();
      const probe = new Database(dbPath);
      const tables = (probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%config%' OR name IN ('workspace_bindings', 'admin_sessions', 'schema_migrations')) ORDER BY name")
        .all() as { name: string }[]).map((row) => row.name);
      probe.close();
      expect(tables).toEqual([
        "admin_sessions",
        "config_audit",
        "config_heads",
        "config_revisions",
        "config_runtime_snapshots",
        "config_runtime_state",
        "schema_migrations",
        "workspace_bindings",
      ]);
    } finally {
      await configStore.close();
    }

    // Reopening the store afterwards is a no-op for both ledgers.
    const store2 = createStoreDb(dbPath);
    try {
      expect((await getRecentRuns(store2, 5)).map((run) => run.id)).toEqual(["legacy-run"]);
      const count = store2.sqlite.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number };
      expect(count.n).toBe(STORE_SQLITE_MIGRATIONS.length);
    } finally {
      await closeStoreDb(store2);
    }
  });

  it("accepts a new 009-era row through the current API without disturbing legacy rows (G3)", async () => {
    const dbPath = join(tmpDir, "legacy.db");
    buildHistoricalDb(dbPath);

    const store: SqliteStoreDb = createStoreDb(dbPath);
    try {
      // After the upgrade, the current API writes the vcs columns the 009
      // step added; the legacy row predates them and must stay untouched.
      await insertReviewRun(store, {
        id: "new-run",
        eventId: "evt-2",
        workspaceId: "ws-legacy",
        triggerName: "gitea",
        repoRef: "owner/legacy",
        provider: "openai",
        providerModel: "gpt-x",
        status: "succeeded",
        startedAt: new Date(1700000010000),
        finishedAt: new Date(1700000015000),
        tokensIn: 5,
        tokensOut: 6,
        branch: "main",
        headSha: "new-sha",
        vcsKind: "git",
        headCommittedAt: new Date(1700000009000),
      });

      const count = store.sqlite.prepare("SELECT COUNT(*) AS n FROM review_runs").get() as { n: number };
      expect(count.n).toBe(2);

      const runs = await getRecentRuns(store, 5);
      expect(runs).toHaveLength(2);
      const inserted = runs.find((run) => run.id === "new-run");
      expect(inserted).toMatchObject({ branch: "main", headSha: "new-sha", vcsKind: "git" });
      expect(inserted?.headCommittedAt?.getTime()).toBe(1700000009000);

      // Legacy row: counters and the 009-era nulls are exactly as seeded.
      const legacy = runs.find((run) => run.id === "legacy-run");
      expect(legacy).toMatchObject({ headSha: "legacy-sha", vcsKind: null, headCommittedAt: null });
      const legacyRow = store.sqlite
        .prepare("SELECT tokens_in, tokens_out FROM review_runs WHERE id = 'legacy-run'")
        .get() as { tokens_in: number; tokens_out: number };
      expect(legacyRow).toEqual({ tokens_in: 111, tokens_out: 22 });
    } finally {
      await closeStoreDb(store);
    }
  });
});
