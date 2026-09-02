import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createReviewEvent } from "@aicr/core";
import { describe, expect, it } from "vitest";

import { createGitVcsAdapter, resolveRelativeGitUrl, type GitCommandRunner } from "../src/git.js";

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

  it("fetches the submodule repository automatically for a gitlink path", async () => {
    // Mirrors production: the agent asked for atframework/libatbus, which is a
    // submodule gitlink (mode 160000) in the superproject. `git show
    // <rev>:<path>` fails with "fatal: bad object"; AICR must clone the
    // submodule at the pinned commit and answer with its root listing instead
    // of letting the orchestrator log "ignored invalid fetch_more_context
    // tool call" while the agent retries.
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-gitlink-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const cloneCalls: string[][] = [];
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (last === "abc123:atframework/libatbus") {
          throw new Error("fatal: bad object abc123:atframework/libatbus");
        }
        if (last === "abc123:.gitmodules") {
          return {
            stdout: '[submodule "libatbus"]\n\tpath = atframework/libatbus\n\turl = https://github.com/atframework/libatbus.git\n',
            stderr: "",
          };
        }
        if (args.includes("ls-tree") && last === "atframework/libatbus") {
          return {
            stdout: "160000 commit 37852fb67088162f9d8ad49f33324af7d9bce31e\tatframework/libatbus\n",
            stderr: "",
          };
        }
        if (args.includes("rev-parse")) {
          throw new Error("not a git repository");
        }
        if (args.includes("clone")) {
          cloneCalls.push([...args]);
          return { stdout: "", stderr: "" };
        }
        if (args.includes("cat-file")) {
          return { stdout: "", stderr: "" };
        }
        if (args.includes("ls-tree") && last === "37852fb67088162f9d8ad49f33324af7d9bce31e") {
          return {
            stdout: [
              "100644 blob aaa111\tCMakeLists.txt",
              "040000 tree bbb222\tinclude",
              "040000 tree ccc333\tsrc",
            ].join("\n") + "\n",
            stderr: "",
          };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), git });

      const result = await adapter.fetchExtraContext(
        { path: "atframework/libatbus", revision: "abc123", reason: "check the submodule" },
        { id: "ws", sourceDir },
      );

      expect(cloneCalls).toHaveLength(1);
      expect(cloneCalls[0]).toContain("https://github.com/atframework/libatbus.git");
      expect(result.path).toBe("atframework/libatbus");
      expect(result.content).toContain("fetched the submodule repository automatically");
      expect(result.content).toContain("pinned at commit 37852fb67088162f9d8ad49f33324af7d9bce31e");
      expect(result.content).toContain("https://github.com/atframework/libatbus.git");
      expect(result.content).toContain("- file: CMakeLists.txt");
      expect(result.content).toContain("- dir: include");
      await expect(
        readFile(join(sourceDir, "atframework", "libatbus"), "utf8"),
      ).resolves.toBe(result.content);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads a file inside a submodule from the auto-fetched pinned commit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-gitlink-inner-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const cloneCalls: string[][] = [];
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (last === "abc123:atframework/libatbus/include/foo.h") {
          throw new Error("fatal: bad object abc123:atframework/libatbus/include/foo.h");
        }
        if (last === "abc123:.gitmodules") {
          return {
            stdout: '[submodule "libatbus"]\n\tpath = atframework/libatbus\n\turl = ../libatbus.git\n',
            stderr: "",
          };
        }
        if (args.includes("ls-tree") && args.includes("abc123")) {
          if (last === "atframework/libatbus") {
            return {
              stdout: "160000 commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\tatframework/libatbus\n",
              stderr: "",
            };
          }
          return { stdout: "", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          throw new Error("not a git repository");
        }
        if (args.includes("clone")) {
          cloneCalls.push([...args]);
          return { stdout: "", stderr: "" };
        }
        if (args.includes("cat-file")) {
          return { stdout: "", stderr: "" };
        }
        if (last === "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef:include/foo.h") {
          return { stdout: "#pragma once\nint foo();\n", stderr: "" };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({
        repositoryDir: join(tempDir, "repo"),
        remoteUrl: "https://github.com/atframework/libatapp.git",
        token: "secret-token",
        git,
      });

      const result = await adapter.fetchExtraContext(
        { path: "atframework/libatbus/include/foo.h", revision: "abc123", reason: "read a submodule header" },
        { id: "ws", sourceDir },
      );

      expect(result.content).toBe("#pragma once\nint foo();\n");
      await expect(
        readFile(join(sourceDir, "atframework", "libatbus", "include", "foo.h"), "utf8"),
      ).resolves.toBe("#pragma once\nint foo();\n");
      // The relative .gitmodules URL resolves against the superproject remote
      // and the same-host token is embedded for authentication.
      expect(cloneCalls).toHaveLength(1);
      expect(cloneCalls[0]).toContain("https://x-access-token:secret-token@github.com/atframework/libatbus.git");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not leak the superproject token to a different submodule host", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-gitlink-host-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const cloneCalls: string[][] = [];
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (last === "abc123:ext/lib") {
          throw new Error("fatal: bad object abc123:ext/lib");
        }
        if (last === "abc123:.gitmodules") {
          return {
            stdout: '[submodule "lib"]\n\tpath = ext/lib\n\turl = https://other.example.com/lib.git\n',
            stderr: "",
          };
        }
        if (args.includes("ls-tree") && args.includes("abc123")) {
          return { stdout: "160000 commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\text/lib\n", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          throw new Error("not a git repository");
        }
        if (args.includes("clone")) {
          cloneCalls.push([...args]);
          return { stdout: "", stderr: "" };
        }
        if (args.includes("cat-file") || args.includes("ls-tree")) {
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({
        repositoryDir: join(tempDir, "repo"),
        remoteUrl: "https://github.com/atframework/libatapp.git",
        token: "secret-token",
        git,
      });

      await adapter.fetchExtraContext(
        { path: "ext/lib", revision: "abc123", reason: "check external submodule" },
        { id: "ws", sourceDir },
      );

      expect(cloneCalls).toHaveLength(1);
      expect(cloneCalls[0]).toContain("https://other.example.com/lib.git");
      expect(cloneCalls[0].join(" ")).not.toContain("secret-token");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retries the submodule clone after a transient failure", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-gitlink-retry-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      let cloneAttempts = 0;
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (last === "abc123:ext/lib") {
          throw new Error("fatal: bad object abc123:ext/lib");
        }
        if (last === "abc123:.gitmodules") {
          return { stdout: '[submodule "lib"]\n\tpath = ext/lib\n\turl = https://github.com/o/lib.git\n', stderr: "" };
        }
        if (args.includes("ls-tree") && args.includes("abc123")) {
          return { stdout: "160000 commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\text/lib\n", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          throw new Error("not a git repository");
        }
        if (args.includes("clone")) {
          cloneAttempts += 1;
          if (cloneAttempts === 1) {
            throw new Error("error: RPC failed; curl 56 GnuTLS recv error, early EOF");
          }
          return { stdout: "", stderr: "" };
        }
        if (args.includes("cat-file") || args.includes("ls-tree")) {
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), git });

      const result = await adapter.fetchExtraContext(
        { path: "ext/lib", revision: "abc123", reason: "check submodule" },
        { id: "ws", sourceDir },
      );

      expect(cloneAttempts).toBe(2);
      expect(result.content).toContain("fetched the submodule repository automatically");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to a scrubbed note when the submodule fetch ultimately fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-gitlink-fail-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (last === "abc123:ext/lib") {
          throw new Error("fatal: bad object abc123:ext/lib");
        }
        if (last === "abc123:.gitmodules") {
          return { stdout: '[submodule "lib"]\n\tpath = ext/lib\n\turl = https://github.com/o/lib.git\n', stderr: "" };
        }
        if (args.includes("ls-tree") && args.includes("abc123")) {
          return { stdout: "160000 commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\text/lib\n", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          throw new Error("not a git repository");
        }
        if (args.includes("clone")) {
          throw new Error("fatal: unable to access 'https://x-access-token:secret-token@github.com/o/lib.git/': The requested URL returned error: 403");
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({
        repositoryDir: join(tempDir, "repo"),
        remoteUrl: "https://github.com/atframework/libatapp.git",
        token: "secret-token",
        git,
      });

      const result = await adapter.fetchExtraContext(
        { path: "ext/lib", revision: "abc123", reason: "check submodule" },
        { id: "ws", sourceDir },
      );

      expect(result.content).toContain("failed after retries");
      expect(result.content).toContain("Do not retry aicr.fetch_more_context");
      expect(result.content).not.toContain("secret-token");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("notes when the pinned submodule commit is unreachable", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-gitlink-nocommit-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (last === "abc123:ext/lib") {
          throw new Error("fatal: bad object abc123:ext/lib");
        }
        if (last === "abc123:.gitmodules") {
          return { stdout: '[submodule "lib"]\n\tpath = ext/lib\n\turl = https://github.com/o/lib.git\n', stderr: "" };
        }
        if (args.includes("ls-tree") && args.includes("abc123")) {
          return { stdout: "160000 commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\text/lib\n", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          throw new Error("not a git repository");
        }
        if (args.includes("clone")) {
          return { stdout: "", stderr: "" };
        }
        if (args.includes("cat-file") || args.includes("fetch")) {
          throw new Error("fatal: git upload-pack: not our ref deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), git });

      const result = await adapter.fetchExtraContext(
        { path: "ext/lib", revision: "abc123", reason: "check submodule" },
        { id: "ws", sourceDir },
      );

      expect(result.content).toContain("not reachable");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a submodule note when no URL is recorded in .gitmodules", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-gitlink-nourl-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (last === "abc123:atframework/libatbus/include/foo.h") {
          throw new Error("fatal: bad object abc123:atframework/libatbus/include/foo.h");
        }
        if (last === "abc123:.gitmodules") {
          throw new Error("fatal: path '.gitmodules' does not exist in 'abc123'");
        }
        if (args.includes("ls-tree")) {
          if (last === "atframework/libatbus") {
            return {
              stdout: "160000 commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\tatframework/libatbus\n",
              stderr: "",
            };
          }
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), git });

      const result = await adapter.fetchExtraContext(
        { path: "atframework/libatbus/include/foo.h", revision: "abc123", reason: "read a submodule header" },
        { id: "ws", sourceDir },
      );

      expect(result.content).toContain('is inside the git submodule "atframework/libatbus"');
      expect(result.content).toContain("pinned at commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      expect(result.content).toContain("No submodule URL is recorded");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rethrows the git show error for a path missing at the revision", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-missing-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (last === "abc123:src/gone.ts") {
          throw new Error("fatal: path 'src/gone.ts' does not exist in 'abc123'");
        }
        if (args.includes("ls-tree")) {
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), git });

      await expect(
        adapter.fetchExtraContext(
          { path: "src/gone.ts", revision: "abc123", reason: "read a removed file" },
          { id: "ws", sourceDir },
        ),
      ).rejects.toThrow("does not exist in 'abc123'");
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

  it("propagates the error when git show also fails for a non-existent revision path", async () => {
    // The ENOENT → `git show` fallback must still terminate cleanly when the
    // path genuinely does not exist at the revision (or is a submodule gitlink).
    // Re-throwing is the stop-signal that tells the orchestrator this context
    // is unavailable instead of looping.
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-extra-showfail-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const git: GitCommandRunner = async (args) => {
        const last = args.at(-1);
        if (typeof last === "string" && last.startsWith("deadbeef:")) {
          throw new Error("fatal: Path 'does/not/exist.h' does not exist in 'deadbeef'");
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), git });

      await expect(
        adapter.fetchExtraContext(
          { path: "does/not/exist.h", revision: "deadbeef", reason: "genuinely missing" },
          { id: "ws", sourceDir },
        ),
      ).rejects.toThrow("does not exist");
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

  it("clamps endLine beyond the actual file content length", async () => {
    // A slice-based extraction silently clamps out-of-range endLine values
    // instead of throwing. This documents the boundary so the agent receives
    // the whole tail rather than an error when it overestimates line count.
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-clamp-"));

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "file.ts"), "a\nb\nc\n", "utf8");
      const adapter = createGitVcsAdapter({
        repositoryDir: tempDir,
        git: async () => ({ stdout: "", stderr: "" }),
      });

      const result = await adapter.fetchExtraContext(
        { path: "file.ts", startLine: 2, endLine: 1000, reason: "overestimate" },
        { id: "ws", sourceDir },
      );

      expect(result.content).toBe("b\nc\n");
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

describe("GitVcsAdapter.fetchAttribution", () => {
  // Mirrors real `git blame --line-porcelain`: the first line of each commit
  // group emits a 4-field header `<sha> <orig> <final> <num_lines>`; coalesced
  // subsequent lines emit a 3-field header. Lines 1-2 share Alice's commit;
  // line 3 is Bob's size-1 group.
  const porcelain = [
    "4f7d9a2b1234567890abcdef1234567890abcdef 1 1 2",
    "author Alice",
    "author-mail <alice@example.com>",
    "author-time 1705000000",
    "author-tz +0000",
    "committer Alice",
    "committer-mail <alice@example.com>",
    "committer-time 1705000000",
    "committer-tz +0000",
    "summary fix login flow",
    "filename src/auth.ts",
    "\tline one",
    "4f7d9a2b1234567890abcdef1234567890abcdef 2 2",
    "author Alice",
    "author-mail <alice@example.com>",
    "author-time 1705000000",
    "author-tz +0000",
    "committer Alice",
    "committer-mail <alice@example.com>",
    "committer-time 1705000000",
    "committer-tz +0000",
    "summary fix login flow",
    "filename src/auth.ts",
    "\tline two",
    "abcdef0987654321fedcba0987654321abcdef09 3 3 1",
    "author Bob",
    "author-mail <bob@example.com>",
    "author-time 1706000000",
    "author-tz +0100",
    "committer Bob",
    "committer-mail <bob@example.com>",
    "committer-time 1706000000",
    "committer-tz +0100",
    "summary refactor module",
    "filename src/auth.ts",
    "\tline three",
  ].join("\n");

  it("parses git blame --line-porcelain including 4-field group-start headers", async () => {
    const calls: string[][] = [];
    const git: GitCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: porcelain, stderr: "" };
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    const result = await adapter.fetchAttribution(
      { path: "src/auth.ts", revision: "def456", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(result.status).toBe("ok");
    expect(result.entries).toEqual([
      {
        line: 1,
        revision: "4f7d9a2b1234567890abcdef1234567890abcdef",
        author: "Alice",
        authorEmail: "alice@example.com",
        summary: "fix login flow",
      },
      {
        line: 2,
        revision: "4f7d9a2b1234567890abcdef1234567890abcdef",
        author: "Alice",
        authorEmail: "alice@example.com",
        summary: "fix login flow",
      },
      {
        line: 3,
        revision: "abcdef0987654321fedcba0987654321abcdef09",
        author: "Bob",
        authorEmail: "bob@example.com",
        summary: "refactor module",
      },
    ]);
    expect(calls[0]).toEqual([
      "-C",
      resolve("C:/repo"),
      "blame",
      "--line-porcelain",
      "def456",
      "--",
      "src/auth.ts",
    ]);
  });

  it("defaults the revision to HEAD when not provided", async () => {
    const calls: string[][] = [];
    const git: GitCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: porcelain, stderr: "" };
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    await adapter.fetchAttribution(
      { path: "src/auth.ts", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(calls[0]).toContain("HEAD");
  });

  it("filters attribution to the requested line range and uses native -L when bounded", async () => {
    const calls: string[][] = [];
    const git: GitCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: porcelain, stderr: "" };
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    const result = await adapter.fetchAttribution(
      { path: "src/auth.ts", startLine: 2, endLine: 2, revision: "def456", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.line).toBe(2);
    expect(result.entries[0]?.author).toBe("Alice");
    const lIndex = calls[0]?.indexOf("-L");
    expect(lIndex).toBeGreaterThan(-1);
    expect(calls[0]?.[Number(lIndex) + 1]).toBe("2,2");
  });

  it("returns not_found when the path does not exist at the revision", async () => {
    const git: GitCommandRunner = async () => {
      const error = new Error("fatal: no such path 'src/missing.ts' in HEAD");
      Object.assign(error, {
        stdout: "",
        stderr: "fatal: no such path 'src/missing.ts' in HEAD",
      });
      throw error;
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    const result = await adapter.fetchAttribution(
      { path: "src/missing.ts", revision: "def456", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(result).toEqual({ path: "src/missing.ts", status: "not_found", entries: [] });
  });

  it("returns not_found when blame produces no parseable output", async () => {
    const git: GitCommandRunner = async () => ({ stdout: "", stderr: "" });
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    const result = await adapter.fetchAttribution(
      { path: "src/auth.ts", revision: "def456", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(result.status).toBe("not_found");
    expect(result.entries).toEqual([]);
  });

  it("rejects a path that escapes the workspace source dir", async () => {
    const git: GitCommandRunner = async () => {
      throw new Error("git should not be called for an escaping path");
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    await expect(
      adapter.fetchAttribution(
        { path: "../escape.ts", revision: "def456", reason: "blame" },
        { id: "ws", sourceDir: "C:/repo/source" },
      ),
    ).rejects.toThrow("must stay within");
  });

  it("rejects an option-like revision to prevent git option injection", async () => {
    const git: GitCommandRunner = async () => {
      throw new Error("git should not be called for an option-like revision");
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    await expect(
      adapter.fetchAttribution(
        { path: "src/auth.ts", revision: "--output=/tmp/evil", reason: "blame" },
        { id: "ws", sourceDir: "C:/repo/source" },
      ),
    ).rejects.toThrow("must not be empty or option-like");
  });

  it("rethrows non-missing blame errors instead of masking them", async () => {
    const git: GitCommandRunner = async () => {
      throw new Error("network unreachable");
    };
    const adapter = createGitVcsAdapter({ repositoryDir: "C:/repo", git });

    await expect(
      adapter.fetchAttribution(
        { path: "src/auth.ts", revision: "def456", reason: "blame" },
        { id: "ws", sourceDir: "C:/repo/source" },
      ),
    ).rejects.toThrow("network unreachable");
  });

  it("retries transient network failures when syncing the repository", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-sync-retry-"));
    try {
      let cloneAttempts = 0;
      const git: GitCommandRunner = async (args) => {
        if (args[0] === "clone") {
          cloneAttempts += 1;
          if (cloneAttempts === 1) {
            throw new Error("fatal: unable to access 'https://example/repo.git/': Could not resolve host: example");
          }
          return { stdout: "", stderr: "" };
        }
        if (args[2] === "rev-parse") {
          throw new Error("not a git repository");
        }
        if (args[2] === "fetch") {
          return { stdout: "", stderr: "" };
        }
        if (args[2] === "diff") {
          return { stdout: "src/app.ts\n", stderr: "" };
        }
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), remoteUrl: "https://example/repo.git", git });
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
      expect(cloneAttempts).toBe(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not retry non-transient clone failures", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-sync-noretry-"));
    try {
      let cloneAttempts = 0;
      const git: GitCommandRunner = async (args) => {
        if (args[0] === "clone") {
          cloneAttempts += 1;
          throw new Error("fatal: repository 'https://example/nope.git/' not found");
        }
        if (args[2] === "rev-parse") {
          throw new Error("not a git repository");
        }
        return { stdout: "", stderr: "" };
      };
      const adapter = createGitVcsAdapter({ repositoryDir: join(tempDir, "repo"), remoteUrl: "https://example/nope.git", git });
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

      await expect(adapter.listChanges(event)).rejects.toThrow("not found");
      expect(cloneAttempts).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("resolveRelativeGitUrl", () => {
  it("passes absolute and scp-like submodule URLs through", () => {
    expect(resolveRelativeGitUrl("https://github.com/a/b.git", "https://github.com/c/d.git")).toBe("https://github.com/c/d.git");
    expect(resolveRelativeGitUrl("https://github.com/a/b.git", "git@github.com:c/d.git")).toBe("git@github.com:c/d.git");
  });

  it("resolves relative URLs against an http remote", () => {
    expect(resolveRelativeGitUrl("https://github.com/atframework/libatapp.git", "../libatbus.git")).toBe("https://github.com/atframework/libatbus.git");
    expect(resolveRelativeGitUrl("https://git.example.com/group/sub/proj.git", "../../other/x.git")).toBe("https://git.example.com/group/other/x.git");
  });

  it("resolves relative URLs against an scp-like remote", () => {
    expect(resolveRelativeGitUrl("git@github.com:atframework/libatapp.git", "../libatbus.git")).toBe("git@github.com:atframework/libatbus.git");
  });

  it("returns the submodule URL unchanged when no remote is known", () => {
    expect(resolveRelativeGitUrl(undefined, "../libatbus.git")).toBe("../libatbus.git");
  });
});
