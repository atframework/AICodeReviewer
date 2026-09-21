import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appConfigSchema, type ReviewEvent } from "@aicr/core";
import { createOutputPublisherFromConfig, createCompositeOutputPublisher } from "../src/bootstrap.js";

const event: ReviewEvent = { triggerName: "p4", provider: "p4", workspaceId: "team", targetKind: "commit",
  repoRef: "//depot/main", headSha: "42", reason: "p4:commit", submitterWorkspace: "build_alice_PC", author: { username: "buildbot" } };
const channel = { name: "app", kind: "feishu_app", app_id: "cli_test", app_secret: "test-secret", receive_id: "oc_target",
  member_directory: { chat_id: "oc_source" }, mention_author: true };
function config(overrides: Record<string, unknown> = {}) {
  return appConfigSchema.parse({ outputs: { channels: [{ ...channel, ...overrides }] },
    triggers: [{ name: "p4", kind: "p4", workspace: "alice-service-client" }], workspaces: { instances: { team: {} } } });
}
function stubApi(failedDirectory = false, failedSend = false) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    const result = url.includes("tenant_access_token") ? { code: 0, tenant_access_token: "token", expire: 7200 }
      : url.includes("/members?") ? failedDirectory ? { code: 99991672 } : { code: 0, data: { has_more: false,
        items: [{ member_id_type: "open_id", member_id: "ou_alice", name: "王小明" }] } }
      : url.includes("/contact/") ? { code: 0, data: { user: { open_id: "ou_alice", nickname: "alice", email: "alice@example.com" } } }
      : failedSend ? { code: 230002 } : { code: 0, data: { message_id: "om_report" } };
    return { ok: true, status: 200, json: async () => result, text: async () => JSON.stringify(result) };
  });
  return calls;
}
function card(calls: ReturnType<typeof stubApi>) {
  return calls.filter(call => call.url.includes("/messages?")).map(call => JSON.parse(String(call.body.content)));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Feishu app configured publisher", () => {
  it("uses an injected guesser only after rules fail and renders validated native mentions", async () => {
    const calls = stubApi();
    const guesser = vi.fn(async () => "ou_alice");
    const unknown = { ...event, submitterWorkspace: "xiaoming_laptop" };
    await createOutputPublisherFromConfig(config(), "app", undefined, "team", unknown, process.cwd(), undefined, undefined, guesser)!.publishSummary!("Summary", []);
    expect(guesser).toHaveBeenCalledOnce();
    expect(JSON.stringify(card(calls))).toContain('id=\\"ou_alice\\"');
    calls.length = 0; guesser.mockClear();
    await createOutputPublisherFromConfig(config({ guess_author: false }), "app", undefined, "team", unknown, process.cwd(), undefined, undefined, guesser)!.publishSummary!("Summary", []);
    expect(guesser).not.toHaveBeenCalled(); expect(JSON.stringify(card(calls))).not.toContain("<at");
    calls.length = 0;
    await createOutputPublisherFromConfig(config({ mention_fallback: "all" }), "app", undefined, "team", unknown, process.cwd(), undefined, undefined, async () => undefined)!.publishSummary!("Summary", []);
    expect(JSON.stringify(card(calls))).not.toContain("<at");
  });
  it("uses the configured identity fallback chain and retains request overrides", async () => {
    vi.stubEnv("IDENTITY_TEST_KEY", "test");
    try {
      const parsed = config();
      parsed.llm = appConfigSchema.parse({ llm: { providers: [{ id: "p", kind: "openai_compatible", base_url: "https://identity.example/v1", api_key_env: "IDENTITY_TEST_KEY" }],
        default_model_chain: "review", author_resolution_model_chain: "identity", model_chain: {
          review: [{ provider: "p", model: "review", role: "heavy" }],
          identity: [{ provider: "p", model: "first", role: "light" }, { provider: "p", model: "second", role: "light", overrides: { extra_body: { sentinel: "fallback-override" } } }],
        } } }).llm;
      const calls = stubApi(); const feishuFetch = globalThis.fetch;
      const requests: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (!String(url).startsWith("https://identity.example")) return feishuFetch(url, init);
        const body = JSON.parse(String(init?.body)); requests.push(body);
        return new Response(JSON.stringify(body.model === "first" ? { error: { message: "unavailable" } }
          : { choices: [{ message: { content: '{"candidate":"u0","confidence":"high"}' } }] }), { status: body.model === "first" ? 503 : 200, headers: { "content-type": "application/json" } });
      });
      await createOutputPublisherFromConfig(parsed, "app", undefined, "team", { ...event, submitterWorkspace: "xiaoming-laptop" })!.publishSummary!("Summary", []);
      expect(requests.map(body => body.model)).toEqual(["first", "second"]);
      expect(requests[1]?.sentinel).toBe("fallback-override");
      expect(JSON.stringify(card(calls))).toContain('id=\\"ou_alice\\"');
    } finally { vi.unstubAllEnvs(); }
  });
  it("uses submitter workspace, native card mentions and shared webhook workspace templates", async () => {
    await mkdir(resolve("build/tmp"), { recursive: true });
    const root = await mkdtemp(resolve("build/tmp/feishu-templates-"));
    try {
      await mkdir(join(root, "workspaces/team/templates"), { recursive: true });
      await writeFile(join(root, "workspaces/team/templates/feishu_bot.summary.hbs"), "SHARED {{vcs.workspace}} {{atMentions}} {{summary}}");
      const calls = stubApi();
      const parsed = config();
      const publisher = createOutputPublisherFromConfig(parsed, "app", undefined, "team", event, root)!;
      const result = await publisher.publishSummary!("Summary", [{ file: "a.ts", line: 3, severity: "high", category: "bug", message: "Details" }]);
      expect(result).toMatchObject({ status: "published", externalId: "om_report" });
      expect(JSON.stringify(card(calls))).toContain("SHARED build_alice_PC");
      expect(JSON.stringify(card(calls))).toContain('id=\\"ou_alice\\"');
      expect(JSON.stringify(card(calls))).toContain("Details");
      expect(calls[1]?.url).toContain("/chats/oc_source/members?");
      await createOutputPublisherFromConfig(parsed, "app", undefined, "team", event, root)!.publishSummary!("Again", []);
      expect(calls.filter(call => call.url.includes("tenant_access_token"))).toHaveLength(1);
      expect(calls.filter(call => call.url.includes("/members?"))).toHaveLength(1);
      await createOutputPublisherFromConfig(config(), "app", undefined, "team", event, root)!.publishSummary!("New generation", []);
      expect(calls.filter(call => call.url.includes("tenant_access_token"))).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("uses named templates and email without leaking raw VCS usernames into mention tags", async () => {
    const calls = stubApi();
    const parsed = config({ templates: { summary: "shared" } });
    parsed.outputs.templates.shared = "NAMED {{event.author}} {{atMentions}}";
    const publisher = createOutputPublisherFromConfig(parsed, "app", undefined, "team", {
      ...event, provider: "github", submitterWorkspace: "wrong-alice-workspace", author: { username: "github_login", email: "alice@example.com" },
    })!;
    await publisher.publishSummary!("Summary", []);
    expect(card(calls)[0].body.elements[0].content).toContain('NAMED github_login <at id="ou_alice"></at>');
  });
  it("does not substitute the service workspace or query a directory when mentions are disabled", async () => {
    const calls = stubApi();
    const { submitterWorkspace: _workspace, ...withoutWorkspace } = event;
    await createOutputPublisherFromConfig(config(), "app", undefined, "team", withoutWorkspace)!.publishSummary!("Summary", []);
    expect(JSON.stringify(card(calls))).not.toContain("<at");
    calls.length = 0;
    await createOutputPublisherFromConfig(config({ mention_author: false }), "app", undefined, "team", event)!.publishSummary!("Summary", []);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(card(calls))).not.toContain("<at");
  });
  it("keeps the application API origin out of review target links", async () => {
    const calls = stubApi();
    const publisher = createOutputPublisherFromConfig(config({ base_url: "https://open.larksuite.com" }), "app", undefined, "team", {
      ...event, provider: "gitea", targetKind: "push", repoRef: "owner/repo", headSha: "abcdef1234567890",
    })!;
    await publisher.publishSummary!("Summary", []);
    expect(calls.every(call => call.url.startsWith("https://open.larksuite.com/open-apis/"))).toBe(true);
    expect(JSON.stringify(card(calls))).not.toContain("https://open.larksuite.com");
  });
  it("still sends without mentions after directory failure; treats nonzero send codes as failed receipts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = stubApi(true);
    const publisher = createOutputPublisherFromConfig(config({ mention_fallback: "all" }), "app", undefined, "team", event)!;
    await expect(publisher.publishSummary!("Summary", [])).resolves.toMatchObject({ status: "published" });
    expect(JSON.stringify(card(calls))).not.toContain("<at");
    expect(warn).toHaveBeenCalled();
    stubApi(false, true);
    const failed = createOutputPublisherFromConfig(config(), "app", undefined, "team", event)!;
    const composite = createCompositeOutputPublisher([], [{ name: "app", publisher: failed }]);
    await expect(composite.publishSummary!("Summary", [])).resolves.toMatchObject([{ channel: "app", status: "failed" }]);
  });
  it("applies default empty-summary suppression before any API calls and accepts environment credentials", async () => {
    const calls = stubApi();
    vi.stubEnv("FEISHU_TEST_APP_SECRET", "from-env");
    try {
      const publisher = createOutputPublisherFromConfig(config({ app_secret: undefined, app_secret_env: "FEISHU_TEST_APP_SECRET" }), "app", undefined, "team", event)!;
      const composite = createCompositeOutputPublisher([], [{ name: "app", publisher }]);
      await expect(composite.publishSummary!("", [])).resolves.toEqual([]);
      expect(calls).toHaveLength(0);
      await composite.publishSummary!("Nonempty", []);
      expect(calls[0]?.body.app_secret).toBe("from-env");
    } finally { vi.unstubAllEnvs(); }
  });
});
