export interface AicrMetrics {
  reviewsTotal: number;
  reviewsSkipped: number;
  reviewsFailed: number;
  problemsTotal: number;
  reviewDurationsMs: number[];
  reviewDurationBuckets: Record<DurationBucketLabel, number>;
  reviewDurationCount: number;
  reviewDurationSumMs: number;
}

const DURATION_BUCKET_LABELS = [
  "0.005",
  "0.01",
  "0.025",
  "0.05",
  "0.1",
  "0.25",
  "0.5",
  "1",
  "2.5",
  "5",
  "10",
  "+Inf",
] as const;

type DurationBucketLabel = typeof DURATION_BUCKET_LABELS[number];

function createDurationBucketCounters(): Record<DurationBucketLabel, number> {
  return Object.fromEntries(DURATION_BUCKET_LABELS.map((label) => [label, 0])) as Record<DurationBucketLabel, number>;
}

export function createAicrMetrics(): AicrMetrics {
  return {
    reviewsTotal: 0,
    reviewsSkipped: 0,
    reviewsFailed: 0,
    problemsTotal: 0,
    reviewDurationsMs: [],
    reviewDurationBuckets: createDurationBucketCounters(),
    reviewDurationCount: 0,
    reviewDurationSumMs: 0,
  };
}

export function recordReviewResult(
  metrics: AicrMetrics,
  result: {
    status: string;
    problemCount?: number;
    durationMs?: number;
  },
): void {
  metrics.reviewsTotal += 1;
  if (result.status === "skipped") {
    metrics.reviewsSkipped += 1;
  }
  if (result.status === "failed") {
    metrics.reviewsFailed += 1;
  }
  if (typeof result.problemCount === "number" && result.problemCount > 0) {
    metrics.problemsTotal += result.problemCount;
  }
  if (typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0) {
    const seconds = result.durationMs / 1000;
    metrics.reviewDurationCount += 1;
    metrics.reviewDurationSumMs += result.durationMs;
    for (const label of DURATION_BUCKET_LABELS) {
      if (label === "+Inf" || seconds <= Number(label)) {
        metrics.reviewDurationBuckets[label] += 1;
      }
    }
    metrics.reviewDurationsMs.push(result.durationMs);
  }

  // Keep duration buffer bounded
  if (metrics.reviewDurationsMs.length > 1000) {
    metrics.reviewDurationsMs = metrics.reviewDurationsMs.slice(-500);
  }
}

export function formatPrometheusMetrics(metrics: AicrMetrics): string {
  const lines: string[] = [];

  lines.push("# HELP aicr_reviews_total Total number of review runs.");
  lines.push("# TYPE aicr_reviews_total counter");
  lines.push(`aicr_reviews_total ${metrics.reviewsTotal}`);
  lines.push("");

  lines.push("# HELP aicr_reviews_skipped_total Total number of skipped review runs.");
  lines.push("# TYPE aicr_reviews_skipped_total counter");
  lines.push(`aicr_reviews_skipped_total ${metrics.reviewsSkipped}`);
  lines.push("");

  lines.push("# HELP aicr_reviews_failed_total Total number of failed review runs.");
  lines.push("# TYPE aicr_reviews_failed_total counter");
  lines.push(`aicr_reviews_failed_total ${metrics.reviewsFailed}`);
  lines.push("");

  lines.push("# HELP aicr_problems_total Total number of problems reported.");
  lines.push("# TYPE aicr_problems_total counter");
  lines.push(`aicr_problems_total ${metrics.problemsTotal}`);
  lines.push("");

  const count = metrics.reviewDurationCount;
  const sum = metrics.reviewDurationSumMs / 1000;

  lines.push("# HELP aicr_review_duration_seconds Review run duration in seconds.");
  lines.push("# TYPE aicr_review_duration_seconds histogram");

  for (const le of DURATION_BUCKET_LABELS) {
    lines.push(`aicr_review_duration_seconds_bucket{le="${le}"} ${metrics.reviewDurationBuckets[le]}`);
  }
  lines.push(count > 0 ? `aicr_review_duration_seconds_sum ${sum.toFixed(3)}` : "aicr_review_duration_seconds_sum 0");
  lines.push(`aicr_review_duration_seconds_count ${count}`);

  return lines.join("\n");
}
