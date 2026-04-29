import { describe, expect, it } from "vitest";

import { agentPackageName } from "../src/index.js";

describe("@aicr/agents", () => {
  it("exports the package name", () => {
    expect(agentPackageName).toBe("@aicr/agents");
  });
});
