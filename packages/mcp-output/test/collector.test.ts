import { describe, expect, it } from "vitest";

import { AicrOutputCollector, createAicrOutputToolRegistry } from "../src/index.js";

describe("AicrOutputCollector", () => {
  it("collects findings, summaries, skip reasons, and context requests", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector, async (input) => {
      return `context for ${input.path}`;
    });
    const publishFinding = tools.find((tool) => tool.name === "aicr.publish_finding");
    const publishSummary = tools.find((tool) => tool.name === "aicr.publish_summary");
    const skip = tools.find((tool) => tool.name === "aicr.skip");
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");

    await expect(
      publishFinding?.call({
        file: "src/app.ts",
        line: 12,
        severity: "medium",
        category: "correctness",
        message: "Validate the null branch before dereferencing.",
        fingerprint: "fp-1",
      }),
    ).resolves.toEqual({ accepted: true, findingCount: 1 });
    await expect(publishSummary?.call({ markdown: "## Summary\n\nFound one issue." })).resolves.toEqual({
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

    expect(collector.snapshot()).toEqual({
      findings: [
        {
          file: "src/app.ts",
          line: 12,
          severity: "medium",
          category: "correctness",
          message: "Validate the null branch before dereferencing.",
          fingerprint: "fp-1",
        },
      ],
      summaries: ["## Summary\n\nFound one issue."],
      contextRequests: [
        {
          path: "src/app.ts",
          range: { start_line: 10, end_line: 20 },
          reason: "Need surrounding control flow.",
        },
      ],
      skipReason: "lgtm",
    });
  });

  it("rejects invalid tool inputs before mutating state", async () => {
    const collector = new AicrOutputCollector();
    const publishFinding = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_finding",
    );

    await expect(
      publishFinding?.call({
        file: "src/app.ts",
        line: 0,
        severity: "medium",
        category: "correctness",
        message: "Invalid line should be rejected.",
      }),
    ).rejects.toThrow(/line/u);
    expect(collector.snapshot().findings).toEqual([]);
  });

  it("exposes stable tool names and JSON schemas", () => {
    const tools = createAicrOutputToolRegistry();

    expect(tools.map((tool) => tool.name)).toEqual([
      "aicr.publish_finding",
      "aicr.publish_summary",
      "aicr.skip",
      "aicr.fetch_more_context",
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({
      required: ["file", "line", "severity", "category", "message"],
    });
  });
});

describe("AicrOutputCollector edge cases", () => {
  it("returns empty content when fetchMoreContext handler is not provided", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");

    const result = await fetchMoreContext?.call({
      path: "src/app.ts",
      reason: "Need more context.",
    });

    expect(result).toEqual({ content: "" });
    expect(collector.snapshot().contextRequests).toHaveLength(1);
  });

  it("rejects publish_finding with missing required fields", async () => {
    const collector = new AicrOutputCollector();
    const publishFinding = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_finding",
    );

    await expect(publishFinding?.call({})).rejects.toThrow();
    await expect(publishFinding?.call({ file: "x.ts" })).rejects.toThrow();
    await expect(
      publishFinding?.call({ file: "x.ts", line: 1, severity: "medium", category: "c" }),
    ).rejects.toThrow(/message/u);
  });

  it("rejects publish_finding with invalid severity", async () => {
    const collector = new AicrOutputCollector();
    const publishFinding = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_finding",
    );

    await expect(
      publishFinding?.call({
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

  it("rejects skip with missing reason", async () => {
    const collector = new AicrOutputCollector();
    const skip = createAicrOutputToolRegistry(collector).find((tool) => tool.name === "aicr.skip");

    await expect(skip?.call({})).rejects.toThrow(/reason/u);
  });

  it("rejects fetch_more_context with missing path", async () => {
    const collector = new AicrOutputCollector();
    const fetchMoreContext = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.fetch_more_context",
    );

    await expect(fetchMoreContext?.call({ reason: "need context" })).rejects.toThrow(/path/u);
  });

  it("accepts fetch_more_context with only path and reason (no range)", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");

    const result = await fetchMoreContext?.call({
      path: "src/app.ts",
      reason: "full file context",
    });

    expect(result).toEqual({ content: "" });
    const snapshot = collector.snapshot();
    expect(snapshot.contextRequests[0]?.range).toBeUndefined();
  });

  it("accepts findings with optional end_line, suggestion, and fingerprint", async () => {
    const collector = new AicrOutputCollector();
    const publishFinding = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_finding",
    );

    await expect(
      publishFinding?.call({
        file: "src/app.ts",
        line: 10,
        end_line: 20,
        severity: "high",
        category: "correctness",
        message: "Range issue.",
        suggestion: "Refactor this block.",
        fingerprint: "fp-range",
      }),
    ).resolves.toEqual({ accepted: true, findingCount: 1 });

    const snapshot = collector.snapshot();
    expect(snapshot.findings[0]?.end_line).toBe(20);
    expect(snapshot.findings[0]?.suggestion).toBe("Refactor this block.");
    expect(snapshot.findings[0]?.fingerprint).toBe("fp-range");
  });

  it("snapshot returns independent copies of internal state", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const publishFinding = tools.find((tool) => tool.name === "aicr.publish_finding");

    await publishFinding?.call({
      file: "a.ts",
      line: 1,
      severity: "low",
      category: "style",
      message: "First.",
    });

    const snap1 = collector.snapshot();
    await publishFinding?.call({
      file: "b.ts",
      line: 2,
      severity: "low",
      category: "style",
      message: "Second.",
    });

    const snap2 = collector.snapshot();

    expect(snap1.findings).toHaveLength(1);
    expect(snap2.findings).toHaveLength(2);
  });
});

describe("AicrOutputCollector validation edge cases", () => {
  it("rejects publish_finding when input is not an object", async () => {
    const collector = new AicrOutputCollector();
    const publishFinding = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_finding",
    );

    await expect(publishFinding?.call(null)).rejects.toThrow(/object/u);
    await expect(publishFinding?.call("string")).rejects.toThrow(/object/u);
    await expect(publishFinding?.call(42)).rejects.toThrow(/object/u);
  });

  it("rejects publish_finding with empty string required fields", async () => {
    const collector = new AicrOutputCollector();
    const publishFinding = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_finding",
    );

    await expect(
      publishFinding?.call({
        file: "",
        line: 1,
        severity: "medium",
        category: "test",
        message: "msg",
      }),
    ).rejects.toThrow(/non-empty/u);
  });

  it("rejects publish_finding with negative line number", async () => {
    const collector = new AicrOutputCollector();
    const publishFinding = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_finding",
    );

    await expect(
      publishFinding?.call({
        file: "a.ts",
        line: -1,
        severity: "medium",
        category: "test",
        message: "msg",
      }),
    ).rejects.toThrow(/positive integer/u);
  });

  it("rejects publish_finding with zero end_line", async () => {
    const collector = new AicrOutputCollector();
    const publishFinding = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_finding",
    );

    await expect(
      publishFinding?.call({
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
    const publishFinding = createAicrOutputToolRegistry(collector).find(
      (tool) => tool.name === "aicr.publish_finding",
    );

    for (const severity of ["info", "low", "medium", "high", "critical"]) {
      await expect(
        publishFinding?.call({
          file: "a.ts",
          line: 1,
          severity,
          category: "test",
          message: `${severity} issue.`,
        }),
      ).resolves.toMatchObject({ accepted: true });
    }

    expect(collector.snapshot().findings).toHaveLength(5);
  });

  it("accepts fetch_more_context with only start_line in range", async () => {
    const collector = new AicrOutputCollector();
    const tools = createAicrOutputToolRegistry(collector);
    const fetchMoreContext = tools.find((tool) => tool.name === "aicr.fetch_more_context");

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
