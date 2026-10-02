import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig } from "@aicr/core";
import { closeStoreDb, createStoreDb, findImReviewRequest, type SqliteStoreDb } from "@aicr/store";

import { processImCommand } from "../src/im/command-service.js";
import { ImReplyService } from "../src/im/reply-service.js";
import { ManualReviewService } from "../src/im/manual-review-service.js";

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

    const worker = new ManualReviewService({
      store, namespace: "ns", getConfig: () => config,
      createAdapter: () => ({ kind: "github", describeSource: async () => ({ title: "Commit" }) }),
      dispatch: async handoff => handoff.execute(),
      executeReview: async () => ({ state: "succeeded" }),
    });
    expect(await worker.scan()).toBe(1);
    expect((await findImReviewRequest(store, "ns", review.requestId!))?.state).toBe("succeeded");

    // Missing delivery credentials leave the notification pending for retry.
    const service = new ImReplyService({ store, getConfig: () => config, env: () => undefined, intervalMs: 3_600_000 });
    await service.scan();
    service.dispose();
    const outbox = store.sqlite.prepare("SELECT state, attempts FROM im_reply_outbox WHERE request_id = ?")
      .get(review.requestId) as { state: string; attempts: number };
    expect(outbox).toMatchObject({ state: "pending", attempts: 1 });

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
    expect(status.replyText).toContain("已完成");
  });
});
