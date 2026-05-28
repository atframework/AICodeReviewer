import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStoreDb, closeStoreDb, type StoreDb } from "../src/database.js";
import {
  insertReviewRun,
  getOverviewStats,
  getProjectStats,
  getProviderModelStats,
  getRecentRuns,
  updateRunStatus,
  insertOutputEvents,
  softDeleteMissingProjects,
  hardDeleteExpiredProjects,
} from "../src/stats.js";
import {
  writeReflectionMemory,
  readReflectionMemory,
  compactReflectionMemory,
} from "../src/reflection.js";

let tmpDir: string;
let store: StoreDb;

beforeEach(() => {
  tmpDir = join(tmpdir(), `aicr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  store = createStoreDb(join(tmpDir, "test.db"));
});

afterEach(() => {
  closeStoreDb(store);
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("store database", () => {
  it("creates and initializes database with migrations", () => {
    const tables = store.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as Record<string, string>).name);
    expect(tables).toContain("projects");
    expect(tables).toContain("review_runs");
    expect(tables).toContain("code_metrics");
    expect(tables).toContain("llm_usage");
    expect(tables).toContain("output_events");
    expect(tables).toContain("daily_rollups");
    expect(tables).toContain("_migrations");
  });

  it("enables WAL mode", () => {
    const result = store.sqlite.pragma("journal_mode");
    const row = result[0] as Record<string, string>;
    expect(row.journal_mode).toBe("wal");
  });

  it("enables foreign keys", () => {
    const result = store.sqlite.pragma("foreign_keys");
    const row = result[0] as Record<string, number>;
    expect(row.foreign_keys).toBe(1);
  });
});

describe("stats insert and query", () => {
  it("inserts a review run and queries overview stats", () => {
    insertReviewRun(store, {
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
      codeMetrics: {
        filesChanged: 5,
        linesAdded: 100,
        linesDeleted: 20,
        bytesAnalyzed: 5000,
        filesAnalyzed: 5,
      },
      llmUsages: [{
        providerId: "my-llm",
        modelId: "gpt-4o",
        requestCount: 2,
        tokensIn: 1000,
        tokensOut: 500,
        tokensTotal: 1500,
        costUsd: 0.05,
        latencyMs: 3000,
      }],
    });

    const stats = getOverviewStats(store);
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
    expect(stats.costUsdTotal).toBeCloseTo(0.05);
    expect(stats.avgDurationMs).toBe(5000);
  });

  it("inserts a failed run", () => {
    insertReviewRun(store, {
      id: "run-fail",
      eventId: "evt-fail",
      workspaceId: "ws-1",
      triggerName: "gitea-main",
      provider: null,
      providerModel: null,
      status: "failed",
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 1000,
      error: "Something went wrong",
    });

    const stats = getOverviewStats(store);
    expect(stats.reviewCount).toBe(1);
    expect(stats.failureCount).toBe(1);
    expect(stats.successCount).toBe(0);
  });

  it("queries time-windowed stats", () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    insertReviewRun(store, {
      id: "run-old",
      eventId: "evt-old",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: yesterday,
      finishedAt: yesterday,
      durationMs: 100,
      problemCount: 1,
    });

    insertReviewRun(store, {
      id: "run-new",
      eventId: "evt-new",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      durationMs: 200,
      problemCount: 2,
    });

    const all = getOverviewStats(store);
    expect(all.reviewCount).toBe(2);

    const today = getOverviewStats(store, new Date(now.getTime() - 12 * 60 * 60 * 1000));
    expect(today.reviewCount).toBe(1);
    expect(today.problemTotal).toBe(2);
  });

  it("queries project stats", () => {
    insertReviewRun(store, {
      id: "run-1",
      eventId: "evt-1",
      workspaceId: "ws-1",
      triggerName: "gitea",
      repoRef: "owner/repo-a",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: new Date(),
      problemCount: 5,
    });

    insertReviewRun(store, {
      id: "run-2",
      eventId: "evt-2",
      workspaceId: "ws-2",
      triggerName: "github",
      repoRef: "owner/repo-b",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: new Date(),
      problemCount: 0,
    });

    const projects = getProjectStats(store);
    expect(projects.length).toBe(2);
    expect(projects.map((project) => project.repoRef).sort()).toEqual(["owner/repo-a", "owner/repo-b"]);
  });

  it("queries project stats with code, output, and LLM aggregates", () => {
    insertReviewRun(store, {
      id: "run-project-aggregates",
      eventId: "evt-project-aggregates",
      workspaceId: "ws-1",
      triggerName: "gitea",
      repoRef: "owner/repo-a",
      displayName: "Repo A",
      provider: "openai",
      providerModel: "gpt-4o",
      status: "succeeded",
      startedAt: new Date(),
      durationMs: 1234,
      problemCount: 2,
      codeMetrics: {
        filesChanged: 4,
        linesAdded: 40,
        linesDeleted: 10,
        bytesAnalyzed: 4096,
      },
      llmUsages: [{
        providerId: "openai",
        modelId: "gpt-4o",
        requestCount: 3,
        tokensIn: 300,
        tokensOut: 150,
        tokensTotal: 450,
        costUsd: 0.03,
      }],
    });

    insertOutputEvents(store, "run-project-aggregates", [
      { channelKind: "gitea_problem_issue", eventType: "issue_created", issueCreated: true },
    ]);

    const [project] = getProjectStats(store);
    expect(project).toMatchObject({
      workspaceId: "ws-1",
      triggerName: "gitea",
      repoRef: "owner/repo-a",
      displayName: "Repo A",
      reviewCount: 1,
      problemTotal: 2,
      issueCreatedCount: 1,
      filesChangedTotal: 4,
      linesAddedTotal: 40,
      linesDeletedTotal: 10,
      bytesAnalyzedTotal: 4096,
      llmRequestTotal: 3,
      tokensInTotal: 300,
      tokensOutTotal: 150,
      tokensTotalTotal: 450,
    });
    expect(project!.costUsdTotal).toBeCloseTo(0.03);
  });

  it("queries provider+model stats", () => {
    insertReviewRun(store, {
      id: "run-1",
      eventId: "evt-1",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: "openai",
      providerModel: "gpt-4o",
      status: "succeeded",
      startedAt: new Date(),
      llmUsages: [
        { providerId: "openai", modelId: "gpt-4o", tokensIn: 100, tokensOut: 50, tokensTotal: 150, costUsd: 0.01 },
        { providerId: "anthropic", modelId: "claude-3", tokensIn: 200, tokensOut: 100, tokensTotal: 300 },
      ],
    });

    const providers = getProviderModelStats(store);
    expect(providers.length).toBe(2);
    const openai = providers.find((p) => p.providerId === "openai");
    expect(openai).toBeDefined();
    expect(openai!.tokensTotal).toBe(150);
    expect(openai!.costUsd).toBeCloseTo(0.01);
  });

  it("queries recent runs", () => {
    for (let i = 0; i < 5; i++) {
      insertReviewRun(store, {
        id: `run-${i}`,
        eventId: `evt-${i}`,
        workspaceId: "ws-1",
        triggerName: "gitea",
        provider: "openai",
        providerModel: "gpt-4o",
        status: i === 4 ? "failed" : "succeeded",
        startedAt: new Date(Date.now() - i * 1000),
        problemCount: i,
      });
    }

    const runs = getRecentRuns(store, 3);
    expect(runs.length).toBe(3);
    expect(runs[0]!.id).toBe("run-0");
  });

  it("updates run status", () => {
    insertReviewRun(store, {
      id: "run-update",
      eventId: "evt",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: null,
      providerModel: null,
      status: "queued",
      startedAt: new Date(),
    });

    updateRunStatus(store, "run-update", "succeeded", {
      problemCount: 2,
      durationMs: 3000,
      finishedAt: new Date(),
    });

    const runs = getRecentRuns(store, 10);
    const updated = runs.find((r) => r.id === "run-update");
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("succeeded");
  });

  it("inserts and queries output events", () => {
    insertReviewRun(store, {
      id: "run-oe",
      eventId: "evt",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: new Date(),
    });

    insertOutputEvents(store, "run-oe", [
      { channelKind: "gitea_pr_review", eventType: "problem_comment", commentCreated: true },
      { channelKind: "gitea_problem_issue", eventType: "issue_created", issueCreated: true },
    ]);

    const count = store.sqlite
      .prepare("SELECT COUNT(*) as cnt FROM output_events WHERE run_id = ?")
      .get("run-oe") as Record<string, number>;
    expect(count.cnt).toBe(2);
  });
});

describe("project lifecycle", () => {
  it("soft-deletes projects not in active set", () => {
    insertReviewRun(store, {
      id: "run-1",
      eventId: "evt",
      workspaceId: "ws-old",
      triggerName: "old-trigger",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: new Date(),
    });

    const deleted = softDeleteMissingProjects(store, [
      { workspaceId: "ws-active", triggerName: "active-trigger", repoRef: "" },
    ]);
    expect(deleted).toBe(1);

    const projects = getProjectStats(store);
    expect(projects.length).toBe(0);
  });

  it("hard-deletes expired projects", () => {
    insertReviewRun(store, {
      id: "run-1",
      eventId: "evt",
      workspaceId: "ws-expired",
      triggerName: "expired",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: new Date(),
    });

    softDeleteMissingProjects(store, []);

    const beforeCount = store.sqlite.prepare("SELECT COUNT(*) as cnt FROM projects WHERE deleted_at IS NOT NULL").get() as Record<string, number>;
    expect(beforeCount.cnt).toBe(1);

    const hardDeleted = hardDeleteExpiredProjects(store, 0);
    expect(hardDeleted).toBe(1);

    const count = store.sqlite.prepare("SELECT COUNT(*) as cnt FROM projects").get() as Record<string, number>;
    expect(count.cnt).toBe(0);
  });

  it("preserves active projects during soft delete", () => {
    insertReviewRun(store, {
      id: "run-1",
      eventId: "evt",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: new Date(),
    });

    const deleted = softDeleteMissingProjects(store, [
      { workspaceId: "ws-1", triggerName: "gitea", repoRef: "" },
    ]);
    expect(deleted).toBe(0);

    const projects = getProjectStats(store);
    expect(projects.length).toBe(1);
  });
});

describe("reflection memory", () => {
  it("creates the reflection_memory table via migration", () => {
    const tables = store.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as Record<string, string>).name);
    expect(tables).toContain("reflection_memory");
  });

  it("writes and reads reflection memory entries", async () => {
    const now = new Date();
    await writeReflectionMemory(store, [
      {
        workspaceId: "ws-1",
        fingerprint: "fp-1",
        content: "This project prefers early return patterns.",
        sourceRunId: "run-001",
        createdAt: now,
      },
    ]);

    const entries = await readReflectionMemory(store, "ws-1");
    expect(entries.length).toBe(1);
    expect(entries[0]!.content).toBe("This project prefers early return patterns.");
    expect(entries[0]!.fingerprint).toBe("fp-1");
    expect(entries[0]!.sourceRunId).toBe("run-001");
  });

  it("filters out expired entries on read", async () => {
    const now = new Date();
    await writeReflectionMemory(store, [
      {
        workspaceId: "ws-1",
        fingerprint: "fp-expired",
        content: "Old entry",
        createdAt: new Date(now.getTime() - 100_000),
        expiresAt: new Date(now.getTime() - 1),
      },
      {
        workspaceId: "ws-1",
        fingerprint: "fp-valid",
        content: "Valid entry",
        createdAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    ]);

    const entries = await readReflectionMemory(store, "ws-1");
    expect(entries.length).toBe(1);
    expect(entries[0]!.fingerprint).toBe("fp-valid");
  });

  it("compacts old entries beyond retention", async () => {
    const now = new Date();
    for (let i = 0; i < 10; i += 1) {
      await writeReflectionMemory(store, [
        {
          workspaceId: "ws-compact",
          fingerprint: `fp-${i}`,
          content: `Entry ${i}`,
          createdAt: now,
        },
      ]);
    }

    const deleted = await compactReflectionMemory(store, "ws-compact", {
      maxEntries: 3,
    });
    expect(deleted).toBe(7);

    const remaining = await readReflectionMemory(store, "ws-compact");
    expect(remaining.length).toBe(3);
  });
});
