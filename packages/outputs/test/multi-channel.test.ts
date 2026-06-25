import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
	computeProblemFingerprint,
	createGiteaIssueDispatcher,
	createFeishuBotDispatcher,
	createWeComBotDispatcher,
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

const problems: readonly ReviewProblem[] = [
	{
		file: "src/app.ts",
		line: 42,
		severity: "high",
		category: "correctness",
		message: "Bug found.",
		suggestion: "Fix it.",
		fingerprint: "fp-1",
	},
	{
		file: "src/util.ts",
		line: 10,
		severity: "low",
		category: "style",
		message: "Naming issue.",
	},
];

describe("createGiteaIssueDispatcher", () => {
	it("publishes aggregated problems as an issue comment", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGiteaIssueDispatcher({
			baseUrl: "https://gitea.example",
			token: "test-token",
			owner: "owent",
			repo: "example",
			indexNumber: 7,
			channelName: "gitea-issue-internal",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ id: 456 });
			},
		});

		const result = await dispatcher.publishAggregatedProblems(problems, "Summary text");

		expect(result.channel).toBe("gitea-issue-internal");
		expect(result.status).toBe("published");
		expect(result.externalId).toBe("456");

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		expect(body.body).toContain("Summary text");
		expect(body.body).toContain("HIGH");
		expect(body.body).toContain("Bug found.");
		expect(body.body).toContain("LOW");
		expect(body.body).toContain("Naming issue.");
		expect(calls[0]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/issues/7/comments");
	});

	it("throws OutputDispatchError on failure", async () => {
		const dispatcher = createGiteaIssueDispatcher({
			baseUrl: "https://gitea.example",
			owner: "owent",
			repo: "example",
			indexNumber: 1,
			fetch: async () => response({ message: "forbidden" }, 403),
		});

		await expect(dispatcher.publishAggregatedProblems(problems)).rejects.toThrow("Gitea issue API returned 403");
	});

	it("publishes without summary when not provided", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createGiteaIssueDispatcher({
			baseUrl: "https://gitea.example",
			owner: "owent",
			repo: "example",
			indexNumber: 1,
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ id: 1 });
			},
		});

		await dispatcher.publishAggregatedProblems(problems);

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		expect(body.body).toContain("Problems (2)");
		expect(body.body).not.toContain("undefined");
	});
});

describe("createFeishuBotDispatcher", () => {
	it("publishes aggregated problems to Feishu webhook", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createFeishuBotDispatcher({
			webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
			channelName: "feishu-team",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ code: 0 });
			},
		});

		const result = await dispatcher.publishAggregatedProblems(
			problems,
			"Review summary",
			"<at user_id=\"all\"></at>",
		);

		expect(result.channel).toBe("feishu-team");
		expect(result.status).toBe("published");

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		expect(body.msg_type).toBe("interactive");
		const card = body.card as Record<string, unknown>;
		expect(card.schema).toBe("2.0");
		const cardBody = card.body as Record<string, unknown>;
		const elements = cardBody.elements as Record<string, unknown>[];
		expect(elements.length).toBe(2);
		const content = (elements[0] as Record<string, unknown>).content as string;
		expect(content).toContain("Review summary");
		expect(content).toContain("## Problems (2)");
		expect(content).toContain("Location: `src/app.ts:42`");
		expect(content).toContain("Bug found.");
		expect(content).toContain("Naming issue.");
		expect(content).toContain("Suggestion: Fix it.");
	});

	it("throws on non-2xx response", async () => {
		const dispatcher = createFeishuBotDispatcher({
			webhookUrl: "https://open.feishu.cn/hook/test",
			fetch: async () => response({ code: 19001 }, 400),
		});

		await expect(dispatcher.publishAggregatedProblems(problems)).rejects.toThrow("Feishu webhook returned 400");
	});

	it("includes sign when secret is provided", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createFeishuBotDispatcher({
			webhookUrl: "https://open.feishu.cn/hook/test",
			secret: "test-secret",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ code: 0 });
			},
		});

		await dispatcher.publishAggregatedProblems(problems);

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		expect(body.sign).toBeDefined();
		expect(body.timestamp).toBeDefined();
	});

	it("computes Feishu HMAC-SHA256 signature correctly", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const secret = "test-secret";
		const dispatcher = createFeishuBotDispatcher({
			webhookUrl: "https://open.feishu.cn/hook/test",
			secret,
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ code: 0 });
			},
		});

		await dispatcher.publishAggregatedProblems(problems);

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		const timestamp = Number(body.timestamp);
		expect(Number.isFinite(timestamp)).toBe(true);
		const stringToSign = `${timestamp}\n${secret}`;
		const expectedSign = createHmac("sha256", stringToSign).digest("base64");
		expect(body.sign).toBe(expectedSign);
	});
});

describe("createWeComBotDispatcher", () => {
	it("publishes aggregated problems to WeCom webhook", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createWeComBotDispatcher({
			webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test",
			channelName: "wecom-ops",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ errcode: 0 });
			},
		});

		const result = await dispatcher.publishAggregatedProblems(problems, "Review done");

		expect(result.channel).toBe("wecom-ops");
		expect(result.status).toBe("published");

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		expect(body.msgtype).toBe("markdown");
		const md = body.markdown as Record<string, unknown>;
		expect(md.content).toContain("Review done");
		expect(md.content).toContain("## Problems (2)");
		expect(md.content).toContain("[HIGH]");
		expect(md.content).toContain("Location: `src/app.ts:42`");
		expect(md.content).toContain("Bug found.");
		expect(md.content).toContain("Naming issue.");
		expect(md.content).toContain("Suggestion: Fix it.");
	});

	it("includes mentioned_mobile_list when provided", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createWeComBotDispatcher({
			webhookUrl: "https://qyapi.weixin.qq.com/hook/test",
			mentionedMobileList: ["13800138000", "13900139000"],
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ errcode: 0 });
			},
		});

		await dispatcher.publishAggregatedProblems(problems);

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		const md = body.markdown as Record<string, unknown>;
		expect(md.mentioned_mobile_list).toEqual(["13800138000", "13900139000"]);
	});

	it("appends WeCom mention text to the markdown content", async () => {
		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createWeComBotDispatcher({
			webhookUrl: "https://qyapi.weixin.qq.com/hook/test",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ errcode: 0 });
			},
		});

		await dispatcher.publishAggregatedProblems(problems, "Review done", "<@dev>");

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		const md = body.markdown as Record<string, unknown>;
		expect(md.content).toContain("<@dev>");
	});

	it("throws on non-2xx response", async () => {
		const dispatcher = createWeComBotDispatcher({
			webhookUrl: "https://qyapi.weixin.qq.com/hook/test",
			fetch: async () => response({ errcode: 40001 }, 400),
		});

		await expect(dispatcher.publishAggregatedProblems(problems)).rejects.toThrow("WeCom webhook returned 400");
	});

	it("truncates problems to 10 in display", async () => {
		const manyProblems: ReviewProblem[] = Array.from({ length: 15 }, (_, i) => ({
			file: `file${i}.ts`,
			line: i + 1,
			severity: "low" as const,
			category: "test",
			message: `Problem ${i}`,
		}));

		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createWeComBotDispatcher({
			webhookUrl: "https://qyapi.weixin.qq.com/hook/test",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ errcode: 0 });
			},
		});

		await dispatcher.publishAggregatedProblems(manyProblems);

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		const md = body.markdown as Record<string, unknown>;
		expect(md.content).toContain("Problems (15)");
		expect(md.content).toContain("file0.ts");
		expect(md.content).toContain("file9.ts");
		expect(md.content).not.toContain("file10.ts");
	});

	it("truncates long messages to avoid exceeding card limits", async () => {
		const longMessage = "A".repeat(600);
		const longSuggestion = "B".repeat(400);
		const longProblems: ReviewProblem[] = [{
			file: "src/app.ts",
			line: 1,
			severity: "high",
			category: "correctness",
			message: longMessage,
			suggestion: longSuggestion,
		}];

		const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
		const dispatcher = createFeishuBotDispatcher({
			webhookUrl: "https://open.feishu.cn/hook/test",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return response({ code: 0 });
			},
		});

		await dispatcher.publishAggregatedProblems(longProblems);

		const body = JSON.parse(calls[0]?.init?.body ?? "{}");
		const card = body.card as Record<string, unknown>;
		const cardBody = card.body as Record<string, unknown>;
		const elements = cardBody.elements as Record<string, unknown>[];
		const content = (elements[0] as Record<string, unknown>).content as string;
		expect(content).toContain("A".repeat(500));
		expect(content).toContain("...");
		expect(content).toContain("B".repeat(300));
		expect(content).not.toContain("A".repeat(501));
		expect(content).not.toContain("B".repeat(301));
	});
});

describe("computeProblemFingerprint", () => {
	it("produces a deterministic hash for same input", () => {
		const fp1 = computeProblemFingerprint({
			file: "src/app.ts",
			line: 42,
			category: "correctness",
			message: "Bug found.",
		});
		const fp2 = computeProblemFingerprint({
			file: "src/app.ts",
			line: 42,
			category: "correctness",
			message: "Bug found.",
		});

		expect(fp1).toBe(fp2);
	});

	it("produces different hashes for different inputs", () => {
		const fp1 = computeProblemFingerprint({
			file: "src/app.ts",
			line: 42,
			category: "correctness",
			message: "Bug found.",
		});
		const fp2 = computeProblemFingerprint({
			file: "src/app.ts",
			line: 43,
			category: "correctness",
			message: "Bug found.",
		});

		expect(fp1).not.toBe(fp2);
	});

	it("returns a non-empty string", () => {
		const fp = computeProblemFingerprint({
			file: "a.ts",
			line: 1,
			category: "test",
			message: "msg",
		});

		expect(fp.length).toBeGreaterThan(0);
	});
});
