import { describe, expect, it } from "vitest";

import {
  createGitlabMergeRequestReviewDispatcher,
  OutputDispatchError,
  type FetchLike,
  type ReviewFinding,
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

const finding: ReviewFinding = {
  file: "src/app.ts",
  line: 42,
  severity: "medium",
  category: "correctness",
  message: "The retry branch can publish stale state.",
  suggestion: "Reload state before publishing.",
  fingerprint: "fp-gitlab",
};

describe("createGitlabMergeRequestReviewDispatcher", () => {
  it("publishes a finding as a GitLab merge request discussion", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabMergeRequestReviewDispatcher({
      baseUrl: "https://gitlab.example/",
      token: "gl-token",
      projectId: "owent/example",
      mergeRequestIid: 7,
      baseSha: "base-sha",
      startSha: "start-sha",
      headSha: "head-sha",
      channelName: "gitlab-main",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 456 });
      },
    });

    const result = await dispatcher.publishFinding(finding);

    expect(result).toEqual({ channel: "gitlab-main", status: "published", externalId: "456", raw: { id: 456 } });
    expect(calls[0]?.url).toBe("https://gitlab.example/api/v4/projects/owent%2Fexample/merge_requests/7/discussions");
    expect(calls[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      "private-token": "gl-token",
    });
    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.position).toMatchObject({
      position_type: "text",
      base_sha: "base-sha",
      start_sha: "start-sha",
      head_sha: "head-sha",
      old_path: "src/app.ts",
      new_path: "src/app.ts",
      new_line: 42,
    });
  });

  it("publishes a general MR note when line comment metadata is unavailable", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabMergeRequestReviewDispatcher({
      projectId: 123,
      mergeRequestIid: 7,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishFinding(finding);

    expect(calls[0]?.url).toBe("https://gitlab.com/api/v4/projects/123/merge_requests/7/notes");
    const body = JSON.parse(calls[0]?.init?.body ?? "{}");
    expect(body.position).toBeUndefined();
    expect(body.body).toContain("src/app.ts:42");
  });

  it("publishes a general MR note when a finding is marked non-line-commentable", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabMergeRequestReviewDispatcher({
      projectId: "owent/example",
      mergeRequestIid: 7,
      baseSha: "base",
      headSha: "head",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return response({ id: 1 });
      },
    });

    await dispatcher.publishFinding({ ...finding, lineCommentAllowed: false });

    expect(calls[0]?.url).toBe("https://gitlab.com/api/v4/projects/owent%2Fexample/merge_requests/7/notes");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}").position).toBeUndefined();
  });

  it("falls back to a general MR note when GitLab rejects the line anchor", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGitlabMergeRequestReviewDispatcher({
      projectId: "owent/example",
      mergeRequestIid: 7,
      baseSha: "base",
      headSha: "head",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? response({ message: "line_code is invalid" }, 422)
          : response({ id: 2 });
      },
    });

    const result = await dispatcher.publishFinding(finding);

    expect(result.externalId).toBe("2");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/discussions");
    expect(calls[1]?.url).toContain("/notes");
  });

  it("throws a typed dispatch error on non-recoverable responses", async () => {
    const dispatcher = createGitlabMergeRequestReviewDispatcher({
      projectId: "owent/example",
      mergeRequestIid: 7,
      fetch: async () => response({ message: "forbidden" }, 403),
    });

    await expect(dispatcher.publishFinding(finding)).rejects.toBeInstanceOf(OutputDispatchError);
    await expect(dispatcher.publishFinding(finding)).rejects.toMatchObject({ status: 403 });
  });
});
