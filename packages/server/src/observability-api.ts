import { Hono } from "hono";

import type { StoreDb } from "@aicr/store";
import {
  getOverviewStats,
  getProjectStats,
  getProviderModelStats,
  getRecentRuns,
  getRecentWebhookEvents,
  type TimeWindowStats,
  type ProjectStats,
  type ProviderModelStats,
  type RecentRunStats,
} from "@aicr/store";
import type { AutoCommitStore } from "@aicr/core";
import type { AdminAuthConfig } from "./admin-auth.js";
import {
  createAdminAuthMiddleware,
  createAdminSession,
  revokeAdminSession,
  type AdminAuthContext,
  type AdminSessionStore,
} from "./admin-auth.js";
import type { LiveRunRegistry } from "./live-runs.js";

export interface ObservabilityApiOptions {
  readonly store: StoreDb;
  readonly adminAuth: AdminAuthConfig;
  /** Durable admin sessions (P2): sha256-hashed, TTL-bound, multi-process. */
  readonly sessionStore: AdminSessionStore;
  readonly timezone?: string;
  /** Auto-commit receipt store; enables the receipt query endpoint. */
  readonly autoCommitStore?: AutoCommitStore;
  /** In-memory registry of currently running analyses; enables the live-runs endpoint. */
  readonly liveRuns?: LiveRunRegistry;
}

interface DashboardStats {
  overview: TimeWindowStats;
  today: TimeWindowStats;
  thisWeek: TimeWindowStats;
  thisMonth: TimeWindowStats;
  projects: ProjectStats[];
  providerModels: ProviderModelStats[];
  recentRuns: RecentRunStats[];
  timezone: string;
}

interface LoginFailureState {
  count: number;
  resetAt: number;
}

const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;

function getTimeWindows(): { today: Date; thisWeek: Date; thisMonth: Date } {
  const now = new Date();

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const thisWeek = new Date(today);
  thisWeek.setUTCDate(thisWeek.getUTCDate() - thisWeek.getUTCDay());

  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  return { today, thisWeek, thisMonth };
}

function parseSince(value: string | undefined): Date | undefined | null {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLimit(value: string | undefined): number {
  const parsed = value === undefined ? 20 : Number(value);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

function getLoginAttemptKey(username: string, forwardedFor: string | undefined): string {
  const client = forwardedFor?.split(",")[0]?.trim() || "unknown";
  return `${client}:${username.toLowerCase()}`;
}

export function createObservabilityApi(options: ObservabilityApiOptions): Hono {
  const api = new Hono();
  const authContext: AdminAuthContext = { config: options.adminAuth, sessions: options.sessionStore };
  const authMiddleware = createAdminAuthMiddleware(authContext);
  const loginFailures = new Map<string, LoginFailureState>();

  function isLoginRateLimited(key: string): boolean {
    const now = Date.now();
    const state = loginFailures.get(key);
    if (!state) return false;
    if (now >= state.resetAt) {
      loginFailures.delete(key);
      return false;
    }
    return state.count >= LOGIN_FAILURE_LIMIT;
  }

  function recordLoginFailure(key: string): void {
    const now = Date.now();
    const existing = loginFailures.get(key);
    if (!existing || now >= existing.resetAt) {
      loginFailures.set(key, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
      return;
    }
    existing.count += 1;
  }

  api.post("/login", async (c) => {
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({ username: "", password: "" }));

    if (!body.username || !body.password) {
      return c.json({ error: "bad_request", message: "username and password required" }, 400);
    }

    const loginAttemptKey = getLoginAttemptKey(body.username, c.req.header("x-forwarded-for"));
    if (isLoginRateLimited(loginAttemptKey)) {
      return c.json({ error: "rate_limited", message: "Too many failed login attempts" }, 429);
    }

    const session = await createAdminSession(authContext, body.username, body.password);
    if (!session) {
      recordLoginFailure(loginAttemptKey);
      return c.json({ error: "unauthorized", message: "Invalid credentials" }, 401);
    }

    loginFailures.delete(loginAttemptKey);

    return c.json({ token: session.token, expiresAt: session.expiresAt });
  });

  api.post("/logout", authMiddleware, async (c) => {
    const authorization = c.req.header("authorization");
    if (authorization) {
      const token = authorization.slice("bearer ".length);
      await revokeAdminSession(authContext, token);
    }
    return c.json({ ok: true });
  });

  api.get("/stats", authMiddleware, async (c) => {
    const tz = options.timezone ?? "UTC";
    const windows = getTimeWindows();

    const overview = await getOverviewStats(options.store);
    const today = await getOverviewStats(options.store, windows.today);
    const thisWeek = await getOverviewStats(options.store, windows.thisWeek);
    const thisMonth = await getOverviewStats(options.store, windows.thisMonth);
    const projects = await getProjectStats(options.store);
    const providerModels = await getProviderModelStats(options.store);
    const recentRuns = await getRecentRuns(options.store, 20);

    const result: DashboardStats = {
      overview,
      today,
      thisWeek,
      thisMonth,
      projects,
      providerModels,
      recentRuns,
      timezone: tz,
    };

    return c.json(result);
  });

  api.get("/stats/projects", authMiddleware, async (c) => {
    const sinceDate = parseSince(c.req.query("since"));
    if (sinceDate === null) {
      return c.json({ error: "bad_request", message: "since must be a valid date" }, 400);
    }
    const projects = await getProjectStats(options.store, sinceDate);
    return c.json(projects);
  });

  api.get("/stats/providers", authMiddleware, async (c) => {
    const sinceDate = parseSince(c.req.query("since"));
    if (sinceDate === null) {
      return c.json({ error: "bad_request", message: "since must be a valid date" }, 400);
    }
    const providers = await getProviderModelStats(options.store, sinceDate);
    return c.json(providers);
  });

  api.get("/runs", authMiddleware, async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const runs = await getRecentRuns(options.store, limit);
    return c.json(runs);
  });

  // Currently executing analyses from the in-process live-run registry.
  // Streaming agents report completed turns; other invocations report on exit.
  // Entries vanish on settle or restart; completed runs appear in /runs.
  api.get("/runs/live", authMiddleware, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      serverTime: new Date().toISOString(),
      runs: options.liveRuns?.list() ?? [],
    });
  });

  // Receipt-time webhook/trigger event log backing the dashboard Events
  // panel. Same retention contract as Recent Runs: the store keeps the
  // latest 100 entries and the client pages 20 per page.
  api.get("/events", authMiddleware, async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const events = await getRecentWebhookEvents(options.store, limit);
    return c.json(events);
  });


  if (options.autoCommitStore) {
    const autoCommitStore = options.autoCommitStore;
    // Receipt detail stays behind admin auth: it carries source identities
    // and routing fields that must not become a public high-cardinality
    api.get("/auto-commit/receipts/:id", authMiddleware, async (c) => {
      const receiptId = c.req.param("id");
      if (!receiptId) {
        return c.json({ error: "bad_request", message: "receipt id required" }, 400);
      }
      const result = await autoCommitStore.getReceipt(receiptId);
      if (!result) {
        return c.json({ error: "not_found", message: `unknown receipt ${receiptId}` }, 404);
      }
      return c.json(result);
    });
  }
  return api;
}
