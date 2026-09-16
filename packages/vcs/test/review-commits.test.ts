import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitVcsAdapter } from "../src/git.js";
import { createSvnVcsAdapter } from "../src/svn.js";
import { P4VcsAdapter } from "../src/p4.js";

describe("review commit metadata", () => {
  it("walks merged ancestry, pages without overlap, preserves raw authors and reads root/merge diffs", async () => {
    await mkdir("build/tmp", { recursive: true });
    const root = await mkdtemp(resolve("build/tmp/review-git-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "Raw Author", GIT_AUTHOR_EMAIL: "raw@example.com",
        GIT_COMMITTER_NAME: "Commit Bot", GIT_COMMITTER_EMAIL: "bot@example.com" } }).trim();
    const commit = async (path: string, content: string) => {
      await writeFile(join(root, path), content);
      git("add", "--", path); git("-c", "commit.gpgsign=false", "commit", "-m", path);
      return git("rev-parse", "HEAD");
    };
    try {
      git("init", "-b", "main");
      const base = await commit("base.txt", "base\n");
      git("checkout", "-b", "side");
      const side = await commit("中文 文件.txt", "side\n");
      git("checkout", "main");
      const main = await commit("main.txt", "main\n");
      git("-c", "commit.gpgsign=false", "merge", "--no-ff", "side", "-m", "merge");
      const head = git("rev-parse", "HEAD");
      const vcs = createGitVcsAdapter({ repositoryDir: root });
      const query = { scopeRef: "main", baseRevision: base, headRevision: head, maxRecords: 1, maxBytes: 1_048_576 };
      const records = [];
      let cursor: string | undefined;
      do {
        const page = await vcs.listReviewCommitMetadataPage({ ...query, ...(cursor ? { cursor } : {}) });
        records.push(...page.records); cursor = page.nextCursor;
      } while (cursor);
      expect(records.map(record => record.revision).sort()).toEqual([head, side, main].sort());
      expect(records[0]?.revision).toBe(head);
      expect(records.find(record => record.revision === side)).toMatchObject({ authorName: "Raw Author",
        authorEmail: "raw@example.com", committerName: "Commit Bot", changedPaths: ["中文 文件.txt"] });
      expect(records[0]?.changedPaths).toEqual(["中文 文件.txt"]);
      const single = await vcs.listReviewCommitMetadataPage({ ...query, baseRevision: undefined, maxRecords: 10 });
      expect(single.records.map(record => record.revision)).toEqual([head]);
      const initial = await vcs.listReviewCommitMetadataPage({ scopeRef: "main", headRevision: base, maxRecords: 10, maxBytes: 1_048_576 });
      expect(initial.records[0]?.parents).toEqual([]);
      expect(initial.records[0]?.changedPaths).toEqual(["base.txt"]);
      const patch = await vcs.diff({ headRevision: base, files: ["base.txt"] });
      expect(patch.files[0]?.hunks[0]?.lines).toContainEqual(expect.objectContaining({ kind: "add", content: "base" }));
      await expect(vcs.listReviewCommitMetadataPage({ ...query, headRevision: "--all" })).rejects.toThrow("Invalid review");
      await expect(vcs.listReviewCommitMetadataPage({ ...query, cursor: "-1" })).rejects.toThrow("Invalid review");
      expect((await vcs.listReviewCommitMetadataPage({ ...query, baseRevision: head })).records).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("limits SVN single-revision reads and pins the adapter scope instead of an event label", async () => {
    const calls: string[][] = [];
    const vcs = createSvnVcsAdapter({ repositoryDir: "build/tmp/svn-review", repositoryUrl: "https://svn.example/project/trunk",
      svn: async args => { calls.push([...args]); return { stdout: '<log><logentry revision="42"><author>alice</author></logentry></log>', stderr: "" }; } });
    const page = await vcs.listReviewCommitMetadataPage({ scopeRef: "project", headRevision: "42", maxRecords: 20, maxBytes: 1_048_576 });
    expect(calls[0]).toEqual(expect.arrayContaining(["42:42", "https://svn.example/project/trunk@42"]));
    expect(page.records[0]).toMatchObject({ revision: "42", svnAuthor: "alice" });
  });

  it("limits P4 single-changelist reads and keeps the recorded submitter workspace", async () => {
    const calls: string[][] = [];
    const vcs = new P4VcsAdapter({ repositoryDir: "build/tmp/p4-review", depot: "//depot/main",
      p4: async args => { calls.push([...args]); return { stdout: args.includes("changes")
        ? "Change 42 on 2026/09/15 by alice@submit-client 'change'\n"
        : "Change 42 by alice@submit-client\n\nAffected files ...\n\n... //depot/main/a.txt#1 add\n", stderr: "" }; } });
    const page = await vcs.listReviewCommitMetadataPage({ scopeRef: "label", headRevision: "42", maxRecords: 20, maxBytes: 1_048_576 });
    expect(calls[0]).toContain("//depot/main/...@>41,@<=42");
    expect(page.records[0]).toMatchObject({ revision: "42", p4User: "alice", p4Client: "submit-client" });
  });
});
