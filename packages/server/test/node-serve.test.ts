import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { serveAsync } from "../src/node-serve.js";

describe("serve", () => {
  it("starts an HTTP server that responds to requests", async () => {
    const app = new Hono();
    app.get("/test", (c) => c.json({ ok: true }));

    const server = await serveAsync(app, { port: 0 });
    const address = server.address();

    expect(address).toBeDefined();

    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/test`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("returns 500 on handler error", async () => {
    const app = new Hono();
    app.get("/error", () => {
      throw new Error("test error");
    });

    const server = await serveAsync(app, { port: 0 });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/error`);
      expect(response.status).toBe(500);
    } finally {
      server.close();
    }
  });
});
