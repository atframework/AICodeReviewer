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
  it("publishes a problem as a GitHub pull request review comment", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      token: "gh-token",
      owner: "owent",
      repo: "example",
      pullNumber: 42,
      channelName: "github-pr-main",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 123 });
      },
    });

    const result = await dispatcher.publishProblem(problem);

    expect(result).toEqual({ channel: "github-pr-main", status: "published", externalId: "123", raw: { id: 123 } });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/owent/example/pulls/42/reviews");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer gh-token",
      accept: "application/vnd.github+json",
    });
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      event: "COMMENT",
      comments: [
        {
          path: "src/app.ts",
          line: 42,
          side: "RIGHT",
        },
      ],
    });
  });

  it("uses a custom API base URL and URL-encodes path segments", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      baseUrl: "https://github.enterprise/api/v3/",
      owner: "org/sub-org",
      repo: "repo&name",
      pullNumber: 5,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishProblem(problem);

    expect(calls[0]?.url).toBe("https://github.enterprise/api/v3/repos/org%2Fsub-org/repo%26name/pulls/5/reviews");
  });

  it("publishes a general review comment when a problem is marked non-line-commentable", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishProblem({ ...problem, lineCommentAllowed: false });

    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.event).toBe("COMMENT");
    expect(body.comments).toBeUndefined();
    expect(body.body).toContain("src/app.ts:42");
  });

  it("falls back to a general review comment when GitHub rejects the line anchor", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? response({ message: "Validation Failed" }, 422)
          : response({ id: 2 });
      },
    });

    const result = await dispatcher.publishProblem(problem);

    expect(result.externalId).toBe("2");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]?.init?.body ?? "{}").comments).toHaveLength(1);
    expect(JSON.parse(calls[1]?.init?.body ?? "{}").comments).toBeUndefined();
  });

  it("throws a typed dispatch error on non-recoverable responses", async () => {
    const dispatcher = createGithubPullRequestReviewDispatcher({
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async () => response({ message: "bad credentials" }, 401),
    });

    await expect(dispatcher.publishProblem(problem)).rejects.toBeInstanceOf(OutputDispatchError);
    await expect(dispatcher.publishProblem(problem)).rejects.toMatchObject({ status: 401 });
  });
});
