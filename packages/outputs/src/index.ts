import { createHash } from "node:crypto";

export const outputsPackageName = "@aicr/outputs";

export {
	clearTemplateCache,
	createTemplateResolver,
	getBuiltinTemplate,
	renderBuiltinTemplate,
	renderTemplate,
	toTemplateFinding,
	type TemplateContext,
	type TemplateFinding,
	type TemplateKind,
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

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ReviewFinding {
	readonly file: string;
	readonly line: number;
	readonly endLine?: number;
	readonly lineCommentAllowed?: boolean;
	readonly severity: FindingSeverity;
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
	publishFinding(finding: ReviewFinding): Promise<DispatchResult>;
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

export function renderFindingMarkdown(finding: ReviewFinding): string {
	if (finding.renderedMarkdown) {
		return finding.renderedMarkdown;
	}

	const location = finding.endLine ? `${finding.file}:${finding.line}-${finding.endLine}` : `${finding.file}:${finding.line}`;
	const parts = [
		`**${finding.severity.toUpperCase()} · ${finding.category}**`,
		"",
		finding.message,
		"",
		`Location: \`${location}\``,
	];

	if (finding.suggestion) {
		parts.push("", "Suggested fix:", "", finding.suggestion);
	}

	if (finding.fingerprint) {
		parts.push("", `<!-- aicr:fingerprint=${finding.fingerprint} -->`);
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

	function generalReviewBody(finding: ReviewFinding): Record<string, unknown> {
		return {
			event: "COMMENT",
			body: renderFindingMarkdown(finding),
		};
	}

	return {
		async publishFinding(finding: ReviewFinding): Promise<DispatchResult> {
			if (finding.lineCommentAllowed === false) {
				return postReview(generalReviewBody(finding));
			}

			const body = {
				event: "COMMENT",
				body: `AICR finding for ${finding.file}:${finding.line}`,
				comments: [
					{
						path: finding.file,
						new_position: finding.line,
						body: renderFindingMarkdown(finding),
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
					return postReview(generalReviewBody(finding));
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
	publishFinding(finding: ReviewFinding): Promise<DispatchResult>;
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

	function generalReviewBody(finding: ReviewFinding): Record<string, unknown> {
		return {
			event: "COMMENT",
			body: renderFindingMarkdown(finding),
		};
	}

	return {
		async publishFinding(finding: ReviewFinding): Promise<DispatchResult> {
			if (finding.lineCommentAllowed === false) {
				return postReview(generalReviewBody(finding));
			}

			const body = {
				event: "COMMENT",
				body: `AICR finding for ${finding.file}:${finding.line}`,
				comments: [
					{
						path: finding.file,
						line: finding.line,
						side: "RIGHT",
						body: renderFindingMarkdown(finding),
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
					return postReview(generalReviewBody(finding));
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
	publishFinding(finding: ReviewFinding): Promise<DispatchResult>;
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

	function canPublishLineComment(finding: ReviewFinding): boolean {
		return finding.lineCommentAllowed !== false && Boolean(options.baseSha && options.headSha);
	}

	function generalNoteBody(finding: ReviewFinding): Record<string, unknown> {
		return { body: renderFindingMarkdown(finding) };
	}

	return {
		async publishFinding(finding: ReviewFinding): Promise<DispatchResult> {
			const notesEndpoint = `${mrPath}/notes`;
			if (!canPublishLineComment(finding)) {
				return post(notesEndpoint, generalNoteBody(finding), "GitLab merge request note API");
			}

			const discussionsEndpoint = `${mrPath}/discussions`;
			const body = {
				body: renderFindingMarkdown(finding),
				position: {
					position_type: "text",
					base_sha: options.baseSha,
					start_sha: options.startSha ?? options.baseSha,
					head_sha: options.headSha,
					old_path: finding.file,
					new_path: finding.file,
					new_line: finding.line,
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
					return post(notesEndpoint, generalNoteBody(finding), "GitLab merge request note API");
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
	publishAggregatedFindings(findings: readonly ReviewFinding[], summary?: string): Promise<DispatchResult>;
}

export function createGiteaIssueDispatcher(options: GiteaIssueOptions): GiteaIssueDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	const channel = options.channelName ?? "gitea_issue";

	return {
		async publishAggregatedFindings(findings, summary): Promise<DispatchResult> {
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
			if (findings.length > 0) {
				sections.push(`### Findings (${findings.length})`, "");
				for (const finding of findings) {
					sections.push(renderFindingMarkdown(finding));
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
}

export type GiteaFindingIssueResolvedAction = "none" | "close" | "delete";

export interface GiteaFindingIssueOptions {
	readonly baseUrl: string;
	readonly token?: string;
	readonly owner: string;
	readonly repo: string;
	readonly channelName?: string;
	readonly markerPrefix?: string;
	readonly markerLabel?: string;
	readonly labelIds?: readonly number[];
	readonly resolvedAction?: GiteaFindingIssueResolvedAction;
	readonly fetch?: FetchLike;
}

export interface GiteaFindingIssueDispatcher {
	reconcileFindings(findings: readonly ReviewFinding[], summary?: string): Promise<readonly DispatchResult[]>;
}

interface ManagedGiteaIssue {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly state: string;
	readonly url?: string;
	readonly fingerprint?: string;
}

const AICR_MANAGED_ISSUE_MARKER = "<!-- aicr:managed=finding-issue -->";

function extractManagedIssueFingerprint(body: string): string | undefined {
	const match = /<!--\s*aicr:fingerprint=([^\s-][^\s]*)\s*-->/u.exec(body);
	return match?.[1];
}

function extractIssueNumber(raw: Record<string, unknown>): number | undefined {
	const value = raw.number ?? raw.index;
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function buildFindingIssueTitle(finding: ReviewFinding, markerPrefix: string): string {
	const location = finding.endLine ? `${finding.file}:${finding.line}-${finding.endLine}` : `${finding.file}:${finding.line}`;
	const normalizedMessage = finding.message.replace(/\s+/gu, " ").trim();
	const title = `${markerPrefix} [${finding.severity.toUpperCase()}] ${finding.category}: ${location} - ${normalizedMessage}`;
	return title.length > 240 ? `${title.slice(0, 237)}...` : title;
}

function ensureFindingFingerprint(finding: ReviewFinding): ReviewFinding {
	return finding.fingerprint ? finding : { ...finding, fingerprint: computeFindingFingerprint(finding) };
}

function buildManagedIssueBody(
	finding: ReviewFinding,
	options: {
		readonly channel: string;
		readonly markerLabel: string;
		readonly summary?: string;
	},
): string {
	const sections = [
		AICR_MANAGED_ISSUE_MARKER,
		`<!-- aicr:channel=${options.channel} -->`,
		`<!-- aicr:label=${options.markerLabel} -->`,
		`<!-- aicr:fingerprint=${finding.fingerprint ?? computeFindingFingerprint(finding)} -->`,
		"",
		renderFindingMarkdown(finding),
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
		if (number === undefined || !title.startsWith(markerPrefix) || !body.includes(AICR_MANAGED_ISSUE_MARKER)) {
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

export function createGiteaFindingIssueDispatcher(options: GiteaFindingIssueOptions): GiteaFindingIssueDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	const channel = options.channelName ?? "gitea_finding_issue";
	const markerPrefix = options.markerPrefix ?? "[AICR]";
	const markerLabel = options.markerLabel ?? "aicr-managed";
	const resolvedAction = options.resolvedAction ?? "close";
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

	async function request(method: string, endpoint: string, body?: unknown): Promise<unknown> {
		const response = await fetchImpl(endpoint, {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});

		if (!response.ok) {
			throw new OutputDispatchError(`Gitea finding issue API returned ${response.status}.`, {
				status: response.status,
				responseBody: await response.text(),
			});
		}

		if (response.status === 204) {
			return {};
		}

		return response.json();
	}

	async function listManagedOpenIssues(): Promise<readonly ManagedGiteaIssue[]> {
		const params = new URLSearchParams({ state: "open", type: "issues" });
		const raw = await request("GET", `${repoPath}/issues?${params.toString()}`);
		return parseManagedIssues(raw, markerPrefix, markerLabel);
	}

	async function createIssue(finding: ReviewFinding, summary: string | undefined): Promise<DispatchResult> {
		const body: Record<string, unknown> = {
			title: buildFindingIssueTitle(finding, markerPrefix),
			body: buildManagedIssueBody(finding, { channel, markerLabel, ...(summary ? { summary } : {}) }),
		};
		if (options.labelIds && options.labelIds.length > 0) {
			body.labels = [...options.labelIds];
		}

		const raw = await request("POST", `${repoPath}/issues`, body);
		const externalId = extractExternalId(raw);
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
				"🤖 **AICR lifecycle:** this managed finding is no longer present in the latest analysis.",
				"",
				"Closing the issue automatically. Reopen it if the finding is still valid.",
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

	return {
		async reconcileFindings(findings, summary): Promise<readonly DispatchResult[]> {
			const preparedFindings = findings.map(ensureFindingFingerprint);
			const currentFingerprints = new Set(preparedFindings.map((finding) => finding.fingerprint!));
			const existingIssues = await listManagedOpenIssues();
			const existingByFingerprint = new Map<string, ManagedGiteaIssue>();
			for (const issue of existingIssues) {
				if (issue.fingerprint) {
					existingByFingerprint.set(issue.fingerprint, issue);
				}
			}

			const results: DispatchResult[] = [];
			for (const finding of preparedFindings) {
				if (!existingByFingerprint.has(finding.fingerprint!)) {
					results.push(await createIssue(finding, summary));
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
}

export interface FeishuBotOptions {
	readonly webhookUrl: string;
	readonly secret?: string | undefined;
	readonly channelName?: string | undefined;
	readonly fetch?: FetchLike | undefined;
}

export interface FeishuBotDispatcher {
	publishAggregatedFindings(findings: readonly ReviewFinding[], summary?: string, mentionText?: string): Promise<DispatchResult>;
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

	return {
		async publishAggregatedFindings(findings, summary, mentionText): Promise<DispatchResult> {
			const sections: string[] = [];
			if (summary) {
				sections.push(summary);
			}
			if (findings.length > 0) {
				sections.push("", `Findings: ${findings.length}`);
				for (const finding of findings.slice(0, 10)) {
					sections.push(`- [${finding.severity.toUpperCase()}] ${finding.category}: ${finding.file}:${finding.line}`);
				}
				if (findings.length > 10) {
					sections.push(`... and ${findings.length - 10} more`);
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
}

export interface WeComBotOptions {
	readonly webhookUrl: string;
	readonly channelName?: string;
	readonly mentionedMobileList?: readonly string[];
	readonly fetch?: FetchLike;
}

export interface WeComBotDispatcher {
	publishAggregatedFindings(findings: readonly ReviewFinding[], summary?: string, mentionText?: string): Promise<DispatchResult>;
}

export function createWeComBotDispatcher(options: WeComBotOptions): WeComBotDispatcher {
	const fetchImpl = options.fetch ?? defaultFetch();
	const channel = options.channelName ?? "wecom_bot";

	return {
		async publishAggregatedFindings(findings, summary, mentionText): Promise<DispatchResult> {
			const sections: string[] = [];
			if (summary) {
				sections.push(summary);
			}
			if (mentionText) {
				sections.push(mentionText);
			}
			if (findings.length > 0) {
				sections.push("", `Findings: ${findings.length}`);
				for (const finding of findings.slice(0, 10)) {
					sections.push(`- [${finding.severity.toUpperCase()}] ${finding.category}: ${finding.file}:${finding.line}`);
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
}

export function computeFindingFingerprint(finding: {
	readonly file: string;
	readonly line: number;
	readonly category: string;
	readonly message: string;
}): string {
	const raw = `${finding.file}:${finding.line}:${finding.category}:${finding.message}`;
	return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}