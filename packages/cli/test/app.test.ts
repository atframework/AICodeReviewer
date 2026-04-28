import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/app.js";

class MemoryWriter {
  public output = "";

  write(text: string): void {
    this.output += text;
  }
}

async function writeWorkspaceFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(rootDir, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("runCli", () => {
  it("runs the review command and prints the prepared review prompt summary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-cli-review-"));

    try {
      await writeWorkspaceFile(
        tempDir,
        "prompts/system/code-reviewer.system.md",
        [
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
      );
      await writeWorkspaceFile(tempDir, "src/AGENTS.md", "# Source\nUse transactions for auth writes.\n");

      const stdout = new MemoryWriter();
      const stderr = new MemoryWriter();
      const exitCode = await runCli(
        [
          "review",
          "--repo",
          "owent/example",
          "--workspace",
          "ws",
          "--source-root",
          ".",
          "--changed-file",
          "src/auth/login.ts",
        ],
        { cwd: tempDir, stdout, stderr },
      );

      const parsed = JSON.parse(stdout.output) as {
        reviewPreparation?: { systemPrompt?: string; instructionCount?: number; changedPaths?: string[] };
      };

      expect(exitCode).toBe(0);
      expect(stderr.output).toBe("");
      expect(parsed.reviewPreparation?.instructionCount).toBeGreaterThanOrEqual(1);
      expect(parsed.reviewPreparation?.systemPrompt).toContain("src/AGENTS.md");
      expect(parsed.reviewPreparation?.changedPaths).toContain("src/auth/login.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns an error when review is missing the required repo flag", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    const exitCode = await runCli(["review"], { stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("requires --repo");
  });

  it("prints the version when --version is passed", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const exitCode = await runCli(["--version"], { stdout, stderr });
    expect(exitCode).toBe(0);
    expect(stdout.output.trim()).toBe("0.1.0");
    expect(stderr.output).toBe("");
  });

  it("prints help when no command is provided", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const exitCode = await runCli([], { stdout, stderr });
    expect(exitCode).toBe(0);
    expect(stdout.output).toContain("AICodeReviewer CLI");
    expect(stdout.output).toContain("Commands:");
  });

  it("prints help when --help is provided alongside a command", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const exitCode = await runCli(["--help", "review"], { stdout, stderr });
    expect(exitCode).toBe(0);
    expect(stdout.output).toContain("AICodeReviewer CLI");
  });

  it("returns a friendly error when argument parsing fails", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const exitCode = await runCli(["--definitely-unknown-flag"], { stdout, stderr });
    expect(exitCode).toBe(1);
    expect(stdout.output).toBe("");
    expect(stderr.output).toContain("aicr failed to parse arguments:");
  });

  it("prints diagnostics for the doctor command", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const exitCode = await runCli(["doctor", "--config", "config.toml"], {
      cwd: process.cwd(),
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.output) as { node: string; config: string | null };
    expect(parsed.node).toBe(process.version);
    expect(parsed.config).toBe("config.toml");
  });

  it("falls through to a scaffolded message for unknown commands", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const exitCode = await runCli(["serve"], { stdout, stderr });
    expect(exitCode).toBe(0);
    expect(stdout.output).toContain('Command "serve" is scaffolded');
  });

  it("returns an error when --max-prompt-tokens is not a positive integer", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const exitCode = await runCli(
      ["review", "--repo", "owent/example", "--max-prompt-tokens", "0"],
      { stdout, stderr },
    );
    expect(exitCode).toBe(1);
    expect(stderr.output).toContain("--max-prompt-tokens must be a positive integer");
  });

  it("returns an error with a friendly message when the base prompt template cannot be loaded", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-cli-missing-prompt-"));
    try {
      const stdout = new MemoryWriter();
      const stderr = new MemoryWriter();
      const exitCode = await runCli(
        ["review", "--repo", "owent/example"],
        { cwd: tempDir, stdout, stderr },
      );
      expect(exitCode).toBe(1);
      expect(stderr.output).toContain("aicr review failed:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns an error when the provider is not in the supported enum", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-cli-bad-provider-"));
    try {
      await writeWorkspaceFile(
        tempDir,
        "prompts/system/code-reviewer.system.md",
        "<task>\n{{TASK_CONTEXT}}\n</task>\n",
      );
      const stdout = new MemoryWriter();
      const stderr = new MemoryWriter();
      const exitCode = await runCli(
        ["review", "--repo", "owent/example", "--provider", "unsupported"],
        { cwd: tempDir, stdout, stderr },
      );
      expect(exitCode).toBe(1);
      expect(stderr.output).toContain("aicr review failed:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates author, sha, and url options into the resulting review event", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-cli-options-"));
    try {
      await writeWorkspaceFile(
        tempDir,
        "prompts/system/code-reviewer.system.md",
        "<task>\n{{TASK_CONTEXT}}\n</task>\n",
      );
      const stdout = new MemoryWriter();
      const stderr = new MemoryWriter();
      const exitCode = await runCli(
        [
          "review",
          "--repo",
          "owent/example",
          "--base-sha",
          "base-1",
          "--head-sha",
          "head-2",
          "--url",
          "https://example.com/owent/example/pulls/1",
          "--author-username",
          "owent",
          "--author-email",
          "owent@example.com",
          "--author-display-name",
          "OwEnt",
          "--operator-override",
          "Be terse.",
          "--memory-hint",
          "Recent memory.",
          "--task-context",
          "Custom task context",
        ],
        { cwd: tempDir, stdout, stderr },
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.output) as {
        reviewEvent: {
          baseSha?: string;
          headSha?: string;
          url?: string;
          author?: { username?: string; email?: string; displayName?: string };
        };
        reviewPreparation?: { taskContext?: string };
      };
      expect(parsed.reviewEvent.baseSha).toBe("base-1");
      expect(parsed.reviewEvent.headSha).toBe("head-2");
      expect(parsed.reviewEvent.url).toBe("https://example.com/owent/example/pulls/1");
      expect(parsed.reviewEvent.author?.username).toBe("owent");
      expect(parsed.reviewEvent.author?.email).toBe("owent@example.com");
      expect(parsed.reviewEvent.author?.displayName).toBe("OwEnt");
      expect(parsed.reviewPreparation?.taskContext).toBe("Custom task context");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});