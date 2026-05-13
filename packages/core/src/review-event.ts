import { z } from "zod";

export const reviewProviderSchema = z.enum([
  "gitea",
  "forgejo",
  "github",
  "gitlab",
  "p4",
  "svn",
  "scheduled",
  "manual",
]);

export const reviewTargetKindSchema = z.enum([
  "pull_request",
  "push",
  "commit",
  "issue",
  "manual",
  "scheduled",
]);

export const reviewActorSchema = z
  .object({
    username: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
  })
  .passthrough();

export const reviewEventSchema = z
  .object({
    triggerName: z.string().min(1),
    provider: reviewProviderSchema,
    workspaceId: z.string().min(1),
    targetKind: reviewTargetKindSchema,
    repoRef: z.string().min(1),
    baseSha: z.string().min(1).optional(),
    headSha: z.string().min(1).optional(),
    changedFiles: z.array(z.string().min(1)).optional(),
    author: reviewActorSchema,
    title: z.string().min(1).optional(),
    url: z.string().url().optional(),
    reason: z.string().min(1),
    labels: z.array(z.string().min(1)).optional(),
    rawEventName: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    submitterWorkspace: z.string().min(1).optional(),
  })
  .strict();

export type ReviewEvent = z.infer<typeof reviewEventSchema>;
export type ReviewActor = z.infer<typeof reviewActorSchema>;
export type ReviewProvider = z.infer<typeof reviewProviderSchema>;
export type ReviewTargetKind = z.infer<typeof reviewTargetKindSchema>;

export function createReviewEvent(input: ReviewEvent): ReviewEvent {
  return reviewEventSchema.parse(input);
}