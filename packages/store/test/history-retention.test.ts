import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHistoryRetention } from "@aicr/core";
import { closeStoreDb, createStoreDb, type StoreDb } from "../src/database.js";
import { configureHistoryRetention, pruneRecentRunHistory } from "../src/history-retention.js";
import { getDailyRollups, getOverviewStats, getProjectStats, getProviderModelStats, getRecentRuns, insertReviewRun, insertReviewRunOnce, type ReviewRunInsert } from "../src/stats.js";
import { getRecentWebhookEvents, insertWebhookEvent, pruneWebhookEvents } from "../src/webhook-events.js";

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !process.env.AICR_PG_TEST_URL)(`admin history [${backend}]`, () => {
    let store: StoreDb;
    let directory: string;
    let schema: string;
    beforeEach(async () => {
      await mkdir("build/tmp", { recursive: true });
      directory = await mkdtemp(join(process.cwd(), "build/tmp/history-retention-"));
      schema = `history_${randomUUID().replaceAll("-", "")}`;
      store = backend === "sqlite" ? createStoreDb(join(directory, "history.sqlite"))
        : await createStoreDb({ kind: "postgres", url: process.env.AICR_PG_TEST_URL!, schema });
    });
    afterEach(async () => {
      if (store?.kind === "postgres") await store.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      if (store) await closeStoreDb(store);
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("erases old details while preserving aggregates, daily rollups and checkpoint idempotency", async () => {
      const now = Date.now();
      const run = (id: string, startedAt: number): ReviewRunInsert => ({ id, eventId: `event-${id}`, workspaceId: "ws", triggerName: "github",
        repoRef: "org/repo", provider: "test", providerModel: "model", status: "succeeded", startedAt: new Date(startedAt),
        error: "private old detail", targetUrl: "https://example.com/private", branch: "old-branch", headSha: "old-sha",
        durationMs: 123, promptTokenEstimate: 12, problemCount: 1, codeMetrics: { filesChanged: 2 },
        llmUsages: [{ providerId: "test", modelId: "model", tokensIn: 20, tokensOut: 4, tokensTotal: 24, costUsd: 0.01 }],
      });
      for (let i = 0; i < 4; i++) await insertReviewRun(store, run(`run-${i}`, now + i));
      await insertReviewRun(store, run("ancient", now - 365 * 86_400_000));
      const before = await Promise.all([getOverviewStats(store), getProjectStats(store), getProviderModelStats(store), getDailyRollups(store)]);
      let keep = 2;
      configureHistoryRetention(store, () => resolveHistoryRetention({ recent_runs: { max_count: keep, max_age_months: 6 } }));
      expect(await pruneRecentRunHistory(store)).toBe(3);
      expect((await getRecentRuns(store, 20)).map(item => item.id)).toEqual(["run-3", "run-2"]);
      expect((await getRecentRuns(store, 1, 1)).map(item => item.id)).toEqual(["run-2"]);
      const raw = store.kind === "sqlite"
        ? store.sqlite.prepare("SELECT event_id, error, target_url, branch, head_sha FROM review_runs WHERE id = ?").get("run-0")
        : (await store.pool.query("SELECT event_id, error, target_url, branch, head_sha FROM review_runs WHERE id = $1", ["run-0"])).rows[0];
      expect(raw).toEqual({ event_id: "", error: null, target_url: null, branch: null, head_sha: null });
      expect(await insertReviewRunOnce(store, run("run-0", now))).toBe(false);
      expect(await Promise.all([getOverviewStats(store), getProjectStats(store), getProviderModelStats(store), getDailyRollups(store)])).toEqual(before);
      keep = 1;
      await pruneRecentRunHistory(store);
      expect((await getRecentRuns(store, 20)).map(item => item.id)).toEqual(["run-3"]);
      keep = 20;
      expect((await getRecentRuns(store, 20)).map(item => item.id)).toEqual(["run-3"]); // Pruning is irreversible.
      await insertReviewRun(store, run("fresh", now + 5));
      expect((await getOverviewStats(store)).reviewCount).toBe(6);
      expect((await getDailyRollups(store)).reduce((sum, row) => sum + row.reviewCount, 0)).toBe(6);
    });

    it("applies live count and age limits to events, with stable ties and no insert required for expiry", async () => {
      const now = Date.now();
      let keep = 3;
      configureHistoryRetention(store, () => resolveHistoryRetention({ events: { max_count: keep, max_age_months: 6 } }));
      for (let i = 0; i < 5; i++) await insertWebhookEvent(store, { decision: "queued", reason: `event-${i}`, receivedAt: new Date(now) });
      expect((await getRecentWebhookEvents(store, 1, 1)).map(item => item.reason)).toEqual(["event-3"]);
      await insertWebhookEvent(store, { decision: "queued", reason: "ancient", receivedAt: new Date(now - 365 * 86_400_000) });
      expect((await getRecentWebhookEvents(store, 20)).map(item => item.reason)).toEqual(["event-4", "event-3", "event-2"]);
      keep = 1;
      expect(await pruneWebhookEvents(store)).toBe(2);
      expect((await getRecentWebhookEvents(store, 20)).map(item => item.reason)).toEqual(["event-4"]);
      expect(await pruneWebhookEvents(store, undefined, now + 365 * 86_400_000)).toBe(1);
      expect(await getRecentWebhookEvents(store, 20)).toEqual([]);
    });
  });
}
