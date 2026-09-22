import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createGiteaProblemIssueDispatcher,
  type FetchLike,
  type GiteaProblemIssueOptions,
  type ReviewProblem,
} from "../src/index.js";

const baseUrl = process.env.AICR_GITEA_TEST_URL;
const token = process.env.AICR_GITEA_TEST_TOKEN;
const enabled = Boolean(baseUrl || token);

type User = { login: string; email: string; password: string; token: string };
type Issue = { number: number; assignees: { login: string }[] | null };
const problem: ReviewProblem = {
  file: "src/app.ts", line: 1, severity: "high", category: "correctness",
  message: "Acceptance fixture boundary check.", fingerprint: "live-boundary",
};

describe.skipIf(!enabled)("Gitea assignment with a disposable real service", () => {
  const users: User[] = [];
  const repos: string[] = [];
  let owner: User;
  let author: User;
  let reader: User;

  async function api(path: string, method = "GET", body?: unknown, auth = token): Promise<Response> {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method, headers: { authorization: `token ${auth}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    return response;
  }

  beforeAll(async () => {
    if (!baseUrl || !token) throw new Error("Set both AICR_GITEA_TEST_URL and AICR_GITEA_TEST_TOKEN");
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new Error("Live fixture requires a disposable loopback HTTP Gitea instance");
    }
    for (const role of ["owner", "author", "reader"]) {
      const login = `aicr-${role}-${randomUUID().slice(0, 8)}`;
      const user = { login, email: `${login}@example.invalid`, password: randomBytes(24).toString("hex"), token: "" };
      // Register ownership before mutation so cleanup also handles a lost response.
      users.push(user);
      await api("/admin/users", "POST", {
        username: login, email: user.email, password: user.password, must_change_password: false,
      });
      const response = await fetch(`${baseUrl}/api/v1/users/${login}/tokens`, {
        method: "POST", headers: {
          authorization: `Basic ${Buffer.from(`${login}:${user.password}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "acceptance", scopes: ["all"] }),
        signal: AbortSignal.timeout(10000),
      });
      expect(response.status).toBe(201);
      user.token = (await response.json() as { sha1: string }).sha1;
    }
    [owner, author, reader] = users as [User, User, User];
  });

  afterAll(async () => {
    const failures: string[] = [];
    for (const repo of repos) {
      try { await api(`/repos/${users[0]!.login}/${repo}`, "DELETE"); }
      catch { failures.push(repo); }
    }
    for (const user of [...users].reverse()) {
      try { await api(`/admin/users/${user.login}`, "DELETE"); }
      catch { failures.push(user.login); }
    }
    expect(failures, "fixture cleanup failures").toEqual([]);
  });

  async function fixture(linked = true) {
    const repo = `acceptance-${randomUUID()}`;
    repos.push(repo);
    await api("/user/repos", "POST", { name: repo, private: true, auto_init: true }, owner.token);
    const path = `/repos/${owner.login}/${repo}`;
    await api(`${path}/collaborators/${author.login}`, "PUT", { permission: "write" }, owner.token);
    await api(`${path}/collaborators/${reader.login}`, "PUT", { permission: "read" }, owner.token);
    const created = await (await api(`${path}/contents/src/app.ts`, "POST", {
      content: Buffer.from("export const value = 1;\n").toString("base64"), message: "Acceptance fixture",
      author: { name: "Display name is not a login", email: linked ? author.email : "unlinked@example.invalid" },
    }, owner.token)).json() as { commit: { sha: string } };
    return { repo, path, headSha: created.commit.sha };
  }

  async function publish(
    current: Awaited<ReturnType<typeof fixture>>,
    options: Partial<GiteaProblemIssueOptions> = {},
  ) {
    const calls: { method: string; url: string; status: number }[] = [];
    const request: FetchLike = async (url, init) => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
      calls.push({ method: init?.method ?? "GET", url, status: response.status });
      return response;
    };
    const result = await createGiteaProblemIssueDispatcher({
      baseUrl: baseUrl!, token: owner.token, owner: owner.login, repo: current.repo,
      headSha: current.headSha, targetKind: "push", resolvedAction: "none", fetch: request, ...options,
    }).reconcileProblems([problem], "Local acceptance report");
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("published");
    // Read persisted platform state, not merely the sent request or HTTP 201.
    const issues = await (await api(`${current.path}/issues?state=open&type=issues`, "GET", undefined, owner.token)).json() as Issue[];
    expect(issues).toHaveLength(1);
    return { calls, assignees: (issues[0]!.assignees ?? []).map((user) => user.login) };
  }

  it.each(["consolidated", "per_commit", "per_problem"] as const)("assigns the linked commit author in %s mode", async (issueMode) => {
    const f = await fixture();
    const commit = await (await api(`${f.path}/git/commits/${f.headSha}`)).json() as { author: { login: string } };
    expect(commit.author.login).toBe(author.login);
    const result = await publish(f, { issueMode });
    expect(result.assignees).toEqual([author.login]);
    expect(result.calls.filter((call) => call.url.includes("/git/commits/"))).toHaveLength(1);
  });

  it("leaves an unlinked email unassigned", async () => {
    const f = await fixture(false);
    const commit = await (await api(`${f.path}/git/commits/${f.headSha}`)).json() as { author: unknown };
    expect(commit.author).toBeNull();
    expect((await publish(f)).assignees).toEqual([]);
  });

  it("does not treat successful creation by a read-only collaborator as assignment", async () => {
    const result = await publish(await fixture(), { token: reader.token, committerUsername: author.login });
    expect(result.assignees).toEqual([]);
    expect(result.calls.filter((call) => call.method === "POST").map((call) => call.status)).toEqual([201]);
  });

  it("retries a nonexistent assignee once without assignment", async () => {
    const result = await publish(await fixture(), { committerUsername: `missing-${randomUUID()}` });
    expect(result.assignees).toEqual([]);
    expect(result.calls.filter((call) => call.method === "POST").map((call) => call.status)).toEqual([422, 201]);
  });

  it("retries an existing user without repository access once without assignment", async () => {
    const f = await fixture();
    await api(`${f.path}/collaborators/${author.login}`, "DELETE", undefined, owner.token);
    const result = await publish(f, { committerUsername: author.login });
    expect(result.assignees).toEqual([]);
    expect(result.calls.filter((call) => call.method === "POST").map((call) => call.status)).toEqual([422, 201]);
  });
});
