import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { isConfigError } from "@aicr/core";

import { createStoreDb, closeStoreDb, type PgStoreDb } from "../src/database.js";
import {
  insertReviewRun,
  insertReviewRunOnce,
  insertOutputEvents,
  updateRunStatus,
  getOverviewStats,
  getProjectStats,
  getProviderModelStats,
  getRecentRuns,
  softDeleteMissingProjects,
  hardDeleteExpiredProjects,
  getDailyRollups,
  recomputeDailyRollup,
} from "../src/stats.js";
import {
  writeReflectionMemory,
  readReflectionMemory,
  compactReflectionMemory,
} from "../src/reflection.js";
import {
  getModelCatalogEntriesByModelId,
  getModelCatalogEntry,
  getModelCatalogSourceMeta,
  setModelCatalogSourceMeta,
  upsertModelCatalogEntries,
} from "../src/model-catalog.js";
import {
  claimReviewDeferral,
  deleteReviewDeferral,
  listPendingReviewDeferrals,
  resetClaimedReviewDeferrals,
  upsertReviewDeferral,
} from "../src/review-deferrals.js";
import {
  getRecentWebhookEvents,
  insertWebhookEvent,
  pruneWebhookEvents,
  WEBHOOK_EVENTS_RETENTION_LIMIT,
} from "../src/webhook-events.js";
import { createPgMigrationStore, STORE_MIGRATION_PLAN } from "../src/pg-migrations.js";

const PG_URL = process.env.AICR_PG_TEST_URL;
const describePg = PG_URL ? describe : describe.skip;

const DAY1 = "2024-01-15";
const DAY2 = "2024-01-16";
const at = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 10, 0, 0));

let schemaName: string;
let store: PgStoreDb;

async function openStore(name: string = schemaName): Promise<PgStoreDb> {
  return createStoreDb({ kind: "postgres", url: PG_URL!, schema: name });
}

async function ledgerRows(name: string = schemaName): Promise<Record<string, unknown>[]> {
  const result = await store.pool.query(
    `SELECT id, checksum, to_version FROM ${name}.schema_migrations WHERE namespace = 'store' ORDER BY to_version`,
  );
  return result.rows;
}

beforeEach(async () => {
  schemaName = `test_${randomUUID().replaceAll("-", "")}`;
  store = await openStore();
});

afterEach(async () => {
  await store.pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await closeStoreDb(store);
});

describePg("pg store migrations", () => {
  it("initializes a fresh schema and stays idempotent on reopen (M01)", async () => {
    const tables = await store.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [schemaName],
    );
    const names = tables.rows.map((row) => row.table_name);
    for (const expected of ["projects", "review_runs", "code_metrics", "llm_usage", "output_events", "daily_rollups", "reflection_memory", "model_catalog", "model_catalog_source", "webhook_events", "review_deferrals", "schema_migrations"]) {
      expect(names).toContain(expected);
    }
    expect(await ledgerRows()).toHaveLength(STORE_MIGRATION_PLAN.steps.length);

    // Second start: no repeated DDL, ledger unchanged.
    await closeStoreDb(store);
    store = await openStore();
    expect(await ledgerRows()).toHaveLength(STORE_MIGRATION_PLAN.steps.length);
  });

  it("applies each step exactly once under concurrent creates (M04)", async () => {
    const concurrentSchema = `test_${randomUUID().replaceAll("-", "")}`;
    const [a, b] = await Promise.all([
      createStoreDb({ kind: "postgres", url: PG_URL!, schema: concurrentSchema }),
      createStoreDb({ kind: "postgres", url: PG_URL!, schema: concurrentSchema }),
    ]);
    try {
      const rows = await a.pool.query(
        `SELECT id FROM ${concurrentSchema}.schema_migrations WHERE namespace = 'store'`,
      );
      expect(rows.rows).toHaveLength(STORE_MIGRATION_PLAN.steps.length);
    } finally {
      await a.pool.query(`DROP SCHEMA IF EXISTS ${concurrentSchema} CASCADE`);
      await closeStoreDb(a);
      await closeStoreDb(b);
    }
  });

  it("leaves the ledger empty or complete after a mid-migration kill (M06)", async () => {
    const killSchema = `test_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    const victim = new pg.Pool({
      connectionString: PG_URL,
      max: 1,
      options: `-c search_path=${killSchema}`,
    });
    // The killed connection surfaces on the pool as an idle-client error.
    victim.on("error", () => {});
    try {
      const client = await victim.connect();
        // Swallow the socket error from the deliberately killed connection.
        client.on("error", () => {});
      try {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${killSchema}`);
        const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
        const pid = rows[0]!.pid as number;
        const migrationStore = createPgMigrationStore(client);
        await migrationStore.ensureLedger();
        const attempt = migrationStore.withMigrationLock(async () => {
          await migrationStore.applyStep(STORE_MIGRATION_PLAN.steps[0]!);
          // Crash before COMMIT: the server aborts the transaction.
          await admin.query("SELECT pg_terminate_backend($1)", [pid]);
          await client.query("SELECT 1");
        });
        await expect(attempt).rejects.toThrow();
      } finally {
        client.release();
      }
    } finally {
      await victim.end().catch(() => {});
    }

    try {
      // Rolled back: the step neither recorded nor left its tables behind.
      const interim = await admin.query(
        `SELECT COUNT(*)::int AS n FROM ${killSchema}.schema_migrations WHERE namespace = 'store'`,
      );
      expect(interim.rows[0]!.n).toBe(0);

      // Reconnect retries cleanly; a repeated create is a no-op.
      const first = await openStore(killSchema);
      const applied = await first.pool.query(
        `SELECT COUNT(*)::int AS n FROM ${killSchema}.schema_migrations WHERE namespace = 'store'`,
      );
      expect(applied.rows[0]!.n).toBe(STORE_MIGRATION_PLAN.steps.length);
      await closeStoreDb(first);
      const second = await openStore(killSchema);
      const reapplied = await second.pool.query(
        `SELECT COUNT(*)::int AS n FROM ${killSchema}.schema_migrations WHERE namespace = 'store'`,
      );
      expect(reapplied.rows[0]!.n).toBe(STORE_MIGRATION_PLAN.steps.length);
      await closeStoreDb(second);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${killSchema} CASCADE`);
      await admin.end();
    }
  });

  it("refuses to start on checksum drift (M16)", async () => {
    await store.pool.query(
      `UPDATE ${schemaName}.schema_migrations SET checksum = 'drifted' WHERE namespace = 'store' AND id = '001_initial'`,
    );
    await closeStoreDb(store);
    await expect(openStore()).rejects.toSatisfy(
      (error: unknown) => isConfigError(error, "schema_version_unsupported"),
    );
    // The data is untouched; repairing the checksum lets startup proceed.
    await repairLedger(
      `UPDATE ${schemaName}.schema_migrations SET checksum = $1 WHERE namespace = 'store' AND id = '001_initial'`,
      [STORE_MIGRATION_PLAN.steps[0]!.checksum],
    );
    store = await openStore();
    expect(await ledgerRows()).toHaveLength(STORE_MIGRATION_PLAN.steps.length);
  });

  it("refuses to start on an unknown higher schema version (M16)", async () => {
    await store.pool.query(
      `INSERT INTO ${schemaName}.schema_migrations
         (namespace, id, checksum, from_version, to_version, app_version, applied_at)
       VALUES ('store', '999_future', 'abc', 9, 10, 'future', 0)`,
    );
    await closeStoreDb(store);
    await expect(openStore()).rejects.toSatisfy(
      (error: unknown) => isConfigError(error, "schema_version_unsupported"),
    );
    await repairLedger(
      `DELETE FROM ${schemaName}.schema_migrations WHERE namespace = 'store' AND id = '999_future'`,
    );
    store = await openStore();
    expect(await ledgerRows()).toHaveLength(STORE_MIGRATION_PLAN.steps.length);
  });
});

/** Runs one repair statement against the test schema with a scratch pool. */
async function repairLedger(statement: string, params: readonly unknown[] = []): Promise<void> {
  const pool = new pg.Pool({ connectionString: PG_URL, max: 1 });
  try {
    await pool.query(statement, params);
  } finally {
    await pool.end();
  }
}

describePg("pg store stats", () => {
  it("inserts a review run and aggregates overview stats", async () => {
    await insertReviewRun(store, {
      id: "run-1",
      eventId: "evt-1",
      workspaceId: "ws-1",
      triggerName: "gitea-main",
      provider: "my-llm",
      providerModel: "gpt-4o",
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 5000,
      problemCount: 3,
      summaryCount: 1,
      dispatchCount: 2,
      promptTokenEstimate: 850,
      codeMetrics: { filesChanged: 5, linesAdded: 100, linesDeleted: 20, bytesAnalyzed: 5000, filesAnalyzed: 5 },
      llmUsages: [{
        providerId: "my-llm",
        modelId: "gpt-4o",
        requestCount: 2,
        tokensIn: 1000,
        tokensOut: 500,
        tokensTotal: 1500,
        cachedTokens: 400,
        cacheCreationTokens: 100,
        costUsd: 0.05,
        latencyMs: 3000,
      }],
    });

    const stats = await getOverviewStats(store);
    expect(stats.reviewCount).toBe(1);
    expect(stats.successCount).toBe(1);
    expect(stats.failureCount).toBe(0);
    expect(stats.problemTotal).toBe(3);
    expect(stats.filesChangedTotal).toBe(5);
    expect(stats.linesAddedTotal).toBe(100);
    expect(stats.bytesAnalyzedTotal).toBe(5000);
    expect(stats.llmRequestTotal).toBe(2);
    expect(stats.tokensInTotal).toBe(1000);
    expect(stats.tokensOutTotal).toBe(500);
    expect(stats.tokensTotalTotal).toBe(1500);
    expect(stats.cachedTokensInTotal).toBe(400);
    expect(stats.cacheCreationTokensTotal).toBe(100);
    expect(stats.costUsdTotal).toBeCloseTo(0.05);
    expect(stats.avgDurationMs).toBe(5000);
    expect(stats.promptTokenEstimateTotal).toBe(850);
  });

  it("filters stats by time window", async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await insertReviewRun(store, {
      id: "run-old", eventId: "evt-old", workspaceId: "ws-1", triggerName: "gitea",
      provider: null, providerModel: null, status: "succeeded",
      startedAt: yesterday, finishedAt: yesterday, durationMs: 100, problemCount: 1,
    });
    await insertReviewRun(store, {
      id: "run-new", eventId: "evt-new", workspaceId: "ws-1", triggerName: "gitea",
      provider: null, providerModel: null, status: "failed",
      startedAt: now, finishedAt: now, durationMs: 200, problemCount: 2,
    });

    expect((await getOverviewStats(store)).reviewCount).toBe(2);
    const today = await getOverviewStats(store, new Date(now.getTime() - 12 * 60 * 60 * 1000));
    expect(today.reviewCount).toBe(1);
    expect(today.failureCount).toBe(1);
    expect(today.problemTotal).toBe(2);
  });

  it("aggregates project, provider+model, and recent-run stats", async () => {
    await insertReviewRun(store, {
      id: "run-a", eventId: "evt-a", workspaceId: "ws-1", triggerName: "gitea",
      repoRef: "owner/repo-a", displayName: "Repo A",
      provider: "openai", providerModel: "gpt-4o", status: "succeeded",
      startedAt: new Date(), durationMs: 1234, problemCount: 2,
      codeMetrics: { filesChanged: 4, linesAdded: 40, linesDeleted: 10, bytesAnalyzed: 4096 },
      llmUsages: [
        { providerId: "openai", modelId: "gpt-4o", requestCount: 3, tokensIn: 300, tokensOut: 150, tokensTotal: 450, cachedTokens: 120, costUsd: 0.03 },
        { providerId: "anthropic", modelId: "claude", tokensIn: 200, tokensOut: 100, tokensTotal: 300 },
      ],
    });
    await insertReviewRun(store, {
      id: "run-b", eventId: "evt-b", workspaceId: "ws-2", triggerName: "github",
      repoRef: "owner/repo-b", provider: null, providerModel: null, status: "failed",
      startedAt: new Date(),
    });
    await insertOutputEvents(store, "run-a", [
      { channelKind: "gitea_problem_issue", eventType: "issue_created", issueCreated: true },
    ]);

    const projects = await getProjectStats(store);
    expect(projects).toHaveLength(2);
    const a = projects.find((project) => project.repoRef === "owner/repo-a")!;
    expect(a).toMatchObject({
      workspaceId: "ws-1",
      displayName: "Repo A",
      reviewCount: 1,
      problemTotal: 2,
      issueCreatedCount: 1,
      filesChangedTotal: 4,
      linesAddedTotal: 40,
      llmRequestTotal: 4,
      tokensInTotal: 500,
      tokensTotalTotal: 750,
      cachedTokensInTotal: 120,
    });
    expect(a.costUsdTotal).toBeCloseTo(0.03);

    const providers = await getProviderModelStats(store);
    expect(providers.map((row) => row.providerId).sort()).toEqual(["anthropic", "openai"]);
    const openai = providers.find((row) => row.providerId === "openai")!;
    expect(openai.tokensTotal).toBe(450);
    expect(openai.cachedTokensIn).toBe(120);
    expect(openai.costUsd).toBeCloseTo(0.03);

    const recent = await getRecentRuns(store, 10);
    expect(recent).toHaveLength(2);
    const recentA = recent.find((run) => run.id === "run-a")!;
    expect(recentA.llmUsage).toEqual({
      tokensIn: 500,
      tokensOut: 250,
      tokensTotal: 750,
      cachedTokens: 120,
      cacheCreationTokens: 0,
    });
    expect(recent.find((run) => run.id === "run-b")!.llmUsage).toBeUndefined();
  });

  it("updates run status and round-trips the VCS stamp", async () => {
    await insertReviewRun(store, {
      id: "run-vcs", eventId: "evt", workspaceId: "ws-1", triggerName: "gitea",
      provider: null, providerModel: null, status: "queued",
      startedAt: new Date(), branch: "main", headSha: "0123456789abcdef",
      vcsKind: "git", headCommittedAt: new Date("2026-09-01T08:30:00.000Z"),
    });
    await updateRunStatus(store, "run-vcs", "succeeded", { problemCount: 2, durationMs: 3000, finishedAt: new Date() });

    const [run] = await getRecentRuns(store, 1);
    expect(run).toMatchObject({
      id: "run-vcs",
      status: "succeeded",
      problemCount: 2,
      branch: "main",
      headSha: "0123456789abcdef",
      vcsKind: "git",
      headCommittedAt: new Date("2026-09-01T08:30:00.000Z"),
    });
  });

  it("computes and filters daily rollups", async () => {
    await insertReviewRun(store, {
      id: "run-d1", eventId: "evt-d1", workspaceId: "ws-1", triggerName: "gitea",
      repoRef: "owner/repo-a", provider: "openai", providerModel: "gpt-4o", status: "succeeded",
      startedAt: at(DAY1), problemCount: 3,
      codeMetrics: { filesChanged: 5, linesAdded: 50, linesDeleted: 20, bytesAnalyzed: 1024 },
      llmUsages: [{ providerId: "openai", modelId: "gpt-4o", requestCount: 2, tokensIn: 1000, tokensOut: 500, tokensTotal: 1500, cachedTokens: 600, cacheCreationTokens: 50, costUsd: 0.02 }],
    });
    await insertReviewRun(store, {
      id: "run-d2", eventId: "evt-d2", workspaceId: "ws-1", triggerName: "gitea",
      repoRef: "owner/repo-a", provider: null, providerModel: null, status: "skipped",
      startedAt: at(DAY2),
    });

    const [project] = (await getProjectStats(store)).filter((row) => row.workspaceId === "ws-1");
    const rollups = await getDailyRollups(store, { projectId: project!.projectId });
    expect(rollups).toHaveLength(2);
    const day1 = rollups.find((row) => row.date === DAY1)!;
    expect(day1).toMatchObject({
      reviewCount: 1,
      successCount: 1,
      problemTotal: 3,
      filesChanged: 5,
      llmRequestCount: 2,
      tokensTotal: 1500,
      cachedTokens: 600,
      cacheCreationTokens: 50,
    });
    expect(day1.costUsd).toBeCloseTo(0.02);
    expect(rollups.find((row) => row.date === DAY2)).toMatchObject({ reviewCount: 1, skipCount: 1 });
    expect(await getDailyRollups(store, { since: DAY2 })).toHaveLength(1);

    // Idempotent recompute; empty partition leaves no row.
    await recomputeDailyRollup(store, project!.projectId, DAY1);
    expect(await getDailyRollups(store, { projectId: project!.projectId })).toHaveLength(2);
    await recomputeDailyRollup(store, project!.projectId, "2024-01-20");
    expect(await getDailyRollups(store, { since: "2024-01-20", until: "2024-01-20" })).toHaveLength(0);
  });

  it("records a run idempotently for checkpoint retries", async () => {
    const run = {
      id: "run-once", eventId: "evt", workspaceId: "ws-1", triggerName: "gitea",
      provider: null, providerModel: null, status: "succeeded" as const, startedAt: new Date(),
    };
    expect(await insertReviewRunOnce(store, run)).toBe(true);
    expect(await insertReviewRunOnce(store, run)).toBe(false);
    expect((await getOverviewStats(store)).reviewCount).toBe(1);
  });

  it("folds concurrent duplicate runs and accounts for exactly one write", async () => {
    const run = { id: "same-run", eventId: "evt", workspaceId: "ws", status: "succeeded" as const };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => insertReviewRunOnce(store, run)));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(results.filter((result) => result.status === "fulfilled" && result.value)).toHaveLength(1);
    expect(await getRecentRuns(store, 10)).toHaveLength(1);
  });

  it("keeps rollups complete when existing-project runs commit concurrently", async () => {
    const base = { eventId: "evt", workspaceId: "ws", status: "succeeded" as const, startedAt: new Date("2026-09-13T00:00:00Z") };
    await insertReviewRun(store, { ...base, id: "seed" });
    await Promise.all(Array.from({ length: 8 }, (_, index) => insertReviewRun(store, { ...base, id: `concurrent-${index}` })));
    expect(await getDailyRollups(store)).toMatchObject([{ reviewCount: 9 }]);
  });

  it("records both runs when concurrent inserts race on a fresh project identity", async () => {
    const makeRun = (id: string) => ({
      id,
      eventId: `evt-${id}`,
      workspaceId: "ws-race",
      triggerName: "gitea",
      repoRef: "owner/race-repo",
      provider: null,
      providerModel: null,
      status: "succeeded" as const,
      startedAt: new Date(),
      llmUsages: [{ providerId: "openai", modelId: "gpt-4o", tokensIn: 10, tokensOut: 5 }],
    });
    const [first, second] = await Promise.all([
      insertReviewRunOnce(store, makeRun("run-race-1")),
      insertReviewRunOnce(store, makeRun("run-race-2")),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect((await getOverviewStats(store)).reviewCount).toBe(2);
    const usage = await store.pool.query(`SELECT count(*)::int AS n FROM ${schemaName}.llm_usage`);
    expect(usage.rows[0].n).toBe(2);
  });

  it("rolls back the whole accounting on a mid-insert failure and replays cleanly on retry", async () => {
    // Fault injection: a NOT NULL column the writer does not know about makes
    // the llm_usage insert fail after the project and run rows were written.
    await store.pool.query(`ALTER TABLE ${schemaName}.llm_usage ADD COLUMN inject_failure text NOT NULL`);
    const run = {
      id: "run-rollback",
      eventId: "evt-rollback",
      workspaceId: "ws-rollback",
      triggerName: "gitea",
      repoRef: "owner/rollback-repo",
      provider: null,
      providerModel: null,
      status: "succeeded" as const,
      startedAt: new Date(),
      llmUsages: [{ providerId: "openai", modelId: "gpt-4o", tokensIn: 100, tokensOut: 50 }],
    };
    await expect(insertReviewRunOnce(store, run)).rejects.toThrow();

    // Nothing survived: no project, no run, no usage, no rollup.
    expect((await getOverviewStats(store)).reviewCount).toBe(0);
    const counts = await store.pool.query(
      `SELECT (SELECT count(*)::int FROM ${schemaName}.projects) AS projects,` +
        ` (SELECT count(*)::int FROM ${schemaName}.llm_usage) AS usage`,
    );
    expect(counts.rows[0]).toMatchObject({ projects: 0, usage: 0 });
    expect(await getDailyRollups(store)).toHaveLength(0);

    // Checkpoint retry after the fault clears replays the full accounting.
    await store.pool.query(`ALTER TABLE ${schemaName}.llm_usage DROP COLUMN inject_failure`);
    expect(await insertReviewRunOnce(store, run)).toBe(true);
    expect((await getOverviewStats(store)).reviewCount).toBe(1);
    const usage = await store.pool.query(`SELECT tokens_in FROM ${schemaName}.llm_usage`);
    expect(usage.rows).toHaveLength(1);
    expect(await getDailyRollups(store)).toHaveLength(1);
  });

});

describePg("pg store project retention", () => {
  it("soft-deletes missing projects and hard-deletes after the grace period", async () => {
    await insertReviewRun(store, {
      id: "run-1", eventId: "evt", workspaceId: "ws-old", triggerName: "old",
      provider: null, providerModel: null, status: "succeeded", startedAt: new Date(),
    });

    expect(await softDeleteMissingProjects(store, [
      { workspaceId: "ws-active", triggerName: "active", repoRef: "" },
    ])).toBe(1);
    const projects = await getProjectStats(store);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.isActive).toBe(false);

    expect(await hardDeleteExpiredProjects(store, 0)).toBe(1);
    expect(await getProjectStats(store)).toHaveLength(0);
  });
});

describePg("pg store reflection memory", () => {
  it("writes, reads, counts occurrences, and compacts", async () => {
    const now = new Date();
    await writeReflectionMemory(store, [
      { workspaceId: "ws-1", fingerprint: "fp-1", content: "first", sourceRunId: "run-1", createdAt: now },
      { workspaceId: "ws-1", fingerprint: "fp-expired", content: "old", createdAt: new Date(now.getTime() - 1000), expiresAt: new Date(now.getTime() - 1) },
    ]);
    await writeReflectionMemory(store, [
      { workspaceId: "ws-1", fingerprint: "fp-1", content: "updated", createdAt: new Date(now.getTime() + 1000) },
    ]);

    const entries = await readReflectionMemory(store, "ws-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ fingerprint: "fp-1", content: "updated", occurrenceCount: 2 });

    for (let i = 0; i < 5; i += 1) {
      await writeReflectionMemory(store, [
        { workspaceId: "ws-2", fingerprint: `fp-${i}`, content: `entry ${i}`, createdAt: now },
      ]);
    }
    expect(await compactReflectionMemory(store, "ws-2", { maxEntries: 2 })).toBe(3);
    expect(await readReflectionMemory(store, "ws-2")).toHaveLength(2);
  });
});

describePg("pg store model catalog", () => {
  it("upserts, overwrites, and fuzzy-reads entries plus source meta", async () => {
    await upsertModelCatalogEntries(store, [
      { catalogId: "openai/gpt-4o", providerId: "openai", modelId: "gpt-4o", data: JSON.stringify({ contextWindow: 128000 }), source: "remote", fetchedAt: new Date(1000) },
      { catalogId: "other/gpt-4o", providerId: "other", modelId: "gpt-4o", data: "{}", fetchedAt: new Date(1000) },
    ]);
    const entry = await getModelCatalogEntry(store, "openai/gpt-4o");
    expect(entry).toBeDefined();
    expect(JSON.parse(entry!.data).contextWindow).toBe(128000);
    expect(entry!.fetchedAt.getTime()).toBe(1000);

    await upsertModelCatalogEntries(store, [
      { catalogId: "openai/gpt-4o", providerId: "openai", modelId: "gpt-4o", data: JSON.stringify({ v: 2 }), fetchedAt: new Date(2000) },
    ]);
    expect(JSON.parse((await getModelCatalogEntry(store, "openai/gpt-4o"))!.data).v).toBe(2);
    expect(await getModelCatalogEntriesByModelId(store, "gpt-4o")).toHaveLength(2);

    await setModelCatalogSourceMeta(store, { sourceUrl: "src", lastRefreshedAt: new Date(1000), etag: "e1" });
    await setModelCatalogSourceMeta(store, { sourceUrl: "src", lastRefreshedAt: new Date(2000) });
    const meta = await getModelCatalogSourceMeta(store, "src");
    expect(meta!.lastRefreshedAt.getTime()).toBe(2000);
    expect(meta!.etag).toBeUndefined();
  });
});

describePg("pg store review deferrals", () => {
  const deferral = (overrides: Record<string, unknown> = {}) => ({
    dedupKey: "key-1",
    workspaceId: "ws-1",
    provider: "gitea",
    eventName: "pull_request",
    reviewEvent: JSON.stringify({ targetKind: "pull_request" }),
    payload: JSON.stringify({ action: "opened" }),
    notBefore: new Date(10_000),
    ...overrides,
  });

  it("replaces the envelope but never moves not_before earlier", async () => {
    await upsertReviewDeferral(store, deferral({ notBefore: new Date(10_000) }));
    await upsertReviewDeferral(store, deferral({ reviewEvent: JSON.stringify({ headSha: "newer" }), notBefore: new Date(5_000) }));

    let pending = await listPendingReviewDeferrals(store);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.reviewEvent).toContain("newer");
    expect(pending[0]!.notBefore.getTime()).toBe(10_000);

    await upsertReviewDeferral(store, deferral({ notBefore: new Date(30_000) }));
    pending = await listPendingReviewDeferrals(store);
    expect(pending[0]!.notBefore.getTime()).toBe(30_000);
  });

  it("claims atomically and resets claimed rows on recovery", async () => {
    await upsertReviewDeferral(store, deferral());
    const claimed = await claimReviewDeferral(store, "key-1");
    expect(claimed).toBeDefined();
    expect(claimed!.attempts).toBe(1);
    expect(await claimReviewDeferral(store, "key-1")).toBeUndefined();

    expect(await resetClaimedReviewDeferrals(store)).toBe(1);
    const pending = await listPendingReviewDeferrals(store);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBe(1);

    await deleteReviewDeferral(store, "key-1");
    expect(await listPendingReviewDeferrals(store)).toHaveLength(0);
  });
});

describePg("pg store webhook events", () => {
  it("appends, returns newest-first with parsed detail, and prunes", async () => {
    await insertWebhookEvent(store, {
      receivedAt: new Date(1_000),
      provider: "github",
      eventName: "pull_request",
      workspaceId: "ws-1",
      decision: "deferred",
      reason: "execution_window",
      detail: { resumeAt: 5_000 },
    });
    await insertWebhookEvent(store, { receivedAt: new Date(2_000), provider: "gitea", decision: "queued" });

    const events = await getRecentWebhookEvents(store, 20);
    expect(events).toHaveLength(2);
    expect(events[0]!.provider).toBe("gitea");
    expect(events[1]!.detail).toEqual({ resumeAt: 5_000 });

    for (let i = 0; i < WEBHOOK_EVENTS_RETENTION_LIMIT + 10; i += 1) {
      await insertWebhookEvent(store, { receivedAt: new Date(10_000 + i), decision: "executed" });
    }
    expect(await getRecentWebhookEvents(store, WEBHOOK_EVENTS_RETENTION_LIMIT + 50))
      .toHaveLength(WEBHOOK_EVENTS_RETENTION_LIMIT);
    expect(await pruneWebhookEvents(store, 3)).toBe(WEBHOOK_EVENTS_RETENTION_LIMIT - 3);
    expect(await getRecentWebhookEvents(store, 10)).toHaveLength(3);
  });
});
