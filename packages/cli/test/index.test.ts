import { describe, expect, it } from "vitest";

import { runCli } from "../src/app.js";

describe("@aicr/cli", () => {
  it("exports runCli", () => {
    expect(runCli).toBeDefined();
  });
});
