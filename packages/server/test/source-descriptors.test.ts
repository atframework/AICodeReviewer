import { describe, expect, it } from "vitest";

import { branchFromGitRef, describeWebhookSource } from "../src/source-descriptors.js";

describe("branchFromGitRef", () => {
  it("strips refs/heads and rejects tags/detached refs (V05)", () => {
    expect(branchFromGitRef("refs/heads/main")).toBe("main");
    expect(branchFromGitRef("refs/heads/feature/x")).toBe("feature/x");
    expect(branchFromGitRef("refs/tags/v1.2.0")).toBeNull();
    expect(branchFromGitRef("refs/pull/42/head")).toBeNull();
    expect(branchFromGitRef(undefined)).toBeNull();
  });
});

describe("describeWebhookSource — github/gitea/forgejo (V01, V04)", () => {
  it("push: branch and ref come from the verified payload", () => {
    const descriptor = describeWebhookSource("github", {
      ref: "refs/heads/main",
      repository: { full_name: "acme/service-a" },
    });
    expect(descriptor?.source).toEqual({
      vcs: "git",
      repo_ref: "acme/service-a",
      branch: "main",
      ref: "refs/heads/main",
    });
    expect(descriptor?.event).toEqual({ default_branch: null, provider_fields: { repository_id: null, pull_number: null, issue_number: null, installation_id: null } });
  });

  it("tag push: branch is null, ref stays real (V05)", () => {
    const descriptor = describeWebhookSource("github", {
      ref: "refs/tags/v2.0",
      repository: { full_name: "acme/service-a" },
    });
    expect(descriptor?.source.branch).toBeNull();
    expect(descriptor?.source.ref).toBe("refs/tags/v2.0");
  });

  it("pull_request: head/base branches from the PR object", () => {
    const descriptor = describeWebhookSource("gitea", {
      repository: { full_name: "owent/example" },
      pull_request: { head: { ref: "feature/x" }, base: { ref: "main" } },
    });
    expect(descriptor?.source.branch).toBe("feature/x");
    expect(descriptor?.event).toMatchObject({
      base_branch: "main",
      head_branch: "feature/x",
      head_repository: null,
      head_owner: null,
    });
  });

  it("fork pull_request: identity stays with the target repo, head repo is separate evidence (V02)", () => {
    const descriptor = describeWebhookSource("github", {
      repository: { full_name: "acme/service" },
      pull_request: {
        head: { ref: "feature/x", repo: { full_name: "contributor/service", owner: { login: "contributor" } } },
        base: { ref: "main", repo: { full_name: "acme/service" } },
      },
    });
    // Target repo decides identity — never the fork.
    expect(descriptor?.source.repo_ref).toBe("acme/service");
    expect(descriptor?.source.branch).toBe("feature/x");
    expect(descriptor?.event).toMatchObject({
      base_branch: "main",
      head_branch: "feature/x",
      head_repository: "contributor/service",
      head_owner: "contributor",
    });
  });

  it("same-repo pull_request: head repository fields stay null (V02)", () => {
    const descriptor = describeWebhookSource("github", {
      repository: { full_name: "acme/service" },
      pull_request: {
        head: { ref: "feature/x", repo: { full_name: "acme/service", owner: { login: "acme" } } },
        base: { ref: "main" },
      },
    });
    expect(descriptor?.event?.head_repository).toBeNull();
    expect(descriptor?.event?.head_owner).toBeNull();
  });

  it("issue events carry no branch (V01)", () => {
    const descriptor = describeWebhookSource("github", {
      action: "opened",
      repository: { full_name: "acme/service-a" },
      issue: { number: 7 },
    });
    expect(descriptor?.source).toEqual({ vcs: "git", repo_ref: "acme/service-a", branch: null, ref: null });
  });

  it("events without repository context return undefined", () => {
    expect(describeWebhookSource("github", { action: "created", installation: { id: 1 } })).toBeUndefined();
  });
});

describe("describeWebhookSource — gitlab (V03)", () => {
  it("keeps the full multi-level namespace", () => {
    const descriptor = describeWebhookSource("gitlab", {
      ref: "refs/heads/main",
      project: { path_with_namespace: "group/sub/project" },
    });
    expect(descriptor?.source.repo_ref).toBe("group/sub/project");
    expect(descriptor?.source.branch).toBe("main");
  });

  it("MR hooks expose source/target branches without truncation", () => {
    const descriptor = describeWebhookSource("gitlab", {
      object_kind: "merge_request",
      project: { path_with_namespace: "group/sub/project" },
      object_attributes: { source_branch: "feature/y", target_branch: "main" },
    });
    expect(descriptor?.source.branch).toBe("feature/y");
    expect(descriptor?.event).toMatchObject({ base_branch: "main", head_branch: "feature/y" });
  });

  it("note hooks read the embedded merge_request branches", () => {
    const descriptor = describeWebhookSource("gitlab", {
      object_kind: "note",
      project: { path_with_namespace: "group/sub/project" },
      object_attributes: { note: "/review", noteable_type: "MergeRequest" },
      merge_request: { source_branch: "feature/z", target_branch: "develop" },
    });
    expect(descriptor?.source.branch).toBe("feature/z");
    expect(descriptor?.event?.base_branch).toBe("develop");
  });

  it("falls back to repository.full_name when project is absent", () => {
    const descriptor = describeWebhookSource("gitlab", {
      repository: { full_name: "group/project" },
    });
    expect(descriptor?.source.repo_ref).toBe("group/project");
  });
});

describe("describeWebhookSource — non-git providers", () => {
  it("p4/svn/manual/scheduled stay undefined in this slice", () => {
    expect(describeWebhookSource("p4", { change: "123" })).toBeUndefined();
    expect(describeWebhookSource("svn", { revision: "42" })).toBeUndefined();
    expect(describeWebhookSource("manual", {})).toBeUndefined();
  });

  it("non-object payloads return undefined", () => {
    expect(describeWebhookSource("github", "not an object")).toBeUndefined();
    expect(describeWebhookSource("github", null)).toBeUndefined();
  });
});
