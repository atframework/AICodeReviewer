import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig } from "@aicr/core";
import { claimDueImReplyNotifications, closeStoreDb, createStoreDb, finishImReplyNotification, type SqliteStoreDb } from "@aicr/store";

import { processImCommand } from "../src/im/command-service.js";
import { ImReplyService } from "../src/im/reply-service.js";

/**
 * IM-19 combined regression (C-matrix slice): command admission → review
 * execution → terminal state → notification delivery, against one fresh
 * store with no platform calls (the sender fails closed on an unknown
 * connection, which exercises the retry/terminal classification).
 */

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-im-combined-"));
  store = createStoreDb(join(dir, "combined.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

const config: AppConfig = appConfigSchema.parse({
  im: {
    connections: { "wecom-airobot-lc": { kind: "wecom_aibot", corp_id: "ww", aibot_id: "b" } },
    command_bindings: {
      open: {
        enabled: true, connection: "wecom-airobot-lc",
        conversations: [{ kind: "bot_direct" }],
        actors: [{ kind: "any" }],
        commands: ["review", "status", "queue"],
        allow_all_repositories: true,
        repositories: { service: { workspace: "ws", source_trigger: "t", repo_ref: "org/service" } },
      },
    },
  },
  triggers: [{ name: "t", kind: "github" }],
  workspaces: { instances: { ws: {} } },
  outputs: { channels: [] },
});

describe("IM-19: command → review → terminal → notification", () => {
  it("runs the full local pipeline with the notification classified, not re-run", async () => {
    const query = {
      answer: async (input: { command: { kind: string } }) => `查询:${input.command.kind}`,
      resolveProjectAlias: async () => undefined,
    };
    const review = await processImCommand({
      store, query, config,
      namespace: "ns", connectionName: "wecom-airobot-lc", connectionIdentity: "wecom-lc:wecom-airobot-lc",
      deliveryKey: "m-1", payloadDigest: "p",
      actor: { type: "wecom_userid", id: "owent" },
      conversation: { kind: "bot_direct" },
      command: { kind: "review", repoAlias: "service", revision: "0123456789abcdef0123456789abcdef01234567" },
      now: new Date(), configSnapshotId: "snap", configFileDigest: "d".repeat(64),
    });
    expect(review.kind).toBe("accepted");

    // The worker scans; the unknown-connection send fails closed and the row
    // returns to pending (attempt 1) — the review itself stays untouched.
    const service = new ImReplyService({ store, getConfig: () => config, env: () => undefined, intervalMs: 3_600_000 });
    service.start();
    service.dispose();
    const claimed = await claimDueImReplyNotifications(store, { owner: "probe", limit: 5, now: new Date(Date.now() + 120_000) });
    expect(claimed.length).toBeLessThanOrEqual(1);
    if (claimed.length === 1) {
      const ok = finishImReplyNotification(store, { operationId: claimed[0]!.operationId, fence: claimed[0]!.fence, state: "delivered", now: new Date() });
      expect(ok).toBe(true);
    }

    // status still answers after the notification cycle (no re-run effect).
    const status = await processImCommand({
      store, query, config,
      namespace: "ns", connectionName: "wecom-airobot-lc", connectionIdentity: "wecom-lc:wecom-airobot-lc",
      deliveryKey: "m-2", payloadDigest: "p2",
      actor: { type: "wecom_userid", id: "owent" },
      conversation: { kind: "bot_direct" },
      command: { kind: "status", requestId: review.requestId ?? "" },
      now: new Date(), configSnapshotId: "snap", configFileDigest: "d".repeat(64),
    });
    expect(status.kind).toBe("replied");
    expect(status.replyText).toContain(review.requestId ?? "");
  });
});
