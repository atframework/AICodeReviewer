import { describe, expect, it } from "vitest";

import { AicrOutputCollector, createAicrOutputToolRegistry } from "../src/index.js";

describe("AicrOutputCollector", () => {
  it("collects reported problems, summaries, skip reasons, and context requests", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(
      collector,
      async (input) => {
        return `context for ${input.path}`;
      },
      async (input) => ({
        path: input.path,
        status: "ok",
        entries: [{ line: input.range?.start_line ?? 1, revision: "abc123", author: "Alice" }],
      }),
    );
    const reportProblem = tools.find((tool) => tool.name === "aicr.report_problem");
    const publishSummary = tools.find((tool) => tool.name === "aicr.publish_summary");
    const skip = tools.find((tool) => tool.name === "aicr.skip");
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");
    const tryBlame = tools.find((tool) => tool.name === "aicr.try_blame");

    await expect(
      reportProblem?.call({
        file: "src/app.ts",
        line: 12,
        severity: "medium",
        category: "correctness",
        message: "Validate the null branch before dereferencing.",
        fingerprint: "fp-1",
      }),
    ).resolves.toEqual({ accepted: true, problemCount: 1 });
    await expect(publishSummary?.call({ title: "Concise review title", markdown: "## Summary\n\nFound one issue." })).resolves.toEqual({
      accepted: true,
      summaryCount: 1,
    });
    await expect(skip?.call({ reason: "lgtm" })).resolves.toEqual({ accepted: true, reason: "lgtm" });
    await expect(
      fetchMoreContext?.call({
        path: "src/app.ts",
        range: { start_line: 10, end_line: 20 },
        reason: "Need surrounding control flow.",
      }),
    ).resolves.toEqual({ content: "context for src/app.ts" });
    await expect(
      tryBlame?.call({
        path: "src/app.ts",
        range: { start_line: 12, end_line: 12 },
        reason: "Need VCS-verified line attribution.",
      }),
    ).resolves.toEqual({
      content: JSON.stringify(
        {
          path: "src/app.ts",
          status: "ok",
          entries: [{ line: 12, revision: "abc123", author: "Alice" }],
        },
        null,
        2,
      ),
    });

    const snapshot = collector.snapshot();
    expect(snapshot.problems).toEqual([
      {
        file: "src/app.ts",
        line: 12,
        severity: "medium",
        category: "correctness",
        message: "Validate the null branch before dereferencing.",
        fingerprint: "fp-1",
      },
    ]);
    expect(snapshot).not.toHaveProperty("findings");
    expect(snapshot).toMatchObject({
      summaries: [{ title: "Concise review title", markdown: "## Summary\n\nFound one issue." }],
      contextRequests: [
        {
          path: "src/app.ts",
          range: { start_line: 10, end_line: 20 },
          reason: "Need surrounding control flow.",
        },
      ],
      attributionRequests: [
        {
          path: "src/app.ts",
          range: { start_line: 12, end_line: 12 },
          reason: "Need VCS-verified line attribution.",
        },
      ],
      skipReason: "lgtm",
    });
  });

  it("rejects invalid tool inputs before mutating state", async () => {
    const collector = new AicrOutputCollector();
    const reportProblem = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.report_problem",
    );

    await expect(
      reportProblem?.call({
        file: "src/app.ts",
        line: 0,
        severity: "medium",
        category: "correctness",
        message: "Invalid line should be rejected.",
      }),
    ).rejects.toThrow(/line/u);
    expect(collector.snapshot().problems).toEqual([]);
  });

  it("exposes stable tool names and JSON schemas", () => {
    const tools = createAicrOutputToolRegistry();

    expect(tools.map((tool) => tool.name)).toEqual([
      "aicr.report_problem",
      "aicr.publish_summary",
      "aicr.skip",
      "aicr.fetch_more_context",
      "aicr.try_blame",
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({
      required: ["file", "line", "severity", "category", "message"],
    });
    expect(tools[1]?.inputSchema).toMatchObject({
      required: ["markdown"],
      properties: {
        markdown: { type: "string" },
        title: { type: "string" },
      },
    });
  });
});

describe("AicrOutputCollector edge cases", () => {
  it("returns empty content when fetchMoreContext handler is not provided", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");
    const tryBlame = tools.find((tool) => tool.name === "aicr.try_blame");

    const result = await fetchMoreContext?.call({
      path: "src/app.ts",
      reason: "Need more context.",
    });

    expect(result).toEqual({ content: "" });
    expect(collector.snapshot().contextRequests).toHaveLength(1);
  });

  it("rejects report_problem with missing required fields", async () => {
    const collector = new AicrOutputCollector();
    const reportProblem = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.report_problem",
    );

    await expect(reportProblem?.call({})).rejects.toThrow();
    await expect(reportProblem?.call({ file: "x.ts" })).rejects.toThrow();
    await expect(
      reportProblem?.call({ file: "x.ts", line: 1, severity: "medium", category: "c" }),
    ).rejects.toThrow(/message/u);
  });

  it("rejects report_problem with invalid severity", async () => {
    const collector = new AicrOutputCollector();
    const reportProblem = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.report_problem",
    );

    await expect(
      reportProblem?.call({
        file: "x.ts",
        line: 1,
        severity: "critical_high",
        category: "correctness",
        message: "Bad severity.",
      }),
    ).rejects.toThrow(/severity/u);
  });

  it("rejects publish_summary with missing markdown", async () => {
    const collector = new AicrOutputCollector();
    const publishSummary = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_summary",
    );

    await expect(publishSummary?.call({})).rejects.toThrow(/markdown/u);
  });

  it("rejects publish_summary with an empty title when title is provided", async () => {
    const collector = new AicrOutputCollector();
    const publishSummary = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_summary",
    );

    await expect(publishSummary?.call({ markdown: "ok", title: " " })).rejects.toThrow(/title/u);
  });

  it("rejects skip with missing reason", async () => {
    const collector = new AicrOutputCollector();
    const skip = createAicrOutputToolRegistry(collector).find((tool) => tool.name === "aicr.skip");

    await expect(skip?.call({})).rejects.toThrow(/reason/u);
  });

  it("rejects try_blame with missing path", async () => {
    const collector = new AicrOutputCollector();
    const tryBlame = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.try_blame",
    );

    await expect(tryBlame?.call({ reason: "need attribution" })).rejects.toThrow(/path/u);
  });

  it("rejects fetch_more_context with missing path", async () => {
    const collector = new AicrOutputCollector();
    const fetchMoreContext = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.fetch_more_context",
    );

    await expect(fetchMoreContext?.call({ reason: "need context" })).rejects.toThrow(/path/u);
  });

  it("returns empty content and records try_blame when no handler is provided", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const tryBlame = tools.find((tool) => tool.name === "aicr.try_blame");

    const result = await tryBlame?.call({
      path: "src/app.ts",
      range: { start_line: 2, end_line: 2 },
      reason: "Need attribution.",
    });

    expect(result).toEqual({ content: "" });
    expect(collector.snapshot().attributionRequests).toEqual([
      {
        path: "src/app.ts",
        range: { start_line: 2, end_line: 2 },
        reason: "Need attribution.",
      },
    ]);
  });

  it("accepts fetch_more_context with only path and reason (no range)", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");
    const tryBlame = tools.find((tool) => tool.name === "aicr.try_blame");

    const result = await fetchMoreContext?.call({
      path: "src/app.ts",
      reason: "full file context",
    });

    expect(result).toEqual({ content: "" });
    const snapshot = collector.snapshot();
    expect(snapshot.contextRequests[0]?.range).toBeUndefined();
  });

  it("clears review outputs while preserving context request history", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const reportProblem = tools.find((tool) => tool.name === "aicr.report_problem");
    const publishSummary = tools.find((tool) => tool.name === "aicr.publish_summary");
    const skip = tools.find((tool) => tool.name === "aicr.skip");
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");
    const tryBlame = tools.find((tool) => tool.name === "aicr.try_blame");

    await reportProblem?.call({
      file: "src/app.ts",
      line: 1,
      severity: "medium",
      category: "correctness",
      message: "Issue.",
    });
    await publishSummary?.call({ markdown: "Found one issue." });
    await skip?.call({ reason: "temporary" });
    await fetchMoreContext?.call({ path: "src/app.ts", reason: "need full file" });

    collector.clearReviewOutputs();

    expect(collector.snapshot()).toMatchObject({
      problems: [],
      summaries: [],
      contextRequests: [{ path: "src/app.ts", reason: "need full file" }],
    });
    expect(collector.snapshot().skipReason).toBeUndefined();
  });

  it("accepts reported problems with optional end_line, suggestion, and fingerprint", async () => {
    const collector = new AicrOutputCollector();
    const reportProblem = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.report_problem",
    );

    await expect(
      reportProblem?.call({
        file: "src/app.ts",
        line: 10,
        end_line: 20,
        severity: "high",
        category: "correctness",
        message: "Range issue.",
        suggestion: "Refactor this block.",
        fingerprint: "fp-range",
      }),
    ).resolves.toEqual({ accepted: true, problemCount: 1 });

    const snapshot = collector.snapshot();
    expect(snapshot.problems[0]?.end_line).toBe(20);
    expect(snapshot.problems[0]?.suggestion).toBe("Refactor this block.");
    expect(snapshot.problems[0]?.fingerprint).toBe("fp-range");
  });

  it("snapshot returns independent copies of internal state", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const reportProblem = tools.find((tool) => tool.name === "aicr.report_problem");

    await reportProblem?.call({
      file: "a.ts",
      line: 1,
      severity: "low",
      category: "style",
      message: "First.",
    });

    const snap1 = collector.snapshot();
    await reportProblem?.call({
      file: "b.ts",
      line: 2,
      severity: "low",
      category: "style",
      message: "Second.",
    });

    const snap2 = collector.snapshot();

    expect(snap1.problems).toHaveLength(1);
    expect(snap2.problems).toHaveLength(2);
  });
});

describe("AicrOutputCollector validation edge cases", () => {
  it("rejects report_problem when input is not an object", async () => {
    const collector = new AicrOutputCollector();
    const reportProblem = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.report_problem",
    );

    await expect(reportProblem?.call(null)).rejects.toThrow(/object/u);
    await expect(reportProblem?.call("string")).rejects.toThrow(/object/u);
    await expect(reportProblem?.call(42)).rejects.toThrow(/object/u);
  });

  it("rejects report_problem with empty string required fields", async () => {
    const collector = new AicrOutputCollector();
    const reportProblem = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.report_problem",
    );

    await expect(
      reportProblem?.call({
        file: "",
        line: 1,
        severity: "medium",
        category: "test",
        message: "msg",
      }),
    ).rejects.toThrow(/non-empty/u);
  });

  it("rejects report_problem with negative line number", async () => {
    const collector = new AicrOutputCollector();
    const reportProblem = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.report_problem",
    );

    await expect(
      reportProblem?.call({
        file: "a.ts",
        line: -1,
        severity: "medium",
        category: "test",
        message: "msg",
      }),
    ).rejects.toThrow(/positive integer/u);
  });

  it("rejects report_problem with zero end_line", async () => {
    const collector = new AicrOutputCollector();
    const reportProblem = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.report_problem",
    );

    await expect(
      reportProblem?.call({
        file: "a.ts",
        line: 1,
        end_line: 0,
        severity: "medium",
        category: "test",
        message: "msg",
      }),
    ).rejects.toThrow(/positive integer/u);
  });

  it("rejects fetch_more_context when input is not an object", async () => {
    const collector = new AicrOutputCollector();
    const fetchMoreContext = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.fetch_more_context",
    );

    await expect(fetchMoreContext?.call(null)).rejects.toThrow(/object/u);
    await expect(fetchMoreContext?.call([])).rejects.toThrow(/object/u);
  });

  it("rejects fetch_more_context with empty string path", async () => {
    const collector = new AicrOutputCollector();
    const fetchMoreContext = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.fetch_more_context",
    );

    await expect(fetchMoreContext?.call({ path: "", reason: "need context" })).rejects.toThrow(/non-empty/u);
  });

  it("rejects fetch_more_context with empty string reason", async () => {
    const collector = new AicrOutputCollector();
    const fetchMoreContext = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.fetch_more_context",
    );

    await expect(fetchMoreContext?.call({ path: "a.ts", reason: " " })).rejects.toThrow(/non-empty/u);
  });

  it("rejects fetch_more_context with non-integer range values", async () => {
    const collector = new AicrOutputCollector();
    const fetchMoreContext = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.fetch_more_context",
    );

    await expect(
      fetchMoreContext?.call({
        path: "a.ts",
        range: { start_line: 1.5 },
        reason: "need context",
      }),
    ).rejects.toThrow(/positive integer/u);
  });

  it("accepts all valid severity levels", async () => {
    const collector = new AicrOutputCollector();
    const reportProblem = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.report_problem",
    );

    for (const severity of ["info", "low", "medium", "high", "critical"]) {
      await expect(
        reportProblem?.call({
          file: "a.ts",
          line: 1,
          severity,
          category: "test",
          message: `${severity} issue.`,
        }),
      ).resolves.toMatchObject({ accepted: true });
    }

    expect(collector.snapshot().problems).toHaveLength(5);
  });

  it("accepts fetch_more_context with only start_line in range", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");
    const tryBlame = tools.find((tool) => tool.name === "aicr.try_blame");

    await fetchMoreContext?.call({
      path: "src/app.ts",
      range: { start_line: 5 },
      reason: "need context from this line",
    });

    const snapshot = collector.snapshot();
    expect(snapshot.contextRequests[0]?.range?.start_line).toBe(5);
    expect(snapshot.contextRequests[0]?.range?.end_line).toBeUndefined();
  });

  it("accepts fetch_more_context with only end_line in range", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");
    const tryBlame = tools.find((tool) => tool.name === "aicr.try_blame");

    await fetchMoreContext?.call({
      path: "src/app.ts",
      range: { end_line: 20 },
      reason: "need context up to this line",
    });

    const snapshot = collector.snapshot();
    expect(snapshot.contextRequests[0]?.range?.start_line).toBeUndefined();
    expect(snapshot.contextRequests[0]?.range?.end_line).toBe(20);
  });
});
