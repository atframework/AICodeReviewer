/**
 * Auto-commit stream / member / source identity model.
 *
 * Contract: docs/ai/architecture.md §3.1.1 + docs/ai/decisions.md D35 (M15). All keys use versioned structured serialization (JSON
 * arrays with an explicit version slot) plus SHA-256 — never plain string
 * concatenation, so separators inside names, emails, or paths cannot collide
 * (test matrix I01). Values are compared exactly as the VCS reports them: no
 * lowercasing, alias folding, Unicode normalization, or arbitrary trimming;
 * only protocol envelopes are stripped by the VCS adapters themselves.
 *
 * - Stream id: workspaceId + triggerName + VCS kind + source namespace +
 *   scope ref + history generation. Different workspaces, triggers, repos,
 *   Git refs, P4 depot/stream/view scopes, or SVN roots never merge. History
 *   rewrites and path copies start a new generation.
 * - Member id: stream id + revision. The same revision inside one stream is
 *   exactly one logical member regardless of how many notifications cover it.
 * - Source key (grouping key): source namespace + the VCS grouping fields
 *   (git: raw author name+email; p4: changelist User+Client; svn: svn:author).
 *   Computed only when every required field is known; unavailable or
 *   conflicted fields block merging. Credentials never enter any key.
 */

import { createHash } from "node:crypto";

export type AutoCommitVcsKind = "git" | "p4" | "svn";

export function hashStructured(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export interface StreamKeyInput {
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly vcs: AutoCommitVcsKind;
  /** Canonical repository URL (git/svn) or canonical P4 server address. */
  readonly sourceNamespace: string;
  /** Git full ref, P4 depot/stream/view scope, or SVN monitored root. */
  readonly scopeRef: string;
  /** Bumped when history rewrite or path copy changes the source lineage. */
  readonly historyGeneration: number;
}

export function computeStreamId(input: StreamKeyInput): string {
  return hashStructured([
    "aicr-stream",
    1,
    input.workspaceId,
    input.triggerName,
    input.vcs,
    input.sourceNamespace,
    input.scopeRef,
    input.historyGeneration,
  ]);
}

export function computeMemberId(streamId: string, revision: string): string {
  return hashStructured(["aicr-member", 1, streamId, revision]);
}

export type SourceKeyFields =
  | { readonly vcs: "git"; readonly authorName: string; readonly authorEmail: string }
  | { readonly vcs: "p4"; readonly user: string; readonly client: string }
  | { readonly vcs: "svn"; readonly author: string };

export function computeSourceKey(sourceNamespace: string, fields: SourceKeyFields): string {
  switch (fields.vcs) {
    case "git":
      return hashStructured(["aicr-source", 1, sourceNamespace, "git", fields.authorName, fields.authorEmail]);
    case "p4":
      return hashStructured(["aicr-source", 1, sourceNamespace, "p4", fields.user, fields.client]);
    case "svn":
      return hashStructured(["aicr-source", 1, sourceNamespace, "svn", fields.author]);
  }
}

export type SourceFieldStatus = "known" | "unavailable" | "conflicted";

/**
 * Per-field observation evidence. `value` is the latest observation; a
 * conflicted field keeps the first-seen value in `previousValue` so both
 * observations survive (design §5.1.1).
 */
export interface SourceFieldEvidence {
  readonly status: SourceFieldStatus;
  readonly value?: string;
  readonly previousValue?: string;
}

/** Grouping/exclusion fields kept per VCS, mirroring the source evidence. */
export interface SourceSnapshotFields {
  readonly authorName?: SourceFieldEvidence;
  readonly authorEmail?: SourceFieldEvidence;
  readonly committerName?: SourceFieldEvidence;
  readonly committerEmail?: SourceFieldEvidence;
  readonly user?: SourceFieldEvidence;
  readonly client?: SourceFieldEvidence;
  readonly svnAuthor?: SourceFieldEvidence;
}

export interface SourceSnapshot {
  /** Verified range shape of the earliest covering notification; not identity. */
  readonly historyRewrite?: boolean;
  readonly historyBaseRevision?: string;
  readonly v: 1;
  readonly vcs: AutoCommitVcsKind;
  readonly sourceNamespace: string;
  readonly revision: string;
  readonly fields: SourceSnapshotFields;
  /** Provenance: the VCS command/protocol that produced this observation. */
  readonly command: string;
  readonly observedAt: number;
  /** Grouping/exclusion rules version active when the snapshot was verified. */
  readonly rulesVersion: string;
  /** Present only when every grouping field is known. */
  readonly sourceKey: string | null;
  /** Overall grouping status; unavailable/conflicted block merging. */
  readonly status: SourceFieldStatus;
}

/**
 * Derive the grouping source key from per-field evidence. Returns null when
 * any required field is not `known` — the caller must not fall back to a
 * degraded (e.g. User-only) key.
 */
export function deriveSourceKey(
  vcs: AutoCommitVcsKind,
  sourceNamespace: string,
  fields: SourceSnapshotFields,
): string | null {
  const known = (
    evidence: SourceFieldEvidence | undefined,
  ): evidence is SourceFieldEvidence & { readonly value: string } =>
    evidence?.status === "known" && evidence.value !== undefined;

  switch (vcs) {
    case "git": {
      if (!known(fields.authorName) || !known(fields.authorEmail)) return null;
      return computeSourceKey(sourceNamespace, {
        vcs: "git",
        authorName: fields.authorName.value,
        authorEmail: fields.authorEmail.value,
      });
    }
    case "p4": {
      if (!known(fields.user) || !known(fields.client)) return null;
      return computeSourceKey(sourceNamespace, {
        vcs: "p4",
        user: fields.user.value,
        client: fields.client.value,
      });
    }
    case "svn": {
      if (!known(fields.svnAuthor)) return null;
      return computeSourceKey(sourceNamespace, { vcs: "svn", author: fields.svnAuthor.value });
    }
  }
}

/** Member lifecycle (design §7.2). Terminal members never return to pending. */
export type CommitMemberStatus = "pending" | "batched" | "completed" | "skipped" | "failed" | "dead";

/** Batch lifecycle; retry_wait re-enters scheduling without re-grouping. */
export type CommitBatchStatus =
  | "dispatch_pending"
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "retry_wait"
  | "dead";

/** Why a stream/batch is not starting right now (observability, low-cardinality). */
export type SchedulingWaitReason =
  | "delay"
  | "window"
  | "global_concurrency"
  | "workspace_concurrency"
  | "retry_backoff"
  | "exclusion_metadata_unavailable"
  | "exclusion_scope_conflict"
  | "preparation_incomplete";

export interface CommitBatchMember {
  readonly memberId: string;
  readonly revision: string;
  readonly sourceKey: string;
}

export const AUTO_COMMIT_BATCH_LIMITS = {
  maxMembersPerBatch: 50,
  maxMetadataPageRecords: 256,
  maxMetadataPageBytes: 1024 * 1024,
  maxWorkspaceHeadsPerScan: 64,
} as const;
