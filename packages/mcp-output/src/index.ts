export const mcpOutputPackageName = "@aicr/mcp-output";

export type AicrOutputToolName =
	| "aicr.report_problem"
	| "aicr.publish_summary"
	| "aicr.skip"
	| "aicr.fetch_more_context";

export type ProblemSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ReportProblemInput {
	readonly file: string;
	readonly line: number;
	readonly end_line?: number;
	readonly severity: ProblemSeverity;
	readonly category: string;
	readonly message: string;
	readonly suggestion?: string;
	readonly fingerprint?: string;
}

export interface PublishSummaryInput {
	readonly markdown: string;
	readonly title?: string;
}

export interface SkipInput {
	readonly reason: string;
}

export interface FetchMoreContextInput {
	readonly path: string;
	readonly range?: {
		readonly start_line?: number;
		readonly end_line?: number;
	};
	readonly reason: string;
}

export interface AicrOutputState {
	readonly problems: readonly ReportProblemInput[];
	readonly summaries: readonly PublishSummaryInput[];
	readonly contextRequests: readonly FetchMoreContextInput[];
	readonly skipReason?: string;
}

export interface AicrOutputToolDefinition {
	readonly name: AicrOutputToolName;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	call(input: unknown): Promise<unknown>;
}

export type FetchMoreContextHandler = (input: FetchMoreContextInput) => Promise<string>;

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must be a non-empty string.`);
	}

	return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
	if (!Number.isInteger(value) || Number(value) < 1) {
		throw new TypeError(`${label} must be a positive integer.`);
	}

	return Number(value);
}

function parseProblem(input: unknown): ReportProblemInput {
	assertPlainObject(input, "report_problem input");
	const severity = requireString(input.severity, "severity");
	if (!["info", "low", "medium", "high", "critical"].includes(severity)) {
		throw new TypeError("severity must be one of info, low, medium, high, critical.");
	}

	return {
		file: requireString(input.file, "file"),
		line: requirePositiveInteger(input.line, "line"),
		...(input.end_line !== undefined ? { end_line: requirePositiveInteger(input.end_line, "end_line") } : {}),
		severity: severity as ProblemSeverity,
		category: requireString(input.category, "category"),
		message: requireString(input.message, "message"),
		...(input.suggestion !== undefined ? { suggestion: requireString(input.suggestion, "suggestion") } : {}),
		...(input.fingerprint !== undefined ? { fingerprint: requireString(input.fingerprint, "fingerprint") } : {}),
	};
}

function parseSummary(input: unknown): PublishSummaryInput {
	assertPlainObject(input, "publish_summary input");
	return {
		markdown: requireString(input.markdown, "markdown"),
		...(input.title !== undefined ? { title: requireString(input.title, "title") } : {}),
	};
}

function parseSkip(input: unknown): SkipInput {
	assertPlainObject(input, "skip input");
	return { reason: requireString(input.reason, "reason") };
}

function parseFetchMoreContext(input: unknown): FetchMoreContextInput {
	assertPlainObject(input, "fetch_more_context input");
	const rawRange = input.range;
	let range: FetchMoreContextInput["range"];
	if (rawRange !== undefined) {
		assertPlainObject(rawRange, "range");
		range = {
			...(rawRange.start_line !== undefined
				? { start_line: requirePositiveInteger(rawRange.start_line, "range.start_line") }
				: {}),
			...(rawRange.end_line !== undefined
				? { end_line: requirePositiveInteger(rawRange.end_line, "range.end_line") }
				: {}),
		};
	}

	return {
		path: requireString(input.path, "path"),
		...(range ? { range } : {}),
		reason: requireString(input.reason, "reason"),
	};
}

export class AicrOutputCollector {
	private readonly problems: ReportProblemInput[] = [];
	private readonly summaries: PublishSummaryInput[] = [];
	private readonly contextRequests: FetchMoreContextInput[] = [];
	private skipReasonValue: string | undefined;

	reportProblem(input: ReportProblemInput): { accepted: true; problemCount: number } {
		this.problems.push(input);
		return { accepted: true, problemCount: this.problems.length };
	}

	publishSummary(input: PublishSummaryInput): { accepted: true; summaryCount: number } {
		this.summaries.push({
			markdown: input.markdown,
			...(input.title ? { title: input.title } : {}),
		});
		return { accepted: true, summaryCount: this.summaries.length };
	}

	skip(input: SkipInput): { accepted: true; reason: string } {
		this.skipReasonValue = input.reason;
		return { accepted: true, reason: input.reason };
	}

	recordContextRequest(input: FetchMoreContextInput): void {
		this.contextRequests.push(input);
	}

	snapshot(): AicrOutputState {
		const problems = [...this.problems];
		return {
			problems,
			summaries: this.summaries.map((summary) => ({
				markdown: summary.markdown,
				...(summary.title ? { title: summary.title } : {}),
			})),
			contextRequests: [...this.contextRequests],
			...(this.skipReasonValue ? { skipReason: this.skipReasonValue } : {}),
		};
	}
}

const problemInputSchema = {
	type: "object",
	required: ["file", "line", "severity", "category", "message"],
	properties: {
		file: { type: "string" },
		line: { type: "integer", minimum: 1 },
		end_line: { type: "integer", minimum: 1 },
		severity: { enum: ["info", "low", "medium", "high", "critical"] },
		category: { type: "string" },
		message: { type: "string" },
		suggestion: { type: "string" },
		fingerprint: { type: "string" },
	},
} as const;

export function createAicrOutputToolRegistry(
	collector = new AicrOutputCollector(),
	fetchMoreContext?: FetchMoreContextHandler,
): readonly AicrOutputToolDefinition[] {
	return [
		{
			name: "aicr.report_problem",
			description: "Report one actionable code review problem anchored to a changed line.",
			inputSchema: problemInputSchema,
			async call(input: unknown) {
				return collector.reportProblem(parseProblem(input));
			},
		},
		{
			name: "aicr.publish_summary",
			description: "Publish the review summary Markdown.",
			inputSchema: {
				type: "object",
				required: ["markdown"],
				properties: {
					markdown: { type: "string" },
					title: { type: "string" },
				},
			},
			async call(input: unknown) {
				return collector.publishSummary(parseSummary(input));
			},
		},
		{
			name: "aicr.skip",
			description: "Skip output when there are no actionable problems.",
			inputSchema: {
				type: "object",
				required: ["reason"],
				properties: { reason: { type: "string" } },
			},
			async call(input: unknown) {
				return collector.skip(parseSkip(input));
			},
		},
		{
			name: "aicr.fetch_more_context",
			description: "Request bounded extra source context for a path and optional line range.",
			inputSchema: {
				type: "object",
				required: ["path", "reason"],
				properties: {
					path: { type: "string" },
					range: {
						type: "object",
						properties: {
							start_line: { type: "integer", minimum: 1 },
							end_line: { type: "integer", minimum: 1 },
						},
					},
					reason: { type: "string" },
				},
			},
			async call(input: unknown) {
				const parsed = parseFetchMoreContext(input);
				collector.recordContextRequest(parsed);
				return {
					content: fetchMoreContext ? await fetchMoreContext(parsed) : "",
				};
			},
		},
	];
}