import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStoreDb, closeStoreDb, type StoreDb, softDeleteMissingProjects } from "@aicr/store";
import { insertReviewRun, insertWebhookEvent } from "@aicr/store";
import type { ObservabilityApiOptions } from "../src/observability-api.js";
import { createObservabilityApi } from "../src/observability-api.js";
import { createLiveRunRegistry } from "../src/live-runs.js";
import type { AdminAuthConfig } from "../src/admin-auth.js";
import { createAdminSession } from "../src/admin-auth.js";

let tmpDir: string;
let store: StoreDb;
let app: ReturnType<typeof createObservabilityApi>;
let authToken: string;

const ADMIN_CONFIG: AdminAuthConfig = {
  username: "admin",
  password: "test-password",
  sessionTtlSeconds: 3600,
};

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aicr-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  store = createStoreDb(join(tmpDir, "test.db"));

  const options: ObservabilityApiOptions = {
    store,
    adminAuth: ADMIN_CONFIG,
  };

  app = createObservabilityApi(options);

  const session = createAdminSession(ADMIN_CONFIG, "admin", "test-password");
  authToken = session!.token;
});

afterEach(() => {
  closeStoreDb(store);
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  const url = "http://localhost" + path;
  return app.fetch(new Request(url, {
    ...init,
    headers: {
      ...init?.headers,
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
  }));
}

describe("observability API", () => {
  it("POST /login returns token on valid credentials", async () => {
    const res = await fetchApi("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "" },
      body: JSON.stringify({ username: "admin", password: "test-password" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBeDefined();
  });

  it("POST /login rejects invalid credentials", async () => {
    const res = await fetchApi("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /login rate-limits repeated invalid credentials", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetchApi("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "", "X-Forwarded-For": "203.0.113.10" },
        body: JSON.stringify({ username: "admin", password: "wrong" }),
      });
      expect(res.status).toBe(401);
    }

    const limited = await fetchApi("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "", "X-Forwarded-For": "203.0.113.10" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(limited.status).toBe(429);
  });

  it("GET /stats returns dashboard data", async () => {
    insertReviewRun(store, {
      id: "run-1",
      eventId: "evt",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: "openai",
      providerModel: "gpt-4o",
      status: "succeeded",
      startedAt: new Date(),
      durationMs: 1000,
      problemCount: 2,
      llmUsages: [{
        providerId: "openai",
        modelId: "gpt-4o",
        tokensIn: 1000,
        tokensOut: 200,
        tokensTotal: 1200,
        cachedTokens: 600,
      }],
    });

    const res = await fetchApi("/stats");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.overview.reviewCount).toBe(1);
    expect(data.overview.cachedTokensInTotal).toBe(600);
    expect(data.overview.cacheCreationTokensTotal).toBe(0);
    expect(data.overview.problemTotal).toBe(2);
    expect(data.today).toBeDefined();
    expect(data.thisWeek).toBeDefined();
    expect(data.thisMonth).toBeDefined();
    expect(data.projects).toBeDefined();
    expect(data.providerModels).toBeDefined();
    expect(data.recentRuns).toBeDefined();
    expect(data.timezone).toBe("UTC");
  });

  it("GET /stats distinguishes time windows when runs span multiple windows", async () => {
    const day = 24 * 60 * 60 * 1000;
    insertReviewRun(store, {
      id: "old-run",
      eventId: "evt-old",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: new Date(Date.now() - 40 * day),
    });
    insertReviewRun(store, {
      id: "today-run",
      eventId: "evt-today",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: new Date(),
    });

    const res = await fetchApi("/stats");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.overview.reviewCount).toBe(2);
    expect(data.today.reviewCount).toBe(1);
    expect(data.thisMonth.reviewCount).toBe(1);
    expect(data.thisWeek.reviewCount).toBeLessThanOrEqual(data.overview.reviewCount);
  });

  it("GET /stats/projects includes soft-deleted projects marked inactive", async () => {
    insertReviewRun(store, {
      id: "run-1",
      eventId: "evt",
      workspaceId: "ws-1",
      triggerName: "gitea",
      repoRef: "owner/repo",
      provider: null,
      providerModel: null,
      status: "succeeded",
      startedAt: new Date(),
    });

    softDeleteMissingProjects(store, []);

    const res = await fetchApi("/stats/projects");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].workspaceId).toBe("ws-1");
    expect(data[0].isActive).toBe(false);

    const statsRes = await fetchApi("/stats");
    const stats = await statsRes.json();
    expect(stats.overview.reviewCount).toBe(1);
    expect(stats.projects.length).toBe(1);
    expect(stats.recentRuns.length).toBe(1);
  });

  it("GET /stats rejects unauthenticated requests", async () => {
    authToken = "";
    const res = await fetchApi("/stats");
    expect(res.status).toBe(401);
  });

  it("GET /stats/projects returns project list", async () => {
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

    const res = await fetchApi("/stats/projects");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].workspaceId).toBe("ws-1");
  });

  it("GET /stats/projects rejects invalid since query", async () => {
    const res = await fetchApi("/stats/projects?since=not-a-date");
    expect(res.status).toBe(400);
  });

  it("GET /stats/providers returns provider stats", async () => {
    insertReviewRun(store, {
      id: "run-1",
      eventId: "evt",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: "openai",
      providerModel: "gpt-4o",
      status: "succeeded",
      startedAt: new Date(),
      llmUsages: [{
        providerId: "openai",
        modelId: "gpt-4o",
        tokensIn: 100,
        tokensOut: 50,
        tokensTotal: 150,
        cachedTokens: 40,
        cacheCreationTokens: 10,
      }],
    });

    const res = await fetchApi("/stats/providers");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].providerId).toBe("openai");
    expect(data[0].cachedTokensIn).toBe(40);
    expect(data[0].cacheCreationTokens).toBe(10);
  });

  it("GET /stats/providers filters provider stats by since query", async () => {
    insertReviewRun(store, {
      id: "run-old",
      eventId: "evt-old",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: "openai",
      providerModel: "gpt-4o",
      status: "succeeded",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      llmUsages: [{
        providerId: "openai",
        modelId: "gpt-4o",
        tokensIn: 100,
        tokensOut: 50,
        tokensTotal: 150,
      }],
    });
    insertReviewRun(store, {
      id: "run-recent",
      eventId: "evt-recent",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: "openai",
      providerModel: "gpt-4o",
      status: "succeeded",
      startedAt: new Date("2026-01-03T00:00:00Z"),
      llmUsages: [{
        providerId: "openai",
        modelId: "gpt-4o",
        tokensIn: 500,
        tokensOut: 200,
        tokensTotal: 700,
      }],
    });

    const since = encodeURIComponent("2026-01-02T00:00:00Z");
    const res = await fetchApi(`/stats/providers?since=${since}`);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].requestCount).toBe(1);
    expect(data[0].tokensTotal).toBe(700);
  });

  it("GET /stats/providers rejects invalid since query", async () => {
    const res = await fetchApi("/stats/providers?since=not-a-date");
    expect(res.status).toBe(400);
  });

  it("GET /runs returns recent runs", async () => {
    insertReviewRun(store, {
      id: "run-1",
      eventId: "evt",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: "openai",
      providerModel: "gpt-4o",
      status: "succeeded",
      startedAt: new Date(),
      llmUsages: [{
        providerId: "openai",
        modelId: "gpt-4o",
        tokensIn: 1000,
        tokensOut: 200,
        tokensTotal: 1200,
        cachedTokens: 600,
      }],
    });

    const res = await fetchApi("/runs");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].id).toBe("run-1");
    expect(data[0].llmUsage).toEqual({
      tokensIn: 1000,
      tokensOut: 200,
      tokensTotal: 1200,
      cachedTokens: 600,
      cacheCreationTokens: 0,
    });
  });

  it("GET /runs exposes branch, revision, VCS kind and commit time", async () => {
    const committed = new Date("2026-09-10T08:00:00.000Z");
    insertReviewRun(store, {
      id: "run-vcs",
      eventId: "evt",
      workspaceId: "ws-1",
      triggerName: "gitea",
      provider: "openai",
      providerModel: "gpt-4o",
      status: "succeeded",
      startedAt: new Date(),
      branch: "main",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      vcsKind: "git",
      headCommittedAt: committed,
    });

    const res = await fetchApi("/runs");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].branch).toBe("main");
    expect(data[0].headSha).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(data[0].vcsKind).toBe("git");
    expect(data[0].headCommittedAt).toBe(committed.toISOString());
  });

  it("GET /runs/live returns registry entries with server time", async () => {
    const registry = createLiveRunRegistry();
    const executionId = registry.start({
      runId: "live-1",
      source: "auto_commit",
      provider: "gitea",
      eventName: "push",
      workspaceId: "ws-1",
      triggerName: "nightly",
      repoRef: "org/repo",
      targetKind: "push",
      branch: "main",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      vcsKind: "git",
      modelProviderId: "openai",
      modelId: "gpt-4o",
      agentKind: "opencode",
      attempt: 2,
    });
    registry.update(executionId, {
      phase: "analyzing",
      promptTokenEstimate: 5000,
      headCommittedAt: "2026-09-10T08:00:00.000Z",
      metrics: { promptTokens: 1000, totalTokens: 1200, cachedPromptTokens: 600, requestCount: 3 },
    });
    const liveApp = createObservabilityApi({ store, adminAuth: ADMIN_CONFIG, liveRuns: registry });

    const res = await liveApp.fetch(new Request("http://localhost/runs/live", {
      headers: { Authorization: `Bearer ${authToken}` },
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.serverTime).toBeDefined();
    expect(data.runs.length).toBe(1);
    expect(data.runs[0].runId).toBe("live-1");
    expect(data.runs[0].executionId).toBe(executionId);
    expect(data.runs[0].workerId).toBe(1);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(data.runs[0].source).toBe("auto_commit");
    expect(data.runs[0].phase).toBe("analyzing");
    expect(data.runs[0].branch).toBe("main");
    expect(data.runs[0].vcsKind).toBe("git");
    expect(data.runs[0].headCommittedAt).toBe("2026-09-10T08:00:00.000Z");
    expect(data.runs[0].attempt).toBe(2);
    expect(data.runs[0].promptTokenEstimate).toBe(5000);
    expect(data.runs[0].metrics).toEqual({ promptTokens: 1000, totalTokens: 1200, cachedPromptTokens: 600, requestCount: 3 });

    registry.finish(executionId);
    const empty = await liveApp.fetch(new Request("http://localhost/runs/live", {
      headers: { Authorization: `Bearer ${authToken}` },
    }));
    expect((await empty.json()).runs).toEqual([]);
  });

  it("GET /runs/live returns an empty list without a registry", async () => {
    const res = await fetchApi("/runs/live");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.runs).toEqual([]);
    expect(data.serverTime).toBeDefined();
  });

  it("GET /runs/live requires auth", async () => {
    const res = await app.fetch(new Request("http://localhost/runs/live"));
    expect(res.status).toBe(401);
  });

  it("GET /runs clamps invalid limits to the default", async () => {
    for (let i = 0; i < 25; i++) {
      insertReviewRun(store, {
        id: `run-${i}`,
        eventId: `evt-${i}`,
        workspaceId: "ws-1",
        triggerName: "gitea",
        provider: null,
        providerModel: null,
        status: "succeeded",
        startedAt: new Date(Date.now() - i),
      });
    }

    const res = await fetchApi("/runs?limit=not-a-number");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(20);
  });

  it("GET /events returns recent webhook events newest-first with parsed detail", async () => {
    insertWebhookEvent(store, {
      receivedAt: new Date(1_000),
      provider: "gitea",
      eventName: "pull_request",
      workspaceId: "ws-1",
      triggerName: "gitea-main",
      repoRef: "owent/example",
      targetKind: "pull_request",
      decision: "deferred",
      reason: "execution_window",
      detail: { resumeAt: "2026-09-14T12:00:00.000Z" },
    });
    insertWebhookEvent(store, {
      receivedAt: new Date(2_000),
      provider: "github",
      eventName: "pull_request",
      decision: "rejected",
      reason: "invalid_signature",
    });

    const res = await fetchApi("/events");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].provider).toBe("github");
    expect(data[0].decision).toBe("rejected");
    expect(data[0].detail).toBeNull();
    expect(data[1].decision).toBe("deferred");
    expect(data[1].reason).toBe("execution_window");
    expect(data[1].detail).toEqual({ resumeAt: "2026-09-14T12:00:00.000Z" });
  });

  it("GET /events clamps limits like /runs", async () => {
    for (let i = 0; i < 30; i++) {
      insertWebhookEvent(store, {
        receivedAt: new Date(i),
        provider: "gitlab",
        decision: "executed",
      });
    }

    const res = await fetchApi("/events?limit=not-a-number");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(20);
  });

  it("GET /events requires auth", async () => {
    const res = await app.fetch(new Request("http://localhost/events"));
    expect(res.status).toBe(401);
  });
});
