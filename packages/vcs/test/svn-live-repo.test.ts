import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { createReviewEvent } from "@aicr/core";

import { SvnVcsAdapter } from "../src/svn.js";

// Opt in with a local svn CLI (AICR_SVN_TEST_EXECUTABLE); svnadmin must sit
// next to it. The repository is a real FSFS repo created with svnadmin and
// driven through the same `svn` binary the adapter shells out to — no mock.
// History: r1 add (alice), r2 edit (alice), r3 copy (alice), r4 delete
// (alice), r5 bob add whose svn:author revprop is then deleted — the
// documented mutable/unversioned revprop case (design §5.1.1).
const svn = process.env.AICR_SVN_TEST_EXECUTABLE;
const svnadmin = svn && join(svn, "..", process.platform === "win32" ? "svnadmin.exe" : "svnadmin");

describe.skipIf(!svn)("SVN local repository metadata and batch diff", () => {
  it("reads real XML metadata, tolerates a missing author, and diffs a batch", async () => {
    const base = resolve("build/tmp/svn-live-acceptance");
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, "run-"));
    const repoDir = join(root, "repo");
    const wcDir = join(root, "wc");
    const repoUrl = pathToFileURL(repoDir).href;
    const run = (bin: string, args: readonly string[]): string =>
      execFileSync(bin, [...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

    run(svnadmin!, ["create", repoDir]);
    run(svn!, ["co", "-q", repoUrl, wcDir]);
    const wc = (rel: string) => join(wcDir, rel);

    await mkdir(wc("trunk/src"), { recursive: true });
    await writeFile(wc("trunk/src/a.txt"), "alpha v1\nshared\n");
    await writeFile(wc("trunk/src/b.txt"), "beta v1\n");
    run(svn!, ["add", "-q", wc("trunk")]);
    run(svn!, ["commit", "-q", "--username", "alice", "-m", "A1", wcDir]);

    await writeFile(wc("trunk/src/a.txt"), "alpha v2\nshared\nextra\n");
    run(svn!, ["commit", "-q", "--username", "alice", "-m", "A2", wcDir]);

    run(svn!, ["copy", "-q", "--parents", wc("trunk/src/a.txt"), wc("trunk/src/renamed/a.txt")]);
    run(svn!, ["commit", "-q", "--username", "alice", "-m", "A3 copy", wcDir]);


    run(svn!, ["delete", "-q", wc("trunk/src/b.txt")]);
    run(svn!, ["commit", "-q", "--username", "alice", "-m", "A4 delete", wcDir]);

    await writeFile(wc("trunk/docs.md"), "bob notes\n");
    run(svn!, ["add", "-q", wc("trunk/docs.md")]);
    run(svn!, ["commit", "-q", "--username", "bob", "-m", "B1", wcDir]);

    // revprop changes need an explicit pre-revprop-change hook (E165006
    // without it — verified); enable, then delete the r5 author.
    await writeFile(join(repoDir, "hooks", process.platform === "win32" ? "pre-revprop-change.bat" : "pre-revprop-change"),
      process.platform === "win32" ? "exit 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    run(svn!, ["propdel", "--revprop", "-r", "5", "svn:author", repoUrl]);

    const adapter = new SvnVcsAdapter({ repositoryDir: wcDir, repositoryUrl: repoUrl });
    expect(await adapter.describeSource("5")).toEqual({ repository_url: repoUrl, repository_root: repoUrl, repository_uuid: expect.any(String) });

    const page = await adapter.listCommitMetadataPage({
      scopeRef: `${repoUrl}/trunk`, headRevision: "5", maxRecords: 64, maxBytes: 1_048_576,
    });
    expect(page.status).toBe("complete");
    const reviewPage = await adapter.listReviewCommitMetadataPage({ scopeRef: "event-label", headRevision: "5", maxRecords: 20, maxBytes: 1_048_576 });
    expect(reviewPage.records).toHaveLength(1);
    expect(reviewPage.records[0]).toMatchObject({ revision: "5" });
    expect(reviewPage.records[0]?.svnAuthor).toBeUndefined();
    const reviewFirst = await adapter.listReviewCommitMetadataPage({ scopeRef: "event-label", baseRevision: "1", headRevision: "5", maxRecords: 2, maxBytes: 1_048_576 });
    const reviewNext = await adapter.listReviewCommitMetadataPage({ scopeRef: "event-label", baseRevision: "1", headRevision: "5", cursor: reviewFirst.nextCursor!, maxRecords: 2, maxBytes: 1_048_576 });
    expect([...reviewFirst.records, ...reviewNext.records].map(record => record.revision)).toEqual(["2", "3", "4", "5"]);
    expect(page.records.map((r) => r.revision)).toEqual(["1", "2", "3", "4", "5"]);
    // Authors are the recorded svn:author values only: alice for the streak,
    // and r5's deleted author stays unavailable — never substituted with a
    // service account or OS username.
    expect(page.records.slice(0, 4).every((r) => r.svnAuthor === "alice")).toBe(true);
    expect(page.records[4]?.svnAuthor).toBeUndefined();
    // The copy revision records the destination path.
    expect(page.records[2]?.changedPaths.some((p) => p.includes("renamed/a.txt"))).toBe(true);

    // Pagination walks the range ascending without overlap (real --limit +
    // -r LOW:HIGH behavior, previously an unverified code comment).
    const first = await adapter.listCommitMetadataPage({
      scopeRef: `${repoUrl}/trunk`, headRevision: "5", maxRecords: 2, maxBytes: 1_048_576,
    });
    expect(first.status).toBe("partial");
    expect(first.records.map((r) => r.revision)).toEqual(["1", "2"]);
    const second = await adapter.listCommitMetadataPage({
      scopeRef: `${repoUrl}/trunk`, headRevision: "5", cursor: first.nextCursor!, maxRecords: 2, maxBytes: 1_048_576,
    });
    expect(second.records.map((r) => r.revision)).toEqual(["3", "4"]);
    const tail = await adapter.listCommitMetadataPage({
      scopeRef: `${repoUrl}/trunk`, headRevision: "5", cursor: second.nextCursor!, maxRecords: 2, maxBytes: 1_048_576,
    });
    expect(tail.records.map((r) => r.revision)).toEqual(["5"]);
    expect(tail.status).toBe("complete");

    // Batch diff r1..r4 (net: a.txt edited, copy destination, b.txt deleted).
    const scoped = new SvnVcsAdapter({ repositoryDir: wc("trunk"), repositoryUrl: `${repoUrl}/trunk` });
    const range = await scoped.listChanges(createReviewEvent({ triggerName: "svn", provider: "svn", workspaceId: "ws",
      targetKind: "commit", repoRef: `${repoUrl}/trunk`, baseSha: "1", headSha: "4", author: { username: "alice" }, reason: "test" }));
    const batch = await scoped.diff(range);
    expect(batch.files.map(({ oldPath, newPath, status }) => ({ oldPath, newPath, status })))
      .toEqual(expect.arrayContaining([
        { oldPath: "src/a.txt", newPath: "src/a.txt", status: "modified" },
        { oldPath: "src/b.txt", newPath: undefined, status: "deleted" },
        { oldPath: undefined, newPath: "src/renamed/a.txt", status: "added" },
      ]));
    expect(batch.files).toHaveLength(3);
    // The scope itself did not exist before its first commit (r0).
    const initial = await scoped.diff({ headRevision: "1", files: ["src/a.txt", "src/b.txt"] });
    expect(initial.files.map(file => [file.newPath, file.status])).toEqual([
      ["src/a.txt", "added"], ["src/b.txt", "added"],
    ]);
  }, 60_000);
});
