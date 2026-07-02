import { describe, expect, it } from "vitest";

import { evalPackageName, runEval, validateEvalExample, type EvalExample, type EvalReviewOutput } from "../src/index.js";

describe("@aicr/eval", () => {
  it("exports the package name", () => {
    expect(evalPackageName).toBe("@aicr/eval");
  });

  it("validates eval fixture contracts", () => {
    const result = validateEvalExample({
      id: "fixture-1",
      description: "Detect a sample issue",
      changedFiles: ["src/app.ts"],
      diff: "diff --git a/src/app.ts b/src/app.ts",
      expectedProblems: [
        {
          file: "src/app.ts",
          line: 2,
          severity: "high",
          category: "correctness",
          messagePattern: "sample",
        },
      ],
      tags: ["baseline"],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reports eval fixture contract issues with source paths", () => {
    const result = validateEvalExample(
      {
        id: "fixture-2",
        changedFiles: [],
        diff: "",
        expectedProblems: [{ file: "", line: 0, severity: "urgent", category: "" }],
      },
      { sourceName: "bad.json" },
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { path: "bad.json:$.description", message: "must be a non-empty string" },
        { path: "bad.json:$.changedFiles", message: "must include at least one entry" },
        { path: "bad.json:$.diff", message: "must be a non-empty string" },
        { path: "bad.json:$.expectedProblems[0].line", message: "must be a positive integer" },
        {
          path: "bad.json:$.expectedProblems[0].severity",
          message: "must be one of info, low, medium, high, critical",
        },
      ]),
    );
  });

  it("runs an eval with all expected problems found", async () => {
    const example: EvalExample = {
      id: "test-1",
      description: "Sample review",
      changedFiles: ["src/app.ts"],
      diff: "diff content",
      expectedProblems: [
        {
          file: "src/app.ts",
          line: 2,
          severity: "high",
          category: "correctness",
        },
      ],
    };

    const reviewFn = async (): Promise<EvalReviewOutput> => ({
      problems: [
        { file: "src/app.ts", line: 2, severity: "high", category: "correctness", message: "Issue" },
      ],
    });

    const result = await runEval({ examples: [example], reviewFn });
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results[0]!.passed).toBe(true);
    expect(result.results[0]!.foundProblems).toBe(1);
  });

  it("flags missing and unexpected problems", async () => {
    const example: EvalExample = {
      id: "test-2",
      description: "Missing and extra",
      changedFiles: ["src/app.ts"],
      diff: "diff content",
      expectedProblems: [
        {
          file: "src/app.ts",
          line: 2,
          severity: "high",
          category: "correctness",
        },
      ],
    };

    const reviewFn = async (): Promise<EvalReviewOutput> => ({
      problems: [
        { file: "src/app.ts", line: 3, severity: "low", category: "style", message: "Unexpected" },
      ],
    });

    const result = await runEval({ examples: [example], reviewFn });
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0]!.missingProblems.length).toBe(1);
    expect(result.results[0]!.unexpectedProblems.length).toBe(1);
  });

  it("handles empty expected problems", async () => {
    const example: EvalExample = {
      id: "test-3",
      description: "No problems expected",
      changedFiles: ["src/app.ts"],
      diff: "diff content",
    };

    const reviewFn = async (): Promise<EvalReviewOutput> => ({
      problems: [],
    });

    const result = await runEval({ examples: [example], reviewFn });
    expect(result.passed).toBe(1);
    expect(result.results[0]!.foundProblems).toBe(0);
  });

  it("matches problems by message pattern when provided", async () => {
    const example: EvalExample = {
      id: "test-4",
      description: "Pattern matching",
      changedFiles: ["src/app.ts"],
      diff: "diff content",
      expectedProblems: [
        {
          file: "src/app.ts",
          line: 2,
          severity: "high",
          category: "correctness",
          messagePattern: /await/,
        },
      ],
    };

    const reviewFn = async (): Promise<EvalReviewOutput> => ({
      problems: [
        { file: "src/app.ts", line: 2, severity: "high", category: "correctness", message: "Missing await" },
      ],
    });

    const result = await runEval({ examples: [example], reviewFn });
    expect(result.passed).toBe(1);
  });

  it("fails when message pattern does not match", async () => {
    const example: EvalExample = {
      id: "test-5",
      description: "Pattern mismatch",
      changedFiles: ["src/app.ts"],
      diff: "diff content",
      expectedProblems: [
        {
          file: "src/app.ts",
          line: 2,
          severity: "high",
          category: "correctness",
          messagePattern: "await",
        },
      ],
    };

    const reviewFn = async (): Promise<EvalReviewOutput> => ({
      problems: [
        { file: "src/app.ts", line: 2, severity: "high", category: "correctness", message: "Wrong message" },
      ],
    });

    const result = await runEval({ examples: [example], reviewFn });
    expect(result.passed).toBe(0);
    expect(result.results[0]!.missingProblems.length).toBe(1);
  });
});
