import { describe, expect, it } from "vitest";

import {
  IM_COMMAND_NAMES,
  IM_ERROR_CODES,
  IM_REVIEW_TERMINAL_STATES,
  brandVerifiedImEvent,
  imConnectionIdentityKey,
  imConversationSchema,
  imPlatformIdSchema,
  imPrincipalSchema,
  isVerifiedImEvent,
  type ImConnectionIdentity,
  type VerifiedImEventData,
} from "../src/im-contracts.js";

const identity: ImConnectionIdentity = {
  kind: "wecom_app",
  corpId: "ww_example",
  platformId: "1000002",
  tenantKey: undefined,
  namespace: "default",
};

const eventData: VerifiedImEventData = {
  connectionIdentity: identity,
  connectionName: "corp-review",
  protocol: "wecom_app",
  deliveryKind: "message",
  deliveryKey: "msg-1",
  payloadDigest: "sha256:0",
  actor: { type: "wecom_userid", id: "alice_zhang" },
  conversation: { kind: "app_direct" },
  occurredAt: 1_759_000_000_000,
  messageId: "msg-1",
  eventId: undefined,
  actionId: undefined,
  content: { kind: "message", text: "aicr help" },
};

describe("im-contracts: principals and conversations", () => {
  it("parses typed principals and rejects untyped or control-char ids", () => {
    expect(imPrincipalSchema.parse({ type: "feishu_open_id", id: "ou_x" })).toEqual({ type: "feishu_open_id", id: "ou_x" });
    expect(imPrincipalSchema.safeParse({ type: "wecom_magic", id: "x" }).success).toBe(false);
    expect(imPrincipalSchema.safeParse({ type: "wecom_userid", id: "x y" }).success).toBe(true);
    expect(imPlatformIdSchema.safeParse("bad\u0007id").success).toBe(false);
    expect(imPlatformIdSchema.safeParse("").success).toBe(false);
  });

  it("requires an id only for group conversations", () => {
    expect(imConversationSchema.parse({ kind: "app_direct" })).toEqual({ kind: "app_direct" });
    expect(imConversationSchema.safeParse({ kind: "group" }).success).toBe(false);
    expect(imConversationSchema.safeParse({ kind: "group", id: "chat-1", extra: 1 }).success).toBe(false);
  });
});

describe("im-contracts: connection identity", () => {
  it("is stable across key order and secret rotation, distinct across identity-domain changes", () => {
    const rotated = imConnectionIdentityKey(identity);
    expect(rotated).toBe(imConnectionIdentityKey({ ...identity, corpId: "ww_example" }));
    expect(rotated).toBe(imConnectionIdentityKey({ tenantKey: undefined, kind: "wecom_app", namespace: "default", platformId: "1000002", corpId: "ww_example" }));
    expect(rotated).not.toBe(imConnectionIdentityKey({ ...identity, corpId: "ww_other" }));
    expect(rotated).not.toBe(imConnectionIdentityKey({ ...identity, platformId: "1000003" }));
    expect(rotated).not.toBe(imConnectionIdentityKey({ ...identity, namespace: "tenant-b" }));
    expect(rotated).not.toBe(imConnectionIdentityKey({ ...identity, kind: "wecom_aibot" }));
  });
});

describe("im-contracts: verified events are brand-gated", () => {
  it("brands and freezes adapter-verified events; plain data never passes the guard", () => {
    const event = brandVerifiedImEvent(eventData);
    expect(isVerifiedImEvent(event)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(isVerifiedImEvent({ ...eventData })).toBe(false);
    expect(() => {
      (event as mutable).connectionName = "other";
    }).toThrow();
  });

  it("keeps content a closed discriminated union for the command service", () => {
    for (const content of [
      { kind: "card_action", actionId: "act-1" },
      { kind: "lifecycle", event: "chat_disbanded" },
      { kind: "stream_refresh" },
      { kind: "unknown_type", type: "template_card_event" },
    ] as const) {
      const stream = brandVerifiedImEvent({ ...eventData, content });
      expect(stream.content.kind).toBe(content.kind);
    }
  });
});

describe("im-contracts: command and state vocabularies", () => {
  it("fixes the first-phase command names", () => {
    expect([...IM_COMMAND_NAMES]).toEqual([
      "help", "chat-id", "review", "status",
      "projects", "reviews", "commits", "prs", "detail", "prdetail", "queue", "running",
    ]);
  });

  it("keeps terminal states disjoint from active states and error codes unique", () => {
    const active = ["accepted", "validating", "queued", "running", "publishing", "retry_wait"];
    for (const state of IM_REVIEW_TERMINAL_STATES) expect(active).not.toContain(state);
    expect(new Set(IM_ERROR_CODES).size).toBe(IM_ERROR_CODES.length);
    expect(IM_ERROR_CODES).toContain("im.unauthorized_actor");
    expect(IM_ERROR_CODES).not.toContain("im.force");
  });
});

type mutable = { -readonly [key in keyof VerifiedImEventData]: VerifiedImEventData[key] };
