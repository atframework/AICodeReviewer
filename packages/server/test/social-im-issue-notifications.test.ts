import { afterEach, expect, it, vi } from "vitest";
import { createReviewEvent } from "@aicr/core";
import {
  createCompositeOutputPublisher,
  createOutputPublisherFromConfig,
} from "../src/bootstrap.js";
import { classifyImReviewResult } from "../src/im/manual-review-service.js";
import { fixture, platforms, apiFixture, SHA } from "./social-im-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const problem = {
  file: "src/a.ts",
  line: 3,
  severity: "high" as const,
  category: "correctness",
  message: "Short finding\n\nFull problem analysis must remain in the issue.",
  suggestion: "Detailed fix only in the issue.",
  codeSnippet: "privateImplementation();",
  codeLanguage: "ts",
};
const summary =
  "Concise headline\n\nFull summary analysis must remain in the issue.";

for (const issueKind of [
  "github_problem_issue",
  "gitea_problem_issue",
  "gitlab_problem_issue",
] as const) {
  it.each(platforms)(
    `links a confirmed ${issueKind} from a brief %s notification, even when IM is listed first`,
    async (platform) => {
      const { config } = fixture(platform);
      const userId = platform === "slack" ? "U234" : "234567891";
      config.outputs.channels[0]!.author_mappings = {
        "alice@example.org": userId,
      };
      const calls: { url: string; body: Record<string, unknown> }[] = [];
      vi.stubGlobal("fetch", apiFixture(platform, calls));
      const event = createReviewEvent({
        triggerName: "git",
        provider: "github",
        workspaceId: "ws",
        targetKind: "commit",
        repoRef: "org/demo",
        headSha: SHA,
        author: { email: "alice@example.org" },
        reason: "test",
      });
      const report = createOutputPublisherFromConfig(
        config,
        "report",
        undefined,
        "ws",
        event,
      )!;
      const url = "https://git.test/org/demo/issues/42";
      const issue = vi.fn(async () => ({
        channel: "issue",
        status: "published" as const,
        raw: {
          issue:
            issueKind === "gitlab_problem_issue"
              ? { web_url: url }
              : { html_url: url },
        },
      }));
      const publisher = createCompositeOutputPublisher(
        [],
        [
          {
            name: "report",
            kind: config.outputs.channels[0]!.kind,
            publisher: report,
          },
          {
            name: "issue",
            kind: issueKind,
            publisher: { publishSummary: issue },
          },
        ],
      )!;
      await publisher.publishSummary!(summary, [problem]);
      expect(issue).toHaveBeenCalledWith(summary, [problem], undefined);
      const writes = calls.filter((c) =>
        /chat\.postMessage$|\/messages$|sendMessage$/u.test(c.url),
      );
      expect(writes).toHaveLength(1);
      const body = writes[0]!.body,
        text = String(body.text ?? body.content);
      expect(text).toContain("Problems (1)");
      expect(text).toContain("correctness");
      expect(text).toContain("src/a.ts:3");
      for (const detail of [
        "Short finding",
        "Full problem analysis",
        "Detailed fix",
        "privateImplementation",
        "Full summary analysis",
      ])
        expect(text).not.toContain(detail);
      if (platform === "telegram") {
        expect(body.entities).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text_link", url }),
            expect.objectContaining({
              type: "text_link",
              url: `tg://user?id=${userId}`,
            }),
          ]),
        );
      } else {
        expect(text).toContain(url);
        expect(text).toContain(`<@${userId}>`);
        if (platform === "discord")
          expect(body.allowed_mentions).toMatchObject({
            parse: [],
            users: [userId],
          });
      }
    },
  );
}

it.each(platforms)(
  "keeps the full %s report when the issue write fails",
  async (platform) => {
    const { config } = fixture(platform);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", apiFixture(platform, calls));
    const report = createOutputPublisherFromConfig(
      config,
      "report",
      undefined,
      "ws",
    )!;
    const publisher = createCompositeOutputPublisher(
      [],
      [
        {
          name: "report",
          kind: config.outputs.channels[0]!.kind,
          publisher: report,
        },
        {
          name: "issue",
          kind: "github_problem_issue",
          publisher: {
            async publishSummary() {
              return {
                channel: "issue",
                status: "failed",
                raw: { kind: "rejected", status: 403 },
              };
            },
          },
        },
      ],
    )!;
    await publisher.publishSummary!(summary, [problem]);
    const body = calls.at(-1)!.body;
    expect(String(body.text ?? body.content)).toContain(
      "Full problem analysis",
    );
  },
);

it.each(platforms)(
  "keeps the %s issue link and author reminder when a brief notification is truncated",
  async (platform) => {
    const { config } = fixture(platform);
    const userId = platform === "slack" ? "U234" : "234567891";
    config.outputs.channels[0]!.author_mappings = { alice: userId };
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", apiFixture(platform, calls));
    const event = createReviewEvent({
      triggerName: "git",
      provider: "github",
      workspaceId: "ws",
      targetKind: "commit",
      repoRef: "org/demo",
      headSha: SHA,
      author: { username: "alice" },
      reason: "test",
    });
    const publisher = createOutputPublisherFromConfig(
      config,
      "report",
      undefined,
      "ws",
      event,
    )!;
    const url = "https://git.test/org/demo/issues/42";
    await publisher.publishSummary!(
      summary,
      Array.from({ length: 300 }, (_, i) => ({
        ...problem,
        file: `src/${"long-path".repeat(8)}-${i}.ts`,
      })),
      { summaryIssueUrl: url },
    );
    const body = calls.at(-1)!.body,
      text = String(body.text ?? body.content);
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThanOrEqual(
      platform === "discord" ? 1900 : 3900,
    );
    if (platform === "telegram")
      expect(body.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text_link",
            url: `tg://user?id=${userId}`,
          }),
        ]),
      );
    else expect(text).toContain(`<@${userId}>`);
    expect(text + JSON.stringify(body.entities ?? [])).toContain(url);
  },
);

for (const outcome of ["published", "rejected", "unknown"] as const) {
  it.each(platforms)(
    `classifies collected %s findings by the actual ${outcome} flush, including repeated summaries`,
    async (platform) => {
      const { config } = fixture(platform);
      let writes = 0;
      vi.stubGlobal(
        "fetch",
        apiFixture(platform, [], () => {
          writes++;
          if (outcome === "unknown") throw new Error("response lost");
          if (outcome === "rejected") return Response.json({}, { status: 403 });
          return platform === "slack"
            ? Response.json({ ok: true, channel: "C123", ts: "1759000000.123" })
            : platform === "discord"
              ? Response.json({
                  id: "123456789012345689",
                  channel_id: "123456789012345680",
                })
              : Response.json({
                  ok: true,
                  result: { message_id: 123, chat: { id: -1001234567890 } },
                });
        }),
      );
      const publisher = createOutputPublisherFromConfig(
        config,
        "report",
        undefined,
        "ws",
      )!;
      const collected = await publisher.publishProblem!(problem);
      expect(
        classifyImReviewResult({
          status: "published",
          dispatchResults: [collected].flat(),
        }).state,
      ).toBe("publication_unknown");
      const first = await publisher.publishSummary!(summary, [problem]);
      const second = await publisher.publishSummary!("another summary", [
        problem,
      ]);
      expect(
        classifyImReviewResult({
          status: "published",
          dispatchResults: [collected, first, second].flat(),
        }).state,
      ).toBe(
        outcome === "published"
          ? "succeeded"
          : outcome === "rejected"
            ? "failed"
            : "publication_unknown",
      );
      expect(writes).toBe(1);
    },
  );
}
