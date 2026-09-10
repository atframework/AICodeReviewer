/**
 * Auto-commit scheduling store contract.
 *
 * Contract: docs/ai/architecture.md §3.1.1 + docs/ai/decisions.md D35 (M15). Scheduling truth lives in the configured `queue.kind` backend —
 * memory (this process only), SQLite (`queue.sqlite.path`), or Redis (AICR-own
 * keys; BullMQ stays responsible only for sealed execution jobs). Optional
 * observability/cache/object stores never hold unique pending members.
 *
 * The store executes *verified* atomic state transitions only. Source grouping,
 * exclusion decisions, continuity proofs, and VCS verification are computed by
 * the server-side scheduler; the backend guarantees:
 *
 * - Receipt acceptance is atomic and idempotent per delivery key: redelivery
 *   returns the original receipt without resetting `firstAcceptedAt`.
 * - A commit member exists at most once per stream; upserts on batched/terminal
 *   members only add idempotent receipt associations.
 * - Sealing is atomic: every member must still be pending and unassigned, the
 *   stream version and reservation token must match, and the batch row plus
 *   exactly one dispatch outbox entry are written in the same transaction.
 * - Batch completion/failure/renewal requires the current lease token; expired
 *   leases are reclaimed into the *same* batch (never re-grouped with new
 *   commits).
 *
 * All timestamps are UTC epoch milliseconds. `notBefore` values are raw
 * eligibility bounds; converting them through the weekly schedule is the
 * scheduler's job — the store never applies calendars.
 */

import type {
  AutoCommitVcsKind,
  CommitBatchMember,
  CommitBatchStatus,
  CommitMemberStatus,
  SchedulingWaitReason,
  SourceSnapshot,
} from "./auto-commit-identity.js";
import { deriveSourceKey } from "./auto-commit-identity.js";

export const AUTO_COMMIT_STORE_SCHEMA_VERSION = 4;

// ---------------------------------------------------------------------------
// Receipts and members
// ---------------------------------------------------------------------------

export type ReceiptCoverage =
  | { readonly kind: "range"; readonly base: string; readonly head: string }
  | { readonly kind: "single"; readonly revision: string };

export interface AcceptReceiptInput {
  /** Provider delivery id when available; otherwise a deterministic coverage key. */
  readonly deliveryKey: string;
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly provider: string;
  readonly vcs: AutoCommitVcsKind;
  readonly sourceNamespace: string;
  readonly scopeRef: string;
  readonly historyGeneration: number;
  readonly coverage: ReceiptCoverage;
  /** Minimal replayable event envelope (no credentials, no raw request body). */
  readonly envelope: unknown;
  /** Resolved first-receive delay at acceptance time (seconds). */
  readonly delaySeconds: number;
  /** Policy version resolved at acceptance time. */
  readonly policyVersion: string;
  readonly now: number;
}

export interface AutoCommitReceipt {
  readonly receiptId: string;
  /** Persistent acceptance order; defines assembly cuts. */
  readonly receiptSeq: number;
  readonly deliveryKey: string;
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly provider: string;
  readonly vcs: AutoCommitVcsKind;
  readonly sourceNamespace: string;
  readonly scopeRef: string;
  readonly historyGeneration: number;
  readonly coverage: ReceiptCoverage;
  readonly envelope: unknown;
  readonly firstAcceptedAt: number;
  readonly delaySeconds: number;
  readonly policyVersion: string;
  /**
   * Metadata expansion resume point: null when the coverage range has never
   * been paged or is fully expanded; a provider cursor while expansion is
   * split across ticks by the page budget. Persisted so a restart resumes
   * mid-range without re-reading or losing the tail (test N05/N08).
   */
  readonly metadataCursor: string | null;
  readonly metadataAttempts: number;
  readonly metadataNextAttemptAt: number | null;
  readonly metadataTerminalError: string | null;
}

export interface AcceptReceiptResult {
  readonly receipt: AutoCommitReceipt;
  /** True when the delivery key was already accepted (idempotent replay). */
  readonly duplicate: boolean;
}

export type MemberExclusionState =
  "undecided" | "allowed" | "excluded" | "unavailable";

export interface CommitMemberRecord {
  readonly memberId: string;
  readonly streamId: string;
  readonly revision: string;
  /**
   * Earliest covering notification (lowest receipt seq) — the receipt whose
   * firstAcceptedAt drives eligibility. Assembly uses it to detect
   * force-push isolation without re-reading VCS history.
   */
  readonly coverReceiptId: string;
  /** VCS ordering key once metadata is verified; null beforehand. */
  readonly orderKey: string | null;
  /**
   * Direct parent revisions (git); empty for linear p4/svn lineage. Assembly
   * needs this to isolate merge commits (own batch) without re-reading VCS
   * metadata after verification.
   */
  readonly parents: readonly string[];
  readonly status: CommitMemberStatus;
  readonly sourceSnapshot: SourceSnapshot | null;
  readonly exclusion: {
    readonly state: MemberExclusionState;
    readonly ruleId: string | null;
    readonly policyVersion: string | null;
  };
  /** firstAcceptedAt + resolved delay of the earliest covering notification. */
  readonly eligibleAt: number;
  readonly firstAcceptedAt: number;
  readonly batchId: string | null;
  /** Skip/dead reason for terminal diagnostics (e.g. excluded_source). */
  readonly terminalReason: string | null;
}

/**
 * One verified metadata observation for a covered member. `orderKey` orders
 * members within the stream by true VCS history (never by arrival, timestamps,
 * or receipt seq).
 */
export interface MemberMetadataUpsert {
  readonly revision: string;
  readonly orderKey: string;
  /** Direct parent revisions; empty for linear p4/svn lineage. */
  readonly parents: readonly string[];
  readonly sourceSnapshot: SourceSnapshot;
}

export interface ApplyMetadataPageInput {
  readonly streamId: string;
  /** Receipt whose coverage this page expands; association is idempotent. */
  readonly receiptId: string;
  readonly members: readonly MemberMetadataUpsert[];
  readonly now: number;
}

export interface ApplyMetadataPageResult {
  readonly created: number;
  readonly updated: number;
  /** Members that already existed with conflicting observations. */
  readonly conflicted: readonly string[];
}

// ---------------------------------------------------------------------------
// Scheduling heads
// ---------------------------------------------------------------------------

export interface StreamHead {
  readonly latestReceiptSeq: number;
  readonly assemblyCutSeq: number | null;
  readonly assemblyAt: number | null;
  /** Persisted scheduler backoff/calendar bound, preserved during head recomputation. */
  readonly resumeNotBefore: number | null;
  readonly streamId: string;
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly vcs: AutoCommitVcsKind;
  readonly sourceNamespace: string;
  readonly scopeRef: string;
  readonly historyGeneration: number;
  /** Earliest UTC ms at which this stream may become runnable (raw bound). */
  readonly notBefore: number | null;
  readonly activeBatchId: string | null;
  readonly reservationOwner: string | null;
  readonly reservationToken: string | null;
  readonly reservationExpiry: number | null;
  /** Receipt seq up to which coverage expansion completed. */
  readonly coverageCursor: number;
  /** CAS version; increments on every head mutation. */
  readonly version: number;
}

export interface WorkspaceHead {
  readonly workspaceId: string;
  /** Min runnable bound across streams; null when nothing is pending. */
  readonly notBefore: number | null;
  /** Monotonic fairness ticket; lowest ticket prepares first. */
  readonly fairnessSeq: number;
  readonly version: number;
}

export interface StreamHeadUpdate {
  readonly assemblyCutSeq?: number | null;
  readonly assemblyAt?: number | null;
  readonly resumeNotBefore?: number | null;
  readonly notBefore?: number | null;
  readonly coverageCursor?: number;
  readonly historyGeneration?: number;
}

// ---------------------------------------------------------------------------
// Assembly and sealing
// ---------------------------------------------------------------------------

export interface StreamReservation {
  readonly streamId: string;
  readonly token: string;
  readonly expiry: number;
  readonly version: number;
}

export interface SealBatchInput {
  readonly streamId: string;
  readonly reservationToken: string;
  readonly expectedStreamVersion: number;
  readonly batchId: string;
  readonly runId: string;
  /** Ordered members; every one must be pending, eligible, and unassigned. */
  readonly members: readonly CommitBatchMember[];
  readonly base: string;
  readonly head: string;
  readonly sourceKey: string;
  readonly exclusionPolicyVersion: string;
  readonly configPolicyVersion: string;
  readonly maxAttempts: number;
  readonly now: number;
}

export type SealBatchResult =
  | { readonly kind: "sealed" }
  | {
      readonly kind: "conflict";
      readonly reason:
        | "reservation_lost"
        | "stream_version_mismatch"
        | "member_unavailable"
        | "member_ineligible"
        | "active_batch";
      readonly memberId?: string;
    };

// ---------------------------------------------------------------------------
// Dispatch and execution leases
// ---------------------------------------------------------------------------

export interface CommitBatchRecord {
  readonly executionCheckpoint: BatchExecutionCheckpoint | null;
  readonly batchId: string;
  readonly runId: string;
  readonly streamId: string;
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly vcs: AutoCommitVcsKind;
  readonly sourceNamespace: string;
  readonly scopeRef: string;
  readonly historyGeneration: number;
  readonly sourceKey: string;
  readonly members: readonly CommitBatchMember[];
  readonly base: string;
  readonly head: string;
  readonly exclusionPolicyVersion: string;
  readonly configPolicyVersion: string;
  readonly status: CommitBatchStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryNotBefore: number | null;
  readonly leaseToken: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiry: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
}

export interface DispatchOutboxEntry {
  readonly batchId: string;
  readonly status: "pending" | "dispatched";
  readonly nextAttemptAt: number;
}

export interface BatchExecutionCheckpoint {
  readonly phase: "started" | "completed" | "publication_pending";
  readonly result?: unknown;
}

/** Claim one due outbox entry for dispatch into the execution queue. */
export interface ClaimedDispatch {
  readonly batch: CommitBatchRecord;
  readonly claimToken: string;
}

export type BatchCompletion =
  | { readonly outcome: "completed" }
  | { readonly outcome: "skipped"; readonly reason: string };

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface ReceiptQueryResult {
  readonly receipt: AutoCommitReceipt;
  readonly memberCounts: Readonly<Record<CommitMemberStatus, number>>;
}

export interface NextWake {
  /** Raw earliest bound across streams/outbox/leases, or null when idle. */
  readonly at: number;
  readonly reason: SchedulingWaitReason | "outbox_dispatch" | "lease_reclaim";
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface AutoCommitStore {
  readonly backendKind: string;

  acceptReceipt(input: AcceptReceiptInput): Promise<AcceptReceiptResult>;

  applyMetadataPage(
    input: ApplyMetadataPageInput,
  ): Promise<ApplyMetadataPageResult>;

  /**
   * Persist the receipt's metadata expansion resume point. Written after the
   * page's members (never before), so a crash between the two re-reads an
   * idempotent page instead of skipping it. `null` marks full expansion.
   */
  setReceiptMetadataCursor(
    receiptId: string,
    cursor: string | null,
    now: number,
  ): Promise<void>;

  /** Increment durable metadata attempts; null retryAt makes this failure terminal. */
  recordReceiptMetadataFailure(
    receiptId: string,
    error: string,
    retryAt: number | null,
    now: number,
  ): Promise<void>;

  /**
   * Record exclusion verdicts for a page of members and advance nothing else.
   * Excluded members transition pending → skipped with reason
   * `excluded_source` in the same atomic page write; they never receive a run,
   * job, or outbox entry.
   */
  applyExclusionVerdicts(input: {
    readonly streamId: string;
    readonly verdicts: readonly {
      readonly memberId: string;
      readonly state: MemberExclusionState;
      readonly ruleId?: string;
      readonly policyVersion: string;
    }[];
    readonly now: number;
  }): Promise<void>;

  /** Workspace heads runnable at `now` (raw bounds), in fairness order. */
  readRunnableWorkspaceHeads(
    now: number,
    limit: number,
  ): Promise<readonly WorkspaceHead[]>;

  /** Stream heads of a workspace ordered by runnable bound (nulls last). */
  readStreamHeads(
    workspaceId: string,
    limit: number,
  ): Promise<readonly StreamHead[]>;

  readStreamHead(streamId: string): Promise<StreamHead | undefined>;

  /** Pending members of a stream in metadata order (orderKey nulls first, seq order). */
  readPendingMembers(
    streamId: string,
    cursor: string | null,
    limit: number,
  ): Promise<Page<CommitMemberRecord>>;

  /** Direct bounded lookup, preserving requested order and omitting unknown ids. Maximum 512. */
  readMembers(
    memberIds: readonly string[],
  ): Promise<readonly CommitMemberRecord[]>;

  /** Receipts of a stream with seq in (fromSeq, toSeq], ascending — the assembly cut input. */
  readStreamReceipts(
    streamId: string,
    fromSeq: number,
    toSeq: number,
    limit: number,
  ): Promise<readonly AutoCommitReceipt[]>;

  /** Receipt ids associated with a member (paged; association is many-to-many). */
  readMemberReceipts(
    memberId: string,
    cursor: string | null,
    limit: number,
  ): Promise<Page<string>>;

  /** Members associated with a receipt (paged). */
  readReceiptMembers(
    receiptId: string,
    cursor: string | null,
    limit: number,
  ): Promise<Page<CommitMemberRecord>>;

  acquireStreamReservation(
    streamId: string,
    ownerId: string,
    ttlMs: number,
    now: number,
  ): Promise<StreamReservation | undefined>;

  renewStreamReservation(
    streamId: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean>;

  releaseStreamReservation(
    streamId: string,
    token: string,
    now: number,
  ): Promise<void>;

  updateStreamHead(
    streamId: string,
    expectedVersion: number,
    update: StreamHeadUpdate,
    now: number,
  ): Promise<boolean>;

  /** Advance the workspace fairness ticket after it consumed a prepare slot. */
  rotateWorkspaceFairness(workspaceId: string, now: number): Promise<void>;

  sealBatch(input: SealBatchInput): Promise<SealBatchResult>;

  /** Read due outbox entries and stamp dispatch claims atomically. */
  claimDispatch(
    now: number,
    ownerId: string,
    limit: number,
  ): Promise<readonly ClaimedDispatch[]>;

  /** Mark an outbox entry dispatched after the execution enqueue succeeded. */
  confirmDispatch(
    batchId: string,
    claimToken: string,
    now: number,
  ): Promise<void>;

  /** Re-open a pending outbox entry when the execution enqueue failed. */
  abortDispatch(
    batchId: string,
    claimToken: string,
    nextAttemptAt: number,
    now: number,
  ): Promise<void>;

  /** Lease the batch for execution after the consumer picked the job up. */
  startBatchExecution(
    batchId: string,
    ownerId: string,
    ttlMs: number,
    now: number,
    limits?: { readonly global: number; readonly workspace: number },
  ): Promise<string | undefined>;

  /** Requeue a queued batch without consuming an execution attempt; running batches are untouched. */
  deferBatchExecution(
    batchId: string,
    nextAttemptAt: number,
    now: number,
  ): Promise<void>;

  /** Durable side-effect checkpoint, maximum serialized size 1 MiB; fenced by the live execution lease. */
  checkpointBatchExecution(
    batchId: string,
    token: string,
    checkpoint: BatchExecutionCheckpoint,
    now: number,
  ): Promise<boolean>;

  renewBatchLease(
    batchId: string,
    token: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean>;

  completeBatch(
    batchId: string,
    token: string,
    completion: BatchCompletion,
    now: number,
  ): Promise<void>;

  failBatch(
    batchId: string,
    token: string,
    error: string,
    retryNotBefore: number | null,
    dead: boolean,
    now: number,
  ): Promise<void>;

  /** Reclaim batches whose lease expired; returns reclaimed batch ids. */
  reclaimExpiredBatchLeases(
    now: number,
    limit: number,
  ): Promise<readonly string[]>;

  readBatch(batchId: string): Promise<CommitBatchRecord | undefined>;

  getReceipt(receiptId: string): Promise<ReceiptQueryResult | undefined>;

  /** Raw earliest scheduling signal across heads, outbox, and leases. */
  readNextWake(): Promise<NextWake | undefined>;

  close?(): void;
}

export function computeMemberEligibility(
  firstAcceptedAt: number,
  delaySeconds: number,
): number {
  return firstAcceptedAt + delaySeconds * 1000;
}

/** Merge fresh evidence without downgrading known fields or clearing a conflict. */
export function mergeSourceEvidence(
  prior: SourceSnapshot,
  next: SourceSnapshot,
  preferNextRange = false,
): SourceSnapshot {
  const fields = { ...prior.fields };
  let conflict =
    prior.status === "conflicted" ||
    next.status === "conflicted" ||
    (prior.sourceKey !== null &&
      next.sourceKey !== null &&
      prior.sourceKey !== next.sourceKey);
  for (const key of [
    "authorName",
    "authorEmail",
    "committerName",
    "committerEmail",
    "user",
    "client",
    "svnAuthor",
  ] as const) {
    const a = prior.fields[key];
    const b = next.fields[key];
    if (a?.status === "conflicted") {
      conflict = true;
      continue;
    }
    if (a?.status === "known" && b?.status === "known" && a.value !== b.value) {
      fields[key] = {
        status: "conflicted",
        ...(b.value !== undefined ? { value: b.value } : {}),
        ...(a.value !== undefined ? { previousValue: a.value } : {}),
      };
      conflict = true;
    } else if (b?.status === "conflicted" || a?.status !== "known") {
      if (b) fields[key] = b;
      if (b?.status === "conflicted") conflict = true;
    }
  }
  const sourceKey = conflict
    ? null
    : deriveSourceKey(next.vcs, next.sourceNamespace, fields);
  const merged = {
    ...next,
    fields,
    sourceKey,
    status: conflict
      ? ("conflicted" as const)
      : sourceKey === null
        ? ("unavailable" as const)
        : ("known" as const),
  };
  // Range evidence belongs to the earliest covering receipt, independently
  // of which later observation completes the source fields.
  const range = preferNextRange ? next : prior;
  delete merged.historyRewrite;
  delete merged.historyBaseRevision;
  if (range.historyRewrite !== undefined)
    merged.historyRewrite = range.historyRewrite;
  if (range.historyBaseRevision !== undefined)
    merged.historyBaseRevision = range.historyBaseRevision;
  return merged;
}
