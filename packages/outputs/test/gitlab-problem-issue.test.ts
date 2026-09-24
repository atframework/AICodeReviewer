import { describe, expect, it } from "vitest";

import {
  createGitlabProblemIssueDispatcher,
  computeScopeFingerprint,
  type FetchLike,
  type ReviewProblem,
} from "../src/index.js";

function response(
  body: unknown,
  status = 200,
  responseHeaders: Readonly<Record<string, string>> = {},
): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      get(name) {
        return responseHeaders[name.toLowerCase()] ?? null;
      },
    },
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

const PROJECT = "https://gitlab.example/api/v4/projects/group%2Fexample";

describe("createGitlabProblemIssueDispatcher", () => {
  it("creates one marked issue per new problem", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      token: "token-value",
      projectId: "group/example",
      issueMode: "per_problem",
      channelName: "aicr-issues",
      markerPrefix: "[AICR Test]",
      markerLabel: "aicr-managed",
      labels: ["aicr", "needs-triage"],
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1 ? response([]) : response({ id: 99, iid: 7 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem], "Summary text");

    expect(results).toHaveLength(1);
    expect(results[0]?.externalId).toBe("7");
    expect(calls[0]?.url).toBe(`${PROJECT}/issues?state=opened&order_by=updated_at&sort=desc&per_page=30&page=1`);
    expect(calls[1]?.url).toBe(`${PROJECT}/issues`);
    expect(calls[1]?.init?.headers).toMatchObject({ "private-token": "token-value" });
    const body = JSON.parse(calls[1]?.init?.body ?? "{}");
    expect(body.title).toBe("[AICR Test] [CRITICAL] src/auth.ts:12 · SQL query uses unsanitized input");
    expect(body.description).toContain("<!-- aicr:managed=problem-issue -->");
    expect(body.description).toContain("<!-- aicr:fingerprint=fp-sql -->");
    expect(body.description).toContain("Summary text");
    expect(body.labels).toBe("aicr,needs-triage");
  });

  it("does not duplicate an open managed issue with the same fingerprint", async () => {
    const calls: string[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      fetch: async (url) => {
        calls.push(url);
        return response([
          {
            iid: 7,
            title: "[AICR] [CRITICAL] security: src/auth.ts:12",
            description: managedBody.replace("fp-old", "fp-sql"),
            state: "opened",
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
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      channelName: "aicr-issues",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return response([
            {
              iid: 42,
              title: "[AICR] [HIGH] correctness: src/app.ts:1",
              description: managedBody,
              state: "opened",
            },
          ]);
        }
        return response({ id: calls.length });
      },
    });

    const results = await dispatcher.reconcileProblems([]);

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "closed", issueIid: 42 });
    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      `GET ${PROJECT}/issues?state=opened&order_by=updated_at&sort=desc&per_page=30&page=1`,
      `POST ${PROJECT}/issues/42/notes`,
      `PUT ${PROJECT}/issues/42`,
      `GET ${PROJECT}/issues/42`,
    ]);
    expect(JSON.parse(calls[2]?.init?.body ?? "{}")).toEqual({ state_event: "close" });
  });

  it("marks stale issues as resolved with a description rewrite", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      channelName: "aicr-issues",
      resolvedAction: "mark_resolved",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return response([
            {
              iid: 42,
              title: "[AICR] [HIGH] correctness: src/app.ts:1",
              description: managedBody,
              state: "opened",
            },
          ]);
        }
        return response({ id: calls.length });
      },
    });

    const results = await dispatcher.reconcileProblems([]);

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "mark_resolved", issueIid: 42 });
    const putBody = JSON.parse(calls[2]?.init?.body ?? "{}");
    expect(putBody.state_event).toBe("close");
    expect(putBody.description).toContain("Resolved");
    expect(putBody.description).toContain("<!-- aicr:managed=problem-issue -->");
  });

  it("deletes stale managed issues when configured", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      resolvedAction: "delete",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? response([{ iid: 42, title: "[AICR] stale", description: managedBody, state: "opened" }])
          : response({}, 204);
      },
    });

    const results = await dispatcher.reconcileProblems([]);

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "deleted", issueIid: 42 });
    expect(calls[1]?.url).toBe(`${PROJECT}/issues/42`);
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  it("paginates the managed issue window when the limit exceeds the GitLab page size", async () => {
    const calls: string[] = [];
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      iid: index + 1,
      title: `[AICR] p${index}`,
      description: managedBody.replace("fp-old", `fp-p${index}`),
      state: "opened",
    }));
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      maxRecentIssues: 150,
      resolvedAction: "delete",
      fetch: async (url) => {
        calls.push(url);
        if (url.includes("page=1")) {
          return response(pageOne);
        }
        if (url.includes("page=2")) {
          return response([{
            iid: 101,
            title: "[AICR] stale",
            description: managedBody,
            state: "opened",
          }]);
        }
        return response({}, 204);
      },
    });

    const results = await dispatcher.reconcileProblems([]);

    expect(calls[0]).toContain("per_page=100&page=1");
    expect(calls[1]).toContain("per_page=100&page=2");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => (r.raw as { action?: string }).action === "deleted")).toBe(true);
  });

  it("assigns the committer through the users API when configured", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      committerUsername: "committer-user",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?state=opened")) {
          return response([]);
        }
        if (url.includes("/api/v4/users?username=")) {
          return response([{ id: 77, username: "committer-user" }]);
        }
        return response({ id: 100, iid: 10 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem]);

    expect(results).toHaveLength(1);
    expect(calls.some((c) => c.url === "https://gitlab.example/api/v4/users?username=committer-user")).toBe(true);
    const create = calls.find((c) => c.url === `${PROJECT}/issues` && c.init?.method === "POST");
    // A single assignee goes through assignee_id: GitLab CE silently drops
    // the plural assignee_ids field (multiple assignees are Premium-only).
    expect(JSON.parse(create?.init?.body ?? "{}").assignee_id).toBe(77);
    expect(JSON.parse(create?.init?.body ?? "{}").assignee_ids).toBeUndefined();
  });

  it("drops the assignee when the users API finds no matching user", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      committerUsername: "not-a-user",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?state=opened")) {
          return response([]);
        }
        if (url.includes("/api/v4/users?username=")) {
          return response([]);
        }
        return response({ id: 100, iid: 10 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem]);

    expect(results).toHaveLength(1);
    const create = calls.find((c) => c.url === `${PROJECT}/issues` && c.init?.method === "POST");
    expect(JSON.parse(create?.init?.body ?? "{}").assignee_id).toBeUndefined();
    expect(JSON.parse(create?.init?.body ?? "{}").assignee_ids).toBeUndefined();
  });

  it("adds matched owners as assignees when configured", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const authProblem: ReviewProblem = {
      file: "src/auth/login.ts",
      line: 5,
      severity: "high",
      category: "correctness",
      message: "Missing null check.",
      fingerprint: "fp-auth",
    };
    const userIds: Record<string, number> = { "committer-user": 11, alice: 12, bob: 13 };
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
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
        if (url.includes("/issues?state=opened")) {
          return response([]);
        }
        if (url.includes("/api/v4/users?username=")) {
          const username = url.split("username=")[1] ?? "";
          const id = userIds[username];
          return response(id !== undefined ? [{ id, username }] : []);
        }
        return response({ id: 100, iid: 10 });
      },
    });

    const results = await dispatcher.reconcileProblems([authProblem]);

    expect(results).toHaveLength(1);
    const create = calls.find((c) => c.url === `${PROJECT}/issues` && c.init?.method === "POST");
    const assigneeIds = JSON.parse(create?.init?.body ?? "{}").assignee_ids as number[];
    expect(assigneeIds).toContain(11);
    expect(assigneeIds).toContain(12);
    expect(assigneeIds).toContain(13);
  });

  it("auto-creates severity labels and attaches them to issues", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      severityLabelPrefix: "aicr:problem:",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/labels?search=")) {
          return response([]);
        }
        if (url.endsWith("/labels") && init?.method === "POST") {
          return response({ id: 50, name: "aicr:problem:critical" });
        }
        if (url.includes("/issues?state=opened")) {
          return response([]);
        }
        return response({ id: 200, iid: 20 });
      },
    });

    await dispatcher.reconcileProblems([problem]);

    const labelCreate = calls.find((c) => c.url === `${PROJECT}/labels` && c.init?.method === "POST");
    expect(JSON.parse(labelCreate?.init?.body ?? "{}")).toMatchObject({ name: "aicr:problem:critical" });
    const issueBody = JSON.parse(
      calls.find((c) => c.url === `${PROJECT}/issues` && c.init?.method === "POST")?.init?.body ?? "{}",
    );
    expect(issueBody.labels).toBe("aicr:problem:critical");
  });

  it("reuses an existing severity label found by search", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      severityLabelPrefix: "aicr:problem:",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/labels?search=")) {
          return response([{ id: 51, name: "aicr:problem:critical" }]);
        }
        if (url.includes("/issues?state=opened")) {
          return response([]);
        }
        return response({ id: 200, iid: 20 });
      },
    });

    await dispatcher.reconcileProblems([problem]);

    expect(calls.some((c) => c.url === `${PROJECT}/labels` && c.init?.method === "POST")).toBe(false);
    const issueBody = JSON.parse(
      calls.find((c) => c.url === `${PROJECT}/issues` && c.init?.method === "POST")?.init?.body ?? "{}",
    );
    expect(issueBody.labels).toBe("aicr:problem:critical");
  });

  it("sends Feishu notification after creating an issue", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      issueMode: "per_problem",
      notifyFeishu: {
        webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
        secret: "test-secret",
      },
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?state=opened")) {
          return response([]);
        }
        if (url === `${PROJECT}/issues` && init?.method === "POST") {
          return response({ id: 300, iid: 30, web_url: "https://gitlab.example/group/example/-/issues/30" });
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
    expect(content).toContain("https://gitlab.example/group/example/-/issues/30");
    expect(body.sign).toBeDefined();
  });
});

describe("createGitlabProblemIssueDispatcher consolidated mode", () => {
  const problem2: ReviewProblem = {
    file: "src/utils.ts",
    line: 30,
    severity: "medium",
    category: "performance",
    message: "Inefficient loop detected.",
  };

  it("creates one consolidated issue with all problems", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      token: "token-value",
      projectId: "group/example",
      channelName: "aicr-issues",
      markerPrefix: "[AICR]",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([]);
        }
        return response({ id: 500, iid: 50 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem, problem2], "Review summary");

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "created_consolidated" });

    const body = JSON.parse(
      calls.find((c) => c.url === `${PROJECT}/issues` && c.init?.method === "POST")?.init?.body ?? "{}",
    );
    expect(body.title).toBe("[AICR] [CRITICAL] 2 problems · SQL query uses unsanitized input");
    expect(body.description).toContain("<!-- aicr:consolidated=true -->");
    expect(body.description).toContain("<!-- aicr:scope_fingerprint=");
    expect(body.description).toContain("SQL query uses unsanitized input");
    expect(body.description).toContain("Inefficient loop detected");
    expect(body.description).toContain("Review summary");
  });

  it("updates existing consolidated issue on re-analysis", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const scopeFp = computeScopeFingerprint("aicr-issues", "group/example", "");
    const consolidatedBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "",
      "Old content",
    ].join("\n");

    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([{
            iid: 42,
            title: "[AICR] Code Review Report ...",
            description: consolidatedBody,
            state: "opened",
          }]);
        }
        return response({ id: 42, iid: 42 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem], "New summary");

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "updated_consolidated", issueIid: 42 });

    const putCall = calls.find((c) => c.init?.method === "PUT");
    expect(putCall).toBeDefined();
    expect(putCall?.url).toBe(`${PROJECT}/issues/42`);
    const body = JSON.parse(putCall?.init?.body ?? "{}");
    expect(body.title).toBe("[AICR] [CRITICAL] src/auth.ts:12 · SQL query uses unsanitized input");
    expect(body.description).toContain("New summary");
    expect(body.description).toContain("SQL query uses unsanitized input");
  });

  it("closes consolidated issue when no problems found", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const scopeFp = computeScopeFingerprint("aicr-issues", "group/example", "");
    const consolidatedBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "",
      "Old content",
    ].join("\n");

    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([{
            iid: 42,
            title: "[AICR] Code Review Report ...",
            description: consolidatedBody,
            state: "opened",
          }]);
        }
        return response({ id: 1 });
      },
    });

    const results = await dispatcher.reconcileProblems([]);

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "closed", issueIid: 42 });
  });

  it("shows resolved section when new commit drops some problems", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const scopeFp = computeScopeFingerprint("aicr-issues", "group/example", "");
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

    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "bbb222",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([{
            iid: 42,
            title: "[AICR] Code Review Report ...",
            description: oldBody,
            state: "opened",
          }]);
        }
        if (url.includes("/repository/merge_base")) {
          return response({ id: "aaa111" });
        }
        return response({ id: 42, iid: 42 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem], "Updated summary");

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "updated_consolidated", issueIid: 42 });

    const mergeBaseCall = calls.find((c) => c.url.includes("/repository/merge_base"));
    expect(mergeBaseCall?.url).toContain(encodeURIComponent("refs[]"));
    const putCall = calls.find((c) => c.init?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall?.init?.body ?? "{}");
    expect(body.description).toContain("Resolved");
    expect(body.description).toContain("performance");
    expect(body.description).toContain("src/utils.ts:30");
    expect(body.description).toContain("<!-- aicr:commit=bbb222 -->");
    expect(body.description).toContain("SQL query uses unsanitized input");
  });

  it("skips update when current commit is behind stored commit", async () => {
    const scopeFp = computeScopeFingerprint("aicr-issues", "group/example", "");
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

    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "aaa111",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([{
            iid: 42,
            title: "[AICR] ...",
            description: oldBody,
            state: "opened",
          }]);
        }
        if (url.includes("/repository/merge_base")) {
          return response({ id: "aaa111" });
        }
        return response({ id: 42, iid: 42 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem], "Behind update");

    expect(results).toEqual([]);
    expect(calls.some((c) => c.init?.method === "PUT")).toBe(false);
  });

  it("updates without categorization when merge_base lookup fails", async () => {
    const scopeFp = computeScopeFingerprint("aicr-issues", "group/example", "");
    const oldBody = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${scopeFp} -->`,
      "<!-- aicr:commit=aaa111 -->",
      "<!-- aicr:open_problems=fp-sql -->",
      "",
      "Old content",
    ].join("\n");

    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: "bbb222",
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([{
            iid: 42,
            title: "[AICR] ...",
            description: oldBody,
            state: "opened",
          }]);
        }
        if (url.includes("/repository/merge_base")) {
          return response({ message: "404 Not Found" }, 404);
        }
        return response({ id: 42, iid: 42 });
      },
    });

    const results = await dispatcher.reconcileProblems([problem], "Fallback update");

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "updated_consolidated", issueIid: 42 });
    const putCall = calls.find((c) => c.init?.method === "PUT");
    const body = JSON.parse(putCall?.init?.body ?? "{}");
    expect(body.description).toContain("Fallback update");
    expect(body.description).not.toContain("Resolved");
  });
});

describe("createGitlabProblemIssueDispatcher empty-review analyzer reconciliation", () => {
  const oldHeadSha = "a".repeat(40);
  const newHeadSha = "b".repeat(40);
  const oldScopeFp = computeScopeFingerprint("aicr-issues", "group/example", "", { targetKind: "push", headSha: oldHeadSha });

  function buildStoredConsolidatedBody(
    entries: readonly { readonly fp: string; readonly file: string; readonly line: number; readonly category: string; readonly severity: string }[],
  ): string {
    const sections = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:consolidated=true -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      `<!-- aicr:scope_fingerprint=${oldScopeFp} -->`,
      `<!-- aicr:commit=${oldHeadSha} -->`,
      `<!-- aicr:open_problems=${entries.map((entry) => entry.fp).join(",")} -->`,
      "",
    ];
    for (const entry of entries) {
      sections.push(
        `#### ${entry.severity.toUpperCase()} (1)`,
        "",
        `**${entry.category}** — \`${entry.file}:${entry.line}\` <!-- aicr:fp=${entry.fp} -->`,
        "",
        "Old problem description.",
        "",
      );
    }
    return sections.join("\n");
  }

  it("closes an older scope during an empty review when the analyzer approves uncovered findings", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const analyzedFingerprints: string[][] = [];
    const oldBody = buildStoredConsolidatedBody([
      { fp: "fp-uncovered", file: "src/uncovered.ts", line: 20, category: "security", severity: "high" },
      { fp: "fp-reviewed", file: "src/reviewed.ts", line: 30, category: "bug", severity: "medium" },
    ]);
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      channelName: "aicr-issues",
      issueMode: "consolidated",
      headSha: newHeadSha,
      targetKind: "push",
      resolvedAction: "close",
      resolutionAnalyzer: async (candidates) => {
        analyzedFingerprints.push(candidates.map((candidate) => candidate.fingerprint!));
        return new Set(candidates.map((candidate) => candidate.fingerprint!));
      },
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([{ iid: 42, title: "[AICR] Old", description: oldBody, state: "opened" }]);
        }
        if (url.includes("/repository/merge_base")) {
          return response({ id: oldHeadSha });
        }
        return response({ id: 42, iid: 42 });
      },
    });

    const results = await dispatcher.reconcileProblems([], undefined, { reviewedFiles: ["src/reviewed.ts"] });

    expect(analyzedFingerprints).toHaveLength(1);
    expect([...analyzedFingerprints[0]!].sort()).toEqual(["fp-reviewed", "fp-uncovered"]);
    const closeCall = calls.find(
      (c) => c.url === `${PROJECT}/issues/42` && c.init?.method === "PUT" && JSON.parse(c.init.body ?? "{}").state_event === "close",
    );
    expect(closeCall).toBeDefined();
    expect(results.some((r) => r.raw && typeof r.raw === "object" && (r.raw as Record<string, unknown>).action === "closed")).toBe(true);
  });

  it("closes a per-problem issue outside the reviewed scope when the analyzer approves it", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const analyzed: ReviewProblem[][] = [];
    const body = [
      "<!-- aicr:managed=problem-issue -->",
      "<!-- aicr:channel=aicr-issues -->",
      "<!-- aicr:label=aicr-managed -->",
      "<!-- aicr:fingerprint=fp-old -->",
      "<!-- aicr:file=src/uncovered.ts -->",
      "",
      "**HIGH · correctness**",
      "",
      "Some old problem.",
      "",
      "Location: `src/uncovered.ts:42`",
    ].join("\n");
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: "https://gitlab.example",
      projectId: "group/example",
      channelName: "aicr-issues",
      issueMode: "per_problem",
      resolvedAction: "close",
      resolutionAnalyzer: async (candidates) => {
        analyzed.push([...candidates]);
        return new Set(candidates.map((candidate) => candidate.fingerprint!));
      },
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url.includes("/issues?")) {
          return response([{ iid: 42, title: "[AICR] [HIGH] correctness: src/uncovered.ts:42", description: body, state: "opened" }]);
        }
        return response({ id: 42, iid: 42 });
      },
    });

    const results = await dispatcher.reconcileProblems([], undefined, { reviewedFiles: ["src/reviewed.ts"] });

    expect(analyzed).toHaveLength(1);
    expect(analyzed[0]?.[0]?.fingerprint).toBe("fp-old");
    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "closed", issueIid: 42 });
  });
});
