import { describe, expect, it } from "vitest";

import {
  createGiteaProblemIssueDispatcher,
  getHighestSeverity,
  matchOwnersForFile,
  parseOwnersContent,
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
  "<!-- aicr:channel=aicr-issues -->",
  "<!-- aicr:label=aicr-managed -->",
  "<!-- aicr:fingerprint=fp-old -->",
  "",
  "Old problem",
].join("\n");

describe("createGiteaProblemIssueDispatcher", () => {
  it("creates one marked issue per new problem", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      markerPrefix: "[AICR Test]",
      markerLabel: "aicr-managed",
      labelIds: [1, 2],
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1 ? response([]) : response({ id: 99, number: 7 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem], "Summary text");

    expect(results).toHaveLength(1);
    expect(results[0]?.externalId).toBe("99");
    expect(calls[0]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/issues?state=open&type=issues&limit=20&page=1");
    expect(calls[1]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/issues");
    expect(calls[1]?.init?.headers).toMatchObject({ authorization: "token token-value" });
    const body = JSON.parse(calls[1]?.init?.body ?? "{}");
    expect(body.title).toContain("[AICR Test] [CRITICAL] security: src/auth.ts:12");
    expect(body.body).toContain("<!-- aicr:managed=problem-issue -->");
    expect(body.body).toContain("<!-- aicr:fingerprint=fp-sql -->");
    expect(body.body).toContain("Summary text");
    expect(body.labels).toEqual([1, 2]);
  });

  it("does not duplicate an open managed issue with the same fingerprint", async () => {
    const calls: string[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
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
      "GET https://gitea.example/api/v1/repos/owent/example/issues?state=open&type=issues&limit=20&page=1",
      "POST https://gitea.example/api/v1/repos/owent/example/issues/42/comments",
      "PATCH https://gitea.example/api/v1/repos/owent/example/issues/42",
    ]);
    expect(JSON.parse(calls[2]?.init?.body ?? "{}")).toEqual({ state: "closed" });
  });

  it("uses a configured recent managed issue fetch limit", async () => {
    const calls: string[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      maxRecentIssues: 7,
      fetch: async (url) => {
        calls.push(url);
        return response([]);
      },
    });

    await dispatcher.reconcileProblems([]);

    expect(calls).toEqual([
      "https://gitea.example/api/v1/repos/owent/example/issues?state=open&type=issues&limit=7&page=1",
    ]);
  });

  it("deletes stale managed issues when configured", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      resolvedAction: "delete",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? response([{ number: 42, title: "[AICR] stale", body: managedBody, state: "open" }])
          : response({}, 204);
      },
    });

    const results = await dispatcher.reconcileProblems([]);

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "deleted", issueNumber: 42 });
    expect(calls[1]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/issues/42");
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  it("adds committer and matched owners as assignees when configured", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const authProblem: ReviewProblem = {
      file: "src/auth/login.ts",
      line: 5,
      severity: "high",
      category: "correctness",
      message: "Missing null check.",
      fingerprint: "fp-auth",
    };
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      committerUsername: "committer-user",
      addOwnersAsAssignees: true,
      ownersContent: [
        'reviewers:',
        '  - admin1',
        'paths:',
        '  "src/auth/":',
        '    - alice',
        '    - bob',
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

  it("falls back to reviewers when no path matches", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      committerUsername: "committer-user",
      addOwnersAsAssignees: true,
      ownersContent: [
        'reviewers:',
        '  - admin1',
        '  - admin2',
        'paths:',
        '  "src/api/":',
        '    - charlie',
      ].join("\n"),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1 ? response([]) : response({ id: 100, number: 10 });
      },
    });

    await dispatcher.reconcileProblems([problem]);

    const body = JSON.parse(calls[1]?.init?.body ?? "{}");
    expect(body.assignees).toContain("committer-user");
    expect(body.assignees).toContain("admin1");
    expect(body.assignees).toContain("admin2");
    expect(body.assignees).not.toContain("charlie");
  });

  it("auto-creates severity labels and attaches them to issues", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      severityLabelPrefix: "aicr:problem:",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/labels?name=")) {
          return response([]);
        }
        if (url.endsWith("/labels") && init?.method === "POST") {
          return response({ id: 50, name: "aicr:problem:critical", color: "b60205" });
        }
        if (url.includes("/issues?state=open")) {
          return response([]);
        }
        return response({ id: 200, number: 20 });
      },
    });

    await dispatcher.reconcileProblems([problem]);

    const issueBody = JSON.parse(
      calls.find((c) => c.url.endsWith("/issues") && c.init?.method === "POST")?.init?.body ?? "{}",
    );
    expect(issueBody.labels).toContain(50);
  });

  it("sends Feishu notification after creating an issue", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      notifyFeishu: {
        webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
        secret: "test-secret",
      },
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?state=open")) {
          return response([]);
        }
        if (url.endsWith("/issues") && init?.method === "POST") {
          return response({ id: 300, number: 30, html_url: "https://gitea.example/owent/example/issues/30" });
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
    expect(content).toContain("https://gitea.example/owent/example/issues/30");
    expect(body.sign).toBeDefined();
  });
});

describe("parseOwnersContent", () => {
  it("parses reviewers and path-based owners", () => {
    const content = [
      "reviewers:",
      "  - admin1",
      "  - admin2",
      "paths:",
      '  "src/auth/":',
      "    - alice",
      "    - bob",
      '  "src/api/":',
      "    - charlie",
    ].join("\n");

    const owners = parseOwnersContent(content);
    expect(owners.reviewers).toEqual(["admin1", "admin2"]);
    expect(owners.paths?.["src/auth/"]).toEqual(["alice", "bob"]);
    expect(owners.paths?.["src/api/"]).toEqual(["charlie"]);
  });

  it("returns empty config for empty content", () => {
    const owners = parseOwnersContent("");
    expect(owners.reviewers).toBeUndefined();
    expect(owners.paths).toBeUndefined();
  });

  it("ignores comments and blank lines", () => {
    const content = [
      "# This is a comment",
      "",
      "reviewers:",
      "  - admin1",
      "# Another comment",
      "  - admin2",
    ].join("\n");

    const owners = parseOwnersContent(content);
    expect(owners.reviewers).toEqual(["admin1", "admin2"]);
  });
});

describe("matchOwnersForFile", () => {
  const owners = {
    reviewers: ["admin1", "admin2"],
    paths: {
      "src/auth/": ["alice", "bob"],
      "src/api/": ["charlie"],
      "src/": ["dev1"],
    },
  };

  it("matches most specific path prefix", () => {
    expect(matchOwnersForFile("src/auth/login.ts", owners)).toEqual(["alice", "bob"]);
  });

  it("matches less specific path when more specific does not exist", () => {
    expect(matchOwnersForFile("src/utils/helper.ts", owners)).toEqual(["dev1"]);
  });

  it("falls back to reviewers when no path matches", () => {
    expect(matchOwnersForFile("README.md", owners)).toEqual(["admin1", "admin2"]);
  });
});

describe("getHighestSeverity", () => {
  it("returns the highest severity from a list of problems", () => {
    const problems: ReviewProblem[] = [
      { file: "a.ts", line: 1, severity: "low", category: "style", message: "m1" },
      { file: "b.ts", line: 2, severity: "critical", category: "security", message: "m2" },
      { file: "c.ts", line: 3, severity: "medium", category: "correctness", message: "m3" },
    ];
    expect(getHighestSeverity(problems)).toBe("critical");
  });

  it("returns undefined for empty array", () => {
    expect(getHighestSeverity([])).toBeUndefined();
  });

  it("returns the single severity when only one problem", () => {
    const problems: ReviewProblem[] = [
      { file: "a.ts", line: 1, severity: "high", category: "correctness", message: "m1" },
    ];
    expect(getHighestSeverity(problems)).toBe("high");
  });
});