import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createServerApp } from "../src/index.js";

const webhookSecret = "top-secret";

function sign(payload: string): string {
  return createHmac("sha256", webhookSecret).update(payload).digest("hex");
}

describe("createServerApp", () => {
  it("accepts a signed Gitea pull_request webhook and translates it into a ReviewEvent", async () => {
    const app = createServerApp({
      gitea: {
        triggerName: "gitea-internal",
        workspaceId: "gitea-internal-owent-example",
        webhookSecret,
      },
    });
    const payload = JSON.stringify({
      action: "opened",
      repository: {
        full_name: "owent/example",
      },
      sender: {
        login: "owent",
        email: "owent@example.com",
        full_name: "OwEnt",
      },
      pull_request: {
        html_url: "https://gitea.internal.corp/owent/example/pulls/42",
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
      },
    });

    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "pull_request",
        "x-gitea-signature": sign(payload),
      },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reviewEvent?: { repoRef: string; headSha?: string } };

    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.reviewEvent?.repoRef).toBe("owent/example");
    expect(body.reviewEvent?.headSha).toBe("head-sha");
  });

  it("rejects a webhook when the HMAC signature does not match", async () => {
    const app = createServerApp({
      gitea: {
        triggerName: "gitea-internal",
        workspaceId: "gitea-internal-owent-example",
        webhookSecret,
      },
    });
    const payload = JSON.stringify({
      repository: { full_name: "owent/example" },
      pull_request: { base: { sha: "base-sha" }, head: { sha: "head-sha" } },
    });

    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "pull_request",
        "x-gitea-signature": "deadbeef",
      },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };

    expect(response.status).toBe(401);
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("invalid_signature");
  });

  it("accepts a Forgejo push webhook through the shared adapter path", async () => {
    const app = createServerApp({
      forgejo: {
        triggerName: "forgejo-community",
        workspaceId: "forgejo-community-example",
        webhookSecret,
      },
    });
    const payload = JSON.stringify({
      before: "old-sha",
      after: "new-sha",
      compare_url: "https://codeberg.org/owent/example/compare/old...new",
      repository: {
        full_name: "owent/example",
      },
      pusher: {
        username: "owent",
        email: "owent@example.com",
        full_name: "OwEnt",
      },
    });

    const response = await app.request("/webhooks/forgejo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "push",
        "x-gitea-signature": sign(payload),
      },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; provider?: string; reviewEvent?: { targetKind?: string } };

    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.provider).toBe("forgejo");
    expect(body.reviewEvent?.targetKind).toBe("push");
  });

  it("returns 503 when the trigger is not configured", async () => {
    const app = createServerApp({});
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitea-event": "pull_request" },
      body: "{}",
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };

    expect(response.status).toBe(503);
    expect(body.reason).toBe("trigger_not_configured");
  });

  it("returns 401 when the signature header is missing while a secret is configured", async () => {
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
    });
    const payload = JSON.stringify({});
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitea-event": "pull_request" },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };

    expect(response.status).toBe(401);
    expect(body.reason).toBe("invalid_signature");
  });

  it("returns 400 when the event header is missing", async () => {
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
    });
    const payload = JSON.stringify({});
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-signature": sign(payload),
      },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };

    expect(response.status).toBe(400);
    expect(body.reason).toBe("missing_event_name");
  });

  it("returns 400 when the JSON body is malformed", async () => {
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
    });
    const payload = "{not-json}";
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "pull_request",
        "x-gitea-signature": sign(payload),
      },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };

    expect(response.status).toBe(400);
    expect(body.reason).toBe("invalid_json");
  });

  it("returns 400 when the payload schema validation fails", async () => {
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
    });
    const payload = JSON.stringify({ /* missing repository */ pull_request: {} });
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "pull_request",
        "x-gitea-signature": sign(payload),
      },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };

    expect(response.status).toBe(400);
    expect(body.reason).toBe("invalid_payload");
    expect(body).toHaveProperty("issues");
  });

  it("returns 202 unsupported_event for unknown event types", async () => {
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
    });
    const payload = JSON.stringify({ repository: { full_name: "owent/example" } });
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "release",
        "x-gitea-signature": sign(payload),
      },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };

    expect(response.status).toBe(202);
    expect(body.reason).toBe("unsupported_event");
  });

  it("accepts the alternative x-gitea-signature-256 header", async () => {
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
    });
    const payload = JSON.stringify({
      action: "synchronize",
      repository: { full_name: "owent/example" },
      pull_request: { base: { sha: "b" }, head: { sha: "h" } },
    });
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "pull_request",
        "x-gitea-signature-256": `sha256=${sign(payload)}`,
      },
      body: payload,
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
  });

  it("prefers x-gitea-signature-256 when both signature headers are present", async () => {
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws", webhookSecret },
    });
    const payload = JSON.stringify({
      action: "opened",
      repository: { full_name: "owent/example" },
      pull_request: { base: { sha: "b" }, head: { sha: "h" } },
    });

    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "pull_request",
        "x-gitea-signature": "deadbeef",
        "x-gitea-signature-256": `sha256=${sign(payload)}`,
      },
      body: payload,
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
  });

  it("skips signature verification when no secret is configured", async () => {
    const app = createServerApp({
      gitea: { triggerName: "gitea-internal", workspaceId: "ws" },
    });
    const payload = JSON.stringify({
      repository: { full_name: "owent/example" },
      pull_request: { base: { sha: "b" }, head: { sha: "h" } },
    });
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "pull_request",
      },
      body: payload,
    });

    expect(response.status).toBe(202);
  });

  it("exposes /healthz and /readyz", async () => {
    const app = createServerApp({});
    const healthz = await app.request("/healthz");
    const readyz = await app.request("/readyz");
    expect(healthz.status).toBe(200);
    expect(await healthz.text()).toBe("ok");
    expect(readyz.status).toBe(200);
    expect(await readyz.text()).toBe("ready");
  });
});