import { describe, expect, it } from "vitest";

import {
	createGithubIssueDispatcher,
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
	severity: "high",
	category: "security",
	message: "SQL injection vulnerability.",
	suggestion: "Use parameterized queries.",
};

describe("createGithubIssueDispatcher", () => {
	it("posts aggregated problems as a comment on a GitHub issue", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubIssueDispatcher({
			token: "gh-token",
			owner: "my-org",
			repo: "my-repo",
			issueNumber: 42,
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ id: 100 });
			},
		});

		const result = await dispatcher.publishAggregatedProblems([problem], "Review summary");

		expect(result.status).toBe("published");
		expect(result.externalId).toBe("100");
		expect(result.channel).toBe("github_issue");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.github.com/repos/my-org/my-repo/issues/42/comments");
		expect(calls[0]?.init?.headers).toMatchObject({
			authorization: "Bearer gh-token",
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
		});

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		expect(body.body).toContain("Review summary");
		expect(body.body).toContain("SQL injection vulnerability.");
	});

	it("uses default channel name when not specified", async () => {
		const dispatcher = createGithubIssueDispatcher({
			owner: "org",
			repo: "repo",
			issueNumber: 1,
			fetch: async () => response({ id: 1 }),
		});

		const result = await dispatcher.publishAggregatedProblems([], "summary");
		expect(result.channel).toBe("github_issue");
	});

	it("uses custom channel name when specified", async () => {
		const dispatcher = createGithubIssueDispatcher({
			owner: "org",
			repo: "repo",
			issueNumber: 1,
			channelName: "custom-github-issue",
			fetch: async () => response({ id: 1 }),
		});

		const result = await dispatcher.publishAggregatedProblems([], "summary");
		expect(result.channel).toBe("custom-github-issue");
	});

	it("supports custom base URL for GitHub Enterprise", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubIssueDispatcher({
			baseUrl: "https://github.enterprise.com/api/v3",
			token: "ghe-token",
			owner: "my-org",
			repo: "my-repo",
			issueNumber: 5,
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ id: 200 });
			},
		});

		await dispatcher.publishAggregatedProblems([problem]);

		expect(calls[0]?.url).toBe(
			"https://github.enterprise.com/api/v3/repos/my-org/my-repo/issues/5/comments",
		);
		expect(calls[0]?.init?.headers).toMatchObject({
			authorization: "Bearer ghe-token",
		});
	});

	it("throws on API error", async () => {
		const dispatcher = createGithubIssueDispatcher({
			owner: "org",
			repo: "repo",
			issueNumber: 1,
			fetch: async () => response({ message: "Not Found" }, 404),
		});

		await expect(dispatcher.publishAggregatedProblems([problem])).rejects.toThrow(
			"GitHub issue API returned 404",
		);
	});

	it("adds auto-tag and reviewed-tag labels", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubIssueDispatcher({
			owner: "org",
			repo: "repo",
			issueNumber: 10,
			autoTag: "aicr",
			reviewedTag: "aicr:reviewed",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.endsWith("/labels") && init?.method === "GET" || url.includes("/labels") && !init?.method) {
					return response([
						{ id: 1, name: "aicr", color: "ededed" },
						{ id: 2, name: "aicr:reviewed", color: "ededed" },
					]);
				}
				if (url.endsWith("/labels") && init?.method === "POST") {
					return response({ id: 3, name: "aicr", color: "ededed" });
				}
				if (url.endsWith("/comments")) {
					return response({ id: 100 });
				}
				return response({ id: 100 });
			},
		});

		await dispatcher.publishAggregatedProblems([problem], "summary");

		const labelCall = calls.find((c) => c.url.endsWith("/issues/10/labels") && c.init?.method === "POST");
		expect(labelCall).toBeDefined();
		const body = JSON.parse(labelCall?.init?.body ?? "{}");
		expect(body.labels).toEqual(expect.arrayContaining(["aicr", "aicr:reviewed"]));
	});

	it("fetches repository labels only once when adding multiple labels", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGithubIssueDispatcher({
			owner: "org",
			repo: "repo",
			issueNumber: 10,
			autoTag: "aicr",
			reviewedTag: "aicr:reviewed",
			fetch: async (url, init) => {
				calls.push({ url, init });
				if (url.endsWith("/comments")) {
					return response({ id: 100 });
				}
				if (url.endsWith("/repos/org/repo/labels")) {
					return response([
						{ id: 1, name: "aicr", color: "ededed" },
						{ id: 2, name: "aicr:reviewed", color: "ededed" },
					]);
				}
				return response({ id: 200 });
			},
		});

		await dispatcher.publishAggregatedProblems([problem], "summary");

		const labelListCalls = calls.filter((c) => c.url.endsWith("/repos/org/repo/labels") && !c.init?.method);
		expect(labelListCalls).toHaveLength(1);
		const attachCall = calls.find((c) => c.url.endsWith("/issues/10/labels") && c.init?.method === "POST");
		expect(attachCall).toBeDefined();
		expect(JSON.parse(attachCall?.init?.body ?? "{}").labels).toEqual(["aicr", "aicr:reviewed"]);
	});
});
