import { describe, expect, it } from "vitest";

import { buildFeishuEvent } from "../src/im/protocol-feishu.js";

const connection = {
  name: "feishu-app",
  identity: { namespace: "test", kind: "feishu_app" as const, corpId: undefined, platformId: "cli_1", tenantKey: undefined },
};

describe("Feishu card callback normalization", () => {
  it("uses the opaque button value, operator and card context instead of event id", () => {
    const event = buildFeishuEvent({
      header: { event_type: "card.action.trigger", event_id: "evt-1", create_time: "1759000000000" },
      event: {
        operator: { operator_id: { open_id: "ou_1" } },
        context: { open_chat_id: "oc_review", open_message_id: "om_card" },
        action: { tag: "button", value: { aicr_action_id: "ima-opaque" } },
      },
    }, connection);
    expect(event).toMatchObject({
      deliveryKind: "card_action", deliveryKey: "evt-1", messageId: "om_card",
      actor: { type: "feishu_open_id", id: "ou_1" },
      conversation: { kind: "group", id: "oc_review" },
      occurredAt: 1759000000000,
      content: { kind: "card_action", actionId: "ima-opaque" },
    });
    const missingValue = buildFeishuEvent({
      header: { event_type: "card.action.trigger", event_id: "evt-2" },
      event: { operator: { operator_id: { open_id: "ou_1" } }, context: { open_chat_id: "oc_review" }, action: { tag: "button" } },
    }, connection);
    expect(missingValue.content).toMatchObject({ kind: "card_action", actionId: "" });
  });

  it("derives a stable delivery identity when a platform event omits its ids", () => {
    const payload = { header: { event_type: "card.action.trigger" }, event: {
      operator: { operator_id: { open_id: "ou_1" } }, action: { value: { aicr_action_id: "ima-1" } },
    } };
    const first = buildFeishuEvent(payload, connection);
    const replay = buildFeishuEvent(payload, connection);
    const changed = buildFeishuEvent({ ...payload, event: { ...payload.event, action: { value: { aicr_action_id: "ima-2" } } } }, connection);
    expect(first.deliveryKey).toBe(replay.deliveryKey);
    expect(first.payloadDigest).toBe(replay.payloadDigest);
    expect(changed.payloadDigest).not.toBe(first.payloadDigest);
  });

  it("uses the received message id and millisecond event timestamp for callbacks and SDK events", () => {
    const payload = {
      schema: "2.0", header: { event_type: "im.message.receive_v1", event_id: "evt-3", create_time: "1759000000123" },
      event: {
        sender: { sender_id: { open_id: "ou_1" } },
        message: { message_id: "om_3", chat_id: "oc_3", chat_type: "group", content: JSON.stringify({ text: "/review abcdef" }) },
      },
    };
    const callback = buildFeishuEvent(payload, connection);
    const sdk = buildFeishuEvent({ header: payload.header, event: payload.event }, connection);
    for (const event of [callback, sdk]) {
      expect(event).toMatchObject({
        deliveryKind: "message", deliveryKey: "om_3", messageId: "om_3", eventId: "evt-3",
        occurredAt: 1759000000123, content: { kind: "message", text: "/review abcdef" },
      });
    }
  });
});
