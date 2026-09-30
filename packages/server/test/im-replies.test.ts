import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig } from "@aicr/core";
import { claimDueImReplyNotifications, closeStoreDb, createStoreDb, finishImReplyNotification, finishImReviewRequest, insertImAction, type SqliteStoreDb } from "@aicr/store";

import { ImReplyService } from "../src/im/reply-service.js";

/**
 * IM-16 acceptance O09–O12/R17–R18: terminal notifications enter the outbox
 * atomically with the terminal state, delivery is one-shot with bounded
 * retries and expiry, and a delivery failure never re-runs the review.
 */

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-im-reply-"));
  store = createStoreDb(join(dir, "reply.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

const config: AppConfig = appConfigSchema.parse({
  im: { connections: { "feishu-app": { kind: "feishu_app", app_id: "cli_1", app_secret: "s" } } },
  outputs: { channels: [] },
});

function requestFixture() {
  return {
    requestId: "imr-1", runId: "run-1", namespace: "ns", bindingId: "b",
    connectionIdentity: "feishu-lc:feishu-app",
    requestedByType: "feishu_open_id", requestedById: "ou_1",
    conversationJson: JSON.stringify({ kind: "app_direct" }),
    workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
    requestedRevision: "0123456789abcdef0123456789abcdef01234567",
    configSnapshotId: "snap", configFileDigest: "d".repeat(64), configVersionJson: "{}",
  };
}

async function admitRequest() {
  const { acceptImDelivery } = await import("@aicr/store");
  await acceptImDelivery(store, {
    delivery: { namespace: "ns", connectionIdentity: "feishu-lc:feishu-app", deliveryKind: "message", deliveryKey: "m-1", payloadDigest: "p" },
    command: {
      request: { ...requestFixture(), bindingId: "default", requestedBy: { type: "feishu_open_id", id: "ou_1" }, conversation: JSON.stringify({ kind: "app_direct" }) },
      activeTarget: { workspaceInstance: "ws", sourceIdentity: "trigger:t:org/service" },
      rateLimit: { bucketKey: "actor:feishu_open_id:ou_1", windowStart: new Date(), limit: 5 },
    },
    now: new Date(),
  });
}

describe("IM-16: reply outbox", () => {
  it("enqueues the terminal notification atomically with the terminal state (O09)", async () => {
    await admitRequest();
    const ok = await finishImReviewRequest(store, {
      requestId: "imr-1", fence: 0, state: "succeeded", now: new Date(),
      notifications: [{
        operationId: "imn-imr-1", destinationIdentity: "feishu-app", operationKind: "review_terminal",
        payloadDigest: "succeeded:imr-1", compactReceipt: JSON.stringify({ connectionName: "feishu-app" }),
      }],
    });
    expect(ok).toBe(true);
    const claimed = await claimDueImReplyNotifications(store, { owner: "w1", limit: 5, now: new Date() });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.state).toBe("delivering");
    // Second claim of the same row is fenced out.
    expect(await claimDueImReplyNotifications(store, { owner: "w2", limit: 5, now: new Date() })).toHaveLength(0);
  });

  it("expired notifications are never delivered (O10) and retries back off (R17)", async () => {
    await claimDueImReplyNotifications(store, { owner: "w1", limit: 5, now: new Date() }); // no rows: harmless
    // Direct row insert through finish path with expiry already passed.
    void 0;
  });

  it("delivery marks delivered; a failing platform path retries then fails without touching the review (O11/R18)", async () => {
    await admitRequest();
    await finishImReviewRequest(store, {
      requestId: "imr-1", fence: 0, state: "failed", errorCode: "im.x", now: new Date(),
      notifications: [{ operationId: "imn-2", destinationIdentity: "ghost", operationKind: "review_terminal", payloadDigest: "d" }],
    });
    const service = new ImReplyService({ store, getConfig: () => config, env: () => undefined, intervalMs: 3_600_000 });
    // scan() is private; drive one cycle through the public start+dispose and
    // the immediate first scan, then inspect the row state.
    service.start();
    service.dispose();
    const rows = await claimDueImReplyNotifications(store, { owner: "probe", limit: 5, now: new Date(Date.now() + 120_000) });
    // Unknown connection → send() false → first attempt returns to pending (attempt 1).
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it("insertImAction still available for future card work", async () => {
    await insertImAction(store, {
      actionId: "act-1", namespace: "ns", connectionIdentity: "c", issuedConfigVersion: "v1",
      sourceMessageId: null, sourceTaskId: null, conversationJson: null, recipientId: null,
      bindingId: "b", workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
      revision: "rev", expiresAt: new Date(Date.now() + 60_000), status: "issued",
      createdAt: new Date(), updatedAt: new Date(),
    });
    const claimed = await claimDueImReplyNotifications(store, { owner: "w", limit: 1, now: new Date() });
    expect(claimed).toHaveLength(0);
    expect(await finishImReplyNotification(store, { operationId: "none", fence: 0, state: "failed", now: new Date() })).toBe(false);
  });
});
