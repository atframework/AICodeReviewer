import { createHmac } from "node:crypto";

import { createMemoryAutoCommitStore, parseConfigDocumentText } from "@aicr/core";
import { describe, expect, it } from "vitest";

import { resolveGiteaLikeWebhookConfigs, resolveGenericWebhookConfigs } from "../src/bootstrap.js";
import { createServerApp } from "../src/index.js";
import { createWorkspaceRuntime } from "../src/workspace-runtime.js";
import { AutoCommitRuntime } from "../src/auto-commit-runtime.js";

const webhookSecret = "top-secret";

describe("Git routing contract regressions", () => {
  it.each(["github", "gitlab"] as const)("reports %s route ambiguity independently of authentication", async (provider) => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: main, kind: ${provider}, webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    alpha: { match: [{ triggers: [main] }] }
    beta: { match: [{ triggers: [main] }] }
`);
    const app = createServerApp({ [provider]: resolveGenericWebhookConfigs(config, provider, undefined, undefined, runtime) });
    const payload = JSON.stringify({ ...JSON.parse(pushPayload("acme/repo")), project: { path_with_namespace: "acme/repo" } });
    const headers = provider === "github" ? { "x-github-event": "push", "x-hub-signature-256": `sha256=${sign(payload)}` }
      : { "x-gitlab-event": "Push Hook", "x-gitlab-token": webhookSecret };
    const response = await app.request(`/webhooks/${provider}`, { method: "POST", headers, body: payload });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "ambiguous_route" });
  });
  it("returns an observable template error for a branchless source without persisting a receipt", async () => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: main, kind: github, webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    services:
      match: [{ triggers: [main] }]
      work_path: '{{segment git.branch}}'
`);
    const store = createMemoryAutoCommitStore();
    const app = createServerApp({ github: resolveGenericWebhookConfigs(config, "github", undefined, undefined, runtime),
      autoCommit: new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) }) });
    const payload = pushPayload("acme/repo", "refs/tags/v1");
    const response = await app.request("/webhooks/github", { method: "POST", headers: { "x-github-event": "push", "x-hub-signature-256": `sha256=${sign(payload)}` }, body: payload });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: false, reason: "template_invalid" });
    expect(await store.readNextWake()).toBeUndefined();
  });
  it.each(["gitea", "forgejo", "github", "gitlab"] as const)("pins %s resolution through durable intake", async (provider) => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: main, kind: ${provider}, webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    unrelated: {}
    matched:
      match:
        - triggers: [main]
          source:
            repository: { exact: service }
            namespace: { exact: acme/team }
      work_path: '{{segment source.namespace}}/{{segment source.repository}}'
`);
    const store = createMemoryAutoCommitStore();
    const autoCommit = new AutoCommitRuntime({ store, getPolicyLayers: () => ({}) });
    const configs = resolveGenericWebhookConfigs(config, provider, undefined, undefined, runtime);
    const app = createServerApp({ [provider]: configs, autoCommit });
    const payload = JSON.stringify({ ...JSON.parse(pushPayload("acme/team/service")), project: { path_with_namespace: "acme/team/service" } });
    const headers = provider === "gitlab"
      ? { "x-gitlab-event": "Push Hook", "x-gitlab-token": webhookSecret }
      : provider === "github"
        ? { "x-github-event": "push", "x-hub-signature-256": `sha256=${sign(payload)}` }
        : { "x-gitea-event": "push", "x-gitea-signature": sign(payload) };
    const response = await app.request(`/webhooks/${provider}`, { method: "POST", headers, body: payload });
    expect(response.status).toBe(202);
    const body = await response.json() as { accepted: boolean; processing: { receiptId: string } };
    expect(body.accepted).toBe(true);
    const receipt = await store.getReceipt(body.processing.receiptId);
    expect(receipt?.receipt.workspaceId).toBe("matched");
    expect(receipt?.receipt.resolution).toMatchObject({ kind: "match", definitionId: "matched", binding: { workPath: expect.stringContaining("service") } });
  });

  it("never resolves an unauthenticated payload", async () => {
    let called = false;
    const app = createServerApp({ github: { triggerName: "main", workspaceId: "unused", webhookSecret,
      resolveWorkspace: () => { called = true; throw new Error("must authenticate first"); } } });
    const response = await app.request("/webhooks/github", { method: "POST", headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=invalid" }, body: pushPayload("acme/service") });
    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });
});

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

const MATCH_YAML = `
triggers:
  - { name: gitea-main, kind: gitea, webhook_secret_env: AICR_HOOK_SECRET }
  - { name: gitea-other, kind: gitea, webhook_secret_env: AICR_HOOK_SECRET_2 }
workspaces:
  instances:
    services:
      match:
        - triggers: [gitea-main]
          source:
            repo_ref: { glob: "acme/service-*" }
`;

function runtimeAndConfig(yaml: string) {
  const config = parseConfigDocumentText(yaml).config;
  const runtime = createWorkspaceRuntime(config, "/tmp/aicr-test");
  return { config, runtime };
}

process.env.AICR_HOOK_SECRET = webhookSecret;
process.env.AICR_HOOK_SECRET_2 = "second-secret";

describe("match admission — gitea route (W02, W07)", () => {
  it("a match hit is accepted and routed to the definition", async () => {
    const { config, runtime } = runtimeAndConfig(MATCH_YAML);
    const configs = resolveGiteaLikeWebhookConfigs(config, "gitea", undefined, undefined, runtime);
    const app = createServerApp({ gitea: configs });
    const payload = pushPayload("acme/service-a");

    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-signature": sign(payload) },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reviewEvent?: { workspaceId: string } };
    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.reviewEvent?.workspaceId).toBe("services");
  });

  it("a repo no rule matches is repository_not_configured, never the first workspace", async () => {
    const { config, runtime } = runtimeAndConfig(MATCH_YAML);
    const configs = resolveGiteaLikeWebhookConfigs(config, "gitea", undefined, undefined, runtime);
    const app = createServerApp({ gitea: configs });
    const payload = pushPayload("other/unknown");

    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-signature": sign(payload) },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };
    expect(response.status).toBe(202);
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("repository_not_configured");
  });

  it("multiple definition hits report ambiguous_route (W07)", async () => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: gitea-main, kind: gitea, webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    alpha:
      match:
        - triggers: [gitea-main]
          source:
            repo_ref: { glob: "acme/*" }
    beta:
      match:
        - triggers: [gitea-main]
          source:
            repo_ref: { glob: "acme/service-*" }
`);
    const configs = resolveGiteaLikeWebhookConfigs(config, "gitea", undefined, undefined, runtime);
    const app = createServerApp({ gitea: configs });
    const payload = pushPayload("acme/service-x");

    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-signature": sign(payload) },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reason?: string };
    expect(response.status).toBe(202);
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe("ambiguous_route");
  });

  it("configs without match rules keep the legacy catch-all (W10)", async () => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: gitea-main, kind: gitea, webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    legacy:
      source_repo: { trigger: gitea-main, repo: owent/example }
`);
    const configs = resolveGiteaLikeWebhookConfigs(config, "gitea", undefined, undefined, runtime);
    expect(configs[0]?.resolveWorkspace).toBeUndefined();
    const app = createServerApp({ gitea: configs });
    const payload = pushPayload("any/repo");

    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-signature": sign(payload) },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reviewEvent?: { workspaceId: string } };
    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.reviewEvent?.workspaceId).toBe("legacy");
  });
});

describe("multi-profile selection (W13)", () => {
  it("each gitea profile verifies with its own secret; wrong secrets lose", async () => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: gitea-main, kind: gitea, webhook_secret_env: AICR_HOOK_SECRET }
  - { name: gitea-other, kind: gitea, webhook_secret_env: AICR_HOOK_SECRET_2 }
workspaces:
  instances:
    services:
      match:
        - triggers: [gitea-main]
          source:
            repo_ref: { glob: "acme/service-*" }
    other:
      source_repo: { trigger: gitea-other, repo: "other/repo" }
`);
    const configs = resolveGiteaLikeWebhookConfigs(config, "gitea", undefined, undefined, runtime);
    expect(configs).toHaveLength(2);
    const app = createServerApp({ gitea: configs });

    const payload = pushPayload("other/repo");
    const response = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "push",
        "x-gitea-signature": sign(payload, "second-secret"),
      },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reviewEvent?: { triggerName: string; workspaceId: string } };
    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.reviewEvent?.triggerName).toBe("gitea-other");
    expect(body.reviewEvent?.workspaceId).toBe("other");

    const bad = await app.request("/webhooks/gitea", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-signature": sign(payload, "wrong") },
      body: payload,
    });
    expect(bad.status).toBe(401);
  });
});

describe("match admission — github route", () => {
  it("match-referenced triggers reject unmatched repos at admission", async () => {
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
`);
    const configs = resolveGenericWebhookConfigs(config, "github", undefined, undefined, runtime);
    const app = createServerApp({ github: configs });

    const miss = pushPayload("elsewhere/repo");
    const missResponse = await app.request("/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${sign(miss)}` },
      body: miss,
    });
    expect(missResponse.status).toBe(202);
    expect(((await missResponse.json()) as { reason?: string }).reason).toBe("repository_not_configured");

    const hit = pushPayload("acme/service-a");
    const hitResponse = await app.request("/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${sign(hit)}` },
      body: hit,
    });
    const hitBody = (await hitResponse.json()) as { accepted: boolean; reviewEvent?: { workspaceId: string } };
    expect(hitBody.accepted).toBe(true);
    expect(hitBody.reviewEvent?.workspaceId).toBe("services");
  });
});

describe("forgejo route (P1b: profile registry covers all same-kind triggers)", () => {
  it("forgejo triggers are served on /webhooks/forgejo", async () => {
    const { config, runtime } = runtimeAndConfig(`
triggers:
  - { name: forgejo-main, kind: forgejo, webhook_secret_env: AICR_HOOK_SECRET }
workspaces:
  instances:
    forgejo-ws:
      source_repo: { trigger: forgejo-main, repo: "owent/example" }
`);
    const configs = resolveGiteaLikeWebhookConfigs(config, "forgejo", undefined, undefined, runtime);
    expect(configs).toHaveLength(1);
    const app = createServerApp({ forgejo: configs });
    const payload = pushPayload("owent/example");

    const response = await app.request("/webhooks/forgejo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitea-event": "push", "x-gitea-signature": sign(payload) },
      body: payload,
    });
    const body = (await response.json()) as { accepted: boolean; reviewEvent?: { provider: string; workspaceId: string } };
    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.reviewEvent?.provider).toBe("forgejo");
  });
});
