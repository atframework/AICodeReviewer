import { describe, expect, it } from "vitest";

import {
  GiteaApiClient,
  triageIssue,
  parseTriageDecision,
  DEFAULT_TRIAGE_SYSTEM_PROMPT,
  parseIssueRepositoryFromUrl,
  type IssueDetails,
} from "../src/issue-triage.js";
import type { ChatCompletionClient, ModelSpec } from "@aicr/llm";

function createMockFetch(responses: Map<string, unknown>) {
  return async (input: string, init?: { readonly method?: string }) => {
    const key = `${init?.method ?? "GET"} ${input}`;
    const response = responses.get(key);
    if (response) {
      return {
        ok: true,
        status: 200,
        async json() { return response; },
        async text() { return JSON.stringify(response); },
      };
    }
    return {
      ok: false,
      status: 404,
      async json() { return {}; },
      async text() { return "not found"; },
    };
  };
}

function createMockIssue(overrides: Partial<IssueDetails> = {}): IssueDetails {
  return {
    number: 42,
    title: "Test issue",
    body: "This is a test issue",
    state: "open",
    labels: [],
    author: "testuser",
    url: "https://gitea.example.com/owner/repo/issues/42",
    createdAt: "2026-01-01T00:00:00Z",
    comments: [],
    isPullRequest: false,
    ...overrides,
  };
}

function createMockLlm(content: string): ChatCompletionClient {
  return {
    async complete() {
      return {
        providerId: "test-provider",
        modelId: "test-model",
        content,
        raw: {},
      };
    },
  };
}

const testModel: ModelSpec = {
  providerKind: "openai_compatible",
  providerId: "test-provider",
  modelId: "test-model",
};

describe("GiteaApiClient", () => {
  it("fetches an issue with comments", async () => {
    const responses = new Map<string, unknown>([
      ["GET https://gitea.example.com/api/v1/repos/owner/repo/issues/42", {
        title: "Bug report",
        body: "Something is broken",
        state: "open",
        user: { login: "reporter" },
        html_url: "https://gitea.example.com/owner/repo/issues/42",
        created_at: "2026-01-01T00:00:00Z",
        comments: 2,
        labels: [{ name: "bug" }],
      }],
      ["GET https://gitea.example.com/api/v1/repos/owner/repo/issues/42/comments", [
        { user: { login: "dev1" }, body: "I can reproduce this.", created_at: "2026-01-02T00:00:00Z" },
        { user: { login: "dev2" }, body: "Looking into it.", created_at: "2026-01-03T00:00:00Z" },
      ]],
    ]);
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      token: "test-token",
      fetch: createMockFetch(responses),
    });

    const issue = await client.getIssue("owner", "repo", 42);

    expect(issue.number).toBe(42);
    expect(issue.title).toBe("Bug report");
    expect(issue.body).toBe("Something is broken");
    expect(issue.state).toBe("open");
    expect(issue.author).toBe("reporter");
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.comments).toHaveLength(2);
    expect(issue.comments[0]?.author).toBe("dev1");
  });

  it("fetches an issue without comments", async () => {
    const responses = new Map<string, unknown>([
      ["GET https://gitea.example.com/api/v1/repos/owner/repo/issues/99", {
        title: "No comments issue",
        body: "Body text",
        state: "open",
        user: { login: "user1" },
        html_url: "https://gitea.example.com/owner/repo/issues/99",
        created_at: "2026-01-01T00:00:00Z",
        comments: 0,
        labels: [],
      }],
    ]);
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      fetch: createMockFetch(responses),
    });

    const issue = await client.getIssue("owner", "repo", 99);
    expect(issue.comments).toHaveLength(0);
  });

  it("closes an issue via PATCH", async () => {
    let capturedBody: unknown;
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      token: "test-token",
      fetch: async (input, init) => {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return {
          ok: true,
          status: 200,
          async json() { return { state: "closed" }; },
          async text() { return "{}"; },
        };
      },
    });

    const result = await client.closeIssue("owner", "repo", 42);
    expect(capturedBody).toEqual({ state: "closed" });
    expect((result as Record<string, unknown>).state).toBe("closed");
  });

  it("closes a pull request via PATCH", async () => {
    let capturedBody: unknown;
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      token: "test-token",
      fetch: async (_input, init) => {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return {
          ok: true,
          status: 200,
          async json() { return { state: "closed" }; },
          async text() { return "{}"; },
        };
      },
    });

    await client.closePullRequest("owner", "repo", 7);
    expect(capturedBody).toEqual({ state: "closed" });
  });

  it("posts a comment to an issue", async () => {
    let capturedBody: unknown;
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      token: "test-token",
      fetch: async (_input, init) => {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return {
          ok: true,
          status: 201,
          async json() { return { id: 100 }; },
          async text() { return "{}"; },
        };
      },
    });

    await client.postIssueComment("owner", "repo", 42, "Closing this issue.");
    expect(capturedBody).toEqual({ body: "Closing this issue." });
  });

  it("throws on API error", async () => {
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      token: "test-token",
      fetch: async () => ({
        ok: false,
        status: 403,
        async json() { return {}; },
        async text() { return "forbidden"; },
      }),
    });

    await expect(client.getIssue("owner", "repo", 42)).rejects.toThrow("returned 403");
  });

  it("sends authorization header when token is provided", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      token: "my-secret-token",
      fetch: async (_input, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return {
          ok: true,
          status: 200,
          async json() { return { title: "t", state: "open", user: {}, comments: 0, labels: [] }; },
          async text() { return "{}"; },
        };
      },
    });

    await client.getIssue("owner", "repo", 1);
    expect(capturedHeaders?.authorization).toBe("token my-secret-token");
  });
});

describe("parseTriageDecision", () => {
  it("parses a valid close decision", () => {
    const raw = '{"action":"close","reason":"Spam content","category":"spam"}';
    const decision = parseTriageDecision(raw);
    expect(decision).toEqual({
      action: "close",
      reason: "Spam content",
      category: "spam",
    });
  });

  it("parses a valid keep_open decision", () => {
    const raw = '{"action":"keep_open","reason":"Valid bug report","category":"valid"}';
    const decision = parseTriageDecision(raw);
    expect(decision).toEqual({
      action: "keep_open",
      reason: "Valid bug report",
      category: "valid",
    });
  });

  it("defaults to keep_open for unknown action", () => {
    const raw = '{"action":"maybe","reason":"Unclear","category":"valid"}';
    const decision = parseTriageDecision(raw);
    expect(decision.action).toBe("keep_open");
  });

  it("defaults to valid category for unknown category", () => {
    const raw = '{"action":"close","reason":"test","category":"unknown_cat"}';
    const decision = parseTriageDecision(raw);
    expect(decision.category).toBe("valid");
  });

  it("extracts JSON from surrounding text", () => {
    const raw = 'Here is my analysis:\n{"action":"close","reason":"Duplicate","category":"duplicate"}\nDone.';
    const decision = parseTriageDecision(raw);
    expect(decision.action).toBe("close");
    expect(decision.category).toBe("duplicate");
  });

  it("returns keep_open when no JSON is found", () => {
    const decision = parseTriageDecision("No JSON here");
    expect(decision.action).toBe("keep_open");
    expect(decision.reason).toContain("Failed to parse");
  });

  it("returns keep_open for invalid JSON", () => {
    const decision = parseTriageDecision("{invalid json}");
    expect(decision.action).toBe("keep_open");
  });

  it("handles all valid categories", () => {
    const categories = ["valid", "duplicate", "spam", "invalid", "resolved", "out_of_scope", "needs_info", "stale"];
    for (const cat of categories) {
      const decision = parseTriageDecision(`{"action":"close","reason":"test","category":"${cat}"}`);
      expect(decision.category).toBe(cat);
    }
  });
});

describe("triageIssue", () => {
  it("keeps a valid issue open", async () => {
    const issue = createMockIssue({
      title: "App crashes on startup",
      body: "When I run `npm start`, the app crashes with ENOENT.",
    });
    const llm = createMockLlm('{"action":"keep_open","reason":"Valid bug report with clear reproduction steps","category":"valid"}');

    const result = await triageIssue(issue, {
      llm,
      model: testModel,
      giteaClient: new GiteaApiClient({
        baseUrl: "https://gitea.example.com",
        fetch: createMockFetch(new Map()),
      }),
    });

    expect(result.decision.action).toBe("keep_open");
    expect(result.decision.category).toBe("valid");
    expect(result.closed).toBe(false);
    expect(result.commentPosted).toBe(false);
  });

  it("closes a spam issue", async () => {
    const issue = createMockIssue({
      number: 1,
      title: "BUY CHEAP VIAGRA NOW!!!",
      body: "Visit our website for amazing deals!!!",
      url: "https://gitea.example.com/owner/repo/issues/1",
    });
    const llm = createMockLlm('{"action":"close","reason":"Spam content","category":"spam"}');

    let postedComment: string | undefined;
    let closedIssue = false;
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      token: "test-token",
      fetch: async (input, init) => {
        if (init?.method === "POST" && input.includes("/comments")) {
          postedComment = JSON.parse(init.body as string).body;
        }
        if (init?.method === "PATCH" && input.includes("/issues/1")) {
          closedIssue = true;
        }
        return {
          ok: true,
          status: 200,
          async json() { return {}; },
          async text() { return "{}"; },
        };
      },
    });

    const result = await triageIssue(issue, {
      llm,
      model: testModel,
      giteaClient: client,
    });

    expect(result.decision.action).toBe("close");
  expect(closedIssue).toBe(true);
    expect(result.decision.category).toBe("spam");
    expect(result.closed).toBe(true);
    expect(result.commentPosted).toBe(true);
    expect(postedComment).toContain("Auto-triage result");
    expect(postedComment).toContain("spam");
  });

  it("closes a PR that is invalid", async () => {
    const issue = createMockIssue({
      number: 5,
      title: "Fix typo",
      body: "",
      isPullRequest: true,
      url: "https://gitea.example.com/owner/repo/pulls/5",
    });
    const llm = createMockLlm('{"action":"close","reason":"Empty PR with no description","category":"invalid"}');

    let closedPr = false;
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      token: "test-token",
      fetch: async (input, init) => {
        if (init?.method === "PATCH" && input.includes("/pulls/5")) {
          closedPr = true;
        }
        return {
          ok: true,
          status: 200,
          async json() { return {}; },
          async text() { return "{}"; },
        };
      },
    });

    const result = await triageIssue(issue, {
      llm,
      model: testModel,
      giteaClient: client,
    });

    expect(result.decision.action).toBe("close");
    expect(closedPr).toBe(true);
  });

  it("does not close in dryRun mode", async () => {
    const issue = createMockIssue({
      title: "Spam",
      body: "Buy cheap stuff",
      url: "https://gitea.example.com/owner/repo/issues/3",
    });
    const llm = createMockLlm('{"action":"close","reason":"Spam","category":"spam"}');

    let apiCalled = false;
    const client = new GiteaApiClient({
      baseUrl: "https://gitea.example.com",
      token: "test-token",
      fetch: async () => {
        apiCalled = true;
        return {
          ok: true,
          status: 200,
          async json() { return {}; },
          async text() { return "{}"; },
        };
      },
    });

    const result = await triageIssue(issue, {
      llm,
      model: testModel,
      giteaClient: client,
      dryRun: true,
    });

    expect(result.decision.action).toBe("close");
    expect(result.closed).toBe(false);
    expect(result.commentPosted).toBe(false);
    expect(result.closeSkippedReason).toBe("dry_run");
    expect(apiCalled).toBe(false);
  });

  it("does not close when the category is not allowed by policy", async () => {
    const issue = createMockIssue({ title: "Probably resolved", body: "Looks fixed." });
    const llm = createMockLlm('{"action":"close","reason":"Looks resolved","category":"resolved"}');

    let apiCalled = false;
    const result = await triageIssue(issue, {
      llm,
      model: testModel,
      giteaClient: new GiteaApiClient({
        baseUrl: "https://gitea.example.com",
        fetch: async () => {
          apiCalled = true;
          return {
            ok: true,
            status: 200,
            async json() { return {}; },
            async text() { return "{}"; },
          };
        },
      }),
      categoriesClose: ["spam", "invalid"],
    });

    expect(result.decision.action).toBe("close");
    expect(result.closed).toBe(false);
    expect(result.commentPosted).toBe(false);
    expect(result.closeSkippedReason).toBe("category_not_allowed");
    expect(apiCalled).toBe(false);
  });

  it("uses explicit repository metadata instead of brittle URL parsing", async () => {
    const issue = createMockIssue({
      url: "https://gitea.example.com/prefix/owner/repo/issues/42",
      repository: { owner: "real-owner", repo: "real-repo" },
    });
    const llm = createMockLlm('{"action":"close","reason":"Spam","category":"spam"}');

    const calls: string[] = [];
    await triageIssue(issue, {
      llm,
      model: testModel,
      giteaClient: new GiteaApiClient({
        baseUrl: "https://gitea.example.com",
        fetch: async (input) => {
          calls.push(input);
          return {
            ok: true,
            status: 200,
            async json() { return {}; },
            async text() { return "{}"; },
          };
        },
      }),
    });

    expect(calls).toEqual([
      "https://gitea.example.com/api/v1/repos/real-owner/real-repo/issues/42/comments",
      "https://gitea.example.com/api/v1/repos/real-owner/real-repo/issues/42",
    ]);
  });

  it("uses custom prompt when provided", async () => {
    const issue = createMockIssue();
    let capturedSystemPrompt: string | undefined;
    const llm: ChatCompletionClient = {
      async complete(input) {
        capturedSystemPrompt = input.messages[0]?.content as string;
        return {
          providerId: "test",
          modelId: "test",
          content: '{"action":"keep_open","reason":"ok","category":"valid"}',
          raw: {},
        };
      },
    };

    await triageIssue(issue, {
      llm,
      model: testModel,
      giteaClient: new GiteaApiClient({
        baseUrl: "https://gitea.example.com",
        fetch: createMockFetch(new Map()),
      }),
      customPrompt: "Custom triage prompt",
    });

    expect(capturedSystemPrompt).toBe("Custom triage prompt");
  });

  it("uses default prompt when no custom prompt provided", async () => {
    const issue = createMockIssue();
    let capturedSystemPrompt: string | undefined;
    const llm: ChatCompletionClient = {
      async complete(input) {
        capturedSystemPrompt = input.messages[0]?.content as string;
        return {
          providerId: "test",
          modelId: "test",
          content: '{"action":"keep_open","reason":"ok","category":"valid"}',
          raw: {},
        };
      },
    };

    await triageIssue(issue, {
      llm,
      model: testModel,
      giteaClient: new GiteaApiClient({
        baseUrl: "https://gitea.example.com",
        fetch: createMockFetch(new Map()),
      }),
    });

    expect(capturedSystemPrompt).toBe(DEFAULT_TRIAGE_SYSTEM_PROMPT);
  });

  it("includes issue comments in the prompt", async () => {
    const issue = createMockIssue({
      comments: [
        { author: "dev1", body: "Confirmed bug", createdAt: "2026-01-02T00:00:00Z" },
      ],
    });
    let capturedUserPrompt: string | undefined;
    const llm: ChatCompletionClient = {
      async complete(input) {
        capturedUserPrompt = input.messages[1]?.content as string;
        return {
          providerId: "test",
          modelId: "test",
          content: '{"action":"keep_open","reason":"ok","category":"valid"}',
          raw: {},
        };
      },
    };

    await triageIssue(issue, {
      llm,
      model: testModel,
      giteaClient: new GiteaApiClient({
        baseUrl: "https://gitea.example.com",
        fetch: createMockFetch(new Map()),
      }),
    });

    expect(capturedUserPrompt).toContain("Confirmed bug");
    expect(capturedUserPrompt).toContain("@dev1");
  });
});

describe("DEFAULT_TRIAGE_SYSTEM_PROMPT", () => {
  it("contains JSON output format instruction", () => {
    expect(DEFAULT_TRIAGE_SYSTEM_PROMPT).toContain('"action"');
    expect(DEFAULT_TRIAGE_SYSTEM_PROMPT).toContain('"category"');
  });

  it("prefers keep_open when in doubt", () => {
    expect(DEFAULT_TRIAGE_SYSTEM_PROMPT).toContain("prefer");
    expect(DEFAULT_TRIAGE_SYSTEM_PROMPT).toContain("keep_open");
  });
});

describe("parseIssueRepositoryFromUrl", () => {
  it("parses normal Gitea issue and pull URLs", () => {
    expect(parseIssueRepositoryFromUrl("https://gitea.example.com/owner/repo/issues/42")).toEqual({
      owner: "owner",
      repo: "repo",
    });
    expect(parseIssueRepositoryFromUrl("https://gitea.example.com/owner/repo/pulls/7")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses API URLs and URLs served under a path prefix", () => {
    expect(parseIssueRepositoryFromUrl("https://gitea.example.com/api/v1/repos/owner/repo/issues/42")).toEqual({
      owner: "owner",
      repo: "repo",
    });
    expect(parseIssueRepositoryFromUrl("https://gitea.example.com/git/owner/repo/issues/42")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });
});
