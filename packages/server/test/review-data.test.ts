import { describe, expect, it, vi } from "vitest";
import { createReviewEvent } from "@aicr/core";
import { parseReviewDataRequest } from "@aicr/mcp-output";
import type { CommitMetadataPage, CommitMetadataQuery } from "@aicr/vcs";
import type { DiffCapableVcsAdapter } from "../src/review-orchestrator.js";
import { createReviewDataHandler } from "../src/review-data.js";

const event = createReviewEvent({ triggerName: "test", workspaceId: "ws", provider: "github", targetKind: "pull_request",
  repoRef: "upstream/repo", sourceRepoRef: "fork/repo", targetRepoRef: "upstream/repo", branch: "feature", targetBranch: "main",
  baseSha: "base", headSha: "head", author: { username: "delivery-actor" }, reason: "test" });
const range = { baseRevision: "base", headRevision: "head", files: ["a.ts"] };
const record = { revision: "head", parents: ["base"], orderKey: "1", changedPaths: ["a.ts", "deleted.ts"],
  authorName: "Raw Name", authorEmail: "raw@example.com", committerName: "Bot", committerEmail: "bot@example.com" };

function harness(page: CommitMetadataPage = { vcs: "git", status: "complete", records: [record] }) {
  const metadata = vi.fn(async (_query: CommitMetadataQuery) => page);
  const diff = vi.fn(async () => ({ files: [] }));
  const listChanges = vi.fn(async () => ({ headRevision: "head", files: ["local/a.ts"] }));
  const vcs: DiffCapableVcsAdapter = { kind: page.vcs, listReviewCommitMetadataPage: metadata, diff, listChanges,
    fetchScoped: async () => ({ workspaceId: "ws", rootDir: "build/tmp", fetchedFiles: [] }),
    fetchExtraContext: async () => ({ path: "", content: "" }) };
  const call = createReviewDataHandler(vcs, event, range, ["a.ts"]);
  return { vcs, call, metadata, diff, listChanges };
}
const query = (input: unknown = {}) => parseReviewDataRequest("aicr.get_review_commits", input);

describe("review data host handler", () => {
  it("returns only IDs by default, without author/repository information or diff reads", async () => {
    const h = harness();
    expect(await h.call(query())).toEqual({ status: "complete", vcs: "git", commits: [{ revision: "head" }] });
    expect(h.diff).not.toHaveBeenCalled();
    expect(h.metadata).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: "base", headRevision: "head", maxRecords: 20 }));
  });
  it("returns raw author and fork source/target metadata on request", async () => {
    const h = harness();
    expect(await h.call(query({ include_authors: true, include_repositories: true }))).toMatchObject({
      commits: [{ author: { username: null, display_name: "Raw Name", email: "raw@example.com", committer_name: "Bot" } }],
      repositories: { source: { repository: "fork/repo", branch: "feature" }, target: { repository: "upstream/repo", branch: "main" } },
    });
  });
  it("reports the effective file scope and uses identical source/target for automatic commits", async () => {
    const h = harness();
    const handler = createReviewDataHandler(h.vcs, { ...event, targetKind: "commit" }, range, ["effective.ts"]);
    expect(await handler(parseReviewDataRequest("aicr.get_review_context", {}))).toMatchObject({
      reviewed_files: ["effective.ts"], base_revision: "base", head_revision: "head", files_truncated: false,
      repositories: { source: { repository: "upstream/repo", branch: "feature" }, target: { repository: "upstream/repo", branch: "feature" } },
    });
  });
  it("does not invent the source of an old PR event", async () => {
    const h = harness();
    const handler = createReviewDataHandler(h.vcs, { ...event, sourceRepoRef: undefined }, range, []);
    expect(await handler(query({ include_repositories: true }))).toMatchObject({ repositories: { source: { repository: null } } });
  });
  it.each(["files", "diffs", "summary"])("projects %s without dropping deleted files", async detail => {
    const h = harness();
    const result = await h.call(query({ detail }));
    if (detail === "summary") expect(result).toMatchObject({ files: ["a.ts", "deleted.ts"], files_scope: "page" });
    else expect(result).toMatchObject({ commits: [{ files: ["a.ts", "deleted.ts"] }] });
    expect(h.diff).toHaveBeenCalledTimes(detail === "diffs" ? 1 : 0);
    if (detail === "diffs") expect(h.diff).toHaveBeenCalledWith({ baseRevision: "base", headRevision: "head", files: record.changedPaths }, { contextLines: 3 });
  });
  it("keeps empty commits empty rather than passing an empty Git pathspec", async () => {
    const h = harness({ vcs: "git", status: "complete", records: [{ ...record, changedPaths: [] }] });
    expect(await h.call(query({ detail: "diffs" }))).toMatchObject({ commits: [{ files: [], diff: { files: [] } }] });
    expect(h.diff).not.toHaveBeenCalled();
  });
  it.each(["svn", "p4"] as const)("uses normalized %s file paths and recorded submitter metadata", async vcs => {
    const h = harness({ vcs, status: "complete", records: [{ ...record, p4User: "alice", p4Client: "client", svnAuthor: "alice" }] });
    const files = vcs === "svn" ? ["local/a.ts"] : record.changedPaths;
    expect(await h.call(query({ detail: "diffs", include_authors: true }))).toMatchObject({ commits: [{ files, author: { username: "alice" } }] });
    if (vcs === "svn") expect(h.listChanges).toHaveBeenCalledWith(expect.objectContaining({ baseSha: undefined, headSha: "head", changedFiles: undefined }));
    expect(h.diff).toHaveBeenCalledWith({ headRevision: "head", files }, { contextLines: 3 });
  });
  it("round-trips continuations and rejects cross-review/cross-projection cursors", async () => {
    const h = harness({ vcs: "git", status: "partial", records: [record], nextCursor: "20" });
    const first = await h.call(query());
    await h.call(query({ cursor: first.next_cursor }));
    expect(h.metadata).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "20" }));
    await expect(h.call(query({ cursor: first.next_cursor, include_authors: true }))).rejects.toThrow("Cursor");
    const other = createReviewDataHandler(h.vcs, event, { ...range, headRevision: "other" }, []);
    await expect(other(query({ cursor: first.next_cursor }))).rejects.toThrow("Cursor");
    await expect(h.call(query({ cursor: "invalid" }))).rejects.toThrow();
    const [payload, signature] = String(first.next_cursor).split(".");
    const forged = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    forged[1] = "0";
    await expect(h.call(query({ cursor: `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}` }))).rejects.toThrow("Cursor");
  });
  it("honors head_only for automatic commits without changing PR membership", async () => {
    const h = harness();
    await createReviewDataHandler(h.vcs, { ...event, targetKind: "push" }, range, [], "head_only")(query());
    expect(h.metadata.mock.calls[0]?.[0]).not.toHaveProperty("baseRevision");
    await createReviewDataHandler(h.vcs, event, range, [], "head_only")(query());
    expect(h.metadata).toHaveBeenLastCalledWith(expect.objectContaining({ baseRevision: "base" }));
  });
  it("rejects incomplete P4 file metadata rather than presenting an empty diff", async () => {
    const h = harness({ vcs: "p4", status: "complete", records: [{ ...record, changedPaths: [], changedPathsComplete: false }] });
    await expect(h.call(query({ detail: "diffs" }))).rejects.toThrow("incomplete");
    expect(h.diff).not.toHaveBeenCalled();
    expect(await h.call(query())).toMatchObject({ commits: [{ revision: "head" }] });
  });
  it("reports unavailable history without exposing command diagnostics", async () => {
    const h = harness({ vcs: "git", status: "unavailable", records: [], unavailableReason: "https://user:secret@example.com" });
    expect(await h.call(query())).toEqual({ status: "unavailable", reason: "The pinned VCS history could not be read.", commits: [] });
    const { listReviewCommitMetadataPage: _metadata, ...unsupported } = h.vcs;
    expect(await createReviewDataHandler(unsupported, event, range, [])(query())).toMatchObject({ status: "unavailable" });
  });
  it("rejects oversized responses without silently returning a truncated diff", async () => {
    const h = harness({ vcs: "git", status: "complete", records: [{ ...record, changedPaths: ["a".repeat(2000)] }] });
    await expect(h.call(query({ detail: "files", max_bytes: 1024 }))).rejects.toThrow("No diff was truncated");
    expect(await h.call(query())).toMatchObject({ commits: [{ revision: "head" }] });
  });
});
