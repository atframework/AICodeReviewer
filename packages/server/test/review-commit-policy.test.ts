import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createReviewEvent } from "@aicr/core";
import { createGitVcsAdapter, parseUnifiedDiff } from "@aicr/vcs";
import { applyReviewCommitPolicy } from "../src/review-commit-policy.js";
import type { DiffCapableVcsAdapter } from "../src/review-orchestrator.js";

const event = createReviewEvent({ triggerName: "git", provider: "github", workspaceId: "ws", targetKind: "push", repoRef: "acme/repo", author: {}, reason: "test" });
const aggregate = parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
const range = { baseRevision: "base", headRevision: "head", files: ["a.ts"] };
function adapter(): DiffCapableVcsAdapter {
  return { kind: "git", listChanges: vi.fn(), fetchScoped: vi.fn(), fetchExtraContext: vi.fn(),
    diff: vi.fn(async () => aggregate), listCommitMetadataPage: vi.fn(async () => ({ vcs: "git", status: "complete", records: [
      { revision: "middle", parents: ["base"], orderKey: "1", changedPaths: ["a.ts"] },
      { revision: "head", parents: ["middle"], orderKey: "2", changedPaths: ["a.ts"] },
    ] })) };
}
describe("review.commit_strategy actual diff consumption", () => {
  it.each(["aggregate", "head_only", "per_commit"] as const)("%s selects verified commits", async strategy => {
    const vcs = adapter();
    const result = await applyReviewCommitPolicy(vcs, event, range, aggregate, strategy, 5);
    expect(vcs.diff).toHaveBeenCalledTimes(strategy === "aggregate" ? 0 : strategy === "head_only" ? 1 : 2);
    if (strategy !== "aggregate") expect(vcs.diff).toHaveBeenLastCalledWith({ baseRevision: "middle", headRevision: "head", files: ["a.ts"] }, { contextLines: 5 });
    if (strategy === "per_commit") expect(result.diff?.files.map(file => file.hunks[0]?.section)).toEqual(["commit middle", "commit head"]);
  });
  it.each(["partial", "unavailable"] as const)("rejects %s metadata before fetching patches", async status => {
    const vcs = adapter();
    vi.mocked(vcs.listCommitMetadataPage!).mockResolvedValue({ vcs: "git", status, records: [] });
    await expect(applyReviewCommitPolicy(vcs, event, range, aggregate, "per_commit", 3)).rejects.toThrow("metadata budget");
    expect(vcs.diff).not.toHaveBeenCalled();
  });
  it("preserves indivisible rewrite comparisons and never broadens an empty filtered pathspec", async () => {
    const vcs = adapter();
    const page = await vcs.listCommitMetadataPage!({ headRevision: "head", maxRecords: 2, maxBytes: 1000 });
    vi.mocked(vcs.listCommitMetadataPage!).mockResolvedValue({ ...page, historyRewrite: true });
    expect((await applyReviewCommitPolicy(vcs, event, range, aggregate, "per_commit", 3)).diff).toBe(aggregate);
    vi.mocked(vcs.listCommitMetadataPage!).mockResolvedValue({ ...page, records: page.records.map(record => ({ ...record, changedPaths: ["excluded.ts"] })) });
    expect((await applyReviewCommitPolicy(vcs, event, range, aggregate, "head_only", 3)).files).toEqual([]);
    expect(vcs.diff).not.toHaveBeenCalled();
  });
  it("reviews a real Git root commit without assuming the repository hash algorithm", async () => {
    await mkdir("build/tmp", { recursive: true });
    const root = await mkdtemp(join(process.cwd(), "build/tmp/commit-policy-"));
    const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", root, ...args])).stdout.trim();
    try {
      await git("init");
      await writeFile(join(root, "a.ts"), "export const sentinel = 42;\n");
      await git("add", "a.ts");
      await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "root");
      const head = await git("rev-parse", "HEAD");
      const result = await applyReviewCommitPolicy(createGitVcsAdapter({ repositoryDir: root }), event,
        { headRevision: head, files: ["a.ts"] }, undefined, "head_only", 3);
      expect(result.diff?.files[0]?.hunks[0]?.section).toBe(`commit ${head}`);
      expect(JSON.stringify(result.diff)).toContain("sentinel = 42");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
