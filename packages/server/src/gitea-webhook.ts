import type { ReviewEvent, ReviewProvider } from "@aicr/core";

import {
  createIssueReviewEvent,
  createPullRequestReviewEvent,
  createPushReviewEvent,
  issuePayloadSchema,
  pullRequestPayloadSchema,
  pushPayloadSchema,
  translateIssueCommentReviewCommand,
  type PullRequestDetails,
  type VcsWebhookConfig,
} from "./webhook-common.js";

type GiteaLikeProvider = Extract<ReviewProvider, "gitea" | "forgejo">;

async function fetchGiteaPullRequestDetails(
  prApiUrl: string,
  token: string,
): Promise<PullRequestDetails> {
  const response = await fetch(prApiUrl, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch PR details: ${response.status}`);
  }
  return response.json() as Promise<PullRequestDetails>;
}

export async function translateGiteaWebhookToReviewEvent(
  provider: GiteaLikeProvider,
  eventName: string,
  payload: unknown,
  config: VcsWebhookConfig,
): Promise<ReviewEvent | null> {
  if (eventName === "pull_request" || eventName === "pull_request_review_request") {
    const parsed = pullRequestPayloadSchema.parse(payload);

    if (eventName === "pull_request_review_request" && parsed.action !== "review_requested") {
      return null;
    }

    return createPullRequestReviewEvent(provider, eventName, parsed, config);
  }

  if (eventName === "push") {
    return createPushReviewEvent(provider, eventName, pushPayloadSchema.parse(payload), config);
  }

  if (eventName === "issues") {
    return createIssueReviewEvent(provider, eventName, issuePayloadSchema.parse(payload), config);
  }

  if (eventName === "issue_comment") {
    return translateIssueCommentReviewCommand(provider, eventName, payload, config, fetchGiteaPullRequestDetails);
  }

  return null;
}
