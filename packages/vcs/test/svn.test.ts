import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReviewEvent, type ReviewEvent } from "@aicr/core";
import { describe, expect, it } from "vitest";

import { createSvnVcsAdapter, type SvnCommandRunner } from "../src/svn.js";

function makeEvent(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return createReviewEvent({
    triggerName: "svn-main",
    provider: "svn",
    workspaceId: "svn-workspace",
    targetKind: "commit",
    repoRef: "https://svn.example.com/repos/project/trunk",
    baseSha: "10",
    headSha: "12",
    reason: "svn:commit:12",
    author: { username: "testuser" },
    ...overrides,
  });
}

const repositoryUrl = "https://svn.example.com/repos/project/trunk";

const gitDiffOutput = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,1 @@
-old
+new
`;

describe("SvnVcsAdapter", () => {
  it("lists changed files from svn diff --summarize and applies filters", async () => {
    const calls: string[][] = [];
    const svn: SvnCommandRunner = async (args) => {
      calls.push([...args]);
      return {
        stdout: [
          `M       ${repositoryUrl}/src/app.ts`,
          `A       ${repositoryUrl}/src/new.ts`,
          `D       ${repositoryUrl}/docs/old.md`,
        ].join("\n"),
        stderr: "",
      };
    };
    const adapter = createSvnVcsAdapter({
      repositoryDir: "C:/repo",
      repositoryUrl,
      watchPath: ["src/"],
      includeCrFile: ["*.ts"],
      svn,
    });

    const range = await adapter.listChanges(makeEvent());

    expect(range).toEqual({
      baseRevision: "10",
      headRevision: "12",
      files: ["src/app.ts", "src/new.ts"],
    });
    expect(calls).toEqual([
      ["--non-interactive", "diff", "--summarize", "-r", "10:12", repositoryUrl],
    ]);
  });

  it("uses a single revision change when only headSha is present", async () => {
    const calls: string[][] = [];
    const adapter = createSvnVcsAdapter({
      repositoryDir: "C:/repo",
      repositoryUrl,
      svn: async (args) => {
        calls.push([...args]);
        return { stdout: `M       ${repositoryUrl}/src/app.ts\n`, stderr: "" };
      },
    });

    const range = await adapter.listChanges(makeEvent({ baseSha: undefined }));

    expect(range).toEqual({ headRevision: "12", files: ["src/app.ts"] });
    expect(calls[0]).toEqual(["--non-interactive", "diff", "--summarize", "-c", "12", repositoryUrl]);
  });

  it("falls back to ReviewEvent.changedFiles when revisions are absent", async () => {
    const adapter = createSvnVcsAdapter({
      repositoryDir: "C:/repo",
      svn: async () => {
        throw new Error("svn should not be called");
      },
    });

    await expect(
      adapter.listChanges(
        makeEvent({
          baseSha: undefined,
          headSha: undefined,
          changedFiles: ["./src/app.ts", "src/app.ts"],
        }),
      ),
    ).resolves.toEqual({ files: ["src/app.ts"] });
  });

  it("materializes scoped files with svn cat at the review revision", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-svn-scoped-"));
    const calls: string[][] = [];
    const adapter = createSvnVcsAdapter({
      repositoryDir: join(tempDir, "repo"),
      repositoryUrl,
      svn: async (args) => {
        calls.push([...args]);
        return { stdout: "export const app = true;\n", stderr: "" };
      },
    });

    try {
      const sourceDir = join(tempDir, "source");
      const tree = await adapter.fetchScoped(
        { headRevision: "12", files: ["src/app.ts"] },
        { id: "ws", sourceDir },
      );

      expect(tree).toEqual({ workspaceId: "ws", rootDir: sourceDir, fetchedFiles: ["src/app.ts"] });
      expect(calls[0]).toEqual(["--non-interactive", "cat", "-r", "12", `${repositoryUrl}/src/app.ts`]);
      await expect(readFile(join(sourceDir, "src", "app.ts"), "utf8")).resolves.toBe(
        "export const app = true;\n",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fetches missing related context from SVN and persists it", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-svn-extra-"));
    const calls: string[][] = [];
    const adapter = createSvnVcsAdapter({
      repositoryDir: join(tempDir, "repo"),
      repositoryUrl,
      svn: async (args) => {
        calls.push([...args]);
        return { stdout: "one\ntwo\nthree\n", stderr: "" };
      },
    });

    try {
      const sourceDir = join(tempDir, "source");
      await mkdir(sourceDir, { recursive: true });
      const result = await adapter.fetchExtraContext(
        { path: "include/api.h", startLine: 2, endLine: 3, revision: "12", reason: "need API contract" },
        { id: "ws", sourceDir },
      );

      expect(result).toEqual({ path: "include/api.h", content: "two\nthree" });
      expect(calls[0]).toEqual(["--non-interactive", "cat", "-r", "12", `${repositoryUrl}/include/api.h`]);
      await expect(readFile(join(sourceDir, "include", "api.h"), "utf8")).resolves.toBe("one\ntwo\nthree\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects related context URLs outside the configured repository", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-svn-outside-"));
    const adapter = createSvnVcsAdapter({
      repositoryDir: join(tempDir, "repo"),
      repositoryUrl,
      svn: async () => ({ stdout: "", stderr: "" }),
    });

    try {
      await expect(
        adapter.fetchExtraContext(
          {
            path: "https://svn.example.com/repos/other/trunk/secret.h",
            revision: "12",
            reason: "untrusted path",
          },
          { id: "ws", sourceDir: join(tempDir, "source") },
        ),
      ).rejects.toThrow(/configured repository_url/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses git-style SVN diff output", async () => {
    const calls: string[][] = [];
    const adapter = createSvnVcsAdapter({
      repositoryDir: "C:/repo",
      repositoryUrl,
      svn: async (args) => {
        calls.push([...args]);
        return { stdout: gitDiffOutput, stderr: "" };
      },
    });

    const result = await adapter.diff({ baseRevision: "10", headRevision: "12", files: ["src/app.ts"] });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.newPath).toBe("src/app.ts");
    expect(result.files[0]?.hunks[0]?.lines.map((line) => line.kind)).toEqual(["delete", "add"]);
    expect(calls[0]).toEqual(["--non-interactive", "diff", "--git", "-r", "10:12", `${repositoryUrl}/src/app.ts`]);
  });

  it("redacts configured password from command errors", async () => {
    const adapter = createSvnVcsAdapter({
      repositoryDir: "C:/repo",
      repositoryUrl,
      username: "reviewer",
      password: "secret-password",
      svn: async (args) => {
        throw new Error(`svn failed: ${args.join(" ")}`);
      },
    });

    let thrown: unknown;
    try {
      await adapter.diff({ headRevision: "12", files: ["src/app.ts"] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("--password ***");
    expect(String(thrown)).not.toContain("secret-password");
  });
});
