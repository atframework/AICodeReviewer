import { describe, expect, it, vi } from "vitest";
import type { RemotePublicationOperation } from "@aicr/core";
import {
  SocialImClient,
  type SocialImConnection,
  type SocialImSendResult,
} from "../src/social-im.js";
import {
  toBoundedSlackMarkdown,
  toDiscordMarkdown,
  toTelegramMessage,
} from "../src/social-im-markdown.js";
import { PublicationJournal } from "../src/publication-journal.js";
import type { FetchLike, ResponseLike } from "../src/index.js";

const response = (
  raw: unknown,
  status = 200,
  headers: Record<string, string> = {},
): ResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: "test",
  headers: { get: (key) => headers[key] ?? null },
  json: async () => raw,
  text: async () => JSON.stringify(raw),
});
const fixtures: {
  connection: SocialImConnection;
  destination: string;
  receipt: unknown;
}[] = [
  {
    connection: {
      kind: "slack_app",
      app_id: "A123",
      team_id: "T123",
      bot_user_id: "U123",
      token_env: "TOKEN",
    },
    destination: "C123",
    receipt: { ok: true, channel: "C123", ts: "1.234" },
  },
  {
    connection: {
      kind: "discord_bot",
      application_id: "123456789012345678",
      guild_id: "123456789012345679",
      token_env: "TOKEN",
    },
    destination: "123456789012345680",
    receipt: { id: "123456789012345681", channel_id: "123456789012345680" },
  },
  {
    connection: { kind: "telegram_bot", bot_id: "123", token_env: "TOKEN" },
    destination: "-100123",
    receipt: { ok: true, result: { message_id: 42, chat: { id: -100123 } } },
  },
];
function api(
  fixture: (typeof fixtures)[number],
  send: () => ResponseLike | Promise<ResponseLike>,
) {
  return vi.fn<FetchLike>(async (url) => {
    if (url.includes("auth.test"))
      return response({
        ok: true,
        team_id: "T123",
        user_id: "U123",
        bot_id: "B123",
      });
    if (url.includes("conversations.info"))
      return response({
        ok: true,
        channel: {
          id: fixture.destination,
          context_team_id: "T123",
          is_im: false,
          is_mpim: false,
          is_archived: false,
          is_member: true,
          is_channel: true,
        },
      });
    if (url.includes("oauth2/applications"))
      return response({ id: "123456789012345678" });
    if (url.endsWith(fixture.destination))
      return response({
        id: fixture.destination,
        guild_id: "123456789012345679",
        type: 0,
      });
    if (url.endsWith("getMe"))
      return response({
        ok: true,
        result: { id: 123, is_bot: true, username: "AicrBot" },
      });
    if (url.endsWith("getChat"))
      return response({
        ok: true,
        result: { id: -100123, type: "supergroup" },
      });
    return send();
  });
}

describe.each(fixtures)(
  "$connection.kind API and publication recovery",
  (fixture) => {
    it("rejects metadata with an unsupported destination type or a different platform domain", async () => {
      const normal = api(fixture, () => response(fixture.receipt));
      const fetch: FetchLike = async (url, init) => {
        if (url.includes("conversations.info"))
          return response({
            ok: true,
            channel: {
              id: fixture.destination,
              context_team_id: "TOTHER",
              is_im: false,
              is_mpim: false,
              is_archived: false,
              is_member: true,
              is_channel: true,
            },
          });
        if (url.endsWith(fixture.destination))
          return response({
            id: fixture.destination,
            guild_id: "999",
            type: 0,
          });
        if (url.endsWith("getChat"))
          return response({
            ok: true,
            result: { id: -100123, type: "supergroup", is_forum: true },
          });
        return normal(url, init);
      };
      const client = new SocialImClient(fixture.connection, "123:test-token", {
        fetch,
      });
      expect(await client.refreshReadiness(fixture.destination)).toBe(false);
      expect(
        await client.sendMessage(fixture.destination, { text: "report" }),
      ).toEqual({ kind: "rejected", code: "destination_not_ready" });
    });
    it("distinguishes explicit business rejection, ambiguous server failure and a receipt for another target", async () => {
      let raw: unknown =
        fixture.connection.kind === "slack_app"
          ? { ok: false, error: "not_in_channel" }
          : fixture.connection.kind === "telegram_bot"
            ? { ok: false, error_code: 403 }
            : {};
      let status = fixture.connection.kind === "discord_bot" ? 403 : 200;
      const client = new SocialImClient(fixture.connection, "123:test-token", {
        fetch: api(fixture, () => response(raw, status)),
      });
      await client.refreshReadiness(fixture.destination);
      expect(
        await client.sendMessage(fixture.destination, { text: "report" }),
      ).toMatchObject({ kind: "rejected" });
      raw =
        fixture.connection.kind === "slack_app"
          ? { ok: false, error: "internal_error" }
          : { ok: false, error_code: 500 };
      status = fixture.connection.kind === "discord_bot" ? 500 : 200;
      expect(
        await client.sendMessage(fixture.destination, { text: "report" }),
      ).toMatchObject({ kind: "unknown" });
      raw =
        fixture.connection.kind === "slack_app"
          ? { ok: true, channel: "COTHER", ts: "1.234" }
          : fixture.connection.kind === "discord_bot"
            ? { id: "123", channel_id: "999" }
            : { ok: true, result: { message_id: 42, chat: { id: -999 } } };
      status = 200;
      expect(
        await client.sendMessage(fixture.destination, { text: "report" }),
      ).toMatchObject({ kind: "unknown", code: "invalid_message_receipt" });
    });
    it("does not repeat an explicit rejection after a fresh journal restores the checkpoint", async () => {
      let saved: readonly RemotePublicationOperation[] = [];
      let sends = 0;
      const fetch = api(fixture, () => {
        sends++;
        return response({}, 403);
      });
      const client = new SocialImClient(fixture.connection, "123:test-token", {
        fetch,
      });
      await client.refreshReadiness(fixture.destination);
      const journal = () =>
        new PublicationJournal({
          batchId: "rejected",
          operations: saved,
          save: async (ops) => {
            saved = structuredClone(ops);
          },
        });
      const send = () =>
        client.sendMessage(fixture.destination, { text: "report" });
      expect(await journal().run("report", "summary:0", send)).toMatchObject({
        kind: "rejected",
        code: "http_403",
      });
      expect(await journal().run("report", "summary:0", send)).toMatchObject({
        kind: "rejected",
        code: "previously_rejected",
      });
      expect(sends).toBe(1);
    });
    it("validates destination identity before sending and requires the complete business receipt", async () => {
      let raw = fixture.receipt;
      const fetch = api(fixture, () => response(raw));
      const client = new SocialImClient(fixture.connection, "123:test-token", {
        fetch,
      });
      expect(
        await client.sendMessage(fixture.destination, { text: "report" }),
      ).toMatchObject({ kind: "rejected", code: "destination_not_ready" });
      expect(fetch).not.toHaveBeenCalled();
      expect(await client.refreshReadiness(fixture.destination)).toBe(true);
      expect(
        await client.sendMessage(fixture.destination, { text: "report" }),
      ).toMatchObject({ kind: "delivered" });
      raw = {};
      expect(
        await client.sendMessage(fixture.destination, { text: "report" }),
      ).toMatchObject({ kind: "unknown" });
      const init = fetch.mock.calls.at(-1)![1]!;
      expect(init.redirect).toBe("error");
      const body = JSON.parse(init.body!);
      if (fixture.connection.kind === "discord_bot")
        expect(body.allowed_mentions).toEqual({
          parse: [],
          replied_user: false,
        });
      if (fixture.connection.kind === "telegram_bot")
        expect(body).toMatchObject({
          chat_id: fixture.destination,
          entities: [],
          link_preview_options: { is_disabled: true },
        });
      if (fixture.connection.kind === "slack_app")
        expect(body).toMatchObject({
          parse: "none",
          unfurl_links: false,
          unfurl_media: false,
        });
    });
    it("fresh journals replay confirmed receipts and never resend an unknown write", async () => {
      let saved: readonly RemotePublicationOperation[] = [];
      let sends = 0;
      let loseResponse = false;
      const fetch = api(fixture, () => {
        sends++;
        if (loseResponse) throw new Error("lost response with TOKEN");
        return response(fixture.receipt);
      });
      const client = new SocialImClient(fixture.connection, "123:test-token", {
        fetch,
      });
      await client.refreshReadiness(fixture.destination);
      const journal = (batchId: string) =>
        new PublicationJournal({
          batchId,
          operations: saved,
          save: async (ops) => {
            saved = structuredClone(ops);
          },
        });
      const send = () =>
        client.sendMessage(fixture.destination, {
          text: "private report body",
        });
      expect(
        (
          (await journal("one").run(
            "report",
            "summary:0",
            send,
          )) as SocialImSendResult
        ).kind,
      ).toBe("delivered");
      expect(
        (
          (await journal("one").run(
            "report",
            "summary:0",
            send,
          )) as SocialImSendResult
        ).kind,
      ).toBe("delivered");
      expect(sends).toBe(1);
      expect(JSON.stringify(saved)).not.toContain("private report");
      expect(JSON.stringify(saved)).not.toContain("test-token");
      saved = [];
      loseResponse = true;
      await expect(
        journal("two").run("report", "summary:0", send),
      ).rejects.toThrow("unconfirmed_write");
      await expect(
        journal("two").run("report", "summary:0", send),
      ).rejects.toThrow("unconfirmed_write");
      expect(sends).toBe(2);
      expect(saved[0]?.status).toBe("unknown");
    });
    it("expires readiness and schedules explicit rate limits without sleeping or retransmitting", async () => {
      let time = 1000;
      let sends = 0;
      const raw =
        fixture.connection.kind === "telegram_bot"
          ? { ok: false, error_code: 429, parameters: { retry_after: 10 } }
          : { retry_after: 10 };
      const fetch = api(fixture, () => {
        sends++;
        return response(raw, 429, { "Retry-After": "10" });
      });
      const client = new SocialImClient(fixture.connection, "123:test-token", {
        fetch,
        now: () => time,
      });
      await client.refreshReadiness(fixture.destination);
      expect(
        await client.sendMessage(fixture.destination, { text: "report" }),
      ).toEqual({ kind: "rejected", code: "rate_limited", retryAt: 11000 });
      await client.sendMessage(fixture.destination, { text: "report" });
      expect(sends).toBe(1);
      time = 301000;
      expect(client.isReady(fixture.destination)).toBe(false);
    });
  },
);
describe("social IM message formatting", () => {
  it("escapes untrusted Slack controls and converts bold and safe links", () => {
    const text = toBoundedSlackMarkdown(
      "**bold** <@U123> <!channel> [safe](https://example.org) [unsafe](javascript:alert)",
    );
    expect(text).toContain("*bold*");
    expect(text).toContain("&lt;@U123&gt;");
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("<https://example.org|safe>");
    expect(text).not.toContain("javascript:");
  });
  it("keeps surrogate pairs, combining marks, code and links within the total budget", () => {
    const text = "👩‍💻e\u0301".repeat(1000) + "\n```js\nlong code\n```";
    for (const [converted, limit] of [
      [toBoundedSlackMarkdown(text), 3900],
      [toDiscordMarkdown(text), 1900],
    ] as const) {
      expect(converted.length).toBeLessThanOrEqual(limit);
      expect(converted).not.toContain("�");
      expect(converted).toContain("truncated");
      const prefix = converted.split("\n\n…")[0]!;
      expect(prefix.endsWith("e")).toBe(false);
      expect(prefix.endsWith("\u200d")).toBe(false);
    }
  });
  it("calculates Telegram entities against the final UTF-16 text and never creates mention entities", () => {
    const result = toTelegramMessage(
      "🙂 **bold** `code` [link](https://example.org) <@123> @everyone",
    );
    expect(result.text).toBe("🙂 bold code link <@123> @everyone");
    expect(result.entities).toEqual([
      { type: "bold", offset: 3, length: 4 },
      { type: "code", offset: 8, length: 4 },
      { type: "text_link", offset: 13, length: 4, url: "https://example.org" },
    ]);
    const long = toTelegramMessage("🙂 **" + "界".repeat(5000) + "**");
    expect(long.text.length).toBeLessThanOrEqual(3900);
    for (const entity of long.entities ?? [])
      expect(entity.offset + entity.length).toBeLessThanOrEqual(
        long.text.indexOf("\n\n…"),
      );
  });
});
