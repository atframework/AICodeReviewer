import {
  createReviewEvent,
  type ReviewEvent,
  type WorkspaceResolution,
  type WorkspaceSourceValues,
} from "@aicr/core";
import { z } from "zod";

/**
 * Explicit project root inside a monitored SVN repository (spec §5.3: branch
 * and project_path exist only under explicitly configured roots, never
 * inferred from arbitrary URLs).
 */
export interface SvnProjectRoot {
  /** Path prefix inside the repository, e.g. "/projects/app/trunk". */
  readonly prefix: string;
  readonly project: string;
  readonly branch?: string;
}

export interface SvnTriggerConfig {
  readonly triggerName: string;
  readonly workspaceId: string;
  readonly repositoryUrl: string;
  readonly projectRoots?: readonly SvnProjectRoot[];
  /** See P4TriggerConfig.resolveWorkspace — same pending-receipt contract. */
  readonly resolveWorkspace?: (
    source: WorkspaceSourceValues,
    event?: { base_branch?: string | null; head_branch?: string | null },
  ) => WorkspaceResolution;
}

/** Minimal routing envelope extracted from a verified trigger payload. */
export interface SvnRoutingEnvelope {
  readonly revision: string;
  readonly user?: string;
  readonly files?: readonly string[];
}

/**
 * Extracts the routing-stage envelope without any server-side metadata query.
 * Returns null when the payload names no revision.
 */
export function buildSvnRoutingEnvelope(payload: unknown): SvnRoutingEnvelope | null {
  const parsed = svnTriggerPayloadSchema.parse(payload);
  const revision = String(parsed.revision ?? parsed.rev ?? parsed.r ?? "").trim();
  if (!revision) {
    return null;
  }
  const author = firstNonEmpty(parsed.author, parsed.user);
  const files = parsed.changed_files ?? parsed.files ?? [];
  return {
    revision,
    ...(author ? { user: author } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
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

