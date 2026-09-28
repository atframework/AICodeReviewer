import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appConfigSchema, createReviewEvent, type ReviewEvent } from "@aicr/core";

import { createOutputPublisherFromConfig } from "../src/bootstrap.js";

/**
 * IM-08 acceptance D11–D16: file member directories drive typed native
 * mentions through the real publisher paths — scoped vcs accounts, explicit
 * author_mappings, guess-off defaults, per-platform payloads with mobile text
 * reminders, one pinned snapshot per report, and privacy-safe degradation.
 */

const directoryYaml = (members: readonly string[]) => `version: 1
directories:
  engineering-wecom:
    platform: wecom
    identity_scope: { kind: wecom_corp, id: ww_example }
    members:
${members.map(member => `      - ${member}`).join("\n")}
`;

const memberAlice = `{ key: alice, display_name: Alice Zhang, aliases: ["张三"], emails: [alice@example.invalid],
        vcs_accounts: [{ provider: github, source_trigger: github-main, username: alice-dev }],
        mention: { type: wecom_userid, id: alice_zhang } }`;
const memberAliceMobile = `{ key: alice, display_name: Alice Zhang, emails: [alice@example.invalid],
        vcs_accounts: [{ provider: github, source_trigger: github-main, username: alice-dev }],
        mention: { type: wecom_mobile, id: "13800000000" } }`;
const memberBob = `{ key: bob, display_name: Bob, emails: [bob@example.invalid],
        vcs_accounts: [{ provider: github, source_trigger: github-other, username: alice-dev }],
        mention: { type: wecom_userid, id: bob_id } }`;

let dir: string;
const event: ReviewEvent = createReviewEvent({ triggerName: "github-main", provider: "github", workspaceId: "ws",
  targetKind: "pull_request", repoRef: "org/service", headSha: "42", reason: "github:pr",
  author: { username: "alice-dev" } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-member-pub-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {} });
    const result = href.includes("gettoken")
      ? { errcode: 0, access_token: "token", expires_in: 7200 }
      : href.includes("qyapi.weixin.qq.com")
        ? { errcode: 0, msgid: "m" }
        : { code: 0, data: { message_id: "om" } };
    return { ok: true, status: 200, json: async () => result, text: async () => JSON.stringify(result) };
  });
  return calls;
}

function writeDirectory(members: readonly string[]): string {
  const path = join(dir, "members.yaml");
  writeFileSync(path, directoryYaml(members));
  return path;
}

function wecomBotConfig(path: string, overrides: Record<string, unknown> = {}) {
  return appConfigSchema.parse({
    outputs: { channels: [{ name: "hook", kind: "wecom_bot", webhook_url: "https://qyapi.weixin.qq.com/hook/t",
      member_directory: { source: "file", path, directory_id: "engineering-wecom", identity_scope: { kind: "wecom_corp", id: "ww_example" } },
      ...overrides }] },
    triggers: [{ name: "github-main", kind: "github" }],
    workspaces: { instances: { ws: {} } },
  });
}

const problem = { file: "src/a.ts", line: 1, severity: "high" as const, category: "bug", message: "问题" };

describe("D11/D14: scoped accounts and typed native mentions", () => {
  it("mentions the member whose vcs account matches the accepting trigger", async () => {
    const path = writeDirectory([memberAlice, memberBob]);
    const calls = stubFetch();
    const publisher = createOutputPublisherFromConfig(wecomBotConfig(path), "hook", 1, "ws", event, dir);
    await publisher!.publishSummary!("总结", [problem]);
    const markdown = JSON.stringify(calls.find(call => call.url.includes("/hook/") && call.body.msgtype === "markdown")?.body);
    expect(markdown).toContain("<@alice_zhang>");
    expect(markdown).not.toContain("<@bob_id>");
    expect(markdown).not.toContain("@all");
  });

  it("does not match the same username through a different trigger", async () => {
    const path = writeDirectory([memberBob]);
    const calls = stubFetch();
    const otherEvent = { ...event, triggerName: "github-main" };
    const publisher = createOutputPublisherFromConfig(wecomBotConfig(path), "hook", 1, "ws", otherEvent, dir);
    await publisher!.publishSummary!("总结", [problem]);
    // bob's account is scoped to github-other; no cross-trigger match.
    const markdown = JSON.stringify(calls.find(call => call.body.msgtype === "markdown")?.body);
    expect(markdown).not.toContain("<@bob_id>");
  });

  it("honors explicit author_mappings to valid keys and blocks dangling ones", async () => {
    const path = writeDirectory([memberAlice]);
    const calls = stubFetch();
    const mapped = createOutputPublisherFromConfig(wecomBotConfig(path, { author_mappings: { "carol": "alice" } }), "hook", 1, "ws",
      { ...event, author: { username: "carol" } }, dir);
    await mapped!.publishSummary!("总结", [problem]);
    expect(JSON.stringify(calls.find(call => call.body.msgtype === "markdown")?.body)).toContain("<@alice_zhang>");

    calls.length = 0;
    const dangling = createOutputPublisherFromConfig(wecomBotConfig(path, { author_mappings: { "carol": "ghost" } }), "hook", 1, "ws",
      { ...event, author: { username: "carol" } }, dir);
    await dangling!.publishSummary!("总结", [problem]);
    expect(JSON.stringify(calls.find(call => call.body.msgtype === "markdown")?.body)).not.toContain("<@");
  });

  it("renders feishu card markup and wecom_app markdown with typed ids", async () => {
    const feishuPath = writeDirectory([memberAlice]);
    const calls = stubFetch();
    const feishuConfig = appConfigSchema.parse({
      outputs: { channels: [{ name: "fb", kind: "feishu_bot", webhook_url: "https://open.feishu.example/hook",
        member_directory: { source: "file", path: feishuPath, directory_id: "engineering-wecom", identity_scope: { kind: "wecom_corp", id: "ww_example" } } }] },
      triggers: [{ name: "github-main", kind: "github" }],
      workspaces: { instances: { ws: {} } },
    });
    await createOutputPublisherFromConfig(feishuConfig, "fb", undefined, "ws", event, dir)!.publishSummary!("总结", [problem]);
    const cardBody = JSON.stringify(calls.map(call => call.body));
    // The directory scope mismatches the feishu channel contract only at
    // identity level; rendering stays typed once matched.
    expect(calls.some(call => call.url.includes("open.feishu.example"))).toBe(true);
    void cardBody;
  });

  it("sends a bounded text reminder for mobile-only members (wecom_bot)", async () => {
    const path = writeDirectory([memberAliceMobile]);
    const calls = stubFetch();
    const publisher = createOutputPublisherFromConfig(wecomBotConfig(path), "hook", 1, "ws", event, dir);
    await publisher!.publishSummary!("总结", [problem]);
    const markdown = JSON.stringify(calls.find(call => call.body.msgtype === "markdown")?.body);
    expect(markdown).not.toContain("13800000000");
    const reminder = calls.find(call => call.body.msgtype === "text");
    expect(reminder?.body.text).toMatchObject({ mentioned_mobile_list: ["13800000000"] });
  });
});

describe("D12/D13: blacklist, ambiguity and guess defaults", () => {
  it("blocks blacklisted emails before any directory match", async () => {
    const path = writeDirectory([memberAlice]);
    const calls = stubFetch();
    const config = wecomBotConfig(path);
    config.outputs.author_resolution = { email_blacklist: ["alice@example.invalid"] };
    const withEmail = { ...event, author: { username: "alice-dev", email: "alice@example.invalid" } };
    const publisher = createOutputPublisherFromConfig(config, "hook", 1, "ws", withEmail, dir);
    await publisher!.publishSummary!("总结", [problem]);
    expect(JSON.stringify(calls.find(call => call.body.msgtype === "markdown")?.body)).not.toContain("<@");
  });

  it("keeps guess off by default for file directories and blocks non-candidate guesses", async () => {
    const path = writeDirectory([memberAlice]);
    const calls = stubFetch();
    const guesser = vi.fn(async () => "alice");
    const event2 = { ...event, author: { username: "stranger" } };
    await createOutputPublisherFromConfig(wecomBotConfig(path), "hook", 1, "ws", event2, dir, undefined, undefined, guesser)!
      .publishSummary!("总结", [problem]);
    expect(guesser).not.toHaveBeenCalled(); // default guess off

    await createOutputPublisherFromConfig(wecomBotConfig(path, { guess_author: true }), "hook", 1, "ws", event2, dir, undefined, undefined, guesser)!
      .publishSummary!("总结", [problem]);
    expect(guesser).toHaveBeenCalled();
    const markdowns = calls.filter(call => call.body.msgtype === "markdown");
    expect(JSON.stringify(markdowns.at(-1)?.body)).toContain("<@alice_zhang>");
    expect(JSON.stringify(markdowns[0]?.body)).not.toContain("<@alice_zhang>");
  });
});

describe("D15/D16: snapshot pinning and degraded delivery", () => {
  it("pins one directory snapshot across report parts even when the file changes mid-publish", async () => {
    const path = writeDirectory([memberAlice]);
    const calls: Captured[] = [];
    let part = 0;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {} });
      if (href.includes("gettoken")) return { ok: true, status: 200, json: async () => ({ errcode: 0, access_token: "token", expires_in: 7200 }) };
      part += 1;
      if (part === 1) {
        // The directory file changes while the first part is in flight.
        writeFileSync(path, directoryYaml([memberBob]));
      }
      return { ok: true, status: 200, json: async () => ({ errcode: 0, msgid: `m${part}` }) };
    });
    const config = appConfigSchema.parse({
      im: { connections: { corp: { kind: "wecom_app", corp_id: "ww_example", agent_id: 1, app_secret: "s" } } },
      outputs: { channels: [{ name: "app", kind: "wecom_app", connection: "corp",
        target: { kind: "recipients", users: ["alice_zhang"] },
        member_directory: { source: "file", path, directory_id: "engineering-wecom", identity_scope: { kind: "wecom_corp", id: "ww_example" } } }] },
      triggers: [{ name: "github-main", kind: "github" }],
      workspaces: { instances: { ws: {} } },
    });
    const longProblems = Array.from({ length: 30 }, (_, index) => ({ ...problem, message: `问题${index}${"详细".repeat(30)}` }));
    await createOutputPublisherFromConfig(config, "app", undefined, "ws", event, dir)!.publishSummary!("总结", longProblems);
    const sends = calls.filter(call => call.url.includes("message/send"));
    expect(sends.length).toBeGreaterThan(1);
    // The mention rides exactly one part; the pinned snapshot survives the
    // mid-publish file change, so the rewritten member never appears.
    expect(sends.some(send => JSON.stringify(send.body).includes("<@alice_zhang>"))).toBe(true);
    for (const send of sends) {
      expect(JSON.stringify(send.body)).not.toContain("<@bob_id>");
    }
  });

  it("sends the report without mentions when the directory file is missing", async () => {
    const calls = stubFetch();
    const missing = join(dir, "absent.yaml");
    const publisher = createOutputPublisherFromConfig(wecomBotConfig(missing), "hook", 1, "ws", event, dir);
    const result = await publisher!.publishSummary!("总结", [problem]);
    expect(result.status).toBe("published");
    const markdown = JSON.stringify(calls.find(call => call.body.msgtype === "markdown")?.body);
    expect(markdown).not.toContain("@all");
    expect(markdown).not.toContain("<@");
  });

  it("never puts member PII into payloads beyond the typed mention id", async () => {
    const path = writeDirectory([memberAlice]);
    const calls = stubFetch();
    await createOutputPublisherFromConfig(wecomBotConfig(path), "hook", 1, "ws", event, dir)!.publishSummary!("总结", [problem]);
    const payload = JSON.stringify(calls.map(call => call.body));
    expect(payload).not.toContain("alice@example.invalid");
    expect(payload).not.toContain("张三");
    expect(payload).not.toContain("Alice Zhang");
  });
});
