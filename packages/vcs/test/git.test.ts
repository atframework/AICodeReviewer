import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReviewEvent } from "@aicr/core";
import { describe, expect, it } from "vitest";

import { createGitVcsAdapter, type GitCommandRunner } from "../src/git.js";

describe("GitVcsAdapter", () => {
  it("lists changed files from git diff when revisions are present", async () => {
    const mutableCalls: string[][] = [];
    const git: GitCommandRunner = async (args) => {
      mutableCalls.push([...args]);
      return { stdout: "src/app.ts\nREADME.md\n", stderr: "" };
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });
    const event = createReviewEvent({
      triggerName: "manual",
      provider: "manual",
      workspaceId: "ws",
      targetKind: "manual",
      repoRef: "owent/example",
      baseSha: "base",
      headSha: "head",
      author: { username: "owent" },
      reason: "manual:test",
    });

    const range = await adapter.listChanges(event);

    expect(range).toEqual({ baseRevision: "base", headRevision: "head", files: ["src/app.ts", "README.md"] });
    expect(mutableCalls).toEqual([
      ["-C", expect.stringMatching(/repo$/u), "diff", "--name-only", "--diff-filter=ACMRT", "base..head", "--"],
    ]);
  });

  it("falls back to ReviewEvent.changedFiles when revisions are absent", async () => {
    const adapter = createGitVcsAdapter({
      repositoryDir: "C:/repo",
      git: async () => {
        throw new Error("git should not be called");
      },
    });
    const event = createReviewEvent({
      triggerName: "manual",
      provider: "manual",
      workspaceId: "ws",
      targetKind: "manual",
      repoRef: "owent/example",
      changedFiles: ["./src/app.ts", "src/app.ts"],
      author: { username: "owent" },
      reason: "manual:test",
    });

    await expect(adapter.listChanges(event)).resolves.toEqual({ files: ["src/app.ts"] });
  });

  it("materializes scoped text files from the head revision", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-adapter-"));

    try {
      const git: GitCommandRunner = async (args) => {
        const spec = args.at(-1);
        if (spec === "head:src/app.ts") {
          return { stdout: "export const app = true;\n", stderr: "" };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: tempDir, git });

      const tree = await adapter.fetchScoped(
        { baseRevision: "base", headRevision: "head", files: ["src/app.ts", "deleted.ts"] },
        { id: "ws", sourceDir: join(tempDir, "source") },
      );

      expect(tree.workspaceId).toBe("ws");
      expect(tree.fetchedFiles).toEqual(["src/app.ts"]);
      await expect(readFile(join(tempDir, "source", "src", "app.ts"), "utf8")).resolves.toBe(
        "export const app = true;\n",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns bounded extra context by line range", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "file.ts"), ["one", "two", "three", "four"].join("\n"), "utf8");
      const adapter = createGitVcsAdapter({
        repositoryDir: tempDir,
        git: async () => ({ stdout: "", stderr: "" }),
      });

      const result = await adapter.fetchExtraContext(
        { path: "file.ts", startLine: 2, endLine: 3, reason: "test" },
        { id: "ws", sourceDir },
      );

      expect(result).toEqual({ path: "file.ts", content: "two\nthree" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses git diff output through the adapter", async () => {
    const git: GitCommandRunner = async () => ({
      stdout: [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
      stderr: "",
    });
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    const diff = await adapter.diff({ baseRevision: "base", headRevision: "head", files: ["src/app.ts"] });

    expect(diff.files[0]?.newPath).toBe("src/app.ts");
    expect(diff.files[0]?.hunks[0]?.lines.map((line) => line.kind)).toEqual(["delete", "add"]);
  });

  it("throws when listChanges has neither revisions nor changedFiles", async () => {
    const adapter = createGitVcsAdapter({
      repositoryDir: "C:/repo",
      git: async () => ({ stdout: "", stderr: "" }),
    });
    const event = createReviewEvent({
      triggerName: "manual",
      provider: "manual",
      workspaceId: "ws",
      targetKind: "manual",
      repoRef: "owent/example",
      author: {},
      reason: "manual:test",
    });

    await expect(adapter.listChanges(event)).rejects.toThrow(
      "Git listChanges requires base/head revisions or ReviewEvent.changedFiles.",
    );
  });

  it("returns empty fetchedFiles when no headRevision is provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-no-rev-"));

    try {
      const adapter = createGitVcsAdapter({
        repositoryDir: tempDir,
        git: async () => ({ stdout: "", stderr: "" }),
      });
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });

      const tree = await adapter.fetchScoped(
        { files: ["src/app.ts"] },
        { id: "ws", sourceDir },
      );

      expect(tree.fetchedFiles).toEqual([]);
      expect(tree.workspaceId).toBe("ws");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fetches full file content when no line range is specified", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-full-file-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "full.ts"), "one\ntwo\nthree\n", "utf8");
      const adapter = createGitVcsAdapter({
        repositoryDir: tempDir,
        git: async () => ({ stdout: "", stderr: "" }),
      });

      const result = await adapter.fetchExtraContext(
        { path: "full.ts", reason: "full file" },
        { id: "ws", sourceDir },
      );

      expect(result.content).toBe("one\ntwo\nthree\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults startLine to 1 when only endLine is specified", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-endline-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "file.ts"), "a\nb\nc\nd\ne\n", "utf8");
      const adapter = createGitVcsAdapter({
        repositoryDir: tempDir,
        git: async () => ({ stdout: "", stderr: "" }),
      });

      const result = await adapter.fetchExtraContext(
        { path: "file.ts", endLine: 2, reason: "first two lines" },
        { id: "ws", sourceDir },
      );

      expect(result.content).toBe("a\nb");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults endLine to the file length when only startLine is specified", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-startline-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "file.ts"), "a\nb\nc\n", "utf8");
      const adapter = createGitVcsAdapter({
        repositoryDir: tempDir,
        git: async () => ({ stdout: "", stderr: "" }),
      });

      const result = await adapter.fetchExtraContext(
        { path: "file.ts", startLine: 2, reason: "from second to end" },
        { id: "ws", sourceDir },
      );

      expect(result.content).toBe("b\nc\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when startLine is greater than endLine", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-line-order-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "file.ts"), "a\nb\n", "utf8");
      const adapter = createGitVcsAdapter({
        repositoryDir: tempDir,
        git: async () => ({ stdout: "", stderr: "" }),
      });

      await expect(
        adapter.fetchExtraContext(
          { path: "file.ts", startLine: 5, endLine: 2, reason: "bad range" },
          { id: "ws", sourceDir },
        ),
      ).rejects.toThrow("startLine must be less than or equal to endLine.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when startLine is not a positive integer", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-bad-startline-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "file.ts"), "a\n", "utf8");
      const adapter = createGitVcsAdapter({
        repositoryDir: tempDir,
        git: async () => ({ stdout: "", stderr: "" }),
      });

      await expect(
        adapter.fetchExtraContext(
          { path: "file.ts", startLine: 0, endLine: 1, reason: "zero startLine" },
          { id: "ws", sourceDir },
        ),
      ).rejects.toThrow("startLine must be a positive integer.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses changedFiles from event when git diff returns empty output", async () => {
    const git: GitCommandRunner = async () => ({ stdout: "", stderr: "" });
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });
    const event = createReviewEvent({
      triggerName: "manual",
      provider: "manual",
      workspaceId: "ws",
      targetKind: "manual",
      repoRef: "owent/example",
      baseSha: "base",
      headSha: "head",
      changedFiles: ["fallback.ts"],
      author: {},
      reason: "manual:test",
    });

    const range = await adapter.listChanges(event);

    expect(range.files).toEqual(["fallback.ts"]);
    expect(range.baseRevision).toBe("base");
    expect(range.headRevision).toBe("head");
  });

  it("throws when diff is called without revisions", async () => {
    const adapter = createGitVcsAdapter({
      repositoryDir: "C:/repo",
      git: async () => ({ stdout: "", stderr: "" }),
    });

    await expect(
      adapter.diff({ files: ["a.ts"] }),
    ).rejects.toThrow("Git diff requires both baseRevision and headRevision.");
  });
});
