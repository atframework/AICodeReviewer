import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStoreDb, closeStoreDb, type StoreDb } from "@aicr/store";
import { insertReviewRun } from "@aicr/store";
import type { ObservabilityApiOptions } from "../src/observability-api.js";
import { createObservabilityApi } from "../src/observability-api.js";
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
    });

    const res = await fetchApi("/stats");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.overview.reviewCount).toBe(1);
    expect(data.overview.problemTotal).toBe(2);
    expect(data.today).toBeDefined();
    expect(data.thisWeek).toBeDefined();
    expect(data.thisMonth).toBeDefined();
    expect(data.projects).toBeDefined();
    expect(data.providerModels).toBeDefined();
    expect(data.recentRuns).toBeDefined();
    expect(data.timezone).toBe("UTC");
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
      }],
    });

    const res = await fetchApi("/stats/providers");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].providerId).toBe("openai");
  });

  it("GET /runs returns recent runs", async () => {
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

    const res = await fetchApi("/runs");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].id).toBe("run-1");
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
});
