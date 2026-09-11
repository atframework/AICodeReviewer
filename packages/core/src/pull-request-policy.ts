/**
 * `review.pull_request` configuration schema and layered schedule resolution.
 *
 * PR/MR analysis gets its own weekly execution window with the same shape as
 * `review.auto_commit.schedule` (see docs/ai/architecture.md §3.1.1). The same
 * field shape is accepted at three layers — global `review`,
 * `workspaces.defaults.review`, and `workspaces.instances.<id>.review` — and
 * the `schedule` object replaces wholesale at the nearest layer that sets it,
 * never deep-merged across layers.
 *
 * When no layer sets `pull_request.schedule`, resolution returns `undefined`
 * and the caller falls back to the resolved `review.auto_commit.schedule`,
 * so one configured window can cover both execution families. All async
 * pull_request-target events, including comment commands, are gated this way;
 * the schedule never merges or batches PR events, and there is no
 * first-receive delay equivalent to `delay_seconds`.
 */

import { z } from "zod";

import { autoCommitScheduleSchema, type AutoCommitScheduleConfig } from "./auto-commit-policy.js";
import {
  compileWeeklySchedule,
  type CompiledWeeklySchedule,
  type ScheduleRuleGroupInput,
} from "./weekly-schedule.js";

export interface PullRequestConfig {
  readonly schedule?: AutoCommitScheduleConfig | undefined;
}

// Explicit annotation keeps the app config schema's serialized declaration
// small (the weekly-schedule union types stay behind named references).
export const pullRequestConfigSchema: z.ZodType<PullRequestConfig> = z
  .object({
    schedule: autoCommitScheduleSchema.optional(),
  })
  .strict();

const scheduleCache = new Map<string, CompiledWeeklySchedule>();
const SCHEDULE_COMPILE_CACHE_LIMIT = 256;

/**
 * Resolve the effective PR/MR execution window from the three configuration
 * layers. Arguments must be the raw per-layer `review.pull_request` objects,
 * matching the `resolveAutoCommitPolicy` contract. Returns `undefined` when
 * no layer sets a schedule so the caller can apply its own fallback.
 */
export function resolvePullRequestSchedule(
  globalPullRequest: PullRequestConfig | undefined,
  defaultsPullRequest: PullRequestConfig | undefined,
  instancePullRequest: PullRequestConfig | undefined,
): CompiledWeeklySchedule | undefined {
  const scheduleConfig =
    instancePullRequest?.schedule ?? defaultsPullRequest?.schedule ?? globalPullRequest?.schedule;
  if (!scheduleConfig) {
    return undefined;
  }

  const cacheKey = `${scheduleConfig.timezone ?? "UTC"}|${JSON.stringify(scheduleConfig.rules)}`;
  const hit = scheduleCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const compiled = compileWeeklySchedule({
    timezone: scheduleConfig.timezone ?? "UTC",
    rules: (scheduleConfig.rules ?? []) as ScheduleRuleGroupInput[],
  });
  if (scheduleCache.size >= SCHEDULE_COMPILE_CACHE_LIMIT) {
    scheduleCache.clear();
  }
  scheduleCache.set(cacheKey, compiled);
  return compiled;
}
