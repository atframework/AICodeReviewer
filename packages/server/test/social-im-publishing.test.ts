import { afterEach, expect, it, vi } from "vitest";
import { createReviewEvent } from "@aicr/core";
import {
  createOutputPublisherFromConfig,
  createOutputPublisherResolverFromConfig,
} from "../src/bootstrap.js";
import { fixture, platforms, apiFixture, SHA } from "./social-im-fixtures.js";
afterEach(() => vi.unstubAllGlobals());
it.each(platforms)("renders deployed templates into readable %s report payloads", async platform => {
  const { config } = fixture(platform);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", apiFixture(platform, calls));
  const publisher = createOutputPublisherFromConfig(config, "report", undefined, "ws")!;
  await publisher.publishSummary!("Review completed.", [{
    file: "src/example.cpp", line: 42, severity: "high", category: "correctness",
    message: "Check `row->value()` before use.", suggestion: "Add a guard.",
    codeSnippet: "// keep code spacing\n\n\nif (row) { use(row->value()); }", codeLanguage: "cpp", fingerprint: "synthetic-fingerprint",
  }]);
  const writes = calls.filter(c => /chat\.postMessage$|\/messages$|sendMessage$/u.test(c.url));
  expect(writes).toHaveLength(1);
  const body = writes[0]!.body;
  const text = String(body.text ?? body.content);
  expect(text).toContain("HIGH · correctness");
  expect(text).toContain("Problems (1)");
  expect(text).not.toContain("aicr:fingerprint");
  expect(text).not.toContain("\r");
  expect(text).toContain("// keep code spacing\n\n\nif (row)");
  expect(text).not.toContain("\n\n\n\n");
  if (platform === "slack") {
    expect(text).toContain("*HIGH · correctness*");
    expect(text).not.toContain("```cpp");
  }
  if (platform === "telegram") {
    expect(text).not.toContain("**");
    expect(text).not.toContain("`");
    const entities = body.entities as { type: string; offset: number; length: number; language?: string }[];
    expect(entities.some(e => e.type === "bold" && text.slice(e.offset, e.offset + e.length) === "HIGH · correctness")).toBe(true);
    expect(entities.find(e => e.type === "pre")?.language).toBe("cpp");
  }
});
it.each(platforms)(
  "restricts the %s legacy summary route to an exact repository and target kind",
  async (platform) => {
    const { config } = fixture(platform);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", apiFixture(platform, calls));
    config.workspaces.instances.ws!.outputs = { line_comments: [], summary: [] };
    config.outputs.routes = { rules: [{
      match: { trigger: "git", target_kind: "commit", repo_ref: "org/demo" },
      line_comments: [], summary: ["report"],
    }] };
    const resolver = createOutputPublisherResolverFromConfig(config);
    for (const [repoRef, targetKind] of [["other/demo", "commit"], ["org/demo-other", "commit"], ["org/demo", "push"], ["org/demo", "commit"]] as const) {
      const event = createReviewEvent({ triggerName: "git", provider: "github", workspaceId: "ws", targetKind, repoRef, headSha: SHA, author: {}, reason: "test" });
      const publisher = await resolver({ reviewEvent: event });
      await publisher?.publishSummary?.("summary", []);
      const writes = calls.filter((c) => /chat\.postMessage$|\/messages$|sendMessage$/u.test(c.url));
      expect(writes).toHaveLength(repoRef === "org/demo" && targetKind === "commit" ? 1 : 0);
    }
  },
);
it.each(platforms)(
  "builds the %s publisher from configuration and flushes one bounded message",
  async (platform) => {
    const { config, destination } = fixture(platform);
    const calls: {
      url: string;
      body: Record<string, unknown>;
      init?: RequestInit;
    }[] = [];
    vi.stubGlobal("fetch", apiFixture(platform, calls));
    const event = createReviewEvent({
      triggerName: "git",
      provider: "github",
      workspaceId: "ws",
      targetKind: "commit",
      repoRef: "org/demo",
      headSha: SHA,
      author: {},
      reason: "test",
    });
    const publisher = createOutputPublisherFromConfig(
      config,
      "report",
      undefined,
      "ws",
      event,
    )!;
    const result = await publisher.publishSummary!(
      "summary with 中文 👩‍💻 and @everyone",
      [],
    );
    expect(result).toMatchObject({ channel: "report", status: "published" });
    await publisher.publishSummary!("second flush", []);
    const writes = calls.filter((c) =>
      /chat\.postMessage$|\/messages$|sendMessage$/u.test(c.url),
    );
    expect(writes).toHaveLength(1);
    const body = writes[0]!.body;
    expect(body.channel ?? body.chat_id ?? destination).toBe(destination);
    const text = String(body.text ?? body.content);
    expect(text.length).toBeLessThanOrEqual(
      platform === "discord" ? 1900 : 3900,
    );
    expect(text).toContain("summary");
    expect(writes[0]!.init!.redirect).toBe("error");
    if (platform === "discord")
      expect(body.allowed_mentions).toEqual({ parse: [], replied_user: false });
    if (platform === "telegram") {
      expect(body.parse_mode).toBeUndefined();
      expect(body.entities).toBeInstanceOf(Array);
    }
  },
);
it.each(platforms)(
  "keeps %s explicit rejection distinct from an ambiguous write",
  async (platform) => {
    const { config } = fixture(platform);
    vi.stubGlobal(
      "fetch",
      apiFixture(platform, [], () => new Response("{}", { status: 403 })),
    );
    const publisher = createOutputPublisherFromConfig(
      config,
      "report",
      undefined,
      "ws",
    )!;
    expect(await publisher.publishSummary!("summary", [])).toMatchObject({
      status: "failed",
      raw: { kind: "rejected", code: "http_403" },
    });
  },
);
it.each(platforms)(
  "flushes a %s line-only route using named templates and keeps the problem once",
  async (platform) => {
    const { config } = fixture(platform);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", apiFixture(platform, calls));
    config.outputs.templates = {
      p: "Problem: {{problem.message}}",
      s: "Summary: {{summary}}",
    };
    config.outputs.channels[0]!.templates = { problem: "p", summary: "s" };
    config.workspaces.instances.ws!.outputs = {
      line_comments: ["report"],
      summary: [],
    };
    const event = createReviewEvent({
      triggerName: "git",
      provider: "github",
      workspaceId: "ws",
      targetKind: "commit",
      repoRef: "org/demo",
      headSha: SHA,
      author: {},
      reason: "test",
    });
    const publisher = await createOutputPublisherResolverFromConfig(config)({
      reviewEvent: event,
    });
    const problem = {
      file: "src/a.ts",
      line: 1,
      severity: "high" as const,
      category: "bug",
      message: "unique problem",
      suggestion: "fix",
    };
    await publisher!.publishProblem!(problem);
    await publisher!.publishSummary!("summary", [problem]);
    const writes = calls.filter((c) =>
      /chat\.postMessage$|\/messages$|sendMessage$/u.test(c.url),
    );
    expect(writes).toHaveLength(1);
    const text = String(writes[0]!.body.text ?? writes[0]!.body.content);
    expect(text.match(/unique problem/gu)).toHaveLength(1);
    expect(text).toContain("Summary:");
  },
);
