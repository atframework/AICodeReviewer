/**
 * Authenticated webhook source descriptors (spec §5.2, P1b).
 *
 * Extraction runs AFTER signature/credential verification and reads only the
 * verified payload plus the configured trigger profile. Fields a provider
 * cannot prove stay null — metadata fetched later (P4 describe, svn info)
 * belongs to the background-resolution slice and is never guessed here.
 */

import {
  triggerKindToVcs,
  type WorkspaceResolutionEventContext,
  type WorkspaceSourceValues,
} from "@aicr/core";

export interface WebhookSourceDescriptor {
  readonly source: WorkspaceSourceValues;
  readonly event?: WorkspaceResolutionEventContext | undefined;
}

type PayloadRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): PayloadRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PayloadRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** JSON numbers outside the safe integer range have already lost their identity. */
function decimalId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? value : null;
}

function githubFields(payload: PayloadRecord, provider: string): WorkspaceResolutionEventContext {
  const repo = asRecord(payload.repository);
  const pr = asRecord(payload.pull_request);
  const issue = asRecord(payload.issue);
  return {
    default_branch: asString(repo?.default_branch) ?? null,
    provider_fields: {
      repository_id: decimalId(repo?.id),
      pull_number: decimalId(pr?.number ?? (issue?.pull_request ? issue.number : undefined)),
      issue_number: decimalId(issue?.number),
      ...(provider === "github" ? { installation_id: decimalId(asRecord(payload.installation)?.id) } : {}),
    },
  };
}

function gitlabFields(payload: PayloadRecord): WorkspaceResolutionEventContext {
  const attrs = asRecord(payload.object_attributes);
  const mr = asRecord(payload.merge_request) ?? (payload.object_kind === "merge_request" ? attrs : undefined);
  const issue = asRecord(payload.issue) ?? (payload.object_kind === "issue" ? attrs : undefined);
  return {
    default_branch: asString(asRecord(payload.project)?.default_branch) ?? null,
    provider_fields: {
      project_id: decimalId(asRecord(payload.project)?.id),
      source_project_id: decimalId(mr?.source_project_id),
      target_project_id: decimalId(mr?.target_project_id),
      merge_request_iid: decimalId(mr?.iid),
      issue_iid: decimalId(issue?.iid),
    },
  };
}

const BRANCH_REF_PREFIX = "refs/heads/";

/** Push branch from a git ref; null for tags/notes/detached refs (V05). */
export function branchFromGitRef(ref: string | undefined): string | null {
  if (ref === undefined) {
    return null;
  }
  return ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) || null : null;
}

function describeGithubLike(payload: PayloadRecord): WebhookSourceDescriptor | undefined {
  const repository = asRecord(payload.repository);
  const repoRef = asString(repository?.full_name);
  if (repoRef === undefined) {
    return undefined;
  }

  const pullRequest = asRecord(payload.pull_request);
  if (pullRequest !== undefined) {
    const head = asRecord(pullRequest.head);
    const base = asRecord(pullRequest.base);
    const headBranch = asString(head?.ref) ?? null;
    // V02: identity stays with the TARGET repository (repoRef above); the
    // fork's head repository is exposed as separate evidence, never merged
    // into the source identity. Same-repo PRs keep the head fields null.
    const headRepo = asRecord(head?.repo);
    const headRepoFullName = asString(headRepo?.full_name);
    const isFork = headRepoFullName !== undefined && headRepoFullName !== repoRef;
    const headOwner = isFork ? asString(asRecord(headRepo?.owner)?.login) ?? null : null;
    return {
      source: { vcs: "git", repo_ref: repoRef, branch: headBranch, ref: null },
      event: {
        base_branch: asString(base?.ref) ?? null,
        head_branch: headBranch,
        head_repository: isFork ? headRepoFullName! : null,
        head_owner: headOwner,
      },
    };
  }

  const ref = asString(payload.ref);
  if (ref !== undefined) {
    return {
      source: { vcs: "git", repo_ref: repoRef, branch: payload.deleted === true || /^0+$/u.test(String(payload.after)) ? null : branchFromGitRef(ref), ref },
    };
  }

  // Issues/comments and other repository-scoped events carry no branch.
  return { source: { vcs: "git", repo_ref: repoRef, branch: null, ref: null } };
}

function describeGitlab(payload: PayloadRecord): WebhookSourceDescriptor | undefined {
  const project = asRecord(payload.project);
  const repository = asRecord(payload.repository);
  const repoRef = asString(project?.path_with_namespace) ?? asString(repository?.full_name);
  if (repoRef === undefined) {
    return undefined;
  }

  const attributes = asRecord(payload.object_attributes);
  const mrFromNote = asRecord(payload.merge_request);
  const sourceBranch = asString(attributes?.source_branch) ?? asString(mrFromNote?.source_branch);
  const targetBranch = asString(attributes?.target_branch) ?? asString(mrFromNote?.target_branch);
  if (sourceBranch !== undefined || targetBranch !== undefined) {
    return {
      source: { vcs: "git", repo_ref: repoRef, branch: sourceBranch ?? null, ref: null },
      event: { base_branch: targetBranch ?? null, head_branch: sourceBranch ?? null },
    };
  }

  const ref = asString(payload.ref);
  if (ref !== undefined) {
    return {
      source: { vcs: "git", repo_ref: repoRef, branch: /^0+$/u.test(String(payload.after)) ? null : branchFromGitRef(ref), ref },
    };
  }

  return { source: { vcs: "git", repo_ref: repoRef, branch: null, ref: null } };
}

/**
 * Extracts the match-relevant source values from an authenticated payload.
 * Returns undefined when the payload carries no repository context (e.g.
 * GitHub installation events) — callers keep their legacy handling for
 * those. P4/SVN stay undefined in this slice: their descriptors require
 * command-verified metadata (spec §5.2 background resolution).
 */
export function describeWebhookSource(
  provider: string,
  payload: unknown,
): WebhookSourceDescriptor | undefined {
  const record = asRecord(payload);
  if (record === undefined || triggerKindToVcs(provider) !== "git") {
    return undefined;
  }
  const descriptor = provider === "gitlab" ? describeGitlab(record) : describeGithubLike(record);
  if (!descriptor) return undefined;
  return { ...descriptor, event: { ...descriptor.event,
    ...(provider === "gitlab" ? gitlabFields(record) : githubFields(record, provider)) } };
}
