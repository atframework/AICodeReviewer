import { describe, expect, it } from "vitest";

import {
	createGithubProblemIssueDispatcher,
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
		expect(body.title).toContain("[AICR Test] [CRITICAL] security: src/auth.ts:12");
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
});
