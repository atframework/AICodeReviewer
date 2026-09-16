import { describe, expect, it } from "vitest";
import { createReviewEvent } from "@aicr/core";
import { translateWebhookToReviewEvent } from "../src/webhook-translator.js";
import { translateIssueCommentReviewCommand } from "../src/webhook-common.js";

const config = { triggerName: "test", workspaceId: "ws" };
const refs = { sourceRepoRef: "fork/team/repo", targetRepoRef: "org/team/repo", branch: "feature", targetBranch: "main" };

describe("review repository identity", () => {
  it.each(["github", "gitea", "forgejo"] as const)("retains fork identity through %s PR translation and event serialization", async provider => {
    const event = await translateWebhookToReviewEvent(provider, "pull_request", {
      repository: { full_name: "org/team/repo" },
      sender: { login: "maintainer" },
      pull_request: { user: { login: "contributor" }, base: { sha: "base", ref: "main", repo: { full_name: "org/team/repo" } },
        head: { sha: "head", ref: "feature", repo: { full_name: "fork/team/repo" } } },
    }, config);
    expect(event).toMatchObject(refs);
    expect(event?.author.username).toBe("contributor");
    expect(createReviewEvent(JSON.parse(JSON.stringify(event)))).toMatchObject(refs);
  });
  it.each(["github", "gitea", "forgejo"] as const)("retains %s fork identity after comment enrichment", async provider => {
    const event = await translateIssueCommentReviewCommand(provider, "issue_comment", {
      repository: { full_name: "org/team/repo" }, comment: { body: "/aicr review" },
      issue: { number: 1, pull_request: { url: "https://git.example/api/pulls/1" } },
    }, { ...config, token: "token" }, async () => ({
      head: { sha: "head", ref: "feature", repo: { full_name: "fork/team/repo" } },
      base: { sha: "base", ref: "main", repo: { full_name: "org/team/repo" } },
    }));
    expect(event).toMatchObject(refs);
  });
  it.each(["merge_request", "note"])("retains GitLab source and target on %s events", async kind => {
    const mr = { iid: 1, source_branch: "feature", target_branch: "main", diff_refs: { base_sha: "base", head_sha: "head" },
      source: { path_with_namespace: "fork/team/repo" }, target: { path_with_namespace: "org/team/repo" } };
    const event = await translateWebhookToReviewEvent("gitlab", kind, { project: { path_with_namespace: "org/team/repo" },
      ...(kind === "note" ? { object_kind: "note", merge_request: mr, object_attributes: { note: "/aicr review" } }
        : { object_attributes: mr }) }, config);
    expect(event).toMatchObject(refs);
  });
  it("uses equal GitLab project IDs as same-repository evidence, and leaves missing fork evidence unknown", async () => {
    for (const sourceId of [1, 2]) {
      const event = await translateWebhookToReviewEvent("gitlab", "merge_request", {
        project: { path_with_namespace: "org/team/repo" }, object_attributes: { source_project_id: sourceId, target_project_id: 1 },
      }, config);
      expect(event?.sourceRepoRef).toBe(sourceId === 1 ? "org/team/repo" : undefined);
      expect(event?.targetRepoRef).toBe("org/team/repo");
    }
  });
  it("accepts a deleted GitHub fork without inventing its repository", async () => {
    const event = await translateWebhookToReviewEvent("github", "pull_request", { repository: { full_name: "org/repo" },
      pull_request: { base: { sha: "base" }, head: { sha: "head", repo: null } } }, config);
    expect(event?.sourceRepoRef).toBeUndefined();
    expect(event?.targetRepoRef).toBe("org/repo");
  });
});
