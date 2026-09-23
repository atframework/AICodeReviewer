import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createGitlabProblemIssueDispatcher,
  type FetchLike,
  type GitlabProblemIssueOptions,
  type ReviewProblem,
} from "../src/index.js";

const baseUrl = process.env.AICR_GITLAB_TEST_URL;
const token = process.env.AICR_GITLAB_TEST_TOKEN;
const enabled = Boolean(baseUrl || token);

type User = { id: number; username: string; email: string };
type Issue = {
  iid: number;
  state: string;
  labels: string[];
  assignees: { username: string }[] | null;
};

const problem: ReviewProblem = {
  file: "src/app.ts", line: 1, severity: "high", category: "correctness",
  message: "Acceptance fixture boundary check.", fingerprint: "live-boundary",
};

describe.skipIf(!enabled)("GitLab problem issues with a disposable real service", () => {
  let author: User;
  let authorToken: string;
  const projects: number[] = [];

  async function api(path: string, method = "GET", body?: unknown): Promise<Response> {
    const response = await fetch(`${baseUrl}/api/v4${path}`, {
      method, headers: { "PRIVATE-TOKEN": token!, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
    return response;
  }

  beforeAll(async () => {
    if (!baseUrl || !token) throw new Error("Set both AICR_GITLAB_TEST_URL and AICR_GITLAB_TEST_TOKEN");
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      throw new Error("Live fixture requires a disposable loopback HTTP GitLab instance");
    }
    const username = `aicr-author-${randomUUID().slice(0, 8)}`;
    const created = await (await api("/users", "POST", {
      username, email: `${username}@example.invalid`, name: username,
      password: randomBytes(24).toString("hex"), skip_confirmation: true,
    })).json() as { id: number };
    author = { id: created.id, username, email: `${username}@example.invalid` };
    // Impersonation token used to probe read_project as the author (see fixture()).
    authorToken = (await (await api(`/users/${author.id}/impersonation_tokens`, "POST", {
      name: `aicr-${randomUUID().slice(0, 8)}`, scopes: ["read_api"],
      expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    })).json() as { token: string }).token;
  });

  afterAll(async () => {
    const failures: string[] = [];
    for (const id of projects) {
      try { await api(`/projects/${id}`, "DELETE"); }
      catch { failures.push(String(id)); }
    }
    if (author) {
      try { await api(`/users/${author.id}`, "DELETE"); }
      catch { failures.push(author.username); }
    }
    expect(failures, "fixture cleanup failures").toEqual([]);
  });

  async function fixture() {
    const name = `acceptance-${randomUUID().slice(0, 8)}`;
    const project = await (await api("/projects", "POST", {
      name, visibility: "private", initialize_with_readme: true,
    })).json() as { id: number; path_with_namespace: string };
    projects.push(project.id);
    // GitLab only assigns project members; non-member ids are silently dropped.
    await api(`/projects/${project.id}/members`, "POST", { user_id: author.id, access_level: 30 });
    // The member row is committed synchronously, but the assignee permission
    // check (ProjectTeam#member? -> project_authorizations) is populated
    // asynchronously by AuthorizedProjectsWorker; on a busy instance an issue
    // created in that gap silently loses its assignee. Poll as the author
    // until read_project is granted before publishing.
    const deadline = Date.now() + 60000;
    for (;;) {
      const probe = await fetch(`${baseUrl}/api/v4/projects/${project.id}`, {
        headers: { "PRIVATE-TOKEN": authorToken }, signal: AbortSignal.timeout(30000),
      });
      if (probe.status === 200) break;
      if (Date.now() > deadline) throw new Error(`authorization propagation timed out; probe=${probe.status}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await api(`/projects/${project.id}/repository/files/${encodeURIComponent("src/app.ts")}`, "POST", {
      branch: "main", content: "export const value = 1;\n", commit_message: "Acceptance fixture",
      author_name: author.username, author_email: author.email,
    });
    return { id: project.id, path: project.path_with_namespace };
  }

  interface CapturedCall { url: string; method: string | undefined; body: string | undefined; status: number }

  async function publish(
    projectId: number,
    options: Partial<GitlabProblemIssueOptions> = {},
  ): Promise<{ issues: readonly Issue[]; calls: CapturedCall[] }> {
    const calls: CapturedCall[] = [];
    const request: FetchLike = async (url, init) => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      calls.push({
        url: String(url), method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined, status: response.status,
      });
      return response;
    };
    const result = await createGitlabProblemIssueDispatcher({
      baseUrl: baseUrl!, token: token!, projectId,
      resolvedAction: "none", fetch: request, ...options,
    }).reconcileProblems([problem], "Local acceptance report");
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("published");
    // Read persisted platform state, not merely the sent request or HTTP 201.
    const issues = await (await api(`/projects/${projectId}/issues?state=opened`)).json() as Issue[];
    return { issues, calls };
  }

  // Cold-boot GitLab is slow: each fixture round-trips several API calls, so
  // every test gets a generous timeout instead of the 5s default.
  it.each(["consolidated", "per_commit", "per_problem"] as const)("assigns the committer username in %s mode", { timeout: 60000 }, async (issueMode) => {
    const f = await fixture();
    const { issues, calls } = await publish(f.id, { issueMode, committerUsername: author.username });
    expect(issues).toHaveLength(1);
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith(`/api/v4/projects/${f.id}/issues`));
    // The request must carry the singular assignee_id (CE drops assignee_ids).
    expect(create?.body ? JSON.parse(create.body).assignee_id : undefined).toBe(author.id);
    const assignees = (issues[0]!.assignees ?? []).map((user) => user.username);
    if (assignees.length === 0) {
      const members = await (await api(`/projects/${f.id}/members`)).json();
      const raw = await (await api(`/projects/${f.id}/issues/${issues[0]!.iid}`)).json();
      throw new Error(`assignee missing; members=${JSON.stringify(members)} issue=${JSON.stringify(raw).slice(0, 800)} calls=${JSON.stringify(calls)}`);
    }
    expect(assignees).toEqual([author.username]);
  });

  it("creates and attaches severity labels on the real project", { timeout: 60000 }, async () => {
    const f = await fixture();
    const { issues } = await publish(f.id, { severityLabelPrefix: "aicr:problem:" });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.labels).toContain("aicr:problem:high");
  });

  it("drops an unknown committer username instead of failing", { timeout: 60000 }, async () => {
    const f = await fixture();
    const { issues } = await publish(f.id, { committerUsername: `missing-${randomUUID()}` });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.assignees ?? []).toEqual([]);
  });

  it("closes the consolidated issue through state_event when problems clear", { timeout: 60000 }, async () => {
    const f = await fixture();
    const request: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    const dispatcher = createGitlabProblemIssueDispatcher({
      baseUrl: baseUrl!, token: token!, projectId: f.id, issueMode: "consolidated",
      resolvedAction: "close", fetch: request,
    });
    await dispatcher.reconcileProblems([problem], "First pass");
    await dispatcher.reconcileProblems([], "Second pass");
    const issues = await (await api(`/projects/${f.id}/issues?state=closed`)).json() as Issue[];
    expect(issues).toHaveLength(1);
    expect(issues[0]!.state).toBe("closed");
  });
});
