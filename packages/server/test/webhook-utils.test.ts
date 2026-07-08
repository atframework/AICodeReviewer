import { describe, expect, it, vi } from "vitest";

import {
  computeWebhookSignature,
  translateWebhookToReviewEvent,
  verifyWebhookSignature,
} from "../src/webhook-translator.js";

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

  it("returns null for an unsupported event type", async () => {
    const event = await translateWebhookToReviewEvent(
      "gitea",
      "release",
      { repository: { full_name: "owent/example" } },
      config,
    );
    expect(event).toBeNull();
  });

  it("derives the author from sender first, then pull_request.user", async () => {
    const event = await translateWebhookToReviewEvent(
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

  it("propagates the provider into reason and provider fields for forgejo", async () => {
    const event = await translateWebhookToReviewEvent(
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

  it("translates GitHub pull_request review_requested into a pull request review event", async () => {
    const event = await translateWebhookToReviewEvent(
      "github",
      "pull_request",
      {
        action: "review_requested",
        repository: { full_name: "owent/example" },
        sender: { login: "maintainer" },
        pull_request: {
          title: "Add auth checks",
          html_url: "https://github.com/owent/example/pull/42",
          base: { sha: "base-sha" },
          head: { sha: "head-sha", ref: "feature/auth" },
        },
        requested_reviewer: { login: "aicr-bot" },
      },
      { triggerName: "github", workspaceId: "github-owent-example" },
    );

    expect(event).toMatchObject({
      provider: "github",
      targetKind: "pull_request",
      repoRef: "owent/example",
      baseSha: "base-sha",
      headSha: "head-sha",
      reason: "github:review_requested",
      rawEventName: "pull_request",
      branch: "feature/auth",
    });
  });

  it("translates Gitea pull_request_review_request review_requested into a pull request review event", async () => {
    const event = await translateWebhookToReviewEvent(
      "gitea",
      "pull_request_review_request",
      {
        action: "review_requested",
        repository: { full_name: "owent/example" },
        sender: { login: "maintainer" },
        pull_request: {
          title: "Add auth checks",
          html_url: "https://gitea.example.com/owent/example/pulls/42",
          base: { sha: "base-sha" },
          head: { sha: "head-sha", ref: "feature/auth" },
        },
        requested_reviewer: { login: "aicr-bot" },
      },
      config,
    );

    expect(event).toMatchObject({
      provider: "gitea",
      targetKind: "pull_request",
      repoRef: "owent/example",
      baseSha: "base-sha",
      headSha: "head-sha",
      reason: "gitea:review_requested",
      rawEventName: "pull_request_review_request",
      branch: "feature/auth",
    });
  });

  it("does not translate Gitea pull_request_review_request review_request_removed into a review event", async () => {
    const event = await translateWebhookToReviewEvent(
      "gitea",
      "pull_request_review_request",
      {
        action: "review_request_removed",
        repository: { full_name: "owent/example" },
        sender: { login: "maintainer" },
        pull_request: { base: { sha: "base-sha" }, head: { sha: "head-sha" } },
      },
      config,
    );

    expect(event).toBeNull();
  });

  it("translates push events with before/after shas", async () => {
    const event = await translateWebhookToReviewEvent(
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

  it("skips branch-deletion push events (after is all zeros)", async () => {
    const event = await translateWebhookToReviewEvent(
      "github",
      "push",
      {
        before: "2197257f23ded146aac94912aacd287e80f7f343",
        after: "0000000000000000000000000000000000000000",
        compare_url: "https://github.com/owent/example/compare/00000000^...0000000000000000000000000000000000000000",
        repository: { full_name: "owent/example" },
        pusher: { login: "pusher-user" },
        ref: "refs/heads/develop/some_branch",
      },
      config,
    );

    // A branch deletion has no reviewable commit range; returning null lets the
    // route skip it (202) instead of failing with an invalid `git diff` range.
    expect(event).toBeNull();
  });

  it("skips branch-creation push events (before is all zeros)", async () => {
    const event = await translateWebhookToReviewEvent(
      "gitea",
      "push",
      {
        before: "0000000000000000000000000000000000000000",
        after: "def4567890abcdef1234567890abcdef12345678",
        compare_url: "https://gitea.example.com/owent/example/compare/0000000...def4567",
        repository: { full_name: "owent/example" },
        pusher: { login: "pusher-user" },
        ref: "refs/heads/feature/new",
      },
      config,
    );

    expect(event).toBeNull();
  });

  it("uses sender over pull_request.user when both are present", async () => {
    const event = await translateWebhookToReviewEvent(
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

  it("produces an empty author when both sender and pull_request.user are absent", async () => {
    const event = await translateWebhookToReviewEvent(
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

  it("includes rawEventName in the translated event", async () => {
    const event = await translateWebhookToReviewEvent(
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

  it("extracts branch from push ref for GitHub-style push events", async () => {
    const event = await translateWebhookToReviewEvent(
      "github",
      "push",
      {
        ref: "refs/heads/sample_solution",
        before: "abc123",
        after: "def456",
        repository: { full_name: "atframework/atsf4g-co" },
        pusher: { name: "yousongyang", email: "yousongyang@example.com" },
        commits: [],
      },
      { triggerName: "github-atframework", workspaceId: "github-atsf4g-co" },
    );

    expect(event?.branch).toBe("sample_solution");
  });

  it("falls back pusher.name to author.username for GitHub push events", async () => {
    const event = await translateWebhookToReviewEvent(
      "github",
      "push",
      {
        ref: "refs/heads/main",
        before: "abc123",
        after: "def456",
        repository: { full_name: "atframework/atsf4g-co" },
        pusher: { name: "yousongyang", email: "yousongyang@example.com" },
        commits: [],
      },
      { triggerName: "github-atframework", workspaceId: "github-atsf4g-co" },
    );

    expect(event?.author.username).toBe("yousongyang");
    expect(event?.author.email).toBe("yousongyang@example.com");
  });

  it("uses repository mappings to select the target workspace", async () => {
    const event = await translateWebhookToReviewEvent(
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

  it("returns null for installation events (not a review)", async () => {
    const evicted: (number | undefined)[] = [];
    const event = await translateWebhookToReviewEvent(
      "github",
      "installation",
      {
        action: "created",
        installation: { id: 12345678 },
        repository: { full_name: "owent/example" },
      },
      {
        triggerName: "github",
        workspaceId: "github-ws",
        evictTokenCache: (installationId?: number) => { evicted.push(installationId); },
      },
    );

    expect(event).toBeNull();
    expect(evicted).toEqual([12345678]);
  });

  it("returns null for installation_repositories events and evicts cache", async () => {
    const evicted: (number | undefined)[] = [];
    const event = await translateWebhookToReviewEvent(
      "github",
      "installation_repositories",
      {
        action: "added",
        installation: { id: 12345678 },
        repositories_added: [{ full_name: "owent/example" }],
      },
      {
        triggerName: "github",
        workspaceId: "github-ws",
        evictTokenCache: (installationId?: number) => { evicted.push(installationId); },
      },
    );

    expect(event).toBeNull();
    expect(evicted).toEqual([12345678]);
  });

  it("resolves an App installation token from payload for issue_comment PR enrichment", async () => {
    const resolvedInstallationIds: number[] = [];
    const config = {
      triggerName: "github-app",
      workspaceId: "github-ws",
      appTokenResolver: async (installationId: number) => {
        resolvedInstallationIds.push(installationId);
        return "ghs_APPRESOLVEDTOKEN";
      },
    };

    const fetchCalls: { url: string; auth: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const headers = init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers as Record<string, string>);
      fetchCalls.push({ url: urlStr, auth: headers.get("Authorization") ?? "" });
      return new Response(
        JSON.stringify({
          head: { sha: "head-from-api", ref: "feature/branch" },
          base: { sha: "base-from-api" },
          title: "PR from API",
          html_url: "https://github.com/owent/example/pull/42",
          user: { login: "pr-author" },
        }),
        { status: 200 },
      );
    });

    try {
      const event = await translateWebhookToReviewEvent(
        "github",
        "issue_comment",
        {
          action: "created",
          repository: { full_name: "owent/example" },
          sender: { login: "commenter" },
          installation: { id: 9876543 },
          issue: {
            number: 42,
            title: "Original title",
            pull_request: {
              url: "https://api.github.com/repos/owent/example/pulls/42",
              html_url: "https://github.com/owent/example/pull/42",
            },
          },
          comment: { body: "/aicr review", user: { login: "commenter" } },
        },
        config,
      );

      expect(resolvedInstallationIds).toEqual([9876543]);
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]?.auth).toBe("Bearer ghs_APPRESOLVEDTOKEN");
      expect(event).toMatchObject({
        headSha: "head-from-api",
        baseSha: "base-from-api",
        title: "PR from API",
        author: { username: "pr-author" },
        branch: "feature/branch",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to webhook payload when appTokenResolver fails", async () => {
    const config = {
      triggerName: "github-app",
      workspaceId: "github-ws",
      appTokenResolver: async () => {
        throw new Error("App token resolution failed");
      },
    };

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));

    try {
      const event = await translateWebhookToReviewEvent(
        "github",
        "issue_comment",
        {
          action: "created",
          repository: { full_name: "owent/example" },
          sender: { login: "commenter" },
          installation: { id: 9876543 },
          issue: {
            number: 42,
            title: "Fallback title",
            pull_request: {
              url: "https://api.github.com/repos/owent/example/pulls/42",
              html_url: "https://github.com/owent/example/pull/42",
            },
          },
          comment: { body: "/aicr review", user: { login: "commenter" } },
        },
        config,
      );

      expect(event).toMatchObject({
        title: "Fallback title",
        url: "https://github.com/owent/example/pull/42",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
