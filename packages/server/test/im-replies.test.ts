import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig } from "@aicr/core";
import { claimDueImReplyNotifications, closeStoreDb, createStoreDb, finishImReviewRequest, findImReviewRequest, type SqliteStoreDb } from "@aicr/store";

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
    await admitRequest();
    const now = new Date();
    await finishImReviewRequest(store, {
      requestId: "imr-1", fence: 0, state: "succeeded", now,
      notifications: [{
        operationId: "imn-expired", destinationIdentity: "feishu-app", operationKind: "review_terminal",
        payloadDigest: "d", expiry: new Date(now.getTime() - 1000),
      }],
    });
    expect(await claimDueImReplyNotifications(store, { owner: "w1", limit: 5, now })).toHaveLength(0);
    expect(store.sqlite.prepare("SELECT state FROM im_reply_outbox WHERE operation_id = 'imn-expired'").get())
      .toMatchObject({ state: "expired" });
  });

  it("backs off failed sends and exhausts after five attempts without rerunning the review (O11/R18)", async () => {
    await admitRequest();
    await finishImReviewRequest(store, {
      requestId: "imr-1", fence: 0, state: "failed", errorCode: "im.x", now: new Date(),
      notifications: [{ operationId: "imn-2", destinationIdentity: "ghost", operationKind: "review_terminal", payloadDigest: "d",
        compactReceipt: JSON.stringify({ connectionName: "ghost", conversation: "{\"kind\":\"app_direct\"}",
          actor: { type: "feishu_open_id", id: "ou_1" }, requestId: "imr-1", state: "failed",
          repoRef: "org/service", revision: "0123456789abcdef0123456789abcdef01234567" }) }],
    });
    let now = new Date(Date.now() + 1000);
    const service = new ImReplyService({ store, getConfig: () => config, env: () => undefined, now: () => now });
    for (let attempt = 1; attempt <= 5; attempt++) {
      await service.scan();
      expect(store.sqlite.prepare("SELECT state, attempts FROM im_reply_outbox WHERE operation_id = 'imn-2'").get())
        .toMatchObject({ state: attempt === 5 ? "failed" : "pending", attempts: attempt });
      now = new Date(now.getTime() + 86_400_000);
    }
    service.dispose();
    expect((await findImReviewRequest(store, "ns", "imr-1"))?.state).toBe("failed");
  });
});
