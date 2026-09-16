import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { AicrOutputCollector, createAicrOutputToolRegistry } from "../src/index.js";

describe("review data registry", () => {
  it("accepts the shipped review-query example through the real registry", async () => {
    const example = JSON.parse(await readFile(new URL("../../../example/mcp-review-queries.json", import.meta.url), "utf8"));
    const tools = createAicrOutputToolRegistry(undefined, undefined, undefined, async () => ({ status: "complete" }));
    for (const call of example.toolCalls) {
      const tool = tools.find(tool => tool.name === call.name);
      expect(tool).toBeDefined();
      await expect(tool!.call(call.input)).resolves.toHaveProperty("content");
    }
  });
  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { max_bytes: 0 }, { max_bytes: 1048577 },
    { include_authors: "true" }, { include_repositories: 1 }, { detail: "all" }, { revision: "arbitrary" }, { cursor: "" },
    { cursor: "x".repeat(4097) }])("rejects invalid input %j before recording/reading", async input => {
    const collector = new AicrOutputCollector();
    const read = vi.fn();
    const tool = createAicrOutputToolRegistry(collector, undefined, undefined, read).find(tool => tool.name === "aicr.get_review_commits")!;
    await expect(tool.call(input)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(collector.snapshot().reviewDataRequests).toBeUndefined();
  });
  it("executes normalized requests through the host handler and preserves requests across output clearing", async () => {
    const collector = new AicrOutputCollector();
    const read = vi.fn(async () => ({ status: "complete", commits: [{ revision: "abc" }] }));
    const tool = createAicrOutputToolRegistry(collector, undefined, undefined, read).find(tool => tool.name === "aicr.get_review_commits")!;
    const result = await tool.call({ detail: "files", include_authors: true });
    expect(result).toEqual({ content: JSON.stringify({ status: "complete", commits: [{ revision: "abc" }] }, null, 2) });
    expect(read).toHaveBeenCalledWith({ name: "aicr.get_review_commits", input: {
      detail: "files", include_authors: true, include_repositories: false, limit: 20, max_bytes: 200000 } });
    collector.clearReviewOutputs();
    expect(collector.snapshot().reviewDataRequests).toHaveLength(1);
  });
  it("rejects context arguments and does not manufacture metadata without a host", async () => {
    const tools = createAicrOutputToolRegistry();
    await expect(tools.find(tool => tool.name === "aicr.get_review_context")!.call({ repository: "elsewhere" })).rejects.toThrow();
    await expect(tools.find(tool => tool.name === "aicr.get_review_commits")!.call({})).rejects.toThrow("outside an active review");
  });
});
