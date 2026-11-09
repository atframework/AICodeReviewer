import { spawn, type SpawnOptions } from "node:child_process";
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
        literal: true,
        max_results: 10,
      }),
    ).toEqual({
      pattern: "TODO",
      path_glob: "*.rs",
      case_insensitive: true,
      literal: true,
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
  function runSearch(script: string, maxResults = 50, timeoutMs?: number) {
    return executeTgrepSearch(
      {
        pattern: "--flag.*",
        literal: true,
        path_glob: "*.ts",
        max_results: maxResults,
      },
      {
        indexDir: "fixture-index",
        sourceDir: process.cwd(),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        spawnProcess: ((
          _command: string,
          args: string[],
          options: SpawnOptions,
        ) => {
          expect(args.slice(-3)).toEqual(["--", "--flag.*", "."]);
          expect(args).toContain("--fixed-strings");
          expect(args).toContain("--line-number");
          expect(args).toContain("*.ts");
          return spawn(process.execPath, ["-e", script], options);
        }) as typeof spawn,
      },
    );
  }

  it("limits matches across files and returns partial results with a marker", async () => {
    const result = await runSearch(
      'process.stdout.write("./a.ts:1:first\\n./b.ts:1:second\\n./c.ts:1:third\\n")',
      2,
    );
    expect(result).toContain("./a.ts:1:first\n./b.ts:1:second");
    expect(result).not.toContain("third");
    expect(result).toContain("truncated");
  });

  it("preserves exactly the requested number of matches without a truncation marker", async () => {
    const result = await runSearch(
      'process.stdout.write("./a.ts:1:first\\n")',
      1,
    );
    expect(result).toBe("./a.ts:1:first");
  });

  it("caps bytes while preserving valid UTF-8", async () => {
    const result = await runSearch(
      'process.stdout.write("./a.ts:1:" + "查".repeat(70_000))',
    );
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(64 * 1024);
    expect(result).toContain("truncated");
    expect(result).not.toContain("�");
  });

  it("distinguishes an empty result, a child error, and a deadline", async () => {
    expect(await runSearch("process.exit(1)")).toBe("(no matches)");
    expect(await runSearch("process.exit(2)")).toContain("failed (exit 2)");
    expect(await runSearch("setInterval(() => {}, 1000)", 50, 10)).toContain(
      "timed out",
    );
  });

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
