import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentAdapter } from "@aicr/agents";
import { createReviewEvent } from "@aicr/core";
import type { ChatCompletionClient, ModelSpec } from "@aicr/llm";
import type { ReviewFinding } from "@aicr/outputs";
import type { SandboxBackend, SandboxSpawnOptions } from "@aicr/sandbox";
import { parseUnifiedDiff, type ChangeRange } from "@aicr/vcs";
import { describe, expect, it } from "vitest";

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
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\nKeep findings focused.\n");
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      let modelPrompt = "";
      const llm: ChatCompletionClient = {
        async complete(input) {
          modelPrompt = input.messages[0]?.content ?? "";
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              findings: [
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
      const published: ReviewFinding[] = [];
      const outputPublisher: ReviewOutputPublisher = {
        async publishFinding(finding) {
          published.push(finding);
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
      expect(result.findingCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.dispatchCount).toBe(1);
      expect(result.diffFileCount).toBe(1);
      expect(modelPrompt).toContain("AGENTS.md");
      expect(modelPrompt).toContain("Diff:");
      expect(modelPrompt).toContain("+2: commitBeforeReturn();");
      expect(published).toEqual([
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

  it("supports fenced JSON skip output without dispatching findings", async () => {
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
            async publishFinding() {
              throw new Error("skip output should not dispatch findings");
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

  it("scrubs secrets and fixes markdown before publishing findings", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-scrub-markdown-"));

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
      const published: ReviewFinding[] = [];

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
            async publishFinding(finding) {
              published.push(finding);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.scrubFindings.length).toBeGreaterThanOrEqual(2);
      expect(published[0]?.message).toBe("# Issue\n- contains <REDACTED:AWS_KEY>\n");
      expect(published[0]?.suggestion).toBe("## Fix\n* replace <REDACTED:GITHUB_TOKEN>\n");
      expect(published[0]?.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(published[0]?.suggestion).not.toContain("ghp_");
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
      expect(summary.findingCount).toBe(result.findingCount);
      expect(summary.summaryCount).toBe(result.summaryCount);
      expect(summary.contextRequestCount).toBe(result.contextRequestCount);
      expect(summary.dispatchCount).toBe(result.dispatchCount);
      expect(summary.model).toEqual(result.model);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("produces a summary without skipReason when findings are published", async () => {
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
                  name: "aicr.publish_finding",
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
            async publishFinding() {
              return { channel: "test", status: "published", externalId: "1", raw: {} };
            },
          },
        },
      );

      const summary = summarizeReviewOrchestrationForWebhook(result);

      expect(summary.status).toBe("published");
      expect(summary.skipReason).toBeUndefined();
      expect(summary.findingCount).toBe(1);
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
              findings: [
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
      expect(result.findingCount).toBe(1);
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

  it("handles the alternative findings/summary format from LLM output", async () => {
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
      const published: ReviewFinding[] = [];
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
            async publishFinding(finding) {
              published.push(finding);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.findingCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(published[0]?.endLine).toBe(5);
      expect(published[0]?.suggestion).toBe("Fix it.");
      expect(published[0]?.fingerprint).toBe("fp-alt");
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
              findings: [
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
      const published: ReviewFinding[] = [];
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
            async publishFinding(finding) {
              published.push(finding);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(published[0]?.endLine).toBe(10);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when LLM output is not valid JSON", async () => {
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
      ).rejects.toThrow(/not valid JSON/u);
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
              findings: [
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
      expect(result.findingCount).toBe(1);
      expect(result.dispatchCount).toBe(0);
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
              findings: [
                { file: "src/app.ts", line: 1, severity: "high", category: "correctness", message: "Issue." },
              ],
            }),
            raw: {},
          };
        },
      };
      const published: ReviewFinding[] = [];

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
            async publishFinding(finding) {
              published.push(finding);
              return { channel: "resolved", status: "published", externalId: "42", raw: {} };
            },
          }),
        },
      );

      expect(result.status).toBe("published");
      expect(result.dispatchCount).toBe(1);
      expect(published).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects LLM JSON output that is not an object", async () => {
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
      ).rejects.toThrow(/must be an object/u);
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

  it("rejects findings entries that are not objects", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-bad-finding-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ findings: ["not-an-object"] }),
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
      ).rejects.toThrow(/finding must be an object/u);
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
  it("rejects findings entries that are Date instances (not plain objects)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-date-finding-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ findings: [new Date()] }),
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
      ).rejects.toThrow(/finding must be an object/u);
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

  it("accepts null-prototype objects as valid findings entries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-nullproto-finding-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const findingObj = Object.create(null);
      findingObj.file = "src/app.ts";
      findingObj.line = 1;
      findingObj.severity = "low";
      findingObj.category = "style";
      findingObj.message = "Minor.";
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ findings: [findingObj] }),
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

      expect(result.findingCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("extractJsonPayload edge cases", () => {
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
              toolCalls: [{ name: "aicr.publish_finding", input: { file: "src/app.ts", line: 1, severity: "low", category: "style", message: "Issue." } }],
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

      expect(result.findingCount).toBe(1);
      expect(result.summaryCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles empty findings array with summary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-empty-findings-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              findings: [],
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

      expect(result.findingCount).toBe(0);
      expect(result.summaryCount).toBe(1);
      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("no_dispatchable_findings");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
