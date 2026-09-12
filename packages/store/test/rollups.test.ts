import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStoreDb, closeStoreDb, type SqliteStoreDb } from "../src/database.js";
import {
  insertReviewRun,
  insertOutputEvents,
  getProjectStats,
  recomputeDailyRollup,
  getDailyRollups,
  toUtcDateString,
} from "../src/stats.js";

let tmpDir: string;
let store: SqliteStoreDb;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aicr-rollups-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  store = createStoreDb(join(tmpDir, "test.db"));
});

afterEach(async () => {
  (await closeStoreDb(store));
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

const DAY1 = "2024-01-15";
const DAY2 = "2024-01-16";
const at = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 10, 0, 0));

async function seed(): Promise<{ projA: number; projB: number }> {
  (await insertReviewRun(store, {
    id: "run-a1",
    eventId: "evt-a1",
    workspaceId: "ws-1",
    triggerName: "gitea",
    repoRef: "owner/repo-a",
    provider: "openai",
    providerModel: "gpt-4o",
    status: "succeeded",
    startedAt: at(DAY1),
    problemCount: 3,
    codeMetrics: { filesChanged: 5, linesAdded: 50, linesDeleted: 20, bytesAnalyzed: 1024 },
    llmUsages: [{ providerId: "openai", modelId: "gpt-4o", requestCount: 2, tokensIn: 1000, tokensOut: 500, tokensTotal: 1500, cachedTokens: 600, cacheCreationTokens: 50, costUsd: 0.02 }],
  }));
  (await insertReviewRun(store, {
    id: "run-a2",
    eventId: "evt-a2",
    workspaceId: "ws-1",
    triggerName: "gitea",
    repoRef: "owner/repo-a",
    provider: null,
    providerModel: null,
    status: "failed",
    startedAt: at(DAY1),
  }));
  (await insertReviewRun(store, {
    id: "run-a3",
    eventId: "evt-a3",
    workspaceId: "ws-1",
    triggerName: "gitea",
    repoRef: "owner/repo-a",
    provider: null,
    providerModel: null,
    status: "skipped",
    startedAt: at(DAY2),
  }));
  (await insertReviewRun(store, {
    id: "run-b1",
    eventId: "evt-b1",
    workspaceId: "ws-2",
    triggerName: "github",
    repoRef: "owner/repo-b",
    provider: "anthropic",
    providerModel: "claude",
    status: "succeeded",
    startedAt: at(DAY1),
    problemCount: 1,
    codeMetrics: { filesChanged: 2, linesAdded: 10, linesDeleted: 5, bytesAnalyzed: 512 },
    llmUsages: [{ providerId: "anthropic", modelId: "claude", requestCount: 1, tokensIn: 200, tokensOut: 100, tokensTotal: 300, costUsd: 0.01 }],
  }));

  const stats = (await getProjectStats(store));
  return {
    projA: stats.find((p) => p.workspaceId === "ws-1")!.projectId,
    projB: stats.find((p) => p.workspaceId === "ws-2")!.projectId,
  };
}

describe("daily rollups", () => {
  it("writes per-project per-day rollups on run insert", async () => {
    const { projA, projB } = await seed();

    const rollups = (await getDailyRollups(store));
    expect(rollups).toHaveLength(3);

    const aDay1 = rollups.find((r) => r.projectId === projA && r.date === DAY1);
    expect(aDay1).toMatchObject({
      reviewCount: 2,
      successCount: 1,
      failureCount: 1,
      skipCount: 0,
      problemRunCount: 1,
      problemTotal: 3,
      issueCreatedCount: 0,
      filesChanged: 5,
      linesAdded: 50,
      linesDeleted: 20,
      bytesAnalyzed: 1024,
      llmRequestCount: 2,
      tokensIn: 1000,
      tokensOut: 500,
      tokensTotal: 1500,
      cachedTokens: 600,
      cacheCreationTokens: 50,
    });
    expect(aDay1!.costUsd).toBeCloseTo(0.02);

    const aDay2 = rollups.find((r) => r.projectId === projA && r.date === DAY2);
    expect(aDay2).toMatchObject({
      reviewCount: 1,
      successCount: 0,
      failureCount: 0,
      skipCount: 1,
      problemRunCount: 0,
      problemTotal: 0,
      llmRequestCount: 0,
    });
    expect(aDay2!.costUsd).toBeNull();

    const bDay1 = rollups.find((r) => r.projectId === projB && r.date === DAY1);
    expect(bDay1).toMatchObject({
      reviewCount: 1,
      successCount: 1,
      problemTotal: 1,
      filesChanged: 2,
      llmRequestCount: 1,
      tokensTotal: 300,
    });
    expect(bDay1!.costUsd).toBeCloseTo(0.01);
  });

  it("recomputeDailyRollup is idempotent", async () => {
    const { projA } = await seed();
    const before = (await getDailyRollups(store, { projectId: projA, since: DAY1, until: DAY1 }))[0];

    (await recomputeDailyRollup(store, projA, DAY1));
    (await recomputeDailyRollup(store, projA, DAY1));
    const after = (await getDailyRollups(store, { projectId: projA, since: DAY1, until: DAY1 }))[0];

    expect(after).toEqual(before);
  });

  it("recomputeDailyRollup leaves no row for a partition with no runs", async () => {
    const { projA } = await seed();
    (await recomputeDailyRollup(store, projA, "2024-01-20"));
    expect((await getDailyRollups(store, { projectId: projA, since: "2024-01-20", until: "2024-01-20" }))).toHaveLength(0);
  });

  it("attributes a run without explicit startedAt to today's UTC partition", async () => {
    (await insertReviewRun(store, {
      id: "run-nostart",
      eventId: "evt-nostart",
      workspaceId: "ws-1",
      triggerName: "gitea",
      repoRef: "owner/repo-a",
      provider: null,
      providerModel: null,
      status: "succeeded",
      problemCount: 1,
    }));

    const today = toUtcDateString(new Date());
    const rows = (await getDailyRollups(store, { since: today, until: today }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe(today);
    expect(rows[0]!.reviewCount).toBe(1);
    expect(rows[0]!.problemTotal).toBe(1);
  });

  it("insertOutputEvents refreshes issueCreatedCount in the rollup", async () => {
    const { projA } = await seed();
    (await insertOutputEvents(store, "run-a1", [
      { channelKind: "gitea_problem_issue", eventType: "issue_created", issueCreated: true },
      { channelKind: "gitea_pr_review", eventType: "comment", commentCreated: true },
    ]));

    const aDay1 = (await getDailyRollups(store, { projectId: projA, since: DAY1, until: DAY1 }))[0];
    expect(aDay1.issueCreatedCount).toBe(1);
  });

  it("filters rollups by projectId / since / until", async () => {
    const { projA } = await seed();
    expect((await getDailyRollups(store))).toHaveLength(3);
    expect((await getDailyRollups(store, { projectId: projA }))).toHaveLength(2);
    expect((await getDailyRollups(store, { since: DAY2 }))).toHaveLength(1);
    expect((await getDailyRollups(store, { until: DAY1 }))).toHaveLength(2);
    expect((await getDailyRollups(store, { since: DAY1, until: DAY1 }))).toHaveLength(2);
  });

  it("rollup totals across days match real-time project stats", async () => {
    const { projA } = await seed();
    const rows = (await getDailyRollups(store, { projectId: projA }));

    const sumCost = rows.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
    const summed = {
      reviewCount: rows.reduce((a, r) => a + r.reviewCount, 0),
      successCount: rows.reduce((a, r) => a + r.successCount, 0),
      failureCount: rows.reduce((a, r) => a + r.failureCount, 0),
      skipCount: rows.reduce((a, r) => a + r.skipCount, 0),
      problemRunCount: rows.reduce((a, r) => a + r.problemRunCount, 0),
      problemTotal: rows.reduce((a, r) => a + r.problemTotal, 0),
      filesChanged: rows.reduce((a, r) => a + r.filesChanged, 0),
      linesAdded: rows.reduce((a, r) => a + r.linesAdded, 0),
      linesDeleted: rows.reduce((a, r) => a + r.linesDeleted, 0),
      bytesAnalyzed: rows.reduce((a, r) => a + r.bytesAnalyzed, 0),
      llmRequestCount: rows.reduce((a, r) => a + r.llmRequestCount, 0),
      tokensIn: rows.reduce((a, r) => a + r.tokensIn, 0),
      tokensOut: rows.reduce((a, r) => a + r.tokensOut, 0),
      tokensTotal: rows.reduce((a, r) => a + r.tokensTotal, 0),
      cachedTokens: rows.reduce((a, r) => a + r.cachedTokens, 0),
      cacheCreationTokens: rows.reduce((a, r) => a + r.cacheCreationTokens, 0),
    };

    const [realtime] = (await getProjectStats(store)).filter((p) => p.projectId === projA);
    expect(summed).toEqual({
      reviewCount: realtime!.reviewCount,
      successCount: realtime!.successCount,
      failureCount: realtime!.failureCount,
      skipCount: realtime!.skipCount,
      problemRunCount: realtime!.problemRunCount,
      problemTotal: realtime!.problemTotal,
      filesChanged: realtime!.filesChangedTotal,
      linesAdded: realtime!.linesAddedTotal,
      linesDeleted: realtime!.linesDeletedTotal,
      bytesAnalyzed: realtime!.bytesAnalyzedTotal,
      llmRequestCount: realtime!.llmRequestTotal,
      tokensIn: realtime!.tokensInTotal,
      tokensOut: realtime!.tokensOutTotal,
      tokensTotal: realtime!.tokensTotalTotal,
      cachedTokens: realtime!.cachedTokensInTotal,
      cacheCreationTokens: realtime!.cacheCreationTokensTotal,
    });
    expect(sumCost).toBeCloseTo(realtime!.costUsdTotal);
  });
});
