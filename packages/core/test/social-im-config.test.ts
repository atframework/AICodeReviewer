import { describe, expect, it } from "vitest";
import { appConfigSchema, outputChannelSchema } from "../src/config.js";
import { imConfigSchema, imConnectionSchema } from "../src/im-config.js";
import { validateEntityCapabilities } from "../src/config-capabilities.js";
import { scrubText } from "../src/secret-scrubber.js";

export const socialConnections = {
  slack: {
    kind: "slack_app",
    app_id: "A123",
    team_id: "T123",
    bot_user_id: "U123",
    token_env: "SLACK_TOKEN",
  },
  discord: {
    kind: "discord_bot",
    application_id: "123456789012345678",
    guild_id: "123456789012345679",
    token_env: "DISCORD_TOKEN",
  },
  telegram: {
    kind: "telegram_bot",
    bot_id: "123456789",
    token_env: "TELEGRAM_TOKEN",
  },
} as const;

describe("social IM configuration", () => {
  it.each([
    ["slack_app", { channel_id: "C123" }, "slack_api", "U234"],
    ["discord_bot", { channel_id: "123" }, "discord_api", "234"],
    ["telegram_bot", { chat_id: "-123" }, undefined, "234"],
  ])("supports %s mappings and matching directories while rejecting platform identity confusion", (kind, target, source, id) => {
    const channel = { name: "report", kind, connection: "bot", ...target, mention_author: true, author_mappings: { "alice@example.org": id } };
    expect(outputChannelSchema.safeParse(channel).success).toBe(true);
    expect(() => validateEntityCapabilities("channel", channel)).not.toThrow();
    expect(outputChannelSchema.safeParse({ ...channel, author_mappings: { alice: "@alice" } }).success).toBe(false);
    if (source) {
      const api = { ...channel, member_directory: { source } };
      expect(outputChannelSchema.safeParse(api).success).toBe(true);
      expect(() => validateEntityCapabilities("channel", api)).not.toThrow();
    }
    expect(outputChannelSchema.safeParse({ ...channel, member_directory: { source: "feishu_api", chat_id: "oc_other" } }).success).toBe(false);
    if (kind === "telegram_bot") expect(outputChannelSchema.safeParse({ ...channel, member_directory: { source: "slack_api" } }).success).toBe(false);
  });
  it("validates Socket Mode credentials, transport exclusivity and receiver ownership", () => {
    const socket = {...socialConnections.slack, socket_mode: {enabled: true, app_token_env: "SLACK_APP_TOKEN"}};
    expect(imConnectionSchema.safeParse(socket).success).toBe(true);
    for (const change of [ {socket_mode: {enabled: true}}, {socket_mode: {enabled: true, app_token: "xapp-test", app_token_env: "APP_TOKEN"}}, {callback: {enabled: true, signing_secret_env: "SIGNING_SECRET"}}]) expect(imConnectionSchema.safeParse({...socket, ...change}).success).toBe(false);
    expect(imConnectionSchema.safeParse({...socialConnections.discord, socket_mode: socket.socket_mode}).success).toBe(false);
    expect(imConfigSchema.safeParse({connections: {first: socket, duplicate: {...socialConnections.slack, callback: {enabled: true, signing_secret_env: "SECRET"}}}}).success).toBe(false);
    expect(scrubText("xapp-1-test-secret wss://example.org/link?ticket=secret-ticket").text).not.toContain("test-secret");
    expect(scrubText("wss://example.org/link?ticket=secret-ticket").text).not.toContain("secret-ticket");
  });
  it.each([
    ["slack", "slack_app", { channel_id: "C123" }],
    ["discord", "discord_bot", { channel_id: "123456789012345680" }],
    ["telegram", "telegram_bot", { chat_id: "-1001234567890" }],
  ])(
    "parses and compiles %s references without coercing IDs",
    (connection, kind, target) => {
      const config = appConfigSchema.parse({
        im: { connections: socialConnections },
        outputs: {
          channels: [{ name: "report", kind, connection, ...target }],
        },
      });
      expect(config.outputs.channels[0]).toEqual({
        name: "report",
        kind,
        connection,
        ...target,
      });
      expect(() =>
        validateEntityCapabilities("channel", config.outputs.channels[0]),
      ).not.toThrow();
      expect(
        appConfigSchema.safeParse({
          ...config,
          outputs: {
            ...config.outputs,
            channels: [{ name: "bad", kind, connection: "wrong", ...target }],
          },
        }).success,
      ).toBe(false);
    },
  );
  it("rejects inline secrets, broad mentions and unknown destination features", () => {
    const channel = {
      name: "slack",
      kind: "slack_app",
      connection: "slack",
      channel_id: "C123",
    };
    for (const extra of [
      { token: "secret" },
      { mention_fallback: "all" },
      { thread_ts: "1.2" },
      { base_url: "https://example.com" },
      { member_directory: { chat_id: "C123" } },
    ]) {
      expect(
        outputChannelSchema.safeParse({ ...channel, ...extra }).success,
      ).toBe(false);
    }
    expect(
      outputChannelSchema.safeParse({
        name: "tg",
        kind: "telegram_bot",
        connection: "tg",
        chat_id: "1e6",
      }).success,
    ).toBe(false);
    expect(
      imConnectionSchema.safeParse({
        ...socialConnections.discord,
        application_id: 123,
      }).success,
    ).toBe(false);
    expect(
      imConnectionSchema.safeParse({
        ...socialConnections.slack,
        token: "literal",
      }).success,
    ).toBe(false);
    expect(
      imConnectionSchema.safeParse({
        ...socialConnections.telegram,
        callback: { enabled: true },
      }).success,
    ).toBe(false);
    expect(
      imConnectionSchema.safeParse({
        ...socialConnections.discord,
        callback: { enabled: true, public_key: "bad" },
      }).success,
    ).toBe(false);
    expect(
      imConnectionSchema.safeParse({
        kind: "telegram_bot",
        bot_id: "123",
        enabled: false,
      }).success,
    ).toBe(true);
  });
  it("limits new bindings to explicit actor policies, fixed commands and repositories", () => {
    const binding = {
      enabled: true,
      connection: "slack",
      actors: [{ type: "slack_user_id", id: "U234" }],
      conversations: [{ kind: "channel", id: "C123" }],
      commands: ["help"],
    };
    const parse = (extra: object) =>
      imConfigSchema.safeParse({
        connections: socialConnections,
        command_bindings: { commands: { ...binding, ...extra } },
      }).success;
    expect(parse({})).toBe(true);
    for (const extra of [
      { actors: [{ kind: "any" }] },
      { actors: [{ type: "discord_user_id", id: "123" }] },
      { commands: ["cancel"] },
      { allow_all_repositories: true },
      { conversations: [{ kind: "app_direct" }] },
    ])
      expect(parse(extra)).toBe(false);
    const callback = { enabled: true, signing_secret_env: "SIGNING_SECRET" };
    expect(
      imConfigSchema.safeParse({
        connections: {
          one: { ...socialConnections.slack, callback },
          two: { ...socialConnections.slack, callback },
        },
      }).success,
    ).toBe(false);
  });
  it.each([
    ["slack", { kind: "channel", id: "C123" }, { type: "slack_user_id", id: "U234" }],
    ["discord", { kind: "channel", id: "123456789012345680" }, { type: "discord_user_id", id: "234" }],
    ["telegram", { kind: "group", id: "-1001234567890" }, { type: "telegram_user_id", id: "234" }],
  ])("allows %s conversation users and rejects overlapping actor policies", (connection, conversation, principal) => {
    const binding = { enabled: true, connection, actors: [{ kind: "conversation_users" }], conversations: [conversation], commands: ["help"] };
    const parse = (command_bindings: object) => imConfigSchema.safeParse({ connections: socialConnections, command_bindings }).success;
    expect(parse({ all: binding })).toBe(true);
    expect(parse({ all: binding, individual: { ...binding, actors: [principal] } })).toBe(false);
    expect(parse({ all: binding, later: { ...binding, actors: [{ kind: "conversation_users", expires_at: "2027-01-01T00:00:00Z" }] } })).toBe(false);
    const other = { ...conversation, id: connection === "slack" ? "C999" : connection === "discord" ? "999" : "-999" };
    expect(parse({ all: binding, separate: { ...binding, conversations: [other] } })).toBe(true);
  });
  it.each([
    ["slack", { kind: "channel", id: "D123" }],
    ["telegram", { kind: "bot_direct" }],
    ["telegram", { kind: "group", id: "234" }],
    ["telegram", { kind: "channel", id: "-100123" }],
  ])("rejects broad %s authorization outside a shared command conversation", (connection, conversation) => {
    for (const enabled of [true, false]) {
      expect(imConfigSchema.safeParse({ connections: socialConnections, command_bindings: { users: { enabled, connection, actors: [{ kind: "conversation_users" }], conversations: [conversation], commands: ["help"] } } }).success).toBe(false);
    }
  });
  it("does not enable conversation users on corporate IM or undefined connections", () => {
    for (const connections of [{}, { old: { kind: "wecom_aibot", corp_id: "ww_example", aibot_id: "bot-1", callback: { enabled: false } } }]) {
      expect(imConfigSchema.safeParse({ connections }).success).toBe(true);
      expect(imConfigSchema.safeParse({ connections, command_bindings: { users: { connection: "old", actors: [{ kind: "conversation_users" }], conversations: [{ kind: "group", id: "group" }], commands: ["help"] } } }).success).toBe(false);
    }
  });
  it("redacts bot paths and temporary reply credentials", () => {
    for (const value of [
      "https://api.telegram.org/bot123:abcdefghij/sendMessage",
      "Authorization: Bot abcdefghij",
      "Authorization: Bearer abcdefghij",
      "https://hooks.slack.com/commands/T123/secret",
      "https://discord.com/api/v10/webhooks/123/secret",
    ]) {
      expect(scrubText(value).text).not.toContain("abcdefghij");
      expect(scrubText(value).text).not.toContain("/secret");
      expect(scrubText(value).matches.length).toBeGreaterThan(0);
    }
  });
});
