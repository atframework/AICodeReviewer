import { createHmac } from "node:crypto";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  compileWeeklySchedule,
  createMemoryAutoCommitStore,
  type CompiledWeeklySchedule,
} from "@aicr/core";
import {
  createStoreDb,
  closeStoreDb,
  getRecentWebhookEvents,
  listPendingReviewDeferrals,
  upsertReviewDeferral,
  claimReviewDeferral,
  type StoreDb,
} from "@aicr/store";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoCommitRuntime, createServerApp } from "../src/index.js";
import { ReviewDeferralManager, computeDeferralKey } from "../src/deferral-manager.js";
import { createReviewDeduplicator } from "../src/review-deduplicator.js";
import type { ReviewOutputPublisher } from "../src/review-orchestrator.js";

const webhookSecret = "top-secret";

function sign(payload: string): string {
  return createHmac("sha256", webhookSecret).update(payload).digest("hex");
}

/**
 * Weekday 12:00–13:40 UTC only. Friday 2026-09-11 14:00 UTC is outside; the
 * next allowed instant is Monday 2026-09-14 12:00:00.000 UTC.
 */
const WEEKDAY_LUNCH_SCHEDULE = compileWeeklySchedule({
  timezone: "UTC",
  rules: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      windows: [{ start: "12:00", end: "13:40" }],
    },
  ],
});

const FRIDAY_AFTER_WINDOW = "2026-09-11T14:00:00.000Z";
const MONDAY_WINDOW_OPEN = "2026-09-14T12:00:00.000Z";
const FRIDAY_TO_MONDAY_MS = Date.parse(MONDAY_WINDOW_OPEN) - Date.parse(FRIDAY_AFTER_WINDOW);

function weekdayLunchSchedule(_workspaceId: string): CompiledWeeklySchedule {
  return WEEKDAY_LUNCH_SCHEDULE;
}

function giteaPrPayload(headSha = "head-sha"): string {
  return JSON.stringify({
    action: "opened",
    repository: { full_name: "owent/example" },
    sender: { login: "owent" },
    pull_request: {
      html_url: "https://gitea.internal.corp/owent/example/pulls/42",
      base: { sha: "base-sha" },
      head: { sha: headSha, ref: "feature-42" },
    },
  });
}

function giteaCommentReviewPayload(): string {
  return JSON.stringify({
    action: "created",
    repository: { full_name: "owent/example" },
    sender: { login: "owent" },
    issue: {
      number: 42,
      title: "Example PR",
      pull_request: {
        url: "https://gitea.internal.corp/api/v1/repos/owent/example/pulls/42",
        html_url: "https://gitea.internal.corp/owent/example/pulls/42",
      },
      labels: [],
    },
    comment: { body: "/aicr review", user: { login: "owent" } },
  });
}

function giteaPushPayload(): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    before: "1111111111111111111111111111111111111111",
    after: "2222222222222222222222222222222222222222",
    repository: { full_name: "owent/example" },
    pusher: { login: "owent", email: "owent@example.com" },
    commits: [{ id: "2222222222222222222222222222222222222222" }],
  });
}

function postGitea(app: Hono, payload: string, event: string): Promise<Response> {
  return app.request("/webhooks/gitea", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitea-event": event,
      "x-gitea-signature": sign(payload),
    },
    body: payload,
  });
}

let tmpDir: string;
let store: StoreDb;

beforeEach(() => {
  tmpDir = join(tmpdir(), `aicr-deferral-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  store = createStoreDb(join(tmpDir, "test.db"));
});

afterEach(async () => {
  (await closeStoreDb(store));
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("persistent review deferrals", () => {
  it("persists a window-deferred event, records it, and resumes at the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        deduplicator: createReviewDeduplicator(),
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
        deferralManager: new ReviewDeferralManager({ store }),
        store,
      });

      const response = await postGitea(app, giteaPrPayload(), "pull_request");
      const body = (await response.json()) as { processing?: { status?: string; resumeAt?: string } };

      expect(response.status).toBe(202);
      expect(body.processing?.status).toBe("deferred");
      expect(body.processing?.resumeAt).toBe(MONDAY_WINDOW_OPEN);

      const pending = (await listPendingReviewDeferrals(store));
      expect(pending).toHaveLength(1);
      expect(pending[0]!.notBefore.getTime()).toBe(Date.parse(MONDAY_WINDOW_OPEN));
      expect(pending[0]!.reviewEvent).toContain("feature-42");

      const events = (await getRecentWebhookEvents(store, 10));
      expect(events).toHaveLength(1);
      expect(events[0]!.decision).toBe("deferred");
      expect(events[0]!.reason).toBe("execution_window");
      expect(events[0]!.workspaceId).toBe("ws");
      expect((events[0]!.detail as { resumeAt?: string }).resumeAt).toBe(MONDAY_WINDOW_OPEN);

      const updated = await postGitea(app, giteaPrPayload("latest-head"), "pull_request");
      expect((await updated.json() as { processing: { status: string } }).processing.status).toBe("deferred");
      expect((await listPendingReviewDeferrals(store))).toHaveLength(1);
      expect((await listPendingReviewDeferrals(store))[0]!.reviewEvent).toContain("latest-head");

      await vi.advanceTimersByTimeAsync(FRIDAY_TO_MONDAY_MS);
      await vi.runOnlyPendingTimersAsync();

      expect(sourceRootResolver).toHaveBeenCalledTimes(1);
      expect(sourceRootResolver.mock.calls[0]?.[0]).toMatchObject({ headSha: "latest-head" });
      expect((await listPendingReviewDeferrals(store))).toHaveLength(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("recovers pending and claimed deferrals on startup", async () => {
    const reviewEvent = JSON.parse(giteaPrPayload()) as Record<string, unknown>;
    const baseEvent = {
      triggerName: "gitea-internal",
      provider: "gitea",
      workspaceId: "ws",
      targetKind: "pull_request",
      repoRef: "owent/example",
      reason: "gitea:opened",
      author: {},
    };
    const pendingEvent = {
      ...baseEvent,
      url: "https://gitea.internal.corp/owent/example/pulls/42",
      branch: "feature-42",
    };
    const claimedEvent = {
      ...baseEvent,
      url: "https://gitea.internal.corp/owent/example/pulls/43",
      branch: "feature-43",
    };
    (await upsertReviewDeferral(store, {
      dedupKey: computeDeferralKey(pendingEvent as never),
      workspaceId: "ws",
      provider: "gitea",
      eventName: "pull_request",
      reviewEvent: JSON.stringify(pendingEvent),
      payload: JSON.stringify(reviewEvent),
      notBefore: new Date(Date.parse(MONDAY_WINDOW_OPEN)),
    }));
    (await upsertReviewDeferral(store, {
      dedupKey: computeDeferralKey(claimedEvent as never),
      workspaceId: "ws",
      provider: "gitea",
      eventName: "pull_request",
      reviewEvent: JSON.stringify(claimedEvent),
      payload: JSON.stringify(reviewEvent),
      notBefore: new Date(Date.parse(MONDAY_WINDOW_OPEN)),
    }));
    // Simulate a process that stopped mid-resume: claimed but never executed.
    expect((await claimReviewDeferral(store, computeDeferralKey(claimedEvent as never)))).toBeDefined();

    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const seen: string[] = [];
    const sourceRootResolver = vi.fn().mockImplementation((event: { branch?: string }) => {
      seen.push(event.branch ?? "");
      return undefined;
    });
    try {
      createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
        deferralManager: new ReviewDeferralManager({ store }),
        store,
      });

      // Recovery runs through the async store queue; flush the microtask chain.
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }

      const recoveryLog = infoSpy.mock.calls
        .map(([entry]) => entry)
        .find((entry) => typeof entry === "string" && entry.includes("recovered review deferrals"));
      expect(recoveryLog).toBeDefined();
      expect(recoveryLog).toContain('"resetClaimed":1');
      expect(recoveryLog).toContain('"pending":2');

      await vi.advanceTimersByTimeAsync(FRIDAY_TO_MONDAY_MS);
      await vi.runOnlyPendingTimersAsync();

      expect(seen.sort()).toEqual(["feature-42", "feature-43"]);
      expect((await listPendingReviewDeferrals(store))).toHaveLength(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("drops a pending deferral when a fresh in-window event supersedes it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
        deferralManager: new ReviewDeferralManager({ store }),
        store,
      });

      await postGitea(app, giteaPrPayload("old-head"), "pull_request");
      expect((await listPendingReviewDeferrals(store))).toHaveLength(1);

      // The window opens and a newer event for the same PR arrives before the
      // deferral timer had a chance to fire.
      vi.setSystemTime(Date.parse(MONDAY_WINDOW_OPEN));
      const response = await postGitea(app, giteaPrPayload("new-head"), "pull_request");
      expect(response.status).toBe(202);
      expect((await listPendingReviewDeferrals(store))).toHaveLength(0);

      await vi.runOnlyPendingTimersAsync();
      // Exactly one execution: the fresh event. The stale deferral is gone.
      expect(sourceRootResolver).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("replaces the stored envelope when another event arrives while deferred", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const seen: string[] = [];
    const sourceRootResolver = vi.fn().mockImplementation((event: { headSha?: string }) => {
      seen.push(event.headSha ?? "");
      return undefined;
    });
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
        deferralManager: new ReviewDeferralManager({ store }),
        store,
      });

      await postGitea(app, giteaPrPayload("old-head"), "pull_request");
      await postGitea(app, giteaPrPayload("new-head"), "pull_request");

      const pending = (await listPendingReviewDeferrals(store));
      expect(pending).toHaveLength(1);
      expect(pending[0]!.reviewEvent).toContain("new-head");

      await vi.advanceTimersByTimeAsync(FRIDAY_TO_MONDAY_MS);
      await vi.runOnlyPendingTimersAsync();
      expect(seen).toEqual(["new-head"]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("replies on the PR when a comment-command review is deferred", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    const publishSummary = vi.fn().mockResolvedValue(undefined);
    const outputPublisher: ReviewOutputPublisher = { publishSummary } as never;
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        reviewOrchestration: { outputPublisher } as never,
        getExecutionSchedule: weekdayLunchSchedule,
        deferralManager: new ReviewDeferralManager({ store }),
        store,
      });

      const response = await postGitea(app, giteaCommentReviewPayload(), "issue_comment");
      expect(response.status).toBe(202);

      // The notice publish is fire-and-forget; flush the microtask chain.
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }

      expect(publishSummary).toHaveBeenCalledTimes(1);
      const [summary, , options] = publishSummary.mock.calls[0] as [string, unknown, { bypassNoProblemsPolicy?: boolean }];
      expect(summary).toContain("review deferred");
      expect(summary).toContain(MONDAY_WINDOW_OPEN);
      expect(options.bypassNoProblemsPolicy).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("does not reply for automatic pull_request events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    const publishSummary = vi.fn().mockResolvedValue(undefined);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        reviewOrchestration: { outputPublisher: { publishSummary } } as never,
        getExecutionSchedule: weekdayLunchSchedule,
        deferralManager: new ReviewDeferralManager({ store }),
        store,
      });

      await postGitea(app, giteaPrPayload(), "pull_request");
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
      expect(publishSummary).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("defers in memory without a store and still resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
        deferralManager: new ReviewDeferralManager({}),
      });

      const response = await postGitea(app, giteaPrPayload(), "pull_request");
      expect(response.status).toBe(202);

      await vi.advanceTimersByTimeAsync(FRIDAY_TO_MONDAY_MS);
      await vi.runOnlyPendingTimersAsync();
      expect(sourceRootResolver).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });
});

describe("webhook event recording", () => {
  it("records rejected, ignored, executed, and queued decisions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-11T13:00:00.000Z")); // inside the window
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    const autoCommitStore = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({ store: autoCommitStore, getPolicyLayers: () => ({}) });
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        autoCommit: runtime,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
        store,
      });

      // invalid signature → rejected
      await app.request("/webhooks/gitea", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitea-event": "pull_request",
          "x-gitea-signature": "bad",
        },
        body: giteaPrPayload(),
      });
      // unsupported event name → ignored
      await postGitea(app, JSON.stringify({ repository: { full_name: "owent/example" } }), "fork");
      // executed in-window → executed
      await postGitea(app, giteaPrPayload(), "pull_request");
      // push on the auto-commit path → queued
      await postGitea(app, giteaPushPayload(), "push");
      await vi.runOnlyPendingTimersAsync();

      const events = (await getRecentWebhookEvents(store, 10));
      const decisions = events.map((event) => `${event.decision}:${event.reason ?? ""}`);
      expect(decisions).toEqual([
        "queued:",
        "executed:",
        "ignored:unsupported_event",
        "rejected:invalid_signature",
      ]);
      const queued = events[0]!;
      expect((queued.detail as { receiptId?: string }).receiptId).toBeDefined();
      expect((queued.detail as { notBefore?: string }).notBefore).toBeDefined();
      const executed = events[1]!;
      expect((executed.detail as { mode?: string; runId?: string }).mode).toBe("background");
      expect((executed.detail as { runId?: string }).runId).toBeDefined();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("records ignored_by_label with the matched labels", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-11T13:00:00.000Z"));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewOrchestration: { ignoreLabelsResolver: () => ["wip"] } as never,
        store,
      });

      const payload = JSON.stringify({
        action: "opened",
        repository: { full_name: "owent/example" },
        sender: { login: "owent" },
        pull_request: {
          html_url: "https://gitea.internal.corp/owent/example/pulls/42",
          base: { sha: "base-sha" },
          head: { sha: "head-sha", ref: "feature-42" },
          labels: [{ name: "wip" }],
        },
      });
      const response = await postGitea(app, payload, "pull_request");
      expect(response.status).toBe(200);

      const events = (await getRecentWebhookEvents(store, 10));
      expect(events).toHaveLength(1);
      expect(events[0]!.decision).toBe("ignored");
      expect(events[0]!.reason).toBe("ignored_by_label");
      expect((events[0]!.detail as { matchedLabels?: string[] }).matchedLabels).toEqual(["wip"]);
      expect(events[0]!.workspaceId).toBe("ws");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });
});
