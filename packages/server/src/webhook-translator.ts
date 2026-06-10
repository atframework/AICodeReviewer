import type { ReviewEvent, ReviewProvider } from "@aicr/core";

import { translateGiteaWebhookToReviewEvent } from "./gitea-webhook.js";
import { translateGithubWebhookToReviewEvent } from "./github-webhook.js";
import { translateGitlabWebhookToReviewEvent } from "./gitlab-webhook.js";
import type { VcsWebhookConfig } from "./webhook-common.js";

export {
  computeWebhookSignature,
  extractWebhookRepositoryRef,
  matchesWebhookRepo,
  verifyWebhookSignature,
} from "./webhook-common.js";
export type { RepositoryWorkspaceMapping, VcsWebhookConfig } from "./webhook-common.js";

export async function translateWebhookToReviewEvent(
  provider: ReviewProvider,
  eventName: string,
  payload: unknown,
  config: VcsWebhookConfig,
): Promise<ReviewEvent | null> {
  if (provider === "gitea" || provider === "forgejo") {
    return translateGiteaWebhookToReviewEvent(provider, eventName, payload, config);
  }

  if (provider === "github") {
    return translateGithubWebhookToReviewEvent(provider, eventName, payload, config);
  }

  if (provider === "gitlab") {
    return translateGitlabWebhookToReviewEvent(provider, eventName, payload, config);
  }

  return null;
}
