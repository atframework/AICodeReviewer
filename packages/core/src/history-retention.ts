export interface HistoryRetentionPolicy {
  readonly max_count: number;
  readonly max_age_months: number;
}

export interface HistoryRetention {
  readonly recent_runs: HistoryRetentionPolicy;
  readonly events: HistoryRetentionPolicy;
  readonly queue: HistoryRetentionPolicy;
}

export function resolveHistoryRetention(input?: { [K in keyof HistoryRetention]?: HistoryRetentionPolicy | undefined }): HistoryRetention {
  return {
    recent_runs: input?.recent_runs ?? { max_count: 2000, max_age_months: 6 },
    events: input?.events ?? { max_count: 2000, max_age_months: 6 },
    queue: input?.queue ?? { max_count: 1000, max_age_months: 6 },
  };
}

/** UTC calendar months, clamping month-end (August 31 -> February 28/29). */
export function historyCutoff(policy: HistoryRetentionPolicy, now = Date.now()): number {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - policy.max_age_months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}
