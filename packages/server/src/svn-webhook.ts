import { createReviewEvent, type ReviewEvent } from "@aicr/core";
import { z } from "zod";

export interface SvnTriggerConfig {
  readonly triggerName: string;
  readonly workspaceId: string;
  readonly repositoryUrl: string;
}

const svnTriggerPayloadSchema = z
  .object({
    revision: z.union([z.string(), z.number()]).optional(),
    rev: z.union([z.string(), z.number()]).optional(),
    r: z.union([z.string(), z.number()]).optional(),
    author: z.string().optional(),
    user: z.string().optional(),
    changed_files: z.array(z.string()).optional(),
    files: z.array(z.string()).optional(),
    base_revision: z.union([z.string(), z.number()]).optional(),
    base_rev: z.union([z.string(), z.number()]).optional(),
    old_revision: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
}

export function translateSvnTriggerToReviewEvent(
  payload: unknown,
  config: SvnTriggerConfig,
): ReviewEvent | null {
  const parsed = svnTriggerPayloadSchema.parse(payload);
  const revision = String(parsed.revision ?? parsed.rev ?? parsed.r ?? "").trim();
  const repositoryUrl = config.repositoryUrl.trim();
  const baseRevision = parsed.base_revision ?? parsed.base_rev ?? parsed.old_revision;
  const author = firstNonEmpty(parsed.author, parsed.user);
  const changedFiles = parsed.changed_files ?? parsed.files ?? [];

  if (!revision || !repositoryUrl) {
    return null;
  }


  return createReviewEvent({
    triggerName: config.triggerName,
    provider: "svn",
    workspaceId: config.workspaceId,
    targetKind: "commit",
    repoRef: repositoryUrl,
    baseSha: baseRevision ? String(baseRevision) : undefined,
    headSha: revision,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    author: {
      username: author || undefined,
    },
    reason: `svn:post-commit:${revision}`,
    rawEventName: "post-commit",
    sourcePath: repositoryUrl,
  });
}

