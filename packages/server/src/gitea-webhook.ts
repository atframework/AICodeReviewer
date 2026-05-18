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
  readonly repoRef?: string;
  readonly repoMappings?: readonly RepositoryWorkspaceMapping[];
  readonly token?: string;
  readonly baseUrl?: string;
}

export interface RepositoryWorkspaceMapping {
  readonly match: string;
  readonly workspace: string;
}

const repositorySchema = z
  .object({
    full_name: z.string().min(1),
  })
  .passthrough();

const actorSchema = z
  .object({
    login: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
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

const pushPayloadSchema = z
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

const issueCommentPayloadSchema = z
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

const REVIEW_COMMAND_RE = /(?:^|\s)\/aicr\s+review(?:\s|$)/iu;
const REVIEW_COMMAND_SHORT_RE = /(?:^|\s)\/review(?:\s|$)/iu;

function containsReviewCommand(body: string): boolean {
  return REVIEW_COMMAND_RE.test(body) || REVIEW_COMMAND_SHORT_RE.test(body);
}

async function fetchPullRequestDetails(
  prApiUrl: string,
  token: string,
): Promise<{
  head?: { sha?: string; ref?: string };
  base?: { sha?: string; ref?: string };
  title?: string;
  html_url?: string;
  user?: z.infer<typeof actorSchema>;
  labels?: unknown[];
}> {
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
  return response.json() as Promise<{
    head?: { sha?: string; ref?: string };
    base?: { sha?: string; ref?: string };
    title?: string;
    html_url?: string;
    user?: z.infer<typeof actorSchema>;
    labels?: unknown[];
  }>;
}

function normalizeActor(actor: z.infer<typeof actorSchema> | undefined): ReviewActor {
  const raw = actor as Record<string, unknown> | undefined;
  return {
    username: actor?.login ?? actor?.username ?? (typeof raw?.name === "string" ? raw.name : undefined),
    email: actor?.email,
    displayName: actor?.full_name,
  };
}

function extractLabelNames(labels: unknown): string[] {
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

function collectPushChangedFiles(parsed: z.infer<typeof pushPayloadSchema>): string[] {
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

export function matchesWebhookRepo(config: GiteaWebhookConfig, repoRef: string): boolean {
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

function resolveWorkspaceIdForRepo(config: GiteaWebhookConfig, repoRef: string): string {
  const normalizedRepo = normalizeRepositoryRef(repoRef);
  const matched = config.repoMappings?.find((mapping) => {
    const normalizedMatch = normalizeRepositoryRef(mapping.match);
    return normalizedRepo === normalizedMatch || normalizedRepo.endsWith(`/${normalizedMatch}`);
  });

  return matched?.workspace ?? config.workspaceId;
}

function extractRefBranch(payload: Record<string, unknown>): string | undefined {
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

function extractPrBranch(pr: Record<string, unknown>): string | undefined {
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

export async function translateWebhookToReviewEvent(
  provider: ReviewProvider,
  eventName: string,
  payload: unknown,
  config: GiteaWebhookConfig,
): Promise<ReviewEvent | null> {
  if (eventName === "pull_request") {
    const parsed = pullRequestPayloadSchema.parse(payload);

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

  if (eventName === "push") {
    const parsed = pushPayloadSchema.parse(payload);
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

  if (eventName === "issues") {
    const parsed = issuePayloadSchema.parse(payload);
    const issueNumber = parsed.issue?.number;
    const issueUrl = parsed.issue?.html_url;
    const issueLabels = extractLabelNames(parsed.issue?.labels);

    return createReviewEvent({
      triggerName: config.triggerName,
      provider,
      workspaceId: resolveWorkspaceIdForRepo(config, parsed.repository.full_name),
      targetKind: "issue",
      repoRef: parsed.repository.full_name,
      author: normalizeActor(parsed.sender ?? parsed.issue?.user),
      title: parsed.issue?.title,
      url: issueUrl,
      reason: `${provider}:${parsed.action ?? "issues"}`,
      rawEventName: eventName,
      ...(issueNumber !== undefined ? { changedFiles: [String(issueNumber)] } : {}),
      ...(issueLabels.length > 0 ? { labels: issueLabels } : {}),
    });
  }

  if (eventName === "issue_comment") {
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
    let url = prInfo.html_url;
    let author = normalizeActor(parsed.comment?.user ?? parsed.sender);
    let branch: string | undefined;
    const prLabels = extractLabelNames(parsed.issue?.labels);

    if (config.token) {
      try {
        const prDetails = await fetchPullRequestDetails(prInfo.url, config.token);
        headSha = prDetails.head?.sha;
        baseSha = prDetails.base?.sha;
        title = prDetails.title ?? title;
        url = prDetails.html_url ?? url;
        author = normalizeActor(prDetails.user) ?? author;
        branch = prDetails.head?.ref;
      } catch {
        // 获取失败时使用已有信息
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