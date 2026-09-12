import { describe, expect, it } from "vitest";

import {
  CONFIG_MATCHER_LIMITS,
  ConfigError,
  compileConfigMatcher,
  compileWorkspaceMatchSource,
  globToConfigRegexSource,
  validateWorkspaceMatchSource,
  workspaceMatchExpressionBytes,
  type ConfigMatcher,
} from "../src/index.js";

function expectMatcherError(fn: () => unknown, fragment?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe("matcher_invalid");
    if (fragment !== undefined) {
      expect((error as ConfigError).message).toContain(fragment);
    }
    return;
  }
  throw new Error("expected matcher_invalid ConfigError");
}

describe("globToConfigRegexSource", () => {
  it("translates full-field glob semantics (spec §5.1)", () => {
    expect(globToConfigRegexSource("*.ts")).toBe("^(?:[\\s\\S]*\\.ts)$");
    expect(globToConfigRegexSource("a?c")).toBe("^(?:a[\\s\\S]c)$");
    expect(globToConfigRegexSource("a/b")).toBe("^(?:a/b)$");
    // Consecutive stars collapse; star crosses `/`.
    expect(globToConfigRegexSource("a**b")).toBe("^(?:a[\\s\\S]*b)$");
  });
});

describe("compileConfigMatcher", () => {
  it("exact is case-sensitive plain equality", () => {
    const matcher = compileConfigMatcher({ exact: "Owner/Repo" });
    expect(matcher("Owner/Repo")).toBe(true);
    expect(matcher("owner/repo")).toBe(false);
    expect(matcher("Owner/Repo2")).toBe(false);
  });

  it("glob matches the entire field and * crosses slashes", () => {
    const matcher = compileConfigMatcher({ glob: "//Engine/*" });
    expect(matcher("//Engine/Core")).toBe(true);
    expect(matcher("//Engine/Tools/Deep")).toBe(true);
    expect(matcher("x//Engine/Core")).toBe(false);
    expect(matcher("//Other")).toBe(false);
  });

  it("glob ? matches exactly one code point", () => {
    const matcher = compileConfigMatcher({ glob: "v?.0" });
    expect(matcher("v1.0")).toBe(true);
    expect(matcher("v12.0")).toBe(false);
    expect(matcher("v.0")).toBe(false);
  });

  it("glob has no extglob/brace/character-class semantics", () => {
    expect(compileConfigMatcher({ glob: "a[bc]" })("a[bc]")).toBe(true);
    expect(compileConfigMatcher({ glob: "a[bc]" })("ab")).toBe(false);
    expect(compileConfigMatcher({ glob: "a{b,c}" })("a{b,c}")).toBe(true);
    expect(compileConfigMatcher({ glob: "a{b,c}" })("ab")).toBe(false);
  });

  it("glob ignore_case folds case only for matching", () => {
    const matcher = compileConfigMatcher({ glob: "owner/*", ignore_case: true });
    expect(matcher("OWNER/Repo")).toBe(true);
    expect(matcher("other/x")).toBe(false);
  });

  it("regex ignore_case folds case only for matching (W05)", () => {
    const matcher = compileConfigMatcher({ regex: "^Eng", ignore_case: true });
    expect(matcher("ENG-main")).toBe(true);
    expect(matcher("x-eng")).toBe(false);
  });

  it("regex uses RE2 substring semantics", () => {
    const matcher = compileConfigMatcher({ regex: "eng.*core" });
    expect(matcher("x-engine-core-y")).toBe(true);
    expect(matcher("engine")).toBe(false);
    const anchored = compileConfigMatcher({ regex: "^eng$" });
    expect(anchored("eng")).toBe(true);
    expect(anchored("engine")).toBe(false);
  });

  it("rejects RE2-unsupported constructs instead of falling back", () => {
    expectMatcherError(() => compileConfigMatcher({ regex: "(?=lookahead)" }));
    expectMatcherError(() => compileConfigMatcher({ regex: "(backref)\\1" }));
    expectMatcherError(() => compileConfigMatcher({ regex: "(unclosed" }));
  });
});

describe("validateWorkspaceMatchSource", () => {
  it("accepts the documented source fields and returns typed matchers", () => {
    const result = validateWorkspaceMatchSource({
      vcs: { exact: "git" },
      repo_ref: { glob: "owner/*", ignore_case: true },
      project_key: { regex: "^git:host:owner/repo$" },
    });
    expect(Object.keys(result).sort()).toEqual(["project_key", "repo_ref", "vcs"]);
  });

  it("rejects unknown source fields with the allowlist in the message", () => {
    expectMatcherError(() => validateWorkspaceMatchSource({ payload_hint: { exact: "x" } }), "payload_hint");
  });

  it("rejects matcher shape violations and oversized expressions", () => {
    expectMatcherError(() => validateWorkspaceMatchSource({ vcs: { exact: "a", glob: "b" } }));
    expectMatcherError(() =>
      validateWorkspaceMatchSource({ vcs: { exact: "x".repeat(CONFIG_MATCHER_LIMITS.maxExpressionBytes + 1) } }),
    );
  });

  it("enforces the per-expression byte budget via the matcher contract", () => {
    expectMatcherError(() =>
      validateWorkspaceMatchSource({ vcs: { exact: "x".repeat(CONFIG_MATCHER_LIMITS.maxExpressionBytes + 1) } }),
    );
  });

  it("passes exactly at the per-expression byte budget and counts UTF-8 bytes, not code points (W06)", () => {
    // Exactly at the limit passes.
    expect(
      validateWorkspaceMatchSource({ vcs: { exact: "x".repeat(CONFIG_MATCHER_LIMITS.maxExpressionBytes) } }),
    ).toEqual({ vcs: { exact: "x".repeat(CONFIG_MATCHER_LIMITS.maxExpressionBytes) } });
    // 512 × "é" = 1024 bytes: passes despite being 512 code points…
    expect(
      validateWorkspaceMatchSource({ vcs: { exact: "é".repeat(512) } }),
    ).toEqual({ vcs: { exact: "é".repeat(512) } });
    // …but 513 × "é" = 1026 bytes exceeds the 1024-byte budget at 513 code points.
    expectMatcherError(() => validateWorkspaceMatchSource({ vcs: { exact: "é".repeat(513) } }));
  });

  it("accounts total expression bytes across a definition's rules", () => {
    const rules = [
      { source: { vcs: { exact: "x".repeat(600) } as ConfigMatcher } },
      { source: { repo_ref: { glob: "y".repeat(700) } as ConfigMatcher } },
    ];
    expect(workspaceMatchExpressionBytes(rules)).toBe(1300);
  });

  it("compiles every expression at validation time", () => {
    expectMatcherError(() => validateWorkspaceMatchSource({ vcs: { regex: "(?=x)" } }));
  });
});

describe("compileWorkspaceMatchSource", () => {
  it("ANDs fields and treats missing values as no-match", () => {
    const test = compileWorkspaceMatchSource(
      validateWorkspaceMatchSource({
        vcs: { exact: "git" },
        repo_ref: { glob: "owner/*" },
      }),
    );
    expect(test({ vcs: "git", repo_ref: "owner/repo" })).toBe(true);
    expect(test({ vcs: "git", repo_ref: "other/repo" })).toBe(false);
    expect(test({ vcs: "git" })).toBe(false);
    expect(test({ vcs: "git", repo_ref: null })).toBe(false);
    expect(test({})).toBe(false);
  });
});
