import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig } from "@aicr/core";
import { closeStoreDb, consumeImRateLimit, createStoreDb, getImAction, type SqliteStoreDb } from "@aicr/store";

import { consumeCardAction, issueCardAction } from "../src/im/action-service.js";

/**
 * IM-15 acceptance A09–A12: opaque action ids, exactly-once atomic
 * consumption, expiry, and replay returning the original request id.
 */

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-im-act-"));
  store = createStoreDb(join(dir, "act.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

const config: AppConfig = appConfigSchema.parse({
  im: {
    connections: { "feishu-app": { kind: "feishu_app", app_id: "cli_1", app_secret: "secret" } },
    command_bindings: { b: {
      enabled: true, connection: "feishu-app", conversations: [{ kind: "app_direct" }],
      actors: [{ type: "feishu_open_id", id: "ou_1" }], commands: ["review"],
      repositories: { service: { workspace: "ws", source_trigger: "t", repo_ref: "org/service" } },
    } },
  },
  triggers: [{ name: "t", kind: "github" }],
  workspaces: { instances: { ws: {} } },
  outputs: { channels: [] },
});
const source = { namespace: "ns", connectionName: "feishu-app", connectionIdentity: "feishu-lc:feishu-app" };
const actor = { type: "feishu_open_id", id: "ou_1" } as const;
const conversation = { kind: "app_direct" } as const;

describe("IM-15: card actions", () => {
  it("issues an opaque id and consumes it exactly once into a request (A09/A10)", async () => {
    const actionId = await issueCardAction(store, {
      namespace: "ns", connectionIdentity: "feishu-lc:feishu-app", connectionName: "feishu-app",
      bindingId: "b", workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
      revision: "0123456789abcdef0123456789abcdef01234567", configVersion: "v1",
      conversationJson: JSON.stringify(conversation), recipientId: null,
    });
    expect(actionId).toMatch(/^ima-/u);
    const first = await consumeCardAction(store, { actionId, config, actor, conversation, ...source });
    expect(first.kind).toBe("accepted");
    if (first.kind === "accepted") expect(first.requestId).toMatch(/^imr-/u);
    // Replay returns the original request id, never a second request (A10).
    const second = await consumeCardAction(store, { actionId, config, actor, conversation, ...source });
    expect(second.kind).toBe("duplicate");
    if (second.kind === "duplicate" && first.kind === "accepted") {
      expect(second.requestId).toBe(first.requestId);
    }
  });

  it("expired actions answer expired and create nothing (A12)", async () => {
    const actionId = await issueCardAction(store, {
      ...source, bindingId: "b",
      workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service", revision: "rev",
      configVersion: "v1", conversationJson: JSON.stringify(conversation), recipientId: null,
    }, new Date(Date.now() - 25 * 60 * 60 * 1000));
    const result = await consumeCardAction(store, { actionId, config, actor, conversation, ...source });
    expect(result.kind).toBe("expired");
  });

  it("unknown ids answer not_found (A09)", async () => {
    const result = await consumeCardAction(store, { actionId: "ima-missing", config, actor, conversation, ...source });
    expect(result.kind).toBe("not_found");
  });

  it("rejects forwarded or revoked actions without consuming them", async () => {
    const actionId = await issueCardAction(store, {
      ...source, bindingId: "b", workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
      revision: "0123456789abcdef0123456789abcdef01234567", configVersion: "v1",
      conversationJson: JSON.stringify(conversation), recipientId: "ou_1",
    });
    expect(await consumeCardAction(store, { actionId, config, actor: { type: "feishu_open_id", id: "ou_2" }, conversation, ...source }))
      .toMatchObject({ kind: "rejected", reason: "recipient_mismatch" });
    expect(await consumeCardAction(store, { actionId, config, actor, conversation: { kind: "group", id: "oc_other" }, ...source }))
      .toMatchObject({ kind: "rejected", reason: "conversation_mismatch" });
    expect(await consumeCardAction(store, { actionId, config, actor, conversation, ...source, connectionIdentity: "other-app" }))
      .toMatchObject({ kind: "rejected", reason: "source_mismatch" });
    const revoked: AppConfig = { ...config, im: { ...config.im, command_bindings: {} } };
    expect(await consumeCardAction(store, { actionId, config: revoked, actor, conversation, ...source }))
      .toMatchObject({ kind: "rejected", reason: "binding_revoked" });
    expect((await getImAction(store, actionId))?.status).toBe("issued");
  });

  it("does not consume the action when request admission is rate limited", async () => {
    const now = new Date();
    const actionId = await issueCardAction(store, {
      ...source, bindingId: "b", workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
      revision: "0123456789abcdef0123456789abcdef01234567", configVersion: "v1",
      conversationJson: JSON.stringify(conversation), recipientId: null,
    }, now);
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    for (let i = 0; i < 5; i += 1) await consumeImRateLimit(store, { namespace: "ns", bucketKey: "actor:feishu_open_id:ou_1", windowStart });
    expect(await consumeCardAction(store, { actionId, config, actor, conversation, ...source, now })).toMatchObject({ kind: "rejected", reason: "rate_limited" });
    expect((await getImAction(store, actionId))?.status).toBe("issued");
  });
});
