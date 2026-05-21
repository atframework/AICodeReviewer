import { describe, expect, it } from "vitest";

import {
  reviewRuns,
  runStatusValues,
} from "../src/index.js";

describe("@aicr/store", () => {
  it("exports reviewRuns table", () => {
    expect(reviewRuns).toBeDefined();
  });

  it("exports runStatusValues", () => {
    expect(runStatusValues).toEqual([
      "queued",
      "preparing",
      "analyzing",
      "publishing",
      "succeeded",
      "failed",
      "cancelled",
      "timeout",
    ]);
  });
});
