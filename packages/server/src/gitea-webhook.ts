import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createReviewEvent,
  type ReviewActor,
  type ReviewEvent,
  type ReviewProvider,
} from "@aicr/core";
import { z } from "zod";

export interface GiteaWebhookConfig {
  readonly triggerName: string;
  readonly workspaceId: string;
  readonly webhookSecret?: string;
}

const repositorySchema = z
  .object({
    full_name: z.string().min(1),
  })
  .strict();

const actorSchema = z
  .object({
    login: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    email: z.string().email().optional(),
    full_name: z.string().min(1).optional(),
  })
  .passthrough();

const pullRequestPayloadSchema = z
  .object({
    action: z.string().min(1).optional(),
    repository: repositorySchema,
    sender: actorSchema.optional(),
    pull_request: z
      .object({
        html_url: z.string().url().optional(),
        user: actorSchema.optional(),
        base: z.object({ sha: z.string().min(1).optional() }).passthrough(),
        head: z.object({ sha: z.string().min(1).optional() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const pushPayloadSchema = z
  .object({
    before: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
    compare_url: z.string().url().optional(),
    repository: repositorySchema,
    pusher: actorSchema.optional(),
  })
  .passthrough();

const issuePayloadSchema = z
  .object({
    action: z.string().min(1).optional(),
    repository: repositorySchema,
    sender: actorSchema.optional(),
    issue: z
      .object({
        number: z.number().int().positive().optional(),
        title: z.string().min(1).optional(),
        body: z.string().optional(),
        html_url: z.string().url().optional(),
        state: z.string().min(1).optional(),
        user: actorSchema.optional(),
        labels: z
          .array(
            z.object({ name: z.string().min(1).optional() }).passthrough(),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const gitlabMergeRequestPayloadSchema = z
  .object({
    object_attributes: z
      .object({
        iid: z.number().optional(),
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
    user_email: z.string().email().optional(),
  })
  .passthrough();

function normalizeActor(actor: z.infer<typeof actorSchema> | undefined): ReviewActor {
  return {
    username: actor?.login ?? actor?.username,
    email: actor?.email,
    displayName: actor?.full_name,
  };
}

export function computeWebhookSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyWebhookSignature(
  payload: string,
  secret: string | undefined,
  providedSignature: string | undefined,
): boolean {
  if (!secret) {
    return true;
  }

  if (!providedSignature) {
    return false;
  }

  const normalized = providedSignature.replace(/^sha256=/iu, "").trim();
  const expectedHex = computeWebhookSignature(payload, secret);

  if (!/^[0-9a-f]+$/iu.test(normalized) || normalized.length !== expectedHex.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(normalized, "hex"));
}

export function translateWebhookToReviewEvent(
  provider: ReviewProvider,
  eventName: string,
  payload: unknown,
  config: GiteaWebhookConfig,
): ReviewEvent | null {
  if (eventName === "pull_request") {
    const parsed = pullRequestPayloadSchema.parse(payload);

    return createReviewEvent({
      triggerName: config.triggerName,
      provider,
      workspaceId: config.workspaceId,
      targetKind: "pull_request",
      repoRef: parsed.repository.full_name,
      baseSha: parsed.pull_request.base.sha,
      headSha: parsed.pull_request.head.sha,
      author: normalizeActor(parsed.sender ?? parsed.pull_request.user),
      url: parsed.pull_request.html_url,
      reason: `${provider}:${parsed.action ?? "pull_request"}`,
      rawEventName: eventName,
    });
  }

  if (eventName === "push") {
    const parsed = pushPayloadSchema.parse(payload);

    return createReviewEvent({
      triggerName: config.triggerName,
      provider,
      workspaceId: config.workspaceId,
      targetKind: "push",
      repoRef: parsed.repository.full_name,
      baseSha: parsed.before,
      headSha: parsed.after,
      author: normalizeActor(parsed.pusher),
      url: parsed.compare_url,
      reason: `${provider}:push`,
      rawEventName: eventName,
    });
  }

  if (eventName === "issues") {
    const parsed = issuePayloadSchema.parse(payload);
    const issueNumber = parsed.issue?.number;
    const issueUrl = parsed.issue?.html_url;

    return createReviewEvent({
      triggerName: config.triggerName,
      provider,
      workspaceId: config.workspaceId,
      targetKind: "issue",
      repoRef: parsed.repository.full_name,
      author: normalizeActor(parsed.sender ?? parsed.issue?.user),
      url: issueUrl,
      reason: `${provider}:${parsed.action ?? "issues"}`,
      rawEventName: eventName,
      ...(issueNumber !== undefined ? { changedFiles: [String(issueNumber)] } : {}),
    });
  }

  if (eventName === "Merge Request Hook" || eventName === "merge_request") {
    const parsed = gitlabMergeRequestPayloadSchema.parse(payload);

    return createReviewEvent({
      triggerName: config.triggerName,
      provider,
      workspaceId: config.workspaceId,
      targetKind: "pull_request",
      repoRef: parsed.project.path_with_namespace,
      baseSha: parsed.object_attributes.diff_refs?.base_sha ?? parsed.object_attributes.target_branch ?? parsed.object_attributes.source?.default_branch,
      headSha: parsed.object_attributes.diff_refs?.head_sha ?? parsed.object_attributes.last_commit?.id ?? parsed.object_attributes.source_branch,
      author: normalizeActor(parsed.user),
      url: parsed.object_attributes.url,
      reason: `${provider}:${parsed.object_attributes.action ?? "merge_request"}`,
      rawEventName: eventName,
    });
  }

  if (eventName === "Push Hook" || eventName === "git_push") {
    const parsed = gitlabPushPayloadSchema.parse(payload);

    return createReviewEvent({
      triggerName: config.triggerName,
      provider,
      workspaceId: config.workspaceId,
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