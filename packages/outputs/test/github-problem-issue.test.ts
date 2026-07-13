import { describe, expect, it } from "vitest";

import {
	createGithubProblemIssueDispatcher,
	computeScopeFingerprint,
	renderProblemMarkdown,
	isFileCoveredByReview,
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
			"GET https://api.github.com/repos/my-org/my-repo/issues/42",
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
		const content = (body.card.body.elements as Array<{ content: string }>)[0]?.content ?? "";
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
		expect(body.body).toContain("#### CRITICAL (1)");
		expect(body.body).toContain("#### MEDIUM (1)");
	});

	it("deduplicates problems by fingerprint in consolidated mode", async () => {
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
			issueMode: "consolidated",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([]);
				}
				return response({ id: 500, number: 50 });
			},
		});

		const results = await dispatcher.reconcileProblems([problem, problem, problem2, { ...problem2, suggestion: "Use a hash set." }], "Summary");

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "created_consolidated" });

		const body = JSON.parse(
			calls.find((c) => c.url.endsWith("/repos/my-org/my-repo/issues") && c.init?.method === "POST")?.init?.body ?? "{}",
		);
		expect(body.title).toBe("[AICR] [CRITICAL] 2 problems · SQL query uses unsanitized input");
		expect(body.body).toContain("#### CRITICAL (1)");
		expect(body.body).toContain("#### MEDIUM (1)");
	});

	it("deduplicates problems by fingerprint in per_problem mode", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return calls.length === 1 ? response([]) : response({ id: 99, number: 7 });
			},
		});

		const results = await dispatcher.reconcileProblems([problem, problem, { ...problem, suggestion: "Different suggestion." }]);

		expect(results).toHaveLength(1);
		const createCalls = calls.filter((c) => c.url.endsWith("/repos/my-org/my-repo/issues") && c.init?.method === "POST");
		expect(createCalls).toHaveLength(1);
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

	it("consolidated mode renders code fences with correct content/language order", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const problemWithCode: ReviewProblem = {
			file: "src/etcd_module.cpp",
			line: 321,
			severity: "critical",
			category: "correctness",
			message: "Logic condition inverted.",
			codeSnippet: "if (keepalive_actor_list == nullptr) {\n  keepalive_count += keepalive_actor_list->size();\n}",
			codeLanguage: "cpp",
			fingerprint: "fp-inverted",
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
				return response({ id: 600, number: 60, html_url: "https://github.com/my-org/my-repo/issues/60" });
			},
		});

		const results = await dispatcher.reconcileProblems([problemWithCode]);

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "created_consolidated" });

		const body = JSON.parse(
			calls.find((c) => c.url.endsWith("/repos/my-org/my-repo/issues") && c.init?.method === "POST")?.init?.body ?? "{}",
		);
		expect(body.body).toContain("```cpp");
		expect(body.body).toContain("if (keepalive_actor_list == nullptr)");
		expect(body.body).not.toContain("```if");
		expect(body.body).not.toContain("keepalive_actor_listnullptr");
	});

	it("consolidated mode shows resolved section when new commit drops some problems", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const oldBody = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			"<!-- aicr:commit=aaa111 -->",
			"<!-- aicr:open_problems=fp-sql,fp-perf -->",
			"",
			"#### CRITICAL (1)",
			"",
			"**security** — `src/auth.ts:12` <!-- aicr:fp=fp-sql -->",
			"",
			"SQL query uses unsanitized input.",
			"",
			"#### MEDIUM (1)",
			"",
			"**performance** — `src/utils.ts:30` <!-- aicr:fp=fp-perf -->",
			"",
			"Inefficient loop detected.",
			"",
		].join("\n");

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			headSha: "bbb222",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{
						number: 42,
						title: "[AICR] Code Review Report ...",
						body: oldBody,
						state: "open",
					}]);
				}
				if (url.includes("/compare/")) {
					return response({ status: "ahead", ahead_by: 1, behind_by: 0 });
				}
				return response({ id: 42, number: 42 });
			},
		});

		const onlySql: ReviewProblem = {
			...problem,
		};

		const results = await dispatcher.reconcileProblems([onlySql], "Updated summary");

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "updated_consolidated", issueNumber: 42 });

		const patchCall = calls.find((c) => c.init?.method === "PATCH");
		expect(patchCall).toBeDefined();
		const body = JSON.parse(patchCall?.init?.body ?? "{}");
		expect(body.body).toContain("Resolved");
		expect(body.body).toContain("performance");
		expect(body.body).toContain("src/utils.ts:30");
		expect(body.body).toContain("<!-- aicr:commit=bbb222 -->");
		expect(body.body).toContain("SQL query uses unsanitized input");
	});

	it("consolidated mode skips resolution on same commit", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const oldBody = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			"<!-- aicr:commit=abc123 -->",
			"<!-- aicr:open_problems=fp-sql,fp-perf -->",
			"",
			"Old content",
		].join("\n");

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			headSha: "abc123",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{
						number: 42,
						title: "[AICR] ...",
						body: oldBody,
						state: "open",
					}]);
				}
				return response({ id: 42, number: 42 });
			},
		});

		const results = await dispatcher.reconcileProblems([problem], "Same commit");

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "updated_consolidated" });
		const patchCall = calls.find((c) => c.init?.method === "PATCH");
		const body = JSON.parse(patchCall?.init?.body ?? "{}");
		expect(body.body).not.toContain("Resolved");
		expect(body.body).toContain("Same commit");
	});

	it("consolidated mode skips update when current commit is behind stored commit", async () => {
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const oldBody = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			"<!-- aicr:commit=bbb222 -->",
			"<!-- aicr:open_problems=fp-sql -->",
			"",
			"Old content",
		].join("\n");

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			headSha: "aaa111",
			fetch: async (url, _init) => {
				if (url.includes("/issues?state=open")) {
					return response([{
						number: 42,
						title: "[AICR] ...",
						body: oldBody,
						state: "open",
					}]);
				}
				if (url.includes("/compare/")) {
					return response({ status: "behind", ahead_by: 0, behind_by: 1 });
				}
				throw new Error("Unexpected request");
			},
		});

		const results = await dispatcher.reconcileProblems([problem]);

		expect(results).toEqual([]);
	});

	it("consolidated mode updates without categorization when compare API fails", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const oldBody = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			"<!-- aicr:commit=aaa111 -->",
			"<!-- aicr:open_problems=fp-sql,fp-perf -->",
			"",
			"Old content",
		].join("\n");

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			headSha: "bbb222",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{
						number: 42,
						title: "[AICR] ...",
						body: oldBody,
						state: "open",
					}]);
				}
				if (url.includes("/compare/")) {
					return response({}, 500);
				}
				return response({ id: 42, number: 42 });
			},
		});

		const results = await dispatcher.reconcileProblems([problem]);

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "updated_consolidated" });
		const patchCall = calls.find((c) => c.init?.method === "PATCH");
		const body = JSON.parse(patchCall?.init?.body ?? "{}");
		expect(body.body).not.toContain("Resolved");
	});

	it("consolidated mode backward compatible with issue lacking commit marker", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const oldBody = [
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
			headSha: "newcommit",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{
						number: 42,
						title: "[AICR] ...",
						body: oldBody,
						state: "open",
					}]);
				}
				return response({ id: 42, number: 42 });
			},
		});

		const results = await dispatcher.reconcileProblems([problem]);

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "updated_consolidated" });
	});

	it("resolved section falls back to raw fingerprint when old body is not parseable", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const oldBody = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			"<!-- aicr:commit=aaa111 -->",
			"<!-- aicr:open_problems=fp-sql,fp-perf -->",
			"",
			"Old content in unparsable format",
		].join("\n");

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			headSha: "bbb222",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{
						number: 42,
						title: "[AICR] ...",
						body: oldBody,
						state: "open",
					}]);
				}
				if (url.includes("/compare/")) {
					return response({ status: "ahead", ahead_by: 1, behind_by: 0 });
				}
				return response({ id: 42, number: 42 });
			},
		});

		const results = await dispatcher.reconcileProblems([problem]);

		expect(results).toHaveLength(1);
		const patchCall = calls.find((c) => c.init?.method === "PATCH");
		const body = JSON.parse(patchCall?.init?.body ?? "{}");
		expect(body.body).toContain("Resolved");
		expect(body.body).toContain("fp-perf");
		expect(body.body).toContain("~~`fp-perf`~~");
	});

	it("categorizes problems when headSha is not provided but open_problems marker exists", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const oldBody = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			"<!-- aicr:commit=aaa111 -->",
			"<!-- aicr:open_problems=fp-sql,fp-perf -->",
			"",
			"#### CRITICAL (1)",
			"",
			"**security** — `src/auth.ts:12` <!-- aicr:fp=fp-sql -->",
			"",
			"SQL query uses unsanitized input.",
			"",
			"#### MEDIUM (1)",
			"",
			"**performance** — `src/utils.ts:30` <!-- aicr:fp=fp-perf -->",
			"",
			"Inefficient loop detected.",
			"",
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
						title: "[AICR] ...",
						body: oldBody,
						state: "open",
					}]);
				}
				return response({ id: 42, number: 42 });
			},
		});

		const results = await dispatcher.reconcileProblems([problem]);

		expect(results).toHaveLength(1);
		const patchCall = calls.find((c) => c.init?.method === "PATCH");
		const body = JSON.parse(patchCall?.init?.body ?? "{}");
		expect(body.body).toContain("Resolved");
		expect(body.body).toContain("performance");
	});

	it("marks all previous problems as resolved when new commit has entirely different problems", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
		const oldBody = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			"<!-- aicr:commit=aaa111 -->",
			"<!-- aicr:open_problems=fp-sql,fp-perf -->",
			"",
			"#### CRITICAL (1)",
			"",
			"**security** — `src/auth.ts:12` <!-- aicr:fp=fp-sql -->",
			"",
			"SQL query uses unsanitized input.",
			"",
			"#### MEDIUM (1)",
			"",
			"**performance** — `src/utils.ts:30` <!-- aicr:fp=fp-perf -->",
			"",
			"Inefficient loop detected.",
			"",
		].join("\n");

		const newProblem: ReviewProblem = {
			file: "src/new.ts",
			line: 1,
			severity: "high",
			category: "correctness",
			message: "Brand new issue.",
			fingerprint: "fp-new",
		};

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			headSha: "bbb222",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{
						number: 42,
						title: "[AICR] ...",
						body: oldBody,
						state: "open",
					}]);
				}
				if (url.includes("/compare/")) {
					return response({ status: "ahead", ahead_by: 1, behind_by: 0 });
				}
				return response({ id: 42, number: 42 });
			},
		});

		const results = await dispatcher.reconcileProblems([newProblem]);

		expect(results).toHaveLength(1);
		const patchCall = calls.find((c) => c.init?.method === "PATCH");
		const body = JSON.parse(patchCall?.init?.body ?? "{}");
		expect(body.body).toContain("security");
		expect(body.body).toContain("performance");
		expect(body.body).toContain("fp-new");
		expect(body.body).toContain("*(new in `bbb222`)*");
	});
});

describe("consolidated cross-scope cleanup", () => {
	const oldHeadSha = "a".repeat(40);
	const newHeadSha = "b".repeat(40);
	const oldScopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo", { targetKind: "push", headSha: oldHeadSha });

	function buildOldConsolidatedBody(opts: { readonly fp: string; readonly file: string; readonly line: number; readonly category: string; readonly severity: string }): string {
		return [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${oldScopeFp} -->`,
			`<!-- aicr:commit=${oldHeadSha} -->`,
			`<!-- aicr:open_problems=${opts.fp} -->`,
			"",
			`#### ${opts.severity.toUpperCase()} (1)`,
			"",
			`**${opts.category}** \u2014 \`${opts.file}:${opts.line}\` <!-- aicr:fp=${opts.fp} -->`,
			"",
			opts.message ?? "Old problem description.",
		].join("\n");
	}

	interface StoredProblemFixture {
		readonly fp: string;
		readonly file: string;
		readonly line: number;
		readonly endLine?: number;
		readonly category: string;
		readonly severity: string;
		readonly message?: string;
	}

	function buildStoredConsolidatedBody(
		entries: readonly StoredProblemFixture[],
	): string {
		const sections = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${oldScopeFp} -->`,
			`<!-- aicr:commit=${oldHeadSha} -->`,
			`<!-- aicr:open_problems=${entries.map((entry) => entry.fp).join(",")} -->`,
			"",
			"## Historical summary",
			"",
			"Prior analysis summary.",
			"",
			"---",
			"",
		];
		for (const entry of entries) {
			const location = entry.endLine
				? `${entry.file}:${entry.line}-${entry.endLine}`
				: `${entry.file}:${entry.line}`;
			sections.push(
				`#### ${entry.severity.toUpperCase()} (1)`,
				"",
				`**${entry.category}** \u2014 \`${location}\` <!-- aicr:fp=${entry.fp} -->`,
				"",
				entry.message ?? "Old problem description.",
				"",
			);
		}
		return sections.join("\n");
	}

	it("closes cross-scope consolidated issue when all its problems are gone and files were reviewed", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const oldBody = buildOldConsolidatedBody({ fp: "fp-old", file: "src/auth.ts", line: 12, category: "security", severity: "critical" });
		const newProblem: ReviewProblem = {
			file: "src/utils.ts", line: 30, severity: "medium", category: "performance",
			message: "New issue.", fingerprint: "fp-new",
		};
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org", repo: "my-repo", channelName: "github-issues",
			issueMode: "consolidated", headSha: newHeadSha, targetKind: "push", resolvedAction: "close",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) return response([{ number: 40, title: "[AICR] Old", body: oldBody, state: "open" }]);
				if (url.includes("/compare/")) return response({ status: "ahead" });
				return response({ id: 50, number: 50 });
			},
		});

		const results = await dispatcher.reconcileProblems([newProblem], "Summary", { reviewedFiles: ["src/auth.ts", "src/utils.ts"] });

		const closeCall = calls.find((c) => c.url.includes("/issues/40") && c.init?.method === "PATCH" && JSON.parse(c.init?.body ?? "{}").state === "closed");
		expect(closeCall).toBeDefined();
		expect(results.some((r) => r.raw && typeof r.raw === "object" && (r.raw as Record<string, unknown>).action === "closed")).toBe(true);
	});

	it("closes a cross-scope issue whose stored locations use line ranges", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const oldBody = buildStoredConsolidatedBody([
			{
				fp: "fp-mq-1",
				file: "src/mq_channel_manager.cpp",
				line: 309,
				endLine: 313,
				category: "correctness",
				severity: "high",
			},
			{
				fp: "fp-mq-2",
				file: "src/mq_channel_manager.cpp",
				line: 712,
				endLine: 715,
				category: "correctness",
				severity: "high",
			},
			{
				fp: "fp-mq-3",
				file: "src/mq_channel_manager.cpp",
				line: 522,
				endLine: 528,
				category: "maintainability",
				severity: "medium",
			},
		]);
		const currentProblem: ReviewProblem = {
			file: "src/current.cpp",
			line: 10,
			severity: "low",
			category: "style",
			message: "Current issue.",
			fingerprint: "fp-current",
		};
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			headSha: newHeadSha,
			targetKind: "push",
			resolvedAction: "close",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open"))
					return response([
						{ number: 46, title: "[AICR] Old", body: oldBody, state: "open" },
					]);
				if (url.includes("/compare/")) return response({ status: "ahead" });
				return response({ id: 50, number: 50 });
			},
		});

		await dispatcher.reconcileProblems([currentProblem], "Current summary", {
			reviewedFiles: ["src/mq_channel_manager.cpp", "src/current.cpp"],
		});

		const closeCall = calls.find(
			(call) =>
				call.url.includes("/issues/46") &&
				call.init?.method === "PATCH" &&
				JSON.parse(call.init.body ?? "{}").state === "closed",
		);
		expect(closeCall).toBeDefined();
	});

	it("partially resolves reviewed findings in an older scope and retains the others", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const oldBody = buildStoredConsolidatedBody([
			{
				fp: "fp-orbit-stringify",
				file: "src/OrbitRPCHandle.h",
				line: 153,
				category: "correctness",
				severity: "high",
			},
			{
				fp: "fp-orbit-concat",
				file: "src/OrbitRPCHandle.h",
				line: 154,
				category: "correctness",
				severity: "high",
			},
			{
				fp: "fp-cmake",
				file: "src/component-functions.cmake",
				line: 327,
				category: "build",
				severity: "medium",
			},
		]);
		const currentProblem: ReviewProblem = {
			file: "src/current.cpp",
			line: 10,
			severity: "low",
			category: "style",
			message: "Current issue.",
			fingerprint: "fp-current",
		};
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			headSha: newHeadSha,
			targetKind: "push",
			resolvedAction: "close",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open"))
					return response([
						{ number: 42, title: "[AICR] [HIGH] 3 problems · Orbit macro expansion", body: oldBody, state: "open" },
					]);
				if (url.includes("/compare/")) return response({ status: "ahead" });
				return response({ id: 47, number: 47 });
			},
		});

		await dispatcher.reconcileProblems([currentProblem], "Current summary", {
			reviewedFiles: ["src/component-functions.cmake", "src/current.cpp"],
		});

		const oldPatchCall = calls.find(
			(call) =>
				call.url.includes("/issues/42") && call.init?.method === "PATCH",
		);
		const oldPatch = JSON.parse(oldPatchCall?.init?.body ?? "{}");
		expect(oldPatch.state).toBeUndefined();
		expect(oldPatch.title).toBe("[AICR] [HIGH] 2 problems · Orbit macro expansion");
		expect(oldPatch.body).toContain(
			"<!-- aicr:open_problems=fp-orbit-stringify,fp-orbit-concat -->",
		);
		expect(oldPatch.body).toContain("✅ Resolved (1)");
		expect(oldPatch.body).toContain("src/component-functions.cmake:327");
		expect(oldPatch.body).toContain("## Historical summary");
		expect(oldPatch.body).not.toContain("aicr:open_problems=fp-current");
		expect(
			calls.some(
				(call) => call.url.endsWith("/issues") && call.init?.method === "POST",
			),
		).toBe(true);
	});

	it("partially resolves an older scope during an empty review", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const oldBody = buildStoredConsolidatedBody([
			{
				fp: "fp-unreviewed",
				file: "src/unreviewed.ts",
				line: 20,
				category: "security",
				severity: "high",
			},
			{
				fp: "fp-reviewed",
				file: "src/reviewed.ts",
				line: 30,
				category: "bug",
				severity: "medium",
			},
		]);
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			headSha: newHeadSha,
			targetKind: "push",
			resolvedAction: "close",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open"))
					return response([
						{ number: 42, title: "[AICR] Old", body: oldBody, state: "open" },
					]);
				if (url.includes("/compare/")) return response({ status: "ahead" });
				return response({ id: 42, number: 42 });
			},
		});

		await dispatcher.reconcileProblems([], undefined, {
			reviewedFiles: ["src/reviewed.ts"],
		});

		const oldPatch = JSON.parse(
			calls.find(
				(call) =>
					call.url.includes("/issues/42") && call.init?.method === "PATCH",
			)?.init?.body ?? "{}",
		);
		expect(oldPatch.state).toBeUndefined();
		expect(oldPatch.body).toContain(
			"<!-- aicr:open_problems=fp-unreviewed -->",
		);
		expect(oldPatch.body).toContain("✅ Resolved (1)");
	});

	it("keeps different per-commit scopes independent", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const oldBody = buildStoredConsolidatedBody([
			{
				fp: "fp-old",
				file: "src/old.ts",
				line: 12,
				category: "bug",
				severity: "high",
			},
		]);
		const currentProblem: ReviewProblem = {
			file: "src/current.ts",
			line: 5,
			severity: "low",
			category: "style",
			message: "Current issue.",
			fingerprint: "fp-current",
		};
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "per_commit",
			headSha: newHeadSha,
			resolvedAction: "close",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open"))
					return response([
						{ number: 40, title: "[AICR] Old", body: oldBody, state: "open" },
					]);
				if (url.includes("/compare/")) return response({ status: "ahead" });
				return response({ id: 50, number: 50 });
			},
		});

		await dispatcher.reconcileProblems([currentProblem], "Current summary", {
			reviewedFiles: ["src/old.ts", "src/current.ts"],
		});

		expect(
			calls.some(
				(call) =>
					call.url.includes("/issues/40") && call.init?.method === "PATCH",
			),
		).toBe(false);
	});

	it("does NOT close cross-scope issue when its files were NOT in the reviewed scope", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const oldBody = buildOldConsolidatedBody({ fp: "fp-old", file: "src/auth.ts", line: 12, category: "security", severity: "critical" });
		const newProblem: ReviewProblem = {
			file: "src/utils.ts", line: 30, severity: "medium", category: "performance",
			message: "New issue.", fingerprint: "fp-new",
		};
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org", repo: "my-repo", channelName: "github-issues",
			issueMode: "consolidated", headSha: newHeadSha, targetKind: "push", resolvedAction: "close",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) return response([{ number: 40, title: "[AICR] Old", body: oldBody, state: "open" }]);
				if (url.includes("/compare/")) return response({ status: "ahead" });
				return response({ id: 50, number: 50 });
			},
		});

		await dispatcher.reconcileProblems([newProblem], "Summary", { reviewedFiles: ["src/utils.ts"] });

		const closeCall = calls.find((c) => c.url.includes("/issues/40") && c.init?.method === "PATCH" && JSON.parse(c.init?.body ?? "{}").state === "closed");
		expect(closeCall).toBeUndefined();
	});

	it("does NOT close cross-scope issue when its problems are still present in the current review", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const oldBody = buildOldConsolidatedBody({ fp: "fp-still-active", file: "src/auth.ts", line: 12, category: "security", severity: "critical" });
		const sameProblem: ReviewProblem = {
			file: "src/auth.ts", line: 12, severity: "critical", category: "security",
			message: "Still here.", fingerprint: "fp-still-active",
		};
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org", repo: "my-repo", channelName: "github-issues",
			issueMode: "consolidated", headSha: newHeadSha, targetKind: "push", resolvedAction: "close",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) return response([{ number: 40, title: "[AICR] Old", body: oldBody, state: "open" }]);
				if (url.includes("/compare/")) return response({ status: "ahead" });
				return response({ id: 50, number: 50 });
			},
		});

		await dispatcher.reconcileProblems([sameProblem], "Summary", { reviewedFiles: ["src/auth.ts"] });

		const closeCall = calls.find((c) => c.url.includes("/issues/40") && c.init?.method === "PATCH" && JSON.parse(c.init?.body ?? "{}").state === "closed");
		expect(closeCall).toBeUndefined();
	});

	it("closes same-scope duplicate consolidated issues", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo", { targetKind: "push", headSha: newHeadSha });
		const body1 = [
			"<!-- aicr:managed=problem-issue -->", "<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->", "<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`, `<!-- aicr:commit=${newHeadSha} -->`,
			"<!-- aicr:open_problems=fp-a -->", "",
			"#### HIGH (1)", "", "**bug** \u2014 `src/a.ts:1` <!-- aicr:fp=fp-a -->", "", "Bug.",
		].join("\n");
		const body2 = body1.replace("src/a.ts:1", "src/a.ts:2");
		const problem: ReviewProblem = {
			file: "src/a.ts", line: 1, severity: "high", category: "bug",
			message: "Bug.", fingerprint: "fp-a",
		};
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org", repo: "my-repo", channelName: "github-issues",
			issueMode: "consolidated", headSha: newHeadSha, targetKind: "push", resolvedAction: "close",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([
						{ number: 40, title: "[AICR] Dup 1", body: body1, state: "open" },
						{ number: 41, title: "[AICR] Dup 2", body: body2, state: "open" },
					]);
				}
				return response({ id: 40, number: 40 });
			},
		});

		await dispatcher.reconcileProblems([problem], "Summary");

		const closeCalls = calls.filter((c) =>
			c.url.includes("/issues/41") && c.init?.method === "PATCH" && JSON.parse(c.init?.body ?? "{}").state === "closed",
		);
		expect(closeCalls).toHaveLength(1);
	});
});

describe("consolidated target-aware scope fingerprint", () => {
	const scopeArgs = ["github-issues", "my-org", "my-repo"] as const;

	it("scopes push per batch and PR per pull number", () => {
		const pushA = computeScopeFingerprint(...scopeArgs, { targetKind: "push", headSha: "aaa111" });
		const pushB = computeScopeFingerprint(...scopeArgs, { targetKind: "push", headSha: "bbb222" });
		const prSha1 = computeScopeFingerprint(...scopeArgs, { targetKind: "pull_request", headSha: "aaa111" });
		const prSha2 = computeScopeFingerprint(...scopeArgs, { targetKind: "pull_request", headSha: "bbb222" });
		const prNum7 = computeScopeFingerprint(...scopeArgs, { targetKind: "pull_request", pullNumber: 7 });
		const prNum8 = computeScopeFingerprint(...scopeArgs, { targetKind: "pull_request", pullNumber: 8 });
		const repoWide = computeScopeFingerprint(...scopeArgs);

		expect(pushA).not.toBe(pushB);
		expect(prSha1).not.toBe(prSha2);
		expect(prNum7).not.toBe(prNum8);
		// PR identity is stable across commits when the pull number is known.
		expect(prNum7).toBe(computeScopeFingerprint(...scopeArgs, { targetKind: "pull_request", pullNumber: 7, headSha: "ccc333" }));
		// Non-push/non-PR targets (manual/scheduled) keep the repo-wide scope.
		expect(repoWide).toBe(computeScopeFingerprint(...scopeArgs, { targetKind: "manual" }));
		// headSha without a target kind falls back to the per_commit scope (differs from repo-wide).
		expect(computeScopeFingerprint(...scopeArgs, { headSha: "aaa111" })).not.toBe(repoWide);
	});

	it("keeps separate push batches in separate issues", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const batch1Fp = computeScopeFingerprint("github-issues", "my-org", "my-repo", { targetKind: "push", headSha: "aaa111" });
		const batch1Body = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${batch1Fp} -->`,
			`<!-- aicr:commit=aaa111 -->`,
			`<!-- aicr:open_problems=fp-sql -->`,
			"",
			"Batch 1 content",
		].join("\n");

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			targetKind: "push",
			headSha: "bbb222",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{ number: 42, title: "[AICR] batch1", body: batch1Body, state: "open" }]);
				}
				return response({ id: 43, number: 43, html_url: "https://github.com/my-org/my-repo/issues/43" });
			},
		});

		const results = await dispatcher.reconcileProblems([problem], "Batch 2 summary");

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "created_consolidated" });
		expect(calls.filter((c) => c.init?.method === "PATCH")).toEqual([]);
		const postCalls = calls.filter((c) => c.init?.method === "POST" && c.url.endsWith("/issues"));
		expect(postCalls).toHaveLength(1);
		const batch2Fp = computeScopeFingerprint("github-issues", "my-org", "my-repo", { targetKind: "push", headSha: "bbb222" });
		const createdBody = JSON.parse(postCalls[0]?.init?.body ?? "{}");
		expect(createdBody.body).toContain(`<!-- aicr:scope_fingerprint=${batch2Fp} -->`);
	});

	it("keeps one PR issue stable across commits", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const prFp = computeScopeFingerprint("github-issues", "my-org", "my-repo", { targetKind: "pull_request", pullNumber: 7 });
		const commit1Body = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${prFp} -->`,
			`<!-- aicr:open_problems=fp-sql -->`,
			"",
			"Commit 1 content",
		].join("\n");

		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			targetKind: "pull_request",
			pullNumber: 7,
			headSha: "bbb222",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([{ number: 42, title: "[AICR] pr7", body: commit1Body, state: "open" }]);
				}
				return response({ id: 42, number: 42 });
			},
		});

		const results = await dispatcher.reconcileProblems([problem], "Commit 2 summary");

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "updated_consolidated", issueNumber: 42 });
		expect(calls.filter((c) => c.init?.method === "POST")).toEqual([]);
		const patchCall = calls.find((c) => c.init?.method === "PATCH");
		expect(patchCall).toBeDefined();
	});
});

describe("isFileCoveredByReview", () => {
	it("returns true when reviewedFiles is undefined (backward compat)", () => {
		expect(isFileCoveredByReview("src/app.ts", undefined)).toBe(true);
	});

	it("returns true when reviewedFiles is empty (backward compat)", () => {
		expect(isFileCoveredByReview("src/app.ts", [])).toBe(true);
	});

	it("returns false when filePath is undefined and reviewedFiles is provided", () => {
		expect(isFileCoveredByReview(undefined, ["src/app.ts"])).toBe(false);
	});

	it("returns true when file is in reviewedFiles", () => {
		expect(isFileCoveredByReview("src/app.ts", ["src/app.ts", "other.ts"])).toBe(true);
	});

	it("returns false when file is not in reviewedFiles", () => {
		expect(isFileCoveredByReview("src/missing.ts", ["src/app.ts"])).toBe(false);
	});

	it("normalizes backslashes and double slashes before comparing", () => {
		expect(isFileCoveredByReview("src\\app.ts", ["src/app.ts"])).toBe(true);
		expect(isFileCoveredByReview("./src//app.ts", ["src/app.ts"])).toBe(true);
	});

	it("strips leading and trailing slashes before comparing", () => {
		expect(isFileCoveredByReview("/src/app.ts/", ["src/app.ts"])).toBe(true);
	});
});

describe("per_problem lifecycle file-scope guard", () => {
	const managedBodyWithFile = (file: string): string => [
		"<!-- aicr:managed=problem-issue -->",
		"<!-- aicr:channel=github-issues -->",
		"<!-- aicr:label=aicr-managed -->",
		"<!-- aicr:fingerprint=fp-old -->",
		`<!-- aicr:file=${file} -->`,
		"",
		"**HIGH · correctness**",
		"",
		"Some old problem.",
		"",
		`Location: \`${file}:42\``,
	].join("\n");

	it("embeds the file marker in newly-created issue bodies", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return calls.length === 1 ? response([]) : response({ id: 1, number: 1 });
			},
		});

		await dispatcher.reconcileProblems([{ ...problem, fingerprint: "fp-new-file" }]);

		const createCall = calls.find((c) => c.init?.method === "POST");
		const body = JSON.parse(createCall?.init?.body ?? "{}");
		expect(body.body).toContain("<!-- aicr:file=src/auth.ts -->");
	});

	it("does NOT close a managed issue when its file is outside the reviewed scope", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response([
					{
						number: 42,
						title: "[AICR] [HIGH] correctness: src/legacy.ts:42",
						body: managedBodyWithFile("src/legacy.ts"),
						state: "open",
					},
				]);
			},
		});

		const results = await dispatcher.reconcileProblems([], undefined, { reviewedFiles: ["src/app.ts", "src/util.ts"] });

		expect(results).toEqual([]);
		expect(calls.filter((c) => c.init?.method === "PATCH")).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("DOES close a managed issue when its file IS in the reviewed scope", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (calls.length === 1) {
					return response([
						{
							number: 42,
							title: "[AICR] [HIGH] correctness: src/app.ts:42",
							body: managedBodyWithFile("src/app.ts"),
							state: "open",
						},
					]);
				}
				return response({ id: calls.length });
			},
		});

		const results = await dispatcher.reconcileProblems([], undefined, { reviewedFiles: ["src/app.ts", "src/util.ts"] });

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ action: "closed", issueNumber: 42 });
	});

	it("closes issues when reviewedFiles is not provided (backward compat)", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (calls.length === 1) {
					return response([
						{
							number: 42,
							title: "[AICR] [HIGH] correctness: src/legacy.ts:42",
							body: managedBodyWithFile("src/legacy.ts"),
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
	});

	it("does NOT close when file cannot be determined and reviewedFiles is provided", async () => {
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			issueMode: "per_problem",
			fetch: async () => {
				return response([
					{
						number: 42,
						title: "[AICR] [HIGH] stale",
						body: managedBody,
						state: "open",
					},
				]);
			},
		});

		const results = await dispatcher.reconcileProblems([], undefined, { reviewedFiles: ["src/app.ts"] });

		expect(results).toEqual([]);
	});
});

describe("consolidated lifecycle file-scope guard", () => {
	const scopeFp = computeScopeFingerprint("github-issues", "my-org", "my-repo");
	const consolidatedBodyWithOpenProblems = (files: readonly { readonly fp: string; readonly file: string; readonly line: number; readonly category: string }[]): string => {
		const fps = files.map((f) => f.fp).join(",");
		const sections: string[] = [
			"<!-- aicr:managed=problem-issue -->",
			"<!-- aicr:consolidated=true -->",
			"<!-- aicr:channel=github-issues -->",
			"<!-- aicr:label=aicr-managed -->",
			`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
			`<!-- aicr:open_problems=${fps} -->`,
			"",
			"### Open Issues",
			"",
			"#### HIGH (1)",
			"",
		];
		for (const f of files) {
			sections.push(`**${f.category}** \u2014 \`${f.file}:${f.line}\` <!-- aicr:fp=${f.fp} -->`);
			sections.push("");
		}
		return sections.join("\n");
	};

	it("does NOT close a consolidated issue on empty review when its files are outside scope", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([
						{
							number: 99,
							title: "[AICR] Consolidated",
							body: consolidatedBodyWithOpenProblems([
								{ fp: "fp-legacy", file: "src/legacy.ts", line: 10, category: "correctness" },
							]),
							state: "open",
						},
					]);
				}
				return response({ id: calls.length });
			},
		});

		const results = await dispatcher.reconcileProblems([], undefined, { reviewedFiles: ["src/app.ts"] });

		expect(results).toEqual([]);
		expect(calls.filter((c) => c.init?.method === "PATCH")).toEqual([]);
	});

	it("DOES close a consolidated issue on empty review when its files ARE in scope", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([
						{
							number: 99,
							title: "[AICR] Consolidated",
							body: consolidatedBodyWithOpenProblems([
								{ fp: "fp-current", file: "src/app.ts", line: 10, category: "correctness" },
							]),
							state: "open",
						},
					]);
				}
				return response({ id: calls.length });
			},
		});

		const results = await dispatcher.reconcileProblems([], undefined, { reviewedFiles: ["src/app.ts"] });

		expect(results).toHaveLength(1);
		expect(results[0]?.raw).toMatchObject({ issueNumber: 99 });
	});

	it("does NOT mark a dropped problem as resolved when its file is outside scope", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([
						{
							number: 99,
							title: "[AICR] Consolidated",
							body: consolidatedBodyWithOpenProblems([
								{ fp: "fp-legacy", file: "src/legacy.ts", line: 10, category: "correctness" },
								{ fp: "fp-keep", file: "src/app.ts", line: 5, category: "security" },
							]),
							state: "open",
						},
					]);
				}
				return response({ id: calls.length });
			},
		});

		const keepProblem: ReviewProblem = {
			file: "src/app.ts",
			line: 5,
			severity: "high",
			category: "security",
			message: "Still here.",
			fingerprint: "fp-keep",
		};

		await dispatcher.reconcileProblems([keepProblem], undefined, { reviewedFiles: ["src/app.ts"] });

		const patchCall = calls.find((c) => c.init?.method === "PATCH");
		expect(patchCall).toBeDefined();
		const body = JSON.parse(patchCall?.init?.body ?? "{}");
		expect(body.body).not.toContain("Resolved");
		expect(body.body).toContain("<!-- aicr:open_problems=fp-keep,fp-legacy -->");
		expect(body.body).toContain("<!-- aicr:fp=fp-legacy -->");
		expect(body.body).toContain("current review did not re-analyze this file");
	});

	it("skips rewriting a consolidated issue when a retained fingerprint cannot be parsed", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([
						{
							number: 99,
							title: "[AICR] Consolidated",
							body: [
								"<!-- aicr:managed=problem-issue -->",
								"<!-- aicr:consolidated=true -->",
								"<!-- aicr:channel=github-issues -->",
								"<!-- aicr:label=aicr-managed -->",
								`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
								"<!-- aicr:open_problems=fp-legacy,fp-keep -->",
								"",
								"#### HIGH (1)",
								"",
								"**security** — `src/app.ts:5` <!-- aicr:fp=fp-keep -->",
							].join("\n"),
							state: "open",
						},
					]);
				}
				return response({ id: calls.length });
			},
		});

		const keepProblem: ReviewProblem = {
			file: "src/app.ts",
			line: 5,
			severity: "high",
			category: "security",
			message: "Still here.",
			fingerprint: "fp-keep",
		};

		const results = await dispatcher.reconcileProblems([keepProblem], undefined, { reviewedFiles: ["src/app.ts"] });

		expect(results).toEqual([]);
		expect(calls.filter((c) => c.init?.method === "PATCH")).toEqual([]);
	});

	it("does NOT close a consolidated issue when previous files cannot be determined", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubProblemIssueDispatcher({
			owner: "my-org",
			repo: "my-repo",
			channelName: "github-issues",
			issueMode: "consolidated",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.includes("/issues?state=open")) {
					return response([
						{
							number: 99,
							title: "[AICR] Consolidated",
							body: [
								"<!-- aicr:managed=problem-issue -->",
								"<!-- aicr:consolidated=true -->",
								"<!-- aicr:channel=github-issues -->",
								"<!-- aicr:label=aicr-managed -->",
								`<!-- aicr:scope_fingerprint=${scopeFp} -->`,
							].join("\n"),
							state: "open",
						},
					]);
				}
				return response({ id: calls.length });
			},
		});

		const results = await dispatcher.reconcileProblems([], undefined, { reviewedFiles: ["src/app.ts"] });

		expect(results).toEqual([]);
		expect(calls.filter((c) => c.init?.method === "PATCH")).toEqual([]);
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
