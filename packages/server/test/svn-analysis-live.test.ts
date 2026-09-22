import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createReviewEvent } from "@aicr/core";
import { SvnVcsAdapter } from "@aicr/vcs";
import type { ReviewProblem } from "@aicr/outputs";
import { describe, expect, it, vi } from "vitest";
import { runReviewOrchestration } from "../src/review-orchestrator.js";

const repositoryUrl = process.env.AICR_SVN_TEST_URL;

describe.skipIf(repositoryUrl === undefined)("Podman SVN analysis", () => {
  it("fetches a real revision, builds context, analyses and publishes through orchestration", async () => {
    if (!repositoryUrl) throw new Error("AICR_SVN_TEST_URL must not be empty.");
    const url = new URL(repositoryUrl);
    if (url.protocol !== "svn:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/repo/trunk") {
      throw new Error("Use the disposable with-svn.sh fixture URL.");
    }
    const base = resolve("build/tmp");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "svn-analysis-"));
    try {
      const source = join(root, "source");
      await mkdir(source);
      const complete = vi.fn(async () => ({ providerId: "fixture", modelId: "deterministic", raw: null,
        content: JSON.stringify({ problems: [{ file: "content.txt", line: 1, severity: "high", category: "correctness",
          message: "Synthetic acceptance finding", fingerprint: "svn-analysis" }], summary: "Synthetic acceptance" }) }));
      const publishProblem = vi.fn(async (_problem: ReviewProblem) => ({ channel: "fixture", status: "published" as const }));
      const event = createReviewEvent({ provider: "svn", triggerName: "svn-fixture", workspaceId: "svn-acceptance",
        targetKind: "commit", repoRef: repositoryUrl, baseSha: "1", headSha: "2", author: { username: "bob" },
        reason: "svn:commit", rawEventName: "commit" });
      const result = await runReviewOrchestration({ reviewEvent: event, provider: "svn", eventName: "commit", payload: {} }, {
        baseSystemPrompt: "{{TASK_CONTEXT}}", sourceRootResolver: () => source,
        vcs: new SvnVcsAdapter({ repositoryDir: source, repositoryUrl }),
        model: { providerId: "fixture", modelId: "deterministic", providerKind: "openai_compatible" },
        llm: { complete }, outputPublisher: { publishProblem },
      });
      expect(result.status).toBe("published");
      expect(result.diffFileCount).toBe(1);
      expect(result.preparedPrompt.taskContext).toContain("content.txt");
      expect(result.preparedPrompt.taskContext).toContain("second revision");
      expect(complete).toHaveBeenCalledTimes(1);
      expect(publishProblem).toHaveBeenCalledTimes(1);
      expect(publishProblem.mock.calls[0]?.[0]).toMatchObject({ file: "content.txt", codeSnippet: "second revision" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
