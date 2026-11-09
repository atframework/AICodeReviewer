import { describe, expect, it } from "vitest";

import {
  createAicrOutputToolRegistry,
  executeTgrepSearch,
  parseSearchCodeInput,
  searchCodeHandlerFromEnv,
} from "../src/index.js";

describe("aicr.search_code input validation", () => {
  it("accepts a minimal pattern", () => {
    expect(parseSearchCodeInput({ pattern: "fn main" })).toEqual({
      pattern: "fn main",
    });
  });

  it("accepts all optional fields", () => {
    expect(
      parseSearchCodeInput({
        pattern: "TODO",
        path_glob: "*.rs",
        case_insensitive: true,
        max_results: 10,
      }),
    ).toEqual({
      pattern: "TODO",
      path_glob: "*.rs",
      case_insensitive: true,
      max_results: 10,
    });
  });

  it("rejects missing or oversized patterns", () => {
    expect(() => parseSearchCodeInput({})).toThrow(/pattern/u);
    expect(() => parseSearchCodeInput({ pattern: " " })).toThrow(/pattern/u);
    expect(() => parseSearchCodeInput({ pattern: "x".repeat(501) })).toThrow(
      /500/u,
    );
  });

  it("rejects out-of-range max_results", () => {
    expect(() =>
      parseSearchCodeInput({ pattern: "x", max_results: 0 }),
    ).toThrow(/max_results/u);
    expect(() =>
      parseSearchCodeInput({ pattern: "x", max_results: 201 }),
    ).toThrow(/max_results/u);
    expect(() =>
      parseSearchCodeInput({ pattern: "x", max_results: 1.5 }),
    ).toThrow(/max_results/u);
  });
});

describe("aicr.search_code registry entry", () => {
  it("returns a degraded message when no handler is configured", async () => {
    const tools = createAicrOutputToolRegistry();
    const tool = tools.find((entry) => entry.name === "aicr.search_code")!;
    const result = (await tool.call({ pattern: "fn main" })) as {
      content: string;
    };
    expect(result.content).toContain("not configured");
  });

  it("delegates to the configured handler", async () => {
    const tools = createAicrOutputToolRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      async (input) => `matches for ${input.pattern}`,
    );
    const tool = tools.find((entry) => entry.name === "aicr.search_code")!;
    const result = (await tool.call({ pattern: "fn main" })) as {
      content: string;
    };
    expect(result.content).toBe("matches for fn main");
  });
});

describe("searchCodeHandlerFromEnv", () => {
  it("is undefined without both paths", () => {
    expect(searchCodeHandlerFromEnv({})).toBeUndefined();
    expect(
      searchCodeHandlerFromEnv({ AICR_TGREP_INDEX_DIR: "/idx" }),
    ).toBeUndefined();
  });
});

describe("executeTgrepSearch", () => {
  it("degrades gracefully when the binary is missing", async () => {
    const result = await executeTgrepSearch(
      { pattern: "x" },
      {
        indexDir: "/nonexistent",
        sourceDir: "/nonexistent",
        spawnProcess: (() => {
          throw new Error("ENOENT");
        }) as never,
      },
    );
    expect(result).toContain("unavailable");
  });
});
