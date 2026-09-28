import { afterEach, describe, expect, it, vi } from "vitest";

import { appConfigSchema, createReviewEvent, type ReviewEvent, type ReviewProblem } from "@aicr/core";
import { PublicationJournal, chunkMarkdownSections } from "@aicr/outputs";

import { createOutputPublisherFromConfig, createOutputPublisherResolverFromConfig } from "../src/bootstrap.js";

/**
 * IM-05 acceptance O05–O08: UTF-8-safe report splitting, the full
 * config→resolver→publisher wiring for wecom_app next to the legacy webhook,
 * the WeCom webhook business-errcode/mobile fixes, and per-part journal
 * recovery that never resends a confirmed part.
 */

const event: ReviewEvent = createReviewEvent({ triggerName: "p4", provider: "p4", workspaceId: "ws", targetKind: "commit",
  repoRef: "//depot/main", headSha: "42", reason: "p4:commit", author: {} });

const TOKEN = { errcode: 0, access_token: "token-a", expires_in: 7200 };

interface Captured {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function wecomConfig(channels: readonly unknown[]) {
  return appConfigSchema.parse({
    im: { connections: { corp: { kind: "wecom_app", corp_id: "ww_example", agent_id: 1000002, app_secret: "test-secret" } } },
    outputs: { channels, routes: { default: { summary: channels.map((channel) => (channel as { name: string }).name) } } },
    triggers: [{ name: "p4", kind: "p4", workspace: "ws-client" }],
    workspaces: { instances: { ws: {} } },
  });
}

function stubWeComApi(options: { failPart?: number; token?: () => string } = {}) {
  const calls: Captured[] = [];
  let sendIndex = 0;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ method: init?.method ?? "GET", url: href, body });
    if (href.includes("gettoken")) {
      return { ok: true, status: 200, json: async () => ({ errcode: 0, access_token: (options.token?.() ?? TOKEN.access_token), expires_in: 7200 }), text: async () => "" };
    }
    sendIndex += 1;
    if (options.failPart === sendIndex) {
      throw new Error("connection reset");
    }
    return { ok: true, status: 200, json: async () => ({ errcode: 0, msgid: `msg-${sendIndex}` }), text: async () => "" };
  });
  return calls;
}

const problem = (message: string): ReviewProblem => ({
  file: "src/main.ts", line: 12, severity: "high", category: "bug", message,
  ...(message.length < 80 ? { suggestion: "修复建议" } : {}),
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("O05: UTF-8 safe report splitting", () => {
  it("never splits a multi-byte character and packs to the platform cap", () => {
    const chinese = "汉".repeat(700); // 2100 bytes alone
    const parts = chunkMarkdownSections(["# 报告", chinese, "尾部段落"]);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(2048);
    }
    expect(parts.join("")).toContain("汉".repeat(699));
    expect(parts.at(-1)).toContain("尾部段落");
  });

  it("keeps exactly-at-cap content in one part", () => {
    const exact = "a".repeat(2048);
    expect(chunkMarkdownSections([exact])).toEqual([exact]);
    expect(chunkMarkdownSections(["a".repeat(2047), "b"])).toHaveLength(2);
  });

  it("sends long Chinese reports as multiple valid markdown parts", async () => {
    const calls = stubWeComApi();
    const config = wecomConfig([{ name: "wecom-app", kind: "wecom_app", connection: "corp", target: { kind: "recipients", users: ["alice"] } }]);
    const publisher = createOutputPublisherFromConfig(config, "wecom-app", undefined, "ws", event, process.cwd());
    const problems = Array.from({ length: 24 }, (_, index) => problem(`问题编号${index}：${"详细描述".repeat(20)}`));
    const result = await publisher!.publishSummary!("总结", problems);
    expect(result.status).toBe("published");
    const sends = calls.filter(call => call.url.includes("message/send"));
    expect(sends.length).toBeGreaterThan(1);
    for (const send of sends) {
      const content = String((send.body.markdown as { content: string }).content);
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(2048);
      expect(content.startsWith("�")).toBe(false);
    }
    expect(sends.every(send => send.body.agentid === 1000002 && send.body.touser === "alice")).toBe(true);
    expect((result.raw as { parts: number }).parts).toBe(sends.length);
  });
});

describe("O06: real config→resolver→publisher wiring", () => {
  it("instantiates the wecom_app channel beside the legacy webhook with unchanged semantics", async () => {
    const calls = stubWeComApi();
    const config = wecomConfig([
      { name: "wecom-app", kind: "wecom_app", connection: "corp", target: { kind: "recipients", users: ["alice"], parties: ["p1"] } },
      { name: "wecom-web", kind: "wecom_bot", webhook_url: "https://qyapi.example/hook" },
    ]);
    const resolve = createOutputPublisherResolverFromConfig(config);
    const publisher = await resolve({ provider: "p4", eventName: "change", payload: {}, reviewEvent: event });
    expect(publisher).toBeDefined();
    await publisher!.publishSummary!("总结", [problem("轻微问题")]);

    const appSend = calls.find(call => call.url.includes("qyapi.weixin.qq.com/cgi-bin/message/send"));
    expect(appSend?.body).toMatchObject({ agentid: 1000002, touser: "alice", toparty: "p1", msgtype: "markdown" });
    const hook = calls.find(call => call.url.includes("qyapi.example/hook"));
    expect(hook).toBeDefined();
    expect(hook?.body).toMatchObject({ msgtype: "markdown" });
    expect(JSON.stringify(hook?.body)).not.toContain("mentioned_mobile_list");
  });

  it("appchat targets go through appchat/send without recipient fields", async () => {
    const calls = stubWeComApi();
    const config = wecomConfig([{ name: "wecom-group", kind: "wecom_app", connection: "corp", target: { kind: "appchat", chat_id: "chat-1" } }]);
    const publisher = createOutputPublisherFromConfig(config, "wecom-group", undefined, "ws", event, process.cwd());
    await publisher!.publishSummary!("总结", [problem("问题")]);
    const send = calls.find(call => call.url.includes("appchat/send"));
    expect(send?.body).toMatchObject({ chatid: "chat-1", msgtype: "markdown" });
    expect(send?.body).not.toHaveProperty("agentid");
    expect(send?.body).not.toHaveProperty("touser");
    expect(calls.find(call => call.url.includes("message/send"))).toBeUndefined();
  });
});

describe("O07: WeCom webhook business errcode and mobile fields", () => {
  const botConfig = (mobiles?: readonly string[]) => appConfigSchema.parse({
    outputs: { channels: [{ name: "hook", kind: "wecom_bot", webhook_url: "https://qyapi.example/hook", ...(mobiles ? { mentioned_mobile_list: mobiles } : {}) }] },
    triggers: [{ name: "p4", kind: "p4", workspace: "ws-client" }],
    workspaces: { instances: { ws: {} } },
  });

  it("treats HTTP 200 + errcode!=0 as a failed dispatch", async () => {
    const calls: Captured[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      calls.push({ method: "POST", url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return { ok: true, status: 200, json: async () => ({ errcode: 45009, errmsg: "api freq out of limit" }), text: async () => "" };
    });
    const publisher = createOutputPublisherFromConfig(botConfig(), "hook", undefined, "ws", event, process.cwd());
    await expect(publisher!.publishSummary!("总结", [problem("问题")])).rejects.toThrow(/errcode 45009/u);
  });

  it("moves mobile mentions to a bounded text message instead of the markdown object", async () => {
    const calls: Captured[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      calls.push({ method: "POST", url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return { ok: true, status: 200, json: async () => ({ errcode: 0 }), text: async () => "" };
    });
    const publisher = createOutputPublisherFromConfig(botConfig(["13800000000"]), "hook", undefined, "ws", event, process.cwd());
    const result = await publisher!.publishSummary!("总结", [problem("问题")]);
    expect(result.status).toBe("published");
    const markdown = calls.find(call => (call.body.msgtype === "markdown"));
    expect(JSON.stringify(markdown?.body)).not.toContain("mentioned_mobile_list");
    const text = calls.find(call => call.body.msgtype === "text");
    expect((text?.body.text as Record<string, unknown>)).toMatchObject({ mentioned_mobile_list: ["13800000000"] });
  });
});

describe("O08: per-part journal recovery", () => {
  it("fails the call on an unconfirmed part without resending the confirmed one", async () => {
    const saved: unknown[] = [];
    const calls = stubWeComApi({ failPart: 2, token: () => "token-a" });
    const config = wecomConfig([{ name: "wecom-app", kind: "wecom_app", connection: "corp", target: { kind: "recipients", users: ["alice"] } }]);
    const publisher = createOutputPublisherFromConfig(config, "wecom-app", undefined, "ws", event, process.cwd());
    const journal = new PublicationJournal({ batchId: "b1", operations: [], save: async ops => { saved.push(structuredClone(ops)); } });
    const problems = Array.from({ length: 20 }, (_, index) => problem(`问题编号${index}：${"详细描述".repeat(20)}`));
    await expect(journal.run("wecom-app", "summary:0", () => publisher!.publishSummary!("总结", problems)))
      .rejects.toThrow("unconfirmed_write");
    const sends = calls.filter(call => call.url.includes("message/send"));
    expect(sends.length).toBeGreaterThan(1);

    // Retry with the same rendered content: the confirmed part must not POST
    // again and the unknown part must fail closed instead of sending a
    // duplicate. (The transport keeps failing part 2 on purpose.)
    await expect(journal.run("wecom-app", "summary:0", () => publisher!.publishSummary!("总结", problems)))
      .rejects.toThrow("publisher_cannot_reconcile");
    expect(calls.filter(call => call.url.includes("message/send"))).toHaveLength(sends.length);
    const statuses = (saved.at(-1) as { status: string }[]).map(op => op.status);
    expect(statuses).toContain("confirmed");
    expect(statuses).toContain("unknown");
    expect(JSON.stringify(saved)).not.toContain("token-a");
  });

  it("marks explicit business rejections as rejected so later retries stay legal", async () => {
    const saved: unknown[] = [];
    let errcode = 0;
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      if (href.includes("gettoken")) {
        return { ok: true, status: 200, json: async () => ({ errcode: 0, access_token: "token-a", expires_in: 7200 }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({ errcode, msgid: "m" }), text: async () => "" };
    });
    const config = wecomConfig([{ name: "wecom-app", kind: "wecom_app", connection: "corp", target: { kind: "recipients", users: ["alice"] } }]);
    const publisher = createOutputPublisherFromConfig(config, "wecom-app", undefined, "ws", event, process.cwd());
    const journal = new PublicationJournal({ batchId: "b2", operations: [], save: async ops => { saved.push(structuredClone(ops)); } });

    errcode = 45009;
    const rejected = await journal.run("wecom-app", "summary:0", () => publisher!.publishSummary!("总结", [problem("问题")]));
    expect(rejected.status).toBe("failed");
    const rejectedOps = saved.at(-1) as { status: string }[];
    expect(rejectedOps.at(-1)?.status).toBe("rejected");

    errcode = 0;
    const retried = await journal.run("wecom-app", "summary:0", () => publisher!.publishSummary!("总结", [problem("问题")]));
    expect(retried.status).toBe("published");
  });
});
