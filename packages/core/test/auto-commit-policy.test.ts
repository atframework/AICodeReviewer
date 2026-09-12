import { describe, expect, it } from "vitest";

import {
  compileExclusionRules,
  decideExclusion,
  type ExclusionRuleConfig,
} from "../src/auto-commit-exclusion.js";
import {
  computeMemberId,
  computeSourceKey,
  computeStreamId,
  deriveSourceKey,
} from "../src/auto-commit-identity.js";
import {
  AUTO_COMMIT_DEFAULT_DELAY_SECONDS,
  autoCommitConfigSchema,
  resolveAutoCommitPolicy,
  type AutoCommitConfig,
} from "../src/auto-commit-policy.js";
import { appConfigSchema } from "../src/config.js";

function policy(
  global?: AutoCommitConfig,
  defaults?: AutoCommitConfig,
  instance?: AutoCommitConfig,
) {
  return resolveAutoCommitPolicy(global, defaults, instance);
}

const FULL_TIME_SCHEDULE = {
  timezone: "Asia/Shanghai",
  rules: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      windows: [
        { start: "18:00", end: "24:00" },
        { start: "00:00", end: "13:00" },
      ],
    },
    { days: ["sat", "sun"], windows: [{ start: "00:00", end: "24:00" }] },
  ],
} as const;

describe("layered resolution (C01–C04)", () => {
  it("applies built-in defaults when every layer is absent (C01)", () => {
    const resolved = policy(undefined, undefined, undefined);
    expect(resolved.delaySeconds).toBe(AUTO_COMMIT_DEFAULT_DELAY_SECONDS);
    expect(resolved.schedule.unrestricted).toBe(true);
    expect(resolved.schedule.timezone).toBe("UTC");
    expect(resolved.exclusions.rules).toHaveLength(0);
  });

  it("prefers instance over defaults over global for delay (C02)", () => {
    expect(
      policy({ delay_seconds: 300 }, { delay_seconds: 180 }, { delay_seconds: 0 }).delaySeconds,
    ).toBe(0);
    expect(policy({ delay_seconds: 300 }, { delay_seconds: 180 }).delaySeconds).toBe(180);
    expect(policy({ delay_seconds: 300 }).delaySeconds).toBe(300);
  });

  it("does not reset an inherited delay when a layer sets only schedule (C02)", () => {
    const resolved = policy(
      { delay_seconds: 300 },
      undefined,
      { schedule: { timezone: "UTC", rules: [] } },
    );
    expect(resolved.delaySeconds).toBe(300);
    expect(resolved.schedule.unrestricted).toBe(true);
  });

  it("inherits the complete schedule when a lower layer sets only delay (C03)", () => {
    const resolved = policy(
      { schedule: FULL_TIME_SCHEDULE },
      undefined,
      { delay_seconds: 5 },
    );
    expect(resolved.delaySeconds).toBe(5);
    expect(resolved.schedule.timezone).toBe("Asia/Shanghai");
    expect(resolved.schedule.unrestricted).toBe(false);
    expect(resolved.schedule.intervalsByDay[6]?.length).toBeGreaterThan(0);
  });

  it("replaces schedule wholesale per layer and never merges across layers (C04)", () => {
    const instanceSchedule = {
      timezone: "Asia/Shanghai",
      rules: [
        {
          days: ["mon", "tue", "wed", "thu", "fri"],
          windows: [{ start: "23:00", end: "07:00" }],
        },
      ],
    } as const;
    const resolved = policy(
      { schedule: { timezone: "UTC", rules: [] } },
      undefined,
      { schedule: instanceSchedule },
    );
    // Instance timezone + rule group must not combine with the global rules: [].
    expect(resolved.schedule.unrestricted).toBe(false);
    expect(resolved.schedule.intervalsByDay[5]).toHaveLength(0); // no sat windows
    expect(resolved.schedule.intervalsByDay[4]).toHaveLength(1); // fri 23:00–07:00
  });

  it("treats explicit rules: [] as lifting all weekly limits (C04)", () => {
    const resolved = policy(
      { schedule: FULL_TIME_SCHEDULE },
      undefined,
      { schedule: { timezone: "UTC", rules: [] } },
    );
    expect(resolved.schedule.unrestricted).toBe(true);
  });

  it("keeps exclusion rules when a layer changes only delay (X01)", () => {
    const rule = {
      id: "bots",
      vcs: "git",
      match: { author_email: { glob: "*-bot@example.com" } },
    } as const;
    const resolved = policy(
      { exclude_sources: [rule] },
      undefined,
      { delay_seconds: 0 },
    );
    expect(resolved.exclusions.rules).toHaveLength(1);
  });

  it("clears inherited exclusions with an explicit empty array (X01)", () => {
    const rule = {
      id: "bots",
      vcs: "git",
      match: { author_email: { glob: "*-bot@example.com" } },
    } as const;
    const resolved = policy({ exclude_sources: [rule] }, undefined, { exclude_sources: [] });
    expect(resolved.exclusions.rules).toHaveLength(0);
  });

  it("resolves include_branches nearest-first with no cross-layer merge", () => {
    expect(policy(undefined, undefined, undefined).includeBranches).toBeUndefined();
    expect(policy({ include_branches: ["main"] }).includeBranches).toEqual(["main"]);
    expect(
      policy({ include_branches: ["main"] }, { include_branches: ["dev"] }).includeBranches,
    ).toEqual(["dev"]);
    expect(
      policy(
        { include_branches: ["main"] },
        { include_branches: ["dev"] },
        { include_branches: ["release/1.x"] },
      ).includeBranches,
    ).toEqual(["release/1.x"]);
  });

  it("clears an inherited branch allowlist with an explicit empty array", () => {
    const resolved = policy(
      { include_branches: ["main"] },
      { include_branches: ["dev"] },
      { include_branches: [] },
    );
    expect(resolved.includeBranches).toBeUndefined();
  });

  it("keeps policyVersion stable when only include_branches changes", () => {
    const a = policy(undefined, undefined, undefined);
    const b = policy({ include_branches: ["main"] }, undefined, undefined);
    expect(a.policyVersion).toBe(b.policyVersion);
  });

  it("preserves inherited branch filtering when an instance only overrides delay or schedule", () => {
    const resolved = policy(
      { include_branches: ["main"] },
      { include_branches: ["release/1.x"], delay_seconds: 25 },
      { schedule: { rules: [] } },
    );
    expect(resolved.includeBranches).toEqual(["release/1.x"]);
    expect(resolved.delaySeconds).toBe(25);
    expect(resolved.schedule.unrestricted).toBe(true);
    expect(policy(
      { include_branches: ["main"] },
      { include_branches: [] },
      { delay_seconds: 0 },
    ).includeBranches).toBeUndefined();
  });

  it("changes policyVersion when the effective exclusion set changes", () => {
    const rule = {
      id: "bots",
      vcs: "git",
      match: { author_email: { glob: "*-bot@example.com" } },
    } as const;
    const a = policy(undefined, undefined, undefined);
    const b = policy({ exclude_sources: [rule] }, undefined, undefined);
    const c = policy({ exclude_sources: [rule] }, undefined, undefined);
    expect(a.policyVersion).not.toBe(b.policyVersion);
    expect(b.policyVersion).toBe(c.policyVersion);
  });
});

describe("schema validation (C05/C06/C09/C10)", () => {
  it("rejects invalid delay values (C05)", () => {
    for (const delay of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 31_536_001]) {
      expect(autoCommitConfigSchema.safeParse({ delay_seconds: delay }).success).toBe(false);
    }
    expect(autoCommitConfigSchema.safeParse({ delay_seconds: 0 }).success).toBe(true);
    expect(autoCommitConfigSchema.safeParse({ delay_seconds: 31_536_000 }).success).toBe(true);
  });

  it("rejects invalid timezone and unknown subfields with paths (C05)", () => {
    const badZone = autoCommitConfigSchema.safeParse({
      schedule: { timezone: "Not/AZone", rules: [] },
    });
    expect(badZone.success).toBe(false);
    expect(JSON.stringify(badZone)).toContain("IANA timezone");

    const unknownField = autoCommitConfigSchema.safeParse({ delay_seconds: 1, burst: 2 });
    expect(unknownField.success).toBe(false);
  });

  it("rejects the superseded flat schedule.windows draft shape (C10)", () => {
    const flat = autoCommitConfigSchema.safeParse({
      schedule: { timezone: "UTC", windows: [{ start: "00:00", end: "24:00" }] },
    });
    expect(flat.success).toBe(false);
    // rules is required inside an explicit schedule.
    expect(autoCommitConfigSchema.safeParse({ schedule: { timezone: "UTC" } }).success).toBe(
      false,
    );
  });

  it("rejects empty in-group arrays and bad weekday enums (C09/C10)", () => {
    expect(
      autoCommitConfigSchema.safeParse({
        schedule: { rules: [{ days: [], windows: [{ start: "00:00", end: "24:00" }] }] },
      }).success,
    ).toBe(false);
    expect(
      autoCommitConfigSchema.safeParse({
        schedule: { rules: [{ days: ["mon"], windows: [] }] },
      }).success,
    ).toBe(false);
    expect(
      autoCommitConfigSchema.safeParse({
        schedule: { rules: [{ days: ["Mon"], windows: [{ start: "00:00", end: "24:00" }] }] },
      }).success,
    ).toBe(false);
    expect(
      autoCommitConfigSchema.safeParse({
        schedule: { rules: [{ days: [1], windows: [{ start: "00:00", end: "24:00" }] }] },
      }).success,
    ).toBe(false);
  });

  it("validates include_branches entries (B01)", () => {
    expect(autoCommitConfigSchema.safeParse({ include_branches: ["main"] }).success).toBe(true);
    expect(autoCommitConfigSchema.safeParse({ include_branches: [] }).success).toBe(true);
    expect(autoCommitConfigSchema.safeParse({ include_branches: [""] }).success).toBe(false);
    expect(autoCommitConfigSchema.safeParse({ include_branches: "main" }).success).toBe(false);
    expect(autoCommitConfigSchema.safeParse({ include_branches: [1] }).success).toBe(false);
  });

  it("parses auto_commit at all three config layers (C01 surface)", () => {
    const parsed = appConfigSchema.parse({
      review: { auto_commit: { delay_seconds: 300 } },
      workspaces: {
        defaults: { review: { auto_commit: { delay_seconds: 180 } } },
        instances: {
          game: { review: { auto_commit: { delay_seconds: 120 } } },
        },
      },
    });
    expect(parsed.review.auto_commit?.delay_seconds).toBe(300);
    expect(parsed.workspaces.defaults.review?.auto_commit?.delay_seconds).toBe(180);
    expect(parsed.workspaces.instances.game?.review?.auto_commit?.delay_seconds).toBe(120);
  });

  it("parses include_branches through the app config surface (B01 surface)", () => {
    const parsed = appConfigSchema.parse({
      workspaces: {
        instances: {
          game: { review: { auto_commit: { include_branches: ["main", "release/1.x"] } } },
        },
      },
    });
    expect(parsed.workspaces.instances.game?.review?.auto_commit?.include_branches).toEqual([
      "main",
      "release/1.x",
    ]);
  });
});

describe("exclusion rule schema (X02/X06)", () => {
  it("rejects wrong-vcs fields, empty match, duplicate ids, empty patterns, glob+regex (X02)", () => {
    const cases: unknown[] = [
      [{ id: "a", vcs: "svn", match: { author_email: { glob: "x" } } }],
      [{ id: "a", vcs: "git", match: {} }],
      [
        { id: "a", vcs: "git", match: { author_name: { glob: "x" } } },
        { id: "a", vcs: "git", match: { author_name: { glob: "y" } } },
      ],
      [{ id: "a", vcs: "git", match: { author_name: { glob: "" } } }],
      [{ id: "a", vcs: "git", match: { author_name: { glob: "x", regex: "y" } } }],
      [{ id: "a", vcs: "git", match: { author_name: { glob: "x", depth: 1 } } }],
      [{ id: "bad id!", vcs: "git", match: { author_name: { glob: "x" } } }],
    ];
    for (const exclude of cases) {
      expect(
        autoCommitConfigSchema.safeParse({ exclude_sources: exclude }).success,
        JSON.stringify(exclude),
      ).toBe(false);
    }
  });

  it("rejects invalid regex, lookaround, and backreferences at config stage (X06)", () => {
    for (const pattern of ["(", "a(?=b)", "(?<=a)b", "(a)\\1"]) {
      const parsed = autoCommitConfigSchema.safeParse({
        exclude_sources: [
          { id: "r", vcs: "git", match: { author_name: { regex: pattern } } },
        ],
      });
      expect(parsed.success, pattern).toBe(false);
    }
    // Bounded RE2 quantifiers and Unicode classes are accepted.
    expect(
      autoCommitConfigSchema.safeParse({
        exclude_sources: [
          { id: "r", vcs: "git", match: { author_name: { regex: "^(?:ci|build)-[\\p{L}]{1,64}$" } } },
        ],
      }).success,
    ).toBe(true);
  });

  it("enforces rule count and pattern byte budgets (X02)", () => {
    const many = Array.from({ length: 129 }, (_, i) => ({
      id: `r${i}`,
      vcs: "git",
      match: { author_name: { glob: "x" } },
    }));
    expect(autoCommitConfigSchema.safeParse({ exclude_sources: many }).success).toBe(false);

    const longPattern = {
      id: "r",
      vcs: "git",
      match: { author_name: { glob: `*${"x".repeat(1024)}` } },
    };
    expect(autoCommitConfigSchema.safeParse({ exclude_sources: [longPattern] }).success).toBe(
      false,
    );
  });
});

describe("exclusion decision semantics (X03/X04/X05/X11/X12)", () => {
  function decide(
    rules: readonly ExclusionRuleConfig[],
    vcs: "git" | "p4" | "svn",
    fields: Parameters<typeof decideExclusion>[2],
  ) {
    return decideExclusion(compileExclusionRules(rules), vcs, fields);
  }

  const known = (value: string) => ({ status: "known" as const, value });

  it("ANDs conditions inside one rule and ORs across rules; order does not matter (X03)", () => {
    const rules: ExclusionRuleConfig[] = [
      { id: "and", vcs: "p4", match: { user: { glob: "svc-*" }, client: { glob: "nightly-*" } } },
      { id: "or-user", vcs: "p4", match: { user: { glob: "ci" } } },
      { id: "or-client", vcs: "p4", match: { client: { glob: "build-*" } } },
    ];
    expect(
      decide(rules, "p4", { user: known("svc-tools"), client: known("nightly-1") }),
    ).toEqual({ kind: "excluded", ruleId: "and" });
    // Same user, other client: the AND rule must not fire.
    expect(decide(rules, "p4", { user: known("svc-tools"), client: known("dev-1") })).toEqual({
      kind: "allowed",
    });
    expect(decide(rules, "p4", { user: known("ci"), client: known("dev-1") })).toEqual({
      kind: "excluded",
      ruleId: "or-user",
    });
    expect(decide(rules, "p4", { user: known("alice"), client: known("build-7") })).toEqual({
      kind: "excluded",
      ruleId: "or-client",
    });
    // Reordered rules give the same verdicts.
    const reordered = [...rules].reverse();
    expect(decide(reordered, "p4", { user: known("ci"), client: known("build-7") }).kind).toBe(
      "excluded",
    );
  });

  it("matches globs against the whole field with code-point semantics (X04)", () => {
    const rules: ExclusionRuleConfig[] = [
      { id: "g", vcs: "git", match: { author_name: { glob: "A?e*" } } },
    ];
    // Whole-string: substring does not match.
    expect(decide(rules, "git", { author_name: known("xAxe-lot") }).kind).toBe("allowed");
    // ? is exactly one code point (not one UTF-16 unit).
    expect(decide(rules, "git", { author_name: known("A⚙e-1") }).kind).toBe("excluded");
    expect(decide(rules, "git", { author_name: known("Abe-9") }).kind).toBe("excluded");
    expect(decide(rules, "git", { author_name: known("Abbe-9") }).kind).toBe("allowed");
  });

  it("treats dots, brackets, slashes, backslashes, and CJK literally in globs (X04)", () => {
    const rules: ExclusionRuleConfig[] = [
      { id: "lit", vcs: "svn", match: { author: { glob: "DOMAIN\\svc.[bot]/cn-提交" } } },
    ];
    expect(decide(rules, "svn", { author: known("DOMAIN\\svc.[bot]/cn-提交") }).kind).toBe(
      "excluded",
    );
    // The dot must not act as a regex wildcard.
    expect(decide(rules, "svn", { author: known("DOMAIN\\svcX[bot]/cn-提交") }).kind).toBe(
      "allowed",
    );
    // ** collapses to *.
    const stars: ExclusionRuleConfig[] = [
      { id: "s", vcs: "svn", match: { author: { glob: "a**b" } } },
    ];
    expect(decide(stars, "svn", { author: known("aXXb") }).kind).toBe("excluded");
    expect(decide(stars, "svn", { author: known("ab") }).kind).toBe("excluded");
  });

  it("runs regex as substring search with opt-in anchors and ignore_case (X05)", () => {
    const substring: ExclusionRuleConfig[] = [
      { id: "r", vcs: "git", match: { author_email: { regex: "bot" } } },
    ];
    expect(decide(substring, "git", { author_email: known("ci-bot@x.dev") }).kind).toBe(
      "excluded",
    );
    const anchored: ExclusionRuleConfig[] = [
      { id: "r", vcs: "git", match: { author_email: { regex: "^bot$" } } },
    ];
    expect(decide(anchored, "git", { author_email: known("ci-bot@x.dev") }).kind).toBe(
      "allowed",
    );
    const folded: ExclusionRuleConfig[] = [
      { id: "r", vcs: "git", match: { author_email: { regex: "^BOT$", ignore_case: true } } },
    ];
    expect(decide(folded, "git", { author_email: known("bOt") }).kind).toBe("excluded");
    const sensitive: ExclusionRuleConfig[] = [
      { id: "r", vcs: "git", match: { author_email: { regex: "^BOT$", ignore_case: false } } },
    ];
    expect(decide(sensitive, "git", { author_email: known("bOt") }).kind).toBe("allowed");
    // Matcher instances are stateless across repeated calls.
    const policy = compileExclusionRules(folded);
    expect(decideExclusion(policy, "git", { author_email: known("bot") }).kind).toBe("excluded");
    expect(decideExclusion(policy, "git", { author_email: known("nobody") }).kind).toBe(
      "allowed",
    );
    expect(decideExclusion(policy, "git", { author_email: known("BOT") }).kind).toBe("excluded");
  });

  it("applies three-state unknown handling (X11)", () => {
    const twoConditions: ExclusionRuleConfig[] = [
      { id: "both", vcs: "p4", match: { user: { glob: "ci" }, client: { glob: "nightly-*" } } },
    ];
    // false + unknown → the rule is defeated → allowed.
    expect(
      decide(twoConditions, "p4", { user: known("alice"), client: { status: "unavailable" } })
        .kind,
    ).toBe("allowed");
    // true + unknown → unknown.
    expect(
      decide(twoConditions, "p4", { user: known("ci"), client: { status: "unavailable" } }).kind,
    ).toBe("unknown");
    // No applicable rules (other vcs) → allowed, never unknown.
    expect(decide(twoConditions, "git", {}).kind).toBe("allowed");
    // All conditions known and false → allowed.
    expect(
      decide(twoConditions, "p4", { user: known("alice"), client: known("dev-1") }).kind,
    ).toBe("allowed");
    // Conflicted field behaves as unknown, not as no_match (X12).
    expect(
      decide(twoConditions, "p4", {
        user: known("ci"),
        client: { status: "conflicted", value: "nightly-1", previousValue: "nightly-2" },
      }).kind,
    ).toBe("unknown");
  });

  it("treats over-budget fields as unavailable instead of truncating (X12)", () => {
    const rules: ExclusionRuleConfig[] = [
      { id: "r", vcs: "git", match: { author_name: { glob: "*" } } },
    ];
    const longValue = `prefix-${"x".repeat(5000)}`;
    const decision = decide(rules, "git", { author_name: known(longValue) });
    expect(decision.kind).toBe("unknown");
  });
});

describe("structured identity keys (I01)", () => {
  const streamBase = {
    workspaceId: "ws",
    triggerName: "gitea",
    vcs: "git" as const,
    sourceNamespace: "https://git.example.com/org/repo",
    scopeRef: "refs/heads/main",
    historyGeneration: 0,
  };

  it("is deterministic and collision-safe against separator injection", () => {
    const a = computeStreamId({ ...streamBase, scopeRef: "refs/heads/a|b" });
    const b = computeStreamId({ ...streamBase, scopeRef: "refs/heads/a", sourceNamespace: "b" });
    const c = computeStreamId({ ...streamBase, scopeRef: "refs/heads/a|b" });
    expect(a).not.toBe(b);
    expect(a).toBe(c);
    expect(computeMemberId(a, "deadbeef")).not.toBe(computeMemberId(a, "deadbee|f"));
  });

  it("distinguishes visually similar unicode and whitespace variants exactly", () => {
    const ns = "https://git.example.com/org/repo";
    const keys = [
      { authorName: "Al ice", authorEmail: "a@x.dev" },
      { authorName: "Alice", authorEmail: "a@x.dev" },
      { authorName: "Αlice", authorEmail: "a@x.dev" }, // Greek capital alpha
      { authorName: "Alice", authorEmail: "a@x.dev " },
    ].map((fields) => computeSourceKey(ns, { vcs: "git", ...fields }));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("derives source keys only when all grouping fields are known", () => {
    const known = (value: string) => ({ status: "known" as const, value });
    expect(
      deriveSourceKey("p4", "p4.example.com:1666", {
        user: known("alice"),
        client: { status: "unavailable" },
      }),
    ).toBeNull();
    const key = deriveSourceKey("p4", "p4.example.com:1666", {
      user: known("alice"),
      client: known("task-a"),
    });
    expect(key).toBe(
      computeSourceKey("p4.example.com:1666", { vcs: "p4", user: "alice", client: "task-a" }),
    );
    expect(
      deriveSourceKey("git", "ns", { authorName: known("a"), authorEmail: { status: "conflicted" } }),
    ).toBeNull();
  });
});
