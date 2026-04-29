import { describe, expect, it } from "vitest";

import { evalPackageName } from "../src/index.js";

describe("@aicr/eval", () => {
  it("exports the package name", () => {
    expect(evalPackageName).toBe("@aicr/eval");
  });
});