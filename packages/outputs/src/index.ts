import { createHash } from "node:crypto";

import { renderMarkdownCodeFence } from "./template-engine.js";
import { toFeishuMarkdown, toWeComMarkdown } from "./im-markdown.js";

export const outputsPackageName = "@aicr/outputs";

export {
	clearTemplateCache,
	createTemplateResolver,
	getBuiltinTemplate,
	renderBuiltinTemplate,
	renderTemplate,
	renderMarkdownCodeFence,
	buildTemplateTargetContext,
	toTemplateProblem,
	type BuildTemplateTargetOptions,
	type TemplateContext,
	type TemplateProblem,
	type TemplateKind,
	type TemplateTarget,
	type TemplateTargetKind,
	type TemplateResolver,
	type TemplateResolverOptions,
} from "./template-engine.js";

export {
	toFeishuMarkdown,
	toWeComMarkdown,
	toDingTalkMarkdown,
	toSlackMarkdown,
} from "./im-markdown.js";

export {
	buildAtMentions,
	renderMentions,
	resolveAuthorUsername,
	type AuthorMentionContext,
	type AuthorResolutionOptions,
	type MentionChannelKind,
} from "./author-resolution.js";

export type ProblemSeverity = "info" | "low" | "medium" | "high" | "critical";

const SEVERITY_RANK: Readonly<Record<ProblemSeverity, number>> = {
	info: 1,
	low: 2,
	medium: 3,
	high: 4,
	critical: 5,
};

export function getHighestSeverity(problems: readonly ReviewProblem[]): ProblemSeverity | undefined {
	let best: ProblemSeverity | undefined;
	let bestRank = 0;
	for (const p of problems) {
		const rank = SEVERITY_RANK[p.severity] ?? 0;
		if (rank > bestRank) {
			bestRank = rank;
			best = p.severity;
		}
	}
	return best;
}

export interface ReviewProblem {
	readonly file: string;
	readonly line: number;
	readonly endLine?: number;
	readonly lineCommentAllowed?: boolean;
	readonly severity: ProblemSeverity;
	readonly category: string;
	readonly message: string;
	readonly suggestion?: string;
	readonly codeSnippet?: string;
	readonly codeLanguage?: string;
	readonly fingerprint?: string;
	readonly renderedMarkdown?: string;
}

export interface DispatchResult {
	readonly channel: string;
	readonly status: "published";
	readonly externalId?: string;
	readonly raw: unknown;
}

export interface ResponseLike {
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

export type FetchLike = (
	input: string,
	init?: {
		readonly method?: string;
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: string;
	},
) => Promise<ResponseLike>;

export type ReviewMode = "auto" | "review" | "comment";
export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";
export type ReviewUpdateStrategy = "always_new" | "update_existing";

const AICR_REVIEW_SUMMARY_MARKER = "<!-- aicr:managed=pr-review -->";

function hasManagedReviewSummaryMarker(body: string): boolean {
	return body.includes(AICR_REVIEW_SUMMARY_MARKER);
}

const AICR_REVIEW_PROBLEMS_RE = /<!--\s*aicr:problems=([^\s]*)\s*-->/u;

function extractReviewSummaryFingerprints(body: string): ReadonlySet<string> {
	const match = AICR_REVIEW_PROBLEMS_RE.exec(body);
	if (!match?.[1]) {
		return new Set();
	}
	return new Set(match[1].split(",").filter((fp) => fp.length > 0));
}

function buildReviewSummaryProblemMarker(fingerprints: ReadonlySet<string>): string {
	if (fingerprints.size === 0) {
		return "<!-- aicr:problems= -->";
	}
	return `<!-- aicr:problems=${[...fingerprints].join(",")} -->`;
}

function buildProblemLocation(problem: { readonly file: string; readonly line: number; readonly endLine?: number }): string {
	return problem.endLine ? `${problem.file}:${problem.line}-${problem.endLine}` : `${problem.file}:${problem.line}`;
}

function categorizeProblems(
	currentProblems: readonly ReviewProblem[],
	previousFingerprints: ReadonlySet<string>,
): {
		readonly newProblems: readonly ReviewProblem[];
		readonly stillOpenProblems: readonly ReviewProblem[];
		readonly resolvedFingerprints: ReadonlySet<string>;
	} {
	const currentFingerprints = new Set<string>();
	const newProblems: ReviewProblem[] = [];
	const stillOpenProblems: ReviewProblem[] = [];

	for (const problem of currentProblems) {
		const fp = problem.fingerprint ?? computeProblemFingerprint(problem);
		currentFingerprints.add(fp);
		if (previousFingerprints.has(fp)) {
			stillOpenProblems.push(problem);
		} else {
			newProblems.push(problem);
		}
	}

	const resolvedFingerprints = new Set<string>();
	for (const fp of previousFingerprints) {
		if (!currentFingerprints.has(fp)) {
			resolvedFingerprints.add(fp);
		}
	}

	return { newProblems, stillOpenProblems, resolvedFingerprints };
}

function buildReviewSummarySections(
	categorized: {
		readonly newProblems: readonly ReviewProblem[];
		readonly stillOpenProblems: readonly ReviewProblem[];
		readonly resolvedFingerprints: ReadonlySet<string>;
	},
	renderedSummary: string,
	headSha?: string,
): string {
	const parts: string[] = [];
	const timestamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/u, " UTC");
	const commitSuffix = headSha ? ` | Commit: \`${headSha.slice(0, 7)}\`` : "";

	parts.push(`> Updated: ${timestamp}${commitSuffix}`);
	parts.push("");

	if (renderedSummary.trim()) {
		parts.push(renderedSummary.trim());
		parts.push("");
	}

	const allCurrent = [...categorized.stillOpenProblems, ...categorized.newProblems];
	if (allCurrent.length > 0) {
		parts.push(`### Open Issues (${allCurrent.length})`);
		parts.push("");
		let idx = 1;
		for (const problem of categorized.stillOpenProblems) {
			const location = buildProblemLocation(problem);
			parts.push(`${idx}. **[${problem.severity.toUpperCase()}] ${problem.category}** — \`${location}\``);
			idx += 1;
		}
		for (const problem of categorized.newProblems) {
			const location = buildProblemLocation(problem);
			const commitTag = headSha ? ` *(new in \`${headSha.slice(0, 7)}\`)*` : " *(new)*";
			parts.push(`${idx}. **[${problem.severity.toUpperCase()}] ${problem.category}** — \`${location}\`${commitTag}`);
			idx += 1;
		}
		parts.push("");
	}

	if (categorized.resolvedFingerprints.size > 0) {
		parts.push(`<details>`);
		parts.push(`<summary>Resolved (${categorized.resolvedFingerprints.size})</summary>`);
		parts.push("");
		parts.push("The following previously reported issues are no longer present:");
		parts.push("");
		for (const fp of categorized.resolvedFingerprints) {
			parts.push(`- ~~\`${fp}\`~~ ✅ Resolved`);
		}
		parts.push("");
		parts.push("</details>");
		parts.push("");
	}

	return normalizeMarkdownBody(parts.join("\n"));
}

function buildReviewSummaryCommentBody(
	renderedSummary: string,
	problems: readonly ReviewProblem[],
	previousFingerprints: ReadonlySet<string>,
	channel: string,
	headSha?: string,
): string {
	const categorized = categorizeProblems(problems, previousFingerprints);
	const currentFingerprints = new Set<string>();
	for (const problem of problems) {
		currentFingerprints.add(problem.fingerprint ?? computeProblemFingerprint(problem));
	}
	const scopeFingerprint = channel;

	const sections = buildReviewSummarySections(categorized, renderedSummary, headSha);

	const body = [
		AICR_REVIEW_SUMMARY_MARKER,
		`<!-- aicr:scope=${scopeFingerprint} -->`,
		buildReviewSummaryProblemMarker(currentFingerprints),
		"",
		"## AI Code Review",
		"",
		sections,
	].join("\n");

	return normalizeMarkdownBody(body);
}

function updateReviewSummaryBody(
	existingBody: string,
	renderedSummary: string,
	problems: readonly ReviewProblem[],
	headSha?: string,
): string {
	const previousFingerprints = extractReviewSummaryFingerprints(existingBody);
	const scopeMatch = /<!--\s*aicr:scope=([^\s]*)\s*-->/u.exec(existingBody);
	const channel = scopeMatch?.[1] ?? "unknown";

	const newBody = buildReviewSummaryCommentBody(renderedSummary, problems, previousFingerprints, channel, headSha);
	return newBody;
}

interface ManagedReviewComment {
	readonly id: number;
	readonly body: string;
}

function parseManagedReviewComments(raw: unknown): readonly ManagedReviewComment[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const comments: ManagedReviewComment[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const obj = entry as Record<string, unknown>;
		const id = obj.id;
		const body = String(obj.body ?? "");
		if ((typeof id === "number" || typeof id === "string") && hasManagedReviewSummaryMarker(body)) {
			comments.push({ id: Number(id), body });
		}
	}

	return comments;
}


export interface GiteaPullRequestReviewOptions {
	readonly baseUrl: string;
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
	readonly pullNumber: number;
	readonly channelName?: string;
	readonly fetch?: FetchLike;
	readonly severityLabelPrefix?: string;
	readonly severityLabelColors?: Readonly<Record<string, string>>;
	readonly autoTag?: string;
	readonly reviewedTag?: string;
	readonly reviewMode?: ReviewMode;
	readonly reviewEvent?: ReviewEvent;
	readonly reviewUpdateStrategy?: ReviewUpdateStrategy;
	readonly headSha?: string;
}

export interface GiteaPullRequestReviewDispatcher {
	publishProblem(problem: ReviewProblem): Promise<DispatchResult>;
	publishSummary?(summary: string, problems?: readonly ReviewProblem[]): Promise<DispatchResult>;
}

export class OutputDispatchError extends Error {
	readonly status?: number;
	readonly responseBody?: string;

	constructor(message: string, options: { readonly status?: number; readonly responseBody?: string } = {}) {
		super(message);
		this.name = "OutputDispatchError";
		if (options.status !== undefined) {
			this.status = options.status;
		}
		if (options.responseBody !== undefined) {
			this.responseBody = options.responseBody;
		}
	}
}

function defaultFetch(): FetchLike {
	const candidate = globalThis.fetch;
	if (!candidate) {
		throw new TypeError("No global fetch implementation is available.");
	}

	return candidate as unknown as FetchLike;
}

function encodePathSegment(value: string): string {
	return encodeURIComponent(value);
}

const CONSECUTIVE_BLANK_LINES_RE = /\n{3,}/gu;
const TRAILING_SPACES_RE = /[ \t]+$/gmu;

function normalizeMarkdownBody(body: string): string {
	const trimmed = body.replace(TRAILING_SPACES_RE, "");
	const collapsed = trimmed.replace(CONSECUTIVE_BLANK_LINES_RE, "\n\n");
	return collapsed.endsWith("\n") ? collapsed : `${collapsed}\n`;
}

function shouldFallbackToGeneralComment(status: number): boolean {
	return status === 422 || status === 403;
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}

	return `${text.slice(0, maxLength)}...`;
}

const IM_PROBLEM_DISPLAY_LIMIT = 10;
const IM_MESSAGE_MAX_LENGTH = 500;
const IM_SUGGESTION_MAX_LENGTH = 300;

function normalizeImInlineText(text: string, maxLength: number): string {
	return truncateText(text.replace(/\s+/gu, " ").trim(), maxLength);
}

function buildImProblemSections(problems: readonly ReviewProblem[]): string[] {
	if (problems.length === 0) {
		return [];
	}

	const sections: string[] = ["", `## Problems (${problems.length})`];
	for (let i = 0; i < Math.min(problems.length, IM_PROBLEM_DISPLAY_LIMIT); i += 1) {
		const problem = problems[i]!;
		sections.push(
			"",
			`### ${i + 1}. [${problem.severity.toUpperCase()}] ${problem.category}`,
			`- Location: \`${buildProblemLocation(problem)}\``,
			`- Message: ${normalizeImInlineText(problem.message, IM_MESSAGE_MAX_LENGTH)}`,
		);
		if (problem.suggestion) {
			sections.push(`- Suggestion: ${normalizeImInlineText(problem.suggestion, IM_SUGGESTION_MAX_LENGTH)}`);
		}
	}
	if (problems.length > IM_PROBLEM_DISPLAY_LIMIT) {
		sections.push("", `... and ${problems.length - IM_PROBLEM_DISPLAY_LIMIT} more`);
	}

	return sections;
}

export function renderProblemMarkdown(problem: ReviewProblem): string {
	if (problem.renderedMarkdown) {
		return problem.renderedMarkdown;
	}

	const location = problem.endLine ? `${problem.file}:${problem.line}-${problem.endLine}` : `${problem.file}:${problem.line}`;
	const parts = [
		`**${problem.severity.toUpperCase()} · ${problem.category}**`,
		"",
		problem.message,
		"",
		`Location: \`${location}\``,
	];

	if (problem.suggestion) {
		parts.push("", "Suggested fix:", "", problem.suggestion);
	}

	if (problem.codeSnippet) {
		parts.push(
			"",
			`Referenced code: \`${location}\``,
			"",
			renderMarkdownCodeFence(problem.codeSnippet, problem.codeLanguage),
		);
	}

	if (problem.fingerprint) {
		parts.push("", `<!-- aicr:fingerprint=${problem.fingerprint} -->`);
	}

	return normalizeMarkdownBody(parts.join("\n"));
}

function extractExternalId(raw: unknown): string | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const value = (raw as Record<string, unknown>).id;
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

export function createGiteaPullRequestReviewDispatcher(
	options: GiteaPullRequestReviewOptions,
): GiteaPullRequestReviewDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	const channel = options.channelName ?? "gitea_pr_review";
	const reviewMode = options.reviewMode ?? "auto";
	const reviewEvent = options.reviewEvent ?? "COMMENT";
	const reviewEndpoint = [
		baseUrl,
		"api/v1/repos",
		encodePathSegment(options.owner),
		encodePathSegment(options.repo),
		"pulls",
		String(options.pullNumber),
		"reviews",
	].join("/");
	const commentEndpoint = [
		baseUrl,
		"api/v1/repos",
		encodePathSegment(options.owner),
		encodePathSegment(options.repo),
		"issues",
		String(options.pullNumber),
		"comments",
	].join("/");
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (options.token) {
		headers.authorization = `token ${options.token}`;
	}

	async function postReview(body: Record<string, unknown>): Promise<DispatchResult> {
		const response = await fetchImpl(reviewEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`Gitea review API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		const raw = await response.json();
		const externalId = extractExternalId(raw);
		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw,
		};
	}

	async function postComment(body: string): Promise<DispatchResult> {
		const response = await fetchImpl(commentEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify({ body }),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`Gitea comment API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		const raw = await response.json();
		const externalId = extractExternalId(raw);
		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw,
		};
	}

	async function postProblem(problem: ReviewProblem): Promise<DispatchResult> {
		const markdown = renderProblemMarkdown(problem);
		if (reviewMode === "comment") {
			return postComment(markdown);
		}

		if (problem.lineCommentAllowed === false) {
			return postReview({ event: reviewEvent, body: markdown });
		}

		const body = {
			event: reviewEvent,
			body: `AICR problem for ${problem.file}:${problem.line}`,
			comments: [
				{
					path: problem.file,
					new_position: problem.line,
					body: markdown,
				},
			],
		};

		const response = await fetchImpl(reviewEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			if (reviewMode === "auto" && shouldFallbackToGeneralComment(response.status)) {
				await response.text();
				return postComment(markdown);
			}

			throw new OutputDispatchError(`Gitea review API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		const raw = await response.json();
		const externalId = extractExternalId(raw);
		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw,
		};
	}

	const fetchCommentsEndpoint = commentEndpoint;

	async function listManagedReviewComments(): Promise<readonly ManagedReviewComment[]> {
		try {
			const response = await fetchImpl(fetchCommentsEndpoint, { headers });
			if (!response.ok) {
				return [];
			}
			const raw = await response.json();
			return parseManagedReviewComments(raw);
		} catch {
			return [];
		}
	}

	async function patchComment(commentId: number, body: string): Promise<DispatchResult> {
		const endpoint = [
			baseUrl,
			"api/v1/repos",
			encodePathSegment(options.owner),
			encodePathSegment(options.repo),
			"issues",
			"comments",
			String(commentId),
		].join("/");
		const response = await fetchImpl(endpoint, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ body }),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`Gitea comment update API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		const raw = await response.json();
		return {
			channel,
			status: "published",
			externalId: String(commentId),
			raw: { action: "updated", commentId, comment: raw },
		};
	}

	const updateStrategy = options.reviewUpdateStrategy ?? "update_existing";

	let attachSummaryLabels: (problems?: readonly ReviewProblem[]) => Promise<void> = () => Promise.resolve();

	const dispatcher: GiteaPullRequestReviewDispatcher = {
		async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
			return postProblem(problem);
		},
		async publishSummary(summary: string, problems?: readonly ReviewProblem[]): Promise<DispatchResult> {
			const trimmed = summary.trim();
			const allProblems = problems ?? [];
			let result: DispatchResult | undefined;

			if (updateStrategy === "update_existing") {
				const existingComments = await listManagedReviewComments();
				const latest = existingComments.length > 0 ? existingComments[existingComments.length - 1] : undefined;

				if (latest) {
					const updatedBody = updateReviewSummaryBody(latest.body, trimmed, allProblems, options.headSha);
					result = await patchComment(latest.id, updatedBody);
				} else {
					const newBody = buildReviewSummaryCommentBody(trimmed, allProblems, new Set(), channel, options.headSha);
					result = await postComment(newBody);
				}
			} else if (trimmed.length > 0) {
				if (reviewMode === "comment") {
					result = await postComment(trimmed);
				} else {
					result = await postReview({ event: reviewEvent, body: trimmed });
				}
			}
			await attachSummaryLabels(allProblems);

			return result ?? { channel, status: "published", raw: {} };
		},
	};

	if (options.severityLabelPrefix || options.autoTag || options.reviewedTag) {
		const labelCache = new Map<string, number>();
		const repoPath = [
			baseUrl,
			"api/v1/repos",
			encodePathSegment(options.owner),
			encodePathSegment(options.repo),
		].join("/");
		const severityColors = { ...DEFAULT_SEVERITY_COLORS, ...(options.severityLabelColors ?? {}) };

		async function resolveLabelIdByName(labelName: string, color?: string): Promise<number | undefined> {
			const cached = labelCache.get(labelName);
			if (cached !== undefined) {
				return cached;
			}

			try {
				const resp = await fetchImpl(`${repoPath}/labels?name=${encodeURIComponent(labelName)}`, { headers });
				if (resp.ok) {
					const list = await resp.json();
					if (Array.isArray(list)) {
						for (const label of list) {
							if (label && typeof label === "object" && (label as Record<string, unknown>).name === labelName) {
								const id = (label as Record<string, unknown>).id;
								if (typeof id === "number") {
									labelCache.set(labelName, id);
									return id;
								}
							}
						}
					}
				}
			} catch {
				// not found, try creating
			}

			const normalizedColor = (color ?? "#ededed").replace(/^#/u, "");
			try {
				const resp = await fetchImpl(`${repoPath}/labels`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name: labelName, color: normalizedColor }),
				});
				if (resp.ok) {
					const created = await resp.json();
					if (created && typeof created === "object") {
						const id = (created as Record<string, unknown>).id;
						if (typeof id === "number") {
							labelCache.set(labelName, id);
							return id;
						}
					}
				}
			} catch {
				// label creation failed
			}

			return undefined;
		}

		async function resolveSeverityLabelId(severity: string): Promise<number | undefined> {
			if (!options.severityLabelPrefix) {
				return undefined;
			}
			return resolveLabelIdByName(`${options.severityLabelPrefix}${severity}`, severityColors[severity] ?? "#ededed");
		}

		attachSummaryLabels = async (problems?: readonly ReviewProblem[]): Promise<void> => {
			const labelIds: number[] = [];

			if (options.autoTag) {
				const id = await resolveLabelIdByName(options.autoTag);
				if (id !== undefined) {
					labelIds.push(id);
				}
			}

			if (options.reviewedTag) {
				const id = await resolveLabelIdByName(options.reviewedTag);
				if (id !== undefined) {
					labelIds.push(id);
				}
			}

			const allProblems = problems ?? [];
			const highest = getHighestSeverity(allProblems);
			if (highest) {
				const severityId = await resolveSeverityLabelId(highest);
				if (severityId !== undefined && !labelIds.includes(severityId)) {
					labelIds.push(severityId);
				}
			}

			if (labelIds.length === 0) {
				return;
			}

			try {
				await fetchImpl(`${repoPath}/issues/${options.pullNumber}/labels`, {
					method: "POST",
					headers,
					body: JSON.stringify({ labels: labelIds }),
				});
			} catch {
				// label attachment failed, non-critical
			}
		};
	}

	return dispatcher;
}

export interface GithubPullRequestReviewOptions {
	readonly baseUrl?: string;
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
	readonly pullNumber: number;
	readonly channelName?: string;
	readonly fetch?: FetchLike;
	readonly severityLabelPrefix?: string;
	readonly severityLabelColors?: Readonly<Record<string, string>>;
	readonly autoTag?: string;
	readonly reviewedTag?: string;
	readonly reviewMode?: ReviewMode;
	readonly reviewEvent?: ReviewEvent;
	readonly reviewUpdateStrategy?: ReviewUpdateStrategy;
	readonly headSha?: string;
}

export interface GithubPullRequestReviewDispatcher {
	publishProblem(problem: ReviewProblem): Promise<DispatchResult>;
	publishSummary?(summary: string, problems?: readonly ReviewProblem[]): Promise<DispatchResult>;
}

export function createGithubPullRequestReviewDispatcher(
	options: GithubPullRequestReviewOptions,
): GithubPullRequestReviewDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
	const channel = options.channelName ?? "github_pr_review";
	const reviewMode = options.reviewMode ?? "auto";
	const reviewEvent = options.reviewEvent ?? "COMMENT";
	const reviewEndpoint = [
		baseUrl,
		"repos",
		encodePathSegment(options.owner),
		encodePathSegment(options.repo),
		"pulls",
		String(options.pullNumber),
		"reviews",
	].join("/");
	const commentEndpoint = [
		baseUrl,
		"repos",
		encodePathSegment(options.owner),
		encodePathSegment(options.repo),
		"issues",
		String(options.pullNumber),
		"comments",
	].join("/");
	const headers: Record<string, string> = {
		"accept": "application/vnd.github+json",
		"content-type": "application/json",
		"x-github-api-version": "2022-11-28",
	};
	if (options.token) {
		headers.authorization = `Bearer ${options.token}`;
	}

	async function postReview(body: Record<string, unknown>): Promise<DispatchResult> {
		const response = await fetchImpl(reviewEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`GitHub review API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		const raw = await response.json();
		const externalId = extractExternalId(raw);
		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw,
		};
	}

	async function postComment(body: string): Promise<DispatchResult> {
		const response = await fetchImpl(commentEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify({ body }),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`GitHub comment API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		const raw = await response.json();
		const externalId = extractExternalId(raw);
		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw,
		};
	}

	async function postProblem(problem: ReviewProblem): Promise<DispatchResult> {
		const markdown = renderProblemMarkdown(problem);
		if (reviewMode === "comment") {
			return postComment(markdown);
		}

		if (problem.lineCommentAllowed === false) {
			return postReview({ event: reviewEvent, body: markdown });
		}

		const body = {
			event: reviewEvent,
			body: `AICR problem for ${problem.file}:${problem.line}`,
			comments: [
				{
					path: problem.file,
					line: problem.line,
					side: "RIGHT",
					body: markdown,
				},
			],
		};

		const response = await fetchImpl(reviewEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			if (reviewMode === "auto" && shouldFallbackToGeneralComment(response.status)) {
				await response.text();
				return postComment(markdown);
			}

			throw new OutputDispatchError(`GitHub review API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		const raw = await response.json();
		const externalId = extractExternalId(raw);
		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw,
		};
	}

	const fetchCommentsEndpoint = commentEndpoint;

	async function listManagedReviewComments(): Promise<readonly ManagedReviewComment[]> {
		try {
			const response = await fetchImpl(fetchCommentsEndpoint, { headers });
			if (!response.ok) {
				return [];
			}
			const raw = await response.json();
			return parseManagedReviewComments(raw);
		} catch {
			return [];
		}
	}

	async function patchComment(commentId: number, body: string): Promise<DispatchResult> {
		const endpoint = [
			baseUrl,
			"repos",
			encodePathSegment(options.owner),
			encodePathSegment(options.repo),
			"issues",
			"comments",
			String(commentId),
		].join("/");
		const response = await fetchImpl(endpoint, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ body }),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`GitHub comment update API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		const raw = await response.json();
		return {
			channel,
			status: "published",
			externalId: String(commentId),
			raw: { action: "updated", commentId, comment: raw },
		};
	}

	const updateStrategy = options.reviewUpdateStrategy ?? "update_existing";

	let attachSummaryLabels: (problems?: readonly ReviewProblem[]) => Promise<void> = () => Promise.resolve();

	const dispatcher: GithubPullRequestReviewDispatcher = {
		async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
			return postProblem(problem);
		},
		async publishSummary(summary: string, problems?: readonly ReviewProblem[]): Promise<DispatchResult> {
			const trimmed = summary.trim();
			const allProblems = problems ?? [];
			let result: DispatchResult | undefined;

			if (updateStrategy === "update_existing") {
				const existingComments = await listManagedReviewComments();
				const latest = existingComments.length > 0 ? existingComments[existingComments.length - 1] : undefined;

				if (latest) {
					const updatedBody = updateReviewSummaryBody(latest.body, trimmed, allProblems, options.headSha);
					result = await patchComment(latest.id, updatedBody);
				} else {
					const newBody = buildReviewSummaryCommentBody(trimmed, allProblems, new Set(), channel, options.headSha);
					result = await postComment(newBody);
				}
			} else if (trimmed.length > 0) {
				if (reviewMode === "comment") {
					result = await postComment(trimmed);
				} else {
					result = await postReview({ event: reviewEvent, body: trimmed });
				}
			}
			await attachSummaryLabels(allProblems);

			return result ?? { channel, status: "published", raw: {} };
		},
	};

	if (options.severityLabelPrefix || options.autoTag || options.reviewedTag) {
		const labelCache = new Map<string, string>();
		const repoPath = [
			baseUrl,
			"repos",
			encodePathSegment(options.owner),
			encodePathSegment(options.repo),
		].join("/");
		const severityColors = { ...DEFAULT_SEVERITY_COLORS, ...(options.severityLabelColors ?? {}) };
		let repositoryLabelNamesPromise: Promise<Set<string> | undefined> | undefined;

		function getRepositoryLabelNames(): Promise<Set<string> | undefined> {
			repositoryLabelNamesPromise ??= fetchGithubRepositoryLabelNames(fetchImpl, repoPath, headers);
			return repositoryLabelNamesPromise;
		}

		async function resolveLabelNameByString(labelName: string, color?: string): Promise<string | undefined> {
			const cached = labelCache.get(labelName);
			if (cached !== undefined) {
				return cached;
			}

			const repositoryLabelNames = await getRepositoryLabelNames();
			if (repositoryLabelNames?.has(labelName)) {
				labelCache.set(labelName, labelName);
				return labelName;
			}

			const normalizedColor = (color ?? "#ededed").replace(/^#/u, "");
			try {
				const resp = await fetchImpl(`${repoPath}/labels`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name: labelName, color: normalizedColor }),
				});
				if (resp.ok) {
					const created = await resp.json();
					if (created && typeof created === "object") {
						const createdName = (created as Record<string, unknown>).name;
						if (createdName === labelName) {
							repositoryLabelNames?.add(labelName);
							labelCache.set(labelName, labelName);
							return labelName;
						}
					}
				}
			} catch {
				// label creation failed
			}

			return undefined;
		}

		async function resolveSeverityLabelName(severity: string): Promise<string | undefined> {
			if (!options.severityLabelPrefix) {
				return undefined;
			}
			return resolveLabelNameByString(`${options.severityLabelPrefix}${severity}`, severityColors[severity] ?? "#ededed");
		}

		attachSummaryLabels = async (problems?: readonly ReviewProblem[]): Promise<void> => {
			const labelNames: string[] = [];

			if (options.autoTag) {
				const name = await resolveLabelNameByString(options.autoTag);
				if (name !== undefined) {
					labelNames.push(name);
				}
			}

			if (options.reviewedTag) {
				const name = await resolveLabelNameByString(options.reviewedTag);
				if (name !== undefined) {
					labelNames.push(name);
				}
			}

			const allProblems = problems ?? [];
			const highest = getHighestSeverity(allProblems);
			if (highest) {
				const severityName = await resolveSeverityLabelName(highest);
				if (severityName !== undefined && !labelNames.includes(severityName)) {
					labelNames.push(severityName);
				}
			}

			if (labelNames.length === 0) {
				return;
			}

			try {
				await fetchImpl(`${repoPath}/issues/${options.pullNumber}/labels`, {
					method: "POST",
					headers,
					body: JSON.stringify({ labels: labelNames }),
				});
			} catch {
				// label attachment failed, non-critical
			}
		};
	}

	return dispatcher;
}

export interface GithubIssueOptions {
	readonly baseUrl?: string;
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
	readonly issueNumber: number;
	readonly channelName?: string;
	readonly fetch?: FetchLike;
	readonly autoTag?: string;
	readonly reviewedTag?: string;
}

export interface GithubIssueDispatcher {
	publishAggregatedProblems(problems: readonly ReviewProblem[], summary?: string): Promise<DispatchResult>;
}

function buildGithubHeaders(token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"accept": "application/vnd.github+json",
		"content-type": "application/json",
		"x-github-api-version": "2022-11-28",
	};
	if (token) {
		headers.authorization = `Bearer ${token}`;
	}
	return headers;
}

function buildGithubRepoPath(baseUrl: string, owner: string, repo: string): string {
	return [
		(baseUrl || "https://api.github.com").replace(/\/+$/u, ""),
		"repos",
		encodePathSegment(owner),
		encodePathSegment(repo),
	].join("/");
}

async function fetchGithubRepositoryLabelNames(
	fetchImpl: FetchLike,
	repoPath: string,
	headers: Readonly<Record<string, string>>,
): Promise<Set<string> | undefined> {
	try {
		const resp = await fetchImpl(`${repoPath}/labels`, { headers });
		if (!resp.ok) {
			return undefined;
		}

		const list = await resp.json();
		if (!Array.isArray(list)) {
			return undefined;
		}

		const names = new Set<string>();
		for (const label of list) {
			if (label && typeof label === "object") {
				const name = (label as Record<string, unknown>).name;
				if (typeof name === "string") {
					names.add(name);
				}
			}
		}

		return names;
	} catch {
		return undefined;
	}
}

export function createGithubIssueDispatcher(options: GithubIssueOptions): GithubIssueDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
	const channel = options.channelName ?? "github_issue";
	const repoPath = buildGithubRepoPath(baseUrl, options.owner, options.repo);
	const headers = buildGithubHeaders(options.token);
	const labelCache = new Map<string, string>();
	let repositoryLabelNamesPromise: Promise<Set<string> | undefined> | undefined;

	function getRepositoryLabelNames(): Promise<Set<string> | undefined> {
		repositoryLabelNamesPromise ??= fetchGithubRepositoryLabelNames(fetchImpl, repoPath, headers);
		return repositoryLabelNamesPromise;
	}

	async function resolveLabelName(labelName: string): Promise<string | undefined> {
		const cached = labelCache.get(labelName);
		if (cached !== undefined) {
			return cached;
		}

		const repositoryLabelNames = await getRepositoryLabelNames();
		if (repositoryLabelNames?.has(labelName)) {
			labelCache.set(labelName, labelName);
			return labelName;
		}

		try {
			const resp = await fetchImpl(`${repoPath}/labels`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: labelName, color: "ededed" }),
			});
			if (resp.ok) {
				const created = await resp.json();
				if (created && typeof created === "object" && (created as Record<string, unknown>).name === labelName) {
					repositoryLabelNames?.add(labelName);
					labelCache.set(labelName, labelName);
					return labelName;
				}
			}
		} catch {
			// label creation failed
		}

		return undefined;
	}

	async function addLabelsToIssue(labels: readonly string[]): Promise<void> {
		if (labels.length === 0) {
			return;
		}
		const resolvedNames: string[] = [];
		for (const labelName of new Set(labels)) {
			const resolvedName = await resolveLabelName(labelName);
			if (resolvedName !== undefined) {
				resolvedNames.push(resolvedName);
			}
		}
		if (resolvedNames.length === 0) {
			return;
		}
		try {
			await fetchImpl(`${repoPath}/issues/${options.issueNumber}/labels`, {
				method: "POST",
				headers,
				body: JSON.stringify({ labels: resolvedNames }),
			});
		} catch {
			// label attachment failed, non-critical
		}
	}

	const dispatcher = {
		async publishAggregatedProblems(problems: readonly ReviewProblem[], summary?: string): Promise<DispatchResult> {
			const endpoint = [
				baseUrl,
				"repos",
				encodePathSegment(options.owner),
				encodePathSegment(options.repo),
				"issues",
				String(options.issueNumber),
				"comments",
			].join("/");

			const sections: string[] = [];
			if (summary) {
				sections.push(summary, "");
			}
			if (problems.length > 0) {
				sections.push(`### Problems (${problems.length})`, "");
				for (const problem of problems) {
					sections.push(renderProblemMarkdown(problem));
					sections.push("");
				}
			}

			const body = normalizeMarkdownBody(sections.join("\n"));
			const response = await fetchImpl(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ body }),
			});

			if (!response.ok) {
				throw new OutputDispatchError(`GitHub issue API returned ${response.status}.`, {
					status: response.status,
					responseBody: await response.text(),
				});
			}

			const raw = await response.json();
			const externalId = extractExternalId(raw);

			const labelsToAdd: string[] = [];
			if (options.autoTag) {
				labelsToAdd.push(options.autoTag);
			}
			if (options.reviewedTag) {
				labelsToAdd.push(options.reviewedTag);
			}
			if (labelsToAdd.length > 0) {
				await addLabelsToIssue(labelsToAdd);
			}

			return {
				channel,
				status: "published",
				...(externalId ? { externalId } : {}),
				raw,
			};
		},
	};

	return dispatcher;
}

export type ProblemIssueMode = "per_problem" | "consolidated";

export type GithubProblemIssueResolvedAction = "none" | "close";

const DEFAULT_MANAGED_ISSUE_FETCH_LIMIT = 20;
const MAX_MANAGED_ISSUE_FETCH_LIMIT = 100;

function normalizeManagedIssueFetchLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_MANAGED_ISSUE_FETCH_LIMIT;
	}

	return Math.min(MAX_MANAGED_ISSUE_FETCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

export interface GithubProblemIssueOptions {
	readonly baseUrl?: string;
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
	readonly channelName?: string;
	readonly markerPrefix?: string;
	readonly markerLabel?: string;
	readonly labels?: readonly string[];
	readonly issueMode?: ProblemIssueMode;
	readonly resolvedAction?: GithubProblemIssueResolvedAction;
	readonly maxRecentIssues?: number;
	readonly fetch?: FetchLike;
	readonly assignCommitter?: boolean;
	readonly committerUsername?: string;
	readonly ownersFilePath?: string;
	readonly ownersContent?: string;
	readonly addOwnersAsAssignees?: boolean;
	readonly ref?: string;
	readonly severityLabelPrefix?: string;
	readonly severityLabelColors?: Readonly<Record<string, string>>;
	readonly notifyFeishu?: {
		readonly webhookUrl: string;
		readonly secret?: string;
	};
	readonly autoTag?: string;
	readonly reviewedTag?: string;
}

export interface GithubProblemIssueDispatcher {
	reconcileProblems(problems: readonly ReviewProblem[], summary?: string): Promise<readonly DispatchResult[]>;
}

interface ManagedGithubIssue {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly state: string;
	readonly url?: string;
	readonly fingerprint?: string;
	readonly scopeFingerprint?: string;
}

function parseManagedGithubIssues(raw: unknown, markerPrefix: string, markerLabel: string): readonly ManagedGithubIssue[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const issues: ManagedGithubIssue[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}

		const rawIssue = entry as Record<string, unknown>;
		if (rawIssue.pull_request) {
			continue;
		}

		const number = extractIssueNumber(rawIssue);
		const title = String(rawIssue.title ?? "");
		const body = String(rawIssue.body ?? "");
		const state = String(rawIssue.state ?? "");
		if (number === undefined || !title.startsWith(markerPrefix) || !hasManagedProblemIssueMarker(body)) {
			continue;
		}

		if (!body.includes(`<!-- aicr:label=${markerLabel} -->`)) {
			continue;
		}

		const fingerprint = extractManagedIssueFingerprint(body);
		const scopeFingerprint = extractConsolidatedScopeFingerprint(body);
		issues.push({
			number,
			title,
			body,
			state,
			...(typeof rawIssue.html_url === "string" ? { url: rawIssue.html_url } : {}),
			...(fingerprint ? { fingerprint } : {}),
			...(scopeFingerprint ? { scopeFingerprint } : {}),
		});
	}

	return issues;
}

export function createGithubProblemIssueDispatcher(options: GithubProblemIssueOptions): GithubProblemIssueDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
	const channel = options.channelName ?? "github_problem_issue";
	const markerPrefix = options.markerPrefix ?? "[AICR]";
	const markerLabel = options.markerLabel ?? "aicr-managed";
	const resolvedAction = options.resolvedAction ?? "close";
	const maxRecentIssues = normalizeManagedIssueFetchLimit(options.maxRecentIssues);
    const issueMode = options.issueMode ?? "consolidated";
	const assignCommitter = options.assignCommitter ?? true;
	const addOwnersAsAssignees = options.addOwnersAsAssignees ?? false;
	const ownersFilePath = options.ownersFilePath ?? "OWNERS";
	const severityLabelPrefix = options.severityLabelPrefix;
	const severityLabelColors = options.severityLabelColors;
	const repoPath = buildGithubRepoPath(baseUrl, options.owner, options.repo);
	const headers = buildGithubHeaders(options.token);

	async function request(method: string, endpoint: string, body?: unknown): Promise<unknown> {
		const response = await fetchImpl(endpoint, {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`GitHub problem issue API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		if (response.status === 204) {
			return {};
		}

		return response.json();
	}

	async function fetchOwnersContent(): Promise<string | undefined> {
		if (options.ownersContent !== undefined) {
			return options.ownersContent;
		}

		try {
			const refParam = options.ref ? `?ref=${encodeURIComponent(options.ref)}` : "";
			const raw = await request("GET", `${repoPath}/contents/${encodePathSegment(ownersFilePath)}${refParam}`);
			if (!raw || typeof raw !== "object") {
				return undefined;
			}

			const content = (raw as Record<string, unknown>).content;
			if (typeof content !== "string") {
				return undefined;
			}

			return Buffer.from(content, "base64").toString("utf8");
		} catch {
			return undefined;
		}
	}

	const autoTagLabelCache = new Map<string, string>();
	let repositoryLabelNamesPromise: Promise<Set<string> | undefined> | undefined;

	function getRepositoryLabelNames(): Promise<Set<string> | undefined> {
		repositoryLabelNamesPromise ??= fetchGithubRepositoryLabelNames(fetchImpl, repoPath, headers);
		return repositoryLabelNamesPromise;
	}

	async function resolveLabelName(labelName: string, color?: string): Promise<string | undefined> {
		const cached = autoTagLabelCache.get(labelName);
		if (cached !== undefined) {
			return cached;
		}

		const repositoryLabelNames = await getRepositoryLabelNames();
		if (repositoryLabelNames?.has(labelName)) {
			autoTagLabelCache.set(labelName, labelName);
			return labelName;
		}

		const normalizedColor = (color ?? "#ededed").replace(/^#/u, "");
		try {
			const resp = await fetchImpl(`${repoPath}/labels`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: labelName, color: normalizedColor }),
			});
			if (resp.ok) {
				const created = await resp.json();
				if (created && typeof created === "object") {
					const createdName = (created as Record<string, unknown>).name;
					if (createdName === labelName) {
						repositoryLabelNames?.add(labelName);
						autoTagLabelCache.set(labelName, labelName);
						return labelName;
					}
				}
			}
		} catch {
			// label creation failed
		}

		return undefined;
	}

	async function resolveSeverityLabelName(severity: string): Promise<string | undefined> {
		if (!severityLabelPrefix) {
			return undefined;
		}
		return resolveLabelName(`${severityLabelPrefix}${severity}`, severityLabelColors?.[severity] ?? DEFAULT_SEVERITY_COLORS[severity]);
	}

	async function sendFeishuNotification(
		issueTitle: string,
		issueUrl: string | undefined,
		severity: string,
		problemFile: string,
	): Promise<void> {
		if (!options.notifyFeishu) {
			return;
		}

		try {
			const sections = [
				`**New AICR Issue Created**`,
				`**Severity:** [${severity.toUpperCase()}]`,
				`**File:** ${problemFile}`,
			];
			if (issueUrl) {
				sections.push(`**Link:** [${issueTitle}](${issueUrl})`);
			} else {
				sections.push(`**Title:** ${issueTitle}`);
			}

			const timestamp = Math.floor(Date.now() / 1000);
			const body: Record<string, unknown> = {
				msg_type: "interactive",
				card: {
					elements: [
						{
							tag: "markdown",
							content: toFeishuMarkdown(sections.join("\n")),
						},
					],
				},
			};

			if (options.notifyFeishu.secret) {
				body.timestamp = String(timestamp);
				body.sign = await computeFeishuSign(timestamp, options.notifyFeishu.secret);
			}

			await fetchImpl(options.notifyFeishu.webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch {
			// Feishu notification failure should not block issue creation
		}
	}

	async function listManagedOpenIssues(): Promise<readonly ManagedGithubIssue[]> {
		const params = new URLSearchParams({
			state: "open",
			sort: "updated",
			direction: "desc",
			per_page: String(maxRecentIssues),
			page: "1",
		});
		const raw = await request("GET", `${repoPath}/issues?${params.toString()}`);
		return parseManagedGithubIssues(raw, markerPrefix, markerLabel);
	}

	function resolveAssignees(problem: ReviewProblem, owners: OwnersConfig | undefined): string[] {
		const assignees: string[] = [];

		if (assignCommitter && options.committerUsername) {
			assignees.push(options.committerUsername);
		}

		if (addOwnersAsAssignees && owners) {
			const matched = matchOwnersForFile(problem.file, owners);
			for (const owner of matched) {
				if (!assignees.includes(owner)) {
					assignees.push(owner);
				}
			}
		}

		return assignees;
	}

	async function createIssue(
		problem: ReviewProblem,
		summary: string | undefined,
		owners: OwnersConfig | undefined,
	): Promise<DispatchResult> {
		const body: Record<string, unknown> = {
			title: buildProblemIssueTitle(problem, markerPrefix),
			body: buildManagedIssueBody(problem, { channel, markerLabel, ...(summary ? { summary } : {}) }),
		};

		const labelNames: string[] = [];
		if (options.labels && options.labels.length > 0) {
			labelNames.push(...options.labels);
		}

		if (options.autoTag) {
			const name = await resolveLabelName(options.autoTag);
			if (name !== undefined && !labelNames.includes(name)) {
				labelNames.push(name);
			}
		}

		if (options.reviewedTag) {
			const name = await resolveLabelName(options.reviewedTag);
			if (name !== undefined && !labelNames.includes(name)) {
				labelNames.push(name);
			}
		}

		if (severityLabelPrefix) {
			const severityName = await resolveSeverityLabelName(problem.severity);
			if (severityName !== undefined && !labelNames.includes(severityName)) {
				labelNames.push(severityName);
			}
		}

		if (labelNames.length > 0) {
			body.labels = labelNames;
		}

		const assignees = resolveAssignees(problem, owners);
		if (assignees.length > 0) {
			body.assignees = assignees;
		}

		const raw = await request("POST", `${repoPath}/issues`, body);
		const externalId = extractExternalId(raw);

		const issueUrl = raw && typeof raw === "object"
			? (raw as Record<string, unknown>).html_url as string | undefined
			: undefined;

		await sendFeishuNotification(
			buildProblemIssueTitle(problem, markerPrefix),
			issueUrl,
			problem.severity,
			problem.file,
		);

		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw: { action: "created", issue: raw },
		};
	}

	async function createConsolidatedIssue(
		problems: readonly ReviewProblem[],
		summary: string | undefined,
		owners: OwnersConfig | undefined,
	): Promise<DispatchResult> {
		const scopeFingerprint = computeScopeFingerprint(channel, options.owner, options.repo);
		const body: Record<string, unknown> = {
			title: buildConsolidatedIssueTitle(problems, markerPrefix),
			body: buildConsolidatedIssueBody(problems, { channel, markerLabel, scopeFingerprint, ...(summary ? { summary } : {}) }),
		};

		const labelNames: string[] = [];
		if (options.labels && options.labels.length > 0) {
			labelNames.push(...options.labels);
		}

		if (options.autoTag) {
			const name = await resolveLabelName(options.autoTag);
			if (name !== undefined && !labelNames.includes(name)) {
				labelNames.push(name);
			}
		}

		if (options.reviewedTag) {
			const name = await resolveLabelName(options.reviewedTag);
			if (name !== undefined && !labelNames.includes(name)) {
				labelNames.push(name);
			}
		}

		if (severityLabelPrefix) {
			const highest = getHighestSeverity(problems);
			if (highest) {
				const severityName = await resolveSeverityLabelName(highest);
				if (severityName !== undefined && !labelNames.includes(severityName)) {
					labelNames.push(severityName);
				}
			}
		}

		if (labelNames.length > 0) {
			body.labels = labelNames;
		}

		const allAssignees = collectAllAssignees(problems, owners);
		if (allAssignees.length > 0) {
			body.assignees = allAssignees;
		}

		const raw = await request("POST", `${repoPath}/issues`, body);
		const externalId = extractExternalId(raw);

		const issueUrl = raw && typeof raw === "object"
			? (raw as Record<string, unknown>).html_url as string | undefined
			: undefined;

		const highest = getHighestSeverity(problems);
		await sendFeishuNotification(
			buildConsolidatedIssueTitle(problems, markerPrefix),
			issueUrl,
			highest ?? "info",
			`${problems.length} problems`,
		);

		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw: { action: "created_consolidated", issue: raw },
		};
	}

	async function updateConsolidatedIssue(
		existing: ManagedGithubIssue,
		problems: readonly ReviewProblem[],
		summary: string | undefined,
	): Promise<DispatchResult> {
		const scopeFingerprint = computeScopeFingerprint(channel, options.owner, options.repo);
		const body: Record<string, unknown> = {
			title: buildConsolidatedIssueTitle(problems, markerPrefix),
			body: buildConsolidatedIssueBody(problems, { channel, markerLabel, scopeFingerprint, ...(summary ? { summary } : {}) }),
		};

		if (severityLabelPrefix) {
			const labelNames: string[] = [];
			const highest = getHighestSeverity(problems);
			if (highest) {
				const severityName = await resolveSeverityLabelName(highest);
				if (severityName !== undefined) {
					labelNames.push(severityName);
				}
			}
			if (labelNames.length > 0) {
				body.labels = labelNames;
			}
		}

		const raw = await request("PATCH", `${repoPath}/issues/${existing.number}`, body);
		return {
			channel,
			status: "published",
			externalId: String(existing.number),
			raw: { action: "updated_consolidated", issueNumber: existing.number, issue: raw },
		};
	}

	function collectAllAssignees(problems: readonly ReviewProblem[], owners: OwnersConfig | undefined): string[] {
		const assigneeSet = new Set<string>();
		for (const problem of problems) {
			for (const assignee of resolveAssignees(problem, owners)) {
				assigneeSet.add(assignee);
			}
		}
		return [...assigneeSet];
	}

	async function resolveIssue(issue: ManagedGithubIssue): Promise<DispatchResult | undefined> {
		if (resolvedAction === "none") {
			return undefined;
		}

		await request("POST", `${repoPath}/issues/${issue.number}/comments`, {
			body: [
				"🤖 **AICR lifecycle:** this managed problem is no longer present in the latest analysis.",
				"",
				"Closing the issue automatically. Reopen it if the problem is still valid.",
			].join("\n"),
		});
		const raw = await request("PATCH", `${repoPath}/issues/${issue.number}`, { state: "closed" });
		return {
			channel,
			status: "published",
			externalId: String(issue.number),
			raw: { action: "closed", issueNumber: issue.number, issue: raw },
		};
	}

	const dispatcher = {
		async reconcileProblems(problems: readonly ReviewProblem[], summary?: string): Promise<readonly DispatchResult[]> {
			let owners: OwnersConfig | undefined;

			if (addOwnersAsAssignees) {
				const ownersContent = await fetchOwnersContent();
				if (ownersContent) {
					owners = parseOwnersContent(ownersContent);
				}
			}

			if (issueMode === "consolidated") {
				const existingIssues = await listManagedOpenIssues();
				const scopeFingerprint = computeScopeFingerprint(channel, options.owner, options.repo);
				const existingConsolidated = existingIssues.find(
					(issue) => issue.scopeFingerprint === scopeFingerprint,
				);

				const results: DispatchResult[] = [];

				if (problems.length === 0) {
					if (existingConsolidated && resolvedAction !== "none") {
						const result = await resolveIssue(existingConsolidated);
						if (result) {
							results.push(result);
						}
					}
					return results;
				}

				if (existingConsolidated) {
					results.push(await updateConsolidatedIssue(existingConsolidated, problems, summary));
				} else {
					results.push(await createConsolidatedIssue(problems, summary, owners));
				}

				for (const issue of existingIssues) {
					if (issue.scopeFingerprint === scopeFingerprint) {
						continue;
					}
					if (!isConsolidatedManagedIssue(issue.body)) {
						continue;
					}
					const result = await resolveIssue(issue);
					if (result) {
						results.push(result);
					}
				}

				return results;
			}

			const preparedProblems = problems.map(ensureProblemFingerprint);

			const currentFingerprints = new Set(preparedProblems.map((problem) => problem.fingerprint!));
			const existingIssues = await listManagedOpenIssues();
			const existingByFingerprint = new Map<string, ManagedGithubIssue>();
			for (const issue of existingIssues) {
				if (issue.fingerprint) {
					existingByFingerprint.set(issue.fingerprint, issue);
				}
			}

			const results: DispatchResult[] = [];
			for (const problem of preparedProblems) {
				if (!existingByFingerprint.has(problem.fingerprint!)) {
					results.push(await createIssue(problem, summary, owners));
				}
			}

			for (const issue of existingIssues) {
				if (!issue.fingerprint || currentFingerprints.has(issue.fingerprint)) {
					continue;
				}

				const result = await resolveIssue(issue);
				if (result) {
					results.push(result);
				}
			}

			return results;
		},
	};

	return dispatcher;
}

export interface GitlabMergeRequestReviewOptions {
	readonly baseUrl?: string;
	readonly token?: string;
	readonly projectId: string | number;
	readonly mergeRequestIid: number;
	readonly baseSha?: string;
	readonly startSha?: string;
	readonly headSha?: string;
	readonly channelName?: string;
	readonly fetch?: FetchLike;
	readonly severityLabelPrefix?: string;
	readonly severityLabelColors?: Readonly<Record<string, string>>;
	readonly autoTag?: string;
	readonly reviewedTag?: string;
}

export interface GitlabMergeRequestReviewDispatcher {
	publishProblem(problem: ReviewProblem): Promise<DispatchResult>;
	publishSummary?(summary: string, problems?: readonly ReviewProblem[]): Promise<DispatchResult>;
}

export function createGitlabMergeRequestReviewDispatcher(
	options: GitlabMergeRequestReviewOptions,
): GitlabMergeRequestReviewDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = (options.baseUrl ?? "https://gitlab.com").replace(/\/+$/u, "");
	const channel = options.channelName ?? "gitlab_mr_review";
	const projectPath = encodePathSegment(String(options.projectId));
	const mrPath = [baseUrl, "api/v4/projects", projectPath, "merge_requests", String(options.mergeRequestIid)].join("/");
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (options.token) {
		headers["private-token"] = options.token;
	}

	async function post(endpoint: string, body: Record<string, unknown>, errorLabel: string): Promise<DispatchResult> {
		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`${errorLabel} returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		const raw = await response.json();
		const externalId = extractExternalId(raw);
		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw,
		};
	}

	function canPublishLineComment(problem: ReviewProblem): boolean {
		return problem.lineCommentAllowed !== false && Boolean(options.baseSha && options.headSha);
	}

	function generalNoteBody(problem: ReviewProblem): Record<string, unknown> {
		return { body: renderProblemMarkdown(problem) };
	}

	const notesEndpoint = `${mrPath}/notes`;
	let attachSummaryLabels: (problems?: readonly ReviewProblem[]) => Promise<void> = () => Promise.resolve();

	const dispatcher: GitlabMergeRequestReviewDispatcher = {
		async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
			if (!canPublishLineComment(problem)) {
				return post(notesEndpoint, generalNoteBody(problem), "GitLab merge request note API");
			}

			const discussionsEndpoint = `${mrPath}/discussions`;
			const body = {
				body: renderProblemMarkdown(problem),
				position: {
					position_type: "text",
					base_sha: options.baseSha,
					start_sha: options.startSha ?? options.baseSha,
					head_sha: options.headSha,
					old_path: problem.file,
					new_path: problem.file,
					new_line: problem.line,
				},
			};

			const response = await fetchImpl(discussionsEndpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				if (shouldFallbackToGeneralComment(response.status)) {
					await response.text();
					return post(notesEndpoint, generalNoteBody(problem), "GitLab merge request note API");
				}

				throw new OutputDispatchError(`GitLab merge request discussion API returned ${response.status}.`, {
					status: response.status,
					responseBody: await response.text(),
				});
			}

			const raw = await response.json();
			const externalId = extractExternalId(raw);
			return {
				channel,
				status: "published",
				...(externalId ? { externalId } : {}),
				raw,
			};
		},
		async publishSummary(summary: string, problems?: readonly ReviewProblem[]): Promise<DispatchResult> {
			const result = summary.trim().length > 0
				? await post(notesEndpoint, { body: summary }, "GitLab merge request note API")
				: undefined;
			await attachSummaryLabels(problems);

			return result ?? { channel, status: "published", raw: {} };
		},
	};

	if (options.severityLabelPrefix || options.autoTag || options.reviewedTag) {
		const labelCache = new Map<string, string>();
		const gitlabProjectPath = [
			baseUrl,
			"api/v4/projects",
			projectPath,
		].join("/");
		const severityColors = { ...DEFAULT_SEVERITY_COLORS, ...(options.severityLabelColors ?? {}) };

		function normalizeGitlabLabelColor(color: string): string {
			return color.startsWith("#") ? color : `#${color}`;
		}

		async function resolveLabelNameByString(labelName: string, color?: string): Promise<string | undefined> {
			const cached = labelCache.get(labelName);
			if (cached !== undefined) {
				return cached;
			}

			try {
				const resp = await fetchImpl(`${gitlabProjectPath}/labels?search=${encodeURIComponent(labelName)}`, { headers });
				if (resp.ok) {
					const list = await resp.json();
					if (Array.isArray(list)) {
						for (const label of list) {
							if (label && typeof label === "object" && (label as Record<string, unknown>).name === labelName) {
								labelCache.set(labelName, labelName);
								return labelName;
							}
						}
					}
				}
			} catch {
				// not found
			}

			const normalizedColor = normalizeGitlabLabelColor(color ?? "#ededed");
			try {
				const resp = await fetchImpl(`${gitlabProjectPath}/labels`, {
					method: "POST",
					headers,
					body: JSON.stringify({ name: labelName, color: normalizedColor }),
				});
				if (resp.ok) {
					const created = await resp.json();
					if (created && typeof created === "object") {
						const createdName = (created as Record<string, unknown>).name;
						if (createdName === labelName) {
							labelCache.set(labelName, labelName);
							return labelName;
						}
					}
				}
			} catch {
				// label creation failed
			}

			return undefined;
		}

		async function resolveSeverityLabelName(severity: string): Promise<string | undefined> {
			if (!options.severityLabelPrefix) {
				return undefined;
			}
			return resolveLabelNameByString(`${options.severityLabelPrefix}${severity}`, severityColors[severity] ?? "#ededed");
		}

		attachSummaryLabels = async (problems?: readonly ReviewProblem[]): Promise<void> => {
			const labelNames: string[] = [];

			if (options.autoTag) {
				const name = await resolveLabelNameByString(options.autoTag);
				if (name !== undefined) {
					labelNames.push(name);
				}
			}

			if (options.reviewedTag) {
				const name = await resolveLabelNameByString(options.reviewedTag);
				if (name !== undefined) {
					labelNames.push(name);
				}
			}

			const allProblems = problems ?? [];
			const highest = getHighestSeverity(allProblems);
			if (highest) {
				const severityName = await resolveSeverityLabelName(highest);
				if (severityName !== undefined && !labelNames.includes(severityName)) {
					labelNames.push(severityName);
				}
			}

			if (labelNames.length === 0) {
				return;
			}

			try {
				const addLabelsParam = labelNames.map((n) => encodeURIComponent(n)).join(",");
				await fetchImpl(`${gitlabProjectPath}/merge_requests/${options.mergeRequestIid}?add_labels=${addLabelsParam}`, {
					method: "PUT",
					headers,
				});
			} catch {
				// label attachment failed, non-critical
			}
		};
	}

	return dispatcher;
}

export interface GiteaIssueOptions {
	readonly baseUrl: string;
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
	readonly indexNumber: number;
	readonly channelName?: string;
	readonly fetch?: FetchLike;
	readonly autoTag?: string;
	readonly reviewedTag?: string;
}

export interface GiteaIssueDispatcher {
	publishAggregatedProblems(problems: readonly ReviewProblem[], summary?: string): Promise<DispatchResult>;
}

export function createGiteaIssueDispatcher(options: GiteaIssueOptions): GiteaIssueDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	const channel = options.channelName ?? "gitea_issue";
	const repoPath = [
		baseUrl,
		"api/v1/repos",
		encodePathSegment(options.owner),
		encodePathSegment(options.repo),
	].join("/");

	async function addLabelsToIssue(labels: readonly string[]): Promise<void> {
		if (labels.length === 0) {
			return;
		}
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (options.token) {
			headers.authorization = `token ${options.token}`;
		}
		const labelCache = new Map<string, number>();
		const labelIds: number[] = [];
		for (const labelName of labels) {
			const cached = labelCache.get(labelName);
			if (cached !== undefined) {
				labelIds.push(cached);
				continue;
			}
			try {
				const resp = await fetchImpl(`${repoPath}/labels?name=${encodeURIComponent(labelName)}`, { headers });
				if (resp.ok) {
					const list = await resp.json();
					if (Array.isArray(list)) {
						for (const label of list) {
							if (label && typeof label === "object" && (label as Record<string, unknown>).name === labelName) {
								const id = (label as Record<string, unknown>).id;
								if (typeof id === "number") {
									labelCache.set(labelName, id);
									labelIds.push(id);
								}
							}
						}
					}
				}
			} catch {
				// not found, try creating
			}
			if (!labelCache.has(labelName)) {
				try {
					const resp = await fetchImpl(`${repoPath}/labels`, {
						method: "POST",
						headers,
						body: JSON.stringify({ name: labelName, color: "ededed" }),
					});
					if (resp.ok) {
						const created = await resp.json();
						if (created && typeof created === "object") {
							const id = (created as Record<string, unknown>).id;
							if (typeof id === "number") {
								labelCache.set(labelName, id);
								labelIds.push(id);
							}
						}
					}
				} catch {
					// label creation failed
				}
			}
		}
		if (labelIds.length === 0) {
			return;
		}
		try {
			await fetchImpl(`${repoPath}/issues/${options.indexNumber}/labels`, {
				method: "POST",
				headers,
				body: JSON.stringify({ labels: labelIds }),
			});
		} catch {
			// label attachment failed, non-critical
		}
	}

	const dispatcher = {
		async publishAggregatedProblems(problems: readonly ReviewProblem[], summary?: string): Promise<DispatchResult> {
			const endpoint = [
				baseUrl,
				"api/v1/repos",
				encodePathSegment(options.owner),
				encodePathSegment(options.repo),
				"issues",
				String(options.indexNumber),
				"comments",
			].join("/");

			const sections: string[] = [];
			if (summary) {
				sections.push(summary, "");
			}
			if (problems.length > 0) {
				sections.push(`### Problems (${problems.length})`, "");
				for (const problem of problems) {
					sections.push(renderProblemMarkdown(problem));
					sections.push("");
				}
			}

			const body = normalizeMarkdownBody(sections.join("\n"));
			const headers: Record<string, string> = {
				"content-type": "application/json",
			};
			if (options.token) {
				headers.authorization = `token ${options.token}`;
			}

			const response = await fetchImpl(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ body }),
			});

			if (!response.ok) {
				throw new OutputDispatchError(`Gitea issue API returned ${response.status}.`, {
					status: response.status,
					responseBody: await response.text(),
				});
			}

			const raw = await response.json();
			const externalId = extractExternalId(raw);

			const labelsToAdd: string[] = [];
			if (options.autoTag) {
				labelsToAdd.push(options.autoTag);
			}
			if (options.reviewedTag) {
				labelsToAdd.push(options.reviewedTag);
			}
			if (labelsToAdd.length > 0) {
				await addLabelsToIssue(labelsToAdd);
			}

			return {
				channel,
				status: "published",
				...(externalId ? { externalId } : {}),
				raw,
			};
		},
	};

	return dispatcher;
}

export type GiteaProblemIssueResolvedAction = "none" | "close" | "delete";

export interface OwnersConfig {
	readonly reviewers?: readonly string[];
	readonly paths?: Readonly<Record<string, readonly string[]>>;
}

export interface GiteaProblemIssueOptions {
	readonly baseUrl: string;
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
	readonly channelName?: string;
	readonly markerPrefix?: string;
	readonly markerLabel?: string;
	readonly labelIds?: readonly number[];
	readonly issueMode?: ProblemIssueMode;
	readonly resolvedAction?: GiteaProblemIssueResolvedAction;
	readonly maxRecentIssues?: number;
	readonly fetch?: FetchLike;
	readonly assignCommitter?: boolean;
	readonly committerUsername?: string;
	readonly ownersFilePath?: string;
	readonly ownersContent?: string;
	readonly addOwnersAsAssignees?: boolean;
	readonly ref?: string;
	readonly severityLabelPrefix?: string;
	readonly severityLabelColors?: Readonly<Record<string, string>>;
	readonly notifyFeishu?: {
		readonly webhookUrl: string;
		readonly secret?: string;
	};
	readonly autoTag?: string;
	readonly reviewedTag?: string;
}

export interface GiteaProblemIssueDispatcher {
	reconcileProblems(problems: readonly ReviewProblem[], summary?: string): Promise<readonly DispatchResult[]>;
}

const DEFAULT_SEVERITY_COLORS: Readonly<Record<string, string>> = {
	info: "#207de1",
	low: "#006b75",
	medium: "#fbca04",
	high: "#e11d48",
	critical: "#b60205",
};

export function parseOwnersContent(content: string): OwnersConfig {
	const lines = content.split("\n");
	const reviewers: string[] = [];
	const paths: Record<string, string[]> = {};
	let currentPath: string | null = null;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}

		const indented = rawLine.length > 0 && (rawLine[0] === " " || rawLine[0] === "\t");

		const colonMatch = /^(.+?):\s*$/u.exec(line);
		if (colonMatch) {
			let key = colonMatch[1]!.trim();

			if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
				key = key.slice(1, -1);
			}

			if (key === "reviewers") {
				currentPath = "__reviewers__";
				continue;
			}

			if (key === "paths") {
				currentPath = null;
				continue;
			}

			if (key.includes("/") || key.includes("\\") || key.includes("*")) {
				currentPath = key;
				if (!paths[key]) {
					paths[key] = [];
				}
				continue;
			}
		}

		if (indented) {
			const value = line.replace(/^-\s*/u, "").trim();
			if (!value) {
				continue;
			}

			if (currentPath === "__reviewers__") {
				reviewers.push(value);
			} else if (currentPath !== null && paths[currentPath]) {
				paths[currentPath]!.push(value);
			}
		}
	}

	const result: { reviewers?: string[]; paths?: Record<string, string[]> } = {};
	if (reviewers.length > 0) {
		result.reviewers = reviewers;
	}
	if (Object.keys(paths).length > 0) {
		result.paths = paths;
	}
	return result;
}

export function matchOwnersForFile(
	filePath: string,
	owners: OwnersConfig,
): readonly string[] {
	const matchedOwners: string[] = [];
	let bestMatchLength = -1;

	if (owners.paths) {
		for (const [dirPath, users] of Object.entries(owners.paths)) {
			const normalizedDir = dirPath.replace(/\\/gu, "/").replace(/\/+$/u, "") + "/";
			const normalizedFile = filePath.replace(/\\/gu, "/");
			if (normalizedFile.startsWith(normalizedDir) && normalizedDir.length > bestMatchLength) {
				bestMatchLength = normalizedDir.length;
				matchedOwners.length = 0;
				matchedOwners.push(...users);
			}
		}
	}

	if (matchedOwners.length === 0 && owners.reviewers) {
		return owners.reviewers;
	}

	return matchedOwners;
}

interface ManagedGiteaIssue {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly state: string;
	readonly url?: string;
	readonly fingerprint?: string;
	readonly scopeFingerprint?: string;
}

const AICR_MANAGED_PROBLEM_ISSUE_MARKER = "<!-- aicr:managed=problem-issue -->";

function extractManagedIssueFingerprint(body: string): string | undefined {
	const match = /<!--\s*aicr:fingerprint=([^\s-][^\s]*)\s*-->/u.exec(body);
	return match?.[1];
}

function extractIssueNumber(raw: Record<string, unknown>): number | undefined {
	const value = raw.number ?? raw.index;
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function hasManagedProblemIssueMarker(body: string): boolean {
	return body.includes(AICR_MANAGED_PROBLEM_ISSUE_MARKER);
}

const AICR_CONSOLIDATED_MARKER = "<!-- aicr:consolidated=true -->";

const MANAGED_ISSUE_TITLE_MAX_DISPLAY_WIDTH = 72;
const MANAGED_ISSUE_LOCATION_MAX_DISPLAY_WIDTH = 32;
const MANAGED_ISSUE_CORE_MIN_DISPLAY_WIDTH = 16;

function isConsolidatedManagedIssue(body: string): boolean {
	return body.includes(AICR_CONSOLIDATED_MARKER);
}

function extractConsolidatedScopeFingerprint(body: string): string | undefined {
	const match = /<!--\s*aicr:scope_fingerprint=([^\s-][^\s]*)\s*-->/u.exec(body);
	return match?.[1];
}

export function computeScopeFingerprint(channel: string, owner: string, repo: string): string {
	const raw = `consolidated:${channel}:${owner}/${repo}`;
	return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function isWideIssueTitleCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		code === 0x2329 ||
		code === 0x232a ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

function getIssueTitleDisplayWidth(value: string): number {
	let width = 0;
	for (const char of value) {
		const code = char.codePointAt(0)!;
		width += isWideIssueTitleCodePoint(code) ? 2 : 1;
	}
	return width;
}

function sliceIssueTitleByDisplayWidth(value: string, maxDisplayWidth: number): string {
	if (maxDisplayWidth <= 0) {
		return "";
	}

	let width = 0;
	let result = "";
	for (const char of value) {
		const code = char.codePointAt(0)!;
		const charWidth = isWideIssueTitleCodePoint(code) ? 2 : 1;
		if (width + charWidth > maxDisplayWidth) {
			break;
		}
		result += char;
		width += charWidth;
	}

	return result;
}

function sliceIssueTitleFromEndByDisplayWidth(value: string, maxDisplayWidth: number): string {
	if (maxDisplayWidth <= 0) {
		return "";
	}

	let width = 0;
	const chars = Array.from(value);
	const result: string[] = [];
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		const char = chars[i]!;
		const code = char.codePointAt(0)!;
		const charWidth = isWideIssueTitleCodePoint(code) ? 2 : 1;
		if (width + charWidth > maxDisplayWidth) {
			break;
		}
		result.unshift(char);
		width += charWidth;
	}

	return result.join("");
}

function buildConsolidatedIssueTitle(
	problems: readonly ReviewProblem[],
	markerPrefix: string,
): string {
	if (problems.length === 1) {
		return buildProblemIssueTitle(problems[0]!, markerPrefix);
	}

	const highest = getHighestSeverity(problems);
	const count = problems.length;
	const prefix = [
		markerPrefix,
		...(highest ? [`[${highest.toUpperCase()}]`] : []),
		`${count} problem${count !== 1 ? "s" : ""}`,
	].join(" ");

	const highestProblems = highest
		? problems.filter((p) => p.severity === highest)
		: problems;
	const representative = highestProblems[0]!;
	const separator = " · ";
	const summaryBudget =
		MANAGED_ISSUE_TITLE_MAX_DISPLAY_WIDTH -
		getIssueTitleDisplayWidth(prefix) -
		getIssueTitleDisplayWidth(separator);
	const summary =
		summaryBudget > MANAGED_ISSUE_CORE_MIN_DISPLAY_WIDTH
			? (summarizeProblemForIssueTitle(representative.message, summaryBudget) ||
				truncateIssueTitle(representative.category, summaryBudget))
			: "";
	const title = summary ? `${prefix}${separator}${summary}` : prefix;
	return truncateIssueTitle(title, MANAGED_ISSUE_TITLE_MAX_DISPLAY_WIDTH);
}

function buildConsolidatedIssueBody(
	problems: readonly ReviewProblem[],
	options: {
		readonly channel: string;
		readonly markerLabel: string;
		readonly scopeFingerprint: string;
		readonly summary?: string;
	},
): string {
	const sections: string[] = [
		AICR_MANAGED_PROBLEM_ISSUE_MARKER,
		AICR_CONSOLIDATED_MARKER,
		`<!-- aicr:channel=${options.channel} -->`,
		`<!-- aicr:label=${options.markerLabel} -->`,
		`<!-- aicr:scope_fingerprint=${options.scopeFingerprint} -->`,
		"",
	];

	if (options.summary?.trim()) {
		sections.push(options.summary, "", "---", "");
	}

	const grouped = groupProblemsBySeverity(problems);
	for (const group of grouped) {
		sections.push(`### ${group.severity.toUpperCase()} (${group.problems.length})`, "");
		for (let i = 0; i < group.problems.length; i++) {
			const p = group.problems[i]!;
			const location = p.endLine ? `${p.file}:${p.line}-${p.endLine}` : `${p.file}:${p.line}`;
			sections.push(`**${i + 1}. ${p.category}** — \`${location}\``, "");
			sections.push(p.message);
			if (p.suggestion) {
				sections.push("", `> **Suggested fix:** ${p.suggestion}`);
			}
			if (p.codeSnippet && p.codeLanguage) {
				sections.push("", renderMarkdownCodeFence(p.codeSnippet, p.codeLanguage));
			}
			sections.push("");
		}
	}

	return normalizeMarkdownBody(sections.join("\n"));
}

interface SeverityGroup {
	readonly severity: ProblemSeverity;
	readonly problems: readonly ReviewProblem[];
}

const CONSOLIDATION_SEVERITY_ORDER: readonly ProblemSeverity[] = ["critical", "high", "medium", "low", "info"];

function groupProblemsBySeverity(problems: readonly ReviewProblem[]): readonly SeverityGroup[] {
	const map = new Map<ProblemSeverity, ReviewProblem[]>();
	for (const p of problems) {
		const list = map.get(p.severity) ?? [];
		list.push(p);
		map.set(p.severity, list);
	}
	const groups: SeverityGroup[] = [];
	for (const sev of CONSOLIDATION_SEVERITY_ORDER) {
		const list = map.get(sev);
		if (list && list.length > 0) {
			groups.push({ severity: sev, problems: list });
		}
	}
	return groups;
}

function truncateIssueTitleTail(value: string, maxDisplayWidth: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized === "") {
		return "";
	}

	if (getIssueTitleDisplayWidth(normalized) <= maxDisplayWidth) {
		return normalized;
	}

	const ellipsis = "...";
	const suffixWidth = maxDisplayWidth - getIssueTitleDisplayWidth(ellipsis);
	if (suffixWidth <= 0) {
		return ellipsis;
	}

	return `${ellipsis}${sliceIssueTitleFromEndByDisplayWidth(normalized, suffixWidth).trimStart()}`;
}

function abbreviateLocationForIssueTitle(location: string, maxDisplayWidth: number): string {
	const normalized = location.replace(/\\/gu, "/").replace(/\s+/gu, " ").trim();
	if (normalized === "") {
		return "";
	}

	if (getIssueTitleDisplayWidth(normalized) <= maxDisplayWidth) {
		return normalized;
	}

	if (normalized.includes("/")) {
		const segments = normalized.split("/");
		let suffix = segments.at(-1) ?? normalized;
		for (let i = segments.length - 2; i >= 0; i -= 1) {
			const candidate = `${segments[i]!}/${suffix}`;
			if (getIssueTitleDisplayWidth(`.../${candidate}`) > maxDisplayWidth) {
				break;
			}
			suffix = candidate;
		}

		const abbreviated = `.../${suffix}`;
		if (getIssueTitleDisplayWidth(abbreviated) <= maxDisplayWidth) {
			return abbreviated;
		}
	}

	return truncateIssueTitleTail(normalized, maxDisplayWidth);
}

function buildProblemIssueTitle(problem: ReviewProblem, markerPrefix: string): string {
	const prefix = `${markerPrefix} [${problem.severity.toUpperCase()}]`;
	const rawLocation = buildProblemLocation(problem);
	let location = abbreviateLocationForIssueTitle(rawLocation, MANAGED_ISSUE_LOCATION_MAX_DISPLAY_WIDTH);
	let coreBudget = MANAGED_ISSUE_TITLE_MAX_DISPLAY_WIDTH - getIssueTitleDisplayWidth(`${prefix} ${location} · `);

	if (coreBudget < MANAGED_ISSUE_CORE_MIN_DISPLAY_WIDTH) {
		const reducedLocationBudget = Math.max(
			12,
			MANAGED_ISSUE_TITLE_MAX_DISPLAY_WIDTH -
				getIssueTitleDisplayWidth(`${prefix} · `) -
				MANAGED_ISSUE_CORE_MIN_DISPLAY_WIDTH,
		);
		location = abbreviateLocationForIssueTitle(rawLocation, reducedLocationBudget);
		coreBudget = MANAGED_ISSUE_TITLE_MAX_DISPLAY_WIDTH - getIssueTitleDisplayWidth(`${prefix} ${location} · `);
	}

	const summary = coreBudget > 0
		? summarizeProblemForIssueTitle(problem.message, coreBudget) || truncateIssueTitle(problem.category, coreBudget)
		: "";
	const title = summary ? `${prefix} ${location} · ${summary}` : `${prefix} ${location}`;
	return truncateIssueTitle(title, MANAGED_ISSUE_TITLE_MAX_DISPLAY_WIDTH);
}

function stripMarkdownForIssueTitle(value: string): string {
	return value
		.replace(/```[\s\S]*?```/gu, " ")
		.replace(/`([^`]+)`/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/[>#*_~]/gu, " ");
}

function truncateIssueTitle(value: string, maxDisplayWidth: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized === "" || maxDisplayWidth <= 0) {
		return "";
	}

	if (getIssueTitleDisplayWidth(normalized) <= maxDisplayWidth) {
		return normalized;
	}

	const ellipsis = "...";
	const limit = maxDisplayWidth - getIssueTitleDisplayWidth(ellipsis);
	if (limit <= 0) {
		return ellipsis;
	}

	const prefix = sliceIssueTitleByDisplayWidth(normalized, limit).trimEnd();
	const wordBoundary = prefix.lastIndexOf(" ");
	const shortened = wordBoundary > Math.floor(prefix.length * 0.6)
		? prefix.slice(0, wordBoundary)
		: prefix;
	return `${shortened}${ellipsis}`;
}

function summarizeProblemForIssueTitle(message: string, maxDisplayWidth = 40): string {
	if (maxDisplayWidth <= 0) {
		return "";
	}

	const normalized = stripMarkdownForIssueTitle(message).replace(/\s+/gu, " ").trim();
	if (normalized === "") {
		return "";
	}

	const sentenceEnd = /[。！？]|[.!?](?=\s|$)/u.exec(normalized);
	const firstSentence = sentenceEnd ? normalized.slice(0, sentenceEnd.index).trim() : normalized;
	return truncateIssueTitle(firstSentence, maxDisplayWidth).replace(/[。！？.!?]+$/u, "").trim();
}

function ensureProblemFingerprint(problem: ReviewProblem): ReviewProblem {
	return problem.fingerprint ? problem : { ...problem, fingerprint: computeProblemFingerprint(problem) };
}

function buildManagedIssueBody(
	problem: ReviewProblem,
	options: {
		readonly channel: string;
		readonly markerLabel: string;
		readonly summary?: string;
	},
): string {
	const sections = [
		AICR_MANAGED_PROBLEM_ISSUE_MARKER,
		`<!-- aicr:channel=${options.channel} -->`,
		`<!-- aicr:label=${options.markerLabel} -->`,
		`<!-- aicr:fingerprint=${problem.fingerprint ?? computeProblemFingerprint(problem)} -->`,
		"",
		renderProblemMarkdown(problem),
	];

	if (options.summary?.trim()) {
		sections.push("", "---", "", "### Review summary", "", options.summary);
	}

	return normalizeMarkdownBody(sections.join("\n"));
}

function parseManagedIssues(raw: unknown, markerPrefix: string, markerLabel: string): readonly ManagedGiteaIssue[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const issues: ManagedGiteaIssue[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") {
			continue;
		}

		const rawIssue = entry as Record<string, unknown>;
		if (rawIssue.pull_request) {
			continue;
		}

		const number = extractIssueNumber(rawIssue);
		const title = String(rawIssue.title ?? "");
		const body = String(rawIssue.body ?? "");
		const state = String(rawIssue.state ?? "");
		if (number === undefined || !title.startsWith(markerPrefix) || !hasManagedProblemIssueMarker(body)) {
			continue;
		}

		if (!body.includes(`<!-- aicr:label=${markerLabel} -->`)) {
			continue;
		}

		const fingerprint = extractManagedIssueFingerprint(body);
		const scopeFingerprint = extractConsolidatedScopeFingerprint(body);
		issues.push({
			number,
			title,
			body,
			state,
			...(typeof rawIssue.html_url === "string" ? { url: rawIssue.html_url } : {}),
			...(fingerprint ? { fingerprint } : {}),
			...(scopeFingerprint ? { scopeFingerprint } : {}),
		});
	}

	return issues;
}

export function createGiteaProblemIssueDispatcher(options: GiteaProblemIssueOptions): GiteaProblemIssueDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	const channel = options.channelName ?? "gitea_problem_issue";
	const markerPrefix = options.markerPrefix ?? "[AICR]";
	const markerLabel = options.markerLabel ?? "aicr-managed";
	const resolvedAction = options.resolvedAction ?? "close";
	const maxRecentIssues = normalizeManagedIssueFetchLimit(options.maxRecentIssues);
    const issueMode = options.issueMode ?? "consolidated";
	const assignCommitter = options.assignCommitter ?? true;
	const addOwnersAsAssignees = options.addOwnersAsAssignees ?? false;
	const ownersFilePath = options.ownersFilePath ?? "OWNERS";
	const severityLabelPrefix = options.severityLabelPrefix;
	const severityLabelColors = options.severityLabelColors;
	const repoPath = [
		baseUrl,
		"api/v1/repos",
		encodePathSegment(options.owner),
		encodePathSegment(options.repo),
	].join("/");
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (options.token) {
		headers.authorization = `token ${options.token}`;
	}

	const severityLabelCache = new Map<string, number>();

	async function request(method: string, endpoint: string, body?: unknown): Promise<unknown> {
		const response = await fetchImpl(endpoint, {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`Gitea problem issue API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		if (response.status === 204) {
			return {};
		}

		return response.json();
	}

	async function fetchOwnersContent(): Promise<string | undefined> {
		if (options.ownersContent !== undefined) {
			return options.ownersContent;
		}

		try {
			const refParam = options.ref ? `?ref=${encodeURIComponent(options.ref)}` : "";
			const raw = await request("GET", `${repoPath}/contents/${encodePathSegment(ownersFilePath)}${refParam}`);
			if (!raw || typeof raw !== "object") {
				return undefined;
			}

			const content = (raw as Record<string, unknown>).content;
			if (typeof content !== "string") {
				return undefined;
			}

			return Buffer.from(content, "base64").toString("utf8");
		} catch {
			return undefined;
		}
	}

	const autoTagLabelCache = new Map<string, number>();

	async function resolveLabelIdByName(labelName: string, color?: string): Promise<number | undefined> {
		const cached = autoTagLabelCache.get(labelName);
		if (cached !== undefined) {
			return cached;
		}

		try {
			const listRaw = await request("GET", `${repoPath}/labels?name=${encodeURIComponent(labelName)}`);
			if (Array.isArray(listRaw)) {
				for (const label of listRaw) {
					if (label && typeof label === "object" && (label as Record<string, unknown>).name === labelName) {
						const id = (label as Record<string, unknown>).id;
						if (typeof id === "number") {
							autoTagLabelCache.set(labelName, id);
							return id;
						}
					}
				}
			}
		} catch {
			// Label list failed, try creating
		}

		try {
			const allLabelsRaw = await request("GET", `${repoPath}/labels`);
			if (Array.isArray(allLabelsRaw)) {
				for (const label of allLabelsRaw) {
					if (label && typeof label === "object" && (label as Record<string, unknown>).name === labelName) {
						const id = (label as Record<string, unknown>).id;
						if (typeof id === "number") {
							autoTagLabelCache.set(labelName, id);
							return id;
						}
					}
				}
			}
		} catch {
			// Continue to create
		}

		const normalizedColor = (color ?? "#ededed").replace(/^#/u, "");
		try {
			const created = await request("POST", `${repoPath}/labels`, {
				name: labelName,
				color: normalizedColor,
			});
			if (created && typeof created === "object") {
				const id = (created as Record<string, unknown>).id;
				if (typeof id === "number") {
					autoTagLabelCache.set(labelName, id);
					return id;
				}
			}
		} catch {
			// Label creation failed
		}

		return undefined;
	}

	async function resolveSeverityLabelId(severity: string): Promise<number | undefined> {
		if (!severityLabelPrefix) {
			return undefined;
		}

		const cached = severityLabelCache.get(severity);
		if (cached !== undefined) {
			return cached;
		}

		const labelName = `${severityLabelPrefix}${severity}`;

		try {
			const listRaw = await request("GET", `${repoPath}/labels?name=${encodeURIComponent(labelName)}`);
			if (Array.isArray(listRaw)) {
				for (const label of listRaw) {
					if (label && typeof label === "object" && (label as Record<string, unknown>).name === labelName) {
						const id = (label as Record<string, unknown>).id;
						if (typeof id === "number") {
							severityLabelCache.set(severity, id);
							return id;
						}
					}
				}
			}
		} catch {
			// Label list failed, try creating
		}

		try {
			const allLabelsRaw = await request("GET", `${repoPath}/labels`);
			if (Array.isArray(allLabelsRaw)) {
				for (const label of allLabelsRaw) {
					if (label && typeof label === "object" && (label as Record<string, unknown>).name === labelName) {
						const id = (label as Record<string, unknown>).id;
						if (typeof id === "number") {
							severityLabelCache.set(severity, id);
							return id;
						}
					}
				}
			}
		} catch {
			// Continue to create
		}

		const colors = { ...DEFAULT_SEVERITY_COLORS, ...(severityLabelColors ?? {}) };
		const color = colors[severity] ?? "#ededed";
		try {
			const created = await request("POST", `${repoPath}/labels`, {
				name: labelName,
				color: color.replace(/^#/u, ""),
			});
			if (created && typeof created === "object") {
				const id = (created as Record<string, unknown>).id;
				if (typeof id === "number") {
					severityLabelCache.set(severity, id);
					return id;
				}
			}
		} catch {
			// Label creation failed
		}

		return undefined;
	}

	async function sendFeishuNotification(
		issueTitle: string,
		issueUrl: string | undefined,
		severity: string,
		problemFile: string,
	): Promise<void> {
		if (!options.notifyFeishu) {
			return;
		}

		try {
			const sections = [
				`**New AICR Issue Created**`,
				`**Severity:** [${severity.toUpperCase()}]`,
				`**File:** ${problemFile}`,
			];
			if (issueUrl) {
				sections.push(`**Link:** [${issueTitle}](${issueUrl})`);
			} else {
				sections.push(`**Title:** ${issueTitle}`);
			}

			const timestamp = Math.floor(Date.now() / 1000);
			const body: Record<string, unknown> = {
				msg_type: "interactive",
				card: {
					elements: [
						{
							tag: "markdown",
							content: toFeishuMarkdown(sections.join("\n")),
						},
					],
				},
			};

			if (options.notifyFeishu.secret) {
				body.timestamp = String(timestamp);
				body.sign = await computeFeishuSign(timestamp, options.notifyFeishu.secret);
			}

			await fetchImpl(options.notifyFeishu.webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch {
			// Feishu notification failure should not block issue creation
		}
	}

	async function listManagedOpenIssues(): Promise<readonly ManagedGiteaIssue[]> {
		const params = new URLSearchParams({
			state: "open",
			type: "issues",
			limit: String(maxRecentIssues),
			page: "1",
		});
		const raw = await request("GET", `${repoPath}/issues?${params.toString()}`);
		return parseManagedIssues(raw, markerPrefix, markerLabel);
	}

	function resolveAssignees(problem: ReviewProblem, owners: OwnersConfig | undefined): string[] {
		const assignees: string[] = [];

		if (assignCommitter && options.committerUsername) {
			assignees.push(options.committerUsername);
		}

		if (addOwnersAsAssignees && owners) {
			const matched = matchOwnersForFile(problem.file, owners);
			for (const owner of matched) {
				if (!assignees.includes(owner)) {
					assignees.push(owner);
				}
			}
		}

		return assignees;
	}

	async function createIssue(
		problem: ReviewProblem,
		summary: string | undefined,
		owners: OwnersConfig | undefined,
	): Promise<DispatchResult> {
		const body: Record<string, unknown> = {
			title: buildProblemIssueTitle(problem, markerPrefix),
			body: buildManagedIssueBody(problem, { channel, markerLabel, ...(summary ? { summary } : {}) }),
		};

		const labelIdList: number[] = [];
		if (options.labelIds && options.labelIds.length > 0) {
			labelIdList.push(...options.labelIds);
		}

		if (options.autoTag) {
			const autoTagId = await resolveLabelIdByName(options.autoTag);
			if (autoTagId !== undefined && !labelIdList.includes(autoTagId)) {
				labelIdList.push(autoTagId);
			}
		}

		if (options.reviewedTag) {
			const reviewedTagId = await resolveLabelIdByName(options.reviewedTag);
			if (reviewedTagId !== undefined && !labelIdList.includes(reviewedTagId)) {
				labelIdList.push(reviewedTagId);
			}
		}

		if (severityLabelPrefix) {
			const severityId = await resolveSeverityLabelId(problem.severity);
			if (severityId !== undefined && !labelIdList.includes(severityId)) {
				labelIdList.push(severityId);
			}
		}

		if (labelIdList.length > 0) {
			body.labels = labelIdList;
		}

		const assignees = resolveAssignees(problem, owners);
		if (assignees.length > 0) {
			body.assignees = assignees;
		}

		const raw = await request("POST", `${repoPath}/issues`, body);
		const externalId = extractExternalId(raw);

		const issueUrl = raw && typeof raw === "object"
			? (raw as Record<string, unknown>).html_url as string | undefined
			: undefined;

		await sendFeishuNotification(
			buildProblemIssueTitle(problem, markerPrefix),
			issueUrl,
			problem.severity,
			problem.file,
		);

		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw: { action: "created", issue: raw },
		};
	}

	async function createConsolidatedIssue(
		problems: readonly ReviewProblem[],
		summary: string | undefined,
		owners: OwnersConfig | undefined,
	): Promise<DispatchResult> {
		const scopeFingerprint = computeScopeFingerprint(channel, options.owner, options.repo);
		const body: Record<string, unknown> = {
			title: buildConsolidatedIssueTitle(problems, markerPrefix),
			body: buildConsolidatedIssueBody(problems, { channel, markerLabel, scopeFingerprint, ...(summary ? { summary } : {}) }),
		};

		const labelIdList: number[] = [];
		if (options.labelIds && options.labelIds.length > 0) {
			labelIdList.push(...options.labelIds);
		}

		if (options.autoTag) {
			const autoTagId = await resolveLabelIdByName(options.autoTag);
			if (autoTagId !== undefined && !labelIdList.includes(autoTagId)) {
				labelIdList.push(autoTagId);
			}
		}

		if (options.reviewedTag) {
			const reviewedTagId = await resolveLabelIdByName(options.reviewedTag);
			if (reviewedTagId !== undefined && !labelIdList.includes(reviewedTagId)) {
				labelIdList.push(reviewedTagId);
			}
		}

		if (severityLabelPrefix) {
			const highest = getHighestSeverity(problems);
			if (highest) {
				const severityId = await resolveSeverityLabelId(highest);
				if (severityId !== undefined && !labelIdList.includes(severityId)) {
					labelIdList.push(severityId);
				}
			}
		}

		if (labelIdList.length > 0) {
			body.labels = labelIdList;
		}

		const allAssignees = collectAllAssignees(problems, owners);
		if (allAssignees.length > 0) {
			body.assignees = allAssignees;
		}

		const raw = await request("POST", `${repoPath}/issues`, body);
		const externalId = extractExternalId(raw);

		const issueUrl = raw && typeof raw === "object"
			? (raw as Record<string, unknown>).html_url as string | undefined
			: undefined;

		const highest = getHighestSeverity(problems);
		await sendFeishuNotification(
			buildConsolidatedIssueTitle(problems, markerPrefix),
			issueUrl,
			highest ?? "info",
			`${problems.length} problems`,
		);

		return {
			channel,
			status: "published",
			...(externalId ? { externalId } : {}),
			raw: { action: "created_consolidated", issue: raw },
		};
	}

	async function updateConsolidatedIssue(
		existing: ManagedGiteaIssue,
		problems: readonly ReviewProblem[],
		summary: string | undefined,
	): Promise<DispatchResult> {
		const scopeFingerprint = computeScopeFingerprint(channel, options.owner, options.repo);
		const body: Record<string, unknown> = {
			title: buildConsolidatedIssueTitle(problems, markerPrefix),
			body: buildConsolidatedIssueBody(problems, { channel, markerLabel, scopeFingerprint, ...(summary ? { summary } : {}) }),
		};

		if (severityLabelPrefix) {
			const labelIdList: number[] = [];
			const highest = getHighestSeverity(problems);
			if (highest) {
				const severityId = await resolveSeverityLabelId(highest);
				if (severityId !== undefined) {
					labelIdList.push(severityId);
				}
			}
			if (labelIdList.length > 0) {
				body.labels = labelIdList;
			}
		}

		const raw = await request("PATCH", `${repoPath}/issues/${existing.number}`, body);
		return {
			channel,
			status: "published",
			externalId: String(existing.number),
			raw: { action: "updated_consolidated", issueNumber: existing.number, issue: raw },
		};
	}

	function collectAllAssignees(problems: readonly ReviewProblem[], owners: OwnersConfig | undefined): string[] {
		const assigneeSet = new Set<string>();
		for (const problem of problems) {
			for (const assignee of resolveAssignees(problem, owners)) {
				assigneeSet.add(assignee);
			}
		}
		return [...assigneeSet];
	}

	async function resolveIssue(issue: ManagedGiteaIssue): Promise<DispatchResult | undefined> {
		if (resolvedAction === "none") {
			return undefined;
		}

		if (resolvedAction === "delete") {
			const raw = await request("DELETE", `${repoPath}/issues/${issue.number}`);
			return {
				channel,
				status: "published",
				externalId: String(issue.number),
				raw: { action: "deleted", issueNumber: issue.number, response: raw },
			};
		}

		await request("POST", `${repoPath}/issues/${issue.number}/comments`, {
			body: [
				"🤖 **AICR lifecycle:** this managed problem is no longer present in the latest analysis.",
				"",
				"Closing the issue automatically. Reopen it if the problem is still valid.",
			].join("\n"),
		});
		const raw = await request("PATCH", `${repoPath}/issues/${issue.number}`, { state: "closed" });
		return {
			channel,
			status: "published",
			externalId: String(issue.number),
			raw: { action: "closed", issueNumber: issue.number, issue: raw },
		};
	}

	const dispatcher = {
		async reconcileProblems(problems: readonly ReviewProblem[], summary?: string): Promise<readonly DispatchResult[]> {
			let owners: OwnersConfig | undefined;

			if (addOwnersAsAssignees) {
				const ownersContent = await fetchOwnersContent();
				if (ownersContent) {
					owners = parseOwnersContent(ownersContent);
				}
			}

			if (issueMode === "consolidated") {
				const existingIssues = await listManagedOpenIssues();
				const scopeFingerprint = computeScopeFingerprint(channel, options.owner, options.repo);
				const existingConsolidated = existingIssues.find(
					(issue) => issue.scopeFingerprint === scopeFingerprint,
				);

				const results: DispatchResult[] = [];

				if (problems.length === 0) {
					if (existingConsolidated && resolvedAction !== "none") {
						const result = await resolveIssue(existingConsolidated);
						if (result) {
							results.push(result);
						}
					}
					return results;
				}

				if (existingConsolidated) {
					results.push(await updateConsolidatedIssue(existingConsolidated, problems, summary));
				} else {
					results.push(await createConsolidatedIssue(problems, summary, owners));
				}

				for (const issue of existingIssues) {
					if (issue.scopeFingerprint === scopeFingerprint) {
						continue;
					}
					if (!isConsolidatedManagedIssue(issue.body)) {
						continue;
					}
					const result = await resolveIssue(issue);
					if (result) {
						results.push(result);
					}
				}

				return results;
			}

			const preparedProblems = problems.map(ensureProblemFingerprint);

			const currentFingerprints = new Set(preparedProblems.map((problem) => problem.fingerprint!));
			const existingIssues = await listManagedOpenIssues();
			const existingByFingerprint = new Map<string, ManagedGiteaIssue>();
			for (const issue of existingIssues) {
				if (issue.fingerprint) {
					existingByFingerprint.set(issue.fingerprint, issue);
				}
			}

			const results: DispatchResult[] = [];
			for (const problem of preparedProblems) {
				if (!existingByFingerprint.has(problem.fingerprint!)) {
					results.push(await createIssue(problem, summary, owners));
				}
			}

			for (const issue of existingIssues) {
				if (!issue.fingerprint || currentFingerprints.has(issue.fingerprint)) {
					continue;
				}

				const result = await resolveIssue(issue);
				if (result) {
					results.push(result);
				}
			}

			return results;
		},
	};

	return dispatcher;
}

export interface FeishuBotOptions {
	readonly webhookUrl: string;
	readonly secret?: string | undefined;
	readonly channelName?: string | undefined;
	readonly fetch?: FetchLike | undefined;
}

export interface FeishuBotDispatcher {
	publishAggregatedProblems(problems: readonly ReviewProblem[], summary?: string, mentionText?: string): Promise<DispatchResult>;
}

async function computeFeishuSign(timestamp: number, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const stringToSign = `${timestamp}\n${secret}`;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(stringToSign),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(""));
	return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export function createFeishuBotDispatcher(options: FeishuBotOptions): FeishuBotDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const channel = options.channelName ?? "feishu_bot";

	const dispatcher = {
		async publishAggregatedProblems(
			problems: readonly ReviewProblem[],
			summary?: string,
			mentionText?: string,
		): Promise<DispatchResult> {
			const sections: string[] = [];
			if (summary) {
				sections.push(summary.trim());
			}
			sections.push(...buildImProblemSections(problems));

			const timestamp = Math.floor(Date.now() / 1000);
			const body: Record<string, unknown> = {
				msg_type: "interactive",
				card: {
					elements: [
						{
							tag: "markdown",
							content: toFeishuMarkdown(sections.join("\n")),
						},
					],
				},
			};

			if (mentionText) {
				const elements = body.card as Record<string, unknown>;
				elements.elements = [
					...(elements.elements as unknown[]),
					{ tag: "markdown", content: mentionText },
				];
			}

			if (options.secret) {
				body.timestamp = String(timestamp);
				body.sign = await computeFeishuSign(timestamp, options.secret);
			}

			const response = await fetchImpl(options.webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				throw new OutputDispatchError(`Feishu webhook returned ${response.status}.`, {
					status: response.status,
					responseBody: await response.text(),
				});
			}

			const raw = await response.json();
			return { channel, status: "published", raw };
		},
	};

	return dispatcher;
}

export interface WeComBotOptions {
	readonly webhookUrl: string;
	readonly channelName?: string;
	readonly mentionedMobileList?: readonly string[];
	readonly fetch?: FetchLike;
}

export interface WeComBotDispatcher {
	publishAggregatedProblems(problems: readonly ReviewProblem[], summary?: string, mentionText?: string): Promise<DispatchResult>;
}

export function createWeComBotDispatcher(options: WeComBotOptions): WeComBotDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const channel = options.channelName ?? "wecom_bot";

	const dispatcher = {
		async publishAggregatedProblems(
			problems: readonly ReviewProblem[],
			summary?: string,
			mentionText?: string,
		): Promise<DispatchResult> {
			const sections: string[] = [];
			if (summary) {
				sections.push(summary.trim());
			}
			if (mentionText) {
				sections.push(mentionText);
			}
			sections.push(...buildImProblemSections(problems));

			const body: Record<string, unknown> = {
				msgtype: "markdown",
				markdown: {
					content: toWeComMarkdown(sections.join("\n")),
				},
			};

			if (options.mentionedMobileList && options.mentionedMobileList.length > 0) {
				const md = body.markdown as Record<string, unknown>;
				body.markdown = {
					...md,
					mentioned_mobile_list: options.mentionedMobileList,
				};
			}

			const response = await fetchImpl(options.webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				throw new OutputDispatchError(`WeCom webhook returned ${response.status}.`, {
					status: response.status,
					responseBody: await response.text(),
				});
			}

			const raw = await response.json();
			return { channel, status: "published", raw };
		},
	};

	return dispatcher;
}

export function computeProblemFingerprint(problem: {
	readonly file: string;
	readonly line: number;
	readonly category: string;
	readonly message: string;
}): string {
	const raw = `${problem.file}:${problem.line}:${problem.category}:${problem.message}`;
	return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
