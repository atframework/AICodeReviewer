import { createHmac } from "node:crypto";

import { createMemoryAutoCommitStore } from "@aicr/core";
import { closeStoreDb, createStoreDb, getRecentWebhookEvents } from "@aicr/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewDeferralManager } from "../src/deferral-manager.js";
import { AutoCommitRuntime, createServerApp, type ServerAppOptions } from "../src/index.js";
import { createReviewDeduplicator } from "../src/review-deduplicator.js";

const secret = "branch-filter-test";
const providers = ["gitea", "forgejo", "github", "gitlab"] as const;
type Provider = typeof providers[number];
const base = "1".repeat(40);
const head = "2".repeat(40);

function request(provider: Provider, event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "gitlab") {
    headers["x-gitlab-event"] = event;
    headers["x-gitlab-token"] = secret;
  } else if (provider === "github") {
    headers["x-github-event"] = event;
    headers["x-hub-signature-256"] = `sha256=${signature}`;
  } else {
    headers["x-gitea-event"] = event;
    headers["x-gitea-signature"] = signature;
  }
  return { method: "POST", headers, body };
}

function config(provider: Provider): ServerAppOptions {
  return {
    [provider]: {
      triggerName: `${provider}-trigger`,
      workspaceId: "fallback",
      webhookSecret: secret,
      repoMappings: [
        { match: "owner/repo", workspace: "restricted" },
        { match: "owner/other", workspace: "unrestricted" },
      ],
      token: "test-token",
    },
  };
}

function push(provider: Provider, branch: string, repo = "owner/repo") {
  return {
    ref: `refs/heads/${branch}`, before: base, after: head,
    ...(provider === "gitlab"
      ? { project: { path_with_namespace: repo } }
      : { repository: { full_name: repo } }),
  };
}

function pr(provider: Provider, targetBranch: unknown, repo = "owner/repo") {
  return provider === "gitlab" ? {
    project: { path_with_namespace: repo },
    object_attributes: {
      iid: 1, action: "open", source_branch: "feature/x", target_branch: targetBranch,
      diff_refs: { base_sha: base, head_sha: head },
    },
  } : {
    repository: { full_name: repo }, action: "opened",
    pull_request: {
      base: { sha: base, ref: targetBranch }, head: { sha: head, ref: "feature/x" },
      html_url: `https://${provider}.example.com/${repo}/pulls/1`,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(providers)("%s branch filtering", (provider) => {
  const pushEvent = provider === "gitlab" ? "Push Hook" : "push";
  const prEvent = provider === "gitlab" ? "Merge Request Hook" : "pull_request";
  const path = `/webhooks/${provider}`;

  it("filters before persistence and selects policy by the mapped repository", async () => {
    const store = createMemoryAutoCommitStore();
    const accept = vi.spyOn(store, "acceptReceipt");
    const runtime = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const lookup = vi.fn((workspace: string) => workspace === "restricted" ? ["release/1.x"] : []);
    const app = createServerApp({ ...config(provider), autoCommit: runtime, getAutoCommitBranches: lookup });

    for (const branch of ["main", "Release/1.x", "release/2.x"]) {
      const rejected = await app.request(path, request(provider, pushEvent, push(provider, branch)));
      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toMatchObject({ accepted: false, reason: "branch_not_watched", branch });
    }
    expect(accept).not.toHaveBeenCalled();
    expect(await store.readNextWake()).toBeUndefined();

    for (const [branch, repo, workspace] of [
      ["release/1.x", "owner/repo", "restricted"],
      ["main", "owner/other", "unrestricted"],
    ] as const) {
      const accepted = await app.request(path, request(provider, pushEvent, push(provider, branch, repo)));
      expect(accepted.status).toBe(202);
      const body = await accepted.json();
      expect(body).toMatchObject({ accepted: true, processing: { mode: "queued", status: "queued" } });
      const receipt = await store.getReceipt(body.processing.receiptId);
      expect(receipt?.receipt).toMatchObject({ workspaceId: workspace, scopeRef: `refs/heads/${branch}` });
    }
    expect(lookup).toHaveBeenCalledWith("restricted");
    expect(lookup).toHaveBeenCalledWith("unrestricted");
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("matches PR targets independently of the source branch and commit policy", async () => {
    const lookup = vi.fn((workspace: string) => workspace === "restricted" ? ["release/1.x"] : []);
    const commitLookup = vi.fn(() => ["unrelated"]);
    const app = createServerApp({
      ...config(provider), getPullRequestTargetBranches: lookup, getAutoCommitBranches: commitLookup,
    });
    for (const branch of ["feature/x", "Release/1.x", "release/2.x"]) {
      const rejected = await app.request(path, request(provider, prEvent, pr(provider, branch)));
      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toMatchObject({ accepted: false, reason: "target_branch_not_watched" });
    }
    for (const [branch, repo] of [["release/1.x", "owner/repo"], ["main", "owner/other"]]) {
      const accepted = await app.request(path, request(provider, prEvent, pr(provider, branch, repo)));
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toMatchObject({
        accepted: true, reviewEvent: { targetBranch: branch, branch: "feature/x" },
      });
    }
    expect(commitLookup).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledWith("unrestricted");
  });

  it.each(["before", "after"] as const)("does not queue a branch create/delete with a zero %s SHA", async (field) => {
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const accept = vi.spyOn(runtime, "accept");
    const app = createServerApp({ ...config(provider), autoCommit: runtime, getAutoCommitBranches: () => ["main"] });
    const response = await app.request(path, request(provider, pushEvent, {
      ...push(provider, "main"), [field]: "0".repeat(40),
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "unsupported_event" });
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([42, ["main"], { ref: "main" }, ""])("rejects malformed PR target ref %j", async (ref) => {
    const lookup = vi.fn(() => ["main"]);
    const app = createServerApp({ ...config(provider), getPullRequestTargetBranches: lookup });
    const response = await app.request(path, request(provider, prEvent, pr(provider, ref)));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "invalid_payload" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("retains the documented fail-open behavior when the target ref is absent", async () => {
    const app = createServerApp({ ...config(provider), getPullRequestTargetBranches: () => ["main"] });
    const response = await app.request(path, request(provider, prEvent, pr(provider, undefined)));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, reviewEvent: { targetKind: "pull_request" } });
  });

  it("returns a retryable receive error when a watched push cannot be persisted", async () => {
    const app = createServerApp({
      ...config(provider), getAutoCommitBranches: () => ["main"],
      autoCommit: { accept: async () => { throw new Error("store unavailable"); } },
    });
    const response = await app.request(path, request(provider, pushEvent, push(provider, "main")));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "auto_commit_receive_failed" });
  });
});

describe("GitLab push aliases", () => {
  it.each(["Push Hook", "git_push"])("queues and deduplicates %s deliveries", async (eventName) => {
    const store = createMemoryAutoCommitStore();
    const runtime = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const app = createServerApp({ ...config("gitlab"), autoCommit: runtime, getAutoCommitBranches: () => ["main"] });
    const payload = push("gitlab", "main");
    const first = await app.request("/webhooks/gitlab", request("gitlab", eventName, payload));
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ accepted: true, processing: { mode: "queued", status: "queued" } });
    const repeated = await app.request("/webhooks/gitlab", request("gitlab", eventName, payload));
    expect(await repeated.json()).toMatchObject({ processing: { status: "duplicate", receiptId: firstBody.processing.receiptId } });
    const rejected = await app.request("/webhooks/gitlab", request("gitlab", eventName, push("gitlab", "dev")));
    expect(await rejected.json()).toMatchObject({ accepted: false, reason: "branch_not_watched" });
  });
});

describe("PR comment commands and ignored-event side effects", () => {
  it("uses a GitHub App installation token before filtering a PR comment", async () => {
    const resolver = vi.fn(async () => "installation-token");
    const fetchMock = vi.fn(async () => Response.json({ base: { ref: "dev", sha: base }, head: { sha: head } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createServerApp({
      github: { triggerName: "github-app", workspaceId: "repo", webhookSecret: secret, appTokenResolver: resolver },
      getPullRequestTargetBranches: () => ["main"],
    });
    const response = await app.request("/webhooks/github", request("github", "issue_comment", {
      installation: { id: 42 }, repository: { full_name: "owner/repo" },
      issue: { number: 1, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" } },
      comment: { body: "/review" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "target_branch_not_watched" });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(42);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer installation-token" }),
    }));
  });

  it.each(["gitea", "forgejo", "github"] as const)("does not apply either branch allowlist to %s issues", async (provider) => {
    const lookup = vi.fn(() => ["main"]);
    const app = createServerApp({ ...config(provider), getAutoCommitBranches: lookup, getPullRequestTargetBranches: lookup });
    const response = await app.request(`/webhooks/${provider}`, request(provider, "issues", {
      repository: { full_name: "owner/repo" }, action: "opened", issue: { number: 1, title: "Bug report" },
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, reviewEvent: { targetKind: "issue" } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["gitea", "forgejo", "github"] as const)("filters %s commands after authenticated PR-detail enrichment", async (provider) => {
    const fetchMock = vi.fn(async () => Response.json({ base: { sha: base, ref: "dev" }, head: { sha: head, ref: "feature/x" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createServerApp({ ...config(provider), getPullRequestTargetBranches: () => ["main"] });
    const payload = {
      repository: { full_name: "owner/repo" },
      issue: { number: 1, pull_request: { url: `https://${provider}.example.com/api/pulls/1` } },
      comment: { body: "/aicr review" },
    };
    const response = await app.request(`/webhooks/${provider}`, request(provider, "issue_comment", payload));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "target_branch_not_watched", branch: "dev" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      payload.issue.pull_request.url,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `${provider === "github" ? "Bearer" : "token"} test-token` }) }),
    );

    fetchMock.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    const retry = await app.request(`/webhooks/${provider}`, request(provider, "issue_comment", payload));
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: true, reviewEvent: { reason: `${provider}:comment_review` } });
  });

  it.each(["note", "Note Hook"])("filters GitLab %s commands on the embedded MR target", async (eventName) => {
    const app = createServerApp({ ...config("gitlab"), getPullRequestTargetBranches: () => ["main"] });
    const response = await app.request("/webhooks/gitlab", request("gitlab", eventName, {
      object_kind: "note", project: { path_with_namespace: "owner/repo" },
      object_attributes: { note: "/review", noteable_type: "MergeRequest" },
      merge_request: { iid: 1, source_branch: "main", target_branch: "dev" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "target_branch_not_watched", branch: "dev" });
  });

  it("records the ignored target without dedup, deferral, or analysis", async () => {
    const store = createStoreDb(":memory:");
    const deduplicator = createReviewDeduplicator();
    const schedule = vi.spyOn(deduplicator, "trySchedule");
    const deferrals = new ReviewDeferralManager({ store });
    const defer = vi.spyOn(deferrals, "defer");
    const pipeline = vi.fn(() => { throw new Error("must not analyze ignored PR"); });
    try {
      const app = createServerApp({
        ...config("github"), store, asyncTriggers: true, deduplicator, deferralManager: deferrals,
        getPullRequestTargetBranches: () => ["main"],
        getExecutionSchedule: pipeline,
      });
      const response = await app.request("/webhooks/github", request("github", "pull_request", pr("github", "dev")));
      expect(response.status).toBe(200);
      expect(schedule).not.toHaveBeenCalled();
      expect(defer).not.toHaveBeenCalled();
      expect(pipeline).not.toHaveBeenCalled();
      expect(await getRecentWebhookEvents(store, 10)).toMatchObject([{
        workspaceId: "restricted", decision: "ignored", reason: "target_branch_not_watched", detail: { branch: "dev" },
      }]);
    } finally {
      deferrals.stop();
      await closeStoreDb(store);
    }
  });
});
