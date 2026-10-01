import { createReviewEvent, type ReviewEvent, type ReviewProvider } from "@aicr/core";
import type { ImQueryRun } from "@aicr/store";

/** Rebuild the original target, keeping its diff range and PR/MR metadata. */
export function adminReReviewEvent(row: ImQueryRun, provider: ReviewProvider): ReviewEvent | undefined {
  if (!row.repoRef || !row.triggerName) return undefined;
  if (row.reviewEventJson !== null) {
    const original = createReviewEvent(JSON.parse(row.reviewEventJson));
    if (original.workspaceId !== row.workspaceId || original.repoRef !== row.repoRef || original.triggerName !== row.triggerName
      || original.provider !== provider) {
      throw new Error("stored review event does not match run identity");
    }
    return createReviewEvent({ ...original, requestOrigin: undefined, reason: "admin:rereview" });
  }
  // A historical commit row may represent a multi-commit push. Its head alone
  // cannot establish the original diff range, so require the saved event.
  return undefined;
}
