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

const gitDiffOutput = `diff --git a/project/trunk/src/app.ts b/project/trunk/src/app.ts
--- a/project/trunk/src/app.ts\t(revision 10)
+++ b/project/trunk/src/app.ts\t(revision 12)
@@ -1,1 +1,1 @@
-old
+new
`;

const sourceInfo = `<info><entry><url>${repositoryUrl}</url><repository><root>https://svn.example.com/repos</root></repository></entry></info>`;

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
        return { stdout: args.includes("info") ? sourceInfo : gitDiffOutput, stderr: "" };
      },
    });

    const result = await adapter.diff({ baseRevision: "10", headRevision: "12", files: ["src/app.ts"] });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.newPath).toBe("src/app.ts");
    expect(result.files[0]?.oldPath).toBe("src/app.ts");
    expect(result.files[0]?.status).toBe("modified");
    expect(result.files[0]?.hunks[0]?.lines.map((line) => line.kind)).toEqual(["delete", "add"]);
    expect(calls[0]).toEqual(["--non-interactive", "diff", "--git", `--old=${repositoryUrl}@10`, `--new=${repositoryUrl}@12`, "--", "src/app.ts"]);
    expect(calls[1]).toEqual(["--non-interactive", "info", "--xml", "-r", "12", `${repositoryUrl}@12`]);
  });

  it.each([{ files: [] }, { files: ["docs/ignored.md"] }])("does not widen an empty filtered range to the whole repository ($files)", async ({ files }) => {
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, watchPath: ["src/"],
      svn: async () => { throw new Error("empty range must not contact SVN"); } });
    await expect(adapter.diff({ headRevision: "12", files })).resolves.toEqual({ files: [] });
  });

  it.each([
    { status: "added", oldLabel: "nonexistent", newLabel: "revision 12", oldPath: undefined, newPath: "src/app.ts" },
    { status: "deleted", oldLabel: "revision 10", newLabel: "nonexistent", oldPath: "src/app.ts", newPath: undefined },
  ])("normalizes SVN $status paths and the nonexistent side", async ({ status, oldLabel, newLabel, oldPath, newPath }) => {
    const patch = gitDiffOutput.replace("(revision 10)", `(${oldLabel})`).replace("(revision 12)", `(${newLabel})`);
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl,
      svn: async args => ({ stdout: args.includes("info") ? sourceInfo : patch, stderr: "" }) });
    const { files } = await adapter.diff({ baseRevision: "10", headRevision: "12", files: ["src/app.ts"] });
    expect(files[0]?.status).toBe(status);
    expect(files[0]?.oldPath).toBe(oldPath);
    expect(files[0]?.newPath).toBe(newPath);
  });

  it("rejects a different project's same-name file instead of guessing a suffix", async () => {
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl,
      svn: async args => ({ stdout: args.includes("info") ? sourceInfo : gitDiffOutput.replaceAll("project/trunk/", "other/trunk/"), stderr: "" }) });
    await expect(adapter.diff({ headRevision: "12", files: ["src/app.ts"] })).rejects.toThrow(/scope/iu);
  });

  it("deduplicates directory targets and compares the preceding revision for a single commit", async () => {
    const calls: string[][] = [];
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl,
      svn: async args => { calls.push([...args]); return { stdout: "", stderr: "" }; } });
    await adapter.diff({ headRevision: "12", files: ["src/app.ts", "src", "src/app.ts"] });
    expect(calls).toEqual([["--non-interactive", "diff", "--git", `--old=${repositoryUrl}@11`, `--new=${repositoryUrl}@12`, "--", "src/app.ts"]]);
  });

  it("rebases URL-encoded scope metadata without changing hunk text that resembles a header", async () => {
    const url = "https://svn.example.com/repos/project%20one/trunk";
    const patch = gitDiffOutput.replaceAll("project/trunk/", "project one/trunk/") + "--- literal\t(revision 10)\n+++ literal\t(revision 12)\n";
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl: url,
      svn: async args => ({ stdout: args.includes("info") ? sourceInfo.replace(repositoryUrl, url) : patch, stderr: "" }) });
    const { files } = await adapter.diff({ headRevision: "12", files: ["src/app.ts"] });
    expect(files[0]).toMatchObject({ oldPath: "src/app.ts", newPath: "src/app.ts", status: "modified" });
    expect(files[0]?.hunks[0]?.lines.slice(-2).map(line => line.content)).toEqual(["-- literal\t(revision 10)", "++ literal\t(revision 12)"]);
  });

  it.each(["<info/>", sourceInfo.replace(repositoryUrl, "https://svn.example.com/repos/other/trunk")])("fails closed on incomplete or conflicting source metadata", async info => {
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl,
      svn: async args => ({ stdout: args.includes("info") ? info : gitDiffOutput, stderr: "" }) });
    await expect(adapter.diff({ headRevision: "12", files: ["src/app.ts"] })).rejects.toThrow();
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

describe("SvnVcsAdapter.fetchAttribution", () => {
  const blameOutput = [
    "    12     alice line one",
    "    15     bob   line two",
  ].join("\n");

  it("parses svn blame into attribution entries", async () => {
    const calls: string[][] = [];
    const svn: SvnCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: blameOutput, stderr: "" };
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, svn });

    const result = await adapter.fetchAttribution(
      { path: "src/app.ts", revision: "15", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(result.status).toBe("ok");
    expect(result.entries).toEqual([
      { line: 1, revision: "12", author: "alice" },
      { line: 2, revision: "15", author: "bob" },
    ]);
    expect(calls[0]).toEqual([
      "--non-interactive",
      "blame",
      "-r",
      "15",
      `${repositoryUrl}/src/app.ts`,
    ]);
  });

  it("omits -r when no revision is requested", async () => {
    const calls: string[][] = [];
    const svn: SvnCommandRunner = async (args) => {
      calls.push([...args]);
      return { stdout: blameOutput, stderr: "" };
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, svn });

    await adapter.fetchAttribution(
      { path: "src/app.ts", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(calls[0]).toEqual(["--non-interactive", "blame", `${repositoryUrl}/src/app.ts`]);
  });

  it("filters attribution to the requested line range", async () => {
    const svn: SvnCommandRunner = async () => ({ stdout: blameOutput, stderr: "" });
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, svn });

    const result = await adapter.fetchAttribution(
      { path: "src/app.ts", startLine: 2, endLine: 2, revision: "15", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.line).toBe(2);
    expect(result.entries[0]?.author).toBe("bob");
  });

  it("returns not_found when blame produces no parseable output (binary file)", async () => {
    const svn: SvnCommandRunner = async () => ({
      stdout: "Skipping binary file: src/app.ts\n",
      stderr: "",
    });
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, svn });

    const result = await adapter.fetchAttribution(
      { path: "src/app.ts", revision: "15", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(result).toEqual({ path: "src/app.ts", status: "not_found", entries: [] });
  });

  it("returns not_found when blame reports a missing path", async () => {
    const svn: SvnCommandRunner = async () => {
      throw new Error("svn: E160013: File not found");
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, svn });

    const result = await adapter.fetchAttribution(
      { path: "src/missing.ts", revision: "15", reason: "blame" },
      { id: "ws", sourceDir: "C:/repo/source" },
    );

    expect(result).toEqual({ path: "src/missing.ts", status: "not_found", entries: [] });
  });

  it("rethrows non-missing blame errors instead of masking them as not_found", async () => {
    const svn: SvnCommandRunner = async () => {
      throw new Error("svn: E170013: Unable to connect to a repository at URL");
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, svn });

    await expect(
      adapter.fetchAttribution(
        { path: "src/app.ts", revision: "15", reason: "blame" },
        { id: "ws", sourceDir: "C:/repo/source" },
      ),
    ).rejects.toThrow("Unable to connect");
  });

  it("rejects a path that escapes the configured repository_url", async () => {
    const svn: SvnCommandRunner = async () => {
      throw new Error("svn should not be called for an out-of-repo path");
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, svn });

    await expect(
      adapter.fetchAttribution(
        { path: "https://other.example.com/repos/project/file.ts", revision: "15", reason: "blame" },
        { id: "ws", sourceDir: "C:/repo/source" },
      ),
    ).rejects.toThrow("must stay within the configured repository_url");
  });

  it("retries transient connection failures and then lists changes", async () => {
    let diffAttempts = 0;
    const svn: SvnCommandRunner = async (args) => {
      if (args.includes("--summarize")) {
        diffAttempts += 1;
        if (diffAttempts === 1) {
          throw new Error("svn: E175002: Unable to connect to a repository at URL 'https://svn.example.com'\nsvn: E175002: Connection timed out");
        }
        return { stdout: `M       ${repositoryUrl}/src/app.ts\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, svn });

    const range = await adapter.listChanges(makeEvent());
    expect(range.files).toEqual(["src/app.ts"]);
    expect(diffAttempts).toBe(2);
  });

  it("does not retry permanent svn failures", async () => {
    let diffAttempts = 0;
    const svn: SvnCommandRunner = async (args) => {
      if (args.includes("--summarize")) {
        diffAttempts += 1;
        throw new Error("svn: E160013: File not found: revision '12', path '/trunk'");
      }
      return { stdout: "", stderr: "" };
    };
    const adapter = createSvnVcsAdapter({ repositoryDir: "C:/repo", repositoryUrl, svn });

    await expect(adapter.listChanges(makeEvent())).rejects.toThrow("E160013");
    expect(diffAttempts).toBe(1);
  });
});
