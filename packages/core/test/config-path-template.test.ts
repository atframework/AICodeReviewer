import { describe, expect, it } from "vitest";

import {
  ConfigError,
  WORK_PATH_TEMPLATE_VARIABLES,
  assertSafeWorkPathOutput,
  compileWorkspaceMatchDefinitions,
  compileWorkspacePathTemplate,
  pathTemplateDefault,
  pathTemplateHash,
  pathTemplateLower,
  pathTemplateSegment,
  resolveWorkspaceForSource,
  validateWorkPathTemplateVariables,
  type PathTemplateVariables,
} from "../src/index.js";

function expectTemplateError(fn: () => unknown, fragment?: string): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe("template_invalid");
    if (fragment !== undefined) {
      expect((error as ConfigError).message).toContain(fragment);
    }
    return error as ConfigError;
  }
  throw new Error("expected template_invalid ConfigError");
}

describe("segment helper", () => {
  it.each(["CON.txt", "LPT1.log", "COM¹", "NUL.tar.gz"])("rejects reserved Windows name %s", (value) => {
    expectTemplateError(() => pathTemplateSegment(value));
  });
  it("passes portable values through unchanged", () => {
    expect(pathTemplateSegment("owner-repo_1.2")).toBe("owner-repo_1.2");
    expect(pathTemplateSegment("工程")).toBe("工程");
  });

  it("encodes hostile characters with the fixed encoding plus original hash", () => {
    const encoded = pathTemplateSegment("owner/repo");
    expect(encoded).toMatch(/^owner_x2F_repo~[0-9a-f]{12}$/u);
    expect(pathTemplateSegment("a:b")).toMatch(/^a_x3A_b~[0-9a-f]{12}$/u);
    // Distinct originals never collapse to the same segment.
    expect(pathTemplateSegment("a/b")).not.toBe(pathTemplateSegment("a\\b"));
  });

  it.each([".", "..", "NUL", "con", "COM1", "lpt9"])("rejects the reserved segment %s", (value) => {
    expectTemplateError(() => pathTemplateSegment(value));
  });

  it.each(["a ", "a.", " a b "])("rejects trailing dots/spaces: %j", (value) => {
    expectTemplateError(() => pathTemplateSegment(value));
  });

  it("rejects NUL bytes inside the value", () => {
    expectTemplateError(() => pathTemplateSegment("a\0b"));
  });

  it("requires an explicit default for null or empty values", () => {
    expectTemplateError(() => pathTemplateSegment(null), "default");
    expectTemplateError(() => pathTemplateSegment(undefined));
    expectTemplateError(() => pathTemplateSegment(""));
  });
});

describe("path template boundary regressions", () => {
  it.each([
    "{{segment}}", "{{hash}}", "{{segment source.repository 1}}",
    '{{default source.repository "fallback"}}',
    "{{segment (default source.repository source.namespace)}}",
    '{{segment "safe" ignored=(lookup source "repository")}}',
    '{{workspace.id ignored="value"}}',
    "{{../segment source.repository}}", "{{@segment source.repository}}",
  ])("rejects invalid helper invocation at compile time: %s", (source) => {
    expectTemplateError(() => compileWorkspacePathTemplate(source));
  });

  it.each(["safe/CON.txt", "safe/trailing.", "safe/trailing ", "safe/a:b", "x".repeat(256)])(
    "rejects nonportable rendered path %s", (value) => {
      expectTemplateError(() => assertSafeWorkPathOutput(value));
    },
  );

  it("reports missing render variables as template_invalid", () => {
    expectTemplateError(() => compileWorkspacePathTemplate("{{segment source.repository}}")({}));
  });

  it("rejects a provider namespace not extracted by the matched trigger", () => {
    expectTemplateError(() => validateWorkPathTemplateVariables("{{segment gitlab.project}}", undefined, ["github"]));
    expectTemplateError(() => validateWorkPathTemplateVariables("{{segment git.repository}}", undefined, ["p4"]));
  });
});

describe("default/hash/lower helpers", () => {
  it("default falls back only for null/undefined/empty string, never 0/false", () => {
    expect(pathTemplateDefault(null, "unscoped")).toBe("unscoped");
    expect(pathTemplateDefault(undefined, "unscoped")).toBe("unscoped");
    expect(pathTemplateDefault("", "unscoped")).toBe("unscoped");
    expect(pathTemplateDefault(0, "unscoped")).toBe(0);
    expect(pathTemplateDefault(false, "unscoped")).toBe(false);
    expect(pathTemplateDefault("main", "unscoped")).toBe("main");
  });

  it("hash returns the full sha256 hex and rejects null", () => {
    expect(pathTemplateHash("project")).toMatch(/^[0-9a-f]{64}$/u);
    expect(pathTemplateHash("project")).toBe(pathTemplateHash("project"));
    expect(pathTemplateHash("1")).not.toBe(pathTemplateHash(1));
    expectTemplateError(() => pathTemplateHash(null));
  });

  it("lower lowercases display text and rejects null", () => {
    expect(pathTemplateLower("Owner/REPO")).toBe("owner/repo");
    expectTemplateError(() => pathTemplateLower(null));
  });
});

describe("compileWorkspacePathTemplate AST whitelist", () => {
  it("compiles whitelisted templates", () => {
    const render = compileWorkspacePathTemplate("{{segment trigger.name}}/{{segment (default git.branch \"unscoped\")}}/{{workspace.id}}");
    const output = render({
      trigger: { name: "gitea-main" },
      git: { branch: "Feature/X" },
      workspace: { id: "engine", instance_id: "abc" },
    });
    expect(output).toMatch(/^gitea-main\/Feature_x2F_X~[0-9a-f]{12}\/engine$/u);
  });

  it("lower composes inside segment for display-only casing", () => {
    const render = compileWorkspacePathTemplate("{{segment (lower git.branch)}}");
    expect(render({ git: { branch: "Feature/ABC" } })).toMatch(/^feature_x2F_abc~[0-9a-f]{12}$/u);
  });

  it("renders hash output", () => {
    const render = compileWorkspacePathTemplate("project/{{hash source.project_key}}");
    expect(render({ source: { project_key: "git:host:o/r" } })).toMatch(/^project\/[0-9a-f]{64}$/u);
  });

  it.each([
    ["{{#if x}}y{{/if}}", "block"],
    ["{{> partial}}", "Partial"],
    ["{{!-- comment --}}", "Comment"],
    ["{{lookup obj key}}", "lookup"],
    ["{{log value}}", "log"],
    ["{{@index}}", "@data"],
    ["{{../value}}", "../"],
    ["{{segment constructor}}", "prototype"],
    ["{{segment __proto__}}", "prototype"],
    ["{{segment this}}", "this"],
    ["{{unknown value}}", "Unknown helper"],
    ["{{git.branch}}", "segment/hash"],
    ["{{lower git.branch}}", "segment"],
    ["{{default (lower git.branch) \"x\"}}", "segment"],
  ])("rejects %s (%s)", (source, fragment) => {
    expectTemplateError(() => compileWorkspacePathTemplate(source), fragment);
  });

  it("allows direct output of the fixed safe variables only", () => {
    expect(compileWorkspacePathTemplate("{{workspace.id}}/{{workspace.instance_id}}")({
      workspace: { id: "a", instance_id: "b" },
    })).toBe("a/b");
  });

  it("enforces source byte, node, and depth budgets", () => {
    expectTemplateError(() => compileWorkspacePathTemplate("x".repeat(4097)));
    expectTemplateError(() => compileWorkspacePathTemplate(Array.from({ length: 260 }, (_, i) => `{{workspace.id}}c${i}`).join("")));
    let deep = "git.branch";
    for (let i = 0; i < 10; i += 1) {
      deep = `(default ${deep} "x")`;
    }
    expectTemplateError(() => compileWorkspacePathTemplate(`{{segment ${deep}}}`), "depth");
  });

  it("rejects template syntax errors", () => {
    expectTemplateError(() => compileWorkspacePathTemplate("{{segment git.branch"));
  });
});

describe("render output validation", () => {
  it.each([
    ["plain/relative", "plain/relative"],
    ["a/b/c", "a/b/c"],
  ])("accepts %s", (input, expected) => {
    expect(assertSafeWorkPathOutput(input)).toBe(expected);
  });

  it.each([
    "",
    "/absolute/path",
    "C:/windows/path",
    "c:relative",
    "\\\\unc\\share",
    "back\\slash",
    "50%encoded",
    "a//b",
    "a/./b",
    "a/../b",
    "~/home",
    "nul\0byte",
  ])("rejects %j", (input) => {
    expectTemplateError(() => assertSafeWorkPathOutput(input));
  });

  it("render-time output is validated even for safe-looking templates", () => {
    const render = compileWorkspacePathTemplate("{{workspace.id}}/{{workspace.instance_id}}");
    expectTemplateError(() => render({ workspace: { id: "a", instance_id: ".." } }));
  });
});

function registryResolve(triggerKind: string, repoRef: string, event?: Parameters<typeof resolveWorkspaceForSource>[5]): PathTemplateVariables {
  const triggerName = `${triggerKind}-t`;
  const config = {
    triggers: [{ name: triggerName, kind: triggerKind }],
    workspaces: {
      instances: {
        ws: { match: [{ triggers: [triggerName], source: { repo_ref: { glob: "*" } } }] },
      },
    },
  };
  const vcs = triggerKind === "p4" ? "p4" : triggerKind === "svn" ? "svn" : "git";
  const result = resolveWorkspaceForSource(
    config,
    compileWorkspaceMatchDefinitions(config),
    triggerName,
    { vcs, repo_ref: repoRef },
    event,
  );
  if (result.kind !== "match") {
    throw new Error(`expected match for ${triggerKind}, got ${result.kind}`);
  }
  return result.variables;
}

function registryGet(variables: PathTemplateVariables, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) => (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
      variables,
    );
}

describe("variable registry (V11/V13)", () => {
  it("registers each path exactly once, well-formed", () => {
    const paths = WORK_PATH_TEMPLATE_VARIABLES.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path).toMatch(/^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/u);
    }
  });

  it("marks scheduled.* unavailable with the missing-engine note (V11)", () => {
    const scheduled = WORK_PATH_TEMPLATE_VARIABLES.filter((entry) => entry.path.startsWith("scheduled."));
    expect(scheduled.length).toBeGreaterThanOrEqual(4);
    for (const entry of scheduled) {
      expect(entry.availability).toBe("unavailable");
      expect(entry.note).toBeDefined();
    }
    // Every unavailable entry tells the UI why; none is silently listed.
    for (const entry of WORK_PATH_TEMPLATE_VARIABLES.filter((item) => item.availability === "unavailable")) {
      expect(entry.note).toBeDefined();
    }
  });

  it("every extracted variable is produced by a real resolution fixture", () => {
    const fixtures: Record<string, () => PathTemplateVariables> = {
      github: () => registryResolve("github", "acme/service", { base_branch: "main", head_branch: "feature" }),
      gitea: () => registryResolve("gitea", "acme/service", { base_branch: "main", head_branch: "feature" }),
      forgejo: () => registryResolve("forgejo", "acme/service", { base_branch: "main", head_branch: "feature" }),
      gitlab: () => registryResolve("gitlab", "group/sub/project", { base_branch: "main", head_branch: "feature" }),
      p4: () => registryResolve("p4", "//depot/project"),
      svn: () => registryResolve("svn", "https://svn.example/project"),
    };
    for (const entry of WORK_PATH_TEMPLATE_VARIABLES) {
      if (entry.availability !== "extracted") {
        continue;
      }
      const namespace = entry.path.split(".")[0]!;
      const fixtureKey = namespace in fixtures ? namespace : "github";
      const variables = fixtures[fixtureKey]!();
      expect(
        registryGet(variables, entry.path),
        `extracted variable ${entry.path} must be present (namespace ${namespace})`,
      ).not.toBeUndefined();
    }
  });

  it("nullable extracted variables are null, never missing keys (boundary fixture)", () => {
    const variables = registryResolve("github", "single-repo");
    const nullable = WORK_PATH_TEMPLATE_VARIABLES.filter(
      (entry) => entry.availability === "extracted" && entry.nullable,
    );
    for (const entry of nullable) {
      const namespace = entry.path.split(".")[0]!;
      if (["gitea", "forgejo", "gitlab", "p4", "svn"].includes(namespace)) {
        continue; // namespace absent on a github fixture by design (V04)
      }
      expect(
        registryGet(variables, entry.path),
        `nullable variable ${entry.path} must be null, not undefined`,
      ).not.toBeUndefined();
    }
    // Spot-check the actual nulls for fields the fixture cannot know.
    expect(registryGet(variables, "git.branch")).toBeNull();
    expect(registryGet(variables, "git.namespace")).toBeNull();
    expect(registryGet(variables, "manual.request_id")).toBeNull();
  });

  it("rejects unknown variables and namespaces at publish validation (V12)", () => {
    // Unknown field under a known root names the root in the error.
    expectTemplateError(
      () => validateWorkPathTemplateVariables("{{segment git.bogus_field}}"),
      'Unknown work_path variable "git.bogus_field"',
    );
    // Unknown root namespace.
    expectTemplateError(
      () => validateWorkPathTemplateVariables("{{segment vcs.host}}"),
      'Unknown work_path variable "vcs.host"',
    );
    // Deep typo under a provider namespace is equally rejected.
    expectTemplateError(
      () => validateWorkPathTemplateVariables("{{segment github.fullname}}"),
      "github.fullname",
    );
  });

  it("rejects registered-but-unavailable and forbidden variables at publish validation (V12)", () => {
    // scheduled.* is listed in the descriptor registry (V11) but extraction
    // has no engine yet — publish must fail, not silently render empty.
    expectTemplateError(
      () => validateWorkPathTemplateVariables("{{segment scheduled.job_id}}"),
      "not yet extracted",
    );
    // event.* is forbidden in work_path by contract.
    expectTemplateError(
      () => validateWorkPathTemplateVariables("{{segment event.name}}"),
      "must not use",
    );
  });

  it("event.* variables stay forbidden in work_path templates", () => {
    for (const path of ["event.provider", "event.name", "event.head_revision"]) {
      expectTemplateError(() => compileWorkspacePathTemplate(`{{${path}}}`));
    }
  });
});
