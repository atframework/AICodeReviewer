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

type GithubProvider = Extract<ReviewProvider, "github">;

async function fetchGithubPullRequestDetails(
  prApiUrl: string,
  token: string,
): Promise<PullRequestDetails> {
  const response = await fetch(prApiUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch PR details: ${response.status}`);
  }
  return response.json() as Promise<PullRequestDetails>;
}

export async function translateGithubWebhookToReviewEvent(
  provider: GithubProvider,
  eventName: string,
  payload: unknown,
  config: VcsWebhookConfig,
): Promise<ReviewEvent | null> {
  if (eventName === "pull_request") {
    return createPullRequestReviewEvent(provider, eventName, pullRequestPayloadSchema.parse(payload), config);
  }

  if (eventName === "push") {
    return createPushReviewEvent(provider, eventName, pushPayloadSchema.parse(payload), config);
  }

  if (eventName === "issues") {
    return createIssueReviewEvent(provider, eventName, issuePayloadSchema.parse(payload), config);
  }

  if (eventName === "issue_comment") {
    return translateIssueCommentReviewCommand(provider, eventName, payload, config, fetchGithubPullRequestDetails);
  }

  return null;
}
