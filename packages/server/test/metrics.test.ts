import { describe, expect, it } from "vitest";

import { createAicrMetrics, formatPrometheusMetrics, recordReviewResult } from "../src/metrics.js";

describe("metrics", () => {
  it("creates metrics with zero values", () => {
    const m = createAicrMetrics();
    expect(m.reviewsTotal).toBe(0);
    expect(m.reviewsSkipped).toBe(0);
    expect(m.reviewsFailed).toBe(0);
    expect(m.problemsTotal).toBe(0);
    expect(m.reviewDurationsMs).toEqual([]);
    expect(m.reviewDurationCount).toBe(0);
    expect(m.reviewDurationSumMs).toBe(0);
    expect(m.reviewDurationBuckets["+Inf"]).toBe(0);
  });

  it("records a published review with problems", () => {
    const m = createAicrMetrics();
    recordReviewResult(m, { status: "published", problemCount: 3, durationMs: 1500 });
    expect(m.reviewsTotal).toBe(1);
    expect(m.problemsTotal).toBe(3);
    expect(m.reviewDurationsMs).toEqual([1500]);
  });

  it("records a skipped review", () => {
    const m = createAicrMetrics();
    recordReviewResult(m, { status: "skipped", durationMs: 500 });
    expect(m.reviewsTotal).toBe(1);
    expect(m.reviewsSkipped).toBe(1);
    expect(m.problemsTotal).toBe(0);
  });

  it("records a failed review", () => {
    const m = createAicrMetrics();
    recordReviewResult(m, { status: "failed", durationMs: 200 });
    expect(m.reviewsTotal).toBe(1);
    expect(m.reviewsFailed).toBe(1);
  });

  it("formats prometheus metrics with data", () => {
    const m = createAicrMetrics();
    recordReviewResult(m, { status: "published", problemCount: 2, durationMs: 1500 });
    recordReviewResult(m, { status: "skipped", durationMs: 300 });

    const output = formatPrometheusMetrics(m);
    expect(output).toContain("aicr_reviews_total 2");
    expect(output).toContain("aicr_reviews_skipped_total 1");
    expect(output).toContain("aicr_problems_total 2");
    expect(output).toContain("aicr_review_duration_seconds_bucket");
    expect(output).toContain("aicr_review_duration_seconds_count 2");
  });

  it("formats prometheus metrics with empty data", () => {
    const m = createAicrMetrics();
    const output = formatPrometheusMetrics(m);
    expect(output).toContain("aicr_reviews_total 0");
    expect(output).toContain("aicr_review_duration_seconds_count 0");
  });

  it("records zero-duration observations", () => {
    const m = createAicrMetrics();
    recordReviewResult(m, { status: "published", durationMs: 0 });

    const output = formatPrometheusMetrics(m);
    expect(output).toContain('aicr_review_duration_seconds_bucket{le="0.005"} 1');
    expect(output).toContain("aicr_review_duration_seconds_sum 0.000");
    expect(output).toContain("aicr_review_duration_seconds_count 1");
  });

  it("formats cumulative histogram buckets and sum", () => {
    const m = createAicrMetrics();
    recordReviewResult(m, { status: "published", durationMs: 4 });
    recordReviewResult(m, { status: "published", durationMs: 10 });
    recordReviewResult(m, { status: "published", durationMs: 11_000 });

    const output = formatPrometheusMetrics(m);
    expect(output).toContain('aicr_review_duration_seconds_bucket{le="0.005"} 1');
    expect(output).toContain('aicr_review_duration_seconds_bucket{le="0.01"} 2');
    expect(output).toContain('aicr_review_duration_seconds_bucket{le="10"} 2');
    expect(output).toContain('aicr_review_duration_seconds_bucket{le="+Inf"} 3');
    expect(output).toContain("aicr_review_duration_seconds_sum 11.014");
    expect(output).toContain("aicr_review_duration_seconds_count 3");
  });

  it("bounds the duration buffer", () => {
    const m = createAicrMetrics();
    for (let i = 0; i < 1200; i++) {
      recordReviewResult(m, { status: "published", durationMs: 100 });
    }
    expect(m.reviewDurationsMs.length).toBeLessThanOrEqual(1000);
    expect(m.reviewDurationCount).toBe(1200);

    const output = formatPrometheusMetrics(m);
    expect(output).toContain("aicr_review_duration_seconds_count 1200");
    expect(output).toContain("aicr_review_duration_seconds_sum 120.000");
    expect(output).toContain('aicr_review_duration_seconds_bucket{le="+Inf"} 1200');
  });
});
