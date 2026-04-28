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

  return null;
}