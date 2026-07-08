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

function extractInstallationId(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const installation = (payload as Record<string, unknown>).installation;
  if (!installation || typeof installation !== "object") {
    return undefined;
  }
  const id = (installation as Record<string, unknown>).id;
  if (typeof id === "number") {
    return id;
  }
  if (typeof id === "string" && id.length > 0) {
    const parsed = Number(id);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
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
    let effectiveConfig = config;
    if (!config.token && config.appTokenResolver) {
      const installationId = extractInstallationId(payload);
      if (installationId !== undefined) {
        try {
          const token = await config.appTokenResolver(installationId);
          effectiveConfig = { ...config, token };
        } catch {
          // Fall back to the webhook payload if App token resolution fails.
        }
      }
    }
    return translateIssueCommentReviewCommand(provider, eventName, payload, effectiveConfig, fetchGithubPullRequestDetails);
  }

  if (eventName === "installation" || eventName === "installation_repositories") {
    if (config.evictTokenCache) {
      const installationId = extractInstallationId(payload);
      config.evictTokenCache(installationId);
    }
    return null;
  }

  return null;
}
