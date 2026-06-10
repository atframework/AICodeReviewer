import { createReviewEvent, type ReviewEvent, type ReviewProvider } from "@aicr/core";
import { z } from "zod";

import {
  actorSchema,
  containsReviewCommand,
  extractLabelNames,
  normalizeActor,
  resolveWorkspaceIdForRepo,
  type VcsWebhookConfig,
} from "./webhook-common.js";

type GitlabProvider = Extract<ReviewProvider, "gitlab">;

const gitlabMergeRequestPayloadSchema = z
  .object({
    object_attributes: z
      .object({
        iid: z.number().optional(),
        title: z.string().min(1).optional(),
        action: z.string().min(1).optional(),
        source_branch: z.string().min(1).optional(),
        target_branch: z.string().min(1).optional(),
        diff_refs: z
          .object({
            base_sha: z.string().min(1).optional(),
            start_sha: z.string().min(1).optional(),
            head_sha: z.string().min(1).optional(),
          })
          .passthrough()
          .optional(),
        last_commit: z
          .object({
            id: z.string().min(1).optional(),
          })
          .passthrough()
          .optional(),
        source: z
          .object({
            default_branch: z.string().min(1).optional(),
          })
          .passthrough()
          .optional(),
        url: z.string().url().optional(),
        labels: z
          .array(
            z.object({ title: z.string().min(1).optional() }).passthrough(),
          )
          .optional(),
      })
      .passthrough(),
    project: z
      .object({
        path_with_namespace: z.string().min(1),
      })
      .passthrough(),
    user: actorSchema.optional(),
  })
  .passthrough();

const gitlabPushPayloadSchema = z
  .object({
    before: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
    project: z
      .object({
        path_with_namespace: z.string().min(1),
      })
      .passthrough(),
    user_username: z.string().min(1).optional(),
    user_email: z.string().min(1).optional(),
  })
  .passthrough();

const gitlabNotePayloadSchema = z
  .object({
    object_kind: z.literal("note"),
    project: z
      .object({
        path_with_namespace: z.string().min(1),
      })
      .passthrough(),
    user: actorSchema.optional(),
    merge_request: z
      .object({
        iid: z.number().int().positive(),
        source_branch: z.string().min(1).optional(),
        target_branch: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        diff_refs: z
          .object({
            base_sha: z.string().min(1).optional(),
            head_sha: z.string().min(1).optional(),
          })
          .passthrough()
          .optional(),
        labels: z
          .array(
            z.object({ title: z.string().min(1).optional() }).passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    object_attributes: z
      .object({
        note: z.string(),
        noteable_type: z.string().min(1).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export async function translateGitlabWebhookToReviewEvent(
  provider: GitlabProvider,
  eventName: string,
  payload: unknown,
  config: VcsWebhookConfig,
): Promise<ReviewEvent | null> {
  if (eventName === "note" || eventName === "Note Hook") {
    const parsed = gitlabNotePayloadSchema.parse(payload);
    const noteBody = parsed.object_attributes.note ?? "";

    if (!containsReviewCommand(noteBody)) {
      return null;
    }

    const mr = parsed.merge_request;
    if (!mr) {
      return null;
    }

    const mrLabels = extractLabelNames(mr.labels);

    return createReviewEvent({
      triggerName: config.triggerName,
      provider,
      workspaceId: resolveWorkspaceIdForRepo(config, parsed.project.path_with_namespace),
      targetKind: "pull_request",
      repoRef: parsed.project.path_with_namespace,
      baseSha: mr.diff_refs?.base_sha ?? mr.target_branch,
      headSha: mr.diff_refs?.head_sha ?? mr.source_branch,
      author: normalizeActor(parsed.user),
      title: mr.title,
      reason: `${provider}:comment_review`,
      rawEventName: eventName,
      ...(mrLabels.length > 0 ? { labels: mrLabels } : {}),
      branch: mr.source_branch,
    });
  }

  if (eventName === "Merge Request Hook" || eventName === "merge_request") {
    const parsed = gitlabMergeRequestPayloadSchema.parse(payload);
    const mrLabels = extractLabelNames(parsed.object_attributes.labels);

    return createReviewEvent({
      triggerName: config.triggerName,
      provider,
      workspaceId: resolveWorkspaceIdForRepo(config, parsed.project.path_with_namespace),
      targetKind: "pull_request",
      repoRef: parsed.project.path_with_namespace,
      baseSha: parsed.object_attributes.diff_refs?.base_sha ?? parsed.object_attributes.target_branch ?? parsed.object_attributes.source?.default_branch,
      headSha: parsed.object_attributes.diff_refs?.head_sha ?? parsed.object_attributes.last_commit?.id ?? parsed.object_attributes.source_branch,
      author: normalizeActor(parsed.user),
      title: parsed.object_attributes.title,
      url: parsed.object_attributes.url,
      reason: `${provider}:${parsed.object_attributes.action ?? "merge_request"}`,
      rawEventName: eventName,
      ...(mrLabels.length > 0 ? { labels: mrLabels } : {}),
    });
  }

  if (eventName === "Push Hook" || eventName === "git_push") {
    const parsed = gitlabPushPayloadSchema.parse(payload);

    return createReviewEvent({
      triggerName: config.triggerName,
      provider,
      workspaceId: resolveWorkspaceIdForRepo(config, parsed.project.path_with_namespace),
      targetKind: "push",
      repoRef: parsed.project.path_with_namespace,
      baseSha: parsed.before,
      headSha: parsed.after,
      author: {
        username: parsed.user_username,
        email: parsed.user_email,
      },
      reason: `${provider}:push`,
      rawEventName: eventName,
    });
  }

  return null;
}
