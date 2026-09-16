import { describe, expect, it } from "vitest";

import {
  createGithubProblemIssueDispatcher,
  createGiteaProblemIssueDispatcher,
  type FetchLike,
  type ReviewProblem,
} from "../src/index.js";

const problem: ReviewProblem = {
  file: "src/app.ts", line: 8, severity: "high", category: "correctness",
  message: "Missing boundary check.", fingerprint: "boundary",
};
const problems = [problem, { ...problem, line: 20, fingerprint: "second-boundary" }];

function response(body: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
  return { ok: status >= 200 && status < 300, status, statusText: String(status),
    json: async () => body, text: async () => JSON.stringify(body) };
}

describe.each([
  { platform: "GitHub", create: createGithubProblemIssueDispatcher, repoPath: "https://git.example/api/v3/repos/org/repo", commits: "commits" },
  { platform: "Gitea", create: createGiteaProblemIssueDispatcher, repoPath: "https://git.example/api/v1/repos/org/repo", commits: "git/commits" },
])("$platform managed issue assignment contract", ({ platform, create, repoPath, commits }) => {
  const options = { owner: "org", repo: "repo", token: "test-token",
    baseUrl: platform === "GitHub" ? "https://git.example/api/v3" : "https://git.example",
    headSha: "refs/heads/feature", targetKind: "push" };
  const commitUrl = `${repoPath}/${commits}/refs%2Fheads%2Ffeature`;
  type Call = { url: string; init: Parameters<FetchLike>[1] };

  function harness(commit: () => ReturnType<FetchLike>, post?: (body: Record<string, unknown>) => ReturnType<FetchLike>) {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith(`${repoPath}/issues?`)) return response([]);
      if (url === commitUrl && init?.method === "GET") return commit();
      if (url === `${repoPath}/issues` && init?.method === "POST") {
        return post ? post(JSON.parse(init.body!)) : response({ id: calls.length, number: calls.length });
      }
      throw new Error(`Unexpected request ${init?.method} ${url}`);
    };
    return { fetch, calls, posts: () => calls.filter((call) => call.init?.method === "POST"),
      lookups: () => calls.filter((call) => call.url.includes("/commits/")) };
  }

  it.each(["consolidated", "per_commit", "per_problem"] as const)("assigns the linked author in %s mode and caches across problems", async (issueMode) => {
    const h = harness(async () => response({ author: { login: "author" }, committer: { login: "merge-bot" } }));
    const dispatcher = create({ ...options, issueMode, fetch: h.fetch, fallbackCommitterUsername: "pusher" });
    await dispatcher.reconcileProblems(problems);
    expect(h.lookups()).toHaveLength(1);
    expect(h.lookups()[0]?.url).toBe(commitUrl);
    expect(h.lookups()[0]?.init?.headers?.authorization).toBe(platform === "GitHub" ? "Bearer test-token" : "token test-token");
    expect(h.posts()).toHaveLength(issueMode === "per_problem" ? 2 : 1);
    for (const call of h.posts()) expect(JSON.parse(call.init!.body!).assignees).toEqual(["author"]);
  });

  it.each([
    { name: "null author", commit: async () => response({ author: null, committer: { login: "bot" } }) },
    { name: "absent author", commit: async () => response({}) },
    { name: "git display name", commit: async () => response({ author: { name: "Not A Login" } }) },
    { name: "empty login", commit: async () => response({ author: { login: "  " } }) },
    { name: "invalid login type", commit: async () => response({ author: { login: 123 } }) },
    { name: "not found", commit: async () => response({ message: "not found" }, 404) },
    { name: "server error", commit: async () => response({}, 503) },
    { name: "network error", commit: async () => { throw new Error("connection lost"); } },
    { name: "invalid JSON", commit: async () => ({ ...response({}), json: async () => { throw new SyntaxError("invalid JSON"); } }) },
  ])("uses the pusher only after $name and caches the miss", async ({ commit }) => {
    const h = harness(commit);
    await create({ ...options, issueMode: "per_problem", fetch: h.fetch, fallbackCommitterUsername: "pusher" }).reconcileProblems(problems);
    expect(h.lookups()).toHaveLength(1);
    expect(h.posts()).toHaveLength(2);
    for (const call of h.posts()) expect(JSON.parse(call.init!.body!).assignees).toEqual(["pusher"]);
  });

  it.each([
    { name: "disabled", assignCommitter: false, committerUsername: "author", expected: ["owner"] },
    { name: "known author", assignCommitter: true, committerUsername: "owner", expected: ["owner"] },
  ])("skips lookup for $name while retaining and deduplicating OWNERS", async ({ assignCommitter, committerUsername, expected }) => {
    const h = harness(async () => { throw new Error("unexpected lookup"); });
    await create({ ...options, fetch: h.fetch, assignCommitter, committerUsername,
      fallbackCommitterUsername: "pusher", addOwnersAsAssignees: true,
      ownersContent: "reviewers:\n  - owner\n" }).reconcileProblems(problems);
    expect(h.lookups()).toHaveLength(0);
    expect(h.posts()).toHaveLength(1);
    expect(JSON.parse(h.posts()[0]!.init!.body!).assignees).toEqual(expected);
  });

  it("uses the fallback without a SHA and does not query on empty reviews", async () => {
    const h = harness(async () => { throw new Error("unexpected lookup"); });
    const { headSha: _headSha, ...withoutSha } = options;
    await create({ ...withoutSha, fetch: h.fetch, fallbackCommitterUsername: "pusher" }).reconcileProblems([problem]);
    await create({ ...options, fetch: h.fetch }).reconcileProblems([]);
    expect(h.lookups()).toHaveLength(0);
    expect(h.posts()).toHaveLength(1);
    expect(JSON.parse(h.posts()[0]!.init!.body!).assignees).toEqual(["pusher"]);
  });

  it("does not look up or change assignees on an existing managed issue", async () => {
    const h = harness(async () => response({ author: { login: "author" } }));
    await create({ ...options, issueMode: "per_problem", fetch: h.fetch }).reconcileProblems([problem]);
    const body = JSON.parse(h.posts()[0]!.init!.body!);
    const calls: Call[] = [];
    await create({ ...options, issueMode: "per_problem", fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith(`${repoPath}/issues?`)) return response([{ ...body, number: 1, state: "open" }]);
      throw new Error(`Unexpected request ${url}`);
    } }).reconcileProblems([problem]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("shares an in-flight lookup so concurrent creates both retain the author", async () => {
    let finish!: (value: Awaited<ReturnType<FetchLike>>) => void;
    const pending = new Promise<Awaited<ReturnType<FetchLike>>>((resolve) => { finish = resolve; });
    const h = harness(() => pending);
    const dispatcher = create({ ...options, fetch: h.fetch, issueMode: "per_problem" });
    const first = dispatcher.reconcileProblems([problem]);
    const second = dispatcher.reconcileProblems([problems[1]!]);
    await expect.poll(() => h.lookups().length).toBe(1);
    finish(response({ author: { login: "author" } }));
    await Promise.all([first, second]);
    expect(h.lookups()).toHaveLength(1);
    expect(h.posts()).toHaveLength(2);
    for (const call of h.posts()) expect(JSON.parse(call.init!.body!).assignees).toEqual(["author"]);
  });

  const assignmentError = platform === "GitHub"
    ? { message: "Validation Failed", errors: [{ resource: "Issue", field: "assignees", code: "invalid" }] }
    : { message: "Assignee does not exist: [name: missing]" };

  it.each(["consolidated", "per_commit", "per_problem"] as const)("retries only assignment rejection in %s mode, preserving the issue body", async (issueMode) => {
    const h = harness(async () => response({}), async (body) => body.assignees ? response(assignmentError, 422) : response({ id: 1 }));
    await create({ ...options, issueMode, fetch: h.fetch, committerUsername: "missing" }).reconcileProblems([problem], "Summary");
    expect(h.posts()).toHaveLength(2);
    const first = JSON.parse(h.posts()[0]!.init!.body!);
    const retry = JSON.parse(h.posts()[1]!.init!.body!);
    expect(first.assignees).toEqual(["missing"]);
    delete first.assignees;
    expect(retry).toEqual(first);
  });

  it.each([
    ...[400, 401, 403, 404, 409, 410, 429, 500, 503].map((status) => ({ name: `HTTP ${status}`, reply: () => Promise.resolve(response(assignmentError, status)) })),
    { name: "unrelated validation", reply: async () => response({ errors: [{ field: "title" }] }, 422) },
    { name: "mixed validation", reply: async () => response({ errors: [{ field: "assignees" }, { field: "labels" }] }, 422) },
    { name: "spam rejection", reply: async () => response({ message: "Validation failed, or the endpoint has been spammed." }, 422) },
    { name: "malformed validation", reply: async () => ({ ...response(null, 422), text: async () => "not JSON" }) },
    { name: "null validation", reply: async () => response(null, 422) },
    { name: "lost POST response", reply: async () => { throw new Error("socket reset after write"); } },
    { name: "unreadable successful POST response", reply: async () => ({ ...response({}, 201), json: async () => { throw new SyntaxError("invalid JSON"); } }) },
  ])("does not retry $name", async ({ reply }) => {
    const h = harness(async () => response({}), reply);
    await expect(create({ ...options, fetch: h.fetch, committerUsername: "author" }).reconcileProblems([problem])).rejects.toThrow();
    expect(h.posts()).toHaveLength(1);
  });

  it("propagates a failed fallback without a third POST", async () => {
    const h = harness(async () => response({}), async () => response(assignmentError, 422));
    await expect(create({ ...options, fetch: h.fetch, committerUsername: "missing" }).reconcileProblems([problem])).rejects.toMatchObject({ status: 422 });
    expect(h.posts()).toHaveLength(2);
  });

  it("never retries a rejection when no assignees were sent", async () => {
    const h = harness(async () => response({}), async () => response(assignmentError, 422));
    await expect(create({ ...options, fetch: h.fetch, assignCommitter: false }).reconcileProblems([problem])).rejects.toMatchObject({ status: 422 });
    expect(h.posts()).toHaveLength(1);
  });
});
