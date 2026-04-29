export const outputsPackageName = "@aicr/outputs";

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ReviewFinding {
	readonly file: string;
	readonly line: number;
	readonly endLine?: number;
	readonly severity: FindingSeverity;
	readonly category: string;
	readonly message: string;
	readonly suggestion?: string;
	readonly fingerprint?: string;
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

export function renderFindingMarkdown(finding: ReviewFinding): string {
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

	return {
		async publishFinding(finding: ReviewFinding): Promise<DispatchResult> {
			const endpoint = [
				baseUrl,
				"api/v1/repos",
				encodePathSegment(options.owner),
				encodePathSegment(options.repo),
				"pulls",
				String(options.pullNumber),
				"reviews",
			].join("/");
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
			const headers: Record<string, string> = {
				"content-type": "application/json",
			};
			if (options.token) {
				headers.authorization = `token ${options.token}`;
			}

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
		},
	};
}