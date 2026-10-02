import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitVcsAdapter, type VcsAdapter } from "@aicr/vcs";

import { resolveImRevision, validateRevisionFormat } from "../src/im/revision-resolver.js";

/**
 * IM-13 acceptance V01–V05 share: format validation per VCS family and
 * resolution through trusted adapters. Git runs end-to-end against a real
 * local repository (root/merge/unreachable commits, blob/tag objects); P4
 * and SVN descriptors use the shapes the real adapters produce — their
 * submitted-only/URL-conflict semantics are pinned in the VCS live suites.
 */

const GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const GIT_SHA_UPPER = GIT_SHA.toUpperCase();
const GIT_SHA256 = "a".repeat(64); // SHA-256 full hex

function adapterFor(kind: string, metadata?: Record<string, string | null>): VcsAdapter {
  return {
    kind: kind as VcsAdapter["kind"],
    listChanges: async () => { throw new Error("not used"); },
    ...(metadata !== undefined ? { describeSource: async () => metadata } : {}),
    fetchRevisionCommittedAt: async () => "2026-09-28T00:00:00Z",
  } as VcsAdapter;
}

describe("V01: revision format validation", () => {
  it("accepts complete Git SHA-1 and SHA-256, rejects floating/short/range", () => {
    expect(validateRevisionFormat("git", GIT_SHA)).toBe(true);
    expect(validateRevisionFormat("git", GIT_SHA256)).toBe(true);
    expect(validateRevisionFormat("github", GIT_SHA)).toBe(true);
    expect(validateRevisionFormat("gitlab", GIT_SHA)).toBe(true);

    expect(validateRevisionFormat("git", "HEAD")).toBe(false);
    expect(validateRevisionFormat("git", "main")).toBe(false);
    expect(validateRevisionFormat("git", GIT_SHA.slice(0, 7))).toBe(false);
    expect(validateRevisionFormat("git", `${GIT_SHA}..${GIT_SHA}`)).toBe(false);
    expect(validateRevisionFormat("git", `-${GIT_SHA}`)).toBe(false);
    expect(validateRevisionFormat("git", ` ${GIT_SHA}`)).toBe(false);
    expect(validateRevisionFormat("git", GIT_SHA.toUpperCase())).toBe(true); // hex is case-insensitive at format level
  });

  it("accepts canonical SVN/P4 revisions, rejects zero/negative/floating", () => {
    expect(validateRevisionFormat("svn", "123")).toBe(true);
    expect(validateRevisionFormat("svn", "r123")).toBe(false); // design says rN is stripped by the store
    expect(validateRevisionFormat("svn", "0")).toBe(false);
    expect(validateRevisionFormat("svn", "HEAD")).toBe(false);
    expect(validateRevisionFormat("p4", "456")).toBe(true);
    expect(validateRevisionFormat("p4", "-1")).toBe(false);
  });
});

describe("V04/V05: resolution through the trusted adapter", () => {
  it("resolves a Git commit with full metadata and normalizes to lowercase", async () => {
    const adapter = adapterFor("git", {
      author_username: "alice-dev",
      author_email: "alice@example.invalid",
      title: "feat: add feature",
      url: "https://github.com/org/service/commit/" + GIT_SHA,
      base_revision: "fedcba9876543210fedcba9876543210fedcba98",
    });
    const result = await resolveImRevision(adapter, GIT_SHA_UPPER);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.revision.revision).toBe(GIT_SHA); // normalized lowercase
    expect(result.revision.author.username).toBe("alice-dev");
    expect(result.revision.title).toBe("feat: add feature");
    expect(result.revision.baseRevision).toBe("fedcba9876543210fedcba9876543210fedcba98");
    expect(result.revision.committedAt).toBe("2026-09-28T00:00:00Z");
  });

  it("rejects invalid formats, missing objects and unavailable metadata", async () => {
    expect((await resolveImRevision(adapterFor("git", {}), "HEAD")).kind).toBe("rejected");
    expect((await resolveImRevision(adapterFor("git", { title: "x" }), "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).kind).toBe("rejected");
    expect((await resolveImRevision(adapterFor("git"), GIT_SHA)).kind).toBe("rejected"); // no describeSource
  });
});

describe("V03/V04: P4 and SVN descriptor resolution", () => {
  it("resolves a submitted P4 changelist with the recorded submitter as trusted author", async () => {
    // Shape produced by the real adapter (p4 describe -s): pending changes
    // and depot mismatches throw inside describeSource — verified in the VCS
    // live suites — so the resolver only ever sees submitted descriptors.
    const adapter = adapterFor("p4", {
      change: "3", user: "alice-submitter", client: "task-main",
      stream: null, server: "127.0.0.1:1866", service_client: "task-main-abc123",
    });
    const result = await resolveImRevision(adapter, "3");
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.revision.revision).toBe("3");
    expect(result.revision.author.username).toBe("alice-submitter");
    expect(result.revision.baseRevision).toBeNull(); // P4 base/file scope come from the adapter at execution
  });

  it("rejects P4 metadata failures as not found and floating revisions at the format gate", async () => {
    const pending = { ...adapterFor("p4"), describeSource: async () => { throw new Error("not the requested submitted changelist"); } };
    expect((await resolveImRevision(pending as VcsAdapter, "4")).kind).toBe("rejected");
    expect((await resolveImRevision(adapterFor("p4", {}), "4")).kind).toBe("rejected");
    expect((await resolveImRevision(adapterFor("p4", { change: "4" }), "0")).kind).toBe("rejected"); // invalid_format
  });

  it("resolves a fixed SVN revision through the repository identity descriptor", async () => {
    const adapter = adapterFor("svn", {
      repository_url: "https://svn.example/repo", repository_root: "https://svn.example/repo", repository_uuid: "uuid-1",
    });
    const result = await resolveImRevision(adapter, "5");
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.revision.revision).toBe("5");
    expect(result.revision.url).toBeUndefined(); // svn identity carries no forge URL; authors come from log metadata at execution
    const conflicting = { ...adapterFor("svn"), describeSource: async () => { throw new Error("SVN info URL conflicts with configured source"); } };
    expect((await resolveImRevision(conflicting as VcsAdapter, "5")).kind).toBe("rejected");
  });
});

const gitEnv = {
  ...process.env,
  GIT_COMMITTER_NAME: "Commit Bot",
  GIT_COMMITTER_EMAIL: "bot@example.com",
  GIT_AUTHOR_NAME: "Fallback Author",
  GIT_AUTHOR_EMAIL: "fallback@example.com",
};

function runGit(repoDir: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repoDir, env: gitEnv, encoding: "utf8" }).trim();
}

async function commitFile(repoDir: string, file: string, content: string, message: string, author: string): Promise<string> {
  await mkdir(dirname(join(repoDir, file)), { recursive: true });
  await writeFile(join(repoDir, file), content, "utf8");
  runGit(repoDir, ["add", file]);
  runGit(repoDir, ["commit", "--author", author, "-m", message]);
  return runGit(repoDir, ["rev-parse", "HEAD"]);
}

describe("V02/V05: real local git repository resolution", () => {
  // Real subprocess git: one shared repository (root → A2 → merge(side B1)
  // → A3) drives both cases; per-test timeouts absorb slow spawns on loaded
  // Windows hosts.
  let repoDir: string;
  let refs: { root: string; c1: string; side1: string; merge: string; c2: string };
  let blob: string;
  let tagObject: string;
  let orphan: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "aicr-im-revision-"));
    runGit(repoDir, ["init", "-b", "main"]);
    const root = await commitFile(repoDir, "a.txt", "a\n", "root", "Alice <alice@example.com>");
    const c1 = await commitFile(repoDir, "b.txt", "b\n", "A2", "Alice <alice@example.com>");
    runGit(repoDir, ["checkout", "-b", "side", c1]);
    const side1 = await commitFile(repoDir, "side.txt", "s\n", "B1", "Bob <bob@example.com>");
    runGit(repoDir, ["checkout", "main"]);
    runGit(repoDir, ["merge", "--no-ff", "side", "-m", "Merge side"]);
    const merge = runGit(repoDir, ["rev-parse", "HEAD"]);
    const c2 = await commitFile(repoDir, "c.txt", "c\n", "A3", "Alice <alice@example.com>");
    refs = { root, c1, side1, merge, c2 };
    blob = runGit(repoDir, ["hash-object", "-w", "a.txt"]);
    runGit(repoDir, ["tag", "-a", "v1", "-m", "tag message", c1]);
    tagObject = runGit(repoDir, ["rev-parse", "v1"]);
    orphan = runGit(repoDir, ["commit-tree", `${c2}^{tree}`, "-m", "orphan"]);
  }, 120_000);

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("resolves root and merge commits, rejects blobs, tags, unreachable and missing objects", { timeout: 120_000 }, async () => {
    const adapter = createGitVcsAdapter({ repositoryDir: repoDir });

    // Root commit: no parent → base is the empty tree (baseRevision null).
    const rootResult = await resolveImRevision(adapter, refs.root.toUpperCase());
    expect(rootResult.kind).toBe("resolved");
    if (rootResult.kind !== "resolved") return;
    expect(rootResult.revision.revision).toBe(refs.root); // uppercase input normalized
    expect(rootResult.revision.baseRevision).toBeNull();
    expect(rootResult.revision.title).toBe("root");
    expect(rootResult.revision.committedAt).toBeDefined();

    // Merge commit: base is the FIRST parent (mainline c1, not side1).
    const mergeResult = await resolveImRevision(adapter, refs.merge);
    expect(mergeResult.kind).toBe("resolved");
    if (mergeResult.kind !== "resolved") return;
    expect(mergeResult.revision.baseRevision).toBe(refs.c1);
    expect(mergeResult.revision.baseRevision).not.toBe(refs.side1);

    // Ordinary commit chains onto the merge.
    const c2Result = await resolveImRevision(adapter, refs.c2);
    expect(c2Result.kind).toBe("resolved");
    if (c2Result.kind !== "resolved") return;
    expect(c2Result.revision.baseRevision).toBe(refs.merge);

    // Blob objects, annotated tag objects and commits outside every ref
    // are not reviewable targets (V02: 只接受范围内 commit).
    expect((await resolveImRevision(adapter, blob)).kind).toBe("rejected");
    expect((await resolveImRevision(adapter, tagObject)).kind).toBe("rejected");
    expect((await resolveImRevision(adapter, orphan)).kind).toBe("rejected");
    expect((await resolveImRevision(adapter, "f".repeat(40))).kind).toBe("rejected");
  });

  it("takes the commit author from trusted VCS metadata, never from the chat operator (V05)", { timeout: 120_000 }, async () => {
    const adapter = createGitVcsAdapter({ repositoryDir: repoDir });
    const result = await resolveImRevision(adapter, refs.c1);
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    // The chat operator ("owent") never leaks into the commit identity:
    // author/email come from the repository object only.
    expect(result.revision.author).toEqual({ username: "Alice", email: "alice@example.com" });
    expect(result.revision.author.username).not.toBe("owent");
  });
});
