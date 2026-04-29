import { describe, expect, it } from "vitest";

import { sandboxPackageName } from "../src/index.js";

describe("@aicr/sandbox", () => {
  it("exports the package name", () => {
    expect(sandboxPackageName).toBe("@aicr/sandbox");
  });
});
