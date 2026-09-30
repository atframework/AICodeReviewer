import { describe, expect, it } from "vitest";

import { appConfigSchema, brandVerifiedImEvent, type AppConfig } from "@aicr/core";

import { ImLongConnectionService } from "../src/im/long-connection-service.js";
import { WecomAibotLongConnection } from "../src/im/wecom-long-connection.js";

function config(secret: string, enabled = true): AppConfig {
  return appConfigSchema.parse({
    im: { connections: { bot: { kind: "wecom_aibot", corp_id: "ww", aibot_id: "bot-1", secret, enabled } } },
    outputs: { channels: [] },
  });
}

describe("IM long-connection reconciliation", () => {
  it("fails proactive delivery while disconnected so the outbox can retry", async () => {
    const client = new WecomAibotLongConnection({
      botId: "bot-1", secret: "secret", connectionName: "bot", namespace: "test",
      onMessage: async () => undefined,
    });
    await expect(client.sendProactive("chat-1", "reply", true)).rejects.toThrow("not connected");
    client.dispose();
  });

  it("waits for the platform send acknowledgement before reporting delivery", async () => {
    const client = new WecomAibotLongConnection({
      botId: "bot-1", secret: "secret", connectionName: "bot", namespace: "test",
      onMessage: async () => undefined,
    });
    const frames: { headers: { req_id: string }; body: Record<string, unknown> }[] = [];
    const internal = client as unknown as {
      ws: { readyState: number; send: (text: string) => void; close: () => void };
      handleMessage: (text: string) => void;
    };
    internal.ws = { readyState: 1, send: text => { frames.push(JSON.parse(text) as typeof frames[number]); }, close: () => undefined };
    try {
      const delivered = client.sendProactive("chat-1", "reply", true);
      expect(frames[0]?.body).toMatchObject({ chatid: "chat-1", msgtype: "markdown" });
      internal.handleMessage(JSON.stringify({ headers: { req_id: frames[0]!.headers.req_id }, errcode: 0 }));
      await expect(delivered).resolves.toBeUndefined();

      const rejected = client.sendProactive("chat-1", "reply", true);
      internal.handleMessage(JSON.stringify({ headers: { req_id: frames[1]!.headers.req_id }, errcode: 40001 }));
      await expect(rejected).rejects.toThrow("40001");

      const malformed = client.sendProactive("chat-1", "reply", true);
      internal.handleMessage(JSON.stringify({ headers: { req_id: frames[2]!.headers.req_id } }));
      await expect(malformed).rejects.toThrow("NaN");
    } finally {
      client.dispose();
    }
  });
  it("keeps unchanged connections and reconnects only after credential rotation or removal", async () => {
    let current = config("first");
    const opened: string[] = [];
    const closed: string[] = [];
    const service = new ImLongConnectionService({
      getConfig: () => current,
      env: () => undefined,
      namespace: "test",
      onAdmitMessage: async () => undefined,
      createWecom: options => ({
        connect: async () => { opened.push(options.secret); },
        dispose: () => { closed.push(options.secret); },
      }),
    });
    try {
      await service.reconcile();
      await service.reconcile();
      expect(opened).toEqual(["first"]);
      expect(closed).toEqual([]);
      current = config("rotated");
      await service.reconcile();
      expect(opened).toEqual(["first", "rotated"]);
      expect(closed).toEqual(["first"]);
      current = config("rotated", false);
      await service.reconcile();
      expect(closed).toEqual(["first", "rotated"]);
    } finally {
      service.dispose();
    }
  });

  it("forwards the platform delivery identity for retry deduplication", async () => {
    const received: string[] = [];
    let push: (() => Promise<void>) | undefined;
    const service = new ImLongConnectionService({
      getConfig: () => config("secret"),
      env: () => undefined,
      namespace: "test",
      onAdmitMessage: async message => { received.push(`${message.deliveryKey}:${message.payloadDigest}`); },
      createWecom: options => {
        push = () => options.onMessage(brandVerifiedImEvent({
          connectionIdentity: { kind: "wecom_aibot", namespace: "test", corpId: "ww", platformId: "bot-1", tenantKey: undefined },
          connectionName: "bot", protocol: "wecom_aibot", deliveryKind: "message",
          deliveryKey: "platform-msg-1", payloadDigest: "sha256:body-1",
          actor: { type: "wecom_userid", id: "alice" }, conversation: { kind: "bot_direct" },
          occurredAt: 1, messageId: "platform-msg-1", eventId: undefined, actionId: undefined,
          content: { kind: "message", text: "aicr review svc deadbeef" },
        }), async () => undefined);
        return { connect: async () => undefined, dispose: () => undefined };
      },
    });
    try {
      await service.reconcile();
      await push!();
      await push!();
      expect(received).toEqual(["platform-msg-1:sha256:body-1", "platform-msg-1:sha256:body-1"]);
    } finally {
      service.dispose();
    }
  });

  it("does not turn an event without a verified actor into an any-actor command", async () => {
    let push: (() => Promise<void>) | undefined;
    let admitted = 0;
    const service = new ImLongConnectionService({
      getConfig: () => config("secret"), env: () => undefined, namespace: "test",
      onAdmitMessage: async () => { admitted++; },
      createWecom: options => {
        push = () => options.onMessage(brandVerifiedImEvent({
          connectionIdentity: { kind: "wecom_aibot", namespace: "test", corpId: "ww", platformId: "bot-1", tenantKey: undefined },
          connectionName: "bot", protocol: "wecom_aibot", deliveryKind: "message",
          deliveryKey: "msg-unknown", payloadDigest: "sha256:unknown", actor: undefined,
          conversation: { kind: "bot_direct" }, occurredAt: 1, messageId: "msg-unknown",
          eventId: undefined, actionId: undefined, content: { kind: "message", text: "aicr review svc deadbeef" },
        }), async () => undefined);
        return { connect: async () => undefined, dispose: () => undefined };
      },
    });
    try {
      await service.reconcile();
      await push!();
      expect(admitted).toBe(0);
    } finally {
      service.dispose();
    }
  });
});
