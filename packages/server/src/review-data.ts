import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ReviewConfig, ReviewEvent } from "@aicr/core";
import type { ReviewDataHandler } from "@aicr/mcp-output";
import type { ChangeRange, CommitMetadataRecord } from "@aicr/vcs";
import type { DiffCapableVcsAdapter } from "./review-orchestrator.js";

function repositories(event: ReviewEvent) {
  const pull = event.targetKind === "pull_request";
  return {
    source: { repository: pull ? event.sourceRepoRef ?? null : event.repoRef, branch: event.branch ?? null },
    target: { repository: pull ? event.targetRepoRef ?? event.repoRef : event.repoRef,
      branch: (pull ? event.targetBranch : event.branch) ?? null },
  };
}

function author(record: CommitMetadataRecord) {
  return {
    username: record.p4User ?? record.svnAuthor ?? null,
    display_name: record.authorName ?? null,
    email: record.authorEmail ?? null,
    workspace: record.p4Client ?? null,
    committer_name: record.committerName ?? null,
    committer_email: record.committerEmail ?? null,
  };
}

/** The host owns VCS credentials; native MCP records requests for this same handler. */
export function createReviewDataHandler(
  vcs: DiffCapableVcsAdapter,
  event: ReviewEvent,
  range: ChangeRange,
  reviewedFiles: readonly string[],
  strategy?: ReviewConfig["commit_strategy"],
): ReviewDataHandler {
  const cursorKey = randomBytes(32);
  const sign = (payload: string) => createHmac("sha256", cursorKey).update(payload).digest("hex");
  return async (request) => {
    if (request.name === "aicr.get_review_context") {
      return { provider: event.provider, target_kind: event.targetKind,
        base_revision: range.baseRevision ?? event.baseSha ?? null,
        head_revision: range.headRevision ?? event.headSha ?? null,
        repositories: repositories(event), reviewed_files: reviewedFiles.slice(0, 1000),
        reviewed_file_count: reviewedFiles.length, files_truncated: reviewedFiles.length > 1000,
        commit_strategy: strategy ?? "aggregate" };
    }
    const input = request.input;
    const headRevision = range.headRevision ?? event.headSha;
    const headOnly = strategy === "head_only" && (event.targetKind === "push" || event.targetKind === "commit");
    const baseRevision = headOnly ? undefined : range.baseRevision ?? event.baseSha;
    if (!headRevision || !vcs.listReviewCommitMetadataPage) {
      return { status: "unavailable", reason: "The current review has no pinned revision or its VCS adapter does not support review metadata.", commits: [] };
    }
    // Bind continuations to the review and projection. Never accept a caller-chosen revision.
    const identity = createHash("sha256").update(JSON.stringify({ provider: event.provider, repo: event.repoRef,
      baseRevision, headRevision, detail: input.detail, authors: input.include_authors,
      repositories: input.include_repositories })).digest("hex").slice(0, 24);
    let cursor: string | undefined;
    if (input.cursor) {
      const [payload, signature, extra] = input.cursor.split(".");
      if (!payload || !signature || extra !== undefined || !/^[0-9a-f]{64}$/u.test(signature) ||
        !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(sign(payload), "hex"))) {
        throw new Error("Cursor does not belong to this review/query.");
      }
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== identity || typeof decoded[1] !== "string") {
        throw new Error("Cursor does not belong to this review/query.");
      }
      cursor = decoded[1];
    }
    const page = await vcs.listReviewCommitMetadataPage({ scopeRef: event.sourcePath ?? event.repoRef,
      ...(baseRevision ? { baseRevision } : {}), headRevision, ...(cursor ? { cursor } : {}),
      maxRecords: input.limit, maxBytes: 1_048_576 });
    if (page.status === "unavailable") {
      // Raw command diagnostics may contain credential-bearing URLs or local paths.
      return { status: "unavailable", reason: "The pinned VCS history could not be read.", commits: [] };
    }
    const commits: Record<string, unknown>[] = [];
    const summary = new Set<string>();
    for (const record of page.records) {
      const item: Record<string, unknown> = { revision: record.revision };
      if (input.include_authors) item.author = author(record);
      if (input.detail !== "ids") {
        const parent = page.vcs === "git" ? record.parents[0] : undefined;
        // SVN metadata paths are repository-global. listChanges normalizes them.
        // The review-specific Git/P4 metadata already carries scoped local paths.
        const commitRange = page.vcs !== "svn"
          ? { ...(parent ? { baseRevision: parent } : {}), headRevision: record.revision, files: record.changedPaths }
          : await vcs.listChanges({ ...event, baseSha: undefined, headSha: record.revision, changedFiles: undefined });
        if (page.vcs !== "svn" && record.changedPathsComplete === false) throw new Error("Commit file list is incomplete.");
        for (const path of commitRange.files) summary.add(path);
        if (input.detail !== "summary") item.files = commitRange.files;
        if (input.detail === "diffs") {
          if (!vcs.diff) throw new Error("The current VCS adapter does not support commit diffs.");
          // Empty Git pathspecs mean the entire tree. Empty commits have an empty patch.
          item.diff = commitRange.files.length ? await vcs.diff(commitRange, { contextLines: 3 }) : { files: [] };
        }
      }
      commits.push(item);
    }
    const payload = page.nextCursor ? Buffer.from(JSON.stringify([identity, page.nextCursor])).toString("base64url") : undefined;
    const result = { status: page.status, vcs: page.vcs, commits,
      ...(input.detail === "summary" ? { files: [...summary].sort(), files_scope: "page" } : {}),
      ...(input.include_repositories ? { repositories: repositories(event) } : {}),
      ...(payload ? { next_cursor: `${payload}.${sign(payload)}` } : {}) };
    if (Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") > input.max_bytes) {
      throw new Error("Review data exceeds max_bytes. Request fewer commits, use ids/files, or increase max_bytes (up to 1048576). No diff was truncated.");
    }
    return result;
  };
}
