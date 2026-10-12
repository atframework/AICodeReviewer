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
  it("rejects inline secrets, native mentions and unknown destination features", () => {
    const channel = {
      name: "slack",
      kind: "slack_app",
      connection: "slack",
      channel_id: "C123",
    };
    for (const extra of [
      { token: "secret" },
      { mention_author: true },
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
  it("limits new bindings to exact identities, fixed commands and repositories", () => {
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
