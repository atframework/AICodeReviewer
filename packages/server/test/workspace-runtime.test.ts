import { join, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfigDocumentText } from "@aicr/core";

import { buildSourceRootResolver } from "../src/bootstrap.js";
import { createWorkspaceRuntime } from "../src/workspace-runtime.js";

const BASE_DIR = resolve("/data/aicr");

function parse(yaml: string) {
  return parseConfigDocumentText(yaml).config;
}

const LEGACY_CONFIG = `
triggers:
  - { name: gitea-main, kind: gitea }
workspaces:
  instances:
    legacy:
      source_repo: { trigger: gitea-main, repo: owent/example }
`;

const MATCH_CONFIG = `
triggers:
  - { name: github-main, kind: github }
  - { name: gitea-self, kind: gitea, base_url: https://gitea.example.com }
workspaces:
  instances:
    services:
      match:
        - triggers: [github-main]
          source:
            repo_ref: { glob: "acme/service-*" }
    templated:
      match:
        - triggers: [gitea-self]
          source:
            repo_ref: { glob: "Engine/*" }
      work_path: "{{segment trigger.name}}/{{segment source.repository}}"
`;

describe("workspace-runtime legacy parity (W10, L13)", () => {
  it("legacy source_root is byte-identical to buildSourceRootResolver", () => {
    const config = parse(LEGACY_CONFIG);
    const runtime = createWorkspaceRuntime(config, BASE_DIR);
    const event = {
      triggerName: "gitea-main",
      workspaceId: "legacy",
      repoRef: "owent/example",
    };
    const legacy = buildSourceRootResolver(BASE_DIR)(event as never);
    expect(runtime.layoutForEvent(event).sourceRoot).toBe(legacy);
  });

  it("legacy agent/tmp/context-repos/templates mirror the historical shape", () => {
    const config = parse(LEGACY_CONFIG);
    const runtime = createWorkspaceRuntime(config, BASE_DIR);
    const layout = runtime.layoutForEvent({
      triggerName: "gitea-main",
      workspaceId: "legacy",
      repoRef: "owent/example:main",
    });
    expect(layout.kind).toBe("legacy_v1");
    expect(layout.sourceRoot).toBe(join(BASE_DIR, "workspaces", "legacy", "source", "owent_example_main"));
    expect(layout.agentDir).toBe(join(BASE_DIR, "workspaces", "legacy", "agent"));
    expect(layout.tmpDir).toBe(join(BASE_DIR, "workspaces", "legacy", "tmp"));
    expect(layout.contextReposDir).toBe(join(BASE_DIR, "workspaces", "legacy", "context-repos"));
  });

  it("unbound fallback workspaces keep the legacy layout", () => {
    const config = parse("workspaces:\n  instances:\n    plain: {}\n");
    const runtime = createWorkspaceRuntime(config, BASE_DIR);
    const layout = runtime.layoutForEvent({ triggerName: "t", workspaceId: "plain", repoRef: "a/b" });
    expect(layout.kind).toBe("legacy_v1");
  });
});

describe("workspace-runtime isolated_v2 (W01)", () => {
  it("match-resolved events get per-instance directories", () => {
    const config = parse(MATCH_CONFIG);
    const runtime = createWorkspaceRuntime(config, BASE_DIR);
    const layout = runtime.layoutForEvent({
      triggerName: "github-main",
      workspaceId: "services",
      repoRef: "acme/service-a",
    });
    expect(layout.kind).toBe("isolated_v2");
    expect(layout.instanceRoot).toContain("services");
    expect(layout.instanceRoot).toMatch(/[0-9a-f]{64}/u);
    expect(layout.sourceRoot).toBe(join(layout.instanceRoot, "source"));
    expect(layout.agentDir).toBe(join(layout.instanceRoot, "agent"));
    expect(layout.contextReposDir).toBe(join(layout.instanceRoot, "context-repos"));
  });

  it("two projects of one definition never share writable dirs (W01, L03)", () => {
    const config = parse(MATCH_CONFIG);
    const runtime = createWorkspaceRuntime(config, BASE_DIR);
    const a = runtime.layoutForEvent({ triggerName: "github-main", workspaceId: "services", repoRef: "acme/service-a" });
    const b = runtime.layoutForEvent({ triggerName: "github-main", workspaceId: "services", repoRef: "acme/service-b" });
    expect(a.instanceRoot).not.toBe(b.instanceRoot);
    expect(a.sourceRoot).not.toBe(b.sourceRoot);
  });

  it("work_path templates render deterministically from event fields", () => {
    const config = parse(MATCH_CONFIG);
    const runtime = createWorkspaceRuntime(config, BASE_DIR);
    const layout = runtime.layoutForEvent({
      triggerName: "gitea-self",
      workspaceId: "templated",
      repoRef: "Engine/Core",
      branch: "main",
    });
    expect(layout.instanceRoot).toContain(join("gitea-self", "Core"));
  });

  it("receive-time resolution and execution-time layout agree (determinism)", () => {
    const config = parse(MATCH_CONFIG);
    const runtime = createWorkspaceRuntime(config, BASE_DIR);
    const resolution = runtime.resolveForSource("github-main", {
      vcs: "git",
      repo_ref: "acme/service-a",
      branch: "main",
      ref: "refs/heads/main",
    });
    expect(resolution.kind).toBe("match");
    const layout = runtime.layoutForEvent({
      triggerName: "github-main",
      workspaceId: "services",
      repoRef: "acme/service-a",
      branch: "main",
    });
    if (resolution.kind !== "match") throw new Error("expected match");
    expect(layout.instanceRoot).toContain(resolution.binding.instanceId);
  });

  it("workspaces.root overrides the layout root", () => {
    const config = parse(`${MATCH_CONFIG}`);
    const withRoot = parseConfigDocumentText(`
triggers:
  - { name: github-main, kind: github }
workspaces:
  root: custom/root
  instances:
    services:
      match:
        - triggers: [github-main]
          source:
            repo_ref: { glob: "acme/*" }
`).config;
    const runtime = createWorkspaceRuntime(withRoot, BASE_DIR);
    const layout = runtime.layoutForEvent({
      triggerName: "github-main",
      workspaceId: "services",
      repoRef: "acme/x",
    });
    expect(layout.instanceRoot.startsWith(join(BASE_DIR, "custom", "root") + sep)).toBe(true);
    void config;
  });
});
