import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStoreDb, closeStoreDb, type StoreDb, softDeleteMissingProjects } from "@aicr/store";
import { insertReviewRun, insertWebhookEvent } from "@aicr/store";
import type { ObservabilityApiOptions } from "../src/observability-api.js";
import { createObservabilityApi } from "../src/observability-api.js";
import { createLiveRunRegistry } from "../src/live-runs.js";
import type { AdminAuthConfig } from "../src/admin-auth.js";
import {
  computeSourceKey,
  computeStreamId,
  createMemoryAutoCommitStore,
  createMemoryConfigStore,
  resolveHistoryRetention,
} from "@aicr/core";

import { createAdminSession, type AdminAuthContext } from "../src/admin-auth.js";

let tmpDir: string;
let store: StoreDb;
let sessionStore: ReturnType<typeof createMemoryConfigStore>;
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

  sessionStore = createMemoryConfigStore();
  const options: ObservabilityApiOptions = {
    store,
    adminAuth: ADMIN_CONFIG,
    sessionStore,
  };

  app = createObservabilityApi(options);

  const authContext: AdminAuthContext = { config: ADMIN_CONFIG, sessions: sessionStore };
  const session = await createAdminSession(authContext, "admin", "test-password");
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
  it("returns bounded run/event pages with a lookahead and stable timestamp ties", async () => {
    const now = new Date();
    for (let i = 0; i < 25; i++) {
      await insertReviewRun(store, { id: `page-${String(i).padStart(2, "0")}`, eventId: "evt", workspaceId: "ws", triggerName: "github",
        provider: "test", providerModel: "test", status: "succeeded", startedAt: now });
      await insertWebhookEvent(store, { decision: "queued", reason: `event-${i}`, receivedAt: now });
    }
    for (const endpoint of ["runs", "events"]) {
      const first = await (await fetchApi(`/${endpoint}?page=1&limit=20`)).json();
      const second = await (await fetchApi(`/${endpoint}?page=2&limit=20`)).json();
      expect(first.items).toHaveLength(20);
      expect(first.hasMore).toBe(true);
      expect(second.items).toHaveLength(5);
      expect(second.hasMore).toBe(false);
      expect(new Set([...first.items, ...second.items].map((item: { id: string | number }) => item.id)).size).toBe(25);
      expect(await (await fetchApi(`/${endpoint}?page=3&limit=20`)).json()).toMatchObject({ items: [], hasMore: false });
      expect((await fetchApi(`/${endpoint}?page=-1`)).status).toBe(400);
      expect((await fetchApi(`/${endpoint}?page=1.5`)).status).toBe(400);
      expect(Array.isArray(await (await fetchApi(`/${endpoint}?limit=5`)).json())).toBe(true);
    }
  });

  it("runs history maintenance before reads without failing them, and bounds Queue pages by the retention policy", async () => {
    const maintenance = vi.fn(() => Promise.resolve());
    const batches = createMemoryAutoCommitStore();
    const now = Date.now();
    const seal = async (batchId: string, createdAt: number, terminal: "completed" | "running") => {
      const scopeRef = `refs/heads/${batchId}`;
      const sourceNamespace = "https://git.example.com/org/repo";
      const snapshot = {
        v: 1 as const, vcs: "git" as const, sourceNamespace, revision: "A1",
        fields: {
          authorName: { status: "known" as const, value: "dev" },
          authorEmail: { status: "known" as const, value: "dev@example.com" },
        },
        command: "git log", observedAt: createdAt, rulesVersion: "rules-v1",
        sourceKey: computeSourceKey(sourceNamespace, { vcs: "git", authorName: "dev", authorEmail: "dev@example.com" }),
        status: "known" as const,
      };
      const accepted = await batches.acceptReceipt({
        deliveryKey: `delivery-${batchId}`, workspaceId: "ws", triggerName: "gitea", provider: "gitea", vcs: "git",
        sourceNamespace, scopeRef, historyGeneration: 0,
        coverage: { kind: "range", base: "A0", head: "A1" }, envelope: { ref: scopeRef },
        delaySeconds: 0, policyVersion: "pol-1", now: createdAt,
      });
      const streamId = computeStreamId(accepted.receipt);
      await batches.applyMetadataPage({ streamId, receiptId: accepted.receipt.receiptId,
        members: [{ revision: "A1", orderKey: "000000000001", parents: [], sourceSnapshot: snapshot }], now: createdAt });
      const member = (await batches.readPendingMembers(streamId, null, 1)).items[0]!;
      await batches.applyExclusionVerdicts({ streamId,
        verdicts: [{ memberId: member.memberId, state: "allowed", policyVersion: "pol-1" }], now: createdAt });
      const reservation = await batches.acquireStreamReservation(streamId, "test", 60_000, createdAt);
      expect(await batches.sealBatch({ streamId, reservationToken: reservation!.token,
        expectedStreamVersion: reservation!.version, batchId, runId: `run-${batchId}`,
        members: [{ memberId: member.memberId, revision: "A1", sourceKey: snapshot.sourceKey }],
        base: "A0", head: "A1", sourceKey: snapshot.sourceKey,
        exclusionPolicyVersion: "rules-v1", configPolicyVersion: "pol-1", maxAttempts: 2, now: createdAt,
      })).toEqual({ kind: "sealed" });
      const claimed = await batches.claimDispatch(createdAt, "test", 1);
      await batches.confirmDispatch(batchId, claimed[0]!.claimToken, createdAt);
      const token = await batches.startBatchExecution(batchId, "test", 60_000, createdAt, { global: 10, workspace: 1 });
      if (terminal === "completed") await batches.completeBatch(batchId, token!, { outcome: "completed" }, createdAt);
      else await batches.checkpointBatchExecution(batchId, token!, {
        phase: "publication_pending",
        publication: {
          output: { problems: [], summaries: [{ markdown: "private analysis payload" }] },
          receipts: [{ channel: "report", status: "unknown", attempts: 1, updatedAt: createdAt }],
        },
      }, createdAt);
    };
    await seal("queue-aged-out", now - 400 * 86_400_000, "completed");
    await seal("queue-overflow", now - 1000, "completed");
    await seal("queue-kept", now, "completed");
    await seal("queue-active", now, "running");

    const historyApp = createObservabilityApi({
      store, adminAuth: ADMIN_CONFIG, sessionStore, autoCommitStore: batches,
      historyRetention: () => resolveHistoryRetention({ queue: { max_count: 1, max_age_months: 6 } }),
      beforeHistoryRead: maintenance,
    });
    const fetchHistory = (path: string) => historyApp.fetch(new Request(`http://localhost${path}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    }));

    const completed = await (await fetchHistory("/auto-commit/batches?status=completed&limit=10&page=1")).json();
    // Only the newest terminal batch inside the age window survives the policy;
    // the aged-out and over-count rows are invisible without any deletion.
    expect(completed.items.map((item: { batchId: string }) => item.batchId)).toEqual(["queue-kept"]);
    expect(completed.hasMore).toBe(false);
    const running = await (await fetchHistory("/auto-commit/batches?status=running&limit=10&page=1")).json();
    expect(running.items.map((item: { batchId: string }) => item.batchId)).toEqual(["queue-active"]);
    expect(running.items[0].publications).toEqual([{ channel: "report", status: "unknown", attempts: 1, updatedAt: now }]);
    expect(JSON.stringify(running)).not.toContain("private analysis payload");
    expect(completed.items[0].publications).toEqual([]);
    expect(maintenance).toHaveBeenCalledTimes(2);

    // The same hook guards Recent Runs and Events; a sweep failure degrades to
    // a warn log instead of failing the bounded read.
    maintenance.mockRejectedValue(new Error("sweep backend unavailable"));
    for (const path of ["/runs?page=1&limit=5", "/events?page=1&limit=5", "/auto-commit/batches?status=completed&limit=10&page=1"]) {
      const response = await fetchHistory(path);
      expect(response.status).toBe(200);
    }
    expect(maintenance).toHaveBeenCalledTimes(5);
  });

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
    const liveApp = createObservabilityApi({ store, adminAuth: ADMIN_CONFIG, sessionStore, liveRuns: registry });

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

describe("observability API without a stats store (P5 decoupling)", () => {
  it("login/logout and live runs work; stats endpoints report explicit unavailability (A04)", async () => {
    const sessionStoreOnly = createMemoryConfigStore();
    const app = createObservabilityApi({ adminAuth: ADMIN_CONFIG, sessionStore: sessionStoreOnly });
    try {
      const login = await app.request("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "test-password" }),
      });
      expect(login.status).toBe(200);
      const { token } = await login.json() as { token: string };

      const live = await app.request("/runs/live", { headers: { authorization: `Bearer ${token}` } });
      expect(live.status).toBe(200);
      expect(((await live.json()) as { runs: unknown[] }).runs).toEqual([]);

      for (const path of ["/stats", "/stats/projects", "/stats/providers", "/runs", "/events"]) {
        const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
        expect([path, response.status]).toEqual([path, 503]);
        const body = await response.json() as { error: string };
        expect(body.error).toBe("stats_unavailable");
      }
    } finally {
      await sessionStoreOnly.close();
    }
  });
});
