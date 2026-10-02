import { describe, expect, it, vi } from "vitest";

import { WeComAppClient, type FetchLike, type WeComSendResult } from "../src/index.js";

/**
 * IM-04 acceptance O01–O04: token single-flight/expiry/isolation, exact HTTP
 * shapes for message/send vs appchat/send, the fixed 40014/42001 refresh
 * whitelist, and partial-recipient handling that never resends the whole set.
 */

const response = (data: unknown, status = 200) => ({ ok: status === 200, status, statusText: "test",
  json: async () => data, text: async () => JSON.stringify(data) });

const TOKEN = { errcode: 0, access_token: "private-token-value", expires_in: 7200 };

interface RecordedRequest {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

function recordingFetch(handler: (request: RecordedRequest) => unknown): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn<FetchLike>(async (url, init) => {
    const request: RecordedRequest = { method: init?.method ?? "GET", url: String(url) };
    if (typeof init?.body === "string") request.body = JSON.parse(init.body) as Record<string, unknown>;
    return response(handler(request));
  });
}

function client(fetch: FetchLike, now: () => number = () => 1_000_000): WeComAppClient {
  return new WeComAppClient({ corpId: "ww_example", agentId: 1000002, appSecret: "app-secret", fetch, now });
}

const markdown = { msgtype: "markdown" as const, markdown: { content: "# 报告\n内容" } };

describe("O01: token caching, single-flight and expiry", () => {
  it("shares one gettoken across concurrent sends and refreshes only after expiry", async () => {
    const fetch = recordingFetch(request => (request.url.includes("gettoken") ? TOKEN : { errcode: 0 }));
    const now = vi.fn(() => 1_000_000);
    const app = client(fetch, now);
    await Promise.all([
      app.sendToRecipients(markdown, { users: ["alice"] }),
      app.sendToRecipients(markdown, { users: ["bob"] }),
      app.sendToAppChat(markdown, "chat-1"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(4); // one gettoken + three sends
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("gettoken"))).toHaveLength(1);

    now.mockReturnValue(1_000_000 + (7200 - 120) * 1000 + 1);
    await app.sendToRecipients(markdown, { users: ["alice"] });
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("gettoken"))).toHaveLength(2);
  });

  it("isolates credential versions: distinct clients never share tokens", async () => {
    const fetch = recordingFetch(request => (request.url.includes("gettoken") ? TOKEN : { errcode: 0 }));
    const first = new WeComAppClient({ corpId: "ww_example", agentId: 1000002, appSecret: "secret-a", fetch });
    const second = new WeComAppClient({ corpId: "ww_example", agentId: 1000002, appSecret: "secret-b", fetch });
    await first.sendToRecipients(markdown, { users: ["alice"] });
    await second.sendToRecipients(markdown, { users: ["alice"] });
    const tokenCalls = fetch.mock.calls.filter(([url]) => String(url).includes("gettoken")).map(([url]) => String(url));
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[0]).toContain("corpsecret=secret-a");
    expect(tokenCalls[1]).toContain("corpsecret=secret-b");
  });

  it("never leaks the token outside the request query in errors", async () => {
    const fetch = vi.fn<FetchLike>(async (url) => {
      if (String(url).includes("gettoken")) return response({ errcode: 40091, errmsg: "invalid secret" });
      return response({});
    });
    const result = await client(fetch).sendToRecipients(markdown, { users: ["alice"] });
    expect(result).toMatchObject({ kind: "rejected", errcode: 40091 });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
});

describe("O02: message/send and appchat/send shapes", () => {
  it("posts recipients with agentid and pipe-joined lists", async () => {
    const fetch = recordingFetch(request => (request.url.includes("gettoken") ? TOKEN : { errcode: 0 }));
    await client(fetch).sendToRecipients(markdown, { users: ["alice", "bob"], parties: ["p1"], tags: ["t1"] });
    const send = fetch.mock.calls.map(([url, init]) => ({ url: String(url), init })).find(call => call.url.includes("message/send"))!;
    expect(send.url).toBe("https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=private-token-value");
    expect(send.init?.method).toBe("POST");
    expect(send.init?.body && JSON.parse(String(send.init.body))).toEqual({
      agentid: 1000002, touser: "alice|bob", toparty: "p1", totag: "t1", ...markdown,
    });
  });

  it("posts appchat with chatid only and rejects recipient fields on that endpoint", async () => {
    const fetch = recordingFetch(request => (request.url.includes("gettoken") ? TOKEN : { errcode: 0 }));
    await client(fetch).sendToAppChat({ msgtype: "text", text: { content: "hello" } }, "chat-1");
    const send = fetch.mock.calls.map(([url, init]) => ({ url: String(url), init })).find(call => call.url.includes("appchat/send"))!;
    expect(send.url).toBe("https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=private-token-value");
    expect(JSON.parse(String(send.init?.body))).toEqual({ chatid: "chat-1", msgtype: "text", text: { content: "hello" } });
    await expect(client(fetch).sendToAppChat(markdown, "")).rejects.toThrow(TypeError);
    await expect(client(recordingFetch(() => TOKEN)).sendToRecipients(markdown, {})).rejects.toThrow(/at least one non-empty/u);
  });

  it("refuses oversized content locally without any network call", async () => {
    const fetch = recordingFetch(() => TOKEN);
    const big = { msgtype: "text" as const, text: { content: "汉".repeat(1025) } }; // 3 bytes × 1025 > 2048
    await expect(client(fetch).sendToRecipients(big, { users: ["alice"] })).rejects.toThrow(/2048/u);
    await expect(client(fetch).sendToAppChat(big, "chat-1")).rejects.toThrow(/2048/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a button_interaction card whose task_id and button key carry the opaque action id (IM-15)", async () => {
    const fetch = recordingFetch(request => (request.url.includes("gettoken") ? TOKEN : { errcode: 0, msgid: "msg-1", response_code: "rc-1" }));
    const result = await client(fetch).sendToRecipients({
      msgtype: "template_card",
      template_card: {
        card_type: "button_interaction",
        main_title: { title: "代码评审报告", desc: "org/service" },
        sub_title_text: "修订 0123456789ab",
        task_id: "ima-opaque-1",
        button_list: [{ text: "重新评审", type: 0, key: "ima-opaque-1", style: 1 }],
      },
    }, { users: ["alice"] });
    expect(result).toMatchObject({ kind: "delivered", msgid: "msg-1" });
    const send = fetch.mock.calls.map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined }))
      .find(call => call.url.includes("message/send"))!;
    expect(send.body).toEqual({
      agentid: 1000002, touser: "alice", msgtype: "template_card",
      template_card: {
        card_type: "button_interaction",
        main_title: { title: "代码评审报告", desc: "org/service" },
        sub_title_text: "修订 0123456789ab",
        task_id: "ima-opaque-1",
        button_list: [{ text: "重新评审", type: 0, key: "ima-opaque-1", style: 1 }],
      },
    });
    // The strict task_id charset is enforced before any network call.
    const badTask = recordingFetch(() => TOKEN);
    await expect(client(badTask).sendToRecipients({
      msgtype: "template_card",
      template_card: { card_type: "button_interaction", main_title: { title: "t" }, task_id: "bad task id!", button_list: [{ text: "b", type: 0, key: "k" }] },
    }, { users: ["alice"] })).rejects.toThrow(/task_id/u);
    expect(badTask).not.toHaveBeenCalled();
  });
});

describe("O03: business errors and the fixed refresh whitelist", () => {
  it("refreshes exactly once on 42001 and succeeds on the retry", async () => {
    let sendAttempts = 0;
    const fetch = recordingFetch(request => {
      if (request.url.includes("gettoken")) return TOKEN;
      sendAttempts += 1;
      return sendAttempts === 1 ? { errcode: 42001, errmsg: "access_token expired" } : { errcode: 0 };
    });
    const result = await client(fetch).sendToRecipients(markdown, { users: ["alice"] });
    expect(result).toMatchObject({ kind: "delivered" });
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("gettoken"))).toHaveLength(2);
    expect(sendAttempts).toBe(2);
  });

  it("does not refresh or retry on non-whitelisted codes, HTTP errors or timeouts", async () => {
    const unknownCode = recordingFetch(request => (request.url.includes("gettoken") ? TOKEN : { errcode: 301002, errmsg: "sdk error" }));
    const rejected: WeComSendResult = await client(unknownCode).sendToRecipients(markdown, { users: ["alice"] });
    expect(rejected).toMatchObject({ kind: "rejected", errcode: 301002 });
    expect(unknownCode.mock.calls.filter(([url]) => String(url).includes("gettoken"))).toHaveLength(1);
    expect(unknownCode.mock.calls.filter(([url]) => String(url).includes("message/send"))).toHaveLength(1);

    const http500 = vi.fn<FetchLike>(async (url) => (String(url).includes("gettoken") ? response(TOKEN) : response({}, 500)));
    expect(await client(http500).sendToRecipients(markdown, { users: ["alice"] })).toMatchObject({ kind: "unknown", reason: "http" });

    const timingOut = vi.fn<FetchLike>(async (url) => {
      if (String(url).includes("gettoken")) return response(TOKEN);
      throw new Error("aborted: timeout");
    });
    expect(await client(timingOut).sendToAppChat(markdown, "chat-1")).toMatchObject({ kind: "unknown", reason: "network" });
    for (const fetch of [http500, timingOut]) {
      expect(fetch.mock.calls.filter(([url]) => String(url).includes("message/send") || String(url).includes("appchat/send"))).toHaveLength(1);
    }
  });
});

describe("O04: partial recipient failures", () => {
  it("keeps the delivered remainder without resending the whole set", async () => {
    const fetch = recordingFetch(request => (request.url.includes("gettoken")
      ? TOKEN
      : { errcode: 0, invaliduser: "bob | carol |", unlicenseduser: "dave", msgid: "msg-1" }));
    const result = await client(fetch).sendToRecipients(markdown, { users: ["alice", "bob", "carol", "dave"] });
    expect(result).toEqual({ kind: "partial", invalidUsers: ["bob", "carol"], invalidParties: [], invalidTags: [], unlicensedUsers: ["dave"] });
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("message/send"))).toHaveLength(1);
  });

  it("reports all-invalid recipients as a rejection (81013)", async () => {
    const fetch = recordingFetch(request => (request.url.includes("gettoken") ? TOKEN : { errcode: 81013, errmsg: "all invalid" }));
    const result = await client(fetch).sendToRecipients(markdown, { users: ["alice"] });
    expect(result).toEqual({ kind: "rejected", errcode: 81013, reason: "all recipients are invalid or unlicensed" });
  });
});
