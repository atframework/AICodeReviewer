import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig } from "@aicr/core";
import { bindImActionSource, closeStoreDb, consumeImRateLimit, createStoreDb, getImAction, type SqliteStoreDb } from "@aicr/store";

import { consumeCardAction, issueCardAction } from "../src/im/action-service.js";

/**
 * IM-15 acceptance A09–A13: opaque action ids, platform-message binding from
 * the send acknowledgement, exactly-once atomic consumption, expiry, replay
 * returning the original request id, and pending (unbound) actions never
 * executing.
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
const source = { namespace: "ns", connectionName: "feishu-app", connectionIdentity: "feishu-lc:feishu-app",
  configSnapshotId: "click-snapshot", configFileDigest: "d".repeat(64) };
const actor = { type: "feishu_open_id", id: "ou_1" } as const;
const conversation = { kind: "app_direct" } as const;
const REVISION = "0123456789abcdef0123456789abcdef01234567";

/** WeCom application binding surface for task-bound card clicks. */
function wecomConfig(): AppConfig {
  return appConfigSchema.parse({
    im: {
      connections: { "wecom-corp": { kind: "wecom_app", corp_id: "ww", agent_id: 1, app_secret: "s",
        callback: { enabled: true, token: "t", encoding_aes_key: "k" } } },
      command_bindings: { b: {
        enabled: true, connection: "wecom-corp", conversations: [{ kind: "app_direct" }],
        actors: [{ type: "wecom_userid", id: "ou_1" }], commands: ["review"],
        repositories: { service: { workspace: "ws", source_trigger: "t", repo_ref: "org/service" } },
      } },
    },
    triggers: [{ name: "t", kind: "github" }],
    workspaces: { instances: { ws: {} } },
    outputs: { channels: [] },
  });
}

/** The realistic card lifecycle: issue pre-send, bind the platform message id from the ack. */
async function issueBoundCardAction(issuedAt = new Date(), messageId = "om-card-1", recipientId: string | null = null): Promise<string> {
  const actionId = await issueCardAction(store, {
    namespace: "ns", connectionIdentity: "feishu-lc:feishu-app", connectionName: "feishu-app",
    bindingId: "b", workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
    revision: REVISION, configVersion: "v1",
    conversationJson: JSON.stringify(conversation), recipientId,
  }, issuedAt);
  expect(await bindImActionSource(store, { actionId, sourceMessageId: messageId, now: issuedAt })).toBe(true);
  return actionId;
}

describe("IM-15: card actions", () => {
  it.each([undefined, "file-only"])("leaves the action unconsumed without a persistent click snapshot (%s)", async configSnapshotId => {
    const actionId = await issueBoundCardAction();
    expect(await consumeCardAction(store, { actionId, config, actor, conversation, ...source, configSnapshotId, sourceMessageId: "om-card-1" }))
      .toEqual({ kind: "rejected", reason: "execution_unavailable" });
    expect((await getImAction(store, actionId))?.status).toBe("issued");
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM im_review_requests").get()).toMatchObject({ count: 0 });
  });
  it("issues an opaque id, binds the send ack and consumes it exactly once into a request (A09/A10)", async () => {
    const actionId = await issueBoundCardAction();
    expect(actionId).toMatch(/^ima-/u);
    expect((await getImAction(store, actionId))?.sourceMessageId).toBe("om-card-1");
    const first = await consumeCardAction(store, { actionId, config, actor, conversation, ...source, sourceMessageId: "om-card-1" });
    expect(first.kind).toBe("accepted");
    if (first.kind === "accepted") expect(first.requestId).toMatch(/^imr-/u);
    // Replay returns the original request id, never a second request (A10).
    const second = await consumeCardAction(store, { actionId, config, actor, conversation, ...source, sourceMessageId: "om-card-1" });
    expect(second.kind).toBe("duplicate");
    if (second.kind === "duplicate" && first.kind === "accepted") {
      expect(second.requestId).toBe(first.requestId);
    }
  });

  it("rejects a pending action that never got bound and one bound to another message (A11/A13)", async () => {
    // Bind failed / send response lost: the action stays pending and never
    // executes, whatever source the callback claims.
    const pendingId = await issueCardAction(store, {
      namespace: "ns", connectionIdentity: "feishu-lc:feishu-app", connectionName: "feishu-app",
      bindingId: "b", workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
      revision: REVISION, configVersion: "v1", conversationJson: JSON.stringify(conversation), recipientId: null,
    });
    expect(await consumeCardAction(store, { actionId: pendingId, config, actor, conversation, ...source, sourceMessageId: "om-self-claimed" }))
      .toMatchObject({ kind: "rejected", reason: "unbound" });
    expect((await getImAction(store, pendingId))?.status).toBe("issued");

    // A forwarded card (different platform message id) is rejected even with
    // a valid action id.
    const actionId = await issueBoundCardAction(undefined, "om-real");
    expect(await consumeCardAction(store, { actionId, config, actor, conversation, ...source, sourceMessageId: "om-forwarded" }))
      .toMatchObject({ kind: "rejected", reason: "source_mismatch" });
    expect((await getImAction(store, actionId))?.status).toBe("issued");
  });

  it("expired actions answer expired and create nothing (A12)", async () => {
    const actionId = await issueBoundCardAction(new Date(Date.now() - 25 * 60 * 60 * 1000));
    const result = await consumeCardAction(store, { actionId, config, actor, conversation, ...source, sourceMessageId: "om-card-1" });
    expect(result.kind).toBe("expired");
  });

  it("unknown ids answer not_found (A09)", async () => {
    const result = await consumeCardAction(store, { actionId: "ima-missing", config, actor, conversation, ...source, sourceMessageId: "om-card-1" });
    expect(result.kind).toBe("not_found");
  });

  it("rejects forwarded or revoked actions without consuming them", async () => {
    const actionId = await issueBoundCardAction(undefined, "om-card-1", "ou_1");
    expect(await consumeCardAction(store, { actionId, config, actor: { type: "feishu_open_id", id: "ou_2" }, conversation, ...source, sourceMessageId: "om-card-1" }))
      .toMatchObject({ kind: "rejected", reason: "recipient_mismatch" });
    expect(await consumeCardAction(store, { actionId, config, actor, conversation: { kind: "group", id: "oc_other" }, ...source, sourceMessageId: "om-card-1" }))
      .toMatchObject({ kind: "rejected", reason: "conversation_mismatch" });
    expect(await consumeCardAction(store, { actionId, config, actor, conversation, ...source, connectionIdentity: "other-app", sourceMessageId: "om-card-1" }))
      .toMatchObject({ kind: "rejected", reason: "source_mismatch" });
    const revoked: AppConfig = { ...config, im: { ...config.im, command_bindings: {} } };
    expect(await consumeCardAction(store, { actionId, config: revoked, actor, conversation, ...source, sourceMessageId: "om-card-1" }))
      .toMatchObject({ kind: "rejected", reason: "binding_revoked" });
    expect((await getImAction(store, actionId))?.status).toBe("issued");
  });

  it("does not consume the action when request admission is rate limited", async () => {
    const now = new Date();
    const actionId = await issueCardAction(store, {
      ...source, bindingId: "b", workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
      revision: REVISION, configVersion: "v1", conversationJson: JSON.stringify(conversation), recipientId: null,
    }, now);
    expect(await bindImActionSource(store, { actionId, sourceMessageId: "om-card-1", now })).toBe(true);
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    for (let i = 0; i < 5; i += 1) await consumeImRateLimit(store, { namespace: "ns", bucketKey: "actor:feishu_open_id:ou_1", windowStart });
    expect(await consumeCardAction(store, { actionId, config, actor, conversation, ...source, sourceMessageId: "om-card-1", now })).toMatchObject({ kind: "rejected", reason: "rate_limited" });
    expect((await getImAction(store, actionId))?.status).toBe("issued");
  });

  it("binds only once and never rebinds consumed actions (A13)", async () => {
    const actionId = await issueBoundCardAction(undefined, "om-first");
    // A second acknowledgement for the same action never overwrites the binding.
    expect(await bindImActionSource(store, { actionId, sourceMessageId: "om-second", now: new Date() })).toBe(false);
    expect((await getImAction(store, actionId))?.sourceMessageId).toBe("om-first");
    const consumed = await consumeCardAction(store, { actionId, config, actor, conversation, ...source, sourceMessageId: "om-first" });
    expect(consumed.kind).toBe("accepted");
    expect(await bindImActionSource(store, { actionId, sourceMessageId: "om-third", now: new Date() })).toBe(false);
    expect((await getImAction(store, actionId))?.sourceMessageId).toBe("om-first");
  });

  it("consumes WeCom task-bound cards only with the matching TaskId (A11)", async () => {
    // WeCom cards bind the send-side TaskId (equal to the action id); the
    // platform message id stays unused.
    const actionId = await issueCardAction(store, {
      namespace: "ns", connectionIdentity: "wecom-app:ww:1", connectionName: "wecom-corp",
      bindingId: "b", workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
      revision: REVISION, configVersion: "v1", conversationJson: JSON.stringify({ kind: "app_direct" }), recipientId: null,
    });
    expect(await bindImActionSource(store, { actionId, sourceTaskId: actionId, now: new Date() })).toBe(true);
    const wecomSource = { namespace: "ns", connectionName: "wecom-corp", connectionIdentity: "wecom-app:ww:1",
      configSnapshotId: "click-snapshot", configFileDigest: "d".repeat(64) };
    const wecomActor = { type: "wecom_userid", id: "ou_1" } as const;
    const wecomConversation = { kind: "app_direct" } as const;
    // A feishu-style click (message id, no TaskId) cannot consume a task card.
    expect(await consumeCardAction(store, { actionId, config: wecomConfig(), actor: wecomActor, conversation: wecomConversation, ...wecomSource, sourceMessageId: "om-x" }))
      .toMatchObject({ kind: "rejected", reason: "source_mismatch" });
    // The matching TaskId consumes; a wrong one is rejected before any state.
    const consumed = await consumeCardAction(store, { actionId, config: wecomConfig(), actor: wecomActor, conversation: wecomConversation, ...wecomSource, sourceTaskId: actionId });
    expect(consumed.kind).toBe("accepted");
    expect(await consumeCardAction(store, { actionId, config: wecomConfig(), actor: wecomActor, conversation: wecomConversation, ...wecomSource, sourceTaskId: "ima-other" }))
      .toMatchObject({ kind: "rejected", reason: "source_mismatch" });
  });
});
