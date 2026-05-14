import { describe, expect, it } from "vitest";

import {
	createGithubProblemIssueDispatcher,
	computeScopeFingerprint,
	renderProblemMarkdown,
	type FetchLike,
	type ReviewProblem,
} from "../src/index.js";

function response(body: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		async json() {
			return body;
		},
		async text() {
			return JSON.stringify(body);
		},
	};
}

function measureDisplayWidth(value: string): number {
	let width = 0;
	for (const char of value) {
		const code = char.codePointAt(0)!;
		width += (
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
		) ? 2 : 1;
	}
	return width;
}

const problem: ReviewProblem = {
	file: "src/auth.ts",
	line: 12,
	severity: "critical",
	category: "security",
	message: "SQL query uses unsanitized input.",
	suggestion: "Use parameterized queries.",
	fingerprint: "fp-sql",
};

const managedBody = [
	"<!-- aicr:managed=problem-issue -->",
	"<!-- aicr:channel=github-issues -->",
	"<!-- aicr:label=aicr-managed -->",
	"<!-- aicr:fingerprint=fp-old -->",
	"",
	"Old problem",
].join("\n");

describe("createGithubProblemIssueDispatcher", () => {
	it("creates one marked issue per new problem with GitHub API headers", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			token: "gh-token",
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			channelName: "github-issues",
			markerPrefix: "[AICR Test]",
			markerLabel: "aicr-managed",
			labels: ["bug"],
			fetch: async (url, init) => {
				calls.push({ url, init });
				return calls.length === 1 ? response([]) : response({ id: 99, number: 7, html_url: "https://github.com/my-org/my-repo/issues/7" });
			},
		});

		const results = await dispatcher.reconcileProblems([problem], "Summary text");

		expect(results).toHaveLength(1);
		expect(results[0]?.externalId).toBe("99");

		expect(calls[0]?.url).toBe("https://api.github.com/repos/my-org/my-repo/issues?state=open&sort=updated&direction=desc&per_page=20&page=1");
		expect(calls[1]?.url).toBe("https://api.github.com/repos/my-org/my-repo/issues");
		expect(calls[1]?.init?.headers).toMatchObject({
			authorization: "Bearer gh-token",
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
		});

		const body = JSON.parse(calls[1]?.init?.body ?? "{}");
		expect(body.title).toBe("[AICR Test] [CRITICAL] src/auth.ts:12 · SQL query uses unsanitized input");
		expect(body.title).not.toContain(" - ");
		expect(body.body).toContain("<!-- aicr:managed=problem-issue -->");
		expect(body.body).toContain("<!-- aicr:fingerprint=fp-sql -->");
		expect(body.body).toContain("Summary text");
		expect(body.labels).toEqual(["bug"]);
	});

	it("does not duplicate an open managed issue with the same fingerprint", async () => {
		const calls: string[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url) => {
				calls.push(url);
				return response([
					{
						number: 7,
						title: "[AICR] [CRITICAL] security: src/auth.ts:12",
						body: managedBody.replace("fp-old", "fp-sql"),
						state: "open",
					},
				]);
			},
		});

		const results = await dispatcher.reconcileProblems([problem]);

		expect(results).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("closes stale managed issues when problems disappear", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			channelName: "github-issues",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (calls.length === 1) {
					return response([
						{
							number: 42,
							title: "[AICR] [HIGH] correctness: src/app.ts:1",
							body: managedBody,
							state: "open",
						},
					]);
				}
				return response({ id: calls.length });
			},
		});

		const results = await dispatcher.reconcileProblems([]);

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "closed", issueNumber: 42 });
		expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
			"GET https://api.github.com/repos/my-org/my-repo/issues?state=open&sort=updated&direction=desc&per_page=20&page=1",
			"POST https://api.github.com/repos/my-org/my-repo/issues/42/comments",
			"PATCH https://api.github.com/repos/my-org/my-repo/issues/42",
		]);
		expect(JSON.parse(calls[2]?.init?.body ?? "{}")).toEqual({ state: "closed" });
	});

	it("uses a configured recent managed issue fetch limit", async () => {
		const calls: string[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			maxRecentIssues: 7,
			fetch: async (url) => {
				calls.push(url);
				return response([]);
			},
		});

		await dispatcher.reconcileProblems([]);

		expect(calls).toEqual([
			"https://api.github.com/repos/my-org/my-repo/issues?state=open&sort=updated&direction=desc&per_page=7&page=1",
		]);
	});

	it("skips resolvedAction none for stale issues", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			resolvedAction: "none",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response([
					{ number: 42, title: "[AICR] stale", body: managedBody, state: "open" },
				]);
			},
		});

		const results = await dispatcher.reconcileProblems([]);
		expect(results).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("adds committer and matched owners as assignees", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const authProblem: ReviewProblem = {
			file: "src/auth/login.ts",
			line: 5,
			severity: "high",
			category: "correctness",
			message: "Missing null check.",
			fingerprint: "fp-auth",
		};
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			committerUsername: "committer-user",
			addOwnersAsAssignees: true,
			ownersContent: [
				"reviewers:",
				"  - admin1",
				"paths:",
				'  "src/auth/":',
				"    - alice",
				"    - bob",
			].join("\n"),
			fetch: async (url, init) => {
				calls.push({ url, init });
				return calls.length === 1 ? response([]) : response({ id: 100, number: 10 });
			},
		});

		const results = await dispatcher.reconcileProblems([authProblem]);

		expect(results).toHaveLength(1);
		const body = JSON.parse(calls[1]?.init?.body ?? "{}");
		expect(body.assignees).toContain("committer-user");
		expect(body.assignees).toContain("alice");
		expect(body.assignees).toContain("bob");
	});

	it("auto-creates severity labels using string names (not IDs)", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			severityLabelPrefix: "aicr:problem:",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.endsWith("/labels") && init?.method === "POST") {
					return response({ id: 50, name: "aicr:problem:critical", color: "b60205" });
				}
				if (url.includes("/issues?state=open")) {
					return response([]);
				}
				if (url.endsWith("/labels")) {
					return response([]);
				}
				return response({ id: 200, number: 20 });
			},
		});

		await dispatcher.reconcileProblems([problem]);

		const issueBody = JSON.parse(
			calls.find((c) => c.url.endsWith("/repos/my-org/my-repo/issues") && c.init?.method === "POST")?.init?.body ?? "{}",
		);
		expect(issueBody.labels).toContain("aicr:problem:critical");
	});

	it("fetches repository labels only once for auto, reviewed, and severity labels", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			autoTag: "aicr",
			reviewedTag: "aicr:reviewed",
			severityLabelPrefix: "aicr:problem:",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([]);
				}
				if (url.endsWith("/repos/my-org/my-repo/labels")) {
					return response([
						{ id: 1, name: "aicr", color: "ededed" },
						{ id: 2, name: "aicr:reviewed", color: "ededed" },
						{ id: 3, name: "aicr:problem:critical", color: "b60205" },
					]);
				}
				return response({ id: 201, number: 21 });
			},
		});

		await dispatcher.reconcileProblems([problem]);

		const labelListCalls = calls.filter((c) => c.url.endsWith("/repos/my-org/my-repo/labels") && !c.init?.method);
		expect(labelListCalls).toHaveLength(1);
		const issueBody = JSON.parse(
			calls.find((c) => c.url.endsWith("/repos/my-org/my-repo/issues") && c.init?.method === "POST")?.init?.body ?? "{}",
		);
		expect(issueBody.labels).toEqual(["aicr", "aicr:reviewed", "aicr:problem:critical"]);
	});

	it("sends Feishu notification after creating an issue", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			notifyFeishu: {
				webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
				secret: "test-secret",
			},
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([]);
				}
				if (url.endsWith("/my-repo/issues") && init?.method === "POST") {
					return response({
						id: 300,
						number: 30,
						html_url: "https://github.com/my-org/my-repo/issues/30",
					});
				}
				return response({ code: 0 });
			},
		});

		await dispatcher.reconcileProblems([problem]);

		const feishuCall = calls.find((c) => c.url.includes("open.feishu.cn"));
		expect(feishuCall).toBeDefined();
		const body = JSON.parse(feishuCall?.init?.body ?? "{}");
		expect(body.msg_type).toBe("interactive");
		const content = (body.card.elements as Array<{ content: string }>)[0]?.content ?? "";
		expect(content).toContain("[CRITICAL]");
		expect(content).toContain("https://github.com/my-org/my-repo/issues/30");
		expect(body.sign).toBeDefined();
	});

	it("supports custom base URL for GitHub Enterprise", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			baseUrl: "https://github.enterprise.com/api/v3",
			token: "ghe-token",
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return calls.length === 1 ? response([]) : response({ id: 99, number: 7 });
			},
		});

		await dispatcher.reconcileProblems([problem]);

		expect(calls[0]?.url).toContain("https://github.enterprise.com/api/v3/repos/my-org/my-repo");
		expect(calls[1]?.init?.headers).toMatchObject({
			authorization: "Bearer ghe-token",
		});
	});

	it("ignores PRs when listing managed issues", async () => {
		const calls: string[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url) => {
				calls.push(url);
				return response([
					{
						number: 7,
						title: "[AICR] [CRITICAL] security: src/auth.ts:12",
						body: managedBody.replace("fp-old", "fp-sql"),
						state: "open",
						pull_request: { url: "https://github.com/my-org/my-repo/pull/7" },
					},
				]);
			},
		});

		const results = await dispatcher.reconcileProblems([problem]);

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "created" });
	});

	it("keeps managed issue titles concise for verbose messages", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return calls.length === 1 ? response([]) : response({ id: 101, number: 8 });
			},
		});

		await dispatcher.reconcileProblems([{
			...problem,
			message: "The authentication retry path can return a success response before persisting the failed login attempt, allowing audit records to be silently dropped when storage is temporarily unavailable. This is intentionally verbose.",
		}]);

		const body = JSON.parse(calls[1]?.init?.body ?? "{}");
		expect(body.title.length).toBeLessThanOrEqual(72);
		expect(body.title).toContain("src/auth.ts:12");
		expect(body.title).toContain("authentication retry path");
		expect(body.title).not.toContain("This is intentionally verbose");
	});

	it("keeps managed issue titles visually short for CJK messages", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return calls.length === 1 ? response([]) : response({ id: 102, number: 9 });
			},
		});

		await dispatcher.reconcileProblems([{
			...problem,
			file: "src/services/payment/reconciliation-handler.ts",
			message: "支付对账流程在网络重试后可能重复写入结算记录，导致同一批次被重复结算并触发后续告警，这里故意写得很长。",
		}]);

		const body = JSON.parse(calls[1]?.init?.body ?? "{}");
		expect(body.title).toContain("reconciliation-handler.ts:12");
		expect(body.title).toContain("支付对账流程");
		expect(body.title).not.toContain("这里故意写得很长");
		expect(measureDisplayWidth(body.title)).toBeLessThanOrEqual(72);
	});

	it("consolidated mode creates one issue with all problems", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const problem2: ReviewProblem = {
			file: "src/utils.ts",
			line: 30,
			severity: "medium",
			category: "performance",
			message: "Inefficient loop detected.",
		};
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			markerPrefix: "[AICR]",
			issueMode: "consolidated",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([]);
				}
				return response({ id: 500, number: 50, html_url: "https://github.com/my-org/my-repo/issues/50" });
			},
		});

		const results = await dispatcher.reconcileProblems([problem, problem2], "Review summary");

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "created_consolidated" });

		const body = JSON.parse(
			calls.find((c) => c.url.endsWith("/repos/my-org/my-repo/issues") && c.init?.method === "POST")?.init?.body ?? "{}",
		);
		expect(body.title).toBe("[AICR] [CRITICAL] 2 problems · SQL query uses unsanitized input");
		expect(body.title).not.toContain("Code Review Report");
		expect(body.body).toContain("<!-- aicr:consolidated=true -->");
		expect(body.body).toContain("<!-- aicr:scope_fingerprint=");
		expect(body.body).toContain("SQL query uses unsanitized input");
		expect(body.body).toContain("Inefficient loop detected");
		expect(body.body).toContain("Review summary");
		expect(body.body).toContain("### CRITICAL (1)");
		expect(body.body).toContain("### MEDIUM (1)");
	});

	it("consolidated mode updates existing issue on re-analysis", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const consolidatedBody = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			"",
			"Old content",
		].join("\n");

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{
						number: 42,
						title: "[AICR] Code Review Report ...",
						body: consolidatedBody,
						state: "open",
					}]);
				}
				return response({ id: 42, number: 42 });
			},
		});

		const results = await dispatcher.reconcileProblems([problem], "New summary");

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "updated_consolidated", issueNumber: 42 });

		const patchCall = calls.find((c) => c.init?.method === "PATCH");
		expect(patchCall).toBeDefined();
		const body = JSON.parse(patchCall?.init?.body ?? "{}");
		expect(body.title).toBe("[AICR] [CRITICAL] src/auth.ts:12 · SQL query uses unsanitized input");
		expect(body.body).toContain("New summary");
		expect(body.body).toContain("SQL query uses unsanitized input");
	});

	it("consolidated mode closes issue when no problems found", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const consolidatedBody = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			"",
			"Old content",
		].join("\n");

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{
						number: 42,
						title: "[AICR] Code Review Report ...",
						body: consolidatedBody,
						state: "open",
					}]);
				}
				return response({ id: 1 });
			},
		});

		const results = await dispatcher.reconcileProblems([]);

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "closed", issueNumber: 42 });
	});

	it("consolidated mode returns empty results when no problems and no existing issue", async () => {
		const calls: string[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			fetch: async (url) => {
				calls.push(url);
				return response([]);
			},
		});

		const results = await dispatcher.reconcileProblems([]);

		expect(results).toEqual([]);
		expect(calls).toHaveLength(1);
	});
});

describe("markdownlint compliance of generated bodies", () => {
	function assertNoViolations(body: string, label: string): void {
		const violations: string[] = [];
		if (/\n{3,}/u.test(body)) {
			violations.push("MD012: multiple consecutive blank lines");
		}
		if (!body.endsWith("\n") && body.length > 0) {
			violations.push("MD047: missing trailing newline");
		}
		if (/^#{1,6}[^ \n]/mu.test(body)) {
			violations.push("MD018: heading without space after #");
		}
		if (/[ \t]+$/mu.test(body)) {
			violations.push("MD009: trailing spaces");
		}
		expect(violations, `${label} markdownlint violations`).toEqual([]);
	}

	it("renderProblemMarkdown produces markdownlint-compliant output", () => {
		const result = renderProblemMarkdown({
			file: "src/app.ts",
			line: 10,
			severity: "high",
			category: "correctness",
			message: "This is a bug.",
			suggestion: "Fix it.",
			codeSnippet: "if (x) { return; }",
			codeLanguage: "ts",
			fingerprint: "fp-1",
		});
		assertNoViolations(result, "renderProblemMarkdown/full");
	});

	it("renderProblemMarkdown produces markdownlint-compliant output without optionals", () => {
		const result = renderProblemMarkdown({
			file: "src/app.ts",
			line: 10,
			severity: "low",
			category: "style",
			message: "Minor issue.",
		});
		assertNoViolations(result, "renderProblemMarkdown/minimal");
	});
});
