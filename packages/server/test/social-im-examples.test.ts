import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import {
  loadConfigFile,
  compileExecutionGraph,
  resolveOutputChannelsForEvent,
  createReviewEvent,
} from "@aicr/core";
import { createOutputPublisherResolverFromConfig } from "../src/bootstrap.js";
import { platforms, apiFixture, SHA } from "./social-im-fixtures.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it.each(platforms)(
  "loads, compiles and publishes the real %s YAML example",
  async (platform) => {
    vi.stubEnv(
      "AICR_" + platform.toUpperCase() + "_TOKEN",
      platform === "telegram" ? "123456789:test-token" : "test-token",
    );
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", apiFixture(platform, calls));
    const config = await loadConfigFile(
      resolve(
        "example",
        platform === "slack" ? "slack-app.yaml" : platform + "-bot.yaml",
      ),
    );
    const graph = compileExecutionGraph(config);
    const event = createReviewEvent({
      triggerName: "git",
      provider: "github",
      workspaceId: "ws",
      targetKind: "commit",
      repoRef: "org/demo",
      headSha: SHA,
      author: { email: "alice@example.org" },
      reason: "example",
    });
    expect(
      resolveOutputChannelsForEvent(config, graph, event, "ws", "summary"),
    ).toEqual(["report"]);
    const publisher = await createOutputPublisherResolverFromConfig(config)({
      reviewEvent: event,
    });
    expect(publisher).toBeDefined();
    expect(
      await publisher!.publishSummary!("synthetic report", []),
    ).toMatchObject([{ channel: "report", status: "published" }]);
    expect(
      calls.filter((c) =>
        /chat\.postMessage$|\/messages$|sendMessage$/u.test(c.url),
      ),
    ).toHaveLength(1);
    const body = calls.at(-1)!.body;
    if (platform === "telegram") expect(JSON.stringify(body.entities)).toContain("tg://user?id=234567891");
    else expect(String(body.text ?? body.content)).toContain(platform === "slack" ? "<@U234>" : "<@234567891>");
  },
);
