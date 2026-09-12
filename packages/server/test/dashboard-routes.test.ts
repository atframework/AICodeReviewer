import type { StoreDb } from "@aicr/store";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServerApp } from "../src/index.js";

describe("dashboard routes", () => {
  afterEach(() => vi.useRealTimers());
  async function dashboardScript() {
    const html = await (await createServerApp({}).request("/dashboard")).text();
    const elements = new Map<string, { innerHTML: string; textContent: string; disabled: boolean; value: string;
      style: Record<string, string>; classList: { active: boolean; contains: () => boolean }; addEventListener: () => void }>();
    const listeners = new Map<string, () => void>();
    const element = (id: string) => {
      let value = elements.get(id);
      if (!value) {
        value = { innerHTML: "", textContent: "", disabled: false, value: "0", style: {},
          classList: { active: id === "tab-live", contains() { return this.active; } }, addEventListener() {} };
        elements.set(id, value);
      }
      return value;
    };
    const context = createContext({ AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
      localStorage: { removeItem() {} }, document: {
      hidden: false,
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      getElementById: element,
      querySelectorAll: () => [],
      createElement: () => ({ textContent: "", get innerHTML() {
        return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      } }),
    } });
    const script = html.match(/<script>([\s\S]*?)<\/script>/u)![1]!;
    runInContext(script.replace("initDashboard();", ""), context);
    return { context, element, listeners };
  }

  it("renders overview tokens, cache hit rate and absent usage", async () => {
    const { context, element } = await dashboardScript();
    runInContext(`renderRunsTable([
      {workspaceId:'ws',status:'succeeded',llmUsage:{tokensTotal:1200,tokensIn:1000,tokensOut:200,cachedTokens:800}},
      {workspaceId:'empty',status:'skipped'}
    ],document.getElementById('overview-runs'),true)`, context);
    const rendered = element("overview-runs").innerHTML;
    expect(rendered).toContain("80.0%");
    expect(rendered).toContain("miss 200");
    expect(rendered.match(/<td>/gu)).toHaveLength(16);
    expect(rendered).toContain("<td>—</td>");
  });

  it("renders branch, short revision and commit time in the revision cell", async () => {
    const { context, element } = await dashboardScript();
    runInContext(`renderRunsTable([
      {workspaceId:'ws',status:'succeeded',branch:'main',vcsKind:'git',
        headSha:'0123456789abcdef0123456789abcdef01234567',headCommittedAt:'2026-09-10T08:00:00.000Z'},
      {workspaceId:'svn-ws',status:'succeeded',vcsKind:'svn',headSha:'42'},
      {workspaceId:'p4-ws',status:'succeeded',vcsKind:'p4',headSha:'12345'},
      {workspaceId:'unknown-ws',status:'succeeded',headSha:'0123456789abcdef0123456789abcdef01234567'}
    ],document.getElementById('runs-out'),true)`, context);
    const rendered = element("runs-out").innerHTML;
    expect(rendered).toContain("main");
    expect(rendered).toContain("01234567");
    expect(rendered).toContain("r42");
    expect(rendered).toContain("CL 12345");
    expect(rendered).toContain('title="0123456789abcdef0123456789abcdef01234567"');
    expect(rendered).toContain(new Date("2026-09-10T08:00:00.000Z").toLocaleString());
  });

  it("renders the live tab with per-run tokens, cache hit, request count and cost", async () => {
    const { context, element } = await dashboardScript();
    runInContext(`liveData=[{
      runId:'run-1',source:'auto_commit',provider:'gitea',eventName:'push',workspaceId:'ws',triggerName:'nightly',
      repoRef:'org/repo',targetKind:'push',branch:'main',headSha:'0123456789abcdef0123456789abcdef01234567',vcsKind:'git',
      headCommittedAt:'2026-09-10T08:00:00.000Z',modelProviderId:'openai',modelId:'gpt-4o',agentKind:'opencode',attempt:2,
      startedAt:'2026-09-11T10:00:00.000Z',phase:'analyzing',promptTokenEstimate:5000,
      metrics:{promptTokens:1000,completionTokens:200,totalTokens:1200,cachedPromptTokens:600,requestCount:3,estimatedCostUsd:0.0123}
    },{
      runId:'run-2',source:'webhook',provider:'gitlab',eventName:'merge_request',workspaceId:'ws2',triggerName:null,
      repoRef:'org/repo2',targetKind:'pull_request',modelProviderId:'anthropic',modelId:'claude',attempt:1,
      startedAt:'2026-09-11T10:05:00.000Z',phase:'preparing',promptTokenEstimate:5000,metrics:{}
    }];renderLiveTable()`, context);
    const rendered = element("live-table").innerHTML;
    expect(rendered).toContain("auto-commit");
    expect(rendered).toContain("attempt 2");
    expect(rendered).toContain("analyzing");
    expect(rendered).toContain("openai / gpt-4o");
    expect(rendered).toContain("opencode");
    expect(rendered).toContain("1,200");
    expect(rendered).toContain("60.0%");
    expect(rendered).toContain("$0.0123");
    expect(rendered).toContain("main");
    expect(rendered).toContain("01234567");
    expect(rendered).toContain("~5,000 est. prompt");
    expect(rendered).toContain('data-started="2026-09-11T10:00:00.000Z"');
    runInContext("liveData=[];renderLiveTable()", context);
    expect(element("live-table").innerHTML).toContain("No running analyses");
  });

  it("escapes revision attributes and task links and preserves unknown revisions", async () => {
    const { context, element } = await dashboardScript();
    context.row = { branch: '<img src=x>', headSha: 'hash" onmouseover="alert(1)', runId: '<script>',
      title: '<img src=x>', url: 'javascript:alert(1)', workerId: 1, metrics: { totalTokens: 0 } };
    runInContext("liveData=[row];renderLiveTable()", context);
    const html = element("live-table").innerHTML;
    expect(html).toContain('title="hash&quot; onmouseover=&quot;alert(1)"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('Run &lt;script&gt;');
    expect(html).toContain('Committed —');
    expect(html).toContain('<div>0</div>');
    expect(runInContext("formatRevisionShort({headSha:'0123456789abcdef0123456789abcdef01234567'})", context))
      .toBe('0123456789abcdef0123456789abcdef01234567');
  });

  it("defaults to manual refresh and serializes polling after slow requests finish", async () => {
    vi.useFakeTimers();
    const { context, element } = await dashboardScript();
    let respond!: (value: unknown) => void;
    const fetch = vi.fn(() => new Promise((resolve) => { respond = resolve; }));
    Object.assign(context, { fetch, authToken: "token" });
    runInContext("setLiveAuto()", context);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled();
    element("live-auto").value = "5000";
    runInContext("setLiveAuto()", context);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(element("live-refresh").disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await runInContext("loadLiveRuns()", context);
    expect(fetch).toHaveBeenCalledTimes(1);
    respond({ ok: true, status: 200, json: async () => ({ serverTime: new Date().toISOString(), runs: [] }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(element("live-refresh").disabled).toBe(false);
    expect(element("live-table").innerHTML).toContain("No running analyses");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    runInContext("stopLiveRefresh()", context);
    respond({ ok: true, status: 200, json: async () => ({ serverTime: new Date().toISOString(), runs: [] }) });
  });

  it("reports HTTP and malformed responses as errors instead of an empty success", async () => {
    const { context, element } = await dashboardScript();
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    Object.assign(context, { fetch, authToken: "token" });
    await runInContext("loadLiveRuns()", context);
    expect(element("live-indicator").textContent).toContain("HTTP 503");
    expect(element("live-table").textContent).toContain("unavailable");
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ error: "broken" }) });
    await runInContext("liveData=[];loadLiveRuns()", context);
    expect(element("live-indicator").textContent).toContain("Invalid live response");
    expect(element("live-indicator").textContent).toContain("stale");
  });

  it("stops polling on hide/logout and ignores responses from an earlier session", async () => {
    vi.useFakeTimers();
    const { context, element, listeners } = await dashboardScript();
    let respond!: (value: unknown) => void;
    const fetch = vi.fn(() => new Promise((resolve) => { respond = resolve; }));
    Object.assign(context, { fetch, authToken: "old-token" });
    element("live-auto").value = "5000";
    const pending = runInContext("loadLiveRuns()", context);
    runInContext("document.hidden=true", context);
    listeners.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    runInContext("logout();authToken='new-token'", context);
    respond({ ok: false, status: 401 });
    await pending;
    expect(context.authToken).toBe("new-token");
    expect(element("live-auto").value).toBe("0");
    expect(element("live-table").innerHTML).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serves the dashboard shell with the live tab and auto-refresh controls", async () => {
    const app = createServerApp({});
    const response = await app.request("http://localhost/dashboard");
    const html = await response.text();
    expect(html).toContain('data-tab="live"');
    expect(html).toContain('id="tab-live"');
    expect(html).toContain('id="live-auto"');
    expect(html).toContain('id="live-table"');
    expect(html).toContain("api/admin/runs/live");
    expect(html).toContain("Off (manual)");
  });

  it("pages 100 events by 20 and escapes event text and reasons", async () => {
    const { context, element } = await dashboardScript();
    runInContext(`eventsData=Array.from({length:100},function(_,i){return {
      provider:'gitea',repoRef:'<img src=x onerror=alert(1)>',eventName:'event-'+i,
      decision:'ignored',reason:'ignored_by_label',detail:{matchedLabels:['<script>']}
    }});renderEventsPage()`, context);
    expect(element("events-table").innerHTML.match(/<tr>/gu)).toHaveLength(20);
    expect(element("events-table").innerHTML).toContain("event-19");
    expect(element("events-table").innerHTML).not.toContain("event-20");
    expect(element("events-table").innerHTML).not.toContain("<img");
    expect(element("events-table").innerHTML).toContain("&lt;script&gt;");
    expect(element("events-prev").disabled).toBe(true);
    runInContext("eventsPage=5;renderEventsPage();nextEventsPage()", context);
    expect(element("events-page-info").textContent).toBe("100 events · page 5 / 5");
    expect(element("events-next").disabled).toBe(true);
    runInContext("eventsData=[];renderEventsPage()", context);
    expect(element("events-page-info").textContent).toBe("0 events · page 1 / 1");
    expect(element("events-table").innerHTML).toContain("No events");
  });

  it("serves the dashboard shell at / when observability is disabled", async () => {
    const app = createServerApp({});

    const response = await app.request("http://localhost/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("AICodeReviewer Observability");
    expect(html).toContain("Observability dashboard is not configured.");
  });

  it("serves the dashboard shell at /dashboard when observability is disabled", async () => {
    const app = createServerApp({});

    const response = await app.request("http://localhost/dashboard");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("AICodeReviewer Observability");
    expect(html).toContain("var dashboardEnabled=false");
  });

  it("serves the enabled dashboard shell at / when observability is configured", async () => {
    const app = createServerApp({
      observability: {
        store: {} as StoreDb,
        adminAuth: {
          username: "admin",
          password: "secret",
          sessionTtlSeconds: 3600,
        },
      },
    });

    const response = await app.request("http://localhost/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("var dashboardEnabled=true");
    expect(html).toContain("var src=data||providerStatsData;");
  });

  it("redirects the top-level root to the prefixed dashboard", async () => {
    const app = createServerApp({ pathPrefix: "console" });

    const response = await app.request("http://localhost/");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/console/dashboard");
  });

  it("serves the prefixed dashboard shell", async () => {
    const app = createServerApp({ pathPrefix: "console" });

    const response = await app.request("http://localhost/console/dashboard");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("AICodeReviewer Observability");
  });
});
