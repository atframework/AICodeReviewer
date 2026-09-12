import { describe, expect, it } from "vitest";

import { appConfigSchema } from "../src/config.js";
import { isAllowedInstant } from "../src/weekly-schedule.js";
import {
  pullRequestConfigSchema,
  resolvePullRequestSchedule,
  resolvePullRequestTargetBranches,
} from "../src/pull-request-policy.js";

const WEEKDAY_PEAK_FREE_SCHEDULE = {
  timezone: "Asia/Shanghai",
  rules: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      windows: [
        { start: "00:00", end: "13:00" },
        { start: "18:00", end: "24:00" },
      ],
    },
    { days: ["sat", "sun"], windows: [{ start: "00:00", end: "24:00" }] },
  ],
} as const;

describe("pullRequestConfigSchema", () => {
  it("accepts a full schedule with the auto_commit schedule shape", () => {
    const parsed = pullRequestConfigSchema.parse({ schedule: WEEKDAY_PEAK_FREE_SCHEDULE });
    expect(parsed.schedule?.timezone).toBe("Asia/Shanghai");
    expect(parsed.schedule?.rules).toHaveLength(2);
  });

  it("accepts an empty object and a schedule without timezone", () => {
    expect(pullRequestConfigSchema.parse({})).toEqual({});
    expect(pullRequestConfigSchema.parse({ schedule: { rules: [] } })).toEqual({
      schedule: { rules: [] },
    });
  });

  it("rejects unknown subfields and invalid windows", () => {
    expect(() => pullRequestConfigSchema.parse({ delay_seconds: 30 })).toThrow();
    expect(() =>
      pullRequestConfigSchema.parse({
        schedule: { rules: [{ days: ["mon"], windows: [{ start: "9:00", end: "10:00" }] }] },
      }),
    ).toThrow();
    expect(() =>
      pullRequestConfigSchema.parse({
        schedule: { timezone: "Mars/Olympus", rules: [] },
      }),
    ).toThrow(/invalid IANA timezone/u);
  });
  it("validates include_target_branches entries", () => {
    expect(pullRequestConfigSchema.parse({ include_target_branches: ["main"] })).toEqual({
      include_target_branches: ["main"],
    });
    expect(pullRequestConfigSchema.parse({ include_target_branches: [] })).toEqual({
      include_target_branches: [],
    });
    expect(() => pullRequestConfigSchema.parse({ include_target_branches: [""] })).toThrow();
    expect(() => pullRequestConfigSchema.parse({ include_target_branches: "main" })).toThrow();
  });
});

describe("resolvePullRequestTargetBranches", () => {
  it("resolves parsed config per field without resetting inherited schedules or other workspaces", () => {
    const config = appConfigSchema.parse({
      review: { pull_request: { include_target_branches: ["main"], schedule: WEEKDAY_PEAK_FREE_SCHEDULE } },
      workspaces: {
        defaults: { review: { pull_request: { include_target_branches: ["dev"] } } },
        instances: {
          scheduled: { review: { pull_request: { schedule: { rules: [] } } } },
          cleared: { review: { pull_request: { include_target_branches: [] } } },
          restricted: { review: { pull_request: { include_target_branches: ["release/1.x"] } } },
        },
      },
    });
    const global = config.review.pull_request;
    const defaults = config.workspaces.defaults.review?.pull_request;
    const instance = (name: string) => config.workspaces.instances[name]?.review?.pull_request;
    expect(resolvePullRequestTargetBranches(global, defaults, instance("scheduled"))).toEqual(["dev"]);
    expect(resolvePullRequestSchedule(global, defaults, instance("scheduled"))?.unrestricted).toBe(true);
    expect(resolvePullRequestTargetBranches(global, defaults, instance("cleared"))).toBeUndefined();
    expect(resolvePullRequestSchedule(global, defaults, instance("cleared"))?.timezone).toBe("Asia/Shanghai");
    expect(resolvePullRequestTargetBranches(global, defaults, instance("restricted"))).toEqual(["release/1.x"]);
    expect(resolvePullRequestTargetBranches(global, defaults, undefined)).toEqual(["dev"]);
  });

  it("allows defaults to clear the global list even when the instance only sets a schedule", () => {
    expect(resolvePullRequestTargetBranches(
      { include_target_branches: ["main"] },
      { include_target_branches: [] },
      { schedule: { rules: [] } },
    )).toBeUndefined();
  });

  it.each(["global", "defaults", "instance"])("rejects malformed allowlists at the %s config layer", (layer) => {
    const review = { pull_request: { include_target_branches: [1] } };
    const input = layer === "global" ? { review }
      : { workspaces: layer === "defaults" ? { defaults: { review } } : { instances: { repo: { review } } } };
    const result = appConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.arrayContaining(["pull_request", "include_target_branches", 0]) }),
      ]));
    }
  });

  it("returns undefined when no layer sets an allowlist", () => {
    expect(resolvePullRequestTargetBranches(undefined, undefined, undefined)).toBeUndefined();
    expect(resolvePullRequestTargetBranches({}, {}, {})).toBeUndefined();
  });

  it("prefers the instance layer over defaults over global with no merge", () => {
    expect(
      resolvePullRequestTargetBranches(
        { include_target_branches: ["main"] },
        { include_target_branches: ["dev"] },
        { include_target_branches: ["release/1.x"] },
      ),
    ).toEqual(["release/1.x"]);
    expect(
      resolvePullRequestTargetBranches(
        { include_target_branches: ["main"] },
        { include_target_branches: ["dev"] },
        undefined,
      ),
    ).toEqual(["dev"]);
    expect(
      resolvePullRequestTargetBranches({ include_target_branches: ["main"] }, undefined, undefined),
    ).toEqual(["main"]);
  });

  it("clears an inherited allowlist with an explicit empty array", () => {
    expect(
      resolvePullRequestTargetBranches(
        { include_target_branches: ["main"] },
        { include_target_branches: ["dev"] },
        { include_target_branches: [] },
      ),
    ).toBeUndefined();
  });
});

describe("resolvePullRequestSchedule", () => {
  it("returns undefined when no layer sets a schedule", () => {
    expect(resolvePullRequestSchedule(undefined, undefined, undefined)).toBeUndefined();
    expect(resolvePullRequestSchedule({}, {}, {})).toBeUndefined();
  });

  it("prefers the instance layer over defaults and global", () => {
    const instance = { schedule: { timezone: "UTC", rules: [] } };
    const defaults = { schedule: WEEKDAY_PEAK_FREE_SCHEDULE };
    const resolved = resolvePullRequestSchedule(defaults, defaults, instance);
    expect(resolved?.timezone).toBe("UTC");
    expect(resolved?.unrestricted).toBe(true);
  });

  it("falls back to defaults then global", () => {
    const fromDefaults = resolvePullRequestSchedule(
      { schedule: { timezone: "UTC", rules: [] } },
      { schedule: WEEKDAY_PEAK_FREE_SCHEDULE },
      undefined,
    );
    expect(fromDefaults?.timezone).toBe("Asia/Shanghai");

    const fromGlobal = resolvePullRequestSchedule(
      { schedule: WEEKDAY_PEAK_FREE_SCHEDULE },
      undefined,
      undefined,
    );
    expect(fromGlobal?.timezone).toBe("Asia/Shanghai");
  });

  it("compiles a usable weekly schedule", () => {
    const resolved = resolvePullRequestSchedule(
      { schedule: WEEKDAY_PEAK_FREE_SCHEDULE },
      undefined,
      undefined,
    );
    expect(resolved).toBeDefined();
    // 2026-09-11 14:00 Asia/Shanghai (Friday) is inside the 13:00–18:00 peak gap.
    const fridayPeakUtc = Date.parse("2026-09-11T06:00:00.000Z");
    expect(isAllowedInstant(resolved!, fridayPeakUtc)).toBe(false);
    // 2026-09-11 19:00 Asia/Shanghai is allowed again.
    const fridayEveningUtc = Date.parse("2026-09-11T11:00:00.000Z");
    expect(isAllowedInstant(resolved!, fridayEveningUtc)).toBe(true);
  });

  it("caches compiled schedules by canonical config", () => {
    const first = resolvePullRequestSchedule({ schedule: WEEKDAY_PEAK_FREE_SCHEDULE }, undefined, undefined);
    const second = resolvePullRequestSchedule({ schedule: { ...WEEKDAY_PEAK_FREE_SCHEDULE } }, undefined, undefined);
    expect(first).toBe(second);
  });
});
