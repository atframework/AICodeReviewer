import { describe, expect, it } from "vitest";
import { buildWorkspaceResolutionVariables, compileWorkspaceMatchDefinitions, createReviewEvent, parseConfigDocumentText,
  projectEventResolution, resolveWorkspaceForSource, reviewMemoryScope, WORK_PATH_TEMPLATE_VARIABLES } from "@aicr/core";
import { describeWebhookSource } from "../src/source-descriptors.js";
import { resolveGenericWebhookConfigs, resolveP4TriggerConfigs, resolveSvnTriggerConfigs } from "../src/bootstrap.js";
import { createWorkspaceRuntime } from "../src/workspace-runtime.js";
import { createServerApp } from "../src/index.js";

const githubPayload = {
  repository: { id: 12, full_name: "group/project", default_branch: "main" },
  installation: { id: 19 }, issue: { number: 7 },
  pull_request: { number: 9, head: { ref: "feature", repo: { full_name: "fork/project", owner: { login: "fork" } } }, base: { ref: "main" } },
};
const gitlabPayload = {
  object_kind: "merge_request", project: { id: 12, path_with_namespace: "group/sub/project", default_branch: "main" },
  object_attributes: { id: 100, iid: 9, source_project_id: 44, target_project_id: 12, source_branch: "feature", target_branch: "main" }, issue: { iid: 7 },
};

describe("provider identity contracts", () => {
  it.each(["github", "gitea", "forgejo"])("%s extracts distinct decimal IDs only in its namespace", (kind) => {
    const descriptor = describeWebhookSource(kind, githubPayload)!;
    const variables = buildWorkspaceResolutionVariables({ definitionId: "services", instanceId: "instance", trigger: { name: "primary", kind }, ...descriptor });
    expect(variables[kind]).toMatchObject({ repository_id: "12", pull_number: "9", issue_number: "7" });
    expect((variables[kind] as Record<string, unknown>).installation_id).toBe(kind === "github" ? "19" : undefined);
    expect((variables.git as Record<string, unknown>).default_branch).toBe("main");
    expect(Object.keys(variables).filter((key) => ["github", "gitea", "forgejo", "gitlab"].includes(key))).toEqual([kind]);
  });

  it("keeps GitLab project IDs distinct from issue/MR iids, including note events", () => {
    for (const payload of [gitlabPayload, { ...gitlabPayload, object_kind: "note", merge_request: gitlabPayload.object_attributes, object_attributes: { id: 999, iid: 888 } }]) {
      const descriptor = describeWebhookSource("gitlab", payload)!;
      const vars = buildWorkspaceResolutionVariables({ definitionId: "services", instanceId: "instance", trigger: { name: "primary", kind: "gitlab" }, ...descriptor });
      expect(vars.gitlab).toMatchObject({ namespace: "group/sub", project_id: "12", source_project_id: "44", target_project_id: "12", merge_request_iid: "9", issue_iid: "7" });
    }
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5, "1e3", "01"])("does not fabricate an ID from %s", (id) => {
    expect(describeWebhookSource("github", { repository: { id, full_name: "a/b" } })?.event?.provider_fields?.repository_id).toBeNull();
  });

  it("deleted branches retain the real ref while exposing a null branch", () => {
    expect(describeWebhookSource("github", { repository: { full_name: "a/b" }, ref: "refs/heads/main", after: "0".repeat(40) })?.source).toMatchObject({ branch: null, ref: "refs/heads/main" });
  });
});

describe("variable catalog completeness (V13)", () => {
  const facts: Record<string, Record<string, string>> = {
    p4: { server: "ssl:p4.example:1666", depot: "depot", depot_path: "//depot/main", stream: "//depot/main", stream_name: "main", client: "author-client", service_client: "aicr-client", user: "alice", change: "42", scope: "//depot/main" },
    svn: { repository_url: "https://svn.example/repo", repository_root: "https://svn.example/repo", repository_uuid: "uuid-1", repository: "app", project_path: "/app/trunk", branch: "trunk", revision: "42", author: "alice" },
  };
  for (const entry of WORK_PATH_TEMPLATE_VARIABLES) {
    it(`${entry.path} has a producer and a missing/event boundary`, () => {
      expect(entry.type).toBe("string");
      expect(entry.events.length).toBeGreaterThan(0);
      if (entry.availability !== "extracted") { expect(entry.sample).toBeNull(); return; }
      const [namespace, field] = entry.path.split(".") as [string, string];
      const kind = ["gitea", "forgejo", "gitlab", "p4", "svn"].includes(namespace) ? namespace : "github";
      const descriptor = describeWebhookSource(kind, kind === "gitlab" ? gitlabPayload : githubPayload);
      const source = descriptor?.source ?? { vcs: kind, repo_ref: kind === "p4" ? "//depot/main" : "https://svn.example/repo/app", repository: "app", namespace: "group", branch: "main", ref: "42" };
      const vars = buildWorkspaceResolutionVariables({ definitionId: "services", instanceId: "instance", trigger: { name: "primary", kind },
        source: { ...source, branch: "feature", ref: "refs/heads/feature" }, event: { ...descriptor?.event,
          ...(facts[kind] ? { provider_fields: facts[kind] } : {}), manual: { request_id: "request-1", requested_by: "operator", requested_workspace: "services" } } });
      expect((vars[namespace] as Record<string, unknown>)[field]).toEqual(expect.any(String));
      const missing = buildWorkspaceResolutionVariables({ definitionId: "services", instanceId: "instance", trigger: { name: "primary", kind },
        source: { vcs: source.vcs, repo_ref: "project" } });
      const boundary = (missing[namespace] as Record<string, unknown> | undefined)?.[field];
      if (entry.nullable && !["source.repository", "trigger.host"].includes(entry.path)) expect(boundary).toBeNull();
      else expect(typeof boundary).toBe("string");
      expect(entry.acquisitionStage).not.toBe("unavailable");
    });
  }
});

describe("pinned source identity and admission (W12/V14)", () => {
  const configText = 'triggers: [{name: primary, kind: github}]\nworkspaces:\n  instances:\n    services:\n      match: [{triggers: [primary]}]\n      work_path: "{{segment github.repository_id}}"\n';
  it("persists full variables and memory scope when definitions/triggers disappear", () => {
    const config = parseConfigDocumentText(configText).config;
    const descriptor = describeWebhookSource("github", githubPayload)!;
    const resolution = resolveWorkspaceForSource(config, compileWorkspaceMatchDefinitions(config), "primary", descriptor.source, descriptor.event);
    expect(resolution.kind).toBe("match");
    if (resolution.kind !== "match") throw new Error("fixture must match");
    const event = createReviewEvent({ triggerName: "primary", workspaceId: "services", provider: "github", targetKind: "pull_request", repoRef: "group/project", author: {}, reason: "fixture", resolution: projectEventResolution(resolution) });
    const replay = createReviewEvent(JSON.parse(JSON.stringify(event)));
    const empty = parseConfigDocumentText("triggers: []\nworkspaces: {instances: {}}\n").config;
    expect(createWorkspaceRuntime(empty, "build/tmp/pinned").layoutForEvent(replay).instanceRoot).toContain(resolution.binding.instanceId);
    expect(replay.resolution).toEqual(resolution);
    expect(reviewMemoryScope(replay)).toBe(resolution.binding.instanceId);
    expect(reviewMemoryScope({ ...event, resolution: undefined })).toBe("services");
    expect(resolveGenericWebhookConfigs(empty, "github")).toEqual([]);
  });

  it.each(["definition", "trigger"])("disabled %s rejects new work while a pinned event remains usable", (disabled) => {
    const config = parseConfigDocumentText(configText).config;
    if (disabled === "definition") config.workspaces.instances.services!.enabled = false;
    else config.triggers[0]!.enabled = false;
    const descriptor = describeWebhookSource("github", githubPayload)!;
    expect(resolveWorkspaceForSource(config, compileWorkspaceMatchDefinitions(config), "primary", descriptor.source, descriptor.event)).toEqual({ kind: "no_match" });
    if (disabled === "trigger") expect(resolveGenericWebhookConfigs(config, "github")).toEqual([]);
  });

  it.each(["p4", "svn"])("disabled %s profiles are not registered for admission", (kind) => {
    const config = parseConfigDocumentText(`triggers: [{name: primary, kind: ${kind}, enabled: false, repository_url: "https://svn.example/repo"}]`).config;
    expect(kind === "p4" ? resolveP4TriggerConfigs(config) : resolveSvnTriggerConfigs(config)).toEqual([]);
  });

  it("rejects an HTTP push for a disabled definition before creating a review receipt", async () => {
    const config = parseConfigDocumentText(configText).config;
    config.workspaces.instances.services!.enabled = false;
    const profiles = resolveGenericWebhookConfigs(config, "github", undefined, undefined, createWorkspaceRuntime(config, "build/tmp/disabled"));
    expect(profiles).toEqual([]);
    const app = createServerApp({ github: profiles });
    const response = await app.request("/webhooks/github", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push" }, body: JSON.stringify({ repository: githubPayload.repository, ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40) }) });
    expect((await response.json()).accepted).toBe(false);
  });
});
