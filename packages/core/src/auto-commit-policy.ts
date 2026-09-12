/**
 * `review.auto_commit` configuration schema and layered policy resolution.
 *
 * Contract: docs/ai/architecture.md §3.1.1 + docs/ai/decisions.md D35 (M15). The same field shape is accepted at three layers — global `review`,
 * `workspaces.defaults.review`, and `workspaces.instances.<id>.review` — and
 * resolved per key with instance → defaults → global → built-in precedence:
 *
 * - `delay_seconds`: nearest explicitly set value wins; built-in default 120.
 *   `0` disables the first-receive wait (schedule still applies).
 * - `schedule`: whole-object replacement at the nearest layer that sets it —
 *   never deep-merged across layers, so a new timezone cannot combine with an
 *   inherited rule set. An explicit schedule requires `rules`; `rules: []`
 *   lifts all weekly restrictions. Missing timezone defaults to UTC; host TZ
 *   is never consulted.
 * - `exclude_sources`: nearest explicitly set array wins wholesale; `[]`
 *   clears inherited rules. Rule semantics live in auto-commit-exclusion.ts.
 * - `include_branches`: nearest explicitly set array wins wholesale; `[]`
 *   clears the inherited allowlist (back to all branches). When the resolved
 *   list is non-empty, only automatic commit events whose `reviewEvent.branch`
 *   is listed are accepted; branchless events (P4/SVN hooks) are not filtered.
 *
 * Defaults are filled only after layered selection, so a layer that sets only
 * `schedule` does not reset an inherited `delay_seconds`. Validation is strict:
 * unknown subfields (including the superseded flat `schedule.windows` draft
 * shape) are rejected at config load with full paths.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  autoCommitExcludeSourcesSchema,
  compileExclusionRules,
  type CompiledExclusionPolicy,
  type ExclusionRuleConfig,
} from "./auto-commit-exclusion.js";
import {
  compileWeeklySchedule,
  isValidTimeZone,
  SCHEDULE_WEEKDAYS,
  type CompiledWeeklySchedule,
  type ScheduleRuleGroupInput,
} from "./weekly-schedule.js";

export const AUTO_COMMIT_DEFAULT_DELAY_SECONDS = 120;
/**
 * Operational bound for the first-receive delay. Rejects values that are not
 * useful operationally and keeps `firstAcceptedAt + delay * 1000` far from
 * timestamp overflow (design §3 delay_seconds row).
 */
export const AUTO_COMMIT_MAX_DELAY_SECONDS = 31_536_000; // 365 days

const scheduleWindowSchema = z
  .object({
    start: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, {
        message: "window start must be strict HH:mm in 00:00–23:59",
      }),
    end: z
      .string()
      .regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/u, {
        message: "window end must be strict HH:mm in 00:00–23:59 or 24:00",
      }),
  })
  .strict()
  .superRefine((window, ctx) => {
    if (window.start === window.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "window start must differ from end; use 00:00–24:00 for a full selected day",
      });
    }
  });

const scheduleRuleGroupSchema = z
  .object({
    days: z
      .array(z.enum(SCHEDULE_WEEKDAYS))
      .min(1, { message: "rule group days must be a non-empty weekday array" }),
    windows: z
      .array(scheduleWindowSchema)
      .min(1, { message: "rule group windows must be a non-empty array" }),
  })
  .strict();

export const autoCommitScheduleSchema = z
  .object({
    timezone: z.string().min(1).optional(),
    rules: z.array(scheduleRuleGroupSchema),
  })
  .strict()
  .superRefine((schedule, ctx) => {
    const timezone = schedule.timezone ?? "UTC";
    if (!isValidTimeZone(timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid IANA timezone "${timezone}"`,
        path: ["timezone"],
      });
    }
  });

export const autoCommitConfigSchema = z
  .object({
    delay_seconds: z
      .number()
      .int()
      .nonnegative()
      .max(AUTO_COMMIT_MAX_DELAY_SECONDS, {
        message: `delay_seconds must not exceed ${AUTO_COMMIT_MAX_DELAY_SECONDS} (365 days)`,
      })
      .optional(),
    schedule: autoCommitScheduleSchema.optional(),
    exclude_sources: autoCommitExcludeSourcesSchema.optional(),
    include_branches: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type AutoCommitConfig = z.infer<typeof autoCommitConfigSchema>;
export type AutoCommitScheduleConfig = z.infer<typeof autoCommitScheduleSchema>;

export interface ResolvedAutoCommitPolicy {
  readonly delaySeconds: number;
  readonly schedule: CompiledWeeklySchedule;
  readonly exclusions: CompiledExclusionPolicy;
  /**
   * Branch allowlist for automatic commit events; `undefined` accepts every
   * branch. Receive-side filter only — receipts already accepted stay valid,
   * so this never joins `policyVersion`.
   */
  readonly includeBranches: readonly string[] | undefined;
  /**
   * Hash of the canonical resolved policy. Sealed batches pin the exclusion
   * version; pending members are re-decided when this version changes.
   */
  readonly policyVersion: string;
}

const scheduleCache = new Map<string, CompiledWeeklySchedule>();
const exclusionCache = new Map<string, CompiledExclusionPolicy>();
const POLICY_COMPILE_CACHE_LIMIT = 256;

function cachedCompile<K, V>(cache: Map<K, V>, key: K, build: () => V): V {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = build();
  if (cache.size >= POLICY_COMPILE_CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(key, value);
  return value;
}

function pickLayer<T>(
  pick: (layer: AutoCommitConfig | undefined) => T | undefined,
  layers: readonly (AutoCommitConfig | undefined)[],
): T | undefined {
  for (const layer of layers) {
    const value = pick(layer);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Resolve the effective auto-commit policy from the three configuration
 * layers. Arguments must be the raw per-layer `review.auto_commit` objects —
 * not the output of `resolveWorkspaceConfig`, whose generic deep merge would
 * combine `schedule` objects across layers and is therefore never used here.
 */
export function resolveAutoCommitPolicy(
  globalAutoCommit: AutoCommitConfig | undefined,
  defaultsAutoCommit: AutoCommitConfig | undefined,
  instanceAutoCommit: AutoCommitConfig | undefined,
): ResolvedAutoCommitPolicy {
  const nearestFirst = [instanceAutoCommit, defaultsAutoCommit, globalAutoCommit];

  const delaySeconds =
    pickLayer((layer) => layer?.delay_seconds, nearestFirst) ??
    AUTO_COMMIT_DEFAULT_DELAY_SECONDS;

  const scheduleConfig = pickLayer((layer) => layer?.schedule, nearestFirst);
  const schedule = cachedCompile(
    scheduleCache,
    scheduleConfig === undefined
      ? "UTC|"
      : `${scheduleConfig.timezone ?? "UTC"}|${JSON.stringify(scheduleConfig.rules)}`,
    () =>
      compileWeeklySchedule({
        timezone: scheduleConfig?.timezone ?? "UTC",
        rules: (scheduleConfig?.rules ?? []) as ScheduleRuleGroupInput[],
      }),
  );

  const exclusionConfig = pickLayer((layer) => layer?.exclude_sources, nearestFirst);
  const exclusions = cachedCompile(
    exclusionCache,
    JSON.stringify(exclusionConfig ?? []),
    () => compileExclusionRules((exclusionConfig ?? []) as ExclusionRuleConfig[]),
  );

  const branchConfig = pickLayer((layer) => layer?.include_branches, nearestFirst);
  const includeBranches = branchConfig && branchConfig.length > 0
    ? Object.freeze([...branchConfig])
    : undefined;

  const policyVersion = createHash("sha256")
    .update(
      JSON.stringify(["auto-commit-policy", 1, delaySeconds, schedule.canonical, exclusions.canonical]),
    )
    .digest("hex")
    .slice(0, 16);

  return { delaySeconds, schedule, exclusions, includeBranches, policyVersion };
}
