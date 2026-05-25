import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ChatCompletionClient, ModelSpec } from "@aicr/llm";
import { parseUnifiedDiff, type ChangeRange } from "@aicr/vcs";
import { createStoreDb, closeStoreDb, type StoreDb } from "@aicr/store";
import { getRecentRuns } from "@aicr/store";
import { describe, expect, it } from "vitest";

import { createServerApp } from "../src/index.js";
import { createAicrMetrics } from "../src/metrics.js";

const webhookSecret = "observability-secret";

function sign(payload: string): string {
  return createHmac("sha256", webhookSecret).update(payload).digest("hex");
}

async function writeWorkspaceFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(rootDir, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("server observability integration", () => {
  it("records metrics and saves a run snapshot for inline review processing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-observability-source-"));
    const runsDir = await mkdtemp(join(tmpdir(), "aicr-observability-runs-"));
    const metrics = createAicrMetrics();

    try {
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\nReview concrete defects only.\n");
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ready = false;\nreturn ready;\n");

      const model: ModelSpec = {
        providerKind: "openai_compatible",
        providerId: "test-provider",
        modelId: "test-model",
      };
      const llm: ChatCompletionClient = {
        async complete() {
          return {
            providerId: "test-provider",
            modelId: "test-model",
            content: JSON.stringify({
              toolCalls: [
                {
                  name: "aicr.report_problem",
                  input: {
                    file: "src/app.ts",
                    line: 2,
                    severity: "medium",
                    category: "correctness",
                    message: "The new return path reports not-ready unconditionally.",
                  },
                },
                {
                  name: "aicr.publish_summary",
                  input: { markdown: "Found one issue." },
                },
              ],
            }),
            raw: {},
          };
        },
      };

      const app = createServerApp({
        metrics,
        runsDir,
        gitea: {
          triggerName: "gitea-internal",
          workspaceId: "ws",
          webhookSecret,
        },
        reviewOrchestration: {
          baseSystemPrompt: "<task>{{TASK_CONTEXT}}</task>",
          sourceRootResolver: () => tempDir,
          vcs: {
            kind: "git",
            async listChanges(): Promise<ChangeRange> {
              return { baseRevision: "base-sha", headRevision: "head-sha", files: ["src/app.ts"] };
            },
            async fetchScoped(range, ws) {
              return { workspaceId: ws.id, rootDir: tempDir, fetchedFiles: [...range.files] };
            },
            async fetchExtraContext(req) {
              return { path: req.path, content: "extra context" };
            },
            async diff() {
              return parseUnifiedDiff(
                [
                  "diff --git a/src/app.ts b/src/app.ts",
                  "--- a/src/app.ts",
                  "+++ b/src/app.ts",
                  "@@ -1 +1,2 @@",
                  " const ready = true;",
                  "+return false;",
                ].join("\n"),
              );
            },
          },
          llm,
          model,
          outputPublisher: {
            async publishProblem() {
              return { channel: "test", status: "published", raw: { id: 1 } };
            },
          },
        },
      });

      const payload = JSON.stringify({
        action: "opened",
        repository: { full_name: "owent/example" },
        sender: { login: "owent" },
        pull_request: {
          html_url: "https://gitea.internal.corp/owent/example/pulls/42",
          base: { sha: "base-sha" },
          head: { sha: "head-sha" },
        },
      });

      const response = await app.request("/webhooks/gitea", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitea-event": "pull_request",
          "x-gitea-signature": sign(payload),
        },
        body: payload,
      });
      const body = (await response.json()) as { accepted?: boolean; reviewRun?: { problemCount?: number } };

      expect(response.status).toBe(202);
      expect(body.accepted).toBe(true);
      expect(body.reviewRun?.problemCount).toBe(1);

      const metricsResponse = await app.request("/metrics");
      const metricsText = await metricsResponse.text();
      expect(metricsText).toContain("aicr_reviews_total 1");
      expect(metricsText).toContain("aicr_problems_total 1");
      expect(metricsText).toContain("aicr_review_duration_seconds_count 1");

      const runIds = await readdir(runsDir);
      expect(runIds).toHaveLength(1);
      const runId = runIds[0];
      if (!runId) {
        throw new Error("expected a run snapshot directory");
      }
      const snapshot = JSON.parse(await readFile(join(runsDir, runId, "run.json"), "utf8")) as {
        reviewEvent?: { repoRef?: string };
        reviewRun?: { problemCount?: number };
      };
      expect(snapshot.reviewEvent?.repoRef).toBe("owent/example");
      expect(snapshot.reviewRun?.problemCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  it("persists review run to store when store is configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-observability-store-"));
    const runsDir = await mkdtemp(join(tmpdir(), "aicr-observability-store-runs-"));
    const dbPath = join(tempDir, "obs.db");
    const metrics = createAicrMetrics();
    const store: StoreDb = createStoreDb(dbPath);

    try {
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\nReview concrete defects only.\n");
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ready = false;\nreturn ready;\n");

      const model: ModelSpec = {
        providerKind: "openai_compatible",
        providerId: "test-provider",
        modelId: "test-model",
      };
      const llm: ChatCompletionClient = {
        async complete() {
          return {
            providerId: "test-provider",
            modelId: "test-model",
            content: JSON.stringify({
              toolCalls: [
                {
                  name: "aicr.report_problem",
                  input: {
                    file: "src/app.ts",
                    line: 2,
                    severity: "medium",
                    category: "correctness",
                    message: "The new return path reports not-ready unconditionally.",
                  },
                },
                {
                  name: "aicr.publish_summary",
                  input: { markdown: "Found one issue." },
                },
              ],
            }),
            raw: {},
          };
        },
      };

      const app = createServerApp({
        metrics,
        runsDir,
        store,
        gitea: {
          triggerName: "gitea-internal",
          workspaceId: "ws",
          webhookSecret,
        },
        reviewOrchestration: {
          baseSystemPrompt: "\u003ctask\u003e{{TASK_CONTEXT}}\u003c/task\u003e",
          sourceRootResolver: () => tempDir,
          vcs: {
            kind: "git",
            async listChanges(): Promise<ChangeRange> {
              return { baseRevision: "base-sha", headRevision: "head-sha", files: ["src/app.ts"] };
            },
            async fetchScoped(range, ws) {
              return { workspaceId: ws.id, rootDir: tempDir, fetchedFiles: [...range.files] };
            },
            async fetchExtraContext(req) {
              return { path: req.path, content: "extra context" };
            },
            async diff() {
              return parseUnifiedDiff(
                [
                  "diff --git a/src/app.ts b/src/app.ts",
                  "--- a/src/app.ts",
                  "+++ b/src/app.ts",
                  "@@ -1 +1,2 @@",
                  " const ready = true;",
                  "+return false;",
                ].join("\n"),
              );
            },
          },
          llm,
          model,
          outputPublisher: {
            async publishProblem() {
              return { channel: "test", status: "published", raw: { id: 1 } };
            },
          },
        },
      });

      const payload = JSON.stringify({
        action: "opened",
        repository: { full_name: "owent/example" },
        sender: { login: "owent" },
        pull_request: {
          html_url: "https://gitea.internal.corp/owent/example/pulls/42",
          base: { sha: "base-sha" },
          head: { sha: "head-sha" },
        },
      });

      const response = await app.request("/webhooks/gitea", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitea-event": "pull_request",
          "x-gitea-signature": sign(payload),
        },
        body: payload,
      });
      const body = (await response.json()) as { accepted?: boolean; reviewRun?: { problemCount?: number } };

      expect(response.status).toBe(202);
      expect(body.accepted).toBe(true);

      const runs = getRecentRuns(store, 10);
      expect(runs.length).toBe(1);
      expect(runs[0]!.workspaceId).toBe("ws");
      expect(runs[0]!.status).toBe("succeeded");
      expect(runs[0]!.problemCount).toBe(1);

      const project = store.sqlite
        .prepare("SELECT repo_ref FROM projects WHERE workspace_id = ?")
        .get("ws") as Record<string, string>;
      expect(project.repo_ref).toBe("owent/example");
    } finally {
      closeStoreDb(store);
      await rm(tempDir, { recursive: true, force: true });
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});