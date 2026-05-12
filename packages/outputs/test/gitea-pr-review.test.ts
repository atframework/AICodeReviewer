import { describe, expect, it } from "vitest";

import {
  createGiteaPullRequestReviewDispatcher,
  OutputDispatchError,
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

const problem: ReviewProblem = {
  file: "src/app.ts",
  line: 42,
  severity: "high",
  category: "correctness",
  message: "This branch returns success before the write is committed.",
  suggestion: "Move the return after the awaited commit call.",
  fingerprint: "abc123",
};

describe("renderProblemMarkdown", () => {
  it("renders severity, category, suggestion, location, and fingerprint", () => {
    const markdown = renderProblemMarkdown(problem);

    expect(markdown).toContain("**HIGH · correctness**");
    expect(markdown).toContain("src/app.ts:42");
    expect(markdown).toContain("Suggested fix:");
    expect(markdown).toContain("<!-- aicr:fingerprint=abc123 -->");
  });

  it("renders without suggestion when not provided", () => {
    const minimal: ReviewProblem = {
      file: "src/util.ts",
      line: 10,
      severity: "low",
      category: "style",
      message: "Inconsistent naming.",
    };
    const markdown = renderProblemMarkdown(minimal);

    expect(markdown).toContain("**LOW · style**");
    expect(markdown).toContain("src/util.ts:10");
    expect(markdown).not.toContain("Suggested fix:");
    expect(markdown).not.toContain("<!-- aicr:fingerprint=");
  });

  it("renders without fingerprint when not provided", () => {
    const noFp: ReviewProblem = {
      file: "src/main.ts",
      line: 5,
      severity: "info",
      category: "naming",
      message: "Variable name could be more descriptive.",
    };
    const markdown = renderProblemMarkdown(noFp);

    expect(markdown).not.toContain("<!-- aicr:fingerprint=");
  });

  it("renders range notation when endLine is provided", () => {
    const ranged: ReviewProblem = {
      file: "src/bulk.ts",
      line: 10,
      endLine: 20,
      severity: "medium",
      category: "complexity",
      message: "This function is too long.",
    };
    const markdown = renderProblemMarkdown(ranged);

    expect(markdown).toContain("src/bulk.ts:10-20");
  });

  it("uses pre-rendered markdown without wrapping it again", () => {
    const markdown = renderProblemMarkdown({
      ...problem,
      renderedMarkdown: "CUSTOM BODY",
    });

    expect(markdown).toBe("CUSTOM BODY");
  });
});

describe("createGiteaPullRequestReviewDispatcher", () => {
  it("publishes a problem as a Gitea pull request review comment", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example/",
      token: "token-value",
      owner: "owent",
      repo: "example",
      pullNumber: 42,
      channelName: "gitea-pr-internal",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 123 });
      },
    });

    const result = await dispatcher.publishProblem(problem);

    expect(result).toEqual({ channel: "gitea-pr-internal", status: "published", externalId: "123", raw: { id: 123 } });
    expect(calls[0]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/pulls/42/reviews");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "token token-value",
    });
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      event: "COMMENT",
      comments: [
        {
          path: "src/app.ts",
          new_position: 42,
        },
      ],
    });
  });

  it("throws a typed dispatch error on non-2xx responses", async () => {
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 42,
      fetch: async () => response({ message: "bad token" }, 401),
    });

    await expect(dispatcher.publishProblem(problem)).rejects.toBeInstanceOf(OutputDispatchError);
    await expect(dispatcher.publishProblem(problem)).rejects.toMatchObject({ status: 401 });
  });

  it("uses the default channel name when not specified", async () => {
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async () => response({ id: 1 }),
    });

    const result = await dispatcher.publishProblem(problem);
    expect(result.channel).toBe("gitea_pr_review");
  });

  it("does not include authorization header when no token is provided", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishProblem(problem);

    expect(calls[0]?.init?.headers).not.toHaveProperty("authorization");
  });

  it("returns undefined externalId when the response has no id", async () => {
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async () => response({}),
    });

    const result = await dispatcher.publishProblem(problem);
    expect(result.externalId).toBeUndefined();
  });

  it("publishes a general review comment when a problem is marked non-line-commentable", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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

  it("falls back to a general review comment when Gitea rejects the line anchor", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? response({ message: "invalid position" }, 422)
          : response({ id: 2 });
      },
    });

    const result = await dispatcher.publishProblem(problem);

    expect(result.externalId).toBe("2");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]?.init?.body ?? "{}").comments).toHaveLength(1);
    expect(JSON.parse(calls[1]?.init?.body ?? "{}").comments).toBeUndefined();
  });

  it("strips trailing slashes from the base URL", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example///",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishProblem(problem);

    expect(calls[0]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/pulls/1/reviews");
  });
});

describe("OutputDispatchError", () => {
  it("stores status and responseBody properties", () => {
    const error = new OutputDispatchError("dispatch failed", {
      status: 500,
      responseBody: "server error",
    });

    expect(error.name).toBe("OutputDispatchError");
    expect(error.message).toBe("dispatch failed");
    expect(error.status).toBe(500);
    expect(error.responseBody).toBe("server error");
  });

  it("omits optional properties when not provided", () => {
    const error = new OutputDispatchError("simple error");

    expect(error.status).toBeUndefined();
    expect(error.responseBody).toBeUndefined();
  });

  it("is an instance of Error", () => {
    const error = new OutputDispatchError("msg");

    expect(error).toBeInstanceOf(Error);
  });
});

describe("renderProblemMarkdown additional edge cases", () => {
  it("renders all severity levels with correct capitalization", () => {
    const severities: Array<[string, string]> = [
      ["info", "INFO"],
      ["low", "LOW"],
      ["medium", "MEDIUM"],
      ["high", "HIGH"],
      ["critical", "CRITICAL"],
    ];

    for (const [severity, expected] of severities) {
      const markdown = renderProblemMarkdown({
        file: "a.ts",
        line: 1,
        severity: severity as "info" | "low" | "medium" | "high" | "critical",
        category: "test",
        message: "msg",
      });

      expect(markdown).toContain(`**${expected} · test**`);
    }
  });

  it("renders critical severity problem", () => {
    const markdown = renderProblemMarkdown({
      file: "src/auth.ts",
      line: 99,
      severity: "critical",
      category: "security",
      message: "Hardcoded secret detected.",
      suggestion: "Use environment variables.",
      fingerprint: "fp-secret",
    });

    expect(markdown).toContain("**CRITICAL · security**");
    expect(markdown).toContain("Hardcoded secret detected.");
    expect(markdown).toContain("Suggested fix:");
    expect(markdown).toContain("<!-- aicr:fingerprint=fp-secret -->");
  });
});

describe("extractExternalId via dispatcher", () => {
  it("handles numeric id in response body", async () => {
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async () => response({ id: 999 }),
    });

    const result = await dispatcher.publishProblem(problem);
    expect(result.externalId).toBe("999");
  });

  it("handles missing id field gracefully", async () => {
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      fetch: async () => response({ review_id: "r-1" }),
    });

    const result = await dispatcher.publishProblem(problem);
    expect(result.externalId).toBeUndefined();
  });

  it("encodes owner and repo with special characters in the URL", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "org/sub-org",
      repo: "repo&name",
      pullNumber: 5,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishProblem(problem);
    expect(calls[0]?.url).toContain("org%2Fsub-org");
    expect(calls[0]?.url).toContain("repo%26name");
  });

  it("attaches highest severity label to PR via publishSummary", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      severityLabelPrefix: "aicr:problem:",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/labels?name=")) {
          return response([{ id: 90, name: "aicr:problem:critical", color: "b60205" }]);
        }
        if (url.endsWith("/labels") && init?.method === "POST") {
          return response({ id: 91, name: "aicr:problem:critical", color: "b60205" });
        }
        return response({ id: 1 });
      },
    });

    const problems = [
      { ...problem, severity: "high" as const },
      { ...problem, severity: "critical" as const, fingerprint: "fp-crit" },
    ];
    const result = await dispatcher.publishSummary!("summary", problems);

    expect(result.status).toBe("published");
    const labelCall = calls.find((c) => c.url.includes("/issues/10/labels"));
    expect(labelCall).toBeDefined();
    const body = JSON.parse(labelCall?.init?.body ?? "{}");
    expect(body.labels).toContain(90);
  });

  it("publishes a summary as a Gitea pull request review comment without label config", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    const result = await dispatcher.publishSummary!("Review summary", []);

    expect(result.externalId).toBe("1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/pulls/10/reviews");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({
      event: "COMMENT",
      body: "Review summary",
    });
  });

  it("attaches auto, reviewed, and highest severity labels to PR summaries", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const labelIds: Record<string, number> = {
      "aicr": 70,
      "aicr:reviewed": 71,
      "aicr:problem:critical": 72,
    };
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      autoTag: "aicr",
      reviewedTag: "aicr:reviewed",
      severityLabelPrefix: "aicr:problem:",
      fetch: async (url, init) => {
        calls.push({ url, init });
        const nameMatch = /[?&]name=([^&]+)/u.exec(url);
        if (nameMatch?.[1]) {
          const name = decodeURIComponent(nameMatch[1]);
          return response([{ id: labelIds[name], name, color: "ededed" }]);
        }
        return response({ id: 1 });
      },
    });

    await dispatcher.publishSummary!("Review summary", [
      { ...problem, severity: "medium", fingerprint: "fp-medium" },
      { ...problem, severity: "critical", fingerprint: "fp-critical" },
    ]);

    const labelCall = calls.find((c) => c.url.includes("/issues/10/labels"));
    expect(labelCall).toBeDefined();
    expect(JSON.parse(labelCall?.init?.body ?? "{}")).toEqual({ labels: [70, 71, 72] });
  });
});
