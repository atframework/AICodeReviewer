import { describe, expect, it } from "vitest";

import {
  computeWebhookSignature,
  translateWebhookToReviewEvent,
  verifyWebhookSignature,
} from "../src/gitea-webhook.js";

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
});
