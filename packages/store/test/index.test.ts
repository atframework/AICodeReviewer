import { describe, expect, it } from "vitest";

import {
  reviewRuns,
  runStatusValues,
  projects,
  codeMetrics,
  llmUsage,
  outputEvents,
  dailyRollups,
  createStoreDb,
  closeStoreDb,
  insertReviewRun,
  getOverviewStats,
} from "../src/index.js";

describe("@aicr/store", () => {
  it("exports reviewRuns table", () => {
    expect(reviewRuns).toBeDefined();
  });

  it("exports runStatusValues with skipped", () => {
    expect(runStatusValues).toEqual([
      "queued",
      "preparing",
      "analyzing",
      "publishing",
      "succeeded",
      "failed",
      "cancelled",
      "timeout",
      "skipped",
    ]);
  });

  it("exports new schema tables", () => {
    expect(projects).toBeDefined();
    expect(codeMetrics).toBeDefined();
    expect(llmUsage).toBeDefined();
    expect(outputEvents).toBeDefined();
    expect(dailyRollups).toBeDefined();
  });

  it("exports database functions", () => {
    expect(typeof createStoreDb).toBe("function");
    expect(typeof closeStoreDb).toBe("function");
  });

  it("exports stats functions", () => {
    expect(typeof insertReviewRun).toBe("function");
    expect(typeof getOverviewStats).toBe("function");
  });
});
