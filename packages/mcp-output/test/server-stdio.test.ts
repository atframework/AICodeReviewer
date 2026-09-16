import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("MCP stdio review metadata", () => {
  it("discovers and records requests through a real subprocess", async () => {
    await mkdir("build/tmp", { recursive: true });
    const root = await mkdtemp(resolve("build/tmp/review-stdio-"));
    const state = join(root, "state.json");
    const client = new Client({ name: "review-data-test", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", resolve("packages/mcp-output/src/server.ts")],
      env: { AICR_OUTPUT_STATE_PATH: state }, stderr: "pipe" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name)).toContain("aicr.get_review_commits");
      const result = await client.callTool({ name: "aicr.get_review_commits", arguments: { detail: "diffs", include_authors: true } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("pending");
      expect(JSON.parse(await readFile(state, "utf8")).reviewDataRequests).toEqual([
        { name: "aicr.get_review_commits", input: { detail: "diffs", include_authors: true, include_repositories: false, limit: 20, max_bytes: 200000 } },
      ]);
    } finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
  });
});
