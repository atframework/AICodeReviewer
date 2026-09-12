import type { ReviewEvent } from "@aicr/core";

export interface ChangeRange {
  readonly baseRevision?: string;
  readonly headRevision?: string;
  readonly files: readonly string[];
}

export interface WorkspaceRef {
  readonly id: string;
  readonly sourceDir: string;
}

export interface ScopedTree {
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly fetchedFiles: readonly string[];
}

export interface ExtraContextRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly revision?: string;
  readonly reason: string;
}

export interface ExtraContextResult {
  readonly path: string;
  readonly content: string;
}

export interface AttributionRequest {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly revision?: string;
  readonly reason: string;
}

export interface AttributionEntry {
  readonly line: number;
  readonly revision?: string;
  readonly author?: string;
  readonly authorEmail?: string;
  readonly summary?: string;
}


/**
 * Bounded commit-history metadata read (design §6.1). Separate from
 * `listChanges`, which answers "which files changed in a range" — this page
 * answers "which commits exist, in which true VCS order, with which recorded
 * source fields". Webhook payload commit arrays are never treated as a
 * complete directory: providers truncate them (GitHub 2048, GitLab 20).
 */
export interface CommitMetadataQuery {
  /** Stream scope: git full ref, P4 depot/stream scope, SVN monitored root URL. */
  readonly scopeRef: string;
  /** Verified lower endpoint (exclusive); the page walks from here toward head. */
  readonly baseRevision?: string;
  /** Fixed upper endpoint; never resolved against a moving ref server-side. */
  readonly headRevision: string;
  /** Opaque continuation token from the previous page. */
  readonly cursor?: string;
  /** Hard caps; callers pass at most 256 records / 1 MiB. */
  readonly maxRecords: number;
  readonly maxBytes: number;
}

/**
 * One commit observation. Fields are the raw VCS-recorded values — git raw
 * `%an/%ae/%cn/%ce` (never mailmap-rewritten `%aN` variants), P4 changelist
 * User/Client, SVN `svn:author`. `undefined` means the field was unavailable
 * in this observation; adapters never substitute service accounts, pusher
 * identities, or platform display names.
 */
export interface CommitMetadataRecord {
  readonly revision: string;
  /** Git range evidence, computed before pagination/filtering. Omitted means unknown. */
  readonly historyRewrite?: boolean;
  /** Lexicographically sortable key ordering records by true VCS history. */
  readonly orderKey: string;
  /** Direct parent revisions (git); empty for p4/svn lineage models. */
  readonly parents: readonly string[];
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly committerName?: string;
  readonly committerEmail?: string;
  readonly p4User?: string;
  readonly p4Client?: string;
  readonly svnAuthor?: string;
  /** Bounded changed-path summary (may be truncated by the byte budget). */
  readonly changedPaths: readonly string[];
}

export interface CommitMetadataPage {
  readonly vcs: "git" | "p4" | "svn";
  /** Whether the original Git base is outside the head's first-parent lineage. */
  readonly historyRewrite?: boolean;
  readonly records: readonly CommitMetadataRecord[];
  readonly nextCursor?: string;
  /**
   * `complete`: the page provably covers the query range. `partial`: more
   * pages follow via nextCursor. `unavailable`: the range could not be read
   * (missing endpoints, permission-hidden history, shallow exhaustion) —
   * callers must not treat this as an empty range.
   */
  readonly status: "complete" | "partial" | "unavailable";
  readonly unavailableReason?: string;
}
export type AttributionStatus = "ok" | "not_found" | "partial";

export interface AttributionResult {
  readonly path: string;
  readonly status: AttributionStatus;
  readonly entries: readonly AttributionEntry[];
}

export interface VcsAdapter {
  readonly kind: "git" | "svn" | "p4" | "github" | "gitlab" | "gitea" | "forgejo";
  listChanges(ev: ReviewEvent): Promise<ChangeRange>;
  /**
   * Bounded history read for auto-commit scheduling. Optional: adapters
   * without it cannot serve the automatic commit path (manual/PR flows are
   * unaffected).
   */
  listCommitMetadataPage?(query: CommitMetadataQuery): Promise<CommitMetadataPage>;
  /**
   * Best-effort commit time for one revision, normalized to an ISO-8601 UTC
   * string: git committer date (`%cI`), SVN `svn:date`, P4 changelist `time`.
   * Advisory by contract: implementations return `undefined` when the
   * revision or its timestamp is unreadable instead of throwing, so callers
   * can stamp observability records without risking the review itself.
   */
  fetchRevisionCommittedAt?(revision: string): Promise<string | undefined>;
  fetchScoped(range: ChangeRange, ws: WorkspaceRef): Promise<ScopedTree>;
  fetchExtraContext(req: ExtraContextRequest, ws: WorkspaceRef): Promise<ExtraContextResult>;
  fetchAttribution?(req: AttributionRequest, ws: WorkspaceRef): Promise<AttributionResult>;
}
