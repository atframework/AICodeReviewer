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
    it.each([true, false])(
      "shares overlapping readiness reads and clears the in-flight result after success=%s",
      async (success) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let blocked = false;
        let fail = false;
        const normal = api(fixture, () => response(fixture.receipt));
        const fetch = vi.fn<FetchLike>(async (url, init) => {
          if (blocked) await gate;
          if (fail) throw new Error("metadata unavailable");
          return normal(url, init);
        });
        const client = new SocialImClient(
          fixture.connection,
          "123:test-token",
          { fetch, now: () => 1000 },
        );
        expect(await client.refreshReadiness(fixture.destination)).toBe(true);
        fetch.mockClear();
        blocked = true;
        fail = !success;
        const first = client.refreshReadiness(fixture.destination);
        const second = client.refreshReadiness(fixture.destination);
        expect(client.isReady(fixture.destination)).toBe(true);
        release();
        expect(await Promise.all([first, second])).toEqual([success, success]);
        expect(fetch).toHaveBeenCalledTimes(success ? 2 : 1);
        expect(client.isReady(fixture.destination)).toBe(success);
        blocked = false;
        fail = false;
        fetch.mockClear();
        expect(await client.refreshReadiness(fixture.destination)).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(2);
      },
    );
    it("keeps unexpired readiness during refresh, expires on time, and renews only on success", async () => {
      let time = 1000;
      let blocked = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const normal = api(fixture, () => response(fixture.receipt));
      const fetch: FetchLike = async (url, init) => {
        if (blocked) await gate;
        return normal(url, init);
      };
      const client = new SocialImClient(fixture.connection, "123:test-token", {
        fetch,
        now: () => time,
      });
      expect(await client.refreshReadiness(fixture.destination)).toBe(true);
      time = 241000;
      expect(client.isReady(fixture.destination)).toBe(true);
      expect(client.isReady(fixture.destination, 60000)).toBe(false);
      blocked = true;
      const refresh = client.refreshReadiness(fixture.destination);
      expect(client.isReady(fixture.destination)).toBe(true);
      time = 300999;
      expect(client.isReady(fixture.destination)).toBe(true);
      time = 301000;
      expect(client.isReady(fixture.destination)).toBe(false);
      release();
      expect(await refresh).toBe(true);
      expect(client.isReady(fixture.destination, 60000)).toBe(true);
      time = 601000;
      expect(client.isReady(fixture.destination)).toBe(false);
    });
    it.each(["identity", "transport"])(
      "invalidates previously ready targets after a failed %s refresh",
      async (failure) => {
        let fail = false;
        const normal = api(fixture, () => response(fixture.receipt));
        const fetch: FetchLike = async (url, init) => {
          if (!fail) return normal(url, init);
          if (failure === "transport") throw new Error("unavailable");
          return response({
            ok: true,
            team_id: "TOTHER",
            user_id: "UOTHER",
            bot_id: "BOTHER",
            id: "999",
            result: { id: 999, is_bot: true, username: "OtherBot" },
          });
        };
        const client = new SocialImClient(
          fixture.connection,
          "123:test-token",
          { fetch, now: () => 1000 },
        );
        expect(await client.refreshReadiness(fixture.destination)).toBe(true);
        fail = true;
        expect(await client.refreshReadiness(fixture.destination)).toBe(false);
        expect(client.isReady(fixture.destination)).toBe(false);
        expect(
          await client.sendMessage(fixture.destination, { text: "report" }),
        ).toEqual({ kind: "rejected", code: "destination_not_ready" });
      },
    );
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
  it("treats heading-like inline content literally without recursive heading parsing", () => {
    expect(toTelegramMessage("**# literal**").text).toBe("# literal");
    expect(toTelegramMessage("# # `literal`").text).toBe("# literal");
    const result = toTelegramMessage("# ".repeat(5000) + "end");
    expect(result.text.length).toBeLessThanOrEqual(3900);
    expect(result.text).toContain("truncated");
  });
  it.each(["````", "~~~~"])("preserves %s fenced source through Telegram entity conversion", fence => {
    const code = "# literal 🙂\n```\n<!-- aicr:fingerprint=source -->\n\n\nvalue\n";
    const result = toTelegramMessage(`## Code\r\n\r\n${fence}md\r\n${code.replace(/\n/gu, "\r\n")}${fence}`);
    expect(result.text).toBe("Code\n\n" + code);
    expect(result.entities).toContainEqual({ type: "pre", offset: 6, length: code.length, language: "md" });
  });
  it("keeps unfinished fences and inline mentions as source instead of metadata or control markup", () => {
    const source = "`@everyone **source**`\n\n```md\n<!-- aicr:fingerprint=source -->\n# source\n";
    expect(toDiscordMarkdown(source)).toBe(source);
    const result = toTelegramMessage(source);
    expect(result.text).toBe("@everyone **source**\n\n<!-- aicr:fingerprint=source -->\n# source\n");
    expect(result.entities?.filter(e => e.type === "pre")).toHaveLength(1);
  });
  it.each(["slack", "discord", "telegram"] as const)("normalizes %s CRLF reports outside code and hides only internal metadata", platform => {
    const source = "## Report\r\n\r\n\r\n**HIGH · correctness**\r\n\r\n<!-- aicr:fingerprint=hidden -->\r\n\r\n\r\nBody\r\n\r\n```cpp\r\n// **literal**\r\n\r\n\r\n// <!-- aicr:fingerprint=source-code -->\r\n```\r\n\r\n`<!-- aicr:fingerprint=inline-code -->`";
    const text = platform === "slack" ? toBoundedSlackMarkdown(source) : platform === "discord" ? toDiscordMarkdown(source) : toTelegramMessage(source).text;
    expect(text).not.toContain("\r");
    expect(text).not.toContain("aicr:fingerprint=hidden");
    expect(text).toContain(platform === "slack" ? "&lt;!-- aicr:fingerprint=source-code --&gt;" : "<!-- aicr:fingerprint=source-code -->");
    expect(text).toContain("aicr:fingerprint=inline-code");
    expect(text).toContain("// **literal**\n\n\n// ");
    expect(text).not.toContain("correctness**\n\n\n");
  });
  it("renders Telegram headings and bold containing code without overlapping code entities", () => {
    const result = toTelegramMessage("## 🙂 Report\n\n**Referenced code (`src/a.cpp:42`):**\n\n**two\nlines**");
    expect(result.text).toBe("🙂 Report\n\nReferenced code (src/a.cpp:42):\n\ntwo\nlines");
    expect(result.entities).toContainEqual({ type: "bold", offset: 0, length: "🙂 Report".length });
    const code = result.entities!.find(e => e.type === "code")!;
    expect(result.text.slice(code.offset, code.offset + code.length)).toBe("src/a.cpp:42");
    for (const entity of result.entities!.filter(e => e.type === "bold")) {
      expect(entity.offset >= code.offset + code.length || entity.offset + entity.length <= code.offset).toBe(true);
    }
    expect(result.entities!.some(e => e.type === "bold" && result.text.slice(e.offset, e.offset + e.length) === "two\nlines")).toBe(true);
  });
  it("keeps Slack inline source literal and removes only fence language metadata", () => {
    const text = toBoundedSlackMarkdown("**label** `**literal** [not a link](https://example.org)`\n\n```cpp\ncpp\n// **literal**\n```\n\n**two\nlines**");
    expect(text).toContain("`**literal** [not a link](https://example.org)`");
    expect(text).toContain("```\ncpp\n// **literal**\n```");
    expect(text).toContain("*two*\n*lines*");
    expect(toBoundedSlackMarkdown("**Referenced code (`src/a.cpp:42`):**")).toBe("*Referenced code (`src/a.cpp:42`):*");
  });
  it.each(["python", "sh", ""])(
    "preserves heading-like source lines in Telegram %s code blocks",
    (language) => {
      const code = "# keep this comment\n## keep this too\nprint(1)\n";
      const result = toTelegramMessage(
        "# Report\n\n```" +
          language +
          "\n" +
          code +
          "```\n\n## Details\n`# inline`\n#\n\nplain",
      );
      expect(result.text).toBe(
        "Report\n\n" + code + "\n\nDetails\n# inline\n#\n\nplain",
      );
      expect(result.entities?.find((entity) => entity.type === "pre")).toEqual({
        type: "pre",
        offset: 8,
        length: code.length,
        ...(language ? { language } : {}),
      });
      const inline = result.entities?.find((entity) => entity.type === "code");
      expect(
        result.text.slice(inline!.offset, inline!.offset + inline!.length),
      ).toBe("# inline");
    },
  );
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
  it("preserves balanced parentheses in Slack and Telegram links", () => {
    const url = "https://gitlab.example/group/a_(b)/-/issues/1?x=(y)&nested=(a(b)c)";
    const source = `[target](${url})`;
    expect(toBoundedSlackMarkdown(source)).toBe(`<${url.replace("&", "&amp;")}|target>`);
    const telegram = toTelegramMessage(source);
    expect(telegram.text).toBe("target");
    expect(telegram.entities).toEqual([{ type: "text_link", offset: 0, length: 6, url }]);
  });
  it("does not split a multi-backtick inline code token while truncating", () => {
    const source = `${"x".repeat(1837)} \`\`a\`b\`\` ${"y".repeat(100)}`;
    const result = toDiscordMarkdown(source);
    expect(result.length).toBeLessThanOrEqual(1900);
    expect(result).toContain("truncated");
    expect(result).not.toContain("a`b");
  });
  it("converts Slack blockquotes without treating fenced source as quotes", () => {
    expect(toBoundedSlackMarkdown("> quote")).toBe("_quote_");
    expect(toBoundedSlackMarkdown("```\n> code\n```")).toBe("```\n&gt; code\n```");
  });
  it("sends Telegram text links with uppercase HTTP schemes", async () => {
    const fixture = fixtures.find(item => item.connection.kind === "telegram_bot")!;
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = api(fixture, () => response(fixture.receipt));
    const recordingFetch: FetchLike = async (input, init) => {
      if (String(input).endsWith("sendMessage")) calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return fetch(input, init);
    };
    const client = new SocialImClient(fixture.connection, "123:test-token", { fetch: recordingFetch });
    expect(await client.refreshReadiness(fixture.destination)).toBe(true);
    const message = toTelegramMessage("[details](HTTPS://example.org/report)");
    expect(await client.sendMessage(fixture.destination, message)).toMatchObject({ kind: "delivered" });
    expect(calls[0]?.body.entities).toEqual([{ type: "text_link", offset: 0, length: 7, url: "HTTPS://example.org/report" }]);
  });
});
