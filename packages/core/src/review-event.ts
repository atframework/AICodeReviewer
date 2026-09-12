import { z } from "zod";

import type { WorkspaceBinding } from "./config-workspace.js";

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
    /**
     * Target (base) branch of a PR/MR — `pull_request.base.ref` for
     * Gitea/GitHub, `object_attributes.target_branch` for GitLab. Unset for
     * push/commit/issue/manual/scheduled events and for comment commands whose
     * PR-detail enrichment failed.
     */
    targetBranch: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    submitterWorkspace: z.string().min(1).optional(),
    /**
     * Frozen admission resolution (spec §5.2/§5.5). Absent on events routed
     * before this field existed — consumers fall back to deriving the layout
     * from the event fields.
     */
    resolution: z.lazy(() => reviewEventResolutionSchema).optional(),
  })
  .strict();

/**
 * Admission-time workspace binding snapshot carried on the event (V14).
 * `match` carries the frozen binding so execution never re-derives the
 * instance from later-edited config; `legacy_binding` pins the definition id.
 */
export const reviewEventResolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("legacy_binding"),
      definitionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("match"),
      definitionId: z.string().min(1),
      ruleId: z.string().min(1).optional(),
      binding: z
        .object({
          definitionId: z.string().min(1),
          instanceId: z.string(),
          workPath: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);

export type ReviewEvent = z.infer<typeof reviewEventSchema>;
export type ReviewActor = z.infer<typeof reviewActorSchema>;
export type ReviewProvider = z.infer<typeof reviewProviderSchema>;
export type ReviewEventResolution = z.infer<typeof reviewEventResolutionSchema>;

/** Projects a full admission resolution onto the event-carried snapshot. */
export function projectEventResolution(
  resolution:
    | { readonly kind: "legacy_binding"; readonly definitionId: string }
    | {
        readonly kind: "match";
        readonly definitionId: string;
        readonly ruleId?: string | undefined;
        readonly binding: WorkspaceBinding;
      },
): ReviewEventResolution {
  if (resolution.kind === "legacy_binding") {
    return { kind: "legacy_binding", definitionId: resolution.definitionId };
  }
  return {
    kind: "match",
    definitionId: resolution.definitionId,
    ...(resolution.ruleId !== undefined ? { ruleId: resolution.ruleId } : {}),
    binding: resolution.binding,
  };
}
export type ReviewTargetKind = z.infer<typeof reviewTargetKindSchema>;

/** VCS family behind a review provider; undefined for providers with no VCS (manual/scheduled). */
export type ReviewVcsKind = "git" | "svn" | "p4";

export function vcsKindForProvider(provider: ReviewProvider): ReviewVcsKind | undefined {
  if (provider === "p4") {
    return "p4";
  }
  if (provider === "svn") {
    return "svn";
  }
  if (provider === "gitea" || provider === "forgejo" || provider === "github" || provider === "gitlab") {
    return "git";
  }
  return undefined;
}

export function createReviewEvent(input: ReviewEvent): ReviewEvent {
  return reviewEventSchema.parse(input);
}