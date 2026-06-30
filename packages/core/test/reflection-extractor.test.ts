import { describe, expect, it } from "vitest";

import { buildMemoryHintsForPrompt, extractCrossRunPatterns, extractReflections, extractRepositoryConventions, type ReflectionExtractorInput } from "../src/reflection-extractor.js";

describe("extractReflections", () => {
  const baseInput: ReflectionExtractorInput = {
    workspaceId: "ws-1",
    runId: "run-001",
    status: "published",
    problems: [],
    summaries: [],
    changedFiles: [],
  };

  it("returns empty array when no problems and no changed files", () => {
    const result = extractReflections(baseInput);
    expect(result).toEqual([]);
  });

  it("returns skip reflection when status is skipped", () => {
    const result = extractReflections({
      ...baseInput,
      status: "skipped",
      skipReason: "no_changed_files",
    });
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("skipped");
    expect(result[0].content).toContain("no_changed_files");
  });

  it("extracts per-category reflections from problems", () => {
    const result = extractReflections({
      ...baseInput,
      status: "published",
      problems: [
        { file: "src/a.ts", line: 10, severity: "high", category: "bug", message: "null ref" },
        { file: "src/b.ts", line: 20, severity: "medium", category: "bug", message: "type mismatch" },
        { file: "src/c.ts", line: 30, severity: "low", category: "style", message: "naming" },
      ],
    });

    const categories = result.filter(r => r.content.includes("Category"));
    expect(categories.length).toBeGreaterThanOrEqual(2);

    const bugCategory = categories.find(r => r.content.includes('"bug"'));
    expect(bugCategory).toBeDefined();
    expect(bugCategory!.content).toContain("2 issues");
    expect(bugCategory!.content).toContain("ts");

    const styleCategory = categories.find(r => r.content.includes('"style"'));
    expect(styleCategory).toBeDefined();
    expect(styleCategory!.content).toContain("1 issue");
  });

  it("includes locations when category has 3 or fewer problems", () => {
    const result = extractReflections({
      ...baseInput,
      status: "published",
      problems: [
        { file: "src/a.ts", line: 10, severity: "high", category: "bug", message: "err" },
      ],
    });

    const categoryReflection = result.find(r => r.content.includes("src/a.ts:10"));
    expect(categoryReflection).toBeDefined();
  });

  it("omits locations when category has more than 3 problems", () => {
    const problems = Array.from({ length: 4 }, (_, i) => ({
      file: `src/file${i}.ts`,
      line: i + 1,
      severity: "low" as const,
      category: "style",
      message: "issue",
    }));

    const result = extractReflections({
      ...baseInput,
      status: "published",
      problems,
    });

    const categoryReflection = result.find(r => r.content.includes("Category"));
    expect(categoryReflection).toBeDefined();
    expect(categoryReflection!.content).not.toContain("src/file0.ts");
  });

  it("extracts cross-category summary when multiple categories exist", () => {
    const result = extractReflections({
      ...baseInput,
      status: "published",
      problems: [
        { file: "a.ts", line: 1, severity: "low", category: "style", message: "m" },
        { file: "b.ts", line: 2, severity: "high", category: "bug", message: "m" },
      ],
    });

    const summaryReflection = result.find(r => r.content.includes("across 2"));
    expect(summaryReflection).toBeDefined();
    expect(summaryReflection!.content).toContain("style");
    expect(summaryReflection!.content).toContain("bug");
  });

  it("extracts file type scope reflection", () => {
    const result = extractReflections({
      ...baseInput,
      status: "published",
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.js"],
    });

    const scopeReflection = result.find(r => r.content.includes("Reviewed files"));
    expect(scopeReflection).toBeDefined();
    expect(scopeReflection!.content).toContain(".ts (2)");
    expect(scopeReflection!.content).toContain(".js (1)");
    expect(scopeReflection!.content).toContain("3 files total");
  });

  it("extracts summary title reflection when present", () => {
    const result = extractReflections({
      ...baseInput,
      status: "published",
      summaries: [{ title: "Found 3 issues" }],
    });

    const titleReflection = result.find(r => r.content.includes("Latest review summary"));
    expect(titleReflection).toBeDefined();
    expect(titleReflection!.content).toContain("Found 3 issues");
  });

  it("does not extract summary title reflection when title is missing", () => {
    const result = extractReflections({
      ...baseInput,
      status: "published",
      summaries: [{ title: undefined }],
    });

    const titleReflection = result.find(r => r.content.includes("Latest review summary"));
    expect(titleReflection).toBeUndefined();
  });

  it("keeps the summary reflection fingerprint stable across runs so the latest overwrites", () => {
    const firstRun = extractReflections({
      ...baseInput,
      runId: "run-001",
      status: "published",
      summaries: [{ title: "First summary" }],
    });
    const secondRun = extractReflections({
      ...baseInput,
      runId: "run-999",
      status: "published",
      summaries: [{ title: "Second summary" }],
    });

    const first = firstRun.find(r => r.content.includes("Latest review summary"));
    const second = secondRun.find(r => r.content.includes("Latest review summary"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.fingerprint).toBe(second!.fingerprint);
    expect(second!.content).toContain("Second summary");
  });

  it("produces stable fingerprints for same workspace and category", () => {
    const result1 = extractReflections({
      ...baseInput,
      status: "published",
      problems: [
        { file: "a.ts", line: 1, severity: "low", category: "bug", message: "m" },
      ],
    });

    const result2 = extractReflections({
      ...baseInput,
      status: "published",
      problems: [
        { file: "other.ts", line: 99, severity: "high", category: "bug", message: "other" },
      ],
    });

    const fp1 = result1.find(r => r.content.includes('"bug"'))!.fingerprint;
    const fp2 = result2.find(r => r.content.includes('"bug"'))!.fingerprint;
    expect(fp1).toBe(fp2);
  });

  it("produces different fingerprints for different workspaces", () => {
    const input2 = { ...baseInput, workspaceId: "ws-2" };
    const result1 = extractReflections({
      ...baseInput,
      status: "published",
      changedFiles: ["a.ts"],
    });
    const result2 = extractReflections({
      ...input2,
      status: "published",
      changedFiles: ["a.ts"],
    });

    expect(result1[0].fingerprint).not.toBe(result2[0].fingerprint);
  });

  it("handles uncategorized problems", () => {
    const result = extractReflections({
      ...baseInput,
      status: "published",
      problems: [
        { file: "a.ts", line: 1, severity: "low", category: "", message: "m" },
      ],
    });

    const uncategorized = result.find(r => r.content.includes("uncategorized"));
    expect(uncategorized).toBeDefined();
  });

  it("handles files without extensions", () => {
    const result = extractReflections({
      ...baseInput,
      status: "published",
      changedFiles: ["Makefile", "Dockerfile"],
    });

    const scope = result.find(r => r.content.includes("Reviewed files"));
    expect(scope).toBeDefined();
    expect(scope!.content).toContain("no-ext");
  });
});

describe("extractRepositoryConventions", () => {
  const baseInput: ReflectionExtractorInput = {
    workspaceId: "ws-1",
    runId: "run-001",
    status: "published",
    problems: [],
    summaries: [],
    changedFiles: [],
  };

  it("extracts abstract repo conventions without storing problem prose or source snippets", () => {
    const result = extractRepositoryConventions({
      ...baseInput,
      problems: [
        {
          file: "packages/core/src/config.ts",
          line: 42,
          severity: "high",
          category: "api-contract",
          message: "The code `const token = \"ghp_abcdefghijklmnopqrstuvwxyz01234567890123\"` must not be stored.",
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("Repo convention:");
    expect(result[0].content).toContain("high api-contract concerns under packages/");
    expect(result[0].content).toContain("Source: packages/core/src/config.ts:42");
    expect(result[0].content).not.toContain("const token");
    expect(result[0].content).not.toContain("ghp_");
    expect(result[0].content.length).toBeLessThanOrEqual(260);
  });

  it("deduplicates conventions by category, file type, and top-level scope", () => {
    const result = extractRepositoryConventions({
      ...baseInput,
      problems: [
        { file: "packages/core/src/a.ts", line: 1, severity: "medium", category: "contract", message: "one" },
        { file: "packages/core/src/b.ts", line: 2, severity: "high", category: "contract", message: "two" },
        { file: "packages/server/src/c.ts", line: 3, severity: "high", category: "contract", message: "three" },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("high contract concerns under packages/");
    expect(result[0].content).toContain("packages/core/src/b.ts:2");
  });

  it("keeps fingerprints scoped to the workspace", () => {
    const first = extractRepositoryConventions({
      ...baseInput,
      workspaceId: "ws-1",
      problems: [{ file: "src/a.ts", line: 1, severity: "low", category: "style", message: "m" }],
    });
    const second = extractRepositoryConventions({
      ...baseInput,
      workspaceId: "ws-2",
      problems: [{ file: "src/a.ts", line: 1, severity: "low", category: "style", message: "m" }],
    });

    expect(first[0].fingerprint).not.toBe(second[0].fingerprint);
  });

  it("omits unsafe escaped locations", () => {
    const result = extractRepositoryConventions({
      ...baseInput,
      problems: [{ file: "../secret.ts", line: 7, severity: "medium", category: "security", message: "m" }],
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).not.toContain("../secret.ts");
    expect(result[0].content).not.toContain("../");
    expect(result[0].content).toContain("in repository files");
    expect(result[0].content).not.toContain("Source:");
  });
});

describe("buildMemoryHintsForPrompt", () => {
  it("orders repo conventions before generic reflections, dedupes, and caps length", () => {
    const result = buildMemoryHintsForPrompt(
      [
        { content: "Latest review summary: no issues", occurrenceCount: 9 },
        { content: "Repo convention: lower count but should be first", occurrenceCount: 1 },
        { content: "Repo convention: lower count but should be first", occurrenceCount: 1 },
        { content: `Repo convention: ${"x".repeat(400)}`, occurrenceCount: 10 },
      ],
      { maxHints: 3, maxHintLength: 80 },
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toMatch(/^Repo convention:/u);
    expect(result[1]).toMatch(/^Repo convention:/u);
    expect(result[2]).toBe("Latest review summary: no issues");
    expect(result.every((hint) => hint.length <= 80)).toBe(true);
    expect(result.filter((hint) => hint === "Repo convention: lower count but should be first")).toHaveLength(1);
  });

  it("scrubs secrets from injected memory hints", () => {
    const result = buildMemoryHintsForPrompt([
      { content: "Repo convention: token=ghp_abcdefghijklmnopqrstuvwxyz01234567890123 should be scrubbed" },
    ]);

    expect(result[0]).toMatch(/<REDACTED:[^>]+>/u);
    expect(result[0]).not.toContain("ghp_");
  });
});
describe("extractCrossRunPatterns", () => {
  const workspaceId = "ws-1";

  function categoryFingerprint(category: string): string {
    const lightResult = extractReflections({
      workspaceId,
      runId: "irrelevant",
      status: "published",
      problems: [{ file: "x.ts", line: 1, severity: "low", category, message: "m" }],
      summaries: [],
      changedFiles: [],
    });
    const categoryEntry = lightResult.find(r => r.content.includes(`"${category}"`));
    return categoryEntry!.fingerprint;
  }

  it("returns no patterns when no category meets the threshold", () => {
    const fp = categoryFingerprint("bug");
    const result = extractCrossRunPatterns(
      workspaceId,
      ["bug"],
      [{ fingerprint: fp, occurrenceCount: 2 }],
    );
    expect(result).toEqual([]);
  });

  it("detects a recurring category at or above the threshold", () => {
    const fp = categoryFingerprint("style");
    const result = extractCrossRunPatterns(
      workspaceId,
      ["style"],
      [{ fingerprint: fp, occurrenceCount: 3 }],
    );
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("style");
    expect(result[0].content).toContain("3 recent reviews");
  });

  it("uses a custom threshold", () => {
    const fp = categoryFingerprint("bug");
    const result = extractCrossRunPatterns(
      workspaceId,
      ["bug"],
      [{ fingerprint: fp, occurrenceCount: 2 }],
      { threshold: 2 },
    );
    expect(result).toHaveLength(1);
  });

  it("produces stable fingerprints for the same workspace and category", () => {
    const fp = categoryFingerprint("security");
    const result1 = extractCrossRunPatterns(
      workspaceId,
      ["security"],
      [{ fingerprint: fp, occurrenceCount: 5 }],
    );
    const result2 = extractCrossRunPatterns(
      workspaceId,
      ["security"],
      [{ fingerprint: fp, occurrenceCount: 10 }],
    );
    expect(result1[0].fingerprint).toBe(result2[0].fingerprint);
  });

  it("produces different fingerprints for different workspaces", () => {
    const fp1 = extractReflections({
      workspaceId: "ws-1",
      runId: "r",
      status: "published",
      problems: [{ file: "a.ts", line: 1, severity: "low", category: "bug", message: "m" }],
      summaries: [],
      changedFiles: [],
    }).find(r => r.content.includes('"bug"'))!.fingerprint;

    const fp2 = extractReflections({
      workspaceId: "ws-2",
      runId: "r",
      status: "published",
      problems: [{ file: "a.ts", line: 1, severity: "low", category: "bug", message: "m" }],
      summaries: [],
      changedFiles: [],
    }).find(r => r.content.includes('"bug"'))!.fingerprint;

    const result1 = extractCrossRunPatterns("ws-1", ["bug"], [{ fingerprint: fp1, occurrenceCount: 5 }]);
    const result2 = extractCrossRunPatterns("ws-2", ["bug"], [{ fingerprint: fp2, occurrenceCount: 5 }]);
    expect(result1[0].fingerprint).not.toBe(result2[0].fingerprint);
  });

  it("skips categories not present in the current run", () => {
    const fp = categoryFingerprint("style");
    const result = extractCrossRunPatterns(
      workspaceId,
      ["bug"],
      [{ fingerprint: fp, occurrenceCount: 10 }],
    );
    expect(result).toEqual([]);
  });

  it("normalizes empty category names to uncategorized", () => {
    const fp = extractReflections({
      workspaceId,
      runId: "r",
      status: "published",
      problems: [{ file: "a.ts", line: 1, severity: "low", category: "", message: "m" }],
      summaries: [],
      changedFiles: [],
    }).find(r => r.content.includes("uncategorized"))!.fingerprint;

    const result = extractCrossRunPatterns(
      workspaceId,
      [""],
      [{ fingerprint: fp, occurrenceCount: 4 }],
    );
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("uncategorized");
  });

  it("does not include secrets or file paths in content", () => {
    const fp = categoryFingerprint("bug");
    const result = extractCrossRunPatterns(
      workspaceId,
      ["bug"],
      [{ fingerprint: fp, occurrenceCount: 5 }],
    );
    expect(result[0].content).not.toMatch(/\/|secret|password|token|api[-_]?key/i);
  });
});
