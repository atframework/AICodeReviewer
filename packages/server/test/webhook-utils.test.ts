import { describe, expect, it } from "vitest";

import {
  computeWebhookSignature,
  translateWebhookToReviewEvent,
  verifyWebhookSignature,
} from "../src/gitea-webhook.js";

describe("computeWebhookSignature", () => {
  it("produces a deterministic hex string for a given payload and secret", () => {
    const payload = '{"action":"opened"}';
    const secret = "webhook-secret";
    const sig = computeWebhookSignature(payload, secret);

    expect(sig).toMatch(/^[0-9a-f]{64}$/u);
    expect(computeWebhookSignature(payload, secret)).toBe(sig);
  });

  it("produces different signatures for different payloads with the same secret", () => {
    const secret = "webhook-secret";
    const sig1 = computeWebhookSignature("payload1", secret);
    const sig2 = computeWebhookSignature("payload2", secret);

    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for the same payload with different secrets", () => {
    const payload = '{"action":"opened"}';
    const sig1 = computeWebhookSignature(payload, "secret1");
    const sig2 = computeWebhookSignature(payload, "secret2");

    expect(sig1).not.toBe(sig2);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "top-secret";
  const payload = '{"hello":"world"}';
  const validHex = computeWebhookSignature(payload, secret);

  it("accepts a matching hex signature", () => {
    expect(verifyWebhookSignature(payload, secret, validHex)).toBe(true);
  });

  it("accepts the sha256= prefixed form (case-insensitive)", () => {
    expect(verifyWebhookSignature(payload, secret, `SHA256=${validHex}`)).toBe(true);
  });

  it("rejects a tampered signature of correct length", () => {
    const tampered = `${"0".repeat(validHex.length - 1)}1`;
    expect(verifyWebhookSignature(payload, secret, tampered)).toBe(false);
  });

  it("rejects signatures of the wrong length without throwing", () => {
    expect(verifyWebhookSignature(payload, secret, "deadbeef")).toBe(false);
  });

  it("rejects non-hex signatures", () => {
    const nonHex = `${"z".repeat(validHex.length)}`;
    expect(verifyWebhookSignature(payload, secret, nonHex)).toBe(false);
  });

  it("rejects when signature is missing but a secret is configured", () => {
    expect(verifyWebhookSignature(payload, secret, undefined)).toBe(false);
  });

  it("returns true when no secret is configured (verification disabled)", () => {
    expect(verifyWebhookSignature(payload, undefined, undefined)).toBe(true);
  });

  it("rejects an empty string signature when a secret is configured", () => {
    expect(verifyWebhookSignature(payload, secret, "")).toBe(false);
  });

  it("handles whitespace in the sha256= prefix by trimming", () => {
    expect(verifyWebhookSignature(payload, secret, `sha256= ${validHex}`)).toBe(true);
  });
});

describe("translateWebhookToReviewEvent", () => {
  const config = { triggerName: "gitea-internal", workspaceId: "ws" };

  it("returns null for an unsupported event type", () => {
    const event = translateWebhookToReviewEvent(
      "gitea",
      "release",
      { repository: { full_name: "owent/example" } },
      config,
    );
    expect(event).toBeNull();
  });

  it("derives the author from sender first, then pull_request.user", () => {
    const event = translateWebhookToReviewEvent(
      "gitea",
      "pull_request",
      {
        action: "opened",
        repository: { full_name: "owent/example" },
        pull_request: {
          base: { sha: "b" },
          head: { sha: "h" },
          user: { login: "fallback-author" },
        },
      },
      config,
    );

    expect(event?.author.username).toBe("fallback-author");
  });

  it("propagates the provider into reason and provider fields for forgejo", () => {
    const event = translateWebhookToReviewEvent(
      "forgejo",
      "pull_request",
      {
        action: "opened",
        repository: { full_name: "owent/example" },
        pull_request: { base: { sha: "b" }, head: { sha: "h" } },
      },
      config,
    );

    expect(event?.provider).toBe("forgejo");
    expect(event?.reason).toBe("forgejo:opened");
  });

  it("translates push events with before/after shas", () => {
    const event = translateWebhookToReviewEvent(
      "gitea",
      "push",
      {
        before: "abc123",
        after: "def456",
        compare_url: "https://gitea.example.com/owent/example/compare/abc123...def456",
        repository: { full_name: "owent/example" },
        pusher: { login: "pusher-user", email: "pusher@example.com" },
        commits: [
          { added: ["src/new.ts"], modified: ["src/app.ts"], removed: ["src/old.ts"] },
        ],
        head_commit: { modified: ["src/app.ts", "README.md"] },
      },
      config,
    );

    expect(event?.targetKind).toBe("push");
    expect(event?.baseSha).toBe("abc123");
    expect(event?.headSha).toBe("def456");
    expect(event?.url).toBe(
      "https://gitea.example.com/owent/example/compare/abc123...def456",
    );
    expect(event?.author.username).toBe("pusher-user");
    expect(event?.changedFiles).toEqual(["src/new.ts", "src/app.ts", "src/old.ts", "README.md"]);
  });

  it("uses sender over pull_request.user when both are present", () => {
    const event = translateWebhookToReviewEvent(
      "gitea",
      "pull_request",
      {
        action: "synchronize",
        repository: { full_name: "owent/example" },
        sender: { login: "sender-user", email: "sender@example.com" },
        pull_request: {
          base: { sha: "b" },
          head: { sha: "h" },
          user: { login: "pr-user" },
        },
      },
      config,
    );

    expect(event?.author.username).toBe("sender-user");
    expect(event?.author.email).toBe("sender@example.com");
  });

  it("produces an empty author when both sender and pull_request.user are absent", () => {
    const event = translateWebhookToReviewEvent(
      "gitea",
      "pull_request",
      {
        action: "opened",
        repository: { full_name: "owent/example" },
        pull_request: {
          base: { sha: "b" },
          head: { sha: "h" },
        },
      },
      config,
    );

    expect(event?.author.username).toBeUndefined();
    expect(event?.author.email).toBeUndefined();
  });

  it("includes rawEventName in the translated event", () => {
    const event = translateWebhookToReviewEvent(
      "gitea",
      "pull_request",
      {
        action: "opened",
        repository: { full_name: "owent/example" },
        pull_request: { base: { sha: "b" }, head: { sha: "h" } },
      },
      config,
    );

    expect(event?.rawEventName).toBe("pull_request");
  });

  it("uses repository mappings to select the target workspace", () => {
    const event = translateWebhookToReviewEvent(
      "gitea",
      "push",
      {
        before: "abc123",
        after: "def456",
        repository: { full_name: "ProjectX/Pipeline" },
      },
      {
        triggerName: "gitea-internal",
        workspaceId: "fallback-ws",
        repoMappings: [
          { match: "ProjectY/server", workspace: "projecty-server" },
          { match: "ProjectX/Pipeline", workspace: "projectx-pipeline" },
        ],
      },
    );

    expect(event?.workspaceId).toBe("projectx-pipeline");
  });
});
