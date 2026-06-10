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

  it("renders a referenced code block when a snippet is provided", () => {
    const markdown = renderProblemMarkdown({
      ...problem,
      codeSnippet: "const ok = false;\nreturn ok;",
      codeLanguage: "ts",
    });

    expect(markdown).toContain("Referenced code: `src/app.ts:42`");
    expect(markdown).toContain("```ts");
    expect(markdown).toContain("return ok;");
  });
});

describe("createGiteaPullRequestReviewDispatcher", () => {
  it("publishes a problem as a single Gitea pull request review body", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example/",
      token: "token-value",
      owner: "owent",
      repo: "example",
      pullNumber: 42,
      channelName: "gitea-pr-internal",
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 123 });
      },
    });

    await dispatcher.publishProblem(problem);
    const result = await dispatcher.publishSummary!("");

    expect(result).toMatchObject({ channel: "gitea-pr-internal", status: "published", externalId: "123" });
    expect(calls[0]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/pulls/42/reviews");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "token token-value",
    });
    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.event).toBe("COMMENT");
    expect(body.comments).toBeUndefined();
    expect(body.body).toContain("src/app.ts:42");
    expect(body.body).toContain("This branch returns success before the write is committed.");
  });

  it("throws a typed dispatch error on non-2xx responses", async () => {
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 42,
      fetch: async () => response({ message: "bad token" }, 401),
    });

    await dispatcher.publishProblem(problem);
    await expect(dispatcher.publishSummary!("")).rejects.toBeInstanceOf(OutputDispatchError);
    await dispatcher.publishProblem(problem);
    await expect(dispatcher.publishSummary!("")).rejects.toMatchObject({ status: 401 });
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
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishProblem(problem);
    await dispatcher.publishSummary!("");

    expect(calls[0]?.init?.headers).not.toHaveProperty("authorization");
  });

  it("returns undefined externalId when the response has no id", async () => {
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewUpdateStrategy: "always_new",
      fetch: async () => response({}),
    });

    await dispatcher.publishProblem(problem);
    const result = await dispatcher.publishSummary!("", [problem]);
    expect(result.externalId).toBeUndefined();
  });

  it("publishes a general review comment when a problem is marked non-line-commentable", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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

  it("falls back to one issue comment when Gitea rejects the review body (auto mode)", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? response({ message: "invalid position" }, 422)
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
    expect(JSON.parse(calls[1]?.init?.body ?? "{}").body).toContain("src/app.ts:42");
  });

  it("falls back to issue comment on 403 (auto mode)", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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

  it("strips trailing slashes from the base URL", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example///",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewUpdateStrategy: "always_new",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishProblem(problem);
    await dispatcher.publishSummary!("");

    expect(calls[0]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/pulls/1/reviews");
  });

  it("posts to issue comment endpoint in comment mode", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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

    expect(result.channel).toBe("gitea_pr_review");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/issues/1/comments");
    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.body).toContain("src/app.ts:42");
    expect(body.event).toBeUndefined();
  });

  it("uses REQUEST_CHANGES event when configured", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewMode: "review",
      reviewUpdateStrategy: "always_new",
      fetch: async () => response({ message: "forbidden" }, 403),
    });

    await dispatcher.publishProblem(problem);
    await expect(dispatcher.publishSummary!("")).rejects.toThrow("Gitea review API returned 403");
  });

  it("publishes summary via comment endpoint in comment mode", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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
      reviewUpdateStrategy: "always_new",
      fetch: async () => response({ id: 999 }),
    });

    await dispatcher.publishProblem(problem);
    const result = await dispatcher.publishSummary!("", [problem]);
    expect(result.externalId).toBe("999");
  });

  it("handles missing id field gracefully", async () => {
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 1,
      reviewUpdateStrategy: "always_new",
      fetch: async () => response({ review_id: "r-1" }),
    });

    await dispatcher.publishProblem(problem);
    const result = await dispatcher.publishSummary!("", [problem]);
    expect(result.externalId).toBeUndefined();
  });

  it("encodes owner and repo with special characters in the URL", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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
      reviewUpdateStrategy: "always_new",
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

describe("createGiteaPullRequestReviewDispatcher (update_existing)", () => {
  it("creates a new managed summary comment when no existing one exists", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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
      "<!-- aicr:scope=gitea_pr_review -->",
      "<!-- aicr:problems=old-fp-1,old-fp-2 -->",
      "",
      "## AI Code Review",
      "",
      "Old summary",
    ].join("\n");

    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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
      "<!-- aicr:scope=gitea_pr_review -->",
      "<!-- aicr:problems=fp-keep,fp-resolve -->",
      "",
      "## AI Code Review",
    ].join("\n");

    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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
      "<!-- aicr:scope=gitea_pr_review -->",
      "<!-- aicr:problems=fp-keep, fp-resolve -->",
      "",
      "## AI Code Review",
    ].join("\n");

    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
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
      "<!-- aicr:scope=gitea-pr-primary -->",
      "<!-- aicr:problems=fp-primary -->",
      "",
      "## AI Code Review",
    ].join("\n");

    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      channelName: "gitea-pr-secondary",
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
    expect(body.body).toContain("<!-- aicr:scope=gitea-pr-secondary -->");
  });

  it("migrates legacy unscoped managed summary comments to the current channel scope", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const existingBody = [
      "<!-- aicr:managed=pr-review -->",
      "<!-- aicr:problems=fp-legacy -->",
      "",
      "## AI Code Review",
    ].join("\n");

    const dispatcher = createGiteaPullRequestReviewDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      pullNumber: 10,
      channelName: "gitea-pr-custom",
      reviewUpdateStrategy: "update_existing",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (!init?.method || init.method === "GET") {
          return response([{ id: 63, body: existingBody }]);
        }
        return response({ id: 63 });
      },
    });

    await dispatcher.publishSummary!("Migrated summary", []);

    const patchCall = calls.find((c) => c.init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall?.init?.body ?? "{}");
    expect(body.body).toContain("<!-- aicr:scope=gitea-pr-custom -->");
  });
});
