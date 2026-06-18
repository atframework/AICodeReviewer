import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createReviewEvent,
  type ReviewActor,
  type ReviewEvent,
  type ReviewProvider,
} from "@aicr/core";
import { z } from "zod";

export interface VcsWebhookConfig {
  readonly triggerName: string;
  readonly workspaceId: string;
  readonly webhookSecret?: string;
  readonly repoRef?: string;
  readonly repoMappings?: readonly RepositoryWorkspaceMapping[];
  readonly token?: string;
  readonly baseUrl?: string;
}

export interface RepositoryWorkspaceMapping {
  readonly match: string;
  readonly workspace: string;
}

export const repositorySchema = z
  .object({
    full_name: z.string().min(1),
  })
  .passthrough();

export const actorSchema = z
  .object({
    login: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    full_name: z.string().min(1).optional(),
  })
  .passthrough();

export const pullRequestPayloadSchema = z
  .object({
    action: z.string().min(1).optional(),
    repository: repositorySchema,
    sender: actorSchema.optional(),
    pull_request: z
      .object({
        title: z.string().min(1).optional(),
        html_url: z.string().url().optional(),
        user: actorSchema.optional(),
        base: z.object({ sha: z.string().min(1).optional() }).passthrough(),
        head: z.object({ sha: z.string().min(1).optional() }).passthrough(),
        labels: z
          .array(
            z.object({ name: z.string().min(1).optional() }).passthrough(),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const pushPayloadSchema = z
  .object({
    before: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
    compare_url: z.string().url().optional(),
    repository: repositorySchema,
    pusher: actorSchema.optional(),
    commits: z
      .array(
        z
          .object({
            added: z.array(z.string()).optional(),
            modified: z.array(z.string()).optional(),
            removed: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .optional(),
    head_commit: z
      .object({
        added: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const issuePayloadSchema = z
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

export const issueCommentPayloadSchema = z
  .object({
    action: z.string().min(1).optional(),
    repository: repositorySchema,
    sender: actorSchema.optional(),
    issue: z
      .object({
        number: z.number().int().positive(),
        title: z.string().min(1).optional(),
        pull_request: z
          .object({
            url: z.string().url(),
            html_url: z.string().url().optional(),
          })
          .optional(),
        user: actorSchema.optional(),
        labels: z
          .array(
            z.object({ name: z.string().min(1).optional() }).passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    comment: z
      .object({
        body: z.string(),
        user: actorSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ActorPayload = z.infer<typeof actorSchema>;
export type PullRequestPayload = z.infer<typeof pullRequestPayloadSchema>;
export type PushPayload = z.infer<typeof pushPayloadSchema>;
export type IssuePayload = z.infer<typeof issuePayloadSchema>;

export interface PullRequestDetails {
  readonly head?: { readonly sha?: string; readonly ref?: string };
  readonly base?: { readonly sha?: string; readonly ref?: string };
  readonly title?: string;
  readonly html_url?: string;
  readonly user?: ActorPayload;
  readonly labels?: unknown[];
}

export type PullRequestDetailsFetcher = (
  prApiUrl: string,
  token: string,
) => Promise<PullRequestDetails>;

const REVIEW_COMMAND_RE = /(?:^|\s)\/aicr\s+review(?:\s|$)/iu;
const REVIEW_COMMAND_SHORT_RE = /(?:^|\s)\/review(?:\s|$)/iu;

export function containsReviewCommand(body: string): boolean {
  return REVIEW_COMMAND_RE.test(body) || REVIEW_COMMAND_SHORT_RE.test(body);
}

export function normalizeActor(actor: ActorPayload | undefined): ReviewActor {
  const raw = actor as Record<string, unknown> | undefined;
  return {
    username: actor?.login ?? actor?.username ?? (typeof raw?.name === "string" ? raw.name : undefined),
    email: actor?.email,
    displayName: actor?.full_name,
  };
}

export function extractLabelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  const names: string[] = [];
  for (const label of labels) {
    if (label && typeof label === "object") {
      const name = (label as Record<string, unknown>).name ?? (label as Record<string, unknown>).title;
      if (typeof name === "string" && name.length > 0) {
        names.push(name);
      }
    }
  }
  return names;
}

export function collectPushChangedFiles(parsed: PushPayload): string[] {
  const files = new Set<string>();
  for (const commit of parsed.commits ?? []) {
    for (const file of [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])]) {
      files.add(file);
    }
  }

  if (parsed.head_commit) {
    for (const file of [
      ...(parsed.head_commit.added ?? []),
      ...(parsed.head_commit.modified ?? []),
      ...(parsed.head_commit.removed ?? []),
    ]) {
      files.add(file);
    }
  }

  return [...files];
}

function normalizeRepositoryRef(repoRef: string): string {
  return repoRef.trim().replace(/^\/+|\/+$/gu, "").toLowerCase();
}

export function matchesWebhookRepo(config: VcsWebhookConfig, repoRef: string): boolean {
  const normalizedRepo = normalizeRepositoryRef(repoRef);
  if (!normalizedRepo) {
    return false;
  }

  if (config.repoRef) {
    const normalizedConfigRepo = normalizeRepositoryRef(config.repoRef);
    if (normalizedRepo === normalizedConfigRepo) {
      return true;
    }
  }

  return config.repoMappings?.some((mapping) => {
    const normalizedMatch = normalizeRepositoryRef(mapping.match);
    return normalizedRepo === normalizedMatch || normalizedRepo.endsWith(`/${normalizedMatch}`);
  }) ?? false;
}

export function resolveWorkspaceIdForRepo(config: VcsWebhookConfig, repoRef: string): string {
  const normalizedRepo = normalizeRepositoryRef(repoRef);
  const matched = config.repoMappings?.find((mapping) => {
    const normalizedMatch = normalizeRepositoryRef(mapping.match);
    return normalizedRepo === normalizedMatch || normalizedRepo.endsWith(`/${normalizedMatch}`);
  });

  return matched?.workspace ?? config.workspaceId;
}

export function extractRefBranch(payload: Record<string, unknown>): string | undefined {
  const ref = payload.ref as string | undefined;
  if (!ref) {
    return undefined;
  }

  const prefix = "refs/heads/";
  if (ref.startsWith(prefix)) {
    return ref.slice(prefix.length);
  }

  return ref;
}

export function extractPrBranch(pr: Record<string, unknown>): string | undefined {
  const head = pr.head as Record<string, unknown> | undefined;
  if (!head) {
    return undefined;
  }

  const ref = head.ref as string | undefined;
  if (ref) {
    return ref;
  }

  const label = head.label as string | undefined;
  if (label) {
    return label.split(":").at(-1);
  }

  return undefined;
}

export function extractWebhookRepositoryRef(
  provider: ReviewProvider,
  payload: unknown,
): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const rawPayload = payload as Record<string, unknown>;

  if (provider === "gitea" || provider === "forgejo" || provider === "github") {
    const repository = rawPayload.repository;
    if (repository && typeof repository === "object") {
      const fullName = (repository as Record<string, unknown>).full_name;
      return typeof fullName === "string" && fullName.length > 0 ? fullName : undefined;
    }
    return undefined;
  }

  if (provider === "gitlab") {
    const project = rawPayload.project;
    if (project && typeof project === "object") {
      const pathWithNamespace = (project as Record<string, unknown>).path_with_namespace;
      if (typeof pathWithNamespace === "string" && pathWithNamespace.length > 0) {
        return pathWithNamespace;
      }
    }

    const repository = rawPayload.repository;
    if (repository && typeof repository === "object") {
      const fullName = (repository as Record<string, unknown>).full_name;
      return typeof fullName === "string" && fullName.length > 0 ? fullName : undefined;
    }
  }

  return undefined;
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

export function createPullRequestReviewEvent(
  provider: ReviewProvider,
  eventName: string,
  parsed: PullRequestPayload,
  config: VcsWebhookConfig,
): ReviewEvent {
  const prLabels = extractLabelNames(parsed.pull_request.labels);

  return createReviewEvent({
    triggerName: config.triggerName,
    provider,
    workspaceId: resolveWorkspaceIdForRepo(config, parsed.repository.full_name),
    targetKind: "pull_request",
    repoRef: parsed.repository.full_name,
    baseSha: parsed.pull_request.base.sha,
    headSha: parsed.pull_request.head.sha,
    author: normalizeActor(parsed.sender ?? parsed.pull_request.user),
    title: parsed.pull_request.title,
    url: parsed.pull_request.html_url,
    reason: `${provider}:${parsed.action ?? "pull_request"}`,
    rawEventName: eventName,
    ...(prLabels.length > 0 ? { labels: prLabels } : {}),
    branch: extractPrBranch(parsed.pull_request),
  });
}

const ZERO_SHA_PATTERN = /^0+$/u;

function isBranchCreateOrDeletePush(parsed: PushPayload): boolean {
  // GitHub/Gitea send an all-zero SHA (40 or 64 zeros) for `before` on branch
  // creation and for `after` on branch deletion. Neither has a reviewable
  // commit range (`git diff` rejects a `..<all-zeros>` range with "Invalid
  // revision range"), so these events must be skipped instead of failing the
  // trigger with review_orchestration_failed.
  return (typeof parsed.before === "string" && ZERO_SHA_PATTERN.test(parsed.before))
    || (typeof parsed.after === "string" && ZERO_SHA_PATTERN.test(parsed.after));
}

export function createPushReviewEvent(
  provider: ReviewProvider,
  eventName: string,
  parsed: PushPayload,
  config: VcsWebhookConfig,
): ReviewEvent | null {
  if (isBranchCreateOrDeletePush(parsed)) {
    return null;
  }

  const changedFiles = collectPushChangedFiles(parsed);

  return createReviewEvent({
    triggerName: config.triggerName,
    provider,
    workspaceId: resolveWorkspaceIdForRepo(config, parsed.repository.full_name),
    targetKind: "push",
    repoRef: parsed.repository.full_name,
    baseSha: parsed.before,
    headSha: parsed.after,
    author: normalizeActor(parsed.pusher),
    url: parsed.compare_url,
    reason: `${provider}:push`,
    rawEventName: eventName,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    branch: extractRefBranch(parsed as Record<string, unknown>),
  });
}

export function createIssueReviewEvent(
  provider: ReviewProvider,
  eventName: string,
  parsed: IssuePayload,
  config: VcsWebhookConfig,
): ReviewEvent {
  const issueNumber = parsed.issue?.number;
  const issueLabels = extractLabelNames(parsed.issue?.labels);

  return createReviewEvent({
    triggerName: config.triggerName,
    provider,
    workspaceId: resolveWorkspaceIdForRepo(config, parsed.repository.full_name),
    targetKind: "issue",
    repoRef: parsed.repository.full_name,
    author: normalizeActor(parsed.sender ?? parsed.issue?.user),
    title: parsed.issue?.title,
    url: parsed.issue?.html_url,
    reason: `${provider}:${parsed.action ?? "issues"}`,
    rawEventName: eventName,
    ...(issueNumber !== undefined ? { changedFiles: [String(issueNumber)] } : {}),
    ...(issueLabels.length > 0 ? { labels: issueLabels } : {}),
  });
}

export async function translateIssueCommentReviewCommand(
  provider: ReviewProvider,
  eventName: string,
  payload: unknown,
  config: VcsWebhookConfig,
  fetchPullRequestDetails?: PullRequestDetailsFetcher,
): Promise<ReviewEvent | null> {
  const parsed = issueCommentPayloadSchema.parse(payload);
  const commentBody = parsed.comment?.body ?? "";

  if (!containsReviewCommand(commentBody)) {
    return null;
  }

  const prInfo = parsed.issue?.pull_request;
  if (!prInfo) {
    return null;
  }

  let headSha: string | undefined;
  let baseSha: string | undefined;
  let title = parsed.issue?.title;
  let url = prInfo.html_url ?? prInfo.url;
  let author = normalizeActor(parsed.comment?.user ?? parsed.sender);
  let branch: string | undefined;
  const prLabels = extractLabelNames(parsed.issue?.labels);

  if (config.token && fetchPullRequestDetails) {
    try {
      const prDetails = await fetchPullRequestDetails(prInfo.url, config.token);
      headSha = prDetails.head?.sha;
      baseSha = prDetails.base?.sha;
      title = prDetails.title ?? title;
      url = prDetails.html_url ?? url;
      if (prDetails.user) {
        author = normalizeActor(prDetails.user);
      }
      branch = prDetails.head?.ref;
    } catch {
      // Use the already-delivered webhook payload if enrichment fails.
    }
  }

  return createReviewEvent({
    triggerName: config.triggerName,
    provider,
    workspaceId: resolveWorkspaceIdForRepo(config, parsed.repository.full_name),
    targetKind: "pull_request",
    repoRef: parsed.repository.full_name,
    ...(baseSha ? { baseSha } : {}),
    ...(headSha ? { headSha } : {}),
    author,
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    reason: `${provider}:comment_review`,
    rawEventName: eventName,
    ...(prLabels.length > 0 ? { labels: prLabels } : {}),
    ...(branch ? { branch } : {}),
  });
}
