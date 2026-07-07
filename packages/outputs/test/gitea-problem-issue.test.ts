import { describe, expect, it } from "vitest";

import {
  createGiteaProblemIssueDispatcher,
  computeScopeFingerprint,
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
      issueMode: "per_problem",
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
    expect(body.title).toBe("[AICR Test] [CRITICAL] src/auth.ts:12 · SQL query uses unsanitized input");
    expect(body.title).not.toContain(" - ");
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      issueMode: "per_problem",
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
      "GET https://gitea.example/api/v1/repos/owent/example/issues/42",
    ]);
    expect(JSON.parse(calls[2]?.init?.body ?? "{}")).toEqual({ state: "closed" });
  });

  it("uses a configured recent managed issue fetch limit", async () => {
    const calls: string[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      issueMode: "per_problem",
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
      issueMode: "per_problem",
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
      issueMode: "per_problem",
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
      issueMode: "per_problem",
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
      issueMode: "per_problem",
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
    const content = (body.card.body.elements as Array<{ content: string }>)[0]?.content ?? "";
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

describe("createGiteaProblemIssueDispatcher consolidated mode", () => {
  const problem2: ReviewProblem = {
    file: "src/utils.ts",
    line: 30,
    severity: "medium",
    category: "performance",
    message: "Inefficient loop detected.",
  };

  it("creates one consolidated issue with all problems", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      markerPrefix: "[AICR]",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([]);
        }
        return response({ id: 500, number: 50 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem, problem2], "Review summary");

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "created_consolidated" });

    const body = JSON.parse(
      calls.find((c) => c.url === "https://gitea.example/api/v1/repos/owent/example/issues" && c.init?.method === "POST")?.init?.body ?? "{}",
    );
    expect(body.title).toBe("[AICR] [CRITICAL] 2 problems · SQL query uses unsanitized input");
    expect(body.title).not.toContain("Code Review Report");
    expect(body.body).toContain("<!-- aicr:consolidated=true -->");
    expect(body.body).toContain("<!-- aicr:scope_fingerprint=");
    expect(body.body).toContain("SQL query uses unsanitized input");
    expect(body.body).toContain("Inefficient loop detected");
    expect(body.body).toContain("Review summary");
  });

  it("updates existing consolidated issue on re-analysis", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const consolidatedBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "",
      "Old content",
    ].join("\n");

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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

  it("closes consolidated issue when no problems found", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const consolidatedBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "",
      "Old content",
    ].join("\n");

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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

  it("returns empty results when no problems and no existing issue", async () => {
    const calls: string[] = [];
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
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

  it("shows resolved section when new commit drops some problems", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const oldBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
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

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "bbb222",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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

    const results = await dispatcher.reconcileProblems([problem], "Updated summary");

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

  it("skips resolution on same commit", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const oldBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "<!-- aicr:commit=abc123 -->",
      "<!-- aicr:open_problems=fp-sql,fp-perf -->",
      "",
      "Old content",
    ].join("\n");

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "abc123",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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

  it("skips update when current commit is behind stored commit", async () => {
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const oldBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "<!-- aicr:commit=bbb222 -->",
      "<!-- aicr:open_problems=fp-sql -->",
      "",
      "Old content",
    ].join("\n");

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "aaa111",
      fetch: async (url, _init) => {
        if (url.includes("/issues?")) {
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

  it("updates without categorization when compare API fails", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const oldBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "<!-- aicr:commit=aaa111 -->",
      "<!-- aicr:open_problems=fp-sql,fp-perf -->",
      "",
      "Old content",
    ].join("\n");

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "bbb222",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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

  it("backward compatible with issue lacking commit marker", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const oldBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "",
      "Old content",
    ].join("\n");

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "newcommit",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const oldBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "<!-- aicr:commit=aaa111 -->",
      "<!-- aicr:open_problems=fp-sql,fp-perf -->",
      "",
      "Old content in unparsable format",
    ].join("\n");

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "bbb222",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const oldBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
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

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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
    const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
    const oldBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
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

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "bbb222",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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

describe("per_problem lifecycle file-scope guard", () => {
  const managedBodyWithFile = (file: string): string => [
    "<!-- aicr:managed=problem-issue -->",
    "<!-- aicr:channel=aicr-issues -->",
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
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
  const scopeFp = computeScopeFingerprint("aicr-issues", "owent", "example");
  const consolidatedBodyWithOpenProblems = (files: readonly { readonly fp: string; readonly file: string; readonly line: number; readonly category: string }[]): string => {
    const fps = files.map((f) => f.fp).join(",");
    const sections: string[] = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([
            {
              number: 99,
              title: "[AICR] Consolidated",
              body: [
                "<!-- aicr:managed=problem-issue -->",
                "<!-- aicr:consolidated=true -->",
                "<!-- aicr:channel=aicr-issues -->",
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
    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      token: "token-value",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([
            {
              number: 99,
              title: "[AICR] Consolidated",
              body: [
                "<!-- aicr:managed=problem-issue -->",
                "<!-- aicr:consolidated=true -->",
                "<!-- aicr:channel=aicr-issues -->",
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

describe("consolidated target-aware scope fingerprint", () => {
  const scopeArgs = ["aicr-issues", "owent", "example"] as const;

  it("scopes push per batch and PR per pull number", () => {
    const pushA = computeScopeFingerprint(...scopeArgs, { targetKind: "push", headSha: "aaa111" });
    const pushB = computeScopeFingerprint(...scopeArgs, { targetKind: "push", headSha: "bbb222" });
    const prNum7 = computeScopeFingerprint(...scopeArgs, { targetKind: "pull_request", pullNumber: 7 });
    const prNum8 = computeScopeFingerprint(...scopeArgs, { targetKind: "pull_request", pullNumber: 8 });
    const repoWide = computeScopeFingerprint(...scopeArgs);

    expect(pushA).not.toBe(pushB);
    expect(prNum7).not.toBe(prNum8);
    expect(prNum7).toBe(computeScopeFingerprint(...scopeArgs, { targetKind: "pull_request", pullNumber: 7, headSha: "ccc333" }));
    expect(repoWide).toBe(computeScopeFingerprint(...scopeArgs, { targetKind: "manual" }));
  });

  it("keeps separate push batches in separate issues", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const batch1Fp = computeScopeFingerprint("aicr-issues", "owent", "example", { targetKind: "push", headSha: "aaa111" });
    const batch1Body = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${batch1Fp} -->`,
      `<!-- aicr:commit=aaa111 -->`,
      `<!-- aicr:open_problems=fp-sql -->`,
      "",
      "Batch 1 content",
    ].join("\n");

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      targetKind: "push",
      headSha: "bbb222",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("state=open")) {
          return response([{ number: 42, title: "[AICR] batch1", body: batch1Body, state: "open" }]);
        }
        return response({ id: 43 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem], "Batch 2 summary");

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "created_consolidated" });
    expect(calls.filter((c) => c.init?.method === "PATCH")).toEqual([]);
    const postCalls = calls.filter((c) => c.init?.method === "POST" && c.url.endsWith("/issues"));
    expect(postCalls).toHaveLength(1);
    const batch2Fp = computeScopeFingerprint("aicr-issues", "owent", "example", { targetKind: "push", headSha: "bbb222" });
    const createdBody = JSON.parse(postCalls[0]?.init?.body ?? "{}");
    expect(createdBody.body).toContain(`<!-- aicr:scope_fingerprint=${batch2Fp} -->`);
  });

  it("keeps one PR issue stable across commits", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const prFp = computeScopeFingerprint("aicr-issues", "owent", "example", { targetKind: "pull_request", pullNumber: 7 });
    const commit1Body = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${prFp} -->`,
      `<!-- aicr:open_problems=fp-sql -->`,
      "",
      "Commit 1 content",
    ].join("\n");

    const dispatcher = createGiteaProblemIssueDispatcher({
      baseUrl: "https://gitea.example",
      owner: "owent",
      repo: "example",
      channelName: "aicr-issues",
      targetKind: "pull_request",
      pullNumber: 7,
      headSha: "bbb222",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("state=open")) {
          return response([{ number: 42, title: "[AICR] pr7", body: commit1Body, state: "open" }]);
        }
        return response({ id: 42 });
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
