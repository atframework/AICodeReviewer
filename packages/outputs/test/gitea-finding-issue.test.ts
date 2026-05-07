import { describe, expect, it } from "vitest";

import {
  createGiteaFindingIssueDispatcher,
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
  file: "src/auth.ts",
  line: 12,
  severity: "critical",
  category: "security",
  message: "SQL query uses unsanitized input.",
  suggestion: "Use parameterized queries.",
  fingerprint: "fp-sql",
};

const managedBody = [
  "<!-- aicr:managed=finding-issue -->",
  "<!-- aicr:channel=aicr-issues -->",
  "<!-- aicr:label=aicr-managed -->",
  "<!-- aicr:fingerprint=fp-old -->",
  "",
  "Old finding",
].join("\n");

describe("createGiteaFindingIssueDispatcher", () => {
  it("creates one marked issue per new finding", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaFindingIssueDispatcher({
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

    const results = await dispatcher.reconcileFindings([finding], "Summary text");

    expect(results).toHaveLength(1);
    expect(results[0]?.externalId).toBe("99");
    expect(calls[0]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/issues?state=open&type=issues");
    expect(calls[1]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/issues");
    expect(calls[1]?.init?.headers).toMatchObject({ authorization: "token token-value" });
    const body = JSON.parse(calls[1]?.init?.body ?? "{}");
    expect(body.title).toContain("[AICR Test] [CRITICAL] security: src/auth.ts:12");
    expect(body.body).toContain("<!-- aicr:managed=finding-issue -->");
    expect(body.body).toContain("<!-- aicr:fingerprint=fp-sql -->");
    expect(body.body).toContain("Summary text");
    expect(body.labels).toEqual([1, 2]);
  });

  it("does not duplicate an open managed issue with the same fingerprint", async () => {
    const calls: string[] = [];
    const dispatcher = createGiteaFindingIssueDispatcher({
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

    const results = await dispatcher.reconcileFindings([finding]);

    expect(results).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("closes stale managed issues when findings disappear", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaFindingIssueDispatcher({
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

    const results = await dispatcher.reconcileFindings([]);

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "closed", issueNumber: 42 });
    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "GET https://gitea.example/api/v1/repos/owent/example/issues?state=open&type=issues",
      "POST https://gitea.example/api/v1/repos/owent/example/issues/42/comments",
      "PATCH https://gitea.example/api/v1/repos/owent/example/issues/42",
    ]);
    expect(JSON.parse(calls[2]?.init?.body ?? "{}")).toEqual({ state: "closed" });
  });

  it("deletes stale managed issues when configured", async () => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const dispatcher = createGiteaFindingIssueDispatcher({
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

    const results = await dispatcher.reconcileFindings([]);

    expect(results).toHaveLength(1);
    expect(results[0]?.raw).toMatchObject({ action: "deleted", issueNumber: 42 });
    expect(calls[1]?.url).toBe("https://gitea.example/api/v1/repos/owent/example/issues/42");
    expect(calls[1]?.init?.method).toBe("DELETE");
  });
});
