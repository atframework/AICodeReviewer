import { describe, expect, it, vi } from "vitest";
import { SocialImClient, type SocialImConnection } from "../src/social-im.js";
import { loadSocialImDirectory } from "../src/social-im-directory.js";
import { toBoundedSlackMarkdown, toDiscordMarkdown, toTelegramMessage } from "../src/social-im-markdown.js";

const slack: SocialImConnection = { kind: "slack_app", app_id: "A123", team_id: "T123", bot_user_id: "U123", token: "test" };
const discord: SocialImConnection = { kind: "discord_bot", application_id: "123", guild_id: "456", token: "test" };

describe("social IM author mentions", () => {
  it("keeps only the trusted Slack/Discord mention after escaping and truncation", () => {
    const content = "<@U666> <@999> <!channel> @everyone 👩‍💻 **report** ".repeat(300);
    const slackText = toBoundedSlackMarkdown(content, "https://example.org/report", "U234");
    expect(slackText.length).toBeLessThanOrEqual(3900);
    expect(slackText).toContain("&lt;@U666&gt;");
    expect(slackText.match(/<@[^>]+>/gu)).toEqual(["<@U234>"]);
    expect(slackText).toContain("https://example.org/report");
    const discordText = toDiscordMarkdown(content, undefined, "234");
    expect(discordText.length).toBeLessThanOrEqual(1900);
    expect(discordText.match(/<@\d+>/gu)).toEqual(["<@234>"]);
    expect(discordText).not.toContain("@everyone");
    expect(toDiscordMarkdown("report", undefined, "@everyone")).toBe("report");
  });
  it("retains Telegram's host-created mention and UTF-16 entity offsets in long emoji reports", () => {
    const message = toTelegramMessage("😀 **summary** `code` [untrusted](tg://user?id=999) ".repeat(500), undefined, "234567891");
    expect(message.text.length).toBeLessThanOrEqual(3900);
    const mentions = message.entities!.filter(e => e.url?.startsWith("tg:"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ type: "text_link", url: "tg://user?id=234567891" });
    expect(message.text.slice(mentions[0]!.offset, mentions[0]!.offset + mentions[0]!.length)).toBe("Review author");
    expect(message.entities!.every(e => e.offset + e.length <= message.text.length)).toBe(true);
  });
  it("keeps native mentions outside unfinished report code fences", () => {
    expect(toDiscordMarkdown("report\n```ts\nconst a = 1;", undefined, "234")).toContain("const a = 1;\n```\n\n<@234>");
    expect(toBoundedSlackMarkdown("report\n```ts\nconst a = 1;", undefined, "U234")).toContain("const a = 1;\n```\n\n<@U234>");
    const truncated = toDiscordMarkdown("report\n~~~ts\n" + "const a = 1;\n".repeat(1000), undefined, "234");
    expect(truncated).not.toContain("~~~");
    expect(truncated).toContain("<@234>");
  });
  it("paginates Slack channel membership and profiles completely, filtering bots, deleted users and outsiders", async () => {
    const read = vi.fn(async (path: string) => {
      if (path.startsWith("conversations.members")) return { ok: true, members: ["U234", "U345", "U456"] };
      return path.includes("cursor=") ? { ok: true, members: [{ id: "U345", deleted: true }, { id: "U456", is_bot: true }] }
        : { ok: true, members: [{ id: "U234", name: "alice", profile: { display_name: "Alice", email: "alice@example.org" } }, { id: "U999", name: "outsider" }], response_metadata: { next_cursor: "next+cursor" } };
    });
    expect(await loadSocialImDirectory(slack, "C123", read)).toEqual([{ id: "U234", names: [], aliases: ["alice", "Alice"], emails: ["alice@example.org"], identifiers: [] }]);
    expect(read.mock.calls[2]![0]).toContain("cursor=next%2Bcursor");
  });
  it.each(["repeated_cursor", "missing_profile", "permission", "missing_cursor"])("rejects incomplete Slack snapshots: %s", async failure => {
    const read = async (path: string) => path.startsWith("conversations.members")
      ? { ok: true, members: ["U234"] }
      : failure === "permission" ? { ok: false, error: "missing_scope" }
      : { ok: true, members: failure === "missing_profile" ? [] : [{ id: "U234" }],
        ...(failure === "repeated_cursor" ? { response_metadata: { next_cursor: "loop" } } : {}),
        ...(failure === "missing_cursor" ? { has_more: true } : {}) };
    await expect(loadSocialImDirectory(slack, "C123", read)).rejects.toThrow("incomplete");
  });
  it("paginates Discord by highest snowflake without inventing email data", async () => {
    const read = vi.fn(async (path: string) => path.includes("after=0")
      ? Array.from({ length: 1000 }, (_, i) => ({ user: { id: String(i + 1), username: `person${i}`, bot: i !== 2 }, nick: "Alice" }))
      : []);
    expect(await loadSocialImDirectory(discord, "789", read)).toEqual([{ id: "3", names: ["Alice"], aliases: ["person2"], emails: [], identifiers: [] }]);
    expect(read.mock.calls[1]![0]).toContain("after=1000");
    await expect(loadSocialImDirectory(discord, "789", async () => [{ user: { id: "bad" } }])).rejects.toThrow();
  });
  it("coalesces directory reads, honors TTL/zero TTL and invalidates failed refreshes", async () => {
    let now = 0;
    let fail = false;
    const fetch = vi.fn(async () => fail ? Response.json({ message: "Forbidden" }, { status: 403 }) : Response.json([{ user: { id: "234", username: "alice" } }]));
    const client = new SocialImClient(discord, "test", { fetch, now: () => now });
    const first = client.members("789", 60);
    expect(client.members("789", 60)).toBe(first);
    await first;
    await client.members("789", 60);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 60_000;
    fail = true;
    await expect(client.members("789", 60)).rejects.toThrow();
    fail = false;
    await client.members("789", 60);
    await client.members("789", 0);
    await client.members("789", 0);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
