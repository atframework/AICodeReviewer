import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createReviewEvent } from "@aicr/core";
import { describe, expect, it } from "vitest";

import { createGitVcsAdapter } from "../src/git.js";

/**
 * Real local repository fixtures (design test matrix VCS row: Git uses real
 * local history). Commits are authored with explicit --author identities and
 * a committer identity from the environment; a .mailmap entry proves the
 * metadata read returns raw `%an/%ae/%cn/%ce` values.
 */

const gitEnv = {
  ...process.env,
  GIT_COMMITTER_NAME: "Commit Bot",
  GIT_COMMITTER_EMAIL: "bot@example.com",
  GIT_AUTHOR_NAME: "Fallback Author",
  GIT_AUTHOR_EMAIL: "fallback@example.com",
};

function git(repoDir: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repoDir, env: gitEnv, encoding: "utf8" }).trim();
}

async function commitFile(
  repoDir: string,
  file: string,
  content: string,
  message: string,
  author: string,
): Promise<string> {
  await mkdir(dirname(join(repoDir, file)), { recursive: true });
  await writeFile(join(repoDir, file), content, "utf8");
  git(repoDir, ["add", file]);
  git(repoDir, ["commit", "--author", author, "-m", message]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

describe("GitVcsAdapter.listCommitMetadataPage", () => {
  it("keeps force-push diffs at the original endpoints instead of the merge base", async () => {
    await mkdir("build/tmp/git-rewrite", { recursive: true });
    const tempDir = await mkdtemp("build/tmp/git-rewrite/endpoints-");
    try {
      git(tempDir, ["init", "-b", "main"]);
      const root = await commitFile(tempDir, "app.txt", "root\n", "root", "Alice <alice@example.com>");
      const oldHead = await commitFile(tempDir, "app.txt", "old-head\n", "old", "Alice <alice@example.com>");
      git(tempDir, ["checkout", "-b", "rewritten", root]);
      const newHead = await commitFile(tempDir, "other.txt", "new\n", "new", "Bob <bob@example.com>");
      const adapter = createGitVcsAdapter({ repositoryDir: tempDir });
      const range = await adapter.listChanges(createReviewEvent({
        triggerName: "push", provider: "github", workspaceId: "ws", targetKind: "push",
        repoRef: "owner/repo", baseSha: oldHead, headSha: newHead,
        author: { username: "pusher" }, reason: "github:push",
      }));
      expect(range.files.sort()).toEqual(["app.txt", "other.txt"]);
      const diff = await adapter.diff(range);
      const app = diff.files.find((file) => file.newPath === "app.txt");
      expect(app?.hunks.flatMap((hunk) => hunk.lines).map((line) => [line.kind, line.content])).toContainEqual(["delete", "old-head"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("walks first-parent order with raw author fields, merge parents, and bounded paths", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-meta-"));
    try {
      git(tempDir, ["init", "-b", "main"]);
      await writeFile(join(tempDir, ".mailmap"), "Mapped Alice <mapped@example.com> <alice@example.com>\n", "utf8");
      await writeFile(join(tempDir, ".gitattributes"), "", "utf8");

      const a1 = await commitFile(tempDir, "a.txt", "a1\n", "A1", "Alice <alice@example.com>");
      const a2 = await commitFile(tempDir, "b.txt", "b1\n", "A2", "Alice <alice@example.com>");
      // Side branch from A2; merged back with --no-ff so the merge has two parents.
      git(tempDir, ["checkout", "-b", "side", a2]);
      const b1 = await commitFile(tempDir, "side.txt", "s1\n", "B1", "Bob <bob@example.com>");
      git(tempDir, ["checkout", "main"]);
      git(tempDir, ["merge", "--no-ff", "side", "-m", "Merge side"]);
      const merge = git(tempDir, ["rev-parse", "HEAD"]);
      const a3 = await commitFile(tempDir, "c.txt", "c1\n", "A3", "Alice <alice@example.com>");

      const adapter = createGitVcsAdapter({ repositoryDir: tempDir });
      const page = await adapter.listCommitMetadataPage({
        scopeRef: "refs/heads/main",
        baseRevision: a1,
        headRevision: a3,
        maxRecords: 256,
        maxBytes: 1_048_576,
      });

      expect(page.status).toBe("complete");
      expect(page.nextCursor).toBeUndefined();
      // First-parent order: A2, merge, A3 — side commit B1 stays out of the walk.
      expect(page.records.map((record) => record.revision)).toEqual([a2, merge, a3]);
      expect(page.records.map((record) => record.revision)).not.toContain(b1);

      const orderKeys = page.records.map((record) => record.orderKey);
      expect([...orderKeys].sort()).toEqual(orderKeys);
      // Absolute first-parent positions: a1=1, a2=2, merge=3, a3=4.
      expect(orderKeys).toEqual(["000000000002", "000000000003", "000000000004"]);

      // Raw author/committer values — .mailmap must NOT rewrite them.
      const a2Record = page.records[0];
      expect(a2Record?.authorName).toBe("Alice");
      expect(a2Record?.authorEmail).toBe("alice@example.com");
      expect(a2Record?.committerName).toBe("Commit Bot");
      expect(a2Record?.committerEmail).toBe("bot@example.com");
      expect(a2Record?.changedPaths).toEqual(["b.txt"]);

      // Merge keeps its full parent list (first parent A2, side B1).
      const mergeRecord = page.records[1];
      expect(mergeRecord?.parents).toEqual([a2, b1]);
      expect(mergeRecord?.authorName).toBe("Fallback Author");
      expect(page.records[2]?.parents).toEqual([merge]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("paginates with a resumable cursor and globally sortable order keys", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-meta-page-"));
    try {
      git(tempDir, ["init", "-b", "main"]);
      const shas: string[] = [];
      for (let index = 1; index <= 5; index += 1) {
        shas.push(
          await commitFile(tempDir, `f${index}.txt`, `${index}\n`, `C${index}`, "Alice <alice@example.com>"),
        );
      }
      const head = shas[shas.length - 1] ?? "";
      const adapter = createGitVcsAdapter({ repositoryDir: tempDir });

      const first = await adapter.listCommitMetadataPage({
        scopeRef: "refs/heads/main",
        headRevision: head,
        maxRecords: 2,
        maxBytes: 1_048_576,
      });
      expect(first.status).toBe("partial");
      expect(first.records.map((record) => record.revision)).toEqual(shas.slice(0, 2));
      expect(first.nextCursor).toBeDefined();

      const second = await adapter.listCommitMetadataPage({
        scopeRef: "refs/heads/main",
        headRevision: head,
        ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
        maxRecords: 2,
        maxBytes: 1_048_576,
      });
      const third = await adapter.listCommitMetadataPage({
        scopeRef: "refs/heads/main",
        headRevision: head,
        ...(second.nextCursor ? { cursor: second.nextCursor } : {}),
        maxRecords: 2,
        maxBytes: 1_048_576,
      });

      const all = [...first.records, ...second.records, ...third.records];
      expect(third.status).toBe("complete");
      expect(all.map((record) => record.revision)).toEqual(shas);
      expect(all.map((record) => record.orderKey)).toEqual([
        "000000000001",
        "000000000002",
        "000000000003",
        "000000000004",
        "000000000005",
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports unavailable for a missing base endpoint instead of an empty range", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-meta-missing-"));
    try {
      git(tempDir, ["init", "-b", "main"]);
      const head = await commitFile(tempDir, "a.txt", "a\n", "A1", "Alice <alice@example.com>");
      const adapter = createGitVcsAdapter({ repositoryDir: tempDir });

      const page = await adapter.listCommitMetadataPage({
        scopeRef: "refs/heads/main",
        baseRevision: "0".repeat(40),
        headRevision: head,
        maxRecords: 256,
        maxBytes: 1_048_576,
      });
      expect(page.status).toBe("unavailable");
      expect(page.records).toEqual([]);
      expect(page.unavailableReason).toBeTruthy();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("honours the byte budget by truncating the page", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aicr-git-meta-bytes-"));
    try {
      git(tempDir, ["init", "-b", "main"]);
      const shas: string[] = [];
      for (let index = 1; index <= 4; index += 1) {
        shas.push(
          await commitFile(
            tempDir,
            `some/fairly/long/directory/path/file-${index}.txt`,
            `${index}\n`,
            `C${index}`,
            "Alice <alice@example.com>",
          ),
        );
      }
      const adapter = createGitVcsAdapter({ repositoryDir: tempDir });
      const page = await adapter.listCommitMetadataPage({
        scopeRef: "refs/heads/main",
        headRevision: shas[shas.length - 1] ?? "",
        maxRecords: 256,
        maxBytes: 400,
      });
      expect(page.status).toBe("partial");
      expect(page.records.length).toBeLessThan(4);
      expect(page.records.length).toBeGreaterThan(0);
      expect(page.nextCursor).toBeDefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
