import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewEvent } from "@aicr/core";
import { createOutputPublisherFromConfig } from "../src/bootstrap.js";
import { fixture, platforms, apiFixture, SHA, type Platform } from "./social-im-fixtures.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const userId = (platform: Platform) => platform === "slack" ? "U234" : "234567891";
const event = (author = { username: "alice-dev", email: "alice@example.org" }) => createReviewEvent({
  triggerName: "git", provider: "github", workspaceId: "ws", targetKind: "commit", repoRef: "org/demo", headSha: SHA, author, reason: "test",
});
const hasMention = (platform: Platform, body: Record<string, unknown>): boolean => platform === "telegram"
  ? JSON.stringify(body.entities).includes(`tg://user?id=${userId(platform)}`)
  : String(body.text ?? body.content).includes(`<@${userId(platform)}>`);

it.each(platforms)("publishes only the mapped %s author, preserving the mention under truncation", async platform => {
  const { config } = fixture(platform);
  config.outputs.channels[0]!.author_mappings = { "alice@example.org": userId(platform) };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", apiFixture(platform, calls));
  const publisher = createOutputPublisherFromConfig(config, "report", undefined, "ws", event())!;
  expect(await publisher.publishSummary!("😀 **summary** <@999> <!channel> @everyone ".repeat(600), [])).toMatchObject({ status: "published" });
  const body = calls.at(-1)!.body;
  expect(hasMention(platform, body)).toBe(true);
  if (platform === "discord") expect(body.allowed_mentions).toEqual({ parse: [], replied_user: false, users: [userId(platform)] });
  expect(calls.some(c => /users\.list|guilds\/|conversations.members/u.test(c.url))).toBe(false);
});

it.each(platforms)("suppresses %s mentions for disabled, ambiguous, blacklisted and actor-only identities", async platform => {
  for (const mode of ["disabled", "ambiguous", "blacklisted", "actor_only"] as const) {
    const { config } = fixture(platform);
    config.outputs.channels[0]!.author_mappings = { "alice@example.org": userId(platform),
      ...(mode === "ambiguous" ? { "alice-dev": platform === "slack" ? "U999" : "999" } : {}) };
    if (mode === "disabled") config.outputs.channels[0]!.mention_author = false;
    if (mode === "blacklisted") config.outputs.author_resolution = { email_blacklist: ["ALICE@example.org"] };
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", apiFixture(platform, calls));
    const reviewEvent = mode === "actor_only" ? { ...event(), author: { fallbackUsername: "alice-dev" } } : event();
    await createOutputPublisherFromConfig(config, "report", undefined, "ws", reviewEvent)!.publishSummary!("report", []);
    expect(hasMention(platform, calls.at(-1)!.body)).toBe(false);
  }
});

it.each(["slack", "discord"] as const)("uses the %s API directory and sends without mentions on ambiguous or unavailable snapshots", async platform => {
  for (const mode of ["exact", "ambiguous", "forbidden", "disabled"] as const) {
    const { config } = fixture(platform);
    config.outputs.channels[0]!.member_directory = { source: platform === "slack" ? "slack_api" : "discord_api" };
    if (mode === "disabled") config.outputs.channels[0]!.mention_author = false;
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const normal = apiFixture(platform, calls);
    const ids = mode === "ambiguous" ? [userId(platform), platform === "slack" ? "U999" : "999"] : [userId(platform)];
    const directoryRead = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (/users\.list|guilds\/|conversations.members/u.test(String(url))) {
        directoryRead();
        if (mode === "forbidden") return Response.json({}, { status: 403 });
        return Response.json(platform === "discord" ? ids.map(id => ({ user: { id, username: "alice-dev" } }))
          : { ok: true, members: String(url).includes("conversations.members") ? ids : ids.map(id => ({ id, name: "alice-dev", profile: { email: "alice@example.org" } })) });
      }
      return normal(url, init);
    });
    expect(await createOutputPublisherFromConfig(config, "report", undefined, "ws", event())!.publishSummary!("report", [])).toMatchObject({ status: "published" });
    expect(hasMention(platform, calls.at(-1)!.body)).toBe(mode === "exact");
    if (mode === "disabled") expect(directoryRead).not.toHaveBeenCalled();
  }
});

it.each(platforms)("resolves a scoped %s file member key and rejects a mismatched connection scope", async platform => {
  mkdirSync(resolve("build/tmp"), { recursive: true });
  const dir = mkdtempSync(resolve("build/tmp/social-members-"));
  const { config, connection } = fixture(platform);
  const scope = { kind: platform === "slack" ? "slack_team" : platform === "discord" ? "discord_guild" : "telegram_bot",
    id: connection.kind === "slack_app" ? connection.team_id : connection.kind === "discord_bot" ? connection.guild_id : connection.bot_id } as const;
  writeFileSync(join(dir, "members.json"), JSON.stringify({ version: 1, directories: { team: { platform, identity_scope: scope, members: [{
    key: "alice", vcs_accounts: [{ provider: "github", source_trigger: "git", username: "alice-dev" }], mention: { type: `${platform}_user_id`, id: userId(platform) },
  }] } } }));
  try {
    for (const mismatch of [false, true]) {
      config.outputs.channels[0]!.member_directory = { source: "file", path: "members.json", directory_id: "team", identity_scope: { ...scope, id: mismatch ? "other" : scope.id }, watch: false };
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      vi.stubGlobal("fetch", apiFixture(platform, calls));
      await createOutputPublisherFromConfig(config, "report", undefined, "ws", event(), dir)!.publishSummary!("report", []);
      expect(hasMention(platform, calls.at(-1)!.body)).toBe(!mismatch);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
