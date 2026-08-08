import { createHash } from "node:crypto";

export const mcpOutputPackageName = "@aicr/mcp-output";

export type AicrOutputToolName =
	| "aicr.report_problem"
	| "aicr.publish_summary"
	| "aicr.skip"
	| "aicr.fetch_more_context"
	| "aicr.try_blame";

export const AICR_OUTPUT_TOOL_DESCRIPTIONS: Readonly<Record<AicrOutputToolName, string>> = {
	"aicr.report_problem": "Report one concrete problem introduced or worsened by the change, anchored to a changed line with a realistic trigger. Call once per discrete issue; omit praise, style-only preferences, and speculation.",
	"aicr.publish_summary": "Publish one concise final summary after all problem reports. Roll up the reported problems and material uncertainty; do not recap code that was checked and found correct or claim unreported problems.",
	"aicr.skip": "End the review without other output when there are no actionable problems (lgtm) or no reviewable code (no_reviewable_code).",
	"aicr.fetch_more_context": "Read a changed file or a narrowly related contract, caller, schema, or configuration needed to validate a finding. Omit range for the full file and give a specific reason.",
	"aicr.try_blame": "Request best-effort VCS attribution for a bounded file range. This returns attribution metadata, not source content; do not infer authorship from prose.",
};

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

export interface TryBlameInput {
	readonly path: string;
	readonly range?: {
		readonly start_line?: number;
		readonly end_line?: number;
	};
	readonly reason: string;
}

export interface TryBlameEntry {
	readonly line: number;
	readonly revision?: string;
	readonly author?: string;
	readonly authorEmail?: string;
	readonly summary?: string;
}

export type TryBlameStatus = "ok" | "not_found" | "partial";

export interface TryBlameResult {
	readonly path: string;
	readonly status: TryBlameStatus;
	readonly entries: readonly TryBlameEntry[];
}

export interface AicrOutputState {
	readonly problems: readonly ReportProblemInput[];
	readonly summaries: readonly PublishSummaryInput[];
	readonly contextRequests: readonly FetchMoreContextInput[];
	readonly attributionRequests?: readonly TryBlameInput[];
	readonly skipReason?: string;
}

export interface AicrOutputToolDefinition {
	readonly name: AicrOutputToolName;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	call(input: unknown): Promise<unknown>;
}

export type FetchMoreContextHandler = (input: FetchMoreContextInput) => Promise<string>;
export type TryBlameHandler = (input: TryBlameInput) => Promise<TryBlameResult>;

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

function computeReportProblemFingerprint(problem: ReportProblemInput): string {
	if (problem.fingerprint) {
		return problem.fingerprint;
	}
	const raw = `${problem.file}:${problem.line}:${problem.category}:${problem.message}`;
	return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function parseRange(input: Record<string, unknown>, label: string): { readonly start_line?: number; readonly end_line?: number } | undefined {
	const rawRange = input.range;
	if (rawRange === undefined) {
		return undefined;
	}

	assertPlainObject(rawRange, label);
	return {
		...(rawRange.start_line !== undefined
			? { start_line: requirePositiveInteger(rawRange.start_line, `${label}.start_line`) }
			: {}),
		...(rawRange.end_line !== undefined
			? { end_line: requirePositiveInteger(rawRange.end_line, `${label}.end_line`) }
			: {}),
	};
}

function parseFetchMoreContext(input: unknown): FetchMoreContextInput {
	assertPlainObject(input, "fetch_more_context input");
	const range = parseRange(input, "range");

	return {
		path: requireString(input.path, "path"),
		...(range ? { range } : {}),
		reason: requireString(input.reason, "reason"),
	};
}

function parseTryBlame(input: unknown): TryBlameInput {
	assertPlainObject(input, "try_blame input");
	const range = parseRange(input, "range");

	return {
		path: requireString(input.path, "path"),
		...(range ? { range } : {}),
		reason: requireString(input.reason, "reason"),
	};
}

export class AicrOutputCollector {
	private readonly problems: ReportProblemInput[] = [];
	private readonly fingerprints: Set<string> = new Set();
	private readonly summaries: PublishSummaryInput[] = [];
	private readonly contextRequests: FetchMoreContextInput[] = [];
	private readonly attributionRequests: TryBlameInput[] = [];
	private skipReasonValue: string | undefined;

	reportProblem(input: ReportProblemInput): { accepted: true; problemCount: number } {
		const fp = computeReportProblemFingerprint(input);
		if (this.fingerprints.has(fp)) {
			return { accepted: true, problemCount: this.problems.length };
		}
		this.fingerprints.add(fp);
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

	recordAttributionRequest(input: TryBlameInput): void {
		this.attributionRequests.push(input);
	}

	clearReviewOutputs(): void {
		this.problems.length = 0;
		this.fingerprints.clear();
		this.summaries.length = 0;
		this.skipReasonValue = undefined;
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
			...(this.attributionRequests.length > 0 ? { attributionRequests: [...this.attributionRequests] } : {}),
			...(this.skipReasonValue ? { skipReason: this.skipReasonValue } : {}),
		};
	}
}

const contextRangeSchema = {
	type: "object",
	properties: {
		start_line: { type: "integer", minimum: 1 },
		end_line: { type: "integer", minimum: 1 },
	},
} as const;

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
	tryBlame?: TryBlameHandler,
): readonly AicrOutputToolDefinition[] {
	return [
		{
			name: "aicr.report_problem",
			description: AICR_OUTPUT_TOOL_DESCRIPTIONS["aicr.report_problem"],
			inputSchema: problemInputSchema,
			async call(input: unknown) {
				return collector.reportProblem(parseProblem(input));
			},
		},
		{
			name: "aicr.publish_summary",
			description: AICR_OUTPUT_TOOL_DESCRIPTIONS["aicr.publish_summary"],
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
			description: AICR_OUTPUT_TOOL_DESCRIPTIONS["aicr.skip"],
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
			description: AICR_OUTPUT_TOOL_DESCRIPTIONS["aicr.fetch_more_context"],
			inputSchema: {
				type: "object",
				required: ["path", "reason"],
				properties: {
					path: { type: "string" },
					range: contextRangeSchema,
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
		{
			name: "aicr.try_blame",
			description: AICR_OUTPUT_TOOL_DESCRIPTIONS["aicr.try_blame"],
			inputSchema: {
				type: "object",
				required: ["path", "reason"],
				properties: {
					path: { type: "string" },
					range: contextRangeSchema,
					reason: { type: "string" },
				},
			},
			async call(input: unknown) {
				const parsed = parseTryBlame(input);
				collector.recordAttributionRequest(parsed);
				return {
					content: tryBlame ? JSON.stringify(await tryBlame(parsed), null, 2) : "",
				};
			},
		},
	];
}
