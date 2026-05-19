import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import { translateWebhookToReviewEvent, type GiteaWebhookConfig } from "../src/gitea-webhook.js";

const baseConfig: GiteaWebhookConfig = {
  triggerName: "github-owent",
  workspaceId: "github-libatapp",
  repoRef: "owent/libatapp",
};

describe("translateWebhookToReviewEvent comment commands", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            head: { sha: "head-sha-from-api", ref: "feature-branch" },
            base: { sha: "base-sha-from-api", ref: "main" },
            title: "PR Title from API",
            html_url: "https://github.com/owent/libatapp/pulls/50",
            user: { login: "yousongyang", email: "ysy@example.com" },
            labels: [{ name: "bug" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null for issue_comment without review command", async () => {
    const result = await translateWebhookToReviewEvent("github", "issue_comment", {
      action: "created",
      repository: { full_name: "owent/libatapp" },
      issue: {
        number: 50,
        pull_request: { url: "https://api.github.com/repos/owent/libatapp/pulls/50" },
      },
      comment: { body: "LGTM, nice work!" },
      sender: { login: "owent" },
    }, baseConfig);

    expect(result).toBeNull();
  });

  it("returns null for issue_comment on regular issue (not PR)", async () => {
    const result = await translateWebhookToReviewEvent("github", "issue_comment", {
      action: "created",
      repository: { full_name: "owent/libatapp" },
      issue: {
        number: 50,
        title: "Bug report",
      },
      comment: { body: "/aicr review" },
      sender: { login: "owent" },
    }, baseConfig);

    expect(result).toBeNull();
  });

  it("translates issue_comment with /aicr review on PR (with token)", async () => {
    const config = { ...baseConfig, token: "ghp_test_token" };
    const result = await translateWebhookToReviewEvent("github", "issue_comment", {
      action: "created",
      repository: { full_name: "owent/libatapp" },
      issue: {
        number: 50,
        title: "Original Title",
        pull_request: { url: "https://api.github.com/repos/owent/libatapp/pulls/50", html_url: "https://github.com/owent/libatapp/pull/50" },
        labels: [{ name: "enhancement" }],
      },
      comment: { body: "Please /aicr review this PR" },
      sender: { login: "owent", email: "owent@example.com" },
    }, config);

    expect(result).not.toBeNull();
    expect(result?.triggerName).toBe("github-owent");
    expect(result?.provider).toBe("github");
    expect(result?.targetKind).toBe("pull_request");
    expect(result?.repoRef).toBe("owent/libatapp");
    expect(result?.headSha).toBe("head-sha-from-api");
    expect(result?.baseSha).toBe("base-sha-from-api");
    expect(result?.title).toBe("PR Title from API");
    expect(result?.url).toBe("https://github.com/owent/libatapp/pulls/50");
    expect(result?.reason).toBe("github:comment_review");
    expect(result?.branch).toBe("feature-branch");
    expect(result?.labels).toEqual(["enhancement"]);
    expect(result?.author).toMatchObject({ username: "yousongyang", email: "ysy@example.com" });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owent/libatapp/pulls/50",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_test_token",
        }),
      }),
    );
  });

  it("translates issue_comment with /review shorthand on PR (with token)", async () => {
    const config = { ...baseConfig, token: "ghp_test_token" };
    const result = await translateWebhookToReviewEvent("github", "issue_comment", {
      action: "created",
      repository: { full_name: "owent/libatapp" },
      issue: {
        number: 50,
        pull_request: { url: "https://api.github.com/repos/owent/libatapp/pulls/50" },
      },
      comment: { body: "/review" },
      sender: { login: "owent" },
    }, config);

    expect(result).not.toBeNull();
    expect(result?.reason).toBe("github:comment_review");
  });

  it("falls back to payload info when token is absent for issue_comment", async () => {
    const result = await translateWebhookToReviewEvent("github", "issue_comment", {
      action: "created",
      repository: { full_name: "owent/libatapp" },
      issue: {
        number: 50,
        title: "Fallback Title",
        pull_request: { url: "https://api.github.com/repos/owent/libatapp/pulls/50", html_url: "https://github.com/owent/libatapp/pull/50" },
      },
      comment: { body: "/aicr review" },
      sender: { login: "owent" },
    }, baseConfig);

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Fallback Title");
    expect(result?.url).toBe("https://github.com/owent/libatapp/pull/50");
    expect(result?.headSha).toBeUndefined();
    expect(result?.baseSha).toBeUndefined();

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the PR API URL as a fallback target identity when html_url is absent", async () => {
    const result = await translateWebhookToReviewEvent("github", "issue_comment", {
      action: "created",
      repository: { full_name: "owent/libatapp" },
      issue: {
        number: 50,
        title: "Fallback Title",
        pull_request: { url: "https://api.github.com/repos/owent/libatapp/pulls/50" },
      },
      comment: { body: "/aicr review" },
      sender: { login: "owent" },
    }, baseConfig);

    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://api.github.com/repos/owent/libatapp/pulls/50");
  });

  it("falls back to payload info when PR detail fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("Not Found", { status: 404 });
      }),
    );

    const config = { ...baseConfig, token: "ghp_test_token" };
    const result = await translateWebhookToReviewEvent("github", "issue_comment", {
      action: "created",
      repository: { full_name: "owent/libatapp" },
      issue: {
        number: 50,
        title: "Fallback Title",
        pull_request: { url: "https://api.github.com/repos/owent/libatapp/pulls/50" },
      },
      comment: { body: "/aicr review" },
      sender: { login: "owent" },
    }, config);

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Fallback Title");
    expect(result?.headSha).toBeUndefined();
  });

  it("translates GitLab note on MR with /aicr review", async () => {
    const result = await translateWebhookToReviewEvent("gitlab", "note", {
      object_kind: "note",
      project: { path_with_namespace: "owent/libatapp" },
      user: { username: "owent", email: "owent@example.com" },
      merge_request: {
        iid: 50,
        source_branch: "feature",
        target_branch: "main",
        title: "MR Title",
        diff_refs: {
          base_sha: "base-sha-gitlab",
          head_sha: "head-sha-gitlab",
        },
        labels: [{ title: "bug" }],
      },
      object_attributes: {
        note: "/aicr review this please",
        noteable_type: "MergeRequest",
      },
    }, baseConfig);

    expect(result).not.toBeNull();
    expect(result?.provider).toBe("gitlab");
    expect(result?.targetKind).toBe("pull_request");
    expect(result?.repoRef).toBe("owent/libatapp");
    expect(result?.headSha).toBe("head-sha-gitlab");
    expect(result?.baseSha).toBe("base-sha-gitlab");
    expect(result?.title).toBe("MR Title");
    expect(result?.reason).toBe("gitlab:comment_review");
    expect(result?.branch).toBe("feature");
    expect(result?.labels).toEqual(["bug"]);
  });

  it("returns null for GitLab note on non-MR", async () => {
    const result = await translateWebhookToReviewEvent("gitlab", "note", {
      object_kind: "note",
      project: { path_with_namespace: "owent/libatapp" },
      user: { username: "owent" },
      object_attributes: {
        note: "/aicr review",
        noteable_type: "Issue",
      },
    }, baseConfig);

    expect(result).toBeNull();
  });

  it("returns null for GitLab note without review command", async () => {
    const result = await translateWebhookToReviewEvent("gitlab", "note", {
      object_kind: "note",
      project: { path_with_namespace: "owent/libatapp" },
      user: { username: "owent" },
      merge_request: {
        iid: 50,
        diff_refs: { base_sha: "base", head_sha: "head" },
      },
      object_attributes: {
        note: "Looks good to me",
        noteable_type: "MergeRequest",
      },
    }, baseConfig);

    expect(result).toBeNull();
  });
});
