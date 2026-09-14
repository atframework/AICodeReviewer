import { createHmac } from "node:crypto";

import { createMemoryAutoCommitStore, parseConfigDocumentText, projectEventResolution,
  type ReceiptQueryResult, type WorkspaceResolution } from "@aicr/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveGiteaLikeWebhookConfigs, resolveGenericWebhookConfigs } from "../src/bootstrap.js";
import { createServerApp } from "../src/index.js";
import { createWorkspaceRuntime, type WorkspaceRuntime } from "../src/workspace-runtime.js";
import { AutoCommitRuntime } from "../src/auto-commit-runtime.js";

const webhookSecret = "top-secret";

beforeEach(() => {
  vi.stubEnv("AICR_HOOK_SECRET", webhookSecret);
  vi.stubEnv("AICR_HOOK_SECRET_2", "second-secret");
  vi.stubEnv("AICR_GITLAB_TOKEN_TARGET", "target-token");
  vi.stubEnv("AICR_GITLAB_TOKEN_OTHER", "other-token");
});
afterEach(() => vi.unstubAllEnvs());

function sign(payload: string, secret: string = webhookSecret): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
function pushPayload(fullName: string, ref = "refs/heads/main"): string {
  return JSON.stringify({
    ref,
    before: "1111111111111111111111111111111111111111",
    after: "2222222222222222222222222222222222222222",
    repository: { full_name: fullName },
    commits: [{ id: "2222222222222222222222222222222222222222", modified: ["src/app.ts"] }],
  });
}

function runtimeAndConfig(yaml: string) {
  const config = parseConfigDocumentText(yaml).config;
  const runtime = createWorkspaceRuntime(config, "/tmp/aicr-attribution-test");
  return { config, runtime };
}

function githubPush(app: Hono, repo: string) {
  const payload = pushPayload(repo);
  return app.request("/webhooks/github", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${sign(payload)}` },
    body: payload,
  });
}


function matchBinding(receipt: ReceiptQueryResult | undefined) {
  const resolution = receipt?.receipt.resolution;
  if (resolution?.kind !== "match") throw new Error("expected a match resolution on the durable receipt");
  return { resolution, binding: resolution.binding };
}

function layoutForReceipt(runtime: WorkspaceRuntime, triggerName: string, receipt: ReceiptQueryResult | undefined, repoRef: string) {
  const resolution = receipt?.receipt.resolution;
  if (resolution?.kind !== "match" && resolution?.kind !== "legacy_binding") {
    throw new Error("expected a bound resolution on the durable receipt");
  }
  return runtime.layoutForEvent({
    triggerName,
    workspaceId: receipt!.receipt.workspaceId,
    repoRef,
    resolution: projectEventResolution(resolution as WorkspaceResolution & { kind: "match" }),
  });
}

describe("one rule, two repositories (E04a)", () => {
  it("binds each repo to a distinct instance and on-disk root", async () => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: github-main, kind: github, webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    services:
      match:
        - triggers: [github-main]
          source:
            repo_ref: { glob: "acme/*" }
      work_path: '{{segment source.namespace}}/{{segment source.repository}}'
`);
    const store = createMemoryAutoCommitStore();
    const autoCommit = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const app = createServerApp({ github: resolveGenericWebhookConfigs(config, "github", undefined, undefined, runtime), autoCommit });

    const receipts: Record<string, ReceiptQueryResult | undefined> = {};
    for (const repo of ["acme/service-a", "acme/service-b"]) {
      const response = await githubPush(app, repo);
      expect(response.status).toBe(202);
      const body = (await response.json()) as { accepted: boolean; processing: { receiptId: string } };
      expect(body.accepted).toBe(true);
      receipts[repo] = await store.getReceipt(body.processing.receiptId);
      expect(receipts[repo]?.receipt.workspaceId).toBe("services");
      expect(receipts[repo]?.receipt.triggerName).toBe("github-main");
    }

    const a = matchBinding(receipts["acme/service-a"]);
    const b = matchBinding(receipts["acme/service-b"]);
    expect(a.binding.instanceId).not.toBe(b.binding.instanceId);
    expect(a.binding.workPath).toBe("acme/service-a");
    expect(b.binding.workPath).toBe("acme/service-b");

    const layoutA = layoutForReceipt(runtime, "github-main", receipts["acme/service-a"], "acme/service-a");
    const layoutB = layoutForReceipt(runtime, "github-main", receipts["acme/service-b"], "acme/service-b");
    expect(layoutA.instanceRoot).not.toBe(layoutB.instanceRoot);
    expect(layoutA.sourceRoot).not.toBe(layoutB.sourceRoot);
    expect(layoutA.instanceRoot).toContain(a.binding.instanceId);
    expect(layoutB.instanceRoot).toContain(b.binding.instanceId);
  });
});

describe("one rule, same repository name (E04b)", () => {
  it("never merges identity across owners or case spellings", async () => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: github-main, kind: github, webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    services:
      match:
        - triggers: [github-main]
          source:
            repo_ref: { glob: "*/service" }
      work_path: '{{segment source.namespace}}/{{segment source.repository}}'
`);
    const store = createMemoryAutoCommitStore();
    const autoCommit = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const app = createServerApp({ github: resolveGenericWebhookConfigs(config, "github", undefined, undefined, runtime), autoCommit });

    const receipts: Record<string, ReceiptQueryResult | undefined> = {};
    for (const repo of ["acme/service", "other/service", "ACME/service"]) {
      const response = await githubPush(app, repo);
      expect(response.status).toBe(202);
      const body = (await response.json()) as { accepted: boolean; processing: { receiptId: string } };
      expect(body.accepted).toBe(true);
      receipts[repo] = await store.getReceipt(body.processing.receiptId);
    }

    const bindings = Object.values(receipts).map((receipt) => matchBinding(receipt).binding);
    expect(new Set(bindings.map((binding) => binding.instanceId))).toHaveProperty("size", 3);
    expect(new Set(bindings.map((binding) => binding.workPath))).toHaveProperty("size", 3);

    // Source namespaces preserve the original case (design §5.1): splitting
    // on case only ever splits, never merges.
    expect(receipts["acme/service"]?.receipt.sourceNamespace).toBe("github:acme/service");
    expect(receipts["ACME/service"]?.receipt.sourceNamespace).toBe("github:ACME/service");
    expect(receipts["other/service"]?.receipt.sourceNamespace).toBe("github:other/service");
  });
});

describe("same repository on two hosts (E04c)", () => {
  it("pins each receipt to its own trigger identity", async () => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: github-main, kind: github, webhook_secret_env: AICR_HOOK_SECRET }
  - { name: gitea-main, kind: gitea, base_url: "https://gitea.acme.example", webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    app:
      match:
        - triggers: [github-main, gitea-main]
          source:
            repo_ref: { glob: "acme/app" }
      work_path: '{{segment source.namespace}}/{{segment source.repository}}'
`);
    const store = createMemoryAutoCommitStore();
    const autoCommit = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const app = createServerApp({
      github: resolveGenericWebhookConfigs(config, "github", undefined, undefined, runtime),
      gitea: resolveGiteaLikeWebhookConfigs(config, "gitea", undefined, undefined, runtime),
      autoCommit,
    });

    const githubResponse = await githubPush(app, "acme/app");
    expect(githubResponse.status).toBe(202);
    const githubBody = (await githubResponse.json()) as { accepted: boolean; processing: { receiptId: string } };
    expect(githubBody.accepted).toBe(true);

    const giteaPayload = pushPayload("acme/app");
    const giteaResponse = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-signature": sign(giteaPayload) },
      body: giteaPayload,
    });
    expect(giteaResponse.status).toBe(202);
    const giteaBody = (await giteaResponse.json()) as { accepted: boolean; processing: { receiptId: string } };
    expect(giteaBody.accepted).toBe(true);

    const githubReceipt = await store.getReceipt(githubBody.processing.receiptId);
    const giteaReceipt = await store.getReceipt(giteaBody.processing.receiptId);
    expect(githubReceipt?.receipt.triggerName).toBe("github-main");
    expect(giteaReceipt?.receipt.triggerName).toBe("gitea-main");

    const gh = matchBinding(githubReceipt);
    const gt = matchBinding(giteaReceipt);
    expect(gh.binding.instanceId).not.toBe(gt.binding.instanceId);
    // Same work path, but the instance id (definition + trigger + project
    // key) keeps the on-disk roots apart.
    expect(gh.binding.workPath).toBe("acme/app");
    expect(gt.binding.workPath).toBe("acme/app");
    expect(gh.resolution.variables).toMatchObject({ source: { project_key: "git:github.com:acme/app" } });
    expect(gt.resolution.variables).toMatchObject({ source: { project_key: "git:gitea.acme.example:acme/app" } });

    const layoutGh = layoutForReceipt(runtime, "github-main", githubReceipt, "acme/app");
    const layoutGt = layoutForReceipt(runtime, "gitea-main", giteaReceipt, "acme/app");
    expect(layoutGh.instanceRoot).not.toBe(layoutGt.instanceRoot);
  });
});

function gitlabForkMrPayload(): string {
  return JSON.stringify({
    object_kind: "merge_request",
    project: { id: 12, path_with_namespace: "group/sub/service", default_branch: "main" },
    object_attributes: {
      id: 100,
      iid: 9,
      action: "open",
      source_project_id: 44,
      target_project_id: 12,
      source_branch: "feature/fork-change",
      target_branch: "main",
      diff_refs: { base_sha: "1".repeat(40), head_sha: "2".repeat(40) },
      last_commit: { id: "2".repeat(40) },
      // Fork-side identity that must never steer routing.
      source: { id: 44, path_with_namespace: "fork-owner/service", default_branch: "main" },
      target: { id: 12, path_with_namespace: "group/sub/service", default_branch: "main" },
    },
    user: { username: "fork-dev" },
  });
}

describe("gitlab fork merge request (E05a)", () => {
  it("derives the workspace binding from the target project only", async () => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: gitlab-main, kind: gitlab, webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    services:
      match:
        - triggers: [gitlab-main]
          source:
            repo_ref: { glob: "group/sub/*" }
      work_path: '{{segment gitlab.project}}/{{segment (default gitlab.target_project_id "none")}}'
`);
    const app = createServerApp({ gitlab: resolveGenericWebhookConfigs(config, "gitlab", undefined, undefined, runtime) });

    const response = await app.request("/webhooks/gitlab", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": webhookSecret },
      body: gitlabForkMrPayload(),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: boolean;
      reviewEvent?: {
        triggerName: string;
        workspaceId: string;
        repoRef: string;
        targetKind: string;
        resolution?: {
          kind: string;
          binding?: { workPath: string; instanceId: string };
          variables?: Record<string, Record<string, unknown>>;
        };
      };
    };
    expect(body.accepted).toBe(true);
    expect(body.reviewEvent).toMatchObject({
      triggerName: "gitlab-main",
      workspaceId: "services",
      repoRef: "group/sub/service",
      targetKind: "pull_request",
    });

    // The fork's source project (fork-owner/service, id 44) matches no rule;
    // only the target path group/sub/service binds.
    const resolution = body.reviewEvent?.resolution;
    expect(resolution?.kind).toBe("match");
    expect(resolution?.binding?.workPath).toBe("service/12");
    expect(resolution?.variables?.source).toMatchObject({
      repo_ref: "group/sub/service",
      project_key: "git:gitlab.com:group/sub/service",
    });
    // Both project ids stay distinct: identity is the target's, the source
    // project id is evidence, never merged into the binding.
    expect(resolution?.variables?.gitlab).toMatchObject({
      namespace: "group/sub",
      project: "service",
      path_with_namespace: "group/sub/service",
      project_id: "12",
      source_project_id: "44",
      target_project_id: "12",
      merge_request_iid: "9",
      source_branch: "feature/fork-change",
      target_branch: "main",
    });
  });
});

describe("gitlab credential attribution (E05b)", () => {
  const YAML = `
triggers:
  - { name: gitlab-target, kind: gitlab, token_env: AICR_GITLAB_TOKEN_TARGET, webhook_secret_env: AICR_HOOK_SECRET }
  - { name: gitlab-other, kind: gitlab, token_env: AICR_GITLAB_TOKEN_OTHER, webhook_secret_env: AICR_HOOK_SECRET_2 }
workspaces:
  instances:
    services:
      source_repo: { trigger: gitlab-target, repo: group/sub/service }
`;

  it("authenticates the fork MR only against the target profile's secret", async () => {
    const { config, runtime } = runtimeAndConfig(YAML);
    const configs = resolveGenericWebhookConfigs(config, "gitlab", undefined, undefined, runtime);
    expect(configs).toHaveLength(2);
    // Each profile carries its own publisher credential.
    expect(configs.find((entry) => entry.triggerName === "gitlab-target")?.token).toBe("target-token");
    expect(configs.find((entry) => entry.triggerName === "gitlab-other")?.token).toBe("other-token");
    const app = createServerApp({ gitlab: configs });

    const response = await app.request("/webhooks/gitlab", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": webhookSecret },
      body: gitlabForkMrPayload(),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: boolean; reviewEvent?: { triggerName: string; workspaceId: string; repoRef: string } };
    expect(body.accepted).toBe(true);
    expect(body.reviewEvent).toMatchObject({ triggerName: "gitlab-target", workspaceId: "services", repoRef: "group/sub/service" });

    // The other profile's valid credential does not authenticate the target
    // profile's constrained repository.
    const other = await app.request("/webhooks/gitlab", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": "second-secret" },
      body: gitlabForkMrPayload(),
    });
    expect(other.status).toBe(401);

    const wrong = await app.request("/webhooks/gitlab", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": "wrong" },
      body: gitlabForkMrPayload(),
    });
    expect(wrong.status).toBe(401);
  });
});
