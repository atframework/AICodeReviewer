import { describe, expect, it } from "vitest";

import {
  canonicalProjectKey,
  compileWorkspaceMatchDefinitions,
  deriveRepositoryParts,
  parseConfigDocumentText,
  resolveWorkspaceForSource,
  triggerKindToVcs,
  triggerProfileHost,
  validateWorkspaceDefinitions,
  workspaceAmbiguityError,
  ConfigError,
  type WorkspaceMatchConfigInput,
  type WorkspaceSourceValues,
} from "../src/index.js";

const TRIGGERS = [
  { name: "github-main", kind: "github" },
  { name: "gitea-self", kind: "gitea", base_url: "https://gitea.example.com/" },
  { name: "gitlab-main", kind: "gitlab", base_url: "https://gitlab.example.com" },
] as const;

function configWith(instances: WorkspaceMatchConfigInput["workspaces"]["instances"]): WorkspaceMatchConfigInput {
  return { triggers: TRIGGERS, workspaces: { instances } };
}

function source(repoRef: string, extra?: Partial<WorkspaceSourceValues>): WorkspaceSourceValues {
  return { vcs: "git", repo_ref: repoRef, ...extra };
}

function resolvedMap(config: WorkspaceMatchConfigInput) {
  return compileWorkspaceMatchDefinitions(config);
}

describe("trigger/vcs/host helpers", () => {
  it("maps trigger kinds to source.vcs values", () => {
    expect(triggerKindToVcs("github")).toBe("git");
    expect(triggerKindToVcs("gitea")).toBe("git");
    expect(triggerKindToVcs("forgejo")).toBe("git");
    expect(triggerKindToVcs("gitlab")).toBe("git");
    expect(triggerKindToVcs("p4")).toBe("p4");
    expect(triggerKindToVcs("svn")).toBe("svn");
    expect(triggerKindToVcs("manual")).toBeUndefined();
    expect(triggerKindToVcs("scheduled")).toBeUndefined();
  });

  it("extracts a lowercase host from base_url and applies provider defaults", () => {
    expect(triggerProfileHost({ name: "t", kind: "github" })).toBe("github.com");
    expect(triggerProfileHost({ name: "t", kind: "gitlab" })).toBe("gitlab.com");
    expect(triggerProfileHost({ name: "t", kind: "gitea", base_url: "https://Gitea.Example.com:8443/root" })).toBe(
      "gitea.example.com:8443",
    );
    expect(triggerProfileHost({ name: "t", kind: "gitea", base_url: "not a url" })).toBeUndefined();
    expect(triggerProfileHost({ name: "t", kind: "gitea" })).toBeUndefined();
  });

  it("builds canonical project keys preserving repo case", () => {
    expect(canonicalProjectKey({ vcs: "git", host: "github.com", repoRef: "Owner/Repo" })).toBe(
      "git:github.com:Owner/Repo",
    );
    expect(canonicalProjectKey({ vcs: "git", host: undefined, repoRef: "o/r" })).toBe("git::o/r");
  });

  it("splits repository parts at the last slash", () => {
    expect(deriveRepositoryParts("owner/repo")).toEqual({ repository: "repo", namespace: "owner" });
    expect(deriveRepositoryParts("group/sub/project")).toEqual({ repository: "project", namespace: "group/sub" });
    expect(deriveRepositoryParts("single")).toEqual({ repository: "single", namespace: undefined });
  });
});

describe("resolveWorkspaceForSource", () => {
  it("an explicit route selects one permitted candidate and settles ambiguity (W08)", () => {
    const config = configWith({
      services: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/service-*" } } }] },
      platform: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/*" } } }] },
    });
    const map = resolvedMap(config);
    // Without a request the overlapping rules are ambiguous (W07).
    const plain = resolveWorkspaceForSource(config, map, "github-main", source("acme/service-a"));
    expect(plain.kind).toBe("ambiguous");
    // The explicit route picks one of the permitted candidates deterministically.
    const picked = resolveWorkspaceForSource(
      config, map, "github-main", source("acme/service-a"), undefined,
      { workspaceId: "platform" },
    );
    expect(picked.kind).toBe("match");
    if (picked.kind === "match") {
      expect(picked.definitionId).toBe("platform");
      expect(picked.binding.definitionId).toBe("platform");
    }
  });

  it("an explicit route outside the permitted rules is denied, never widened (W09)", () => {
    const config = configWith({
      services: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/service-*" } } }] },
      secrets: { match: [{ triggers: ["github-main"], source: { repo_ref: { exact: "acme/vault" } } }] },
    });
    const map = resolvedMap(config);
    // "secrets" has no rule covering acme/service-a: explicit selection is denied.
    const denied = resolveWorkspaceForSource(
      config, map, "github-main", source("acme/service-a"), undefined,
      { workspaceId: "secrets" },
    );
    expect(denied).toEqual({ kind: "route_denied", definitionId: "secrets", reason: "source_not_permitted" });
    // Unknown definition ids are denied with their own reason.
    const unknown = resolveWorkspaceForSource(
      config, map, "github-main", source("acme/service-a"), undefined,
      { workspaceId: "ghost" },
    );
    expect(unknown).toEqual({ kind: "route_denied", definitionId: "ghost", reason: "unknown_definition" });
  });

  it("an explicit route never widens a legacy source_repo binding (W09)", () => {
    const config = configWith({
      legacy: { source_repo: { trigger: "github-main", repo: "acme/legacy" } },
      other: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/*" } } }] },
    });
    const map = resolvedMap(config);
    const denied = resolveWorkspaceForSource(
      config, map, "github-main", source("acme/legacy"), undefined,
      { workspaceId: "other" },
    );
    expect(denied).toEqual({ kind: "route_denied", definitionId: "other", reason: "source_not_permitted" });
    const allowed = resolveWorkspaceForSource(
      config, map, "github-main", source("acme/legacy"), undefined,
      { workspaceId: "legacy" },
    );
    expect(allowed).toEqual({ kind: "legacy_binding", definitionId: "legacy" });
  });

  it("fork PR variables: target identity, separate head repo fields (V02)", () => {
    const config = configWith({
      services: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/*" } } }] },
    });
    const map = resolvedMap(config);
    const fork = resolveWorkspaceForSource(
      config, map, "github-main", source("acme/service", { branch: "feature/x" }),
      { base_branch: "main", head_branch: "feature/x", head_repository: "contributor/service", head_owner: "contributor" },
    );
    if (fork.kind !== "match") {
      throw new Error("expected match resolution");
    }
    // project identity derives from the target repo only.
    expect(fork.variables.source).toMatchObject({ repo_ref: "acme/service", project_key: "git:github.com:acme/service" });
    expect(fork.variables.git).toMatchObject({
      full_name: "acme/service",
      head_repository: "contributor/service",
      head_owner: "contributor",
      base_branch: "main",
    });
    const sameRepo = resolveWorkspaceForSource(
      config, map, "github-main", source("acme/service", { branch: "feature/x" }),
      { base_branch: "main", head_branch: "feature/x" },
    );
    if (sameRepo.kind !== "match") {
      throw new Error("expected match resolution");
    }
    expect(sameRepo.variables.git).toMatchObject({ head_repository: null, head_owner: null });
  });

  it("match variables carry trusted manual fields, null when absent (V11)", () => {
    const config = configWith({
      services: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/*" } } }] },
    });
    const map = resolvedMap(config);
    const withManual = resolveWorkspaceForSource(
      config, map, "github-main", source("acme/service"),
      { manual: { request_id: "req-1", requested_workspace: "services", requested_by: "op" } },
    );
    if (withManual.kind !== "match") {
      throw new Error("expected match resolution");
    }
    expect(withManual.variables.manual).toEqual({
      request_id: "req-1",
      requested_workspace: "services",
      requested_by: "op",
    });
    const withoutManual = resolveWorkspaceForSource(config, map, "github-main", source("acme/service"));
    if (withoutManual.kind !== "match") {
      throw new Error("expected match resolution");
    }
    expect(withoutManual.variables.manual).toEqual({
      request_id: null,
      requested_workspace: null,
      requested_by: null,
    });
  });

  it("legacy source_repo binding wins over match rules (W10 precedence)", () => {
    const config = configWith({
      legacy: { source_repo: { trigger: "github-main", repo: "acme/legacy" } },
      matcher: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/*" } } }] },
    });
    const result = resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("acme/service"));
    expect(result).toEqual({ kind: "legacy_binding", definitionId: "legacy" });
  });

  it("a single match hit binds definition, instance id and default work path (W01)", () => {
    const config = configWith({
      services: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/service-*" } } }] },
    });
    const a = resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("acme/service-a"));
    const b = resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("acme/service-b"));
    if (a.kind !== "match" || b.kind !== "match") {
      throw new Error("expected match resolutions");
    }
    expect(a.definitionId).toBe("services");
    expect(a.binding.definitionId).toBe("services");
    expect(a.binding.workPath).toBe("services");
    // Same definition, different projects: distinct instance ids (W01).
    expect(a.binding.instanceId).not.toBe(b.binding.instanceId);
    expect(a.binding.instanceId).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rules are OR-ed; conditions inside a rule are AND-ed (W02)", () => {
    const config = configWith({
      engine: {
        match: [
          { triggers: ["github-main"], source: { repo_ref: { glob: "Engine/*" }, branch: { exact: "main" } } },
          { triggers: ["github-main"], source: { repo_ref: { exact: "Tools/forge" } } },
        ],
      },
    });
    const map = resolvedMap(config);
    expect(
      resolveWorkspaceForSource(config, map, "github-main", source("Engine/core", { branch: "main" })).kind,
    ).toBe("match");
    // Branch condition fails: AND inside the rule.
    expect(
      resolveWorkspaceForSource(config, map, "github-main", source("Engine/core", { branch: "dev" })).kind,
    ).toBe("no_match");
    // Second rule hits without any branch.
    expect(resolveWorkspaceForSource(config, map, "github-main", source("Tools/forge")).kind).toBe("match");
    expect(resolveWorkspaceForSource(config, map, "github-main", source("Other/repo")).kind).toBe("no_match");
  });

  it("ignores rules bound to other triggers", () => {
    const config = configWith({
      engine: { match: [{ triggers: ["gitlab-main"], source: { repo_ref: { glob: "Engine/*" } } }] },
    });
    const result = resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("Engine/core"));
    expect(result).toEqual({ kind: "unbound" });
  });

  it("rules without triggers apply to every trigger (strict scope)", () => {
    const config = configWith({
      all: { match: [{ source: { repo_ref: { glob: "Engine/*" } } }] },
    });
    expect(resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("Engine/core")).kind).toBe(
      "match",
    );
    expect(resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("Else/where")).kind).toBe(
      "no_match",
    );
  });

  it("multiple definition hits report ambiguity with sorted ids, never a pick (W07)", () => {
    const config = configWith({
      alpha: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/*" } } }] },
      beta: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "acme/service-*" } } }] },
    });
    const result = resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("acme/service-x"));
    expect(result).toEqual({ kind: "ambiguous", definitionIds: ["alpha", "beta"] });
    const error = workspaceAmbiguityError(result.kind === "ambiguous" ? result.definitionIds : []);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.code).toBe("ambiguous_route");
  });

  it("unbound triggers keep the legacy fallback contract", () => {
    const config = configWith({ plain: {} });
    expect(resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("any/repo"))).toEqual({
      kind: "unbound",
    });
  });

  it("identity is case-preserving even when matching folds case (W05)", () => {
    const config = configWith({
      engine: { match: [{ triggers: ["github-main"], source: { repo_ref: { glob: "engine/*", ignore_case: true } } }] },
    });
    const lower = resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("engine/core"));
    const upper = resolveWorkspaceForSource(config, resolvedMap(config), "github-main", source("ENGINE/CORE"));
    if (lower.kind !== "match" || upper.kind !== "match") {
      throw new Error("expected match resolutions");
    }
    expect(lower.binding.instanceId).not.toBe(upper.binding.instanceId);
  });

  it("renders work_path with trigger/source/git variables", () => {
    const config = configWith({
      engine: {
        match: [{ triggers: ["gitea-self"], source: { repo_ref: { glob: "Engine/*" } } }],
        work_path: "{{segment trigger.name}}/{{segment source.repository}}",
      },
    });
    const result = resolveWorkspaceForSource(config, resolvedMap(config), "gitea-self", source("Engine/Core"));
    if (result.kind !== "match") {
      throw new Error("expected match resolution");
    }
    expect(result.binding.workPath).toBe("gitea-self/Core");
    const variables = result.variables as Record<string, Record<string, unknown>>;
    expect(variables.trigger?.host).toBe("gitea.example.com");
    expect(variables.source?.project_key).toBe("git:gitea.example.com:Engine/Core");
    expect(variables.git?.owner).toBe("Engine");
    expect(variables.gitea?.full_name).toBe("Engine/Core");
  });

  it("exposes PR base/head branches through the event context", () => {
    const config = configWith({
      engine: { match: [{ triggers: ["gitlab-main"] }] },
    });
    const result = resolveWorkspaceForSource(
      config,
      resolvedMap(config),
      "gitlab-main",
      source("group/sub/project", { branch: "feature" }),
      { base_branch: "main", head_branch: "feature" },
    );
    if (result.kind !== "match") {
      throw new Error("expected match resolution");
    }
    const variables = result.variables as Record<string, Record<string, unknown>>;
    expect(variables.gitlab?.namespace).toBe("group/sub");
    expect(variables.gitlab?.source_branch).toBe("feature");
    expect(variables.gitlab?.target_branch).toBe("main");
  });
});

describe("work_path variable registry", () => {
  function parseWith(workPath: string): void {
    parseConfigDocumentText(
      [
        "triggers:",
        "  - { name: github-main, kind: github }",
        "workspaces:",
        "  instances:",
        "    engine:",
        "      match: [{ triggers: [github-main] }]",
        `      work_path: '${workPath}'`,
        "",
      ].join("\n"),
    );
  }

  it("accepts extracted variables", () => {
    expect(() =>
      parseWith("{{segment trigger.name}}/{{segment git.branch}}/{{segment (default git.namespace \"none\")}}"),
    ).not.toThrow();
  });

  it("rejects event.* variables as unstable (template_invalid)", () => {
    try {
      parseWith("{{segment event.action}}/{{workspace.id}}");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("template_invalid");
      expect((error as ConfigError).message).toContain("event.action");
    }
  });

  it("rejects registered-but-unextracted provider fields", () => {
    try {
      parseWith("{{segment github.repository_id}}");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ConfigError).code).toBe("template_invalid");
      expect((error as ConfigError).message).toContain("not yet extracted");
    }
  });

  it("rejects unknown variable roots with guidance", () => {
    try {
      parseWith("{{segment payload.repo}}");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ConfigError).code).toBe("template_invalid");
      expect((error as ConfigError).message).toContain("Unknown work_path variable");
    }
  });

  it("validateWorkspaceDefinitions also enforces the registry", () => {
    expect(() =>
      validateWorkspaceDefinitions(
        configWith({ bad: { match: [{ triggers: ["github-main"] }], work_path: "{{segment svn.revision}}" } }),
      ),
    ).toThrowError(/not yet extracted/u);
  });
});
