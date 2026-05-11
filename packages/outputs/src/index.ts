import { createHash } from "node:crypto";

export const outputsPackageName = "@aicr/outputs";

export {
	clearTemplateCache,
	createTemplateResolver,
	getBuiltinTemplate,
	renderBuiltinTemplate,
	renderTemplate,
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
	buildAtMentions,
	renderMentions,
	resolveAuthorUsername,
	type AuthorMentionContext,
	type AuthorResolutionOptions,
	type MentionChannelKind,
} from "./author-resolution.js";

export type ProblemSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ReviewProblem {
	readonly file: string;
	readonly line: number;
	readonly endLine?: number;
	readonly lineCommentAllowed?: boolean;
	readonly severity: ProblemSeverity;
	readonly category: string;
	readonly message: string;
	readonly suggestion?: string;
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

export interface GiteaPullRequestReviewOptions {
	readonly baseUrl: string;
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
	readonly pullNumber: number;
	readonly channelName?: string;
	readonly fetch?: FetchLike;
}

export interface GiteaPullRequestReviewDispatcher {
	publishProblem(problem: ReviewProblem): Promise<DispatchResult>;
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

function shouldFallbackToGeneralComment(status: number): boolean {
	return status === 422;
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

	if (problem.fingerprint) {
		parts.push("", `<!-- aicr:fingerprint=${problem.fingerprint} -->`);
	}

	return parts.join("\n");
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
	const endpoint = [
		baseUrl,
		"api/v1/repos",
		encodePathSegment(options.owner),
		encodePathSegment(options.repo),
		"pulls",
		String(options.pullNumber),
		"reviews",
	].join("/");
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (options.token) {
		headers.authorization = `token ${options.token}`;
	}

	async function postReview(body: Record<string, unknown>): Promise<DispatchResult> {
		const response = await fetchImpl(endpoint, {
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

	function generalReviewBody(problem: ReviewProblem): Record<string, unknown> {
		return {
			event: "COMMENT",
			body: renderProblemMarkdown(problem),
		};
	}

	const dispatcher = {
		async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
			if (problem.lineCommentAllowed === false) {
				return postReview(generalReviewBody(problem));
			}

			const body = {
				event: "COMMENT",
				body: `AICR problem for ${problem.file}:${problem.line}`,
				comments: [
					{
						path: problem.file,
						new_position: problem.line,
						body: renderProblemMarkdown(problem),
					},
				],
			};

			const response = await fetchImpl(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				if (shouldFallbackToGeneralComment(response.status)) {
					await response.text();
					return postReview(generalReviewBody(problem));
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
		},
	};

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
}

export interface GithubPullRequestReviewDispatcher {
	publishProblem(problem: ReviewProblem): Promise<DispatchResult>;
}

export function createGithubPullRequestReviewDispatcher(
	options: GithubPullRequestReviewOptions,
): GithubPullRequestReviewDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
	const channel = options.channelName ?? "github_pr_review";
	const endpoint = [
		baseUrl,
		"repos",
		encodePathSegment(options.owner),
		encodePathSegment(options.repo),
		"pulls",
		String(options.pullNumber),
		"reviews",
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
		const response = await fetchImpl(endpoint, {
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

	function generalReviewBody(problem: ReviewProblem): Record<string, unknown> {
		return {
			event: "COMMENT",
			body: renderProblemMarkdown(problem),
		};
	}

	const dispatcher = {
		async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
			if (problem.lineCommentAllowed === false) {
				return postReview(generalReviewBody(problem));
			}

			const body = {
				event: "COMMENT",
				body: `AICR problem for ${problem.file}:${problem.line}`,
				comments: [
					{
						path: problem.file,
						line: problem.line,
						side: "RIGHT",
						body: renderProblemMarkdown(problem),
					},
				],
			};

			const response = await fetchImpl(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				if (shouldFallbackToGeneralComment(response.status)) {
					await response.text();
					return postReview(generalReviewBody(problem));
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
}

export interface GitlabMergeRequestReviewDispatcher {
	publishProblem(problem: ReviewProblem): Promise<DispatchResult>;
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

	const dispatcher = {
		async publishProblem(problem: ReviewProblem): Promise<DispatchResult> {
			const notesEndpoint = `${mrPath}/notes`;
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
	};

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
}

export interface GiteaIssueDispatcher {
	publishAggregatedProblems(problems: readonly ReviewProblem[], summary?: string): Promise<DispatchResult>;
}

export function createGiteaIssueDispatcher(options: GiteaIssueOptions): GiteaIssueDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	const channel = options.channelName ?? "gitea_issue";

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

			const body = sections.join("\n");
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
	readonly resolvedAction?: GiteaProblemIssueResolvedAction;
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

function buildProblemIssueTitle(problem: ReviewProblem, markerPrefix: string): string {
	const location = problem.endLine ? `${problem.file}:${problem.line}-${problem.endLine}` : `${problem.file}:${problem.line}`;
	const normalizedMessage = problem.message.replace(/\s+/gu, " ").trim();
	const title = `${markerPrefix} [${problem.severity.toUpperCase()}] ${problem.category}: ${location} - ${normalizedMessage}`;
	return title.length > 240 ? `${title.slice(0, 237)}...` : title;
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

	return sections.join("\n");
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
		issues.push({
			number,
			title,
			body,
			state,
			...(typeof rawIssue.html_url === "string" ? { url: rawIssue.html_url } : {}),
			...(fingerprint ? { fingerprint } : {}),
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
							content: sections.join("\n"),
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
		const params = new URLSearchParams({ state: "open", type: "issues" });
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
			const preparedProblems = problems.map(ensureProblemFingerprint);
			let owners: OwnersConfig | undefined;

			if (addOwnersAsAssignees) {
				const ownersContent = await fetchOwnersContent();
				if (ownersContent) {
					owners = parseOwnersContent(ownersContent);
				}
			}

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
				sections.push(summary);
			}
			if (problems.length > 0) {
				sections.push("", `Problems: ${problems.length}`);
				for (const problem of problems.slice(0, 10)) {
					sections.push(`- [${problem.severity.toUpperCase()}] ${problem.category}: ${problem.file}:${problem.line}`);
				}
				if (problems.length > 10) {
					sections.push(`... and ${problems.length - 10} more`);
				}
			}

			const timestamp = Math.floor(Date.now() / 1000);
			const body: Record<string, unknown> = {
				msg_type: "interactive",
				card: {
					elements: [
						{
							tag: "markdown",
							content: sections.join("\n"),
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
				sections.push(summary);
			}
			if (mentionText) {
				sections.push(mentionText);
			}
			if (problems.length > 0) {
				sections.push("", `Problems: ${problems.length}`);
				for (const problem of problems.slice(0, 10)) {
					sections.push(`- [${problem.severity.toUpperCase()}] ${problem.category}: ${problem.file}:${problem.line}`);
				}
			}

			const body: Record<string, unknown> = {
				msgtype: "markdown",
				markdown: {
					content: sections.join("\n"),
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
