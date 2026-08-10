import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFeishuBotDispatcher,
	createGithubIssueDispatcher,
	OutputDispatchError,
	type FetchLike,
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

function makeFeishuDispatcher() {
	return createFeishuBotDispatcher({
		webhookUrl: "https://im.example/webhook/bot",
		channelName: "feishu-test",
	});
}

function makeGithubIssueDispatcher() {
	return createGithubIssueDispatcher({
		token: "gh-token",
		owner: "my-org",
		repo: "my-repo",
		issueNumber: 42,
		autoTag: "aicr-managed",
	});
}

describe("defaultFetch transient IO retry", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("does not retry POST connection failures", async () => {
		const fetchMock = vi.fn<FetchLike>().mockRejectedValue(new TypeError("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		const dispatcher = makeFeishuDispatcher();
		await expect(dispatcher.publishAggregatedProblems([], "summary")).rejects.toBeInstanceOf(TypeError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not retry POST transient statuses and surfaces the canonical dispatch error", async () => {
		const fetchMock = vi.fn<FetchLike>().mockResolvedValue(response({ error: "busy" }, 503));
		vi.stubGlobal("fetch", fetchMock);

		const dispatcher = makeFeishuDispatcher();
		await expect(dispatcher.publishAggregatedProblems([], "summary")).rejects.toBeInstanceOf(OutputDispatchError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries GET connection failures", async () => {
		const calls: { url: string; method: string }[] = [];
		let labelListAttempts = 0;
		const fetchMock: FetchLike = async (url, init) => {
			const method = init?.method ?? "GET";
			calls.push({ url, method });
			if (method === "GET" && url.endsWith("/labels")) {
				labelListAttempts += 1;
				if (labelListAttempts === 1) {
					throw new TypeError("fetch failed");
				}
				return response([{ name: "aicr-managed" }]);
			}
			if (url.endsWith("/comments")) {
				return response({ id: 100 });
			}
			return response({});
		};
		vi.stubGlobal("fetch", fetchMock);

		const dispatcher = makeGithubIssueDispatcher();
		const result = await dispatcher.publishAggregatedProblems([], "summary");
		expect(result.status).toBe("published");
		expect(labelListAttempts).toBe(2);
	});

	it("retries GET transient statuses up to the attempt bound, then degrades without leaking the retry error", async () => {
		let labelListAttempts = 0;
		const fetchMock: FetchLike = async (url, init) => {
			const method = init?.method ?? "GET";
			if (method === "GET" && url.endsWith("/labels")) {
				labelListAttempts += 1;
				return response({ error: "busy" }, 503);
			}
			if (method === "POST" && url.endsWith("/labels")) {
				return response({ name: "aicr-managed" }, 201);
			}
			if (url.endsWith("/comments")) {
				return response({ id: 100 });
			}
			return response({});
		};
		vi.stubGlobal("fetch", fetchMock);

		const dispatcher = makeGithubIssueDispatcher();
		const result = await dispatcher.publishAggregatedProblems([], "summary");
		expect(result.status).toBe("published");
		expect(labelListAttempts).toBe(3);
	});

	it("does not retry GET permanent statuses", async () => {
		let labelListAttempts = 0;
		const fetchMock: FetchLike = async (url, init) => {
			const method = init?.method ?? "GET";
			if (method === "GET" && url.endsWith("/labels")) {
				labelListAttempts += 1;
				return response({ error: "not found" }, 404);
			}
			if (method === "POST" && url.endsWith("/labels")) {
				return response({ name: "aicr-managed" }, 201);
			}
			if (url.endsWith("/comments")) {
				return response({ id: 100 });
			}
			return response({});
		};
		vi.stubGlobal("fetch", fetchMock);

		const dispatcher = makeGithubIssueDispatcher();
		const result = await dispatcher.publishAggregatedProblems([], "summary");
		expect(result.status).toBe("published");
		expect(labelListAttempts).toBe(1);
	});
});
