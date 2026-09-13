import type { ReviewConfig, ReviewEvent } from "@aicr/core";
import type { ChangeRange, ParsedDiff } from "@aicr/vcs";
import type { DiffCapableVcsAdapter } from "./review-orchestrator.js";

/** One analysis per event; per_commit supplies individually labelled patches. */
export async function applyReviewCommitPolicy(
  vcs: DiffCapableVcsAdapter,
  event: ReviewEvent,
  range: ChangeRange,
  aggregate: ParsedDiff | undefined,
  strategy: ReviewConfig["commit_strategy"],
  contextLines: number,
): Promise<{ diff: ParsedDiff | undefined; files: readonly string[] }> {
  if (!strategy || strategy === "aggregate" || (event.targetKind !== "push" && event.targetKind !== "commit")) {
    return { diff: aggregate, files: range.files };
  }
  if (!vcs.diff || !vcs.listCommitMetadataPage || !range.headRevision) {
    throw new Error(`review.commit_strategy=${strategy} requires verified commit metadata and diff support.`);
  }
  const page = await vcs.listCommitMetadataPage({ ...(range.baseRevision ? { baseRevision: range.baseRevision } : {}),
    scopeRef: event.repoRef, headRevision: range.headRevision, maxRecords: 256, maxBytes: 1_048_576 });
  if (page.status !== "complete" || page.nextCursor) {
    throw new Error("Commit review range exceeds the verified metadata budget; reduce its scope.");
  }
  // A rewritten history is an indivisible endpoint comparison (D35).
  if (page.historyRewrite || page.records.some(record => record.historyRewrite)) return { diff: aggregate, files: range.files };
  const records = strategy === "head_only" ? page.records.filter(record => record.revision === range.headRevision) : page.records;
  if (records.length === 0) throw new Error("Commit metadata did not contain the review head.");
  const files: ParsedDiff["files"][number][] = [];
  const selectedPaths = new Set<string>();
  for (const record of records) {
    if (record.changedPathsComplete === false) throw new Error("Commit metadata has incomplete changed paths.");
    const paths = record.changedPaths.filter(path => range.files.includes(path));
    // An empty Git pathspec means the whole tree, not an empty selection.
    if (paths.length === 0) continue;
    for (const path of paths) selectedPaths.add(path);
    const baseRevision = page.vcs === "git" ? record.parents[0] : undefined;
    const diff = await vcs.diff({ ...(baseRevision ? { baseRevision } : {}), headRevision: record.revision, files: paths }, { contextLines });
    files.push(...diff.files.map(file => ({ ...file, hunks: file.hunks.map(hunk => ({ ...hunk,
      section: `commit ${record.revision}${hunk.section ? `: ${hunk.section}` : ""}` })) })));
  }
  return { diff: { files }, files: [...selectedPaths] };
}
