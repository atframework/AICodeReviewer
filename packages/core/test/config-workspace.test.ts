import { describe, expect, it } from "vitest";

import {
  ConfigError,
  buildWorkspaceBinding,
  computeWorkspaceInstanceId,
  computeWorkspaceLayout,
  parseConfigDocumentText,
  validateWorkspaceDefinitions,
  type WorkspaceMatchConfigInput,
} from "../src/index.js";

const TRIGGER = { name: "gitea-main" };

function config(instances: WorkspaceMatchConfigInput["workspaces"]["instances"]): WorkspaceMatchConfigInput {
  return { triggers: [TRIGGER], workspaces: { instances } };
}

function expectCode(fn: () => unknown, code: string, fragment?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(code);
    if (fragment !== undefined) {
      expect((error as ConfigError).message).toContain(fragment);
    }
    return;
  }
  throw new Error(`expected ConfigError ${code}`);
}

describe("validateWorkspaceDefinitions", () => {
  it.each(["../escape", "bad/name", "root", "CON.txt"])("rejects unsafe v2 definition id %s", (id) => {
    expect(() => validateWorkspaceDefinitions(config({ [id]: { match: [{ triggers: [TRIGGER.name] }] } }))).toThrow(ConfigError);
  });

  it("keeps distinct case-sensitivity rules", () => {
    expect(() => validateWorkspaceDefinitions(config({ safe: { match: [
      { source: { repo_ref: { glob: "Owner/Repo" } } },
      { source: { repo_ref: { glob: "Owner/Repo", ignore_case: true } } },
    ] } }))).not.toThrow();
  });

  it("does not let variables override binding identity", () => {
    expect(buildWorkspaceBinding({ definitionId: "safe", triggerName: TRIGGER.name, vcs: "git", canonicalProjectKey: "git:x" },
      { workspace: { id: "forged", instance_id: "forged" } }).workPath).toBe("safe");
  });
  it("accepts legacy source_repo definitions and definitions without match", () => {
    validateWorkspaceDefinitions(config({ plain: {}, legacy: { source_repo: { trigger: "gitea-main", repo: "owner/repo" } } }));
  });

  it("accepts a valid v2 match definition with work_path", () => {
    validateWorkspaceDefinitions(
      config({
        engine: {
          match: [{ id: "r1", triggers: ["gitea-main"], source: { repo_ref: { glob: "Engine/*" } } }],
          work_path: "{{segment source.repository}}",
        },
      }),
    );
  });

  it("rejects source_repo XOR match violations and work_path without match", () => {
    expectCode(
      () =>
        validateWorkspaceDefinitions(
          config({ bad: { source_repo: { trigger: "gitea-main", repo: "o/r" }, match: [{ triggers: ["gitea-main"] }] } }),
        ),
      "match_rule_invalid",
      "mutually exclusive",
    );
    expectCode(
      () => validateWorkspaceDefinitions(config({ bad: { work_path: "{{workspace.id}}" } })),
      "match_rule_invalid",
      "without match",
    );
  });

  it("rejects empty and over-budget match lists", () => {
    expectCode(() => validateWorkspaceDefinitions(config({ bad: { match: [] } })), "match_rule_invalid", "empty");
    const rules = Array.from({ length: 129 }, () => ({ triggers: ["gitea-main"] }));
    expectCode(() => validateWorkspaceDefinitions(config({ bad: { match: rules } })), "match_rule_invalid", "128-rule");
  });

  it("passes exactly at the rule budget and rejects a total-expression overflow (W06)", () => {
    // Exactly 128 rules is the boundary and must pass.
    const atLimit = Array.from({ length: 128 }, (_, index) => ({
      id: `r${index}`,
      triggers: ["gitea-main"],
      source: { vcs: { exact: `v${index}` } },
    }));
    expect(() => validateWorkspaceDefinitions(config({ ok: { match: atLimit } }))).not.toThrow();

    // 64 KiB total-expression budget across one definition's rules.
    const fat = [
      { id: "a", triggers: ["gitea-main"], source: { vcs: { exact: "x".repeat(32 * 1024) } } },
      { id: "b", triggers: ["gitea-main"], source: { repo_ref: { glob: "y".repeat(33 * 1024) } } },
    ];
    expectCode(() => validateWorkspaceDefinitions(config({ bad: { match: fat } })), "match_rule_invalid", "total");
  });

  it("rejects unknown trigger references and duplicate rule ids", () => {
    expectCode(
      () => validateWorkspaceDefinitions(config({ bad: { match: [{ triggers: ["no-such-trigger"] }] } })),
      "invalid_reference",
      "no-such-trigger",
    );
    expectCode(
      () =>
        validateWorkspaceDefinitions(
          config({ bad: { match: [{ id: "r", triggers: ["gitea-main"] }, { id: "r", source: { vcs: { exact: "git" } } }] } }),
        ),
      "duplicate_entity",
    );
  });

  it("rejects byte-identical rules as ambiguous instead of picking one", () => {
    expectCode(
      () =>
        validateWorkspaceDefinitions(
          config({
            bad: {
              match: [
                { triggers: ["gitea-main"], source: { vcs: { exact: "git" } } },
                { triggers: ["gitea-main"], source: { vcs: { exact: "git" } } },
              ],
            },
          }),
        ),
      "ambiguous_route",
    );
    // Same trigger set or same fields with different expressions is
    // distinguishable — allowed.
    validateWorkspaceDefinitions(
      config({
        ok: {
          match: [
            { triggers: ["gitea-main"], source: { vcs: { exact: "git" } } },
            { triggers: ["gitea-main"], source: { vcs: { exact: "svn" } } },
            { source: { repo_ref: { glob: "a/*" } } },
            { source: { repo_ref: { glob: "b/*" } } },
          ],
        },
      }),
    );
  });

  it("rejects invalid matchers and templates at parse time", () => {
    expectCode(
      () => validateWorkspaceDefinitions(config({ bad: { match: [{ source: { evil: { exact: "x" } } }] } })),
      "matcher_invalid",
    );
    expectCode(
      () => validateWorkspaceDefinitions(config({ bad: { match: [{ triggers: ["gitea-main"] }], work_path: "{{#if x}}" } })),
      "template_invalid",
    );
  });

  it("runs through parseConfigDocumentText for real YAML", () => {
    const loaded = parseConfigDocumentText(
      [
        "triggers:",
        "  - { name: gitea-main, kind: gitea }",
        "workspaces:",
        "  instances:",
        "    engine:",
        "      match:",
        "        - triggers: [gitea-main]",
        "          source:",
        "            repo_ref: { glob: 'Engine/*', ignore_case: true }",
        "      work_path: \"{{segment source.repository}}/{{workspace.id}}\"",
        "",
      ].join("\n"),
    );
    const instance = loaded.config.workspaces.instances["engine"];
    expect(instance?.match?.[0]?.triggers).toEqual(["gitea-main"]);
    expect(instance?.work_path).toContain("segment");
  });

  it("parse rejects a match definition referencing an unknown trigger", () => {
    expectCode(
      () =>
        parseConfigDocumentText(
          ["triggers:", "  - { name: gitea-main, kind: gitea }", "workspaces:", "  instances:", "    engine:", "      match:", "        - triggers: [nope]", ""].join("\n"),
        ),
      "invalid_reference",
    );
  });
});

describe("buildWorkspaceBinding", () => {
  const input = {
    definitionId: "engine",
    triggerName: "gitea-main",
    vcs: "git",
    canonicalProjectKey: "git:gitea.example.com:engine/core",
  };

  it("derives the spec instance identity", () => {
    const binding = buildWorkspaceBinding(input, {});
    expect(binding.instanceId).toBe(
      computeWorkspaceInstanceId({
        definitionId: "engine",
        triggerName: "gitea-main",
        vcs: "git",
        canonicalProjectKey: "git:gitea.example.com:engine/core",
      }),
    );
    expect(binding.instanceId).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("defaults the work path to {{workspace.id}}", () => {
    expect(buildWorkspaceBinding(input, {}).workPath).toBe("engine");
  });

  it("renders work_path with source variables without changing identity", () => {
    const variables = { source: { repository: "Core" } };
    const binding = buildWorkspaceBinding({ ...input, workPathTemplate: "{{segment source.repository}}" }, variables);
    expect(binding.workPath).toBe("Core");
    expect(binding.instanceId).toBe(buildWorkspaceBinding(input, {}).instanceId);
  });
});

describe("computeWorkspaceLayout", () => {
  const binding = { definitionId: "engine", instanceId: "f".repeat(64), workPath: "engine/core" };

  it("legacy_v1 mirrors the historical layout exactly", () => {
    const layout = computeWorkspaceLayout("/data/workspaces", { ...binding, workPath: "owner/repo:main" }, "legacy_v1");
    expect(layout.instanceRoot).toBe("/data/workspaces/engine");
    expect(layout.sourceRoot).toBe("/data/workspaces/engine/source/owner_repo_main");
    expect(layout.agentDir).toBe("/data/workspaces/engine/agent");
    expect(layout.tmpDir).toBe("/data/workspaces/engine/tmp");
    expect(layout.contextReposDir).toBe("/data/workspaces/engine/context-repos");
    expect(layout.templatesDir).toBe("/data/workspaces/engine/templates");
  });

  it("isolated_v2 nests under workPath plus full instance id", () => {
    const layout = computeWorkspaceLayout("/data/workspaces", binding, "isolated_v2");
    expect(layout.instanceRoot).toBe(`/data/workspaces/engine/core/${"f".repeat(64)}`);
    expect(layout.sourceRoot).toBe(`${layout.instanceRoot}/source`);
    expect(layout.contextReposDir).toBe(`${layout.instanceRoot}/context-repos`);
    expect(layout.templatesDir).toBe(`${layout.instanceRoot}/templates`);
  });

  it("identical work paths never share writable dirs thanks to the instance suffix", () => {
    const a = buildWorkspaceBinding(
      { definitionId: "d", triggerName: "t", vcs: "git", canonicalProjectKey: "git:h:o/r1", workPathTemplate: "shared" },
      {},
    );
    const b = buildWorkspaceBinding(
      { definitionId: "d", triggerName: "t", vcs: "git", canonicalProjectKey: "git:h:o/r2", workPathTemplate: "shared" },
      {},
    );
    const layoutA = computeWorkspaceLayout("/w", a, "isolated_v2");
    const layoutB = computeWorkspaceLayout("/w", b, "isolated_v2");
    expect(layoutA.sourceRoot).not.toBe(layoutB.sourceRoot);
    expect(layoutA.instanceRoot).toContain(a.instanceId);
  });
});
