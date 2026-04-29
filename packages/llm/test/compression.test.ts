import { describe, expect, it } from "vitest";

import {
  buildCompactedDiff,
  compressDiff,
  estimatePromptTokenCount,
  generatePerFileSummaries,
  scoreAndSelectHunks,
  shouldTriggerCompression,
  type ChatCompletionClient,
  type ChatCompletionInput,
  type ChatCompletionResult,
  type CompressionConfig,
  type ModelSpec,
} from "../src/index.js";
import type { ParsedDiff, ParsedDiffFile, ParsedDiffHunk, ParsedDiffLine } from "@aicr/vcs";

function ctxLine(content: string, oldLine?: number, newLine?: number): ParsedDiffLine {
  return { kind: "context", content, oldLine, newLine };
}

function addLine(content: string, newLine?: number): ParsedDiffLine {
  return { kind: "add", content, oldLine: undefined, newLine };
}

function delLine(content: string, oldLine?: number): ParsedDiffLine {
  return { kind: "delete", content, oldLine, newLine: undefined };
}

function makeHunk(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  lines: ParsedDiffLine[],
  section?: string,
): ParsedDiffHunk {
  return { oldStart, oldLines, newStart, newLines, section, lines };
}

function makeFile(
  newPath: string,
  status: ParsedDiffFile["status"],
  hunks: ParsedDiffHunk[],
): ParsedDiffFile {
  return { newPath, status, rawHeaders: [], hunks };
}

function makeDiff(files: ParsedDiffFile[]): ParsedDiff {
  return { files };
}

const baseModel: ModelSpec = {
  providerKind: "openai_compatible",
  providerId: "openai-prod",
  modelId: "gpt-test",
  contextWindow: 128000,
};

const baseConfig: CompressionConfig = {
  triggerTokens: 1000,
  keepHunksTopK: 10,
  contextLines: 3,
};

function makeSmallDiff(): ParsedDiff {
  return makeDiff([
    makeFile("src/a.ts", "modified", [
      makeHunk(1, 3, 1, 3, [
        ctxLine("line 1"),
        addLine("new line"),
        ctxLine("line 3"),
      ]),
    ]),
  ]);
}

function makeLargeDiff(): ParsedDiff {
  const files: ParsedDiffFile[] = [];
  for (let fi = 0; fi < 5; fi++) {
    const hunks: ParsedDiffHunk[] = [];
    for (let hi = 0; hi < 4; hi++) {
      const lines: ParsedDiffLine[] = [];
      for (let li = 0; li < 50; li++) {
        if (li % 3 === 0) {
          lines.push(addLine(`+ added line ${fi}-${hi}-${li}`));
        } else if (li % 3 === 1) {
          lines.push(delLine(`- removed line ${fi}-${hi}-${li}`));
        } else {
          lines.push(ctxLine(`  context line ${fi}-${hi}-${li}`));
        }
      }
      hunks.push(makeHunk(1, 50, 1, 50, lines));
    }
    files.push(makeFile(`src/file${fi}.ts`, "modified", hunks));
  }
  return makeDiff(files);
}

function makeSummarizeClient(): ChatCompletionClient {
  return {
    async complete(_input: ChatCompletionInput): Promise<ChatCompletionResult> {
      return {
        providerId: "summarizer",
        modelId: "light",
        content: '{"impact":"low","dangers":[],"keyHunks":[0],"desc":"minor changes","highRisk":false}',
        raw: {},
      };
    },
  };
}

describe("shouldTriggerCompression", () => {
  it("returns false when token estimate is under threshold", () => {
    expect(shouldTriggerCompression(500, baseModel, baseConfig)).toBe(false);
  });

  it("returns true when token estimate is over threshold", () => {
    expect(shouldTriggerCompression(1500, baseModel, baseConfig)).toBe(true);
  });

  it("uses per-model override when available", () => {
    const config: CompressionConfig = {
      triggerTokens: 1000,
      perModelOverrides: {
        "openai_compatible:gpt-test": { triggerTokens: 5000 },
      },
    };
    expect(shouldTriggerCompression(2000, baseModel, config)).toBe(false);
  });

  it("uses default 131072 when no triggerTokens configured", () => {
    const model: ModelSpec = { ...baseModel, contextWindow: 200000 };
    expect(shouldTriggerCompression(100000, model, {})).toBe(false);
    expect(shouldTriggerCompression(200000, model, {})).toBe(true);
  });

  it("falls back to base triggerTokens when model override does not include triggerTokens", () => {
    const config: CompressionConfig = {
      triggerTokens: 1500,
      perModelOverrides: {
        "openai_compatible:gpt-test": {},
      },
    };
    expect(shouldTriggerCompression(2000, baseModel, config)).toBe(true);
  });
});

describe("scoreAndSelectHunks", () => {
  it("returns hunks sorted by score descending", () => {
    const diff = makeLargeDiff();
    const selected = scoreAndSelectHunks(diff, 10);
    expect(selected.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < selected.length; i++) {
      expect(selected[i - 1]!.score).toBeGreaterThanOrEqual(selected[i]!.score);
    }
  });

  it("returns empty array for empty diff", () => {
    const diff = makeDiff([]);
    expect(scoreAndSelectHunks(diff, 10)).toEqual([]);
  });

  it("returns all hunks when keepTopK >= total hunks", () => {
    const diff = makeSmallDiff();
    const selected = scoreAndSelectHunks(diff, 50);
    expect(selected.length).toBe(1);
  });

  it("boosts score for security-related keywords", () => {
    const securityFile = makeFile("src/auth.ts", "modified", [
      makeHunk(1, 3, 1, 3, [
        ctxLine("function validateToken() {"),
        addLine("  const password = decryptToken(token);"),
        ctxLine("}"),
      ]),
    ]);
    const plainFile = makeFile("src/format.ts", "modified", [
      makeHunk(1, 3, 1, 3, [
        ctxLine("function formatDate() {"),
        addLine("  return new Date().toISOString();"),
        ctxLine("}"),
      ]),
    ]);
    const diff = makeDiff([plainFile, securityFile]);
    const selected = scoreAndSelectHunks(diff, 2);
    expect(selected.length).toBe(2);
    // The security file's hunk (fileIndex 1) should score higher
    expect(selected[0]!.fileIndex).toBe(1);
  });

  it("boosts score for high-risk file extensions", () => {
    const sqlFile = makeFile("src/migration.sql", "modified", [
      makeHunk(1, 3, 1, 3, [
        ctxLine("-- migration"),
        addLine("ALTER TABLE users ADD COLUMN email TEXT;"),
        ctxLine(""),
      ]),
    ]);
    const txtFile = makeFile("src/readme.txt", "modified", [
      makeHunk(1, 3, 1, 3, [
        ctxLine("## Changelog"),
        addLine("- Added email column"),
        ctxLine(""),
      ]),
    ]);
    const diff = makeDiff([txtFile, sqlFile]);
    const selected = scoreAndSelectHunks(diff, 2);
    expect(selected.length).toBe(2);
    expect(selected[0]!.fileIndex).toBe(1);
  });
});

describe("buildCompactedDiff", () => {
  it("produces compacted diff with summaries and selected hunks", () => {
    const diff = makeSmallDiff();
    const summaries = [
      {
        fileIndex: 0,
        filePath: "src/a.ts",
        summary: "[low] minor changes",
        highRisk: false,
        totalHunks: 1,
      },
    ];
    const selectedHunks = [{ fileIndex: 0, hunkIndex: 0, score: 1 }];
    const result = buildCompactedDiff(diff, summaries, selectedHunks, 3);
    expect(result).toContain("Compressed diff");
    expect(result).toContain("src/a.ts");
    expect(result).toContain("[low] minor changes");
    expect(result).toContain("@@");
  });

  it("marks files with no selected hunks", () => {
    const diff = makeSmallDiff();
    const summaries = [
      {
        fileIndex: 0,
        filePath: "src/a.ts",
        summary: "[low] minor changes",
        highRisk: false,
        totalHunks: 1,
      },
    ];
    const result = buildCompactedDiff(diff, summaries, [], 3);
    expect(result).toContain("no hunks selected");
  });

  it("handles empty summaries gracefully", () => {
    const diff = makeSmallDiff();
    const result = buildCompactedDiff(diff, [], [{ fileIndex: 0, hunkIndex: 0, score: 1 }], 3);
    expect(result).toContain("Compressed diff");
  });
});

describe("generatePerFileSummaries", () => {
  it("summarizes each file in the diff", async () => {
    const diff = makeSmallDiff();
    const summarizeModel: ModelSpec = {
      providerKind: "openai_compatible",
      providerId: "light-prod",
      modelId: "gpt-light",
    };
    const client = makeSummarizeClient();
    const summaries = await generatePerFileSummaries(diff, summarizeModel, client);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.filePath).toBe("src/a.ts");
    expect(summaries[0]!.summary).toContain("minor changes");
  });

  it("skips LLM call for empty file diffs", async () => {
    const diff = makeDiff([
      makeFile("empty.ts", "added", []),
    ]);
    const summarizeModel: ModelSpec = {
      providerKind: "openai_compatible",
      providerId: "light-prod",
      modelId: "gpt-light",
    };
    let callCount = 0;
    const client: ChatCompletionClient = {
      async complete(): Promise<ChatCompletionResult> {
        callCount++;
        return { providerId: "x", modelId: "x", content: "{}", raw: {} };
      },
    };
    const summaries = await generatePerFileSummaries(diff, summarizeModel, client);
    expect(callCount).toBe(0);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summary).toContain("empty or binary change");
  });

  it("handles summarize client errors gracefully", async () => {
    const diff = makeSmallDiff();
    const summarizeModel: ModelSpec = {
      providerKind: "openai_compatible",
      providerId: "bad",
      modelId: "bad",
    };
    const client: ChatCompletionClient = {
      async complete(): Promise<ChatCompletionResult> {
        throw new Error("summarizer down");
      },
    };
    const summaries = await generatePerFileSummaries(diff, summarizeModel, client);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summary).toContain("summary unavailable");
  });
});

describe("estimatePromptTokenCount", () => {
  it("returns a positive number for non-empty text", () => {
    const estimate = estimatePromptTokenCount("hello world this is a test");
    expect(estimate).toBeGreaterThan(0);
  });

  it("returns a small number for empty string", () => {
    const estimate = estimatePromptTokenCount("");
    expect(estimate).toBeGreaterThanOrEqual(0);
  });
});

describe("compressDiff", () => {
  it("returns uncompressed result when under threshold", async () => {
    const diff = makeSmallDiff();
    const promptText = "small prompt";
    const summarizeModel: ModelSpec = {
      providerKind: "openai_compatible",
      providerId: "light",
      modelId: "light",
    };
    const config: CompressionConfig = { triggerTokens: 100000 };
    const result = await compressDiff({
      diff,
      promptText,
      model: baseModel,
      config,
      summarizeModel,
      summarizeClient: makeSummarizeClient(),
    });
    expect(result.compressed).toBe(false);
    expect(result.compactDiff).toBe(promptText);
    expect(result.compressedTokenEstimate).toBe(result.originalTokenEstimate);
    expect(result.selectedHunks).toEqual([]);
  });

  it("compresses when over threshold", async () => {
    const diff = makeLargeDiff();
    const promptText = "x".repeat(5000);
    const summarizeModel: ModelSpec = {
      providerKind: "openai_compatible",
      providerId: "light",
      modelId: "light",
    };
    const config: CompressionConfig = { triggerTokens: 100, keepHunksTopK: 5, contextLines: 3 };
    const result = await compressDiff({
      diff,
      promptText,
      model: baseModel,
      config,
      summarizeModel,
      summarizeClient: makeSummarizeClient(),
    });
    expect(result.compressed).toBe(true);
    expect(result.compactDiff).not.toBe(promptText);
    expect(result.compactDiff).toContain("Compressed diff");
    expect(result.selectedHunks.length).toBeLessThanOrEqual(5);
    expect(result.originalTokenEstimate).toBeGreaterThan(0);
    expect(result.compressedTokenEstimate).toBeGreaterThan(0);
  });

  it("uses default keepTopK and contextLines when not configured", async () => {
    const diff = makeLargeDiff();
    const promptText = "x".repeat(5000);
    const summarizeModel: ModelSpec = {
      providerKind: "openai_compatible",
      providerId: "light",
      modelId: "light",
    };
    const result = await compressDiff({
      diff,
      promptText,
      model: baseModel,
      config: { triggerTokens: 100 },
      summarizeModel,
      summarizeClient: makeSummarizeClient(),
    });
    expect(result.compressed).toBe(true);
    expect(result.selectedHunks.length).toBeLessThanOrEqual(30);
  });
});
