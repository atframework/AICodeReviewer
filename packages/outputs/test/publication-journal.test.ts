import type { RemotePublicationOperation } from "@aicr/core";
import { describe, expect, it, vi } from "vitest";

import {
  createGithubIssueDispatcher, createGiteaIssueDispatcher, createGithubProblemIssueDispatcher,
  createGiteaProblemIssueDispatcher, createGithubPullRequestReviewDispatcher,
  createGiteaPullRequestReviewDispatcher, createGitlabMergeRequestReviewDispatcher,
  createFeishuBotDispatcher, createWeComBotDispatcher, FeishuAppClient,
  type FetchLike, type ResponseLike, type ReviewProblem,
} from "../src/index.js";
import { PublicationJournal, publicationFetch, validateRemotePublicationOperations } from "../src/publication-journal.js";

const problem: ReviewProblem = { file: "a.ts", line: 1, severity: "high", category: "bug", message: "Unsafe access", fingerprint: "p1" };
const reply = (raw: unknown, status = 200, headers?: Record<string, string>): ResponseLike => ({
  ok: status >= 200 && status < 300, status, statusText: "test",
  ...(headers ? { headers: { get: (key: string) => headers[key] ?? null } } : {}),
  json: async () => raw, text: async () => JSON.stringify(raw),
});

function fixture() {
  let saved: readonly RemotePublicationOperation[] = [];
  let time = 1000;
  const save = vi.fn(async (ops: readonly RemotePublicationOperation[]) => { saved = structuredClone(ops); });
  const journal = (batchId = "batch") => new PublicationJournal({ batchId, operations: saved, save, now: () => time });
  return { journal, save, saved: () => saved, time: (value: number) => { time = value; } };
}

describe("remote publication journal", () => {
  const publishers = {
    github_issue: (fetch: FetchLike) => () => createGithubIssueDispatcher({ owner: "o", repo: "r", issueNumber: 1, fetch }).publishAggregatedProblems([problem], "report"),
    gitea_issue: (fetch: FetchLike) => () => createGiteaIssueDispatcher({ baseUrl: "https://git.test", owner: "o", repo: "r", issueNumber: 1, fetch }).publishAggregatedProblems([problem], "report"),
    github_pr: (fetch: FetchLike) => () => createGithubPullRequestReviewDispatcher({ owner: "o", repo: "r", pullNumber: 1, reviewUpdateStrategy: "always_new", fetch }).publishSummary!("report", [problem]),
    gitea_pr: (fetch: FetchLike) => () => createGiteaPullRequestReviewDispatcher({ baseUrl: "https://git.test", owner: "o", repo: "r", pullNumber: 1, reviewUpdateStrategy: "always_new", fetch }).publishSummary!("report", [problem]),
    gitlab_note: (fetch: FetchLike) => () => createGitlabMergeRequestReviewDispatcher({ projectId: "org/repo", mergeRequestIid: 1, fetch }).publishSummary!("report"),
    gitlab_discussion: (fetch: FetchLike) => () => createGitlabMergeRequestReviewDispatcher({ projectId: "org/repo", mergeRequestIid: 1, baseSha: "base", headSha: "head", fetch }).publishProblem(problem),
  };
  it.each(Object.entries(publishers))("%s reconciles a committed write with a lost response across a new journal", async (_kind, factory) => {
    const f = fixture();
    const records: unknown[] = [];
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body!);
        records.push(url.endsWith("/discussions") ? { id: "thread1", notes: [{ id: 1, body: body.body }] } : { id: 1, html_url: "https://git.test/report", body: body.body });
        throw new Error("connection reset after commit");
      }
      return reply(records);
    });
    await expect(f.journal().run("out", "summary:0", factory(fetch))).rejects.toThrow();
    expect(f.saved()[0]).toMatchObject({ status: "unknown", attempts: 1 });
    const result = await f.journal().run("out", "summary:0", factory(fetch));
    expect(result.status).toBe("published");
    expect(records).toHaveLength(1);
    expect(f.saved()[0]).toMatchObject({ status: "confirmed", attempts: 1, reconciliations: 1 });
    expect(JSON.stringify(f.saved())).not.toContain("Unsafe access");
  });

  it.each(["github", "gitea"] as const)("%s preflights before managed issue discovery changes create into update", async (kind) => {
    const f = fixture();
    let issue: Record<string, unknown> | undefined;
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (init?.method === "POST" && url.endsWith("/issues")) {
        issue = { ...JSON.parse(init.body!), id: 1, number: 1, state: "open", labels: [], html_url: "https://git.test/o/r/issues/1" };
        throw new Error("lost response");
      }
      if (init?.method === "PATCH") { issue = { ...issue, ...JSON.parse(init.body!) }; return reply(issue); }
      return reply(url.includes("/issues") ? issue ? [issue] : [] : []);
    });
    const run = () => {
      const opts = { baseUrl: "https://git.test", owner: "o", repo: "r", fetch, assignCommitter: false, issueMode: "per_problem" as const };
      const dispatcher = kind === "gitea" ? createGiteaProblemIssueDispatcher(opts) : createGithubProblemIssueDispatcher(opts);
      return f.journal().run("out", "summary:0", () => dispatcher.reconcileProblems([problem], "report"));
    };
    await expect(run()).rejects.toThrow();
    await run();
    expect(fetch.mock.calls.filter(([url, init]) => url.endsWith("/issues") && init?.method === "POST")).toHaveLength(1);
    expect(f.saved().every(op => op.status === "confirmed")).toBe(true);
  });

  it("retains independent message ordinals and confirmed partial sends", async () => {
    const f = fixture();
    const messages: unknown[] = [];
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      if (init?.method === "GET") return reply(messages);
      const message = { id: messages.length + 1, ...JSON.parse(init!.body!) };
      messages.push(message);
      if (messages.length === 2) throw new Error("lost second response");
      return reply(message);
    });
    const send = () => createGithubIssueDispatcher({ owner: "o", repo: "r", issueNumber: 1, fetch }).publishAggregatedProblems([], "same summary");
    const first = f.journal();
    await first.run("out", "summary:0", send);
    await expect(first.run("out", "summary:1", send)).rejects.toThrow();
    const recovered = f.journal();
    await recovered.run("out", "summary:0", send);
    await recovered.run("out", "summary:1", send);
    expect(messages).toHaveLength(2);
    expect(f.saved().map(op => op.call)).toEqual(["summary:0", "summary:1"]);
  });

  it.each(["not_found", "denied", "malformed", "duplicate", "pagination_limit"])("does not resend after %s reconciliation", async (mode) => {
    const f = fixture();
    let body = "";
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      if (init?.method === "POST") { body = JSON.parse(init.body!).body; throw new Error("lost"); }
      if (mode === "denied") return reply([], 403);
      if (mode === "malformed") return reply({});
      if (mode === "duplicate") return reply([{ id: 1, body }, { id: 2, body }]);
      if (mode === "pagination_limit") return reply([], 200, { link: '<https://evil.test>; rel="next"' });
      return reply([]);
    });
    const work = publishers.github_issue(fetch);
    await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow();
    await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetch.mock.calls.every(([url]) => url.startsWith("https://api.github.com/repos/o/r/"))).toBe(true);
    expect(f.saved()[0]?.status).toBe("unknown");
  });

  it("honors a next-page header on a short page without following its URL", async () => {
    const f = fixture();
    let body = "";
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (init?.method === "POST") { body = JSON.parse(init.body!).body; throw new Error("lost"); }
      return new URL(url).searchParams.get("page") === "1"
        ? reply([], 200, { link: '<https://evil.test/leak>; rel="next"' }) : reply([{ id: 9, body }]);
    });
    const work = publishers.gitea_issue(fetch);
    await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow();
    await f.journal().run("out", "summary:0", work);
    expect(fetch.mock.calls).toHaveLength(3);
    expect(fetch.mock.calls.at(-1)?.[0]).toContain("limit=100&page=2");
  });

  it.each(["feishu", "wecom"])("%s webhook unknown outcome is never blindly resent", async kind => {
    const f = fixture();
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error("lost"));
    const opts = { webhookUrl: "https://im.test/hook/private-token", fetch };
    const work = () => (kind === "feishu" ? createFeishuBotDispatcher(opts) : createWeComBotDispatcher(opts)).publishAggregatedProblems([], "report");
    await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow();
    await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow("publisher_cannot_reconcile");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.saved())).not.toContain("private-token");
  });

  it("Feishu UUID remains stable across restart and expires conservatively", async () => {
    const f = fixture();
    const uuids: string[] = [];
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (url.includes("/auth/")) return reply({ code: 0, tenant_access_token: "private-token", expire: 7200 });
      uuids.push(JSON.parse(init!.body!).uuid);
      if (uuids.length === 1) throw new Error("lost");
      return reply({ code: 0, data: { message_id: "om_1" } });
    });
    const work = () => new FeishuAppClient({ appId: "app", appSecret: "secret", fetch }).sendCard("recipient", "chat_id", { content: "report" });
    await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow();
    f.time(3_541_000);
    await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow("idempotency_window_expired");
    expect(uuids).toHaveLength(1);
    f.time(30_000);
    expect(await f.journal().run("out", "summary:0", work)).toBe("om_1");
    expect(uuids[0]).toBe(uuids[1]);
    expect(uuids[0]!.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(f.saved())).not.toMatch(/secret|private-token|recipient|report/u);
  });

  it.each(["before", "after"])("stops on checkpoint failure %s the remote write even if a publisher catches it", async when => {
    const f = fixture();
    const fetch = vi.fn<FetchLike>().mockResolvedValue(reply({ id: 1 }));
    if (when === "before") f.save.mockRejectedValueOnce(new Error("disk failed"));
    else f.save.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("disk failed"));
    await expect(f.journal().run("out", "summary:0", async () => {
      try { await publishers.github_issue(fetch)(); } catch { /* Simulate an optional output catch. */ }
    })).rejects.toThrow("disk failed");
    expect(fetch).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  });

  it("fences an aborted write and preserves unknown status", async () => {
    const abort = new AbortController();
    const saved: OperationList = [];
    const journal = new PublicationJournal({ batchId: "b", signal: abort.signal, save: async ops => { saved.push(structuredClone(ops)); } });
    const fetch = vi.fn<FetchLike>(async () => { abort.abort(new Error("lease lost")); return reply({ id: 1 }); });
    await expect(journal.run("out", "summary:0", publishers.github_issue(fetch))).rejects.toThrow("lease lost");
    expect(saved.at(-1)?.[0]?.status).toBe("unknown");
  });

  it("checks state changes and deletes by resource, without repeating the mutation", async () => {
    for (const method of ["PATCH", "DELETE"]) {
      const f = fixture();
      const fetch = vi.fn<FetchLike>(async (_url, init) => {
        if (init?.method === "GET") return method === "PATCH" ? reply({ id: 1, state: "closed" }) : reply({}, 404);
        throw new Error("lost");
      });
      const work = () => publicationFetch(fetch, "gitea")("https://git.test/api/v1/repos/o/r/issues/1", { method, ...(method === "PATCH" ? { body: '{"state":"closed"}' } : {}) });
      await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow();
      await f.journal().run("out", "summary:0", work);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(validateRemotePublicationOperations(f.saved())).toBe(true);
    }
  });

  it("isolates concurrent batches/channels and leaves non-batch output unchanged", async () => {
    const f = fixture();
    const fetch = vi.fn<FetchLike>(async (_url, init) => reply({ id: 1, body: JSON.parse(init!.body!).body }));
    const work = publishers.github_issue(fetch);
    const journals = [f.journal("a"), f.journal("b"), f.journal("a")];
    await Promise.all(journals.map((journal, i) => journal.run(i === 2 ? "two" : "one", "summary:0", work)));
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init!.body!).body);
    expect(new Set(bodies).size).toBe(3);
    await work();
    expect(fetch.mock.calls.at(-1)?.[1]?.body).not.toContain("aicr:publication=");
  });

  it("retries explicit rejection but queries an HTTP 5xx before another write", async () => {
    const f = fixture();
    let body = "";
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      if (init?.method === "GET") return reply([{ id: 1, body }]);
      body = JSON.parse(init!.body!).body;
      return reply({}, fetch.mock.calls.length === 1 ? 403 : 503);
    });
    const work = publishers.github_issue(fetch);
    await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow();
    expect(f.saved()[0]?.status).toBe("rejected");
    await expect(f.journal().run("out", "summary:0", work)).rejects.toThrow();
    await f.journal().run("out", "summary:0", work);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(f.saved()[0]).toMatchObject({ attempts: 2, reconciliations: 1, status: "confirmed" });
  });

  it("does not change a destination or body while an earlier write is unknown", async () => {
    const f = fixture();
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error("lost"));
    const work = (webhookUrl: string, summary: string) => () => createWeComBotDispatcher({ webhookUrl, fetch }).publishAggregatedProblems([], summary);
    await expect(f.journal().run("out", "summary:0", work("https://im.test/one", "first"))).rejects.toThrow();
    await expect(f.journal().run("out", "summary:0", work("https://im.test/two", "second"))).rejects.toThrow("request_changed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not move an uncertain Feishu UUID to another application", async () => {
    const f = fixture();
    let sends = 0;
    const fetch: FetchLike = async url => {
      if (url.includes("/auth/")) return reply({ code: 0, tenant_access_token: "token", expire: 7200 });
      sends++;
      throw new Error("lost");
    };
    const work = (appId: string) => () => new FeishuAppClient({ appId, appSecret: "secret", fetch }).sendCard("group", "chat_id", {});
    await expect(f.journal().run("out", "summary:0", work("one"))).rejects.toThrow();
    await expect(f.journal().run("out", "summary:0", work("two"))).rejects.toThrow("request_changed_after_unknown_write");
    expect(sends).toBe(1);
  });

  it("does not send changed IM rendering after the write is confirmed but the channel receipt is lost", async () => {
    const f = fixture();
    const fetch = vi.fn<FetchLike>().mockResolvedValue(reply({ errcode: 0 }));
    const work = (summary: string) => () => createWeComBotDispatcher({ webhookUrl: "https://im.test/hook", fetch }).publishAggregatedProblems([], summary);
    await f.journal().run("out", "summary:0", work("first"));
    await expect(f.journal().run("out", "summary:0", work("changed"))).rejects.toThrow("request_changed_after_confirmed_write");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not confirm malformed successful responses or bypass a swallowed query failure", async () => {
    const f = fixture();
    let body = "";
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      if (init?.method === "GET") return reply([], 403);
      body = JSON.parse(init!.body!).body;
      return reply({});
    });
    await expect(f.journal().run("out", "summary:0", publishers.github_issue(fetch))).rejects.toThrow("invalid_write_response");
    await expect(f.journal().run("out", "summary:0", async () => {
      try { await publishers.github_issue(fetch)(); } catch { /* Simulate a publisher catch. */ }
    })).rejects.toThrow("unconfirmed_write");
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(body).toContain("aicr:publication=");
  });

  it("rejects malformed journals and unsupported protocol shapes", () => {
    const valid = { id: "a".repeat(64), channel: "out", call: "summary:0", strategy: "marker", status: "unknown",
      attempts: 1, reconciliations: 0, firstAttemptAt: 1, updatedAt: 1,
      scope: "https://git.test/repos/o/r", target: "https://git.test/repos/o/r/issues", collection: true };
    expect(validateRemotePublicationOperations([valid])).toBe(true);
    for (const invalid of [null, {}, [valid, valid], [{ ...valid, target: "https://evil.test/issues" }], [{ ...valid, status: "confirmed" }], [{ ...valid, attempts: -1 }]]) {
      expect(validateRemotePublicationOperations(invalid)).toBe(false);
    }
  });
});

type OperationList = (readonly RemotePublicationOperation[])[];
