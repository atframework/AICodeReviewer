#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import {
	AicrOutputCollector,
	type AicrOutputState,
	type ProblemSeverity,
} from "./index.js";

const OUTPUT_STATE_PATH = process.env.AICR_OUTPUT_STATE_PATH ?? ".aicr-output-state.json";
const DEFAULT_SOURCE_DIR = join(process.cwd(), "..", "source");
const PENDING_CONTEXT_MESSAGE = "Context request recorded. AICR will fetch the requested path from VCS and run a follow-up pass if the content is not already mounted in the sandbox.";

function writeState(state: AicrOutputState): void {
	const outputPath = join(process.cwd(), OUTPUT_STATE_PATH);
	writeFileSync(outputPath, JSON.stringify(state, null, 2), "utf8");
}

function resolveSourceContextPath(rawPath: string): string {
	const sourceRoot = resolve(process.env.AICR_SOURCE_DIR ?? DEFAULT_SOURCE_DIR);
	const requestedPath = resolve(sourceRoot, rawPath);
	const sourceRelativePath = relative(sourceRoot, requestedPath);

	if (sourceRelativePath.startsWith("..") || isAbsolute(sourceRelativePath)) {
		throw new RangeError("fetch_more_context path must stay inside the mounted source workspace.");
	}

	return requestedPath;
}

function selectLineRange(
	content: string,
	range: { readonly start_line?: number | undefined; readonly end_line?: number | undefined } | undefined,
): string {
	if (!range) return content;

	const lines = content.split(/\r?\n/u);
	const startLine = range.start_line ?? 1;
	const endLine = range.end_line ?? lines.length;
	if (startLine > endLine) {
		throw new RangeError("range.start_line must be less than or equal to range.end_line.");
	}

	return lines.slice(startLine - 1, endLine).join("\n");
}

async function readMountedContext(
	path: string,
	range: { readonly start_line?: number | undefined; readonly end_line?: number | undefined } | undefined,
): Promise<string> {
	try {
		const content = await readFile(resolveSourceContextPath(path), "utf8");
		return selectLineRange(content, range);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return "";
		}

		throw error;
	}
}

const severitySchema = z.enum(["info", "low", "medium", "high", "critical"]);

const reportProblemShape = {
	file: z.string().min(1),
	line: z.number().int().positive(),
	end_line: z.number().int().positive().optional(),
	severity: severitySchema,
	category: z.string().min(1),
	message: z.string().min(1),
	suggestion: z.string().optional(),
	fingerprint: z.string().optional(),
};

const publishSummaryShape = {
	markdown: z.string().min(1),
	title: z.string().optional(),
};

const skipShape = {
	reason: z.string().min(1),
};

const fetchMoreContextShape = {
	path: z.string().min(1),
	reason: z.string().min(1),
	range: z.object({
		start_line: z.number().int().positive().optional(),
		end_line: z.number().int().positive().optional(),
	}).optional(),
};

async function main(): Promise<void> {
	const server = new McpServer({
		name: "aicr-output",
		version: "0.1.0",
	});

	const collector = new AicrOutputCollector();

	server.registerTool(
		"aicr.report_problem",
		{
			description: "Report one actionable code review problem anchored to a changed line.",
			inputSchema: reportProblemShape,
		},
		async (args: unknown) => {
			const a = args as {
				file: string;
				line: number;
				end_line: number | undefined;
				severity: ProblemSeverity;
				category: string;
				message: string;
				suggestion: string | undefined;
				fingerprint: string | undefined;
			};
			const result = collector.reportProblem({
				file: a.file,
				line: a.line,
				...(a.end_line !== undefined ? { end_line: a.end_line } : {}),
				severity: a.severity,
				category: a.category,
				message: a.message,
				...(a.suggestion !== undefined ? { suggestion: a.suggestion } : {}),
				...(a.fingerprint !== undefined ? { fingerprint: a.fingerprint } : {}),
			});
			writeState(collector.snapshot());
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		},
	);

	server.registerTool(
		"aicr.publish_summary",
		{
			description: "Publish the review summary Markdown.",
			inputSchema: publishSummaryShape,
		},
		async (args: unknown) => {
			const a = args as { markdown: string; title: string | undefined };
			const result = collector.publishSummary({
				markdown: a.markdown,
				...(a.title !== undefined ? { title: a.title } : {}),
			});
			writeState(collector.snapshot());
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		},
	);

	server.registerTool(
		"aicr.skip",
		{
			description: "Skip output when there are no actionable problems.",
			inputSchema: skipShape,
		},
		async (args: unknown) => {
			const a = args as { reason: string };
			const result = collector.skip(a);
			writeState(collector.snapshot());
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		},
	);

	server.registerTool(
		"aicr.fetch_more_context",
		{
			description: "Request source context for a changed file or narrowly related repository file; omit range for the full file. If content is not returned immediately, AICR records the request, pulls it from VCS, and runs a follow-up pass.",
			inputSchema: fetchMoreContextShape,
		},
		async (args: unknown) => {
			const a = args as {
				path: string;
				reason: string;
				range: { start_line?: number | undefined; end_line?: number | undefined } | undefined;
			};
			const { path, range, reason } = a;
			const content = await readMountedContext(path, range);
			collector.recordContextRequest(
				range
					? {
							path,
							reason,
							...(range.start_line !== undefined ? { range: { start_line: range.start_line } } : {}),
							...(range.end_line !== undefined
								? {
										range: {
											...(range.start_line !== undefined ? { start_line: range.start_line } : {}),
											end_line: range.end_line,
										},
									}
								: {}),
						}
					: { path, reason },
			);
			writeState(collector.snapshot());
			return {
					content: [{
						type: "text" as const,
						text: JSON.stringify(content ? { content } : { content: "", pending: true, message: PENDING_CONTEXT_MESSAGE }),
					}],
			};
		},
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	console.error("MCP server error:", error);
	process.exit(1);
});
