import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReviewEvent } from "@aicr/core";
import { describe, expect, it } from "vitest";

import { createGitVcsAdapter, type GitCommandRunner } from "../src/git.js";

describe("GitVcsAdapter", () => {
  it("rejects a non-positive deepenBy value", () => {
    expect(() =>
      createGitVcsAdapter({
        repositoryDir: "C:/repo",
        deepenBy: 0,
      }),
    ).toThrow("deepenBy must be a positive integer.");
  });

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

  it("deepens a shallow repository and retries listChanges when enabled", async () => {
    const mutableCalls: string[][] = [];
    let diffAttempts = 0;
    const git: GitCommandRunner = async (args) => {
      mutableCalls.push([...args]);
      if (args[2] === "diff") {
        diffAttempts += 1;
        if (diffAttempts === 1) {
          throw new Error("fatal: bad revision 'base..head'");
        }
        return { stdout: "src/app.ts\n", stderr: "" };
      }

      if (args[2] === "fetch") {
        return { stdout: "", stderr: "" };
      }

      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git, allowDeepen: true });
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

    expect(range.files).toEqual(["src/app.ts"]);
    expect(mutableCalls).toEqual([
      ["-C", expect.stringMatching(/repo$/u), "diff", "--name-only", "--diff-filter=ACMRT", "base..head", "--"],
      ["-C", expect.stringMatching(/repo$/u), "fetch", "--deepen=100", "origin"],
      ["-C", expect.stringMatching(/repo$/u), "diff", "--name-only", "--diff-filter=ACMRT", "base..head", "--"],
    ]);
  });

  it("does not deepen a shallow repository when disabled", async () => {
    const mutableCalls: string[][] = [];
    const git: GitCommandRunner = async (args) => {
      mutableCalls.push([...args]);
      throw new Error("fatal: bad revision 'base..head'");
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git, allowDeepen: false });
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

    await expect(adapter.listChanges(event)).rejects.toThrow(/bad revision/u);
    expect(mutableCalls).toEqual([
      ["-C", expect.stringMatching(/repo$/u), "diff", "--name-only", "--diff-filter=ACMRT", "base..head", "--"],
    ]);
  });

  it("falls back to ReviewEvent.changedFiles when git diff fails", async () => {
    const adapter = createGitVcsAdapter({
      repositoryDir: "C:/repo",
      git: async () => {
        throw new Error("fatal: not a git repository");
      },
    });
    const event = createReviewEvent({
      triggerName: "gitea",
      provider: "gitea",
      workspaceId: "ws",
      targetKind: "push",
      repoRef: "owent/example",
      baseSha: "base",
      headSha: "head",
      changedFiles: ["src/app.ts"],
      author: { username: "owent" },
      reason: "gitea:push",
    });

    await expect(adapter.listChanges(event)).resolves.toEqual({
      baseRevision: "base",
      headRevision: "head",
      files: ["src/app.ts"],
    });
  });

  it("clones a configured remote before listing changes when the source repo is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-clone-"));
    const repositoryDir = join(tempDir, "source", "owent_example");
    const mutableCalls: string[][] = [];
    const git: GitCommandRunner = async (args) => {
      mutableCalls.push([...args]);
      if (args[2] === "rev-parse") {
        throw new Error("fatal: not a git repository");
      }

      if (args[0] === "clone") {
        return { stdout: "", stderr: "" };
      }

      if (args[2] === "fetch" && args[3] === "origin" && args[4]?.includes("refs/pull")) {
        return { stdout: "", stderr: "" };
      }

      if (args[2] === "diff") {
        return { stdout: "DedicatedServerBuildLinux.jenkinsfile\n", stderr: "" };
      }

      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const adapter = createGitVcsAdapter({
      repositoryDir,
      git,
      remoteUrl: "https://git.example.com/owent/example.git",
    });
    const event = createReviewEvent({
      triggerName: "gitea",
      provider: "gitea",
      workspaceId: "ws",
      targetKind: "push",
      repoRef: "owent/example",
      baseSha: "base",
      headSha: "head",
      changedFiles: ["DedicatedServerBuildLinux.jenkinsfile"],
      author: {},
      reason: "gitea:push",
    });

    const range = await adapter.listChanges(event);

    expect(range.files).toEqual(["DedicatedServerBuildLinux.jenkinsfile"]);
    expect(mutableCalls).toEqual([
      ["-C", repositoryDir, "rev-parse", "--is-inside-work-tree"],
      ["clone", "--no-checkout", "https://git.example.com/owent/example.git", repositoryDir],
      ["-C", repositoryDir, "fetch", "origin", "+refs/pull/*/head:refs/remotes/origin/pr/*"],
      ["-C", repositoryDir, "diff", "--name-only", "--diff-filter=ACMRT", "base..head", "--"],
    ]);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("fetches an existing configured remote before diffing", async () => {
    const mutableCalls: string[][] = [];
    const git: GitCommandRunner = async (args) => {
      mutableCalls.push([...args]);
      if (args[2] === "rev-parse") {
        return { stdout: "true\n", stderr: "" };
      }

      if (args[2] === "remote" && args[3] === "set-url") {
        return { stdout: "", stderr: "" };
      }

      if (args[2] === "fetch") {
        return { stdout: "", stderr: "" };
      }

      if (args[2] === "diff") {
        return { stdout: "src/app.ts\n", stderr: "" };
      }

      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const adapter = createGitVcsAdapter({
      repositoryDir: "C:/repo",
      git,
      remoteUrl: "https://git.example.com/owent/example.git",
    });
    const event = createReviewEvent({
      triggerName: "gitea",
      provider: "gitea",
      workspaceId: "ws",
      targetKind: "push",
      repoRef: "owent/example",
      baseSha: "base",
      headSha: "head",
      author: {},
      reason: "gitea:push",
    });

    await expect(adapter.listChanges(event)).resolves.toEqual({
      baseRevision: "base",
      headRevision: "head",
      files: ["src/app.ts"],
    });
    expect(mutableCalls).toEqual([
      ["-C", expect.stringMatching(/repo$/u), "rev-parse", "--is-inside-work-tree"],
      ["-C", expect.stringMatching(/repo$/u), "remote", "set-url", "origin", "https://git.example.com/owent/example.git"],
      ["-C", expect.stringMatching(/repo$/u), "fetch", "--prune", "origin"],
      ["-C", expect.stringMatching(/repo$/u), "fetch", "origin", "+refs/pull/*/head:refs/remotes/origin/pr/*"],
      ["-C", expect.stringMatching(/repo$/u), "diff", "--name-only", "--diff-filter=ACMRT", "base..head", "--"],
    ]);
  });

  it("clones with embedded token in remote URL when token is provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-auth-url-"));
    const repositoryDir = join(tempDir, "source", "atsf4g-co");
    const calls: string[][] = [];
    const git = async (args: readonly string[]): Promise<GitCommandResult> => {
      calls.push([...args]);
      if (args.includes("clone")) {
        return { stdout: "", stderr: "Cloning..." };
      }
      if (args.includes("diff")) {
        return { stdout: "src/app.ts\n", stderr: "" };
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const adapter = createGitVcsAdapter({
      repositoryDir,
      git,
      remoteUrl: "https://github.com/atframework/atsf4g-co.git",
      token: "github_pat_test123",
    });
    const event = createReviewEvent({
      triggerName: "github",
      provider: "github",
      workspaceId: "ws",
      targetKind: "pull_request",
      repoRef: "atframework/atsf4g-co",
      baseSha: "aaa",
      headSha: "bbb",
      author: {},
      reason: "github:opened",
    });

    const result = await adapter.listChanges(event);
    expect(result.files).toEqual(["src/app.ts"]);
    const cloneCall = calls.find((c) => c.includes("clone"));
    expect(cloneCall).toBeDefined();
    expect(cloneCall?.some((arg) => arg.includes("http.extraHeader"))).toBe(false);
    const cloneUrl = cloneCall!.find((a) => a.includes("x-access-token:"));
    expect(cloneUrl).toContain("x-access-token:github_pat_test123@github.com");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses an auth header when the remote URL cannot embed a token", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-auth-header-"));
    const repositoryDir = join(tempDir, "source", "org_repo");
    const calls: string[][] = [];
    const git: GitCommandRunner = async (args) => {
      calls.push([...args]);
      if (args.includes("rev-parse")) {
        throw new Error("fatal: not a git repository");
      }
      if (args.includes("clone") || args.includes("fetch")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("diff")) {
        return { stdout: "src/app.ts\n", stderr: "" };
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const adapter = createGitVcsAdapter({
      repositoryDir,
      git,
      remoteUrl: "git@github.com:org/repo.git",
      token: "ssh-remote-token",
    });
    const event = createReviewEvent({
      triggerName: "github",
      provider: "github",
      workspaceId: "ws",
      targetKind: "pull_request",
      repoRef: "org/repo",
      baseSha: "aaa",
      headSha: "bbb",
      author: {},
      reason: "github:opened",
    });

    await expect(adapter.listChanges(event)).resolves.toMatchObject({ files: ["src/app.ts"] });

    const cloneCall = calls.find((c) => c.includes("clone"));
    expect(cloneCall).toBeDefined();
    expect(cloneCall?.slice(0, 2)).toEqual(["-c", "http.extraHeader=Authorization: token ssh-remote-token"]);
    expect(cloneCall).toContain("git@github.com:org/repo.git");

    await rm(tempDir, { recursive: true, force: true });
  });

  it("redacts URL-embedded token from Git command errors", async () => {
    const adapter = createGitVcsAdapter({
      repositoryDir: "C:/repo",
      token: "secret-token",
      remoteUrl: "https://github.com/user/repo.git",
      git: async (args) => {
        throw new Error(`failed git clone ${args.join(" ")}`);
      },
    });

    let thrown: unknown;
    try {
      await adapter.diff({ baseRevision: "a", headRevision: "b", files: ["f.ts"] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain("secret-token");
  });

  it("redacts authentication headers from Git command errors", async () => {
    const adapter = createGitVcsAdapter({
      repositoryDir: "C:/repo",
      token: "secret-token",
      git: async (args) => {
        throw new Error(`failed git ${args.join(" ")}`);
      },
    });

    let thrown: unknown;
    try {
      await adapter.diff({ baseRevision: "base", headRevision: "head", files: ["src/app.ts"] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(/Authorization: token \*\*\*/u);
    expect(String(thrown)).not.toContain("secret-token");
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

  it("fetches a not-yet-materialized related file from the head revision via git show", async () => {
    // Mirrors production: fetchScoped only writes changed files, so a related
    // header the agent asks about is absent from the workspace and must be
    // pulled from the repo. Before the fix this threw ENOENT and the
    // orchestrator logged "ignored invalid fetch_more_context tool call".
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-fallback-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (last === "abc123:include/atapp/atapp.h") {
          return { stdout: "#pragma once\nint atapp_run();\n", stderr: "" };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), git });

      const result = await adapter.fetchExtraContext(
        { path: "include/atapp/atapp.h", revision: "abc123", reason: "need the header" },
        { id: "ws", sourceDir },
      );

      expect(result.content).toBe("#pragma once\nint atapp_run();\n");
      // The fetched file must be persisted so the follow-up pass (and a direct
      // workspace read) sees it without re-running git.
      await expect(
        readFile(join(sourceDir, "include", "atapp", "atapp.h"), "utf8"),
      ).resolves.toBe("#pragma once\nint atapp_run();\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads the persisted file on the second fetchExtraContext without git show", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-persist-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      let gitCalls = 0;
      const git: GitCommandRunner = async (args) => {
        gitCalls += 1;
        const last = args.at(-1);
        if (last === "rev1:src/related.ts") {
          return { stdout: "export const x = 1;\n", stderr: "" };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), git });

      const first = await adapter.fetchExtraContext(
        { path: "src/related.ts", revision: "rev1", reason: "first fetch" },
        { id: "ws", sourceDir },
      );
      const second = await adapter.fetchExtraContext(
        { path: "src/related.ts", revision: "rev1", reason: "second fetch" },
        { id: "ws", sourceDir },
      );

      expect(first.content).toBe("export const x = 1;\n");
      expect(second.content).toBe("export const x = 1;\n");
      expect(gitCalls).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when the related file is absent and no revision is provided", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-norev-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const adapter = createGitVcsAdapter({
        repositoryDir: tempDir,
        git: async () => ({ stdout: "", stderr: "" }),
      });

      await expect(
        adapter.fetchExtraContext(
          { path: "missing.ts", reason: "no revision" },
          { id: "ws", sourceDir },
        ),
      ).rejects.toThrow();
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

  it("deepens a shallow repository and retries diff parsing when enabled", async () => {
    let diffAttempts = 0;
    const git: GitCommandRunner = async (args) => {
      if (args[2] === "fetch") {
        return { stdout: "", stderr: "" };
      }

      diffAttempts += 1;
      if (diffAttempts === 1) {
        throw new Error("fatal: ambiguous argument 'base..head': unknown revision");
      }

      return {
        stdout: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
        stderr: "",
      };
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git, allowDeepen: true });

    const diff = await adapter.diff({ baseRevision: "base", headRevision: "head", files: ["src/app.ts"] });

    expect(diff.files[0]?.newPath).toBe("src/app.ts");
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
