import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentAdapter } from "@aicr/agents";
import { createReviewEvent } from "@aicr/core";
import type { ChatCompletionClient, ModelSpec } from "@aicr/llm";
import type { ReviewProblem } from "@aicr/outputs";
import type { SandboxBackend, SandboxSpawnOptions } from "@aicr/sandbox";
import { parseUnifiedDiff, type ChangeRange } from "@aicr/vcs";
import { describe, expect, it, vi } from "vitest";

import {
  runReviewOrchestration,
  summarizeReviewOrchestrationForWebhook,
  formatParsedDiffForPrompt,
  type DiffCapableVcsAdapter,
  type ReviewOutputPublisher,
} from "../src/review-orchestrator.js";

async function writeWorkspaceFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(rootDir, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

const model: ModelSpec = {
  providerKind: "openai_compatible",
  providerId: "openai-prod",
  modelId: "gpt-test",
};

function createReviewEventFixture() {
  return createReviewEvent({
    triggerName: "gitea-internal",
    provider: "gitea",
    workspaceId: "ws",
    targetKind: "pull_request",
    repoRef: "owent/example",
    baseSha: "base",
    headSha: "head",
    author: { username: "owent" },
    reason: "gitea:opened",
    rawEventName: "pull_request",
  });
}

function createVcs(sourceRoot: string): DiffCapableVcsAdapter {
  return {
    kind: "git",
    async listChanges(): Promise<ChangeRange> {
      return { baseRevision: "base", headRevision: "head", files: ["src/app.ts"] };
    },
    async fetchScoped(range, ws) {
      return { workspaceId: ws.id, rootDir: sourceRoot, fetchedFiles: [...range.files] };
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
          " const value = oldValue();",
          "+commitBeforeReturn();",
        ].join("\n"),
      );
    },
  };
}

describe("runReviewOrchestration", () => {
  it("runs VCS, prompt preparation, LLM JSON tool output, collector, and publisher", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-orchestrator-"));

    try {
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\nKeep problems focused.\n");
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      let modelPrompt = "";
      const llm: ChatCompletionClient = {
        async complete(input) {
          modelPrompt = input.messages[0]?.content ?? "";
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                {
                  file: "src/app.ts",
                  line: 2,
                  severity: "high",
                  category: "correctness",
                  message: "The return path can run before the commit finishes.",
                  suggestion: "Await the commit before returning success.",
                  fingerprint: "fp-commit",
                },
              ],
              summary: "One correctness issue was found.",
            }),
            raw: { id: "chatcmpl-test" },
          };
        },
      };
      const publishedProblems: ReviewProblem[] = [];
      const outputPublisher: ReviewOutputPublisher = {
        async publishProblem(problem) {
          publishedProblems.push(problem);
          return { channel: "gitea-pr", status: "published", externalId: "123", raw: { id: 123 } };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: [
            "<repo>",
            "{{REPO_INSTRUCTION_SUMMARIES}}",
            "</repo>",
            "<task>",
            "{{TASK_CONTEXT}}",
            "</task>",
          ].join("\n"),
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher,
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.dispatchCount).toBe(1);
      expect(result.diffFileCount).toBe(1);
      expect(modelPrompt).toContain("AGENTS.md");
      expect(modelPrompt).toContain("Diff:");
      expect(modelPrompt).toContain("+2: commitBeforeReturn();");
      expect(publishedProblems).toEqual([
        {
          file: "src/app.ts",
          line: 2,
          severity: "high",
          category: "correctness",
          message: "The return path can run before the commit finishes.",
          suggestion: "Await the commit before returning success.",
          fingerprint: "fp-commit",
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports fenced JSON skip output without dispatching problems", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-orchestrator-skip-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = 1;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: "```json\n{\"skipReason\":\"lgtm\"}\n```",
            raw: {},
          };
        },
      };
      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            async publishProblem() {
              throw new Error("skip output should not dispatch problems");
            },
          },
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("lgtm");
      expect(result.dispatchCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scrubs secrets and fixes markdown before publishing problems", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-scrub-markdown-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                {
                  file: "src/app.ts",
                  line: 1,
                  severity: "high",
                  category: "security",
                  message: "#Issue\n-contains AKIAIOSFODNN7EXAMPLE",
                  suggestion: "##Fix\n*replace ghp_abcdefghijklmnopqrstuvwxyz01234567890123",
                },
              ],
            }),
            raw: {},
          };
        },
      };
      const publishedProblems: ReviewProblem[] = [];

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.scrubFindings.length).toBeGreaterThanOrEqual(2);
      expect(publishedProblems[0]?.message).toBe("# Issue\n- contains <REDACTED:AWS_KEY>\n");
      expect(publishedProblems[0]?.suggestion).toBe("## Fix\n* replace <REDACTED:GITHUB_TOKEN>\n");
      expect(publishedProblems[0]?.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(publishedProblems[0]?.suggestion).not.toContain("ghp_");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs an agent through sandbox with the prepared prompt on stdin", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-agent-sandbox-"));
    const originalToken = process.env.AICR_AGENT_TOKEN;
    process.env.AICR_AGENT_TOKEN = "resolved-token";

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const spawnCalls: SandboxSpawnOptions[] = [];
      let teardownCount = 0;
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          return {
            exitCode: 0,
            stdout: JSON.stringify({ skipReason: "lgtm" }),
            stderr: "agent log",
            timedOut: false,
            durationMs: 12,
          };
        },
        async teardown() {
          teardownCount += 1;
        },
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() {
          return { available: true, binary: "kilo" };
        },
        buildCommand(task, spawnOptions) {
          expect(task).toContain("<task>");
          expect(spawnOptions.task).toBe(task);
          expect(spawnOptions.workingDir).toContain("agent");
          return ["kilo", "run", "--auto"];
        },
        async materializeConfig(_model, workingDir) {
          return {
            configFiles: new Map(),
            envVars: { AICR_AGENT_TOKEN: "${AICR_AGENT_TOKEN}" },
            workingDir,
          };
        },
      };
      const llm: ChatCompletionClient = {
        async complete() {
          throw new Error("LLM path should not be used when agent+sandbox are provided");
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          sandbox,
          agentAdapter,
          agentTimeoutMs: 30_000,
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("lgtm");
      expect(result.agentResult?.stdout).toContain("lgtm");
      expect(result.llmResult.raw).toMatchObject({ agent: "kilo", stderr: "agent log" });
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.stdin).toContain("Diff:");
      expect(spawnCalls[0]?.env).toEqual({ AICR_AGENT_TOKEN: "resolved-token" });
      expect(spawnCalls[0]?.timeoutMs).toBe(30_000);
      expect(teardownCount).toBe(1);
    } finally {
      if (originalToken === undefined) {
        delete process.env.AICR_AGENT_TOKEN;
      } else {
        process.env.AICR_AGENT_TOKEN = originalToken;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("formatParsedDiffForPrompt", () => {
  it("returns fallback for undefined diff", () => {
    expect(formatParsedDiffForPrompt(undefined)).toBe("Diff: (not available)");
  });

  it("returns fallback for empty files list", () => {
    expect(formatParsedDiffForPrompt({ files: [] })).toBe("Diff: (not available)");
  });

  it("formats renamed files with arrow notation", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/old.ts b/new.ts",
        "rename from old.ts",
        "rename to new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );
    const formatted = formatParsedDiffForPrompt(diff);

    expect(formatted).toContain("renamed: old.ts -> new.ts");
    expect(formatted).toContain("-1: old");
    expect(formatted).toContain("+1: new");
  });

  it("formats context lines with line numbers", () => {
    const diff = parseUnifiedDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,2 @@",
        " context line",
        "-removed",
        "+added",
      ].join("\n"),
    );
    const formatted = formatParsedDiffForPrompt(diff);

    expect(formatted).toContain(" 1: context line");
  });
});

describe("summarizeReviewOrchestrationForWebhook", () => {
  it("produces a summary with skipReason when present", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-summary-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ skipReason: "lgtm" }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );

      const summary = summarizeReviewOrchestrationForWebhook(result);

      expect(summary.status).toBe("skipped");
      expect(summary.skipReason).toBe("lgtm");
      expect(summary.changedFileCount).toBe(result.changedFiles.length);
      expect(summary.fetchedFileCount).toBe(result.fetchedFiles.length);
      expect(summary.diffFileCount).toBe(result.diffFileCount);
      expect(summary.promptTokenEstimate).toBe(result.promptTokenEstimate);
      expect(summary.problemCount).toBe(result.problemCount);
      expect(summary.summaryCount).toBe(result.summaryCount);
      expect(summary.contextRequestCount).toBe(result.contextRequestCount);
      expect(summary.dispatchCount).toBe(result.dispatchCount);
      expect(summary.model).toEqual(result.model);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("produces a summary without skipReason when problems are published", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-summary-pub-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              toolCalls: [
                {
                  name: "aicr.report_problem",
                  input: {
                    file: "src/app.ts",
                    line: 1,
                    severity: "medium",
                    category: "correctness",
                    message: "Issue found.",
                  },
                },
              ],
            }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            async publishProblem() {
              return { channel: "test", status: "published", externalId: "1", raw: {} };
            },
          },
        },
      );

      const summary = summarizeReviewOrchestrationForWebhook(result);

      expect(summary.status).toBe("published");
      expect(summary.skipReason).toBeUndefined();
      expect(summary.problemCount).toBe(1);
      expect(summary.dispatchCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("runReviewOrchestration error paths", () => {
  it("throws when source root cannot be resolved", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-no-source-"));

    try {
      const llm: ChatCompletionClient = {
        async complete() {
          return { providerId: "test", modelId: "test", content: "{}", raw: {} };
        },
      };

      await expect(
        runReviewOrchestration(
          {
            reviewEvent: createReviewEventFixture(),
            payload: {},
            provider: "gitea",
            eventName: "pull_request",
          },
          {
            baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
            sourceRootResolver: () => undefined,
            vcs: createVcs(tempDir),
            llm,
            model,
          },
        ),
      ).rejects.toThrow("Review orchestration requires a source root.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs in dry-run mode without an output publisher", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-dryrun-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                {
                  file: "src/app.ts",
                  line: 1,
                  severity: "low",
                  category: "style",
                  message: "Minor issue.",
                },
              ],
            }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          dryRun: true,
        },
      );

      expect(result.status).toBe("dry_run");
      expect(result.dispatchCount).toBe(0);
      expect(result.problemCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses taskContextBuilder to override the task context", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-task-override-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      let capturedPrompt = "";
      const llm: ChatCompletionClient = {
        async complete(input) {
          capturedPrompt = input.messages[0]?.content ?? "";
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ skipReason: "lgtm" }),
            raw: {},
          };
        },
      };

      await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          taskContextBuilder: () => "Custom override task context.",
        },
      );

      expect(capturedPrompt).toContain("Custom override task context.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles the legacy findings alias with summary from LLM output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-alt-format-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              findings: [
                {
                  file: "src/app.ts",
                  line: 1,
                  severity: "medium",
                  category: "correctness",
                  message: "Issue via alt format.",
                  endLine: 5,
                  suggestion: "Fix it.",
                  fingerprint: "fp-alt",
                },
              ],
              summary: "One issue found.",
            }),
            raw: {},
          };
        },
      };
      const publishedProblems: ReviewProblem[] = [];
      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(publishedProblems[0]?.endLine).toBe(5);
      expect(publishedProblems[0]?.suggestion).toBe("Fix it.");
      expect(publishedProblems[0]?.fingerprint).toBe("fp-alt");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles camelCase endLine mapping from LLM output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-endline-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                {
                  file: "src/app.ts",
                  line: 1,
                  endLine: 10,
                  severity: "low",
                  category: "style",
                  message: "Range with camelCase.",
                },
              ],
            }),
            raw: {},
          };
        },
      };
      const publishedProblems: ReviewProblem[] = [];
      await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(publishedProblems[0]?.endLine).toBe(10);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats non-JSON LLM output as a natural language summary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-bad-json-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: "not json at all",
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );
      expect(result.status).toBe("skipped");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports skipped status when dryRun is false and no publisher is configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-no-publisher-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                { file: "src/app.ts", line: 1, severity: "low", category: "style", message: "Minor." },
              ],
            }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          dryRun: false,
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("no_output_publisher");
      expect(result.problemCount).toBe(1);
      expect(result.dispatchCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes problems through summary-only channels even when the model omits a summary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-summary-only-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                {
                  file: "src/app.ts",
                  line: 1,
                  severity: "high",
                  category: "security",
                  message: "Leaked AKIAIOSFODNN7EXAMPLE in output.",
                },
              ],
            }),
            raw: {},
          };
        },
      };
      const summarizedProblems: ReviewProblem[][] = [];

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            publishesProblems: false,
            async publishProblem() {
              throw new Error("summary-only publisher should not receive line problems");
            },
            async publishSummary(_summary, problems) {
              summarizedProblems.push([...(problems ?? [])]);
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.dispatchCount).toBe(1);
      expect(result.summaryCount).toBe(0);
      expect(summarizedProblems[0]?.[0]?.message).toContain("<REDACTED:AWS_KEY>");
      expect(summarizedProblems[0]?.[0]?.message).not.toContain("AKIA");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("invokes lifecycle summary publishers even when the model reports no problems", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-empty-lifecycle-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ problems: [] }),
            raw: {},
          };
        },
      };
      const summaryCalls: Array<{ summary: string; problems: readonly ReviewProblem[] | undefined }> = [];

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "push",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            publishesProblems: false,
            publishEmptySummary: true,
            async publishProblem() {
              throw new Error("lifecycle publisher should not receive line problems");
            },
            async publishSummary(summary, problems) {
              summaryCalls.push({ summary, problems });
              return { channel: "gitea-problem-issue", status: "published", raw: { action: "closed" } };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(0);
      expect(result.dispatchCount).toBe(1);
      expect(summaryCalls).toEqual([{ summary: "", problems: [] }]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses outputPublisherResolver for per-event publishing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-publisher-resolver-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                { file: "src/app.ts", line: 1, severity: "high", category: "correctness", message: "Issue." },
              ],
            }),
            raw: {},
          };
        },
      };
      const publishedProblems: ReviewProblem[] = [];

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: { pull_request: { number: 42 } },
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          dryRun: false,
          outputPublisherResolver: () => ({
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "resolved", status: "published", externalId: "42", raw: {} };
            },
          }),
        },
      );

      expect(result.status).toBe("published");
      expect(result.dispatchCount).toBe(1);
      expect(publishedProblems).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks problems outside the parsed diff as non-line-commentable", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-line-fallback-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\ncommitBeforeReturn();\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                { file: "src/app.ts", line: 999, severity: "medium", category: "correctness", message: "Issue." },
              ],
            }),
            raw: {},
          };
        },
      };
      const publishedProblems: ReviewProblem[] = [];

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(publishedProblems[0]?.lineCommentAllowed).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("adds a stable fingerprint before publishing when the model omits one", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-auto-fingerprint-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                { file: "src/app.ts", line: 1, severity: "medium", category: "correctness", message: "Issue." },
              ],
            }),
            raw: {},
          };
        },
      };
      const publishedProblems: ReviewProblem[] = [];

      await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(publishedProblems[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats non-object JSON LLM output as a natural language summary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-array-json-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: "[1,2,3]",
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );
      expect(result.status).toBe("skipped");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects toolCalls entries that are not objects", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-bad-toolcall-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ toolCalls: ["not-an-object"] }),
            raw: {},
          };
        },
      };

      await expect(
        runReviewOrchestration(
          {
            reviewEvent: createReviewEventFixture(),
            payload: {},
            provider: "gitea",
            eventName: "pull_request",
          },
          {
            baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
            sourceRootResolver: () => tempDir,
            vcs: createVcs(tempDir),
            llm,
            model,
          },
        ),
      ).rejects.toThrow(/toolCalls entries must be objects/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a toolCalls field that is not an array", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-toolcalls-not-array-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ toolCalls: "not-an-array" }),
            raw: {},
          };
        },
      };

      await expect(
        runReviewOrchestration(
          {
            reviewEvent: createReviewEventFixture(),
            payload: {},
            provider: "gitea",
            eventName: "pull_request",
          },
          {
            baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
            sourceRootResolver: () => tempDir,
            vcs: createVcs(tempDir),
            llm,
            model,
          },
        ),
      ).rejects.toThrow(/toolCalls must be an array/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown AICR tool names from toolCalls", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-unknown-tool-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ toolCalls: [{ name: "aicr.unknown", input: {} }] }),
            raw: {},
          };
        },
      };

      await expect(
        runReviewOrchestration(
          {
            reviewEvent: createReviewEventFixture(),
            payload: {},
            provider: "gitea",
            eventName: "pull_request",
          },
          {
            baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
            sourceRootResolver: () => tempDir,
            vcs: createVcs(tempDir),
            llm,
            model,
          },
        ),
      ).rejects.toThrow(/Unsupported AICR tool name/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects problem entries that are not objects", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-bad-problem-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ problems: ["not-an-object"] }),
            raw: {},
          };
        },
      };

      await expect(
        runReviewOrchestration(
          {
            reviewEvent: createReviewEventFixture(),
            payload: {},
            provider: "gitea",
            eventName: "pull_request",
          },
          {
            baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
            sourceRootResolver: () => tempDir,
            vcs: createVcs(tempDir),
            llm,
            model,
          },
        ),
      ).rejects.toThrow(/problem must be an object/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("invokes aicr.fetch_more_context tool calls and records context requests via the VCS adapter", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-fetch-more-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const fetchExtraCalls: { path: string; startLine?: number; endLine?: number }[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push({
            path: req.path,
            ...(req.startLine !== undefined ? { startLine: req.startLine } : {}),
            ...(req.endLine !== undefined ? { endLine: req.endLine } : {}),
          });
          return { path: req.path, content: `ctx-${req.path}` };
        },
      };
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              toolCalls: [
                {
                  name: "aicr.fetch_more_context",
                  input: {
                    path: "src/app.ts",
                    range: { start_line: 2, end_line: 4 },
                    reason: "need surrounding control flow",
                  },
                },
                { name: "aicr.skip", input: { reason: "lgtm" } },
              ],
            }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs,
          llm,
          model,
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.contextRequestCount).toBe(1);
      expect(fetchExtraCalls).toEqual([
        { path: "src/app.ts", startLine: 2, endLine: 4 },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores invalid fetch_more_context tool calls without failing the review", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-invalid-fetch-more-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              toolCalls: [
                {
                  name: "aicr.fetch_more_context",
                  input: { path: "", reason: "model requested context without selecting a file" },
                },
                { name: "aicr.skip", input: { reason: "lgtm" } },
              ],
            }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "push",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("lgtm");
      expect(result.contextRequestCount).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ignored invalid fetch_more_context tool call"));
    } finally {
      warnSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("asks for a final result when the model only returns an invalid context request", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-invalid-fetch-follow-up-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      let completeCalls = 0;
      const summaryCalls: string[] = [];
      const llm: ChatCompletionClient = {
        async complete(input) {
          completeCalls += 1;
          if (completeCalls === 1) {
            return {
              providerId: input.model.providerId,
              modelId: input.model.modelId,
              content: JSON.stringify({
                toolCalls: [
                  {
                    name: "aicr.fetch_more_context",
                    input: { path: "", reason: "need more context but no file was selected" },
                  },
                ],
              }),
              raw: {},
            };
          }

          expect(input.messages).toHaveLength(3);
          expect(input.messages[2]?.content).toContain("Changed files:");
          expect(input.messages[2]?.content).toContain("src/app.ts");
          expect(input.messages[2]?.content).toContain("path must be a non-empty string");
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ summary: "Analysis completed; no actionable problems." }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "p4",
          eventName: "change-commit",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            publishesProblems: false,
            async publishProblem() {
              throw new Error("summary-only publisher should not receive line problems");
            },
            async publishSummary(summary) {
              summaryCalls.push(summary);
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.summaryCount).toBe(1);
      expect(result.dispatchCount).toBe(1);
      expect(completeCalls).toBe(2);
      expect(summaryCalls).toEqual(["Analysis completed; no actionable problems."]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ignored invalid fetch_more_context tool call"));
    } finally {
      warnSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("repairs an invalid empty publish_summary tool call and still dispatches to summary channels", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-invalid-summary-follow-up-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      let completeCalls = 0;
      const summaryCalls: string[] = [];
      const llm: ChatCompletionClient = {
        async complete(input) {
          completeCalls += 1;
          if (completeCalls === 1) {
            return {
              providerId: input.model.providerId,
              modelId: input.model.modelId,
              content: JSON.stringify({
                toolCalls: [
                  { name: "aicr.publish_summary", input: { markdown: "" } },
                ],
              }),
              raw: {},
            };
          }

          expect(input.messages[2]?.content).toContain("Ignored invalid review output tool calls:");
          expect(input.messages[2]?.content).toContain("markdown must be a non-empty string");
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ summary: "Analysis completed after format repair." }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "p4",
          eventName: "change-commit",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            publishesProblems: false,
            async publishProblem() {
              throw new Error("summary-only publisher should not receive line problems");
            },
            async publishSummary(summary) {
              summaryCalls.push(summary);
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.summaryCount).toBe(1);
      expect(result.dispatchCount).toBe(1);
      expect(completeCalls).toBe(2);
      expect(summaryCalls).toEqual(["Analysis completed after format repair."]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ignored invalid review output tool call"));
    } finally {
      warnSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes a generated summary when format repair still has no final review output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-fallback-summary-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const summaryCalls: string[] = [];
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              toolCalls: [
                { name: "aicr.publish_summary", input: { markdown: "" } },
              ],
            }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "p4",
          eventName: "change-commit",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          outputPublisher: {
            publishesProblems: false,
            async publishProblem() {
              throw new Error("summary-only publisher should not receive line problems");
            },
            async publishSummary(summary) {
              summaryCalls.push(summary);
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.dispatchCount).toBe(1);
      expect(summaryCalls[0]).toContain("AICR review completed for owent/example@head");
      expect(summaryCalls[0]).toContain("Changed files analyzed: 1");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ignored invalid review output tool call"));
    } finally {
      warnSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("omits the diff section when the VCS adapter does not implement diff()", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-no-diff-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const baseVcs = createVcs(tempDir);
      const vcsWithoutDiff: DiffCapableVcsAdapter = {
        kind: baseVcs.kind,
        listChanges: baseVcs.listChanges.bind(baseVcs),
        fetchScoped: baseVcs.fetchScoped.bind(baseVcs),
        fetchExtraContext: baseVcs.fetchExtraContext.bind(baseVcs),
      };
      let captured = "";
      const llm: ChatCompletionClient = {
        async complete(input) {
          captured = input.messages[0]?.content ?? "";
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ skipReason: "lgtm" }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: vcsWithoutDiff,
          llm,
          model,
        },
      );

      expect(result.diffFileCount).toBe(0);
      expect(captured).toContain("Diff: (not available)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("continues with changed paths when VCS diff fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-diff-fails-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async diff() {
          throw new Error("local history unavailable");
        },
      };
      let captured = "";
      const llm: ChatCompletionClient = {
        async complete(input) {
          captured = input.messages[0]?.content ?? "";
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ skipReason: "lgtm" }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "push",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs,
          llm,
          model,
        },
      );

      expect(result.diffFileCount).toBe(0);
      expect(captured).toContain("Diff: (not available)");
      expect(result.status).toBe("skipped");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses changedPathsResolver to override the changed file list", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-paths-resolver-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ skipReason: "lgtm" }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          changedPathsResolver: () => ["resolver/override.ts"],
        },
      );

      expect(result.changedFiles).toEqual(["resolver/override.ts"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("parseToolCalls with isPlainObject", () => {
  it("rejects problem entries that are Date instances (not plain objects)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-date-problem-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ problems: [new Date()] }),
            raw: {},
          };
        },
      };

      await expect(
        runReviewOrchestration(
          {
            reviewEvent: createReviewEventFixture(),
            payload: {},
            provider: "gitea",
            eventName: "pull_request",
          },
          {
            baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
            sourceRootResolver: () => tempDir,
            vcs: createVcs(tempDir),
            llm,
            model,
          },
        ),
      ).rejects.toThrow(/problem must be an object/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects toolCalls entries with missing name field (serialized from non-plain objects)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-missing-name-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ toolCalls: [{ input: {} }] }),
            raw: {},
          };
        },
      };

      await expect(
        runReviewOrchestration(
          {
            reviewEvent: createReviewEventFixture(),
            payload: {},
            provider: "gitea",
            eventName: "pull_request",
          },
          {
            baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
            sourceRootResolver: () => tempDir,
            vcs: createVcs(tempDir),
            llm,
            model,
          },
        ),
      ).rejects.toThrow(/Unsupported AICR tool name/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts null-prototype objects as valid toolCalls entries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-nullproto-toolcall-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const toolCall = Object.create(null);
      toolCall.name = "aicr.skip";
      toolCall.input = Object.create(null);
      toolCall.input.reason = "lgtm";
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ toolCalls: [toolCall] }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("lgtm");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts null-prototype objects as valid problem entries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-nullproto-problem-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const problemObj = Object.create(null);
      problemObj.file = "src/app.ts";
      problemObj.line = 1;
      problemObj.severity = "low";
      problemObj.category = "style";
      problemObj.message = "Minor.";
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ problems: [problemObj] }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );

      expect(result.problemCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("extractJsonPayload edge cases", () => {
  it("ignores DeepSeek/Kimi-style <think> blocks and parses the final JSON object", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-think-json-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: [
              "<think>先看 {这里不是最终 JSON}，再输出结论。</think>",
              JSON.stringify({
                problems: [
                  { file: "src/app.ts", line: 1, severity: "medium", category: "correctness", message: "Issue." },
                ],
              }),
            ].join("\n"),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );

      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses a JSON fence even when the model adds prose before the conclusion", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-fenced-json-prose-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: "分析完成，最终结论如下：\n```json\n{\"summary\":\"没有发现问题\"}\n```",
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );

      expect(result.problemCount).toBe(0);
      expect(result.summaryCount).toBe(1);
      expect(result.outputState.summaries).toEqual(["没有发现问题"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("strips reasoning blocks from natural-language summary fallback", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-think-summary-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: "<thinking>不应进入摘要</thinking>最终摘要",
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );

      expect(result.outputState.summaries).toEqual(["最终摘要"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles mixed-line toolCalls and alternative format together", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-mixed-format-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              toolCalls: [{ name: "aicr.report_problem", input: { file: "src/app.ts", line: 1, severity: "low", category: "style", message: "Issue." } }],
              summary: "Mixed format output.",
            }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );

      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles empty problems array with summary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-empty-problems-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [],
              summary: "No issues found.",
            }),
            raw: {},
          };
        },
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
        },
      );

      expect(result.problemCount).toBe(0);
      expect(result.summaryCount).toBe(1);
      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("no_dispatchable_problems");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips review with no_changed_files when changedPaths is empty and not dryRun", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-no-files-"));

    try {
      const vcsNoFiles: DiffCapableVcsAdapter = {
        kind: "p4",
        listChanges: async () => ({ headRevision: "1", files: [] }),
        fetchScoped: async (_range, ws) => ({ workspaceId: ws.id, rootDir: tempDir, fetchedFiles: [] }),
        fetchExtraContext: async () => ({ path: "", content: "" }),
        diff: async () => ({ files: [] }),
      };

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "p4",
          eventName: "change-commit",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: vcsNoFiles,
          llm: {
            async complete(input) {
              return {
                providerId: input.model.providerId,
                modelId: input.model.modelId,
                content: "",
                raw: {},
              };
            },
          },
          model,
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("no_changed_files");
      expect(result.changedFiles).toEqual([]);
      expect(result.fetchedFiles).toEqual([]);
      expect(result.diffFileCount).toBe(0);
      expect(result.promptTokenEstimate).toBe(0);
      expect(result.problemCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
