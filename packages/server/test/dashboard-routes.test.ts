import type { StoreDb } from "@aicr/store";
import { describe, expect, it } from "vitest";

import { createServerApp } from "../src/index.js";

describe("dashboard routes", () => {
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