import { createHmac } from "node:crypto";

import {
  compileWeeklySchedule,
  createMemoryAutoCommitStore,
  type CompiledWeeklySchedule,
} from "@aicr/core";
import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { AutoCommitRuntime, createServerApp } from "../src/index.js";
import { createReviewDeduplicator } from "../src/review-deduplicator.js";

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

/** Shared resolver: every workspace gets the weekday-lunch schedule. */
function weekdayLunchSchedule(_workspaceId: string): CompiledWeeklySchedule {
  return WEEKDAY_LUNCH_SCHEDULE;
}

function giteaPrPayload(): string {
  return JSON.stringify({
    action: "opened",
    repository: { full_name: "owent/example" },
    sender: { login: "owent" },
    pull_request: {
      html_url: "https://gitea.internal.corp/owent/example/pulls/42",
      base: { sha: "base-sha" },
      head: { sha: "head-sha" },
    },
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

describe("execution window gating for async trigger processing", () => {
  it.each([false, true])("rechecks the actual start after a clock jump (retry=%s)", async (retry) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-11T13:00:00Z"));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    if (retry) sourceRootResolver.mockImplementationOnce(() => { throw new Error("ECONNRESET"); });
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
        triggerRetry: { attempts: 2, backoff: { base_ms: 100, max_ms: 100, jitter: false } },
      });
      await postGitea(app, giteaPrPayload(), "pull_request");
      if (retry) await vi.advanceTimersByTimeAsync(1);
      vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
      await vi.advanceTimersByTimeAsync(100);
      expect(sourceRootResolver).toHaveBeenCalledTimes(retry ? 1 : 0);
      await vi.advanceTimersByTimeAsync(FRIDAY_TO_MONDAY_MS - 100);
      expect(sourceRootResolver).toHaveBeenCalledTimes(retry ? 2 : 1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("defers a pull_request event to the next window and logs the resume instant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    const getExecutionSchedule = vi.fn(weekdayLunchSchedule);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule,
      });

      const response = await postGitea(app, giteaPrPayload(), "pull_request");

      expect(response.status).toBe(202);
      expect(getExecutionSchedule).toHaveBeenCalledWith("ws", "pull_request");
      expect(sourceRootResolver).not.toHaveBeenCalled();
      const deferralLog = infoSpy.mock.calls
        .map(([entry]) => entry)
        .find((entry) => typeof entry === "string" && entry.includes("deferred by execution window"));
      expect(deferralLog).toBeDefined();
      expect(deferralLog).toContain(`"deferMs":${FRIDAY_TO_MONDAY_MS}`);
      expect(deferralLog).toContain(`"resumeAt":"${MONDAY_WINDOW_OPEN}"`);

      // Still nothing one millisecond before the window opens.
      await vi.advanceTimersByTimeAsync(FRIDAY_TO_MONDAY_MS - 1);
      expect(sourceRootResolver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(sourceRootResolver).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("runs a pull_request event immediately inside the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-11T13:00:00.000Z")); // Friday, inside 12:00–13:40
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
      });

      const response = await postGitea(app, giteaPrPayload(), "pull_request");

      expect(response.status).toBe(202);
      await vi.runOnlyPendingTimersAsync();
      expect(sourceRootResolver).toHaveBeenCalledTimes(1);
      const deferred = infoSpy.mock.calls.some(
        ([entry]) => typeof entry === "string" && entry.includes("deferred by execution window"),
      );
      expect(deferred).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("runs immediately when no execution schedule is configured (back-compat)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
      });

      const response = await postGitea(app, giteaPrPayload(), "pull_request");

      expect(response.status).toBe(202);
      await vi.runOnlyPendingTimersAsync();
      expect(sourceRootResolver).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("runs immediately under an unrestricted schedule (rules: [])", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: (_workspaceId: string) =>
          compileWeeklySchedule({ timezone: "UTC", rules: [] }),
      });

      const response = await postGitea(app, giteaPrPayload(), "pull_request");

      expect(response.status).toBe(202);
      await vi.runOnlyPendingTimersAsync();
      expect(sourceRootResolver).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("clamps a retry backoff that would land outside the window to the next window", async () => {
    vi.useFakeTimers();
    // Friday 13:39:50 UTC: inside the window, but a constant 60 s backoff
    // would fire at 13:40:50 — after the window closed.
    vi.setSystemTime(Date.parse("2026-09-11T13:39:50.000Z"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("fetch failed");
      })
      .mockReturnValue(undefined);
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        triggerRetry: {
          attempts: 2,
          backoff: { kind: "constant", base_ms: 60_000, max_ms: 60_000, jitter: false },
        },
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
      });

      const response = await postGitea(app, giteaPrPayload(), "pull_request");

      expect(response.status).toBe(202);
      await vi.runOnlyPendingTimersAsync();
      expect(sourceRootResolver).toHaveBeenCalledTimes(1);

      const retryLog = warnSpy.mock.calls
        .map(([entry]) => entry)
        .find((entry) => typeof entry === "string" && entry.includes("trigger processing failed, retrying"));
      expect(retryLog).toBeDefined();
      // 13:39:50 Friday → 12:00:00 Monday = 252 010 000 ms, not the raw 60 s.
      const expectedRetryMs = Date.parse(MONDAY_WINDOW_OPEN) - Date.parse("2026-09-11T13:39:50.000Z");
      expect(retryLog).toContain(`"nextRetryInMs":${expectedRetryMs}`);
      expect(retryLog).toContain(`"windowDeferred":true`);
      expect(retryLog).toContain(`"resumeAt":"${MONDAY_WINDOW_OPEN}"`);

      // The raw backoff elapses without a new attempt.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(sourceRootResolver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(expectedRetryMs - 61_000);
      expect(sourceRootResolver).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("merges repeated events for the same target into one deferred run plus one re-review", async () => {
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
      });

      const first = await postGitea(app, giteaPrPayload(), "pull_request");
      const second = await postGitea(app, giteaPrPayload(), "pull_request");

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      // The second event joined the pending re-review slot instead of arming
      // a second timer.
      const deferralCount = infoSpy.mock.calls.filter(
        ([entry]) => typeof entry === "string" && entry.includes("deferred by execution window"),
      ).length;
      expect(deferralCount).toBe(1);
      expect(sourceRootResolver).not.toHaveBeenCalled();

      // Window opens: the deferred run executes, completes, and the pending
      // re-review runs immediately because the window is still open.
      await vi.advanceTimersByTimeAsync(FRIDAY_TO_MONDAY_MS);
      await vi.runOnlyPendingTimersAsync();
      expect(sourceRootResolver).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });

  it("keeps push events on the receipt path without touching the direct-path gate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(FRIDAY_AFTER_WINDOW));
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sourceRootResolver = vi.fn().mockReturnValue(undefined);
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({
      store,
      getPolicyLayers: () => ({}),
    });
    try {
      const app = createServerApp({
        gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
        asyncTriggers: true,
        autoCommit: runtime,
        reviewPreparation: { baseSystemPrompt: "test", sourceRootResolver },
        getExecutionSchedule: weekdayLunchSchedule,
      });

      const response = await postGitea(app, giteaPushPayload(), "push");
      const body = (await response.json()) as { processing?: { mode?: string; receiptId?: string } };

      expect(response.status).toBe(202);
      // Receipt persisted for the (separately gated) scheduler; the async
      // direct path never runs, so no timer and no preparation call.
      expect(body.processing?.mode).toBe("queued");
      expect(await store.getReceipt(body.processing!.receiptId!)).toBeDefined();
      expect(sourceRootResolver).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      infoSpy.mockRestore();
    }
  });
});
