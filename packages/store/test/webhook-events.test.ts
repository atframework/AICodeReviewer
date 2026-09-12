import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStoreDb, closeStoreDb, type SqliteStoreDb } from "../src/database.js";
import {
  insertWebhookEvent,
  getRecentWebhookEvents,
  pruneWebhookEvents,
  WEBHOOK_EVENTS_RETENTION_LIMIT,
} from "../src/webhook-events.js";

let tmpDir: string;
let store: SqliteStoreDb;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aicr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  store = createStoreDb(join(tmpDir, "test.db"));
});

afterEach(async () => {
  (await closeStoreDb(store));
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("webhook events", () => {
  it("creates the webhook_events table via migrations", async () => {
    const tables = store.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: unknown) => (r as Record<string, string>).name);
    expect(tables).toContain("webhook_events");
  });

  it("inserts an event and returns it newest-first with parsed detail", async () => {
    (await insertWebhookEvent(store, {
      receivedAt: new Date(1_000),
      provider: "github",
      eventName: "pull_request",
      workspaceId: "ws-1",
      triggerName: "github-main",
      repoRef: "org/repo",
      targetKind: "pull_request",
      targetUrl: "https://github.com/org/repo/pull/1",
      branch: "feature",
      decision: "deferred",
      reason: "execution_window",
      detail: { resumeAt: 5_000, noticePublished: true },
    }));
    (await insertWebhookEvent(store, {
      receivedAt: new Date(2_000),
      provider: "gitea",
      eventName: "push",
      decision: "queued",
      reason: null,
    }));

    const events = (await getRecentWebhookEvents(store, 20));
    expect(events).toHaveLength(2);
    expect(events[0]!.provider).toBe("gitea");
    expect(events[0]!.decision).toBe("queued");
    expect(events[0]!.detail).toBeNull();
    expect(events[1]!.workspaceId).toBe("ws-1");
    expect(events[1]!.detail).toEqual({ resumeAt: 5_000, noticePublished: true });
  });

  it("defaults receivedAt to now and tolerates invalid detail JSON", async () => {
    (await insertWebhookEvent(store, { decision: "rejected", reason: "invalid_signature" }));
    const before = (await getRecentWebhookEvents(store, 1))[0]!;
    expect(before.receivedAt.getTime()).toBeGreaterThan(0);

    store.sqlite.prepare("UPDATE webhook_events SET detail = ? WHERE id = ?").run("not-json", before.id);
    const after = (await getRecentWebhookEvents(store, 1))[0]!;
    expect(after.detail).toBeNull();
  });

  it("prunes rows beyond the retention limit on insert", async () => {
    for (let i = 0; i < WEBHOOK_EVENTS_RETENTION_LIMIT + 25; i += 1) {
      (await insertWebhookEvent(store, {
        receivedAt: new Date(i),
        provider: "gitlab",
        decision: "executed",
      }));
    }
    const events = (await getRecentWebhookEvents(store, WEBHOOK_EVENTS_RETENTION_LIMIT + 50));
    expect(events).toHaveLength(WEBHOOK_EVENTS_RETENTION_LIMIT);
    const count = store.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_events").get() as { n: number };
    expect(count.n).toBe(WEBHOOK_EVENTS_RETENTION_LIMIT);
    const oldest = events[events.length - 1]!;
    expect(oldest.receivedAt.getTime()).toBe(25);
  });

  it("pruneWebhookEvents deletes older rows beyond an explicit keep count", async () => {
    for (let i = 0; i < 10; i += 1) {
      (await insertWebhookEvent(store, { receivedAt: new Date(i), decision: "ignored" }));
    }
    const deleted = (await pruneWebhookEvents(store, 3));
    expect(deleted).toBe(7);
    expect((await getRecentWebhookEvents(store, 10))).toHaveLength(3);
  });

  it("honours the query limit", async () => {
    for (let i = 0; i < 30; i += 1) {
      (await insertWebhookEvent(store, { receivedAt: new Date(i), decision: "executed" }));
    }
    expect((await getRecentWebhookEvents(store, 20))).toHaveLength(20);
  });
});
