import type { StoreDb } from "@aicr/store";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { createServerApp } from "../src/index.js";

describe("dashboard routes", () => {
  async function dashboardScript() {
    const html = await (await createServerApp({}).request("/dashboard")).text();
    const elements = new Map<string, { innerHTML: string; textContent: string; disabled: boolean; addEventListener: () => void }>();
    const element = (id: string) => {
      let value = elements.get(id);
      if (!value) {
        value = { innerHTML: "", textContent: "", disabled: false, addEventListener() {} };
        elements.set(id, value);
      }
      return value;
    };
    const context = createContext({ document: {
      getElementById: element,
      createElement: () => ({ textContent: "", get innerHTML() {
        return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      } }),
    } });
    const script = html.match(/<script>([\s\S]*?)<\/script>/u)![1]!;
    runInContext(script.replace("initDashboard();", ""), context);
    return { context, element };
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
    expect(rendered.match(/<td>/gu)).toHaveLength(14);
    expect(rendered).toContain("<td>—</td>");
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
