import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildReviewTaskContext,
  createReviewEvent,
  estimatePromptTokens,
  loadSystemPromptTemplate,
  prepareReviewPrompt,
  renderPromptTemplate,
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

  it("falls back to reviewEvent.changedFiles when no explicit changedPaths are provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-event-files-"));
    try {
      const reviewEvent = createReviewEvent({
        triggerName: "gitea-internal",
        provider: "gitea",
        workspaceId: "ws",
        targetKind: "pull_request",
        repoRef: "owent/example",
        baseSha: "base-sha",
        headSha: "head-sha",
        changedFiles: ["src/a.ts", "src/b.ts"],
        author: { username: "owent" },
        reason: "gitea:opened",
        url: "https://gitea.internal/owent/example/pulls/1",
      });
      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot: tempDir,
        baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
      });
      expect(prepared.changedPaths).toEqual(["src/a.ts", "src/b.ts"]);
      expect(prepared.taskContext).toContain("- src/a.ts");
      expect(prepared.taskContext).toContain("- src/b.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses explicit changedPaths over reviewEvent.changedFiles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-explicit-paths-"));
    try {
      const reviewEvent = createReviewEvent({
        triggerName: "gitea-internal",
        provider: "gitea",
        workspaceId: "ws",
        targetKind: "pull_request",
        repoRef: "owent/example",
        changedFiles: ["src/ignored.ts"],
        author: { username: "owent" },
        reason: "gitea:opened",
      });
      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot: tempDir,
        baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
        changedPaths: ["src/used.ts"],
      });
      expect(prepared.changedPaths).toEqual(["src/used.ts"]);
      expect(prepared.changedPaths).not.toContain("src/ignored.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates operatorOverrides and memoryHints to the assembled prompt", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-overrides-"));
    try {
      const reviewEvent = createReviewEvent({
        triggerName: "manual-cli",
        provider: "manual",
        workspaceId: "ws",
        targetKind: "manual",
        repoRef: "owent/example",
        reason: "manual:review",
        author: {},
      });
      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot: tempDir,
        baseSystemPrompt: [
          "<repo>",
          "{{REPO_INSTRUCTION_SUMMARIES}}",
          "</repo>",
          "<memory>",
          "{{MEMORY_HINTS}}",
          "</memory>",
          "<task>",
          "{{TASK_CONTEXT}}",
          "</task>",
        ].join("\n"),
        operatorOverrides: ["Always check error handling."],
        memoryHints: ["Previous run flagged missing null checks."],
      });
      expect(prepared.prompt.systemPrompt).toContain("Always check error handling");
      expect(prepared.prompt.systemPrompt).toContain("Previous run flagged missing null checks");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("trims low-priority assets to fit maxPromptTokens budget", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-budget-"));
    try {
      await writeWorkspaceFile(tempDir, "AGENTS.md", "# Root\n" + "Long instruction. ".repeat(100) + "\n");
      const reviewEvent = createReviewEvent({
        triggerName: "manual-cli",
        provider: "manual",
        workspaceId: "ws",
        targetKind: "manual",
        repoRef: "owent/example",
        reason: "manual:review",
        author: {},
      });
      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot: tempDir,
        baseSystemPrompt: [
          "<repo>",
          "{{REPO_INSTRUCTION_SUMMARIES}}",
          "</repo>",
          "<task>",
          "{{TASK_CONTEXT}}",
          "</task>",
        ].join("\n"),
        memoryHints: ["This memory hint should be trimmed first when budget is tight."],
        maxPromptTokens: 50,
      });
      expect(prepared.prompt.droppedInstructionRefs.length).toBeGreaterThan(0);
      expect(prepared.prompt.tokenEstimate).toBeLessThanOrEqual(50);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses explicit taskContext when a non-whitespace value is provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-explicit-ctx-"));
    try {
      const reviewEvent = createReviewEvent({
        triggerName: "manual-cli",
        provider: "manual",
        workspaceId: "ws",
        targetKind: "manual",
        repoRef: "owent/example",
        reason: "manual:review",
        author: {},
      });
      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot: tempDir,
        baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
        taskContext: "Custom task context for this review.",
      });
      expect(prepared.taskContext).toBe("Custom task context for this review.");
      expect(prepared.taskContext).not.toContain("Review target:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("summarizePreparedReviewPrompt returns all expected fields", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-review-prep-summary-"));
    try {
      const reviewEvent = createReviewEvent({
        triggerName: "gitea-internal",
        provider: "gitea",
        workspaceId: "ws",
        targetKind: "pull_request",
        repoRef: "owent/example",
        baseSha: "base",
        headSha: "head",
        changedFiles: ["src/a.ts"],
        author: { username: "owent" },
        reason: "gitea:opened",
        url: "https://gitea.internal/pulls/1",
      });
      const prepared = await prepareReviewPrompt({
        reviewEvent,
        sourceRoot: tempDir,
        baseSystemPrompt: "<task>\n{{TASK_CONTEXT}}\n</task>",
      });
      const summary = summarizePreparedReviewPrompt(prepared);

      expect(summary.sourceRoot).toBe(prepared.sourceRoot);
      expect(summary.changedPaths).toEqual(prepared.changedPaths);
      expect(summary.taskContext).toBe(prepared.taskContext);
      expect(summary.promptTokenEstimate).toBe(prepared.prompt.tokenEstimate);
      expect(summary.instructionCount).toBe(prepared.prompt.loadedInstructionRefs.length);
      expect(summary.skillCount).toBe(prepared.prompt.activatedSkillRefs.length);
      expect(summary.droppedAssetCount).toBe(prepared.prompt.droppedInstructionRefs.length);
      expect(summary.loadedInstructions).toBe(prepared.prompt.loadedInstructionRefs);
      expect(summary.activeSkills).toBe(prepared.prompt.activatedSkillRefs);
      expect(summary.droppedAssets).toBe(prepared.prompt.droppedInstructionRefs);
      expect(summary.systemPrompt).toBe(prepared.prompt.systemPrompt);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildReviewTaskContext", () => {
  it("includes all optional fields when present", () => {
    const event = createReviewEvent({
      triggerName: "gitea-internal",
      provider: "gitea",
      workspaceId: "ws",
      targetKind: "pull_request",
      repoRef: "owent/example",
      baseSha: "abc123",
      headSha: "def456",
      author: { username: "owent" },
      reason: "gitea:opened",
      url: "https://gitea.internal/pulls/1",
    });
    const context = buildReviewTaskContext(event, ["src/a.ts", "src/b.ts"]);

    expect(context).toContain("Review target: pull_request");
    expect(context).toContain("Provider: gitea");
    expect(context).toContain("Workspace: ws");
    expect(context).toContain("Trigger: gitea-internal");
    expect(context).toContain("Repository: owent/example");
    expect(context).toContain("Reason: gitea:opened");
    expect(context).toContain("Base SHA: abc123");
    expect(context).toContain("Head SHA: def456");
    expect(context).toContain("URL: https://gitea.internal/pulls/1");
    expect(context).toContain("- src/a.ts");
    expect(context).toContain("- src/b.ts");
  });

  it("omits optional fields when not present", () => {
    const event = createReviewEvent({
      triggerName: "cron-nightly",
      provider: "scheduled",
      workspaceId: "ws",
      targetKind: "scheduled",
      repoRef: "owent/example",
      author: {},
      reason: "scheduled:cron",
    });
    const context = buildReviewTaskContext(event, []);

    expect(context).toContain("Review target: scheduled");
    expect(context).not.toContain("Base SHA:");
    expect(context).not.toContain("Head SHA:");
    expect(context).not.toContain("URL:");
    expect(context).toContain("- (not provided)");
  });
});

describe("estimatePromptTokens", () => {
  it("returns ceil(length/4) for ASCII text", () => {
    expect(estimatePromptTokens("abcd")).toBe(1);
    expect(estimatePromptTokens("abcde")).toBe(2);
    expect(estimatePromptTokens("")).toBe(0);
  });

  it("scales linearly with text length", () => {
    const short = estimatePromptTokens("hello");
    const long = estimatePromptTokens("hello world, this is a longer prompt");
    expect(long).toBeGreaterThan(short);
  });

  it("estimates CJK characters at roughly 2 tokens per character", () => {
    const cjk = estimatePromptTokens("你好");
    const ascii = estimatePromptTokens("ab");
    expect(cjk).toBeGreaterThan(ascii);
    expect(cjk).toBe(4);
  });

  it("handles mixed CJK and ASCII text", () => {
    const tokens = estimatePromptTokens("Hello 世界");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it("handles empty string", () => {
    expect(estimatePromptTokens("")).toBe(0);
  });

  it("handles surrogate pairs (emoji)", () => {
    const tokens = estimatePromptTokens("🎉");
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("renderPromptTemplate", () => {
  it("replaces all placeholders with their values", () => {
    const result = renderPromptTemplate("Hello {{NAME}}, welcome to {{PLACE}}!", {
      NAME: "Alice",
      PLACE: "Wonderland",
    });
    expect(result).toBe("Hello Alice, welcome to Wonderland!");
  });

  it("leaves unreplaced placeholders intact", () => {
    const result = renderPromptTemplate("Hello {{NAME}}, {{MISSING}} stays.", {
      NAME: "Bob",
    });
    expect(result).toBe("Hello Bob, {{MISSING}} stays.");
  });

  it("handles empty sections map", () => {
    const result = renderPromptTemplate("No placeholders here.", {});
    expect(result).toBe("No placeholders here.");
  });
});