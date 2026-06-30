import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { startAicrMcpHttpServer } from "../src/server.js";

interface TestOutputState {
	readonly problems: readonly {
		readonly file: string;
		readonly line: number;
		readonly severity: string;
		readonly category: string;
		readonly message: string;
	}[];
	readonly summaries: readonly unknown[];
	readonly contextRequests: readonly {
		readonly path: string;
		readonly reason: string;
		readonly range?: {
			readonly start_line?: number;
			readonly end_line?: number;
		};
	}[];
	readonly attributionRequests?: readonly {
		readonly path: string;
		readonly reason: string;
		readonly range?: {
			readonly start_line?: number;
			readonly end_line?: number;
		};
	}[];
}

function isTextContent(value: unknown): value is { readonly type: "text"; readonly text: string } {
	return Boolean(
		value
		&& typeof value === "object"
		&& "type" in value
		&& value.type === "text"
		&& "text" in value
		&& typeof value.text === "string",
	);
}

function parseTextJson(result: { readonly content?: readonly unknown[] }): unknown {
	const first = result.content?.[0];
	if (!isTextContent(first)) {
		throw new TypeError("Expected first MCP result content item to be text.");
	}

	return JSON.parse(first.text) as unknown;
}

describe("AICR MCP Streamable HTTP server", () => {
	it("serves AICR tools over Streamable HTTP and writes output state", async () => {
		await mkdir(join("build", "tmp"), { recursive: true });
		const tempDir = await mkdtemp(join("build", "tmp", "aicr-mcp-http-"));
		const sourceDir = resolve(tempDir, "source");
		const outputStatePath = resolve(tempDir, ".aicr-output-state.json");
		await mkdir(join(sourceDir, "src"), { recursive: true });
		await writeFile(join(sourceDir, "src", "app.ts"), "one\ntwo\nthree\nfour\n", "utf8");

		const handle = await startAicrMcpHttpServer({
			host: "127.0.0.1",
			port: 0,
			outputStatePath,
			sourceDir,
		});
		const client = new Client({ name: "aicr-http-test", version: "0.1.0" }, { capabilities: {} });
		let clientConnected = false;

		try {
			await client.connect(new StreamableHTTPClientTransport(handle.url));
			clientConnected = true;

			const tools = await client.listTools();
			expect(tools.tools.map((tool) => tool.name)).toEqual([
				"aicr.report_problem",
				"aicr.publish_summary",
				"aicr.skip",
				"aicr.fetch_more_context",
				"aicr.try_blame",
			]);

			const reportResult = await client.callTool(
				{
					name: "aicr.report_problem",
					arguments: {
						file: "src/app.ts",
						line: 2,
						severity: "medium",
						category: "correctness",
						message: "The changed branch can skip validation.",
					},
				},
				CallToolResultSchema,
			);
			expect(parseTextJson(reportResult)).toEqual({ accepted: true, problemCount: 1 });

			const contextResult = await client.callTool(
				{
					name: "aicr.fetch_more_context",
					arguments: {
						path: "src/app.ts",
						range: { start_line: 2, end_line: 3 },
						reason: "Need the changed branch and following line.",
					},
				},
				CallToolResultSchema,
			);
			expect(parseTextJson(contextResult)).toEqual({ content: "two\nthree" });

			const blameResult = await client.callTool(
				{
					name: "aicr.try_blame",
					arguments: {
						path: "src/app.ts",
						range: { start_line: 2, end_line: 2 },
						reason: "Need verified attribution for this changed line.",
					},
				},
				CallToolResultSchema,
			);
			expect(parseTextJson(blameResult)).toMatchObject({ pending: true, content: "" });

			const state = JSON.parse(await readFile(outputStatePath, "utf8")) as TestOutputState;
			expect(state.problems).toEqual([
				{
					file: "src/app.ts",
					line: 2,
					severity: "medium",
					category: "correctness",
					message: "The changed branch can skip validation.",
				},
			]);
			expect(state.summaries).toEqual([]);
			expect(state.contextRequests).toEqual([
				{
					path: "src/app.ts",
					reason: "Need the changed branch and following line.",
					range: { start_line: 2, end_line: 3 },
				},
			]);
			expect(state.attributionRequests).toEqual([
				{
					path: "src/app.ts",
					reason: "Need verified attribution for this changed line.",
					range: { start_line: 2, end_line: 2 },
				},
			]);
		} finally {
			if (clientConnected) {
				await client.close();
			}
			await handle.close();
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
