import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { AgentAdapter } from "@aicr/agents";
import { createReviewEvent } from "@aicr/core";
import type { ChatCompletionClient, ModelSpec } from "@aicr/llm";
import type { ReviewProblem } from "@aicr/outputs";
import type { SandboxBackend, SandboxSpawnOptions } from "@aicr/sandbox";
import { createGitVcsAdapter, parseUnifiedDiff, type ChangeRange } from "@aicr/vcs";
import { describe, expect, it, vi } from "vitest";

import {
  runReviewOrchestration,
  summarizeReviewOrchestrationForWebhook,
  formatParsedDiffForPrompt,
  type DiffCapableVcsAdapter,
  type ReviewOrchestrationResult,
  type ReviewOrchestrationContext,
  type ReviewOutputPublisher,
  type ReviewSummaryPublishOptions,
} from "../src/review-orchestrator.js";

const execFileAsync = promisify(execFile);

async function writeWorkspaceFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(rootDir, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function runGit(rootDir: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd: rootDir, encoding: "utf8" });
}

async function commitAll(rootDir: string, author: string, email: string, message: string): Promise<void> {
  await runGit(rootDir, ["add", "."]);
  await runGit(rootDir, [
    "-c",
    `user.name=${author}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "-m",
    message,
  ]);
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
          codeSnippet: "const value = oldValue();\ncommitBeforeReturn();",
          codeLanguage: "ts",
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
      expect(result.scrubMatches.length).toBeGreaterThanOrEqual(2);
      expect(publishedProblems[0]?.message).toBe("# Issue\n\n- contains <REDACTED:AWS_KEY>\n");
      expect(publishedProblems[0]?.suggestion).toBe("## Fix\n\n* replace <REDACTED:GITHUB_TOKEN>\n");
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
      const xdgRoot = String(spawnCalls[0]?.cwd ?? "");
      expect(spawnCalls[0]?.env).toEqual({
        AICR_AGENT_TOKEN: "resolved-token",
        // kilo global config/data isolation rides the same injection as PI_CODING_AGENT_DIR.
        XDG_CONFIG_HOME: join(xdgRoot, ".aicr-xdg-config"),
        XDG_DATA_HOME: join(xdgRoot, ".aicr-xdg-data"),
      });
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

  it("materializes workspace context repositories, mounts them read-only, and lists them in the task prompt", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-context-repos-"));

    try {
      const sourceRoot = join(tempDir, "workspaces", "ws", "source", "repo");
      await writeWorkspaceFile(sourceRoot, "src/app.ts", "const ok = true;\n");
      const auxHostDir = join(tempDir, "workspaces", "ws", "context-repos", "shared-lib");
      await mkdir(auxHostDir, { recursive: true });

      const materializeCalls: { contextReposRoot: string; repos: readonly unknown[] }[] = [];
      const materializedLayouts: { extraMounts?: readonly unknown[] }[] = [];
      const sandbox: SandboxBackend = {
        kind: "docker",
        async materializeFs(layout) {
          materializedLayouts.push(layout);
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ skipReason: "lgtm" }),
            stderr: "",
            timedOut: false,
            durationMs: 5,
          };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() {
          return { available: true, binary: "kilo" };
        },
        buildCommand() {
          return ["kilo", "run"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
        },
      };
      const llm: ChatCompletionClient = {
        async complete() {
          throw new Error("LLM path should not be used when agent+sandbox are provided");
        },
      };

      const contextRepositories = [
        { alias: "shared-lib", kind: "git" as const, url: "https://github.com/org/shared-lib.git", ref: "main" },
        { alias: "broken-lib", kind: "svn" as const, repository_url: "https://svn.example.com/repos/broken" },
      ];

      let agentTask = "";
      const capturingAdapter: AgentAdapter = {
        ...agentAdapter,
        buildCommand(task, spawnOptions) {
          agentTask = task;
          return agentAdapter.buildCommand(task, spawnOptions);
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
          sourceRootResolver: () => sourceRoot,
          vcs: createVcs(sourceRoot),
          llm,
          model,
          sandbox,
          agentAdapter: capturingAdapter,
          contextRepositoriesResolver: (workspaceId) =>
            workspaceId === "ws" ? contextRepositories : undefined,
          contextRepoMaterializer: async (materializeOptions) => {
            materializeCalls.push(materializeOptions);
            return [
              {
                alias: "shared-lib",
                kind: "git",
                hostDir: auxHostDir,
                status: "ok",
                resolvedRevision: "abc123",
                fileCount: 3,
                totalBytes: 1024,
              },
              {
                alias: "broken-lib",
                kind: "svn",
                hostDir: join(tempDir, "workspaces", "ws", "context-repos", "broken-lib"),
                status: "failed",
                error: "connection refused",
              },
            ];
          },
        },
      );

      expect(result.status).toBe("skipped");
      expect(materializeCalls).toHaveLength(1);
      expect(materializeCalls[0]?.contextReposRoot).toBe(join(tempDir, "workspaces", "ws", "context-repos"));
      expect(materializeCalls[0]?.repos).toEqual(contextRepositories);

      const extraMounts = materializedLayouts[0]?.extraMounts ?? [];
      expect(extraMounts).toEqual([
        {
          hostPath: auxHostDir,
          containerPath: "/workspace/context-repos/shared-lib",
          readOnly: true,
        },
      ]);

      expect(agentTask).toContain("Auxiliary context repositories");
      expect(agentTask).toContain("/workspace/context-repos/shared-lib");
      expect(agentTask).toContain("abc123");
      expect(agentTask).not.toContain("broken-lib");

      expect(result.contextRepositories).toHaveLength(2);
      expect(result.contextRepositories?.[1]?.status).toBe("failed");

      const webhookSummary = summarizeReviewOrchestrationForWebhook(result);
      expect(webhookSummary.contextRepositories).toEqual([
        {
          alias: "shared-lib",
          kind: "git",
          status: "ok",
          resolvedRevision: "abc123",
          fileCount: 3,
          totalBytes: 1024,
        },
        {
          alias: "broken-lib",
          kind: "svn",
          status: "failed",
          error: "connection refused",
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips context repository materialization on the direct-LLM path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-context-repos-direct-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const materializer = vi.fn();
      const llm: ChatCompletionClient = {
        async complete() {
          return {
            providerId: model.providerId,
            modelId: model.modelId,
            content: JSON.stringify({ skipReason: "lgtm" }),
            raw: null,
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
          contextRepositoriesResolver: () => [
            { alias: "shared-lib", kind: "git", url: "https://github.com/org/shared-lib.git" },
          ],
          contextRepoMaterializer: materializer,
        },
      );

      expect(result.status).toBe("skipped");
      expect(materializer).not.toHaveBeenCalled();
      expect(result.contextRepositories).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects context overflow in kilo agent JSON stream and throws AgentContextOverflowError", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-agent-overflow-stream-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "error",
              error: {
                name: "ContextOverflowError",
                data: {
                  message:
                    "Invalid request: Your request exceeded model token limit: 262144 (requested: 362661)",
                },
              },
            }),
            stderr: "",
            timedOut: false,
            durationMs: 10,
          };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() {
          return { available: true, binary: "kilo" };
        },
        buildCommand() {
          return ["kilo", "run"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
        },
      };
      const llm: ChatCompletionClient = { async complete() { throw new Error("unused"); } };

      await expect(
        runReviewOrchestration(
          {
            reviewEvent: createReviewEventFixture(),
            payload: {},
            provider: "gitea",
            eventName: "pull_request",
          },
          {
            baseSystemPrompt: "{{TASK_CONTEXT}}",
            sourceRootResolver: () => tempDir,
            vcs: createVcs(tempDir),
            llm,
            model,
            sandbox,
            agentAdapter,
          },
        ),
      ).rejects.toThrow(/context window overflow/iu);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects context overflow on non-zero agent exit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-agent-overflow-exit-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Error: context length exceeded (max 200000 tokens)",
            timedOut: false,
            durationMs: 10,
          };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "opencode",
        async detect() {
          return { available: true, binary: "opencode" };
        },
        buildCommand() {
          return ["opencode", "run"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
        },
      };
      const llm: ChatCompletionClient = { async complete() { throw new Error("unused"); } };

      await expect(
        runReviewOrchestration(
          {
            reviewEvent: createReviewEventFixture(),
            payload: {},
            provider: "gitea",
            eventName: "pull_request",
          },
          {
            baseSystemPrompt: "{{TASK_CONTEXT}}",
            sourceRootResolver: () => tempDir,
            vcs: createVcs(tempDir),
            llm,
            model,
            sandbox,
            agentAdapter,
          },
        ),
      ).rejects.toThrow(/context window overflow/iu);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("repairs free-form agent stdout before publishing summary-channel results", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-agent-freeform-repair-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      const spawnCalls: SandboxSpawnOptions[] = [];
      let spawnCount = 0;
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
          spawnCount += 1;
          if (spawnCount === 1) {
            const usageEvents = Array.from({ length: 8 }, () => ({
              type: "step_finish",
              part: {
                type: "step-finish",
                tokens: { input: 86_250, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
              },
            }));
            return {
              exitCode: 0,
              stdout: [
                {
                  type: "text",
                  part: {
                    text: [
                      "Looking at this diff, I need to understand the session iteration behavior.",
                      "Based on my analysis, let me report my findings.",
                      "审查完成。发现 1 个问题：提交前返回可能跳过必要状态。",
                    ].join("\n"),
                  },
                },
                ...usageEvents,
              ].map((event) => JSON.stringify(event)).join("\n"),
              stderr: "",
              timedOut: false,
              durationMs: 10,
            };
          }

          const repairUsage = [
            { input: 15_431, output: 304 },
            { input: 15_431, output: 304 },
            { input: 15_431, output: 304 },
            { input: 15_433, output: 305 },
          ];
          return {
            exitCode: 0,
            stdout: [
              {
                type: "text",
                part: {
                  text: JSON.stringify({
                    toolCalls: [
                      {
                        name: "aicr.report_problem",
                        input: {
                          file: "src/app.ts",
                          line: 2,
                          severity: "medium",
                          category: "correctness",
                          message: "新增路径在提交完成前返回，触发成功响应时可能跳过必要状态更新。",
                          suggestion: "等待提交完成后再返回成功。",
                        },
                      },
                      {
                        name: "aicr.publish_summary",
                        input: { markdown: "结构化复查完成。发现 1 个问题。" },
                      },
                    ],
                  }),
                },
              },
              ...repairUsage.map((tokens) => ({
                type: "step_finish",
                part: {
                  type: "step-finish",
                  tokens: { ...tokens, reasoning: 0, cache: { read: 0, write: 0 } },
                  cost: 0,
                },
              })),
            ].map((event) => JSON.stringify(event)).join("\n"),
            stderr: "",
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
        buildCommand() {
          return ["kilo", "run", "--auto"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
        },
      };
      const llm: ChatCompletionClient = {
        async complete() {
          throw new Error("LLM path should not be used when agent+sandbox are provided");
        },
      };
      const summaryCalls: { summary: string; problems: readonly ReviewProblem[] }[] = [];

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
          outputPublisher: {
            publishesProblems: false,
            async publishProblem() {
              throw new Error("summary-only publisher should not receive line problems");
            },
            async publishSummary(summary, problems) {
              summaryCalls.push({ summary, problems: problems ?? [] });
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.dispatchCount).toBe(1);
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[1]?.stdin).toContain("previous stdout was free-form text");
      expect(teardownCount).toBe(2);
      expect(summaryCalls[0]?.summary).toBe("结构化复查完成。发现 1 个问题。");
      expect(summaryCalls[0]?.summary).not.toContain("Looking at this diff");
      expect(summaryCalls[0]?.problems[0]).toMatchObject({
        file: "src/app.ts",
        line: 2,
        severity: "medium",
        category: "correctness",
      });
      expect(result.llmResult.usage).toMatchObject({
        promptTokens: 690_000 + 61_726,
        completionTokens: 1_217,
        totalTokens: 690_000 + 61_726 + 1_217,
      });
      const webhookSummary = summarizeReviewOrchestrationForWebhook(result);
      expect(webhookSummary.requestCount).toBe(12);
      expect(webhookSummary.llmUsage?.totalTokens).toBe(752_943);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fetches MCP state context requests before accepting inaccessible-code summaries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-mcp-state-context-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      const fetchExtraCalls: string[] = [];
      const attributionCalls: string[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push(req.path);
          return { path: req.path, content: "const value = oldValue();\ncommitBeforeReturn();\n" };
        },
        async fetchAttribution(req) {
          attributionCalls.push(req.path);
          return {
            path: req.path,
            status: "ok",
            entries: [{ line: req.startLine ?? 1, revision: "r1", author: "Alice" }],
          };
        },
      };
      const spawnCalls: SandboxSpawnOptions[] = [];
      let spawnCount = 0;
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          spawnCount += 1;
          const statePath = join(spawnOptions.cwd, ".aicr-output-state.json");
          const manifest = JSON.parse(await readFile(join(spawnOptions.cwd, "manifest.json"), "utf8")) as {
            readonly mcpTools: readonly string[];
          };
          expect(manifest.mcpTools).toContain("aicr.try_blame");
          if (spawnCount === 1) {
            await writeFile(statePath, JSON.stringify({
              problems: [],
              summaries: [{ markdown: "无法访问完整仓库代码，无法验证该变更。" }],
              contextRequests: [{ path: "src/app.ts", reason: "需要完整仓库代码验证提交路径。" }],
              attributionRequests: [
                {
                  path: "src/app.ts",
                  range: { start_line: 2, end_line: 2 },
                  reason: "需要 VCS 归因验证该行。",
                },
              ],
            }), "utf8");
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 10 };
          }

          expect(spawnOptions.stdin).toContain("Fetched context:");
          expect(spawnOptions.stdin).toContain("commitBeforeReturn");
          expect(spawnOptions.stdin).toContain('"author": "Alice"');
          await writeFile(statePath, JSON.stringify({
            problems: [
              {
                file: "src/app.ts",
                line: 2,
                severity: "medium",
                category: "correctness",
                message: "新增路径在提交完成前返回，调用方可能观察到未提交状态。",
              },
            ],
            summaries: [{ markdown: "补拉上下文后发现 1 个问题。" }],
            contextRequests: [],
          }), "utf8");
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 12 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() {
          return { available: true, binary: "kilo" };
        },
        buildCommand() {
          return ["kilo", "run", "--auto"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          vcs,
          llm: {
            async complete() {
              throw new Error("LLM path should not be used when agent produces MCP state outputs");
            },
          },
          model,
          sandbox,
          agentAdapter,
          outputPublisher: {
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
            async publishSummary() {
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.contextRequestCount).toBe(1);
      expect(fetchExtraCalls).toEqual(["src/app.ts"]);
      expect(attributionCalls).toEqual(["src/app.ts"]);
      expect(spawnCalls).toHaveLength(2);
      expect(publishedProblems[0]?.file).toBe("src/app.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("re-verifies MCP state problems against fetched context in a follow-up pass", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-mcp-problem-context-follow-up-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      const fetchExtraCalls: string[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push(req.path);
          return { path: req.path, content: "export function relatedContract(): boolean;\n" };
        },
      };
      const spawnCalls: SandboxSpawnOptions[] = [];
      let spawnCount = 0;
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          spawnCount += 1;
          const statePath = join(spawnOptions.cwd, ".aicr-output-state.json");
          if (spawnCount === 1) {
            await writeFile(statePath, JSON.stringify({
              problems: [
                {
                  file: "src/app.ts",
                  line: 2,
                  severity: "high",
                  category: "correctness",
                  message: "Reported while the related contract was still pending fetch; to be re-verified.",
                },
              ],
              summaries: [{ markdown: "发现 1 个问题，另有待复核事项（上下文受限）。" }],
              contextRequests: [
                { path: "src/related.ts", reason: "需要相关接口契约复核已报告的问题。" },
              ],
            }), "utf8");
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 10 };
          }

          expect(spawnOptions.stdin).toContain("reported problems while its aicr.fetch_more_context requests were still pending");
          expect(spawnOptions.stdin).toContain("Fetched context:");
          expect(spawnOptions.stdin).toContain("--- src/related.ts ---");
          expect(spawnOptions.stdin).toContain("relatedContract");
          await writeFile(statePath, JSON.stringify({
            problems: [
              {
                file: "src/app.ts",
                line: 2,
                severity: "high",
                category: "correctness",
                message: "Confirmed against the fetched contract: the changed call violates it.",
              },
            ],
            summaries: [{ markdown: "补拉契约后确认 1 个问题。" }],
            contextRequests: [],
          }), "utf8");
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 12 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() {
          return { available: true, binary: "kilo" };
        },
        buildCommand() {
          return ["kilo", "run", "--auto"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          vcs,
          llm: {
            async complete() {
              throw new Error("LLM path should not be used when agent produces MCP state outputs");
            },
          },
          model,
          sandbox,
          agentAdapter,
          outputPublisher: {
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
            async publishSummary() {
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.contextRequestCount).toBe(1);
      expect(fetchExtraCalls).toEqual(["src/related.ts"]);
      expect(spawnCalls).toHaveLength(2);
      expect(publishedProblems[0]?.message).toBe("Confirmed against the fetched contract: the changed call violates it.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not double-collect problems when MCP state and agent stdout both contain them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-mcp-dedup-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\n");
      const publishedProblems: ReviewProblem[] = [];
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          const statePath = join(spawnOptions.cwd, ".aicr-output-state.json");
          const problemData = {
            file: "src/app.ts",
            line: 1,
            severity: "high",
            category: "bug",
            message: "Critical null pointer dereference.",
          };
          await writeFile(statePath, JSON.stringify({
            problems: [problemData],
            summaries: [{ markdown: "Found 1 problem." }],
            contextRequests: [],
          }), "utf8");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              problems: [problemData],
              summary: "Found 1 problem.",
            }),
            stderr: "",
            timedOut: false,
            durationMs: 10,
          };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() {
          return { available: true, binary: "kilo" };
        },
        buildCommand() {
          return ["kilo", "run", "--auto"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: {
            async complete() {
              throw new Error("LLM path should not be used");
            },
          },
          model,
          sandbox,
          agentAdapter,
          outputPublisher: {
            publishesProblems: true,
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
            async publishSummary() {
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(publishedProblems).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses Kilo stream tool-call events as context requests when MCP state is absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-kilo-stream-context-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      const fetchExtraCalls: string[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push(req.path);
          return { path: req.path, content: "const value = oldValue();\ncommitBeforeReturn();\n" };
        },
      };
      const spawnCalls: SandboxSpawnOptions[] = [];
      let spawnCount = 0;
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          spawnCount += 1;
          if (spawnCount === 1) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                type: "tool_call",
                name: "aicr-output_aicr_fetch_more_context",
                input: { path: "src/app.ts", reason: "Need the full changed file before deciding." },
              }),
              stderr: "",
              timedOut: false,
              durationMs: 10,
            };
          }

          expect(spawnOptions.stdin).toContain("Fetched context:");
          expect(spawnOptions.stdin).toContain("commitBeforeReturn");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              toolCalls: [
                {
                  name: "aicr.report_problem",
                  input: {
                    file: "src/app.ts",
                    line: 2,
                    severity: "medium",
                    category: "correctness",
                    message: "成功路径在提交完成前返回。",
                  },
                },
              ],
            }),
            stderr: "",
            timedOut: false,
            durationMs: 12,
          };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() {
          return { available: true, binary: "kilo" };
        },
        buildCommand() {
          return ["kilo", "run", "--auto"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: {
            async complete() {
              throw new Error("direct LLM should not be used when stream tool calls can be repaired by agent");
            },
          },
          model,
          sandbox,
          agentAdapter,
          outputPublisher: {
            async publishProblem() {
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.contextRequestCount).toBe(1);
      expect(fetchExtraCalls).toEqual(["src/app.ts"]);
      expect(spawnCalls).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips when agent repair prose says the changed file has no reviewable code", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-agent-no-reviewable-code-"));

    try {
      await writeWorkspaceFile(tempDir, "W_PrxCraftCostEntry.lua", "");
      const spawnCalls: SandboxSpawnOptions[] = [];
      let spawnCount = 0;
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          spawnCount += 1;
          return {
            exitCode: 0,
            stdout: spawnCount === 1
              ? "审查完成，稍后输出结构化结果。"
              : "审查完成。文件 `W_PrxCraftCostEntry.lua` 内容为空，无代码可审查，未发现可操作的问题。",
            stderr: "",
            timedOut: false,
            durationMs: 10,
          };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() {
          return { available: true, binary: "kilo" };
        },
        buildCommand() {
          return ["kilo", "run", "--auto"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
        },
      };
      const llm: ChatCompletionClient = {
        async complete() {
          throw new Error("direct LLM fallback should not be needed for no-reviewable-code output");
        },
      };
      const summaryCalls: string[] = [];

      const result = await runReviewOrchestration(
        {
          reviewEvent: createReviewEvent({
            triggerName: "p4-main",
            provider: "p4",
            workspaceId: "p4-main",
            targetKind: "commit",
            repoRef: "//Prx/Prx_Main",
            headSha: "6576",
            changedFiles: ["W_PrxCraftCostEntry.lua"],
            author: { username: "p4-program" },
            reason: "p4:change-commit",
            rawEventName: "change-commit",
          }),
          payload: {},
          provider: "p4",
          eventName: "change-commit",
        },
        {
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          sourceRootResolver: () => tempDir,
          vcs: {
            ...createVcs(tempDir),
            async listChanges(): Promise<ChangeRange> {
              return { headRevision: "6576", files: ["W_PrxCraftCostEntry.lua"] };
            },
          },
          llm,
          model,
          sandbox,
          agentAdapter,
          outputPublisher: {
            publishesProblems: false,
            noProblemsAction: "publish_if_summary",
            async publishProblem() {
              throw new Error("no-reviewable-code output should not dispatch line problems");
            },
            async publishSummary(summary) {
              summaryCalls.push(summary);
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("no_reviewable_code");
      expect(result.problemCount).toBe(0);
      expect(result.summaryCount).toBe(0);
      expect(result.dispatchCount).toBe(0);
      expect(spawnCalls).toHaveLength(2);
      expect(summaryCalls).toEqual([]);
      expect(result.outputState.summaries).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recognizes kilo 7.x `tool` events (name under event.tool, input under event.state.input)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-kilo-tool-event-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\n");
      // kilo >=7 emits tool calls as `tool` events with the tool name under `event.tool`
      // (namespaced as <server>_<tool>) and the input under `event.state.input`. This must
      // be recognized the same way as the legacy `tool_call`/`tool_use` events.
      const kiloStream = [
        {
          type: "tool",
          tool: "aicr-output_aicr_report_problem",
          callID: "call_test",
          state: {
            status: "completed",
            input: {
              file: "src/app.ts",
              line: 1,
              severity: "high",
              category: "correctness",
              message: "Bug found via kilo 7.x tool event.",
            },
          },
        },
        {
          type: "step_finish",
          part: { type: "step-finish", tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
        },
      ].map((e) => JSON.stringify(e)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: kiloStream, stderr: "", timedOut: false, durationMs: 7 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() { return { available: true, binary: "kilo" }; },
        buildCommand() { return ["kilo", "run", "--auto"]; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
          outputPublisher: {
            async publishProblem() {
              return { channel: "test", status: "published", externalId: "1", raw: {} };
            },
          },
        },
      );

      expect(result.outputState.problems).toHaveLength(1);
      expect(result.outputState.problems[0]?.message).toBe("Bug found via kilo 7.x tool event.");
      expect(result.llmResult.usage?.promptTokens).toBe(100);
      expect(result.llmResult.usage?.completionTokens).toBe(5);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to direct LLM when agent repair remains unstructured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-agent-direct-llm-fallback-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      const spawnCalls: SandboxSpawnOptions[] = [];
      let spawnCount = 0;
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          spawnCount += 1;
          const text = spawnCount === 1
            ? "Found a critical issue: the success path can return before committing state."
            : "I still found a critical issue, but I am not emitting JSON.";
          return {
            exitCode: 0,
            stdout: [
              { type: "text", part: { text } },
              {
                type: "step_finish",
                part: {
                  type: "step-finish",
                  tokens: {
                    input: spawnCount === 1 ? 1_000 : 2_000,
                    output: spawnCount === 1 ? 10 : 20,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                  cost: spawnCount === 1 ? 0.01 : 0.02,
                },
              },
            ].map((event) => JSON.stringify(event)).join("\n"),
            stderr: "",
            timedOut: false,
            durationMs: 11,
          };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() {
          return { available: true, binary: "kilo" };
        },
        buildCommand() {
          return ["kilo", "run", "--auto"];
        },
        async materializeConfig(_model, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
        },
      };
      let llmCalls = 0;
      const llm: ChatCompletionClient = {
        async complete(input) {
          llmCalls += 1;
          expect(input.messages[1]?.content).toContain("not emitting JSON");
          expect(input.messages[2]?.content).toContain("previous stdout was free-form text");
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              toolCalls: [
                {
                  name: "aicr.report_problem",
                  input: {
                    file: "src/app.ts",
                    line: 2,
                    severity: "critical",
                    category: "correctness",
                    message: "成功路径在状态提交前返回，调用方收到成功后可能观察到未提交状态。",
                  },
                },
                {
                  name: "aicr.publish_summary",
                  input: { markdown: "Direct LLM structured repair completed. Found 1 critical issue." },
                },
              ],
            }),
            usage: { promptTokens: 300, completionTokens: 30, totalTokens: 330 },
            estimatedCostUsd: 0.03,
            retryCount: 1,
            fallbackCount: 0,
            raw: {},
          };
        },
      };
      const summaryCalls: { summary: string; problems: readonly ReviewProblem[] }[] = [];

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
          outputPublisher: {
            publishesProblems: false,
            async publishProblem() {
              throw new Error("summary-only publisher should not receive line problems");
            },
            async publishSummary(summary, problems) {
              summaryCalls.push({ summary, problems: problems ?? [] });
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.dispatchCount).toBe(1);
      expect(result.agentResult?.stdout).toContain("not emitting JSON");
      expect(spawnCalls).toHaveLength(2);
      expect(llmCalls).toBe(1);
      expect(summaryCalls[0]?.summary).toBe("Direct LLM structured repair completed. Found 1 critical issue.");
      expect(result.llmResult.usage).toEqual({
        promptTokens: 3_300,
        completionTokens: 60,
        totalTokens: 3_360,
      });
      const webhookSummary = summarizeReviewOrchestrationForWebhook(result);
      expect(webhookSummary).toMatchObject({
        usageSource: "mixed",
        estimatedCostUsd: 0.06,
        requestCount: 3,
        retryCount: 1,
        fallbackCount: 0,
      });
      expect(summaryCalls[0]?.problems[0]).toMatchObject({
        file: "src/app.ts",
        line: 2,
        severity: "critical",
      });
    } finally {
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
    expect(formatted).toContain("-N lines are deleted old code");
    expect(formatted).toContain("-1: old");
    expect(formatted).toContain("[deleted old code; not current]");
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

  it("forwards real LLM usage through the summary on the direct LLM path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-summary-usage-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ skipReason: "lgtm" }),
            usage: {
              promptTokens: 1234,
              completionTokens: 56,
              totalTokens: 1290,
              cachedPromptTokens: 100,
            },
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

      expect(summary.llmUsage).toMatchObject({
        promptTokens: 1234,
        completionTokens: 56,
        totalTokens: 1290,
        cachedPromptTokens: 100,
      });
      expect(summary.usageSource).toBe("llm_gateway");
      expect(summary.requestCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("aggregates kilo step-finish token events and tags usageSource as agent_stdout", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-kilo-step-finish-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      // Two step-finish events (two model turns) in current kilo's part-wrapped format.
      // Kilo (>=7.x / opencode >=1.15) emits { type:"step_finish", part:{ type:"step-finish",
      // tokens:{input,output,reasoning,cache:{read,write}}, cost } }. Tokens must be
      // summed across turns and the field layout matches the actual NDJSON schema.
      // Kilo's counters are DISJOINT: `input` is non-cached prompt tokens and
      // total = input + output + reasoning + cache.read + cache.write.
      // The text event carries a skipReason so the run resolves to a skip.
      const kiloStream = [
        { type: "text", text: JSON.stringify({ skipReason: "lgtm" }) },
        {
          type: "step_finish",
          part: {
            type: "step-finish",
            reason: "tool-calls",
            tokens: { input: 13193, output: 13, reasoning: 42, cache: { write: 0, read: 704 } },
            cost: 0.001,
          },
        },
        {
          type: "step_finish",
          part: {
            type: "step-finish",
            reason: "stop",
            tokens: { input: 4790, output: 200, reasoning: 0, cache: { write: 10, read: 0 } },
            cost: 0.002,
          },
        },
      ].map((e) => JSON.stringify(e)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: kiloStream, stderr: "", timedOut: false, durationMs: 99 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() { return { available: true, binary: "kilo" }; },
        buildCommand() { return ["kilo", "run", "--auto"]; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
        },
      );

      const summary = summarizeReviewOrchestrationForWebhook(result);

      // Kilo counters are folded into the project convention: promptTokens = input + cache
      // read/write (total input incl. cache), completionTokens = output + reasoning.
      // step1: prompt 13193+704+0=13897, completion 13+42=55; step2: prompt 4790+0+10=4800,
      // completion 200+0=200. Sums: prompt 18697, completion 255.
      // totalTokens falls back to promptTokens+completionTokens=18952 since kilo's
      // per-step tokens omit `total` (the aggregate total is only reported on the
      // session summary, not on each step-finish event).
      expect(summary.llmUsage).toMatchObject({
        promptTokens: 13897 + 4800,
        completionTokens: 55 + 200,
        totalTokens: 18697 + 255,
        cachedPromptTokens: 704,
        cacheCreationTokens: 10,
      });
      // In + Out must equal Total so the dashboard breakdown reconciles.
      expect((summary.llmUsage?.promptTokens ?? 0) + (summary.llmUsage?.completionTokens ?? 0))
        .toBe(summary.llmUsage?.totalTokens);
      expect(summary.usageSource).toBe("agent_stdout");
      expect(summary.requestCount).toBe(2);
      expect(summary.estimatedCostUsd).toBeCloseTo(0.003, 5);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("redirects XDG config/data dirs to bundle-local paths for kilo runs", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-kilo-xdg-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      // kilo schema-strictly validates the global $XDG_CONFIG_HOME/kilo config too,
      // so the orchestrator must redirect it away from the developer's host config.
      const kiloStream = [{ type: "text", text: JSON.stringify({ skipReason: "lgtm" }) }]
        .map((e) => JSON.stringify(e))
        .join("\n");
      const spawnCalls: SandboxSpawnOptions[] = [];
      let bundleManifest: { envKeys?: string[] } | undefined;
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          bundleManifest = JSON.parse(await readFile(join(spawnOptions.cwd, "manifest.json"), "utf8")) as {
            envKeys?: string[];
          };
          return { exitCode: 0, stdout: kiloStream, stderr: "", timedOut: false, durationMs: 9 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() { return { available: true, binary: "kilo" }; },
        buildCommand() { return ["kilo", "run", "--auto"]; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
        },
      );

      const agentSpawn = spawnCalls[0];
      const agentDir = String(agentSpawn?.cwd ?? "");
      expect(agentSpawn?.env?.XDG_CONFIG_HOME).toBe(join(agentDir, ".aicr-xdg-config"));
      expect(agentSpawn?.env?.XDG_DATA_HOME).toBe(join(agentDir, ".aicr-xdg-data"));
      expect(bundleManifest?.envKeys).toContain("XDG_DATA_HOME");
      expect(agentSpawn?.env?.PI_CODING_AGENT_DIR).toBeUndefined();
      expect(bundleManifest?.envKeys).toContain("XDG_CONFIG_HOME");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("omits llmUsage when an agent run emits no step-finish events", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-kilo-no-usage-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      // Stream has only a text event carrying a skipReason — no step-finish → no usage.
      const kiloStream = [
        { type: "text", text: JSON.stringify({ skipReason: "lgtm" }) },
      ].map((e) => JSON.stringify(e)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: kiloStream, stderr: "", timedOut: false, durationMs: 5 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "kilo",
        async detect() { return { available: true, binary: "kilo" }; },
        buildCommand() { return ["kilo", "run", "--auto"]; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
        },
      );

      const summary = summarizeReviewOrchestrationForWebhook(result);

      // No usage captured: keep the separate prompt estimate, but do not fabricate
      // billable llmUsage from it.
      expect(summary.llmUsage).toBeUndefined();
      expect(summary.usageSource).toBeUndefined();
      expect(summary.estimatedCostUsd).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses current opencode tool_use and step_finish events", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-opencode-stream-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const ndjsonStream = [
        {
          type: "tool_use",
          part: {
            type: "tool",
            tool: "aicr-output_aicr_report_problem",
            state: {
              status: "completed",
              input: {
                file: "src/app.ts",
                line: 1,
                severity: "medium",
                category: "correctness",
                message: "OpenCode part-wrapped tool output.",
              },
            },
          },
        },
        {
          type: "step_finish",
          part: {
            type: "step-finish",
            reason: "stop",
            tokens: { input: 1000, output: 50, reasoning: 0, cache: { write: 0, read: 200 } },
            cost: 0.005,
          },
        },
      ].map((e) => JSON.stringify(e)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: ndjsonStream, stderr: "", timedOut: false, durationMs: 9 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "opencode",
        async detect() { return { available: true, binary: "opencode" }; },
        buildCommand() { return ["opencode", "run", "--format", "json"]; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
          outputPublisher: {
            async publishProblem() {
              return { channel: "test", status: "published", externalId: "1", raw: {} };
            },
          },
        },
      );

      expect(result.outputState.problems).toHaveLength(1);
      expect(result.outputState.problems[0]?.message).toBe("OpenCode part-wrapped tool output.");
      const summary = summarizeReviewOrchestrationForWebhook(result);
      expect(summary.llmUsage).toMatchObject({
        promptTokens: 1200,
        completionTokens: 50,
        totalTokens: 1250,
        cachedPromptTokens: 200,
      });
      expect(summary.usageSource).toBe("agent_stdout");
      expect(summary.estimatedCostUsd).toBeCloseTo(0.005, 5);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses pi --mode json events: bridged tool calls, message_end usage, config dir env", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-pi-stream-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      // pi/omp NDJSON: session header + agent/turn/message/tool events. Usage is the
      // authoritative per-message `message_end.message.usage` (disjoint counters:
      // input excludes cache; totalTokens = input+output+cacheRead+cacheWrite).
      const summaryText = JSON.stringify({
        toolCalls: [{ name: "aicr.publish_summary", input: { markdown: "structured summary" } }],
      });
      const piStream = [
        { type: "session", version: 3, id: "s1", timestamp: "2026-08-26T00:00:00Z", cwd: "/workspace/agent" },
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "pi_aicr_output_aicr_report_problem",
          args: {
            file: "src/app.ts",
            line: 1,
            severity: "medium",
            category: "correctness",
            message: "pi bridged tool call.",
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "toolUse",
            usage: {
              input: 1000, output: 50, cacheRead: 200, cacheWrite: 20, totalTokens: 1270,
              cost: { input: 0.001, output: 0.0005, cacheRead: 0.0001, cacheWrite: 0.0001, total: 0.0017 },
            },
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: summaryText }],
            stopReason: "stop",
            usage: {
              input: 500, output: 30, cacheRead: 0, cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0005 },
            },
          },
        },
        { type: "agent_end", messages: [] },
      ].map((e) => JSON.stringify(e)).join("\n");
      const spawnCalls: SandboxSpawnOptions[] = [];
      let bundleManifest: { envKeys?: string[] } | undefined;
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          bundleManifest = JSON.parse(await readFile(join(spawnOptions.cwd, "manifest.json"), "utf8")) as {
            envKeys?: string[];
          };
          return { exitCode: 0, stdout: piStream, stderr: "", timedOut: false, durationMs: 9 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "pi",
        async detect() { return { available: true, binary: "pi" }; },
        buildCommand() { return ["pi", "--mode", "json"]; },
        buildStdin() { return ""; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
          outputPublisher: {
            async publishProblem() {
              return { channel: "test", status: "published", externalId: "1", raw: {} };
            },
          },
        },
      );

      expect(result.outputState.problems).toHaveLength(1);
      expect(result.outputState.problems[0]?.message).toBe("pi bridged tool call.");
      const summary = summarizeReviewOrchestrationForWebhook(result);
      // prompt = (1000+200+20) + (500+0+0); completion = 50+30; total = 1270+530.
      expect(summary.llmUsage).toMatchObject({
        promptTokens: 1720,
        completionTokens: 80,
        totalTokens: 1800,
        cachedPromptTokens: 200,
        cacheCreationTokens: 20,
      });
      expect(summary.usageSource).toBe("agent_stdout");
      expect(summary.estimatedCostUsd).toBeCloseTo(0.0022, 5);

      // PI_CODING_AGENT_DIR is injected with the sandbox-visible bundle config dir,
      // and the pi MCP bridge spec arrives via AICR_PI_MCP_SERVERS.
      const agentSpawn = spawnCalls[0];
      const agentDir = String(agentSpawn?.cwd ?? "");
      expect(agentSpawn?.env?.PI_CODING_AGENT_DIR).toBe(join(agentDir, ".pi-agent"));
      expect(bundleManifest?.envKeys).toContain("PI_CODING_AGENT_DIR");
      const bridgeSpecs = JSON.parse(String(agentSpawn?.env?.AICR_PI_MCP_SERVERS ?? "[]"));
      expect(bridgeSpecs).toHaveLength(1);
      expect(bridgeSpecs[0].name).toBe("aicr-output");
      expect(bridgeSpecs[0].environment.AICR_OUTPUT_STATE_PATH).toBe(
        join(agentDir, ".aicr-output-state.json"),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not synthesize pi usage or cost when assistant messages omit usage", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-pi-no-usage-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const piStream = [
        { type: "session", version: 3, id: "s-no-usage", cwd: "/workspace/agent" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ skipReason: "lgtm" }) }],
            stopReason: "stop",
          },
        },
      ].map((event) => JSON.stringify(event)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: piStream, stderr: "", timedOut: false, durationMs: 4 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "pi",
        async detect() { return { available: true, binary: "pi" }; },
        buildCommand() { return ["pi", "--mode", "json"]; },
        buildStdin() { return ""; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          baseSystemPrompt: "{{TASK_CONTEXT}}",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
          logThinking: false,
        },
      );

      expect(result.llmResult.usage).toBeUndefined();
      expect(result.estimatedCostUsd).toBeUndefined();
      expect(result.requestCount).toBe(1);
      expect(summarizeReviewOrchestrationForWebhook(result)).not.toMatchObject({
        llmUsage: expect.anything(),
        estimatedCostUsd: expect.anything(),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes oh-my-pi mcp__ tool names and points PI_CODING_AGENT_DIR at .omp-agent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-omp-stream-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const skipText = JSON.stringify({ skipReason: "lgtm" });
      const ompStream = [
        { type: "session", version: 3, id: "s2", timestamp: "2026-08-26T00:00:00Z", cwd: "/workspace/agent" },
        {
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "mcp__aicr_output_aicr_report_problem",
          args: {
            file: "src/app.ts",
            line: 1,
            severity: "low",
            category: "correctness",
            message: "omp native MCP tool call.",
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: skipText }],
            stopReason: "stop",
            usage: { input: 42, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 49 },
          },
        },
      ].map((e) => JSON.stringify(e)).join("\n");
      const spawnCalls: SandboxSpawnOptions[] = [];
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          return { exitCode: 0, stdout: ompStream, stderr: "", timedOut: false, durationMs: 7 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "oh-my-pi",
        async detect() { return { available: true, binary: "omp" }; },
        buildCommand() { return ["omp", "-p", "--mode", "json"]; },
        buildStdin() { return ""; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
          webSearch: { enabled: true, providers: ["tavily"], timeoutSeconds: 30 },
          outputPublisher: {
            async publishProblem() {
              return { channel: "test", status: "published", externalId: "1", raw: {} };
            },
          },
        },
      );

      expect(result.outputState.problems).toHaveLength(1);
      expect(result.outputState.problems[0]?.message).toBe("omp native MCP tool call.");
      const agentSpawn = spawnCalls[0];
      expect(agentSpawn?.env?.PI_CODING_AGENT_DIR).toBe(join(String(agentSpawn?.cwd ?? ""), ".omp-agent"));
      expect(agentSpawn?.env?.AICR_PI_MCP_SERVERS).toBeUndefined();
      // The webSearch option rides the same bundle path as compaction and lands in
      // the audited runtime-bundle manifest next to the agent workspace.
      const ompManifest = JSON.parse(
        await readFile(join(String(agentSpawn?.cwd ?? ""), "manifest.json"), "utf8"),
      ) as { webSearch?: { enabled: boolean; mode: string } };
      expect(ompManifest.webSearch).toEqual({ enabled: true, mode: "injected" });
      // Native sandboxes share host paths, so the generated mcp.json must point at the
      // module-relative aicr-output server script, not the container-image /app path.
      const ompMcpJson = JSON.parse(
        await readFile(join(String(agentSpawn?.cwd ?? ""), ".omp-agent", "mcp.json"), "utf8"),
      ) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
      const aicrOutputServer = ompMcpJson.mcpServers["aicr-output"];
      expect(aicrOutputServer?.command).toBe("node");
      expect(aicrOutputServer?.args?.[0]).toMatch(/mcp-output[/\\]dist[/\\]server\.js$/u);
      expect(aicrOutputServer?.args?.[0]).not.toContain("/app/");
      expect(aicrOutputServer?.env?.AICR_OUTPUT_STATE_PATH).toBe(
        join(String(agentSpawn?.cwd ?? ""), ".aicr-output-state.json"),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts a completed oh-my-pi stream when the process lingers past the timeout", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-omp-timeout-grace-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const skipText = JSON.stringify({ skipReason: "lgtm" });
      // Full pi-family stream including the terminal agent_end marker: the review
      // content is complete even though the (killed) process never exited.
      const ompStream = [
        { type: "session", version: 3, id: "s-grace", timestamp: "2026-08-26T00:00:00Z", cwd: "/workspace/agent" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: skipText }],
            stopReason: "stop",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
          },
        },
        { type: "agent_end", messages: [] },
      ].map((e) => JSON.stringify(e)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: null, stdout: ompStream, stderr: "", timedOut: true, durationMs: 600_079 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "oh-my-pi",
        async detect() { return { available: true, binary: "omp" }; },
        buildCommand() { return ["omp", "-p", "--mode", "json"]; },
        buildStdin() { return ""; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
          agentTimeoutMs: 600_000,
        },
      );

      expect(result.outputState.skipReason).toBe("lgtm");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("still fails a timed-out oh-my-pi run when the stream has no agent_end marker", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-omp-timeout-fatal-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      // Partial stream: the agent was killed mid-run, so the output is not safe
      // to treat as a completed review.
      const partialStream = [
        { type: "session", version: 3, id: "s-partial", timestamp: "2026-08-26T00:00:00Z", cwd: "/workspace/agent" },
        { type: "message_start", message: { role: "assistant" } },
      ].map((e) => JSON.stringify(e)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: null, stdout: partialStream, stderr: "", timedOut: true, durationMs: 600_079 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "oh-my-pi",
        async detect() { return { available: true, binary: "omp" }; },
        buildCommand() { return ["omp", "-p", "--mode", "json"]; },
        buildStdin() { return ""; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
        },
      };

      await expect(runReviewOrchestration(
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
          agentTimeoutMs: 600_000,
        },
      )).rejects.toThrow(/timed out/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("caps the raw-stdout fallback so repair follow-up argv stays under MAX_ARG_STRLEN", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-omp-e2big-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      // 200 KiB of non-NDJSON junk: nothing parses, so the extractor falls back
      // to raw stdout. Uncapped, that fallback embedded into the repair task
      // would blow past the 128 KiB per-argument limit (spawn E2BIG).
      const junkStdout = `${"x".repeat(200 * 1024)}\n`;
      const skipText = JSON.stringify({ skipReason: "lgtm" });
      const repairStream = [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: skipText }],
            stopReason: "stop",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
          },
        },
        { type: "agent_end", messages: [] },
      ].map((e) => JSON.stringify(e)).join("\n");
      const spawnCalls: SandboxSpawnOptions[] = [];
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn(spawnOptions) {
          spawnCalls.push(spawnOptions);
          if (spawnCalls.length === 1) {
            return { exitCode: 0, stdout: junkStdout, stderr: "", timedOut: false, durationMs: 12 };
          }
          return { exitCode: 0, stdout: repairStream, stderr: "", timedOut: false, durationMs: 12 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "oh-my-pi",
        async detect() { return { available: true, binary: "omp" }; },
        buildCommand(task) { return ["omp", "-p", "--mode", "json", "--", task]; },
        buildStdin() { return ""; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
          agentTimeoutMs: 30_000,
        },
      );

      expect(result.outputState.skipReason).toBe("lgtm");
      expect(spawnCalls.length).toBeGreaterThanOrEqual(2);
      const repairTask = spawnCalls[1]?.command.at(-1) ?? "";
      expect(repairTask).toContain("bytes truncated");
      // Linux MAX_ARG_STRLEN: any single argv string beyond 128 KiB fails with E2BIG.
      expect(Buffer.byteLength(repairTask, "utf8")).toBeLessThan(128 * 1024);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("estimates oh-my-pi cost from usage when the CLI echoes placeholder zero cost", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-omp-cost-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const ompStream = [
        { type: "session", version: 3, id: "s-cost", timestamp: "2026-08-26T00:00:00Z", cwd: "/workspace/agent" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ skipReason: "lgtm" }) }],
            stopReason: "stop",
            usage: {
              input: 1000,
              output: 100,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1100,
              cost: { total: 0 },
            },
          },
        },
      ].map((e) => JSON.stringify(e)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: ompStream, stderr: "", timedOut: false, durationMs: 5 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "oh-my-pi",
        async detect() { return { available: true, binary: "omp" }; },
        buildCommand() { return ["omp", "-p", "--mode", "json"]; },
        buildStdin() { return ""; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          // No catalog pricing: the agent echo of 0 must fall back to the documented
          // (tokens/1000)*0.002 placeholder instead of recording the run as free.
          model,
          sandbox,
          agentAdapter,
        },
      );

      expect(result.estimatedCostUsd).toBeCloseTo(0.0022, 6);
      expect(result.requestCount).toBe(1);
      expect(result.llmResult.usage?.promptTokens).toBe(1000);
      expect(result.llmResult.usage?.completionTokens).toBe(100);
      expect(result.llmResult.usage?.totalTokens).toBe(1100);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers agent-reported cost over the usage-derived estimate for oh-my-pi", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-omp-cost-real-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const ompStream = [
        { type: "session", version: 3, id: "s-cost2", timestamp: "2026-08-26T00:00:00Z", cwd: "/workspace/agent" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ skipReason: "lgtm" }) }],
            stopReason: "stop",
            usage: {
              input: 1000,
              output: 100,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1100,
              cost: { total: 0.05 },
            },
          },
        },
      ].map((e) => JSON.stringify(e)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: ompStream, stderr: "", timedOut: false, durationMs: 5 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "oh-my-pi",
        async detect() { return { available: true, binary: "omp" }; },
        buildCommand() { return ["omp", "-p", "--mode", "json"]; },
        buildStdin() { return ""; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
        },
      );

      expect(result.estimatedCostUsd).toBe(0.05);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("turns a terminal pi assistant error into a context-overflow error when it matches", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-pi-overflow-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const piStream = [
        { type: "session", version: 3, id: "s3", timestamp: "2026-08-26T00:00:00Z", cwd: "/workspace/agent" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "context_length_exceeded: prompt is too long",
          },
        },
        { type: "agent_end", messages: [] },
      ].map((e) => JSON.stringify(e)).join("\n");
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: piStream, stderr: "", timedOut: false, durationMs: 6 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "pi",
        async detect() { return { available: true, binary: "pi" }; },
        buildCommand() { return ["pi", "--mode", "json"]; },
        buildStdin() { return ""; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
            baseSystemPrompt: "{{TASK_CONTEXT}}",
            sourceRootResolver: () => tempDir,
            vcs: createVcs(tempDir),
            llm: { async complete() { throw new Error("direct llm must not be called"); } },
            model,
            sandbox,
            agentAdapter,
          },
        ),
      ).rejects.toThrow(/context window overflow/iu);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("unwraps the claude-code result envelope with usage, cost, and turn count", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-claude-envelope-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      // Claude Code `claude -p --output-format json` result envelope.
      const envelope = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({ skipReason: "lgtm" }),
        session_id: "ses-claude-1",
        num_turns: 3,
        total_cost_usd: 0.0123,
        duration_ms: 4200,
        usage: {
          input_tokens: 800,
          output_tokens: 120,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 100,
        },
      });
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: envelope, stderr: "", timedOut: false, durationMs: 11 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "claude-code",
        async detect() { return { available: true, binary: "claude" }; },
        buildCommand() { return ["claude", "-p", "--output-format", "json"]; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("lgtm");

      const summary = summarizeReviewOrchestrationForWebhook(result);
      expect(summary.llmUsage).toMatchObject({
        promptTokens: 1200,
        completionTokens: 120,
        totalTokens: 1320,
        cachedPromptTokens: 300,
        cacheCreationTokens: 100,
      });
      expect(summary.usageSource).toBe("agent_stdout");
      expect(summary.requestCount).toBe(3);
      expect(summary.estimatedCostUsd).toBeCloseTo(0.0123, 5);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws on claude-code error envelopes and maps context overflow", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-claude-error-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const envelope = JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "Invalid request: prompt is too long: 300000 tokens > 200000 maximum",
        session_id: "ses-claude-2",
      });
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return { exitCode: 0, stdout: envelope, stderr: "", timedOut: false, durationMs: 8 };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "claude-code",
        async detect() { return { available: true, binary: "claude" }; },
        buildCommand() { return ["claude", "-p"]; },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
            llm: { async complete() { throw new Error("direct llm must not be called"); } },
            model,
            sandbox,
            agentAdapter,
          },
        ),
      ).rejects.toThrow(/too long|overflow|exceeded/iu);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes aicr-output MCP config with a pinned AICR_OUTPUT_STATE_PATH to adapters", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-mcp-spawn-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      let capturedMcpServers: readonly { name: string; config: Record<string, unknown> }[] | undefined;
      const sandbox: SandboxBackend = {
        kind: "native",
        async materializeFs(layout) {
          await mkdir(layout.agentDir, { recursive: true });
          await mkdir(layout.tmpDir, { recursive: true });
          return { agentDir: layout.agentDir, tmpDir: layout.tmpDir, mountSpecs: [] };
        },
        async spawn() {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ skipReason: "lgtm" }),
            stderr: "",
            timedOut: false,
            durationMs: 5,
          };
        },
        async teardown() {},
      };
      const agentAdapter: AgentAdapter = {
        kind: "claude-code",
        async detect() { return { available: true, binary: "claude" }; },
        buildCommand(_task, spawnOptions) {
          capturedMcpServers = spawnOptions.mcpServers as typeof capturedMcpServers;
          return ["claude", "-p"];
        },
        async materializeConfig(_m, workingDir) {
          return { configFiles: new Map(), envVars: {}, workingDir };
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
          llm: { async complete() { throw new Error("direct llm must not be called"); } },
          model,
          sandbox,
          agentAdapter,
        },
      );

      expect(capturedMcpServers).toBeDefined();
      const aicrServer = capturedMcpServers?.find((server) => server.name === "aicr-output");
      expect(aicrServer).toBeDefined();
      const environment = aicrServer?.config.environment as Record<string, string> | undefined;
      expect(environment?.AICR_OUTPUT_STATE_PATH).toContain(".aicr-output-state.json");
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

  it("does not treat removed findings payloads as problems", async () => {
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
      const publishedSummaries: string[] = [];
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
            async publishSummary(summary) {
              publishedSummaries.push(summary);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(0);
      expect(result.summaryCount).toBe(1);
      expect(publishedProblems).toEqual([]);
      expect(publishedSummaries).toEqual(["One issue found."]);
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

  it("records output dispatch failures without failing orchestration", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-dispatch-failure-"));

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
      const dispatchError = Object.assign(new Error("GitHub problem issue API returned 403."), { status: 403 });

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
            async publishSummary() {
              throw dispatchError;
            },
          },
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("output_dispatch_failed");
      expect(result.problemCount).toBe(1);
      expect(result.dispatchCount).toBe(1);
      expect(result.dispatchResults[0]).toMatchObject({
        channel: "output",
        status: "failed",
        raw: {
          action: "dispatch_failed",
          phase: "summary",
          status: 403,
        },
      });
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
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0]?.summary).toContain("AICR review completed");
      expect(summaryCalls[0]?.problems).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes reviewedFiles (changedPaths) to publishSummary options", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-reviewed-files-"));

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
      const summaryOptions: Array<ReviewSummaryPublishOptions | undefined> = [];

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
              throw new Error("should not receive line problems");
            },
            async publishSummary(_summary, _problems, options) {
              summaryOptions.push(options);
              return { channel: "gitea-problem-issue", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(summaryOptions).toHaveLength(1);
      const opts = summaryOptions[0];
      expect(opts?.reviewedFiles).toBeDefined();
      expect(opts?.reviewedFiles).toContain("src/app.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("suppresses zero-problem summaries when the publisher policy says suppress", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-no-problems-suppress-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ summary: "No actionable problems." }),
            raw: {},
          };
        },
      };
      const summaryCalls: string[] = [];

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
            noProblemsAction: "suppress",
            async publishSummary(summary) {
              summaryCalls.push(summary);
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.problemCount).toBe(0);
      expect(result.summaryCount).toBe(1);
      expect(result.dispatchCount).toBe(0);
      expect(summaryCalls).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("repairs summary-only issue claims before publishing summary channels", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-summary-claim-repair-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      let completeCalls = 0;
      const llm: ChatCompletionClient = {
        async complete(input) {
          completeCalls += 1;
          if (completeCalls === 1) {
            return {
              providerId: input.model.providerId,
              modelId: input.model.modelId,
              content: "Found a critical issue: calling a commented-out function will cause a runtime error.",
              raw: {},
            };
          }

          expect(input.messages[2]?.content).toContain("claimed actionable problems in a summary");
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
                    severity: "critical",
                    category: "correctness",
                    message: "Calling the commented-out function can fail at runtime.",
                  },
                },
                {
                  name: "aicr.publish_summary",
                  input: { markdown: "Structured repair completed. Found 1 critical issue." },
                },
              ],
            }),
            raw: {},
          };
        },
      };
      const summaryCalls: Array<{ summary: string; problems: readonly ReviewProblem[] }> = [];

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
            noProblemsAction: "publish_if_summary",
            async publishSummary(summary, problems) {
              summaryCalls.push({ summary, problems: problems ?? [] });
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.dispatchCount).toBe(1);
      expect(completeCalls).toBe(2);
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0]?.summary).toBe("Structured repair completed. Found 1 critical issue.");
      expect(summaryCalls[0]?.problems[0]).toMatchObject({
        file: "src/app.ts",
        line: 1,
        severity: "critical",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("suppresses with publish_if_summary when model skips review", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-publish-if-summary-skip-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({ skipReason: "no issues found" }),
            raw: {},
          };
        },
      };
      const summaryCalls: string[] = [];

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
            noProblemsAction: "publish_if_summary",
            async publishSummary(summary) {
              summaryCalls.push(summary);
              return { channel: "feishu", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.problemCount).toBe(0);
      expect(result.dispatchCount).toBe(0);
      expect(summaryCalls).toEqual([]);
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
          outputPublisherResolver: async () => ({
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
      expect(publishedProblems[0]?.codeSnippet).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("scrubs automatically attached code reference snippets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-code-reference-scrub-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const token = \"ghp_abcdefghijklmnopqrstuvwxyz01234567890123\";\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                { file: "src/app.ts", line: 1, severity: "high", category: "security", message: "Token is hardcoded." },
              ],
            }),
            raw: {},
          };
        },
      };
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async diff() {
          return parseUnifiedDiff([
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -0,0 +1 @@",
            "+const token = \"ghp_abcdefghijklmnopqrstuvwxyz01234567890123\";",
          ].join("\n"));
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
          vcs,
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
      expect(result.scrubMatches.length).toBeGreaterThanOrEqual(1);
      expect(publishedProblems[0]?.codeSnippet).toContain("<REDACTED:GITHUB_TOKEN>");
      expect(publishedProblems[0]?.codeSnippet).not.toContain("ghp_");
      expect(publishedProblems[0]?.codeLanguage).toBe("ts");
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
      const fetchExtraCalls: { path: string; startLine?: number; endLine?: number; revision?: string }[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push({
            path: req.path,
            ...(req.startLine !== undefined ? { startLine: req.startLine } : {}),
            ...(req.endLine !== undefined ? { endLine: req.endLine } : {}),
            ...(req.revision !== undefined ? { revision: req.revision } : {}),
          });
          return { path: req.path, content: `ctx-${req.path}` };
        },
      };
      let completeCalls = 0;
      const llm: ChatCompletionClient = {
        async complete(input) {
          completeCalls += 1;
          if (completeCalls === 2) {
            expect(input.messages[2]?.content).toContain("Fetched context:");
            expect(input.messages[2]?.content).toContain("ctx-src/app.ts");
            return {
              providerId: input.model.providerId,
              modelId: input.model.modelId,
              content: JSON.stringify({ skipReason: "lgtm" }),
              raw: {},
            };
          }

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
      expect(completeCalls).toBe(2);
      expect(fetchExtraCalls).toEqual([
        { path: "src/app.ts", startLine: 2, endLine: 4, revision: "head" },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("feeds aicr.try_blame attribution from a local git fixture into a follow-up", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-try-blame-git-"));

    try {
      await runGit(tempDir, ["init"]);
      await writeWorkspaceFile(tempDir, "src/app.ts", "const one = 1;\n");
      await commitAll(tempDir, "Alice", "alice@example.com", "initial app");
      await writeWorkspaceFile(tempDir, "src/app.ts", "const one = 1;\nconst two = 2;\n");
      await commitAll(tempDir, "Bob", "bob@example.com", "add second line");

      const gitAdapter = createGitVcsAdapter({ repositoryDir: tempDir });
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async listChanges() {
          return { baseRevision: "HEAD~1", headRevision: "HEAD", files: ["src/app.ts"] };
        },
        async fetchAttribution(req, ws) {
          return gitAdapter.fetchAttribution(req, ws);
        },
      };
      let completeCalls = 0;
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
                    name: "aicr.try_blame",
                    input: {
                      path: "src/app.ts",
                      range: { start_line: 2, end_line: 2 },
                      reason: "Need verified attribution for the changed line.",
                    },
                  },
                ],
              }),
              raw: {},
            };
          }

          expect(input.messages[2]?.content).toContain("Fetched context:");
          expect(input.messages[2]?.content).toContain('"status": "ok"');
          expect(input.messages[2]?.content).toContain('"author": "Bob"');
          expect(input.messages[2]?.content).toContain('"authorEmail": "bob@example.com"');
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
          vcs,
          llm,
          model,
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("lgtm");
      expect(result.contextRequestCount).toBe(0);
      expect(result.outputState.attributionRequests).toEqual([
        {
          path: "src/app.ts",
          range: { start_line: 2, end_line: 2 },
          reason: "Need verified attribution for the changed line.",
        },
      ]);
      expect(completeCalls).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns not_found for aicr.try_blame when the VCS adapter has no attribution support", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-try-blame-no-adapter-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      let completeCalls = 0;
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
                    name: "aicr-output_aicr_try_blame",
                    input: {
                      path: "src/app.ts",
                      range: { start_line: 1, end_line: 1 },
                      reason: "Need attribution if available.",
                    },
                  },
                ],
              }),
              raw: {},
            };
          }

          expect(input.messages[2]?.content).toContain('"status": "not_found"');
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

      expect(result.status).toBe("skipped");
      expect(completeCalls).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores invalid aicr.try_blame requests without failing the review", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-invalid-try-blame-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchAttribution() {
          throw new RangeError("path must stay within the scoped workspace");
        },
      };
      let completeCalls = 0;
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
                    name: "aicr.try_blame",
                    input: {
                      path: "../secret.ts",
                      reason: "This should be rejected by the VCS adapter.",
                    },
                  },
                  { name: "aicr.skip", input: { reason: "lgtm" } },
                ],
              }),
              raw: {},
            };
          }

          expect(input.messages[2]?.content).toContain("Ignored invalid context requests:");
          expect(input.messages[2]?.content).toContain("path must stay within the scoped workspace");
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
          vcs,
          llm,
          model,
        },
      );

      expect(result.status).toBe("skipped");
      expect(result.skipReason).toBe("lgtm");
      expect(completeCalls).toBe(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ignored invalid try_blame tool call"));
    } finally {
      warnSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses fetched related context for a follow-up before accepting a no-problem summary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-related-context-follow-up-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const fetchExtraCalls: string[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push(req.path);
          return { path: req.path, content: "export function relatedContract() { return false; }" };
        },
      };
      let completeCalls = 0;
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
                    input: {
                      path: "src/related.ts",
                      reason: "Need related API contract before deciding whether the changed call is safe.",
                    },
                  },
                  {
                    name: "aicr.publish_summary",
                    input: { markdown: "No actionable problems based on the visible diff." },
                  },
                ],
              }),
              raw: {},
            };
          }

          expect(input.messages[2]?.content).toContain("Fetched context:");
          expect(input.messages[2]?.content).toContain("--- src/related.ts ---");
          expect(input.messages[2]?.content).toContain("relatedContract");
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                {
                  file: "src/app.ts",
                  line: 1,
                  severity: "medium",
                  category: "api-contract",
                  message: "The changed call violates the related API contract.",
                },
              ],
              summary: "Related context changed the result; found 1 issue.",
            }),
            raw: {},
          };
        },
      };
      const summaryCalls: Array<{ summary: string; problems: readonly ReviewProblem[] }> = [];

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
          outputPublisher: {
            publishesProblems: false,
            async publishSummary(summary, problems) {
              summaryCalls.push({ summary, problems: problems ?? [] });
              return { channel: "feishu", status: "published", raw: {} };
            },
            async publishProblem() {
              throw new Error("summary-only publisher should not receive line problems");
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.contextRequestCount).toBe(1);
      expect(completeCalls).toBe(2);
      expect(fetchExtraCalls).toEqual(["src/related.ts"]);
      expect(summaryCalls[0]?.summary).toBe("Related context changed the result; found 1 issue.");
      expect(summaryCalls[0]?.problems[0]?.file).toBe("src/app.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("re-verifies reported problems against fetched context in a follow-up pass", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-problem-context-follow-up-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      const fetchExtraCalls: string[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push(req.path);
          return { path: req.path, content: "export function relatedContract(): boolean;\n" };
        },
      };
      let completeCalls = 0;
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
                    input: {
                      path: "src/related.ts",
                      reason: "Need the related API contract to confirm the reported problem.",
                    },
                  },
                  {
                    name: "aicr.report_problem",
                    input: {
                      file: "src/app.ts",
                      line: 2,
                      severity: "high",
                      category: "correctness",
                      message: "Reported while the related contract was still pending fetch; to be re-verified.",
                    },
                  },
                ],
              }),
              raw: {},
            };
          }

          expect(input.messages[2]?.content).toContain("reported problems while its aicr.fetch_more_context requests were still pending");
          expect(input.messages[2]?.content).toContain("Fetched context:");
          expect(input.messages[2]?.content).toContain("--- src/related.ts ---");
          expect(input.messages[2]?.content).toContain("relatedContract");
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
                  message: "Confirmed against the fetched contract: the changed call violates it.",
                },
              ],
              summary: "Fetched context confirmed 1 issue.",
            }),
            raw: {},
          };
        },
      };
      const publishedProblems: ReviewProblem[] = [];
      const summaryCalls: string[] = [];

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
          outputPublisher: {
            publishesProblems: true,
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
            async publishSummary(summary) {
              summaryCalls.push(summary);
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.contextRequestCount).toBe(1);
      expect(completeCalls).toBe(2);
      expect(fetchExtraCalls).toEqual(["src/related.ts"]);
      expect(publishedProblems[0]?.message).toBe("Confirmed against the fetched contract: the changed call violates it.");
      expect(summaryCalls[0]).toBe("Fetched context confirmed 1 issue.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs a third pass when the follow-up itself reports problems plus new context requests", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-problem-context-third-pass-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      const fetchExtraCalls: string[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push(req.path);
          return { path: req.path, content: `export const ${req.path.endsWith("caller.ts") ? "callerProof" : "relatedContract"} = true;\n` };
        },
      };
      let completeCalls = 0;
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
                    input: { path: "src/related.ts", reason: "Need the related API contract." },
                  },
                  {
                    name: "aicr.report_problem",
                    input: {
                      file: "src/app.ts",
                      line: 2,
                      severity: "high",
                      category: "correctness",
                      message: "Provisional problem pending related contract.",
                    },
                  },
                ],
              }),
              raw: {},
            };
          }
          if (completeCalls === 2) {
            expect(input.messages[2]?.content).toContain("--- src/related.ts ---");
            return {
              providerId: input.model.providerId,
              modelId: input.model.modelId,
              content: JSON.stringify({
                toolCalls: [
                  {
                    name: "aicr.fetch_more_context",
                    input: { path: "src/caller.ts", reason: "Need the caller to finish verification." },
                  },
                  {
                    name: "aicr.report_problem",
                    input: {
                      file: "src/app.ts",
                      line: 2,
                      severity: "high",
                      category: "correctness",
                      message: "Contract checked; still need the caller.",
                    },
                  },
                ],
              }),
              raw: {},
            };
          }

          expect(input.messages[2]?.content).toContain("reported problems while its aicr.fetch_more_context requests were still pending");
          expect(input.messages[2]?.content).toContain("--- src/caller.ts ---");
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
                  message: "Final confirmation after caller context.",
                },
              ],
              summary: "Third pass confirmed 1 issue.",
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
          vcs,
          llm,
          model,
          outputPublisher: {
            publishesProblems: true,
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
            async publishSummary() {
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.contextRequestCount).toBe(2);
      expect(completeCalls).toBe(3);
      expect(fetchExtraCalls).toEqual(["src/related.ts", "src/caller.ts"]);
      expect(publishedProblems[0]?.message).toBe("Final confirmation after caller context.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps reported problems without a follow-up when the context fetch is invalid", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-problem-invalid-fetch-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      let completeCalls = 0;
      const publishedProblems: ReviewProblem[] = [];
      const llm: ChatCompletionClient = {
        async complete(input) {
          completeCalls += 1;
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              toolCalls: [
                {
                  name: "aicr.fetch_more_context",
                  input: { path: "", reason: "need more context but no file was selected" },
                },
                {
                  name: "aicr.report_problem",
                  input: {
                    file: "src/app.ts",
                    line: 1,
                    severity: "high",
                    category: "correctness",
                    message: "Diff-visible problem; missing context stated in the report.",
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
            publishesProblems: true,
            async publishProblem(problem) {
              publishedProblems.push(problem);
              return { channel: "test", status: "published", raw: {} };
            },
            async publishSummary() {
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(completeCalls).toBe(1);
      expect(publishedProblems[0]?.message).toBe("Diff-visible problem; missing context stated in the report.");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ignored invalid fetch_more_context tool call"));
    } finally {
      warnSpy.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("repairs missing-diff skip output by fetching changed-file context", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-missing-diff-repair-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      const fetchExtraCalls: string[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push(req.path);
          return { path: req.path, content: "const value = oldValue();\ncommitBeforeReturn();\n" };
        },
        async diff() {
          return { files: [] };
        },
      };
      let completeCalls = 0;
      const llm: ChatCompletionClient = {
        async complete(input) {
          completeCalls += 1;
          if (completeCalls === 1) {
            return {
              providerId: input.model.providerId,
              modelId: input.model.modelId,
              content: JSON.stringify({ skipReason: "无法获取 diff，请提供 diff 后再审查。" }),
              raw: {},
            };
          }

          if (completeCalls === 2) {
            expect(input.messages[2]?.content).toContain("asked for diff/source context");
            return {
              providerId: input.model.providerId,
              modelId: input.model.modelId,
              content: JSON.stringify({
                toolCalls: [
                  {
                    name: "aicr.fetch_more_context",
                    input: { path: "src/app.ts", reason: "Diff is unavailable; need the full changed file." },
                  },
                ],
              }),
              raw: {},
            };
          }

          expect(input.messages[2]?.content).toContain("Fetched context:");
          expect(input.messages[2]?.content).toContain("commitBeforeReturn");
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [
                {
                  file: "src/app.ts",
                  line: 2,
                  severity: "medium",
                  category: "correctness",
                  message: "The function can return before the commit completes.",
                },
              ],
              summary: "Fetched changed-file context and found 1 issue.",
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
          vcs,
          llm,
          model,
          outputPublisher: {
            async publishProblem() {
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.problemCount).toBe(1);
      expect(result.summaryCount).toBe(1);
      expect(result.contextRequestCount).toBe(1);
      expect(result.diffFileCount).toBe(0);
      expect(completeCalls).toBe(3);
      expect(fetchExtraCalls).toEqual(["src/app.ts"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses XML context calls and a final JSON review payload from the same output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-xml-plus-json-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const value = oldValue();\ncommitBeforeReturn();\n");
      const fetchExtraCalls: string[] = [];
      const vcs: DiffCapableVcsAdapter = {
        ...createVcs(tempDir),
        async fetchExtraContext(req) {
          fetchExtraCalls.push(req.path);
          return { path: req.path, content: `ctx-${req.path}` };
        },
      };
      const publishedProblems: ReviewProblem[] = [];
      let completeCalls = 0;
      const llm: ChatCompletionClient = {
        async complete(input) {
          completeCalls += 1;
          if (completeCalls > 1) {
            return {
              providerId: input.model.providerId,
              modelId: input.model.modelId,
              content: JSON.stringify({
                problems: [
                  {
                    file: "src/app.ts",
                    line: 2,
                    severity: "low",
                    category: "correctness",
                    message: "Issue after context fetch.",
                  },
                ],
                summary: "Context fetched; issue confirmed.",
              }),
              raw: {},
            };
          }

          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: [
              '<tool_call name="aicr.fetch_more_context">{"path":"src/app.ts","reason":"need context"}</tool_call>',
              JSON.stringify({
                toolCalls: [
                  {
                    name: "aicr.report_problem",
                    input: {
                      file: "src/app.ts",
                      line: 2,
                      severity: "low",
                      category: "correctness",
                      message: "Issue after context fetch.",
                    },
                  },
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
          vcs,
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

      expect(result.problemCount).toBe(1);
      expect(result.contextRequestCount).toBe(1);
      expect(completeCalls).toBe(2);
      expect(fetchExtraCalls).toEqual(["src/app.ts"]);
      expect(publishedProblems[0]?.file).toBe("src/app.ts");
      expect(publishedProblems[0]?.line).toBe(2);
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
      expect(result.outputState.summaries).toEqual([{ markdown: "没有发现问题" }]);
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

      expect(result.outputState.summaries).toEqual([{ markdown: "最终摘要" }]);
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

  it("parses summary as nested { markdown } object from model output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-nested-summary-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              problems: [{
                file: "src/app.ts",
                line: 1,
                severity: "medium",
                category: "style",
                message: "Naming issue.",
              }],
              summary: { markdown: "## Review Summary\n\nOne style issue found." },
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
      expect(result.summaryCount).toBe(1);
      expect(result.outputState.summaries[0]).toEqual({ markdown: "## Review Summary\n\nOne style issue found." });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves summary titles and forwards them to summary publishers", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-summary-title-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const ok = true;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: JSON.stringify({
              summary: {
                title: "简短标题",
                markdown: "最终摘要",
              },
            }),
            raw: {},
          };
        },
      };
      const publishedSummaries: Array<{ summary: string; title?: string }> = [];

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
            async publishSummary(summary, _problems, options) {
              publishedSummaries.push({ summary, ...(options?.title ? { title: options.title } : {}) });
              return { channel: "test", status: "published", raw: {} };
            },
          },
        },
      );

      expect(result.status).toBe("published");
      expect(result.summaryCount).toBe(1);
      expect(result.outputState.summaries).toEqual([{ title: "简短标题", markdown: "最终摘要" }]);
      expect(publishedSummaries).toEqual([{ summary: "最终摘要", title: "简短标题" }]);
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

describe("outputLanguage injection", () => {
  it("includes output language directive when outputLanguage is set to a non-English language", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-i18n-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "function main() {}\n");

      let capturedPrompt = "";
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
          llm: {
            async complete(input) {
              capturedPrompt = input.messages[0]?.content ?? "";
              return {
                providerId: input.model.providerId,
                modelId: input.model.modelId,
                content: '{"skipReason":"lgtm"}',
                raw: {},
              };
            },
          },
          model,
          outputLanguage: "zh-CN",
        },
      );

      expect(result.status).toBe("skipped");
      expect(capturedPrompt).toContain("Output language: zh-CN");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("omits output language directive when outputLanguage is en", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-i18n-en-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "function main() {}\n");

      let capturedPrompt = "";
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
          llm: {
            async complete(input) {
              capturedPrompt = input.messages[0]?.content ?? "";
              return {
                providerId: input.model.providerId,
                modelId: input.model.modelId,
                content: '{"skipReason":"lgtm"}',
                raw: {},
              };
            },
          },
          model,
          outputLanguage: "en",
        },
      );

      expect(result.status).toBe("skipped");
      expect(capturedPrompt).not.toContain("Output language:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("omits output language directive when outputLanguage is not set", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-i18n-none-"));

    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "function main() {}\n");

      let capturedPrompt = "";
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
          llm: {
            async complete(input) {
              capturedPrompt = input.messages[0]?.content ?? "";
              return {
                providerId: input.model.providerId,
                modelId: input.model.modelId,
                content: '{"skipReason":"lgtm"}',
                raw: {},
              };
            },
          },
          model,
        },
      );

      expect(result.status).toBe("skipped");
      expect(capturedPrompt).not.toContain("Output language:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves memoryHints via memoryHintsResolver and passes to prompt", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-hints-"));
    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const x = 1;\n");
      let capturedPrompt = "";
      const llm: ChatCompletionClient = {
        async complete(input) {
          capturedPrompt = input.messages[0]?.content ?? "";
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: '{"skipReason":"lgtm"}',
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
          baseSystemPrompt: [
            "{{REPO_INSTRUCTION_SUMMARIES}}",
            "{{MEMORY_HINTS}}",
            "{{TASK_CONTEXT}}",
          ].join("\n"),
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          memoryHintsResolver: async (workspaceId) => {
            if (workspaceId === "ws") {
              return ["Previous review found style issues in .ts files", "Repo uses ESLint strict rules"];
            }
            return [];
          },
        },
      );

      expect(result.status).toBe("skipped");
      expect(capturedPrompt).toContain("memory hint 1: Previous review found style issues");
      expect(capturedPrompt).toContain("memory hint 2: Repo uses ESLint strict rules");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to static memoryHints when no resolver is provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-hints-static-"));
    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const x = 1;\n");
      let capturedPrompt = "";
      const llm: ChatCompletionClient = {
        async complete(input) {
          capturedPrompt = input.messages[0]?.content ?? "";
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: '{"skipReason":"lgtm"}',
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
          baseSystemPrompt: "{{MEMORY_HINTS}}\n{{TASK_CONTEXT}}",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          memoryHints: ["Static hint from config"],
        },
      );

      expect(result.status).toBe("skipped");
      expect(capturedPrompt).toContain("Static hint from config");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("calls postRunCallback after successful review", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-callback-"));
    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const x = 1;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: '{"skipReason":"lgtm"}',
            raw: {},
          };
        },
      };

      let callbackResult: ReviewOrchestrationResult | null = null;
      let callbackContext: ReviewOrchestrationContext | null = null;

      await runReviewOrchestration(
        {
          reviewEvent: createReviewEventFixture(),
          payload: {},
          provider: "gitea",
          eventName: "pull_request",
        },
        {
          baseSystemPrompt: "{{TASK_CONTEXT}}",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          postRunCallback: async (result, context) => {
            callbackResult = result;
            callbackContext = context;
          },
        },
      );

      expect(callbackResult).not.toBeNull();
      expect(callbackResult!.status).toBe("skipped");
      expect(callbackContext!.reviewEvent.workspaceId).toBe("ws");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not fail review when postRunCallback throws", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-callback-err-"));
    try {
      await writeWorkspaceFile(tempDir, "src/app.ts", "const x = 1;\n");
      const llm: ChatCompletionClient = {
        async complete(input) {
          return {
            providerId: input.model.providerId,
            modelId: input.model.modelId,
            content: '{"skipReason":"lgtm"}',
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
          baseSystemPrompt: "{{TASK_CONTEXT}}",
          sourceRootResolver: () => tempDir,
          vcs: createVcs(tempDir),
          llm,
          model,
          postRunCallback: async () => {
            throw new Error("reflection store unavailable");
          },
        },
      );

      expect(result.status).toBe("skipped");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
