import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildReviewTaskContext,
  createReviewEvent,
  loadSystemPromptTemplate,
  prepareReviewPrompt,
  summarizePreparedReviewPrompt,
} from "../src/index.js";

async function writeWorkspaceFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(rootDir, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("prepareReviewPrompt", () => {
  it("builds task context, discovers repo instructions, and summarizes the prepared prompt", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-"));

    try {
      await writeWorkspaceFile(tempDir, "src/AGENTS.md", "# Source\nUse transactions for auth writes.\n");
      await writeWorkspaceFile(
        tempDir,
        ".agents/skills/auth-review/SKILL.md",
        [
          "---",
          "name: auth-review",
          'description: "Review authentication and session flows."',
          "---",
          "",
          "# Auth Review",
          "",
          "## Applies To",
          "",
          "- `src/auth/**`",
          "",
        ].join("\n"),
      );

      const reviewEvent = createReviewEvent({
        triggerName: "gitea-internal",
        provider: "gitea",
        workspaceId: "ws",
        targetKind: "pull_request",
        repoRef: "owent/example",
        baseSha: "base-sha",
        headSha: "head-sha",
        changedFiles: ["src/auth/login.ts"],
        author: { username: "owent" },
        reason: "gitea:opened",
        url: "https://gitea.internal/owent/example/pulls/42",
      });

      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot: tempDir,
        baseSystemPrompt: [
          "<repo>",
          "{{REPO_INSTRUCTION_SUMMARIES}}",
          "</repo>",
          "<skills>",
          "{{ACTIVE_SKILL_SUMMARIES}}",
          "</skills>",
          "<memory>",
          "{{MEMORY_HINTS}}",
          "</memory>",
          "<task>",
          "{{TASK_CONTEXT}}",
          "</task>",
        ].join("\n"),
      });
      const summary = summarizePreparedReviewPrompt(prepared);

      expect(prepared.taskContext).toContain("Review target: pull_request");
      expect(prepared.taskContext).toContain("- src/auth/login.ts");
      expect(summary.instructionCount).toBeGreaterThanOrEqual(1);
      expect(summary.skillCount).toBe(1);
      expect(summary.systemPrompt).toContain("src/AGENTS.md");
      expect(summary.systemPrompt).toContain("auth-review");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads a system prompt template from disk and builds a fallback task context for empty changed files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-prompt-"));

    try {
      const promptPath = join(tempDir, "code-reviewer.system.md");
      await writeFile(promptPath, "<task>\n{{TASK_CONTEXT}}\n</task>\n", "utf8");

      const prompt = await loadSystemPromptTemplate(promptPath);
      const taskContext = buildReviewTaskContext(
        createReviewEvent({
          triggerName: "manual-cli",
          provider: "manual",
          workspaceId: "manual-workspace",
          targetKind: "manual",
          repoRef: "owent/example",
          reason: "manual:review",
          author: {},
        }),
        [],
      );

      expect(prompt).toContain("{{TASK_CONTEXT}}");
      expect(taskContext).toContain("Changed files:\n- (not provided)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to a built task context when an explicit whitespace-only context is provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-blank-"));
    try {
      const reviewEvent = createReviewEvent({
        triggerName: "manual-cli",
        provider: "manual",
        workspaceId: "manual-workspace",
        targetKind: "manual",
        repoRef: "owent/example",
        reason: "manual:review",
        author: {},
      });
      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot: tempDir,
        baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
        taskContext: "   \n   ",
      });
      expect(prepared.taskContext).toContain("Review target: manual");
      expect(prepared.taskContext).toContain("- (not provided)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("trims, dedupes, and normalizes changed paths before discovery", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-paths-"));
    try {
      const reviewEvent = createReviewEvent({
        triggerName: "manual-cli",
        provider: "manual",
        workspaceId: "manual-workspace",
        targetKind: "manual",
        repoRef: "owent/example",
        reason: "manual:review",
        author: {},
      });
      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot: tempDir,
        baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
        changedPaths: [" ./src/a.ts ", "src/a.ts", "  ", "src/../src/b.ts"],
      });
      expect(prepared.changedPaths).toEqual(["src/a.ts", "src/b.ts"]);
      expect(prepared.taskContext).toContain("- src/a.ts");
      expect(prepared.taskContext).toContain("- src/b.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects changed paths that escape the source root", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-escape-"));
    try {
      const reviewEvent = createReviewEvent({
        triggerName: "manual-cli",
        provider: "manual",
        workspaceId: "manual-workspace",
        targetKind: "manual",
        repoRef: "owent/example",
        reason: "manual:review",
        author: {},
      });

      await expect(
        prepareReviewPrompt({
          reviewEvent,
          sourceRoot: tempDir,
          baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
          changedPaths: ["../escape.ts"],
        }),
      ).rejects.toThrow(/must stay within/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates errors when the system prompt template cannot be loaded", async () => {
    await expect(
      loadSystemPromptTemplate(join(tmpdir(), "definitely-missing-aicr-prompt.md")),
    ).rejects.toThrow();
  });
});