import { describe, expect, it } from "vitest";

import { createReviewEvent, reviewEventSchema } from "../src/review-event.js";

const baseEvent = {
  triggerName: "gitea-internal",
  provider: "gitea" as const,
  workspaceId: "gitea-internal-owent-example",
  targetKind: "pull_request" as const,
  repoRef: "owent/example",
  baseSha: "base-sha",
  headSha: "head-sha",
  author: { username: "owent", email: "owent@example.com" },
  url: "https://gitea.internal.corp/owent/example/pulls/42",
  reason: "gitea:opened",
  rawEventName: "pull_request",
};

describe("createReviewEvent", () => {
  it("returns the parsed event for a fully populated payload", () => {
    const event = createReviewEvent(baseEvent);

    expect(event.provider).toBe("gitea");
    expect(event.author.username).toBe("owent");
  });

  it("supports the forgejo provider alias", () => {
    const event = createReviewEvent({ ...baseEvent, provider: "forgejo" });
    expect(event.provider).toBe("forgejo");
  });

  it("rejects an unknown provider", () => {
    const result = reviewEventSchema.safeParse({ ...baseEvent, provider: "bitbucket" });
    expect(result.success).toBe(false);
  });

  it("rejects empty triggerName", () => {
    const result = reviewEventSchema.safeParse({ ...baseEvent, triggerName: "" });
    expect(result.success).toBe(false);
  });

  it("rejects malformed url", () => {
    const result = reviewEventSchema.safeParse({ ...baseEvent, url: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (strict schema)", () => {
    const result = reviewEventSchema.safeParse({ ...baseEvent, extra: "nope" });
    expect(result.success).toBe(false);
  });

  it("rejects changedFiles entries that are empty strings", () => {
    const result = reviewEventSchema.safeParse({
      ...baseEvent,
      changedFiles: ["src/index.ts", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unexpected fields inside author because the nested schema is strict", () => {
    const result = reviewEventSchema.safeParse({
      ...baseEvent,
      author: { username: "owent", role: "admin" },
    });
    expect(result.success).toBe(false);
  });

  it("allows omitting optional sha fields for manual or scheduled triggers", () => {
    const event = createReviewEvent({
      triggerName: "cron-nightly",
      provider: "scheduled",
      workspaceId: "ws",
      targetKind: "scheduled",
      repoRef: "owent/example",
      author: {},
      reason: "scheduled:cron",
    });

    expect(event.baseSha).toBeUndefined();
    expect(event.headSha).toBeUndefined();
  });
});
