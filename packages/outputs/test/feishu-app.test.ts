import { afterEach, describe, expect, it, vi } from "vitest";

import { FeishuAppClient, createFeishuAppDispatcher, createFeishuBotDispatcher, resolveFeishuMention,
  type FeishuMember, type FetchLike, type ReviewProblem } from "../src/index.js";

const response = (data: unknown, status = 200) => ({ ok: status === 200, status, statusText: "test",
  json: async () => data, text: async () => JSON.stringify(data) });
const token = { code: 0, tenant_access_token: "private-token", expire: 7200 };
const page = (items: unknown[], more = false, next = "") => ({ code: 0, data: { items, has_more: more, page_token: next } });
const member = (id: string, name: string) => ({ member_id: id, member_id_type: "open_id", name });
const alice: FeishuMember = { open_id: "ou_alice", user_id: "a123", union_id: "on_alice", name: "王小明",
  en_name: "Alice Wang", nickname: "alice", email: "alice@example.com", enterprise_email: "aw@work.example", mobile: "+8613800000000" };
const bob: FeishuMember = { open_id: "ou_bob", name: "Bob", email: "bob@example.com" };

afterEach(() => vi.restoreAllMocks());

describe("Feishu directory attribution", () => {
  it.each(["a123", "on_alice", "ou_alice", "王小明", "Alice Wang", "alice", "+8613800000000"])("matches exact identifier %s", username => {
    expect(resolveFeishuMention({ author: { username } }, [alice, bob])).toBe('<at id="ou_alice"></at>');
  });
  it("prioritizes full email, preserves explicit mapping authority, and rejects conflicts", () => {
    const input = { author: { email: " ALICE@EXAMPLE.COM ", username: "Bob" } };
    expect(resolveFeishuMention(input, [alice, bob])).toContain('id="ou_alice"');
    expect(resolveFeishuMention(input, [alice, bob], { mappings: { "alice@example.com": "ou_bob" } })).toContain('id="ou_bob"');
    expect(resolveFeishuMention(input, [alice, bob], { mappings: { "alice@example.com": "ou_alice", Bob: "ou_bob" } })).toBe("");
    expect(resolveFeishuMention(input, [alice], { mappings: { Bob: "ou_absent" }, mentionFallback: "all" })).toBe("");
  });
  it("uses P4 workspace boundaries without tiny, substring, pusher, or ambiguous guesses", () => {
    expect(resolveFeishuMention({ submitterWorkspace: "DEV_Alice.Wang_PC" }, [alice, bob])).toContain('id="ou_alice"');
    expect(resolveFeishuMention({ submitterWorkspace: "build_王小明_01" }, [alice])).toContain('id="ou_alice"');
    expect(resolveFeishuMention({ submitterWorkspace: "malice-server" }, [alice])).toBe("");
    expect(resolveFeishuMention({ submitterWorkspace: "alice-bob" }, [alice, bob], { mentionFallback: "all" })).toBe("");
    expect(resolveFeishuMention({ submitterWorkspace: "ci_li_pc" }, [{ open_id: "ou_li", nickname: "li" }])).toBe("");
    expect(resolveFeishuMention({ author: { fallbackUsername: "alice" } }, [alice])).toBe("");
  });
  it("never guesses past a tied tier or a blacklist and treats IDs as data", () => {
    const duplicate = { ...bob, name: "王小明" };
    expect(resolveFeishuMention({ author: { displayName: "王小明" }, submitterWorkspace: "alice-pc" }, [alice, duplicate], { mentionFallback: "all" })).toBe("");
    expect(resolveFeishuMention({ author: { email: "ALICE@example.com" }, submitterWorkspace: "alice-pc" }, [alice], {
      mappings: { "ALICE@example.com": "ou_alice" }, emailBlacklist: ["alice@example.com"], mentionFallback: "all",
    })).toBe("");
    expect(resolveFeishuMention({ author: { username: "alice" } }, undefined, { mappings: { alice: 'ou_x"><at id="all' } })).toBe("");
    expect(resolveFeishuMention({ author: { username: "alice" } }, undefined)).toBe("");
    expect(resolveFeishuMention({ author: { username: "nobody" } }, [], { mentionFallback: "all" })).toBe('<at id="all"></at>');
  });
});

describe("Feishu application API", () => {
  it("paginates by has_more (including empty pages), enriches profiles, and shares concurrent refreshes", async () => {
    const fetch = vi.fn<FetchLike>(async url => {
      if (url.includes("tenant_access_token")) return response(token);
      if (url.includes("/members?")) return response(url.includes("page_token=") ? page([member("ou_alice", "王小明")]) : page([], true, "next+/="));
      return response({ code: 0, data: { user: alice } });
    });
    const client = new FeishuAppClient({ appId: "cli_test", appSecret: "private-secret", fetch });
    const [a, b] = await Promise.all([client.members("oc_team"), client.members("oc_team")]);
    expect(a).toEqual([alice]);
    expect(b).toBe(a);
    expect(await client.members("oc_team")).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[2]?.[0]).toContain("page_token=next%2B%2F%3D");
    expect(fetch.mock.calls[3]?.[0]).toContain("/contact/v3/users/ou_alice?user_id_type=open_id");
    expect(fetch.mock.calls[3]?.[1]?.headers?.Authorization).toBe("Bearer private-token");
  });
  it("refreshes expired tokens/directories and isolates apps", async () => {
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetch = vi.fn<FetchLike>(async url => response(url.includes("tenant_access_token") ? { ...token, expire: 120 } : page([])));
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", fetch });
    await client.members("oc_a", 30);
    now += 31_000;
    await client.members("oc_a", 30);
    expect(fetch).toHaveBeenCalledTimes(3);
    now += 31_000;
    await client.members("oc_a", 0);
    await client.members("oc_a", 0);
    expect(fetch).toHaveBeenCalledTimes(6);
    await new FeishuAppClient({ appId: "b", appSecret: "s", fetch }).members("oc_a");
    expect(fetch).toHaveBeenCalledTimes(8);
  });
  it("applies the 12h default TTL and serves an expired snapshot when refresh fails", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let fail = false;
    const warn = vi.fn();
    const fetch = vi.fn<FetchLike>(async url => {
      if (url.includes("tenant_access_token")) return response(token);
      if (url.includes("/members?")) return fail ? response({}, 503) : response(page([member("ou_alice", "王小明")]));
      return response({ code: 0, data: { user: alice } });
    });
    const memberCalls = () => fetch.mock.calls.filter(([url]) => url.includes("/members?")).length;
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", onDirectoryWarning: warn, fetch });
    const first = await client.members("oc_a");
    now += 3_600_000; // 1h < 12h default: still fresh
    expect(await client.members("oc_a")).toBe(first);
    expect(memberCalls()).toBe(1);
    now += 43_200_000; // past the 12h default: refresh
    expect(await client.members("oc_a")).toEqual(first);
    expect(memberCalls()).toBe(2);
    now += 43_200_000; // expired again; refresh fails -> stale snapshot with warning
    fail = true;
    expect(await client.members("oc_a")).toEqual(first);
    expect(warn).toHaveBeenCalledExactlyOnceWith("stale_directory_used");
    fail = false; // the stale serve did not extend the TTL: the next call retries the refresh
    expect(await client.members("oc_a")).toEqual(first);
    expect(memberCalls()).toBe(4);
  });
  it("keeps rejecting a failed refresh when no snapshot exists yet", async () => {
    const warn = vi.fn();
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", onDirectoryWarning: warn,
      fetch: async url => response(url.includes("tenant_access_token") ? token : { code: 99991672, msg: "denied" }, 403) });
    await expect(client.members("oc_a")).rejects.toThrow(/Feishu/);
    expect(warn).not.toHaveBeenCalledWith("stale_directory_used");
  });
  it("zero TTL bypasses a fresh snapshot and never falls back to it", async () => {
    let failed = false;
    const fetch = vi.fn<FetchLike>(async url => response(url.includes("tenant_access_token") ? token
      : failed ? { code: 99991672 } : page([])));
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", fetch });
    await client.members("oc_a");
    await client.members("oc_a", 0);
    expect(fetch.mock.calls.filter(([url]) => url.includes("/members?"))).toHaveLength(2);
    failed = true;
    await expect(client.members("oc_a", 0)).rejects.toThrow(/Feishu/);
  });
  it.each([
    { code: 99991672 },
    { code: 0, data: { items: [], has_more: false, trigger_security_conf_limit: true } },
  ])("invalidates a snapshot after denied or incomplete membership", async failure => {
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let failed = false;
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", fetch: async url =>
      response(url.includes("tenant_access_token") ? token : failed ? failure : page([])) });
    await client.members("oc_a", 1);
    now += 1_000;
    failed = true;
    await expect(client.members("oc_a", 1)).rejects.toThrow(/Feishu/);
    // A later, longer TTL must not resurrect the invalidated snapshot.
    await expect(client.members("oc_a")).rejects.toThrow(/Feishu/);
  });
  it.each([
    { items: [], has_more: true },
    { items: [], has_more: true, page_token: "loop" },
    { items: [], has_more: false, trigger_security_conf_limit: true },
    { items: [member("bad-id", "bad")], has_more: false },
  ])("rejects partial/malformed membership without retaining it", async data => {
    let fail = true;
    const fetch: FetchLike = async url => response(url.includes("tenant_access_token") ? token : fail ? { code: 0, data } : page([]));
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", fetch });
    await expect(client.members("oc_a")).rejects.toThrow(/Feishu/);
    fail = false;
    expect(await client.members("oc_a")).toEqual([]);
  });
  it("retains basic group fields when contact scope is unavailable, without logging profiles", async () => {
    const warn = vi.fn();
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", onDirectoryWarning: warn, fetch: async url => {
      if (url.includes("tenant_access_token")) return response(token);
      if (url.includes("/members?")) return response(page([member("ou_alice", "王小明")]));
      return response({ code: 99991672, msg: "private-email private-token" }, 403);
    } });
    expect(await client.members("oc_a")).toEqual([{ open_id: "ou_alice", name: "王小明" }]);
    expect(warn).toHaveBeenCalledExactlyOnceWith("profiles_unavailable");
  });
  it("shares the exact webhook card and returns the application message receipt", async () => {
    let webhookBody: Record<string, unknown> = {};
    const problems: ReviewProblem[] = [{ file: "x.ts", line: 2, severity: "high", category: "bug", message: "m".repeat(900), suggestion: "fix" }];
    await createFeishuBotDispatcher({ webhookUrl: "https://unused", fetch: async (_url, init) => {
      webhookBody = JSON.parse(init?.body ?? "{}"); return response({ code: 0 });
    } }).publishAggregatedProblems(problems, "# Summary\n\n```ts\nconst a = 1;\n```", '<at id="ou_alice"></at>');
    const fetch = vi.fn<FetchLike>(async url => response(url.includes("tenant_access_token") ? token : { code: 0, data: { message_id: "om_test" } }));
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", fetch });
    const result = await createFeishuAppDispatcher({ client, receiveId: "oc_target" }).publishAggregatedProblems(problems,
      "# Summary\n\n```ts\nconst a = 1;\n```", '<at id="ou_alice"></at>');
    expect(result).toEqual({ channel: "feishu_app", status: "published", externalId: "om_test" });
    const request = JSON.parse(fetch.mock.calls[1]?.[1]?.body ?? "{}");
    expect(JSON.parse(request.content)).toEqual(webhookBody.card);
    expect(request).toMatchObject({ receive_id: "oc_target", msg_type: "interactive", uuid: expect.any(String) });
    expect(request).not.toHaveProperty("card");
    expect(fetch.mock.calls[1]?.[0]).toBe("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id");
  });
  it("sends a brief card with the issue link and keeps the mention when issueLinkCard is brief", async () => {
    let webhookBody: Record<string, unknown> = {};
    const problems: ReviewProblem[] = [
      { file: "a.ts", line: 1, severity: "high", category: "bug", message: "full-message-one", suggestion: "fix-one" },
      { file: "b.ts", line: 2, severity: "low", category: "style", message: "full-message-two" },
    ];
    await createFeishuBotDispatcher({ webhookUrl: "https://unused", fetch: async (_url, init) => {
      webhookBody = JSON.parse(init?.body ?? "{}"); return response({ code: 0 });
    } }).publishAggregatedProblems(problems, "# Review Complete\n\nAll good.", '<at id="ou_alice"></at>',
      { detailLink: { url: "https://github.com/o/r/issues/42", label: "View full report" }, issueLinkCard: "brief" });
    const card = webhookBody.card as { body: { elements: { content?: string }[] } };
    const markdown = card.body.elements[0]?.content ?? "";
    // brief: headline + count + link, no problem titles or bodies
    expect(markdown).toContain("Review Complete");
    expect(markdown).toContain("Problems (2)");
    expect(markdown).toContain("https://github.com/o/r/issues/42");
    expect(markdown).not.toContain("[HIGH] bug");
    expect(markdown).not.toContain("full-message-one");
    expect(markdown).not.toContain("full-message-two");
    // mention preserved as a trailing element
    const mention = card.body.elements.at(-1)?.content ?? "";
    expect(mention).toBe('<at id="ou_alice"></at>');
  });
  it("lists per-problem titles with the issue link by default", async () => {
    let webhookBody: Record<string, unknown> = {};
    const problems: ReviewProblem[] = [
      { file: "a.ts", line: 1, endLine: 3, severity: "high", category: "bug", message: "full-message-one", suggestion: "fix-one" },
      { file: "b.ts", line: 2, severity: "low", category: "style", message: "full-message-two" },
    ];
    await createFeishuBotDispatcher({ webhookUrl: "https://unused", fetch: async (_url, init) => {
      webhookBody = JSON.parse(init?.body ?? "{}"); return response({ code: 0 });
    } }).publishAggregatedProblems(problems, "# Review Complete\n\nAll good.", '<at id="ou_alice"></at>',
      { detailLink: { url: "https://github.com/o/r/issues/42", label: "View full report" } });
    const card = webhookBody.card as { body: { elements: { content?: string }[] } };
    const markdown = card.body.elements[0]?.content ?? "";
    // titles (default): headline + count + one title line per problem + link, no full bodies
    expect(markdown).toContain("Review Complete");
    expect(markdown).toContain("Problems (2)");
    expect(markdown).toContain("1. [HIGH] bug — a.ts:1-3");
    expect(markdown).toContain("2. [LOW] style — b.ts:2");
    expect(markdown).toContain("Full details: [View full report](https://github.com/o/r/issues/42)");
    expect(markdown).not.toContain("full-message-one");
    expect(markdown).not.toContain("full-message-two");
    expect(card.body.elements.at(-1)?.content ?? "").toBe('<at id="ou_alice"></at>');
  });
  it("renders full problem sections with the issue link when issueLinkCard is full", async () => {
    let webhookBody: Record<string, unknown> = {};
    const problems: ReviewProblem[] = [
      { file: "a.ts", line: 1, severity: "high", category: "bug", message: "full-message-one", suggestion: "fix-one" },
    ];
    await createFeishuBotDispatcher({ webhookUrl: "https://unused", fetch: async (_url, init) => {
      webhookBody = JSON.parse(init?.body ?? "{}"); return response({ code: 0 });
    } }).publishAggregatedProblems(problems, "# Review Complete", undefined,
      { detailLink: { url: "https://github.com/o/r/issues/42", label: "View full report" }, issueLinkCard: "full" });
    const card = webhookBody.card as { body: { elements: { content?: string }[] } };
    const markdown = card.body.elements[0]?.content ?? "";
    expect(markdown).toContain("Review Complete");
    expect(markdown).toContain("## Problems (1)");
    expect(markdown).toContain("### 1. [HIGH] bug");
    expect(markdown).toContain("- Location: `a.ts:1`");
    expect(markdown).toContain("- Message: full-message-one");
    expect(markdown).toContain("- Suggestion: fix-one");
    expect(markdown).toContain("Full details: [View full report](https://github.com/o/r/issues/42)");
  });
  it("caps the title list at ten problems and keeps the link for empty results", async () => {
    let webhookBody: Record<string, unknown> = {};
    const problems: ReviewProblem[] = Array.from({ length: 12 }, (_, i) =>
      ({ file: `f${i}.ts`, line: i + 1, severity: "medium" as const, category: "bug", message: `m${i}` }));
    const fetchImpl: FetchLike = async (_url, init) => {
      webhookBody = JSON.parse(init?.body ?? "{}"); return response({ code: 0 });
    };
    const dispatcher = createFeishuBotDispatcher({ webhookUrl: "https://unused", fetch: fetchImpl });
    await dispatcher.publishAggregatedProblems(problems, "# Review Complete", undefined,
      { detailLink: { url: "https://github.com/o/r/issues/42", label: "View full report" } });
    const card = webhookBody.card as { body: { elements: { content?: string }[] } };
    const markdown = card.body.elements[0]?.content ?? "";
    expect(markdown).toContain("**Problems (12)**");
    expect(markdown).toContain("10. [MEDIUM] bug — f9.ts:10");
    expect(markdown).not.toContain("f10.ts");
    expect(markdown).toContain("... and 2 more");
    await dispatcher.publishAggregatedProblems([], "# Review Complete", undefined,
      { detailLink: { url: "https://github.com/o/r/issues/42", label: "View full report" } });
    const emptyMarkdown = (webhookBody.card as { body: { elements: { content?: string }[] } }).body.elements[0]?.content ?? "";
    expect(emptyMarkdown).toContain("Review Complete");
    expect(emptyMarkdown).toContain("Full details: [View full report](https://github.com/o/r/issues/42)");
    expect(emptyMarkdown).not.toContain("Problems (");
  });
  it.each([99991663, 99991671])("refreshes rejected token %s once using the same send UUID", async code => {
    let sends = 0;
    const fetch = vi.fn<FetchLike>(async url => response(url.includes("tenant_access_token") ? token : ++sends === 1
      ? { code } : { code: 0, data: { message_id: "om_ok" } }));
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", fetch });
    await expect(client.sendCard("ou_alice", "open_id", {})).resolves.toBe("om_ok");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[3]?.[1]?.body);
  });
  it.each([{ code: 230002, msg: "secret profile" }, { code: 0, data: {} }, { msg: "bad" }])("rejects failed or malformed send responses", async result => {
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", fetch: async url => response(url.includes("tenant_access_token") ? token : result) });
    await expect(client.sendCard("oc_a", "chat_id", {})).rejects.toThrow(/Feishu/);
    await expect(client.sendCard("oc_a", "chat_id", {})).rejects.not.toThrow(/secret profile/);
  });
  it("does not retry transport failures after message submission or expose the cause", async () => {
    const fetch = vi.fn<FetchLike>(async url => {
      if (url.includes("tenant_access_token")) return response(token);
      throw new Error("secret-token private-profile");
    });
    const client = new FeishuAppClient({ appId: "a", appSecret: "s", fetch });
    await expect(client.sendCard("oc_a", "chat_id", {})).rejects.toThrow("Feishu send message failed (HTTP 0).");
    await expect(client.sendCard("oc_a", "chat_id", {})).rejects.toMatchObject({ status: undefined });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
