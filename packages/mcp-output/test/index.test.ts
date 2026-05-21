import { describe, expect, it } from "vitest";

import {
  mcpOutputPackageName,
  AicrOutputCollector,
  createAicrOutputToolRegistry,
} from "../src/index.js";

describe("@aicr/mcp-output", () => {
  it("exports the package name", () => {
    expect(mcpOutputPackageName).toBe("@aicr/mcp-output");
  });

  it("exports AicrOutputCollector", () => {
    expect(AicrOutputCollector).toBeDefined();
  });

  it("exports createAicrOutputToolRegistry", () => {
    expect(createAicrOutputToolRegistry).toBeDefined();
  });
});
