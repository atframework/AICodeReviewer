import { Hono } from "hono";

import type { StoreDb } from "@aicr/store";
import {
  deleteReviewRun,
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
  /**
   * Business stats store. Optional since P5: login/session and the live-run
   * view work without it, and config management never needed it. The stats,
   * runs, projects, providers, and events endpoints register only when a
   * store is present (A04: availability must be explicit, not a crash).
   */
  readonly store?: StoreDb;
  readonly adminAuth: AdminAuthConfig;
  /** Durable admin sessions (P2): sha256-hashed, TTL-bound, multi-process. */
  readonly sessionStore: AdminSessionStore;
  readonly timezone?: string;
  /**
   * Current admission config snapshot id, supplied when dynamic config is
   * enabled: manual batch retries pin to it so re-armed executions pick up
   * settings changed since the batch's original admission.
   */
  readonly currentConfigSnapshotId?: () => string | null;
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

function statsUnavailable(c: { json(body: unknown, status: 503): Response }): Response {
  return c.json({ error: "stats_unavailable", message: "The stats store is not configured on this deployment; login, config management, and live runs remain available." }, 503);
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
      const token = authorization.slice(7);
      await revokeAdminSession(authContext, token);
    }
    return c.json({ ok: true });
  });

  if (!options.store) {
    api.get("/stats", authMiddleware, (c) => statsUnavailable(c));
    api.get("/stats/projects", authMiddleware, (c) => statsUnavailable(c));
    api.get("/stats/providers", authMiddleware, (c) => statsUnavailable(c));
    api.get("/runs", authMiddleware, (c) => statsUnavailable(c));
    api.get("/events", authMiddleware, (c) => statsUnavailable(c));
  } else {
    const store = options.store;
    api.get("/stats", authMiddleware, async (c) => {
    const tz = options.timezone ?? "UTC";
    const windows = getTimeWindows();

    const overview = await getOverviewStats(store);
    const today = await getOverviewStats(store, windows.today);
    const thisWeek = await getOverviewStats(store, windows.thisWeek);
    const thisMonth = await getOverviewStats(store, windows.thisMonth);
    const projects = await getProjectStats(store);
    const providerModels = await getProviderModelStats(store);
    const recentRuns = await getRecentRuns(store, 20);

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
    const projects = await getProjectStats(store, sinceDate);
    return c.json(projects);
  });

  api.get("/stats/providers", authMiddleware, async (c) => {
    const sinceDate = parseSince(c.req.query("since"));
    if (sinceDate === null) {
      return c.json({ error: "bad_request", message: "since must be a valid date" }, 400);
    }
    const providers = await getProviderModelStats(store, sinceDate);
    return c.json(providers);
  });

  api.get("/runs", authMiddleware, async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const runs = await getRecentRuns(store, limit);
    return c.json(runs);
  });

  // Receipt-time webhook/trigger event log backing the dashboard Events
  // panel. Same retention contract as Recent Runs: the store keeps the
  // latest 100 entries and the client pages 20 per page.
  api.get("/events", authMiddleware, async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const events = await getRecentWebhookEvents(store, limit);
    return c.json(events);
  });
  }

  // Currently executing analyses from the in-process live-run registry.
  // Streaming agents report completed turns; other invocations report on exit.
  // Entries vanish on settle or restart; completed runs appear in /runs.
  // Store-independent: works without a stats backend (P5 decoupling).
  api.get("/runs/live", authMiddleware, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      serverTime: new Date().toISOString(),
      runs: options.liveRuns?.list() ?? [],
    });
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

    // Auto-commit batch listing for the dashboard Queue tab: stuck/terminal
    // batches by status. Bounded to the retention window of interest.
    api.get("/auto-commit/batches", authMiddleware, async (c) => {
      const statusParam = c.req.query("status");
      const allowed = ["dead", "skipped", "retry_wait", "dispatch_pending", "queued", "running", "completed"] as const;
      const statuses = (statusParam ?? "dead,skipped")
        .split(",")
        .map((value) => value.trim())
        .filter((value): value is (typeof allowed)[number] =>
          (allowed as readonly string[]).includes(value),
        );
      if (statuses.length === 0) {
        return c.json({ error: "bad_request", message: "status filter must name at least one known batch status" }, 400);
      }
      const limit = parseLimit(c.req.query("limit"));
      const batches = await autoCommitStore.readBatchesByStatus(statuses, limit);
      return c.json(
        batches.map((batch) => ({
          batchId: batch.batchId,
          runId: batch.runId,
          streamId: batch.streamId,
          workspaceId: batch.workspaceId,
          vcs: batch.vcs,
          status: batch.status,
          attempt: batch.attempt,
          maxAttempts: batch.maxAttempts,
          recoveryAttempt: batch.recoveryAttempt,
          base: batch.base,
          head: batch.head,
          memberCount: batch.members.length,
          retryNotBefore: batch.retryNotBefore,
          lastError: batch.lastError,
          createdAt: batch.createdAt,
        })),
      );
    });

    // Manual retry (P1 dead-batch recovery): re-arm a terminal batch with a
    // fresh attempt budget and release its stream. CAS on the terminal
    // status; audited through the structured log (admin surface is
    // session-authenticated and single-operator).
    api.post("/auto-commit/batches/:id/retry", authMiddleware, async (c) => {
      const batchId = c.req.param("id");
      if (!batchId) {
        return c.json({ error: "bad_request", message: "batch id required" }, 400);
      }
      const existing = await autoCommitStore.readBatch(batchId);
      if (!existing) {
        return c.json({ error: "not_found", message: `unknown batch ${batchId}` }, 404);
      }
      if (existing.status !== "dead" && existing.status !== "skipped") {
        return c.json(
          {
            error: "conflict",
            message: `batch ${batchId} is '${existing.status}'; only terminal dead/skipped batches can be re-armed`,
          },
          409,
        );
      }
      const requeued = await autoCommitStore.requeueBatchForRecovery(
        batchId,
        Date.now(),
        // Pin the retry to the CURRENT admission generation so the re-armed
        // execution picks up settings changed since the original admission.
        options.currentConfigSnapshotId?.() ?? null,
      );
      if (!requeued) {
        return c.json(
          {
            error: "conflict",
            message: `batch ${batchId} could not re-arm: its stream is currently held by another batch; retry after that batch settles`,
          },
          409,
        );
      }
      // Drop the terminal-failure marker run row (if any) so the retried
      // execution can record its own outcome under the same run id; Recent
      // Runs never shows a stale rejection next to the fresh retry.
      let clearedRejectionMarker = false;
      if (options.store) {
        clearedRejectionMarker = await deleteReviewRun(options.store, requeued.runId).catch(() => false);
      }
      console.warn(JSON.stringify({
        level: "warn",
        msg: "admin manual retry re-armed auto-commit batch",
        batchId,
        workspaceId: requeued.workspaceId,
        streamId: requeued.streamId,
        previousStatus: existing.status,
        previousError: existing.lastError,
        clearedRejectionMarker,
      }));
      return c.json({
        ok: true,
        clearedRejectionMarker,
        batch: {
          batchId: requeued.batchId,
          status: requeued.status,
          attempt: requeued.attempt,
          maxAttempts: requeued.maxAttempts,
          recoveryAttempt: requeued.recoveryAttempt,
          retryNotBefore: requeued.retryNotBefore,
        },
      });
    });
  }
  return api;
}
