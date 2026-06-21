#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
	AicrOutputCollector,
	type AicrOutputState,
	type FetchMoreContextInput,
	type ProblemSeverity,
} from "./index.js";

const OUTPUT_STATE_PATH = process.env.AICR_OUTPUT_STATE_PATH ?? ".aicr-output-state.json";
const DEFAULT_SOURCE_DIR = join(process.cwd(), "..", "source");
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_PATH = "/mcp";
const PENDING_CONTEXT_MESSAGE = "Context request recorded. AICR will fetch the requested path from VCS and run a follow-up pass if the content is not already mounted in the sandbox.";

export interface AicrMcpServerOptions {
	readonly outputStatePath?: string;
	readonly sourceDir?: string;
}

export interface AicrMcpServerInstance {
	readonly server: McpServer;
	readonly collector: AicrOutputCollector;
	readonly outputStatePath: string;
}

export interface AicrMcpHttpServerOptions extends AicrMcpServerOptions {
	readonly host?: string;
	readonly port?: number;
	readonly path?: string;
}

export interface AicrMcpHttpServerHandle {
	readonly server: HttpServer;
	readonly url: URL;
	close(): Promise<void>;
}

interface HttpRequestLike extends IncomingMessage {
	readonly headers: IncomingHttpHeaders;
	readonly body?: unknown;
}

interface HttpResponseLike extends ServerResponse {
	readonly headersSent: boolean;
	status(code: number): HttpResponseLike;
	json(body: unknown): void;
	send(body: unknown): void;
}

interface HttpSession {
	readonly server: McpServer;
	readonly transport: StreamableHTTPServerTransport;
}

type TransportKind = "stdio" | "http";

interface CliOptions extends AicrMcpHttpServerOptions {
	readonly transport: TransportKind;
}

function resolveOutputStatePath(rawPath = OUTPUT_STATE_PATH): string {
	return isAbsolute(rawPath) ? rawPath : join(process.cwd(), rawPath);
}

function writeState(state: AicrOutputState, outputStatePath: string): void {
	writeFileSync(outputStatePath, JSON.stringify(state, null, 2), "utf8");
}

function resolveSourceContextPath(rawPath: string, sourceDir: string | undefined): string {
	const sourceRoot = resolve(sourceDir ?? process.env.AICR_SOURCE_DIR ?? DEFAULT_SOURCE_DIR);
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
	sourceDir: string | undefined,
): Promise<string> {
	try {
		const content = await readFile(resolveSourceContextPath(path, sourceDir), "utf8");
		return selectLineRange(content, range);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return "";
		}

		throw error;
	}
}

function buildContextRequest(input: {
	readonly path: string;
	readonly reason: string;
	readonly range: { readonly start_line?: number | undefined; readonly end_line?: number | undefined } | undefined;
}): FetchMoreContextInput {
	if (!input.range) {
		return { path: input.path, reason: input.reason };
	}

	return {
		path: input.path,
		reason: input.reason,
		range: {
			...(input.range.start_line !== undefined ? { start_line: input.range.start_line } : {}),
			...(input.range.end_line !== undefined ? { end_line: input.range.end_line } : {}),
		},
	};
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

export function createAicrMcpServer(options: AicrMcpServerOptions = {}): AicrMcpServerInstance {
	const outputStatePath = resolveOutputStatePath(options.outputStatePath);
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
			writeState(collector.snapshot(), outputStatePath);
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
			writeState(collector.snapshot(), outputStatePath);
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
			writeState(collector.snapshot(), outputStatePath);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		},
	);

	server.registerTool(
		"aicr.fetch_more_context",
		{
			description: "Request source context for a changed file or a related repository file (interface, type definition, caller, callee, schema, configuration). Omit range for the full file. Prefer reading the full changed file before analyzing individual hunks. For related files outside the change, tie the reason to a specific changed line or symbol. If content is not returned immediately, AICR records the request, pulls it from VCS, and runs a follow-up pass.",
			inputSchema: fetchMoreContextShape,
		},
		async (args: unknown) => {
			const a = args as {
				path: string;
				reason: string;
				range: { start_line?: number | undefined; end_line?: number | undefined } | undefined;
			};
			const request = buildContextRequest(a);
			const content = await readMountedContext(request.path, request.range, options.sourceDir);
			collector.recordContextRequest(request);
			writeState(collector.snapshot(), outputStatePath);
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify(content ? { content } : { content: "", pending: true, message: PENDING_CONTEXT_MESSAGE }),
				}],
			};
		},
	);

	return { server, collector, outputStatePath };
}

export async function runAicrMcpStdioServer(options: AicrMcpServerOptions = {}): Promise<void> {
	const { server } = createAicrMcpServer(options);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

function normalizeHttpPath(path: string | undefined): string {
	if (!path || path.trim().length === 0) {
		return DEFAULT_HTTP_PATH;
	}

	return path.startsWith("/") ? path : `/${path}`;
}

function sendJsonRpcError(res: HttpResponseLike, status: number, code: number, message: string): void {
	if (!res.headersSent) {
		res.status(status).json({
			jsonrpc: "2.0",
			error: { code, message },
			id: null,
		});
	}
}

function getSessionId(rawHeader: string | readonly string[] | undefined): string | undefined {
	if (typeof rawHeader === "string") {
		return rawHeader;
	}

	return rawHeader?.[0];
}

function buildHttpUrl(host: string, port: number, path: string): URL {
	const urlHost = host === "::" ? "[::1]" : host;
	return new URL(`http://${urlHost}:${port}${path}`);
}

export async function startAicrMcpHttpServer(
	options: AicrMcpHttpServerOptions = {},
): Promise<AicrMcpHttpServerHandle> {
	const host = options.host ?? DEFAULT_HTTP_HOST;
	const port = options.port ?? DEFAULT_HTTP_PORT;
	const path = normalizeHttpPath(options.path);
	const app = createMcpExpressApp({ host });
	const sessions = new Map<string, HttpSession>();

	app.post(path, async (req: HttpRequestLike, res: HttpResponseLike) => {
		const sessionId = getSessionId(req.headers["mcp-session-id"]);

		try {
			const existingSession = sessionId ? sessions.get(sessionId) : undefined;
			if (existingSession) {
				await existingSession.transport.handleRequest(req, res, req.body);
				return;
			}

			if (sessionId) {
				sendJsonRpcError(res, 404, -32000, "MCP session not found.");
				return;
			}

			if (!isInitializeRequest(req.body)) {
				sendJsonRpcError(res, 400, -32000, "Bad Request: initialize is required before tool requests.");
				return;
			}

			const mcp = createAicrMcpServer(options);
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (initializedSessionId) => {
					sessions.set(initializedSessionId, { server: mcp.server, transport });
				},
			});
			transport.onclose = () => {
				const closedSessionId = transport.sessionId;
				if (closedSessionId) {
					sessions.delete(closedSessionId);
				}
			};

			await mcp.server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
			await transport.handleRequest(req, res, req.body);
		} catch (error) {
			console.error("MCP Streamable HTTP request error:", error);
			sendJsonRpcError(res, 500, -32603, "Internal server error.");
		}
	});

	app.get(path, async (req: HttpRequestLike, res: HttpResponseLike) => {
		const sessionId = getSessionId(req.headers["mcp-session-id"]);
		const session = sessionId ? sessions.get(sessionId) : undefined;
		if (!session) {
			res.status(400).send("Invalid or missing MCP session ID.");
			return;
		}

		await session.transport.handleRequest(req, res);
	});

	app.delete(path, async (req: HttpRequestLike, res: HttpResponseLike) => {
		const sessionId = getSessionId(req.headers["mcp-session-id"]);
		const session = sessionId ? sessions.get(sessionId) : undefined;
		if (!session) {
			res.status(400).send("Invalid or missing MCP session ID.");
			return;
		}

		await session.transport.handleRequest(req, res);
		if (sessionId) {
			sessions.delete(sessionId);
		}
		await session.server.close();
	});

	const httpServer: HttpServer = app.listen(port, host);

	await new Promise<void>((resolvePromise, rejectPromise) => {
		httpServer.once("listening", resolvePromise);
		httpServer.once("error", rejectPromise);
	});

	const address = httpServer.address();
	const resolvedPort = typeof address === "object" && address ? address.port : port;
	const url = buildHttpUrl(host, resolvedPort, path);

	return {
		server: httpServer,
		url,
		async close(): Promise<void> {
			for (const [sessionId, session] of sessions) {
				sessions.delete(sessionId);
				await session.transport.close();
				await session.server.close();
			}

			await new Promise<void>((resolvePromise, rejectPromise) => {
				httpServer.close((error) => {
					if (error) {
						rejectPromise(error);
					} else {
						resolvePromise();
					}
				});
			});
		},
	};
}

function parseTransport(value: string | undefined): TransportKind {
	switch ((value ?? "stdio").toLowerCase()) {
		case "stdio":
			return "stdio";
		case "http":
		case "streamable-http":
			return "http";
		default:
			throw new Error(`Unsupported MCP transport: ${value}`);
	}
}

function parsePort(value: string | undefined, label: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`${label} must be an integer between 0 and 65535.`);
	}

	return port;
}

function requireArgValue(argv: readonly string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value.`);
	}

	return value;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
	let transport = parseTransport(process.env.AICR_MCP_TRANSPORT);
	let host = process.env.AICR_MCP_HOST ?? DEFAULT_HTTP_HOST;
	let port = parsePort(process.env.AICR_MCP_PORT ?? String(DEFAULT_HTTP_PORT), "AICR_MCP_PORT");
	let path = normalizeHttpPath(process.env.AICR_MCP_PATH);

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case "--stdio":
				transport = "stdio";
				break;
			case "--http":
				transport = "http";
				break;
			case "--transport":
				transport = parseTransport(requireArgValue(argv, i, arg));
				i += 1;
				break;
			case "--host":
				host = requireArgValue(argv, i, arg);
				i += 1;
				break;
			case "--port":
				port = parsePort(requireArgValue(argv, i, arg), arg);
				i += 1;
				break;
			case "--path":
				path = normalizeHttpPath(requireArgValue(argv, i, arg));
				i += 1;
				break;
			case "--help":
				console.log([
					"Usage: aicr-mcp-server [--transport stdio|http] [--host 127.0.0.1] [--port 3000] [--path /mcp]",
					"",
					"Default transport is stdio. Use --transport http or --http to start a local Streamable HTTP endpoint.",
				].join("\n"));
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg ?? ""}`);
		}
	}

	return { transport, host, port, path };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
	const options = parseCliOptions(argv);

	if (options.transport === "stdio") {
		await runAicrMcpStdioServer(options);
		return;
	}

	const handle = await startAicrMcpHttpServer(options);
	console.error(`AICR MCP Streamable HTTP server listening on ${handle.url.href}`);

	const shutdown = (): void => {
		void handle.close().finally(() => {
			process.exit(0);
		});
	};

	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error("MCP server error:", error);
		process.exit(1);
	});
}
