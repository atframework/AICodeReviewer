import { describe, expect, it } from "vitest";

import {
  createGithubPullRequestReviewDispatcher,
  OutputDispatchError,
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
  file: "src/app.ts",
  line: 42,
  severity: "high",
  category: "correctness",
  message: "This branch returns success before the write is committed.",
  suggestion: "Move the return after the awaited commit call.",
  fingerprint: "abc123",
};

describe("createGithubPullRequestReviewDispatcher", () => {
  it("publishes a problem as a single GitHub pull request review body", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      token: "gh-token",
      owner: "owent",
      repo: "example",
      pullNumber: 42,
      channelName: "github-pr-main",
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 123 });
      },
    });

    await dispatcher.publishProblem(problem);
    const result = await dispatcher.publishSummary!("");

    expect(result).toMatchObject({ channel: "github-pr-main", status: "published", externalId: "123" });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/owent/example/pulls/42/reviews");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer gh-token",
      accept: "application/vnd.github+json",
    });
    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.event).toBe("COMMENT");
    expect(body.comments).toBeUndefined();
    expect(body.body).toContain("src/app.ts:42");
    expect(body.body).toContain("This branch returns success before the write is committed.");
  });

  it("publishes buffered problems only once across multiple summary entries (always_new)", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      token: "gh-token",
      owner: "owent",
      repo: "example",
      pullNumber: 42,
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: calls.length });
      },
    });

    await dispatcher.publishProblem(problem);
    // The orchestrator may emit more than one summary entry; the buffered
    // problems must not be re-published with each summary.
    await dispatcher.publishSummary!("First summary", [problem]);
    await dispatcher.publishSummary!("Second summary", [problem]);

    const bodiesWithProblem = calls.filter((call) =>
      String(JSON.parse(call.init?.body ?? "{}").body ?? "").includes("src/app.ts:42"),
    );
    expect(bodiesWithProblem).toHaveLength(1);
  });

  it("uses a custom API base URL and URL-encodes path segments", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      baseUrl: "https://github.enterprise/api/v3/",
      owner: "org/sub-org",
      repo: "repo&name",
      pullNumber: 5,
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishProblem(problem);
    await dispatcher.publishSummary!("");

    expect(calls[0]?.url).toBe("https://github.enterprise/api/v3/repos/org%2Fsub-org/repo%26name/pulls/5/reviews");
  });

  it("publishes a general review comment when a problem is marked non-line-commentable", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishProblem({ ...problem, lineCommentAllowed: false });
    await dispatcher.publishSummary!("");

    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.event).toBe("COMMENT");
    expect(body.comments).toBeUndefined();
    expect(body.body).toContain("src/app.ts:42");
  });

  it("falls back to one issue comment when GitHub rejects the review body (auto mode)", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? response({ message: "Validation Failed" }, 422)
          : response({ id: 2 });
      },
    });

    await dispatcher.publishProblem(problem);
    const result = await dispatcher.publishSummary!("");

    expect(result.externalId).toBe("2");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/reviews");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}").comments).toBeUndefined();
    expect(calls[1]?.url).toContain("/issues/1/comments");
    const commentBody = JSON.parse(calls[1]?.init?.body ?? "{}");
    expect(commentBody.body).toContain("src/app.ts:42");
    expect(commentBody.event).toBeUndefined();
  });

  it("throws a typed dispatch error on non-recoverable responses", async () => {
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async () => response({ message: "bad credentials" }, 401),
    });

    await dispatcher.publishProblem(problem);
    await expect(dispatcher.publishSummary!("")).rejects.toBeInstanceOf(OutputDispatchError);
    await expect(dispatcher.publishSummary!("")).rejects.toMatchObject({ status: 401 });
  });

  it("publishes a summary as a GitHub pull request review comment", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 42 });
      },
    });

    const result = await dispatcher.publishSummary!("Review summary", []);

    expect(result.externalId).toBe("42");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/owent/example/pulls/10/reviews");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({
      event: "COMMENT",
      body: "Review summary",
    });
  });

  it("attaches the highest severity label by name", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      severityLabelPrefix: "aicr:problem:",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/labels") && init?.method !== "POST") {
          return response([{ id: 90, name: "aicr:problem:critical", color: "b60205" }]);
        }
        return response({ id: 1 });
      },
    });

    await dispatcher.publishSummary!("summary", [
      { ...problem, severity: "medium", fingerprint: "fp-medium" },
      { ...problem, severity: "critical", fingerprint: "fp-critical" },
    ]);

    const labelCall = calls.find((call) => call.url.includes("/issues/10/labels"));
    expect(labelCall).toBeDefined();
    expect(JSON.parse(labelCall?.init?.body ?? "{}")).toEqual({ labels: ["aicr:problem:critical"] });
  });

  it("attaches auto, reviewed, and highest severity labels to PR summaries", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const existingLabels = [
      { id: 1, name: "aicr", color: "ededed" },
      { id: 2, name: "aicr:reviewed", color: "ededed" },
      { id: 3, name: "aicr:problem:critical", color: "b60205" },
    ];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      autoTag: "aicr",
      reviewedTag: "aicr:reviewed",
      severityLabelPrefix: "aicr:problem:",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/labels") && init?.method !== "POST") {
          return response(existingLabels);
        }
        return response({ id: 1 });
      },
    });

    await dispatcher.publishSummary!("Review summary", [
      { ...problem, severity: "medium", fingerprint: "fp-medium" },
      { ...problem, severity: "critical", fingerprint: "fp-critical" },
    ]);

    const labelCall = calls.find((call) => call.url.includes("/issues/10/labels"));
    expect(labelCall).toBeDefined();
    expect(JSON.parse(labelCall?.init?.body ?? "{}")).toEqual({
      labels: ["aicr", "aicr:reviewed", "aicr:problem:critical"],
    });
  });

  it("posts to issue comment endpoint in comment mode", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewMode: "comment",
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 10 });
      },
    });

    await dispatcher.publishProblem(problem);
    const result = await dispatcher.publishSummary!("");

    expect(result.channel).toBe("github_pr_review");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/issues/1/comments");
    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.body).toContain("src/app.ts:42");
    expect(body.event).toBeUndefined();
  });

  it("uses REQUEST_CHANGES event when configured", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewEvent: "REQUEST_CHANGES",
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 11 });
      },
    });

    await dispatcher.publishProblem(problem);
    await dispatcher.publishSummary!("");

    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.event).toBe("REQUEST_CHANGES");
    expect(body.comments).toBeUndefined();
    expect(body.body).toContain("src/app.ts:42");
  });

  it("does not fallback in review mode on permission error", async () => {
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewMode: "review",
      reviewUpdateStrategy: "always_new",
      fetch: async () => response({ message: "forbidden" }, 403),
    });

    await dispatcher.publishProblem(problem);
    await expect(dispatcher.publishSummary!("")).rejects.toThrow("GitHub review API returned 403");
  });

  it("falls back to issue comment on 403 (auto mode)", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? response({ message: "forbidden" }, 403)
          : response({ id: 3 });
      },
    });

    await dispatcher.publishProblem(problem);
    const result = await dispatcher.publishSummary!("");

    expect(result.externalId).toBe("3");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/reviews");
    expect(calls[1]?.url).toContain("/issues/1/comments");
  });

  it("publishes summary via comment endpoint in comment mode", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewMode: "comment",
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 20 });
      },
    });

    await dispatcher.publishSummary!("Review summary");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/issues/1/comments");
    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.body).toBe("Review summary");
  });

  it("buffers problems and returns status buffered before publishSummary flushes", async () => {
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewUpdateStrategy: "always_new",
      fetch: async () => response({ id: 1 }),
    });

    const buffered = await dispatcher.publishProblem(problem);
    expect(buffered.status).toBe("buffered");
    expect(buffered.raw).toMatchObject({ buffered: true });
  });

  it("flushes buffered problems as a single consolidated review", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 99 });
      },
    });

    await dispatcher.publishProblem(problem);
    await dispatcher.publishProblem({ ...problem, file: "src/other.ts", line: 10, fingerprint: "def456" });
    await dispatcher.publishSummary!("Summary");

    const reviewCall = calls.find((c) => c.url.includes("/reviews"));
    expect(reviewCall).toBeDefined();
    const body = JSON.parse(reviewCall?.init?.body ?? "{}");
    expect(body.comments).toBeUndefined();
    expect(body.body).toContain("Summary");
    expect(body.body).toContain("src/app.ts:42");
    expect(body.body).toContain("src/other.ts:10");
    expect(body.body.match(/### \d+\. \[HIGH\] correctness/gu)).toHaveLength(2);
  });

  it("embeds problem metadata marker in managed summary comment", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      reviewUpdateStrategy: "update_existing",
      headSha: "abc1234567890",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([]);
        }
        return response({ id: 100 });
      },
    });

    await dispatcher.publishSummary!("Summary text", [problem]);

    const postCall = calls.find((c) => c.init?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall?.init?.body ?? "{}");
    expect(body.body).toMatch(/<!--\s*aicr:problem-meta=/u);
  });

  it("renders resolved issues with readable titles from metadata", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const previousFingerprint = problem.fingerprint!;
    const encodedMeta = Buffer.from(JSON.stringify([{
      fingerprint: previousFingerprint,
      severity: problem.severity,
      category: problem.category,
      file: problem.file,
      line: problem.line,
    }]), "utf-8").toString("base64");
    const existingBody = [
      "<!-- aicr:managed=pr-review -->",
      "<!-- aicr:scope=github_pr_review -->",
      `<!-- aicr:problems=${previousFingerprint} -->`,
      `<!-- aicr:problem-meta=${encodedMeta} -->`,
      "",
      "## AI Code Review",
      "",
      "Old summary",
    ].join("\n");

    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      reviewUpdateStrategy: "update_existing",
      headSha: "def7890123456",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([{ id: 1, body: existingBody }]);
        }
        return response({ id: 101 });
      },
    });

    await dispatcher.publishSummary!("New summary", []);

    const patchCall = calls.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall?.init?.body ?? "{}");
    expect(body.body).toContain("Resolved");
    expect(body.body).toContain("[HIGH] correctness — src/app.ts:42");
    expect(body.body).not.toContain(previousFingerprint);
    expect(body.body).toMatch(/\[~~\[HIGH\] correctness — src\/app\.ts:42~~\]\(#aicr-problem-[0-9a-f]{12}\)/u);
    expect(body.body).toMatch(/<span id="aicr-resolved-1"><\/span>/u);
  });

  it("backfills readable resolved titles from legacy open issue lines", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const previousFingerprint = "763ad070712ca49e";
    const existingBody = [
      "<!-- aicr:managed=pr-review -->",
      "<!-- aicr:scope=github_pr_review -->",
      `<!-- aicr:problems=${previousFingerprint} -->`,
      "",
      "## AI Code Review",
      "",
      "### Open Issues (1)",
      "",
      "1. **[MEDIUM] api_contract** — `src/service.cpp:87`",
    ].join("\n");

    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      reviewUpdateStrategy: "update_existing",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([{ id: 1, body: existingBody }]);
        }
        return response({ id: 102 });
      },
    });

    await dispatcher.publishSummary!("New summary", []);

    const patchCall = calls.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall?.init?.body ?? "{}");
    expect(body.body).toContain("[MEDIUM] api_contract — src/service.cpp:87");
    expect(body.body).not.toContain(previousFingerprint);
  });

  it("does not render raw fingerprint text when legacy resolved metadata is unavailable", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const previousFingerprint = "763ad070712ca49e";
    const existingBody = [
      "<!-- aicr:managed=pr-review -->",
      "<!-- aicr:scope=github_pr_review -->",
      `<!-- aicr:problems=${previousFingerprint} -->`,
      "",
      "## AI Code Review",
      "",
      "Old summary without problem metadata",
    ].join("\n");

    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      reviewUpdateStrategy: "update_existing",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([{ id: 1, body: existingBody }]);
        }
        return response({ id: 103 });
      },
    });

    await dispatcher.publishSummary!("New summary", []);

    const patchCall = calls.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall?.init?.body ?? "{}");
    expect(body.body).toContain("Previously reported issue");
    expect(body.body).not.toContain(previousFingerprint);
  });
});

describe("createGithubPullRequestReviewDispatcher (update_existing)", () => {
  it("creates a new managed summary comment when no existing one exists", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      reviewUpdateStrategy: "update_existing",
      headSha: "abc1234567890",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([]);
        }
        return response({ id: 100 });
      },
    });

    const result = await dispatcher.publishSummary!("Summary text", [problem]);

    expect(result.status).toBe("published");
    const postCall = calls.find((c) => c.init?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall?.init?.body ?? "{}");
    expect(body.body).toContain("aicr:managed=pr-review");
    expect(body.body).toContain("Summary text");
    expect(body.body).toContain("Open Issues");
    expect(body.body).toContain("abc1234");
  });

  it("updates an existing managed summary comment", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const existingBody = [
      "<!-- aicr:managed=pr-review -->",
      "<!-- aicr:scope=github_pr_review -->",
      "<!-- aicr:problems=old-fp-1,old-fp-2 -->",
      "",
      "## AI Code Review",
      "",
      "Old summary",
    ].join("\n");

    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      reviewUpdateStrategy: "update_existing",
      headSha: "def4567890123",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([{ id: 50, body: existingBody }]);
        }
        return response({ id: 50 });
      },
    });

    const newProblem: ReviewProblem = {
      file: "src/new.ts",
      line: 5,
      severity: "medium",
      category: "style",
      message: "Bad style",
      fingerprint: "new-fp-3",
    };
    const result = await dispatcher.publishSummary!("New summary", [newProblem]);

    expect(result.status).toBe("published");
    expect(result.externalId).toBe("50");
    const patchCall = calls.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall?.init?.body ?? "{}");
    expect(body.body).toContain("aicr:managed=pr-review");
    expect(body.body).toContain("New summary");
    expect(body.body).toContain("new-fp-3");
    expect(body.body).toContain("def4567");
    expect(body.body).toContain("Resolved");
  });

  it("preserves still-open problems and marks new ones", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const existingBody = [
      "<!-- aicr:managed=pr-review -->",
      "<!-- aicr:scope=github_pr_review -->",
      "<!-- aicr:problems=fp-keep,fp-resolve -->",
      "",
      "## AI Code Review",
    ].join("\n");

    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      reviewUpdateStrategy: "update_existing",
      headSha: "aaa1112223334",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([{ id: 60, body: existingBody }]);
        }
        return response({ id: 60 });
      },
    });

    const keptProblem: ReviewProblem = {
      file: "src/keep.ts",
      line: 10,
      severity: "high",
      category: "bug",
      message: "Keep this",
      fingerprint: "fp-keep",
    };
    const result = await dispatcher.publishSummary!("Updated", [keptProblem]);

    expect(result.status).toBe("published");
    const patchCall = calls.find((c) => c.init?.method === "PATCH");
    const body = JSON.parse(patchCall?.init?.body ?? "{}");
    expect(body.body).toContain("fp-keep");
    expect(body.body).toContain("Open Issues");
    expect(body.body).toContain("Resolved");
    expect(body.body).toContain("Previously reported issue");
    expect(body.body).not.toContain("fp-resolve");
  });

  it("parses previous fingerprints with spaces in managed summary markers", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const existingBody = [
      "<!-- aicr:managed=pr-review -->",
      "<!-- aicr:scope=github_pr_review -->",
      "<!-- aicr:problems=fp-keep, fp-resolve -->",
      "",
      "## AI Code Review",
    ].join("\n");

    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      reviewUpdateStrategy: "update_existing",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([{ id: 61, body: existingBody }]);
        }
        return response({ id: 61 });
      },
    });

    await dispatcher.publishSummary!("Updated", [{
      file: "src/keep.ts",
      line: 10,
      severity: "high",
      category: "bug",
      message: "Keep this",
      fingerprint: "fp-keep",
    }]);

    const patchCall = calls.find((c) => c.init?.method === "PATCH");
    const body = JSON.parse(patchCall?.init?.body ?? "{}");
    expect(body.body).toContain("<!-- aicr:problems=fp-keep -->");
    expect(body.body).toContain("Resolved (1)");
    expect(body.body).toContain("Previously reported issue");
    expect(body.body).not.toContain("fp-resolve");
  });

  it("does not update a managed summary comment from another channel scope", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const existingBody = [
      "<!-- aicr:managed=pr-review -->",
      "<!-- aicr:scope=github-pr-primary -->",
      "<!-- aicr:problems=fp-primary -->",
      "",
      "## AI Code Review",
    ].join("\n");

    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      channelName: "github-pr-secondary",
      reviewUpdateStrategy: "update_existing",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([{ id: 62, body: existingBody }]);
        }
        return response({ id: 100 });
      },
    });

    await dispatcher.publishSummary!("Secondary summary", []);

    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(false);
    const postCall = calls.find((c) => c.init?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall?.init?.body ?? "{}");
    expect(body.body).toContain("<!-- aicr:scope=github-pr-secondary -->");
  });
});
