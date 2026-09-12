/**
 * SQLite AutoCommitStore — durable scheduling truth on local disk.
 *
 * Mirrors the memory reference implementation (memory-auto-commit-store.ts)
 * transition-for-transition; every mutating operation runs inside a
 * better-sqlite3 transaction (BEGIN IMMEDIATE) so the verified state
 * transitions stay atomic across crashes and concurrent processes. Read
 * paths are index-backed; stream/workspace `notBefore` bounds are recomputed
 * from receipts, pending members, and the active batch inside the same
 * transaction instead of being incrementally maintained.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  computeMemberId,
  computeStreamId,
  type CommitBatchMember,
  type SourceSnapshot,
} from "./auto-commit-identity.js";
import type {
  AcceptReceiptInput,
  AcceptReceiptResult,
  AcceptRoutingReceiptInput,
  AcceptRoutingReceiptResult,
  FrozenScopeResolution,
  ApplyMetadataPageInput,
  ApplyMetadataPageResult,
  AutoCommitReceipt,
  AutoCommitStore,
  BatchCompletion,
  BatchExecutionCheckpoint,
  ClaimedDispatch,
  CommitBatchRecord,
  CommitMemberRecord,
  MemberExclusionState,
  NextWake,
  Page,
  ReceiptCoverage,
  ReceiptQueryResult,
  RoutingReceiptRecord,
  SealBatchInput,
  SealBatchResult,
  StreamHead,
  StreamHeadUpdate,
  StreamReservation,
  WorkspaceHead,
} from "./auto-commit-store.js";
import {
  AUTO_COMMIT_STORE_SCHEMA_VERSION,
  computeMemberEligibility,
  mergeSourceEvidence,
} from "./auto-commit-store.js";

export interface SqliteAutoCommitStoreOptions {
  readonly path: string;
}

const DISPATCH_CLAIM_TTL_MS = 30_000;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS auto_commit_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auto_commit_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auto_commit_receipts (
    receipt_id TEXT PRIMARY KEY,
    receipt_seq INTEGER NOT NULL UNIQUE,
    delivery_key TEXT NOT NULL UNIQUE,
    stream_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    trigger_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    vcs TEXT NOT NULL,
    source_namespace TEXT NOT NULL,
    scope_ref TEXT NOT NULL,
    history_generation INTEGER NOT NULL,
    coverage TEXT NOT NULL,
    envelope TEXT NOT NULL,
    first_accepted_at INTEGER NOT NULL,
    delay_seconds INTEGER NOT NULL,
    policy_version TEXT NOT NULL,
    metadata_cursor TEXT,
    metadata_attempts INTEGER NOT NULL DEFAULT 0,
    metadata_next_attempt_at INTEGER,
    metadata_terminal_error TEXT,
    resolution TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auto_commit_receipts_stream
    ON auto_commit_receipts(stream_id, receipt_seq);

  CREATE TABLE IF NOT EXISTS auto_commit_routing_receipts (
    routing_id TEXT PRIMARY KEY,
    routing_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    trigger_name TEXT NOT NULL,
    envelope TEXT NOT NULL,
    parent_delivery_id TEXT,
    first_accepted_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    terminal_error TEXT,
    converted_receipt_ids TEXT NOT NULL DEFAULT '[]',
    completed_at INTEGER,
    note TEXT,
    resolution TEXT
  );

  CREATE TABLE IF NOT EXISTS auto_commit_members (
    member_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    order_key TEXT,
    parents TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    source_snapshot TEXT,
    exclusion_state TEXT NOT NULL,
    exclusion_rule_id TEXT,
    exclusion_policy_version TEXT,
    eligible_at INTEGER NOT NULL,
    first_accepted_at INTEGER NOT NULL,
    batch_id TEXT,
    terminal_reason TEXT,
    cover_seq INTEGER NOT NULL,
    cover_receipt_id TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_auto_commit_members_stream
    ON auto_commit_members(stream_id, status, order_key, member_id);
  CREATE INDEX IF NOT EXISTS idx_auto_commit_members_batch
    ON auto_commit_members(batch_id);

  CREATE TABLE IF NOT EXISTS auto_commit_receipt_members (
    receipt_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY (receipt_id, member_id)
  );
  CREATE INDEX IF NOT EXISTS idx_auto_commit_receipt_members_member
    ON auto_commit_receipt_members(member_id, receipt_id);

  CREATE TABLE IF NOT EXISTS auto_commit_stream_heads (
    stream_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    trigger_name TEXT NOT NULL,
    vcs TEXT NOT NULL,
    source_namespace TEXT NOT NULL,
    scope_ref TEXT NOT NULL,
    history_generation INTEGER NOT NULL,
    not_before INTEGER,
    active_batch_id TEXT,
    reservation_owner TEXT,
    reservation_token TEXT,
    reservation_expiry INTEGER,
    coverage_cursor INTEGER NOT NULL,
    latest_receipt_seq INTEGER NOT NULL DEFAULT 0,
    assembly_cut_seq INTEGER,
    assembly_at INTEGER,
    resume_not_before INTEGER,
    version INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auto_commit_stream_heads_workspace
    ON auto_commit_stream_heads(workspace_id);

  CREATE TABLE IF NOT EXISTS auto_commit_workspace_heads (
    workspace_id TEXT PRIMARY KEY,
    not_before INTEGER,
    fairness_seq INTEGER NOT NULL,
    version INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auto_commit_workspace_heads_not_before
    ON auto_commit_workspace_heads(not_before);

  CREATE TABLE IF NOT EXISTS auto_commit_batches (
    batch_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    trigger_name TEXT NOT NULL,
    vcs TEXT NOT NULL,
    source_namespace TEXT NOT NULL,
    scope_ref TEXT NOT NULL,
    history_generation INTEGER NOT NULL,
    source_key TEXT NOT NULL,
    members TEXT NOT NULL,
    base TEXT NOT NULL,
    head TEXT NOT NULL,
    exclusion_policy_version TEXT NOT NULL,
    config_policy_version TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    retry_not_before INTEGER,
    lease_token TEXT,
    lease_owner TEXT,
    lease_expiry INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    execution_checkpoint TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auto_commit_batches_lease
    ON auto_commit_batches(status, lease_expiry) WHERE status = 'running';

  CREATE TABLE IF NOT EXISTS auto_commit_outbox (
    batch_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    claim_token TEXT,
    claim_expiry INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_auto_commit_outbox_due
    ON auto_commit_outbox(status, next_attempt_at);
`;

interface ReceiptRow {
  receipt_id: string;
  receipt_seq: number;
  delivery_key: string;
  stream_id: string;
  workspace_id: string;
  trigger_name: string;
  provider: string;
  vcs: string;
  source_namespace: string;
  scope_ref: string;
  history_generation: number;
  coverage: string;
  envelope: string;
  first_accepted_at: number;
  delay_seconds: number;
  policy_version: string;
  metadata_cursor: string | null;
  metadata_attempts: number;
  metadata_next_attempt_at: number | null;
  metadata_terminal_error: string | null;
  resolution: string | null;
}

interface RoutingReceiptRow {
  routing_id: string;
  routing_key: string;
  provider: string;
  trigger_name: string;
  envelope: string;
  parent_delivery_id: string | null;
  first_accepted_at: number;
  attempts: number;
  next_attempt_at: number | null;
  terminal_error: string | null;
  converted_receipt_ids: string;
  completed_at: number | null;
  note: string | null;
  resolution: string | null;
}

interface MemberRow {
  member_id: string;
  stream_id: string;
  revision: string;
  order_key: string | null;
  parents: string;
  status: string;
  source_snapshot: string | null;
  exclusion_state: string;
  exclusion_rule_id: string | null;
  exclusion_policy_version: string | null;
  eligible_at: number;
  first_accepted_at: number;
  batch_id: string | null;
  terminal_reason: string | null;
  cover_seq: number;
  cover_receipt_id: string;
}

interface StreamHeadRow {
  stream_id: string;
  workspace_id: string;
  trigger_name: string;
  vcs: string;
  source_namespace: string;
  scope_ref: string;
  history_generation: number;
  not_before: number | null;
  active_batch_id: string | null;
  reservation_owner: string | null;
  reservation_token: string | null;
  reservation_expiry: number | null;
  coverage_cursor: number;
  latest_receipt_seq: number;
  assembly_cut_seq: number | null;
  assembly_at: number | null;
  resume_not_before: number | null;
  version: number;
}

interface WorkspaceHeadRow {
  workspace_id: string;
  not_before: number | null;
  fairness_seq: number;
  version: number;
}

interface BatchRow {
  batch_id: string;
  run_id: string;
  stream_id: string;
  workspace_id: string;
  trigger_name: string;
  vcs: string;
  source_namespace: string;
  scope_ref: string;
  history_generation: number;
  source_key: string;
  members: string;
  base: string;
  head: string;
  exclusion_policy_version: string;
  config_policy_version: string;
  status: string;
  attempt: number;
  max_attempts: number;
  retry_not_before: number | null;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expiry: number | null;
  last_error: string | null;
  created_at: number;
  execution_checkpoint: string | null;
}

interface OutboxRow {
  batch_id: string;
  status: string;
  next_attempt_at: number;
  claim_token: string | null;
  claim_expiry: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDb = any;

async function loadBetterSqlite3(): Promise<SqliteModule> {
  try {
    const mod = await import("better-sqlite3");
    return (
      (mod as { default?: SqliteModule }).default ??
      (mod as unknown as SqliteModule)
    );
  } catch {
    throw new Error(
      "better-sqlite3 is not installed. Install it with: pnpm add better-sqlite3\n" +
        "SQLite queue requires the better-sqlite3 package.",
    );
  }
}

function rowToRoutingReceipt(row: RoutingReceiptRow): RoutingReceiptRecord {
  return {
    routingId: row.routing_id,
    routingKey: row.routing_key,
    provider: row.provider,
    triggerName: row.trigger_name,
    envelope: JSON.parse(row.envelope) as unknown,
    parentDeliveryId: row.parent_delivery_id,
    firstAcceptedAt: row.first_accepted_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    terminalError: row.terminal_error,
    convertedReceiptIds: JSON.parse(row.converted_receipt_ids) as string[],
    completedAt: row.completed_at,
    note: row.note,
    resolution: row.resolution === null
      ? null
      : (JSON.parse(row.resolution) as RoutingReceiptRecord["resolution"]),
  };
}

function rowToReceipt(row: ReceiptRow): AutoCommitReceipt {
  return {
    receiptId: row.receipt_id,
    receiptSeq: row.receipt_seq,
    deliveryKey: row.delivery_key,
    workspaceId: row.workspace_id,
    triggerName: row.trigger_name,
    provider: row.provider,
    vcs: row.vcs as AutoCommitReceipt["vcs"],
    sourceNamespace: row.source_namespace,
    scopeRef: row.scope_ref,
    historyGeneration: row.history_generation,
    coverage: JSON.parse(row.coverage) as ReceiptCoverage,
    envelope: JSON.parse(row.envelope) as unknown,
    firstAcceptedAt: row.first_accepted_at,
    delaySeconds: row.delay_seconds,
    policyVersion: row.policy_version,
    metadataCursor: row.metadata_cursor,
    metadataAttempts: row.metadata_attempts,
    metadataNextAttemptAt: row.metadata_next_attempt_at,
    metadataTerminalError: row.metadata_terminal_error,
    resolution: row.resolution === null ? null : (JSON.parse(row.resolution) as AutoCommitReceipt["resolution"]),
  };
}

function rowToMember(row: MemberRow): CommitMemberRecord {
  return {
    memberId: row.member_id,
    streamId: row.stream_id,
    revision: row.revision,
    orderKey: row.order_key,
    parents: JSON.parse(row.parents) as readonly string[],
    status: row.status as CommitMemberRecord["status"],
    sourceSnapshot:
      row.source_snapshot === null
        ? null
        : (JSON.parse(row.source_snapshot) as SourceSnapshot),
    exclusion: {
      state: row.exclusion_state as MemberExclusionState,
      ruleId: row.exclusion_rule_id,
      policyVersion: row.exclusion_policy_version,
    },
    eligibleAt: row.eligible_at,
    firstAcceptedAt: row.first_accepted_at,
    batchId: row.batch_id,
    terminalReason: row.terminal_reason,
    coverReceiptId: row.cover_receipt_id,
  };
}

function rowToStreamHead(row: StreamHeadRow): StreamHead {
  return {
    streamId: row.stream_id,
    workspaceId: row.workspace_id,
    triggerName: row.trigger_name,
    vcs: row.vcs as StreamHead["vcs"],
    sourceNamespace: row.source_namespace,
    scopeRef: row.scope_ref,
    historyGeneration: row.history_generation,
    notBefore: row.not_before,
    activeBatchId: row.active_batch_id,
    reservationOwner: row.reservation_owner,
    reservationToken: row.reservation_token,
    reservationExpiry: row.reservation_expiry,
    coverageCursor: row.coverage_cursor,
    latestReceiptSeq: row.latest_receipt_seq,
    assemblyCutSeq: row.assembly_cut_seq,
    assemblyAt: row.assembly_at,
    resumeNotBefore: row.resume_not_before,
    version: row.version,
  };
}
function rowToWorkspaceHead(row: WorkspaceHeadRow): WorkspaceHead {
  return {
    workspaceId: row.workspace_id,
    notBefore: row.not_before,
    fairnessSeq: row.fairness_seq,
    version: row.version,
  };
}

function rowToBatch(row: BatchRow): CommitBatchRecord {
  return {
    executionCheckpoint: row.execution_checkpoint
      ? (JSON.parse(row.execution_checkpoint) as BatchExecutionCheckpoint)
      : null,
    batchId: row.batch_id,
    runId: row.run_id,
    streamId: row.stream_id,
    workspaceId: row.workspace_id,
    triggerName: row.trigger_name,
    vcs: row.vcs as CommitBatchRecord["vcs"],
    sourceNamespace: row.source_namespace,
    scopeRef: row.scope_ref,
    historyGeneration: row.history_generation,
    sourceKey: row.source_key,
    members: JSON.parse(row.members) as readonly CommitBatchMember[],
    base: row.base,
    head: row.head,
    exclusionPolicyVersion: row.exclusion_policy_version,
    configPolicyVersion: row.config_policy_version,
    status: row.status as CommitBatchRecord["status"],
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    retryNotBefore: row.retry_not_before,
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseExpiry: row.lease_expiry,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export async function createSqliteAutoCommitStore(
  options: SqliteAutoCommitStoreOptions,
): Promise<AutoCommitStore> {
  const Database = await loadBetterSqlite3();
  const dir = dirname(options.path);
  mkdirSync(dir, { recursive: true });

  const db: SqliteDb = new Database(options.path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  try {
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      const meta = db
        .prepare(`SELECT schema_version FROM auto_commit_meta WHERE id = 1`)
        .get() as { schema_version: number } | undefined;
      if (!meta) {
        db.prepare(
          `INSERT INTO auto_commit_meta (id, schema_version) VALUES (1, ?)`,
        ).run(AUTO_COMMIT_STORE_SCHEMA_VERSION);
      } else {
        let version = meta.schema_version as number;
        if (version === 1) {
          // v1 → v2: receipts gain the persisted metadata expansion cursor. Old rows
          // read as NULL (fully expanded or never paged), matching the new default.
          db.exec(
            `ALTER TABLE auto_commit_receipts ADD COLUMN metadata_cursor TEXT`,
          );
          version = 2;
        }
        if (version === 2) {
          // v2 → v3: receipts gain durable metadata retry accounting; stream heads
          // gain the receipt high-water mark, persisted assembly cut, and the
          // scheduler-managed resume floor. Old rows read as the new defaults
          // (0 attempts, no pending retry, no cut, no floor), which matches a
          // pre-upgrade drained or in-flight state exactly.
          db.exec(`
        ALTER TABLE auto_commit_receipts ADD COLUMN metadata_attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE auto_commit_receipts ADD COLUMN metadata_next_attempt_at INTEGER;
        ALTER TABLE auto_commit_receipts ADD COLUMN metadata_terminal_error TEXT;
        ALTER TABLE auto_commit_stream_heads ADD COLUMN latest_receipt_seq INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE auto_commit_stream_heads ADD COLUMN assembly_cut_seq INTEGER;
        ALTER TABLE auto_commit_stream_heads ADD COLUMN assembly_at INTEGER;
        ALTER TABLE auto_commit_stream_heads ADD COLUMN resume_not_before INTEGER;
        UPDATE auto_commit_stream_heads SET latest_receipt_seq = COALESCE((SELECT MAX(receipt_seq) FROM auto_commit_receipts r WHERE r.stream_id = auto_commit_stream_heads.stream_id), 0);
      `);
          version = 3;
        }
        if (version === 3) {
          // Also accept databases written by the pre-release v3 implementation,
          // which added this column without advancing the schema version.
          const columns = db
            .prepare("PRAGMA table_info(auto_commit_batches)")
            .all() as { name: string }[];
          if (
            !columns.some((column) => column.name === "execution_checkpoint")
          ) {
            db.exec(
              "ALTER TABLE auto_commit_batches ADD COLUMN execution_checkpoint TEXT",
            );
          }
          version = 4;
        }
        if (version === 4) {
          // v4 → v5: receipts gain the frozen admission resolution snapshot;
          // the routing-receipt stage (spec §5.2) gets its own table. Old rows
          // read as NULL resolution (recompute fallback), matching legacy
          // routing exactly.
          db.exec(`
        ALTER TABLE auto_commit_receipts ADD COLUMN resolution TEXT;
        CREATE TABLE IF NOT EXISTS auto_commit_routing_receipts (
          routing_id TEXT PRIMARY KEY,
          routing_key TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL,
          trigger_name TEXT NOT NULL,
          envelope TEXT NOT NULL,
          parent_delivery_id TEXT,
          first_accepted_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER,
          terminal_error TEXT,
          converted_receipt_ids TEXT NOT NULL DEFAULT '[]',
          completed_at INTEGER,
          note TEXT
        );
      `);
          version = 5;
        }
        if (version === 5) {
          // v5 → v6: routing receipts freeze their per-scope interpretation
          // (V14) so restarts never re-resolve against changed config. NULL =
          // not yet interpreted (or a pre-V14 record), which resolves once
          // and then freezes like any new intake. SCHEMA_SQL already carries
          // the column, so guard like the v3 → v4 checkpoint step.
          const columns = db
            .prepare("PRAGMA table_info(auto_commit_routing_receipts)")
            .all() as { name: string }[];
          if (!columns.some((column) => column.name === "resolution")) {
            db.exec(
              "ALTER TABLE auto_commit_routing_receipts ADD COLUMN resolution TEXT",
            );
          }
          version = 6;
        }
        if (version !== AUTO_COMMIT_STORE_SCHEMA_VERSION) {
          throw new Error(
            `Unsupported auto-commit store schema version ${meta.schema_version}; expected ${AUTO_COMMIT_STORE_SCHEMA_VERSION}.`,
          );
        }
        db.prepare(
          `UPDATE auto_commit_meta SET schema_version = ? WHERE id = 1`,
        ).run(version);
      }
      db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auto_commit_batches_active ON auto_commit_batches(status, lease_expiry, workspace_id);
    CREATE INDEX IF NOT EXISTS idx_auto_commit_batches_workspace_active ON auto_commit_batches(workspace_id, status, lease_expiry);
    CREATE INDEX IF NOT EXISTS idx_auto_commit_streams_due ON auto_commit_stream_heads(workspace_id, not_before);
    CREATE INDEX IF NOT EXISTS idx_auto_commit_members_elig ON auto_commit_members(stream_id, status, eligible_at);
  `);
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  // -------------------------------------------------------------------------
  const stmtReceiptByDelivery = db.prepare(
    `SELECT * FROM auto_commit_receipts WHERE delivery_key = ?`,
  );
  const stmtReceiptById = db.prepare(
    `SELECT * FROM auto_commit_receipts WHERE receipt_id = ?`,
  );
  const stmtInsertReceipt = db.prepare(
    `INSERT INTO auto_commit_receipts (
       receipt_id, receipt_seq, delivery_key, stream_id, workspace_id, trigger_name, provider, vcs,
       source_namespace, scope_ref, history_generation, coverage, envelope, first_accepted_at,
       delay_seconds, policy_version, metadata_cursor, resolution
     ) VALUES (
       @receipt_id, @receipt_seq, @delivery_key, @stream_id, @workspace_id, @trigger_name, @provider, @vcs,
       @source_namespace, @scope_ref, @history_generation, @coverage, @envelope, @first_accepted_at,
       @delay_seconds, @policy_version, NULL, @resolution
     )`,
  );
  const stmtMemberById = db.prepare(
    `SELECT * FROM auto_commit_members WHERE member_id = ?`,
  );
  const stmtInsertMember = db.prepare(
    `INSERT INTO auto_commit_members (
       member_id, stream_id, revision, order_key, parents, status, source_snapshot, exclusion_state,
       exclusion_rule_id, exclusion_policy_version, eligible_at, first_accepted_at, batch_id,
       terminal_reason, cover_seq, cover_receipt_id
     ) VALUES (
       @member_id, @stream_id, @revision, @order_key, @parents, 'pending', @source_snapshot, 'undecided',
       NULL, NULL, @eligible_at, @first_accepted_at, NULL, NULL, @cover_seq, @cover_receipt_id
     )`,
  );
  const stmtInsertAssoc = db.prepare(
    `INSERT OR IGNORE INTO auto_commit_receipt_members (receipt_id, member_id) VALUES (?, ?)`,
  );
  const stmtStreamHead = db.prepare(
    `SELECT * FROM auto_commit_stream_heads WHERE stream_id = ?`,
  );
  const stmtWorkspaceHead = db.prepare(
    `SELECT * FROM auto_commit_workspace_heads WHERE workspace_id = ?`,
  );
  const stmtBatchById = db.prepare(
    `SELECT * FROM auto_commit_batches WHERE batch_id = ?`,
  );
  const stmtOutboxById = db.prepare(
    `SELECT * FROM auto_commit_outbox WHERE batch_id = ?`,
  );
  const stmtNextCounter = db.prepare(
    `INSERT INTO auto_commit_counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1
     RETURNING value`,
  );
  const stmtStreamNotBefore = db.prepare(
    `SELECT MIN(eligible) AS not_before FROM (
       SELECT MAX(first_accepted_at + delay_seconds * 1000, COALESCE(metadata_next_attempt_at, 0)) AS eligible
         FROM auto_commit_receipts
        WHERE stream_id = ? AND receipt_seq > ? AND metadata_terminal_error IS NULL
       UNION ALL
       SELECT eligible_at AS eligible
         FROM auto_commit_members
        WHERE stream_id = ? AND status = 'pending'
       UNION ALL
       SELECT COALESCE(retry_not_before, 0) AS eligible
         FROM auto_commit_batches
        WHERE batch_id = ? AND status = 'retry_wait'
     )`,
  );
  const stmtSetStreamNotBefore = db.prepare(
    `UPDATE auto_commit_stream_heads SET not_before = ? WHERE stream_id = ?`,
  );
  const stmtInsertWorkspaceHead = db.prepare(
    `INSERT INTO auto_commit_workspace_heads (workspace_id, not_before, fairness_seq, version)
     VALUES (?, NULL, ?, 0)`,
  );
  const stmtWorkspaceNotBefore = db.prepare(
    `SELECT MIN(not_before) AS not_before FROM auto_commit_stream_heads WHERE workspace_id = ?`,
  );
  const stmtSetWorkspaceNotBefore = db.prepare(
    `UPDATE auto_commit_workspace_heads SET not_before = ?, version = version + 1 WHERE workspace_id = ?`,
  );

  function nextCounter(name: string): number {
    const row = stmtNextCounter.get(name) as { value: number };
    return row.value;
  }

  function ensureWorkspaceHead(workspaceId: string): void {
    const existing = stmtWorkspaceHead.get(workspaceId) as
      WorkspaceHeadRow | undefined;
    if (!existing) {
      stmtInsertWorkspaceHead.run(workspaceId, nextCounter("fairness_seq"));
    }
  }

  /** Exact recompute from this stream's own receipts, pending members, and active batch. */
  function recomputeStreamNotBefore(streamId: string): void {
    const head = stmtStreamHead.get(streamId) as StreamHeadRow | undefined;
    if (!head) return;
    const row = stmtStreamNotBefore.get(
      streamId,
      head.coverage_cursor,
      streamId,
      head.active_batch_id,
    ) as {
      not_before: number | null;
    };
    // The persisted resume floor (scheduler backoff/calendar bound) only raises
    // an existing wake; it never wakes an otherwise idle stream.
    const effective =
      row.not_before !== null && head.resume_not_before !== null
        ? Math.max(row.not_before, head.resume_not_before)
        : row.not_before;
    stmtSetStreamNotBefore.run(effective, streamId);
    recomputeWorkspaceNotBefore(head.workspace_id);
  }

  function recomputeWorkspaceNotBefore(workspaceId: string): void {
    ensureWorkspaceHead(workspaceId);
    const row = stmtWorkspaceNotBefore.get(workspaceId) as {
      not_before: number | null;
    };
    stmtSetWorkspaceNotBefore.run(row.not_before, workspaceId);
  }

  function clearStreamActiveBatch(streamId: string, batchId: string): void {
    db.prepare(
      `UPDATE auto_commit_stream_heads
          SET active_batch_id = NULL, version = version + 1
        WHERE stream_id = ? AND active_batch_id = ?`,
    ).run(streamId, batchId);
    recomputeStreamNotBefore(streamId);
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------
  const txAcceptReceipt = db.transaction(
    (input: AcceptReceiptInput): AcceptReceiptResult => {
      const existing = stmtReceiptByDelivery.get(input.deliveryKey) as
        ReceiptRow | undefined;
      if (existing) {
        return { receipt: rowToReceipt(existing), duplicate: true };
      }

      const streamId = computeStreamId({
        workspaceId: input.workspaceId,
        triggerName: input.triggerName,
        vcs: input.vcs,
        sourceNamespace: input.sourceNamespace,
        scopeRef: input.scopeRef,
        historyGeneration: input.historyGeneration,
      });
      const receiptSeq = nextCounter("receipt_seq");
      const receiptId = randomUUID();
      stmtInsertReceipt.run({
        receipt_id: receiptId,
        receipt_seq: receiptSeq,
        delivery_key: input.deliveryKey,
        stream_id: streamId,
        workspace_id: input.workspaceId,
        trigger_name: input.triggerName,
        provider: input.provider,
        vcs: input.vcs,
        source_namespace: input.sourceNamespace,
        scope_ref: input.scopeRef,
        history_generation: input.historyGeneration,
        coverage: JSON.stringify(input.coverage),
        envelope: JSON.stringify(input.envelope) ?? "null",
        first_accepted_at: input.now,
        delay_seconds: input.delaySeconds,
        policy_version: input.policyVersion,
        resolution: input.resolution === undefined || input.resolution === null
          ? null
          : JSON.stringify(input.resolution),
      });

      const stream = stmtStreamHead.get(streamId) as StreamHeadRow | undefined;
      if (!stream) {
        db.prepare(
          `INSERT INTO auto_commit_stream_heads (
           stream_id, workspace_id, trigger_name, vcs, source_namespace, scope_ref, history_generation,
           not_before, active_batch_id, reservation_owner, reservation_token, reservation_expiry,
           coverage_cursor, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, 0)`,
        ).run(
          streamId,
          input.workspaceId,
          input.triggerName,
          input.vcs,
          input.sourceNamespace,
          input.scopeRef,
          input.historyGeneration,
        );
      }
      // Receipt high-water mark: monotonic per stream, never rewound by dedup or
      // later failure. Direct write (no version bump) — it is derived state, not
      // a CAS-guarded scheduling decision.
      db.prepare(
        `UPDATE auto_commit_stream_heads SET latest_receipt_seq = ? WHERE stream_id = ?`,
      ).run(receiptSeq, streamId);
      recomputeStreamNotBefore(streamId);

      const receipt: AutoCommitReceipt = {
        receiptId,
        receiptSeq,
        deliveryKey: input.deliveryKey,
        workspaceId: input.workspaceId,
        triggerName: input.triggerName,
        provider: input.provider,
        vcs: input.vcs,
        sourceNamespace: input.sourceNamespace,
        scopeRef: input.scopeRef,
        historyGeneration: input.historyGeneration,
        coverage: input.coverage,
        envelope: input.envelope,
        firstAcceptedAt: input.now,
        delaySeconds: input.delaySeconds,
        policyVersion: input.policyVersion,
        metadataCursor: null,
        metadataAttempts: 0,
        metadataNextAttemptAt: null,
        metadataTerminalError: null,
        resolution: input.resolution ?? null,
      };
      return { receipt, duplicate: false };
    },
  );

  const txAcceptRoutingReceipt = db.transaction(
    (input: AcceptRoutingReceiptInput): AcceptRoutingReceiptResult => {
      const existing = db.prepare(
        `SELECT * FROM auto_commit_routing_receipts WHERE routing_key = ?`,
      ).get(input.routingKey) as RoutingReceiptRow | undefined;
      if (existing) {
        return { receipt: rowToRoutingReceipt(existing), duplicate: true };
      }
      const routingId = randomUUID();
      db.prepare(
        `INSERT INTO auto_commit_routing_receipts (
           routing_id, routing_key, provider, trigger_name, envelope, parent_delivery_id,
           first_accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        routingId,
        input.routingKey,
        input.provider,
        input.triggerName,
        JSON.stringify(input.envelope) ?? "null",
        input.parentDeliveryId ?? null,
        input.now,
      );
      const row = db.prepare(
        `SELECT * FROM auto_commit_routing_receipts WHERE routing_id = ?`,
      ).get(routingId) as RoutingReceiptRow;
      return { receipt: rowToRoutingReceipt(row), duplicate: false };
    },
  );

  const txRoutingResolution = db.transaction(
    (
      routingId: string,
      resolution: readonly FrozenScopeResolution[],
    ): RoutingReceiptRecord => {
      // Set-if-null: the first interpretation wins; concurrent/retried
      // attempts read back the frozen value (V14).
      db.prepare(
        `UPDATE auto_commit_routing_receipts
            SET resolution = ?
          WHERE routing_id = ? AND resolution IS NULL`,
      ).run(JSON.stringify(resolution), routingId);
      const row = db.prepare(
        `SELECT * FROM auto_commit_routing_receipts WHERE routing_id = ?`,
      ).get(routingId) as RoutingReceiptRow | undefined;
      if (!row) {
        throw new Error(`Unknown routing receipt ${routingId}.`);
      }
      return rowToRoutingReceipt(row);
    },
  );

  const txRoutingConversion = db.transaction(
    (
      routingId: string,
      input: {
        readonly addedReceiptIds?: readonly string[];
        readonly complete?: boolean;
        readonly note?: string;
      },
      now: number,
    ): RoutingReceiptRecord => {
      const row = db.prepare(
        `SELECT * FROM auto_commit_routing_receipts WHERE routing_id = ?`,
      ).get(routingId) as RoutingReceiptRow | undefined;
      if (!row) {
        throw new Error(`Unknown routing receipt ${routingId}.`);
      }
      const ids = new Set(JSON.parse(row.converted_receipt_ids) as string[]);
      for (const id of input.addedReceiptIds ?? []) {
        ids.add(id);
      }
      const completedAt =
        input.complete === true ? row.completed_at ?? now : row.completed_at;
      db.prepare(
        `UPDATE auto_commit_routing_receipts
            SET converted_receipt_ids = ?, completed_at = ?, note = COALESCE(?, note)
          WHERE routing_id = ?`,
      ).run(JSON.stringify([...ids]), completedAt, input.note ?? null, routingId);
      const updated = db.prepare(
        `SELECT * FROM auto_commit_routing_receipts WHERE routing_id = ?`,
      ).get(routingId) as RoutingReceiptRow;
      return rowToRoutingReceipt(updated);
    },
  );

  const txApplyMetadataPage = db.transaction(
    (input: ApplyMetadataPageInput): ApplyMetadataPageResult => {
      const receipt = stmtReceiptById.get(input.receiptId) as
        ReceiptRow | undefined;
      if (!receipt) {
        throw new RangeError(`Unknown receipt ${input.receiptId}`);
      }
      if (receipt.stream_id !== input.streamId)
        throw new RangeError("Receipt stream mismatch");
      let created = 0;
      let updated = 0;
      const conflicted: string[] = [];

      for (const upsert of input.members) {
        const memberId = computeMemberId(input.streamId, upsert.revision);
        stmtInsertAssoc.run(input.receiptId, memberId);
        const member = stmtMemberById.get(memberId) as MemberRow | undefined;

        if (member) {
          // Earliest covering notification (by persistent receipt seq) owns the
          // (firstAcceptedAt, delay) pair; later/duplicate notifications never
          // reset it, regardless of expansion order or clock jumps.
          if (
            member.status === "pending" &&
            receipt.receipt_seq < member.cover_seq
          ) {
            member.cover_seq = receipt.receipt_seq;
            member.cover_receipt_id = receipt.receipt_id;
            member.first_accepted_at = receipt.first_accepted_at;
            member.eligible_at = computeMemberEligibility(
              receipt.first_accepted_at,
              receipt.delay_seconds,
            );
            db.prepare(
              `UPDATE auto_commit_members
                SET cover_seq = ?, cover_receipt_id = ?, first_accepted_at = ?, eligible_at = ?
              WHERE member_id = ?`,
            ).run(
              member.cover_seq,
              member.cover_receipt_id,
              member.first_accepted_at,
              member.eligible_at,
              memberId,
            );
          }
          if (member.status === "pending" && member.batch_id === null) {
            if (member.source_snapshot === null) {
              member.order_key = upsert.orderKey;
              member.parents = JSON.stringify(upsert.parents ?? []);
              member.source_snapshot = JSON.stringify(upsert.sourceSnapshot);
              db.prepare(
                `UPDATE auto_commit_members SET order_key = ?, parents = ?, source_snapshot = ? WHERE member_id = ?`,
              ).run(
                member.order_key,
                member.parents,
                member.source_snapshot,
                memberId,
              );
              updated += 1;
            } else {
              const prior = JSON.parse(
                member.source_snapshot,
              ) as SourceSnapshot;
              const merged = mergeSourceEvidence(
                prior,
                upsert.sourceSnapshot,
                member.cover_receipt_id === receipt.receipt_id,
              );
              member.source_snapshot = JSON.stringify(merged);
              db.prepare(
                "UPDATE auto_commit_members SET source_snapshot = ? WHERE member_id = ?",
              ).run(member.source_snapshot, memberId);
              if (merged.status === "conflicted") conflicted.push(memberId);
              updated += 1;
            }
          }
          // Batched/terminal members only gain the idempotent association.
          continue;
        }

        stmtInsertMember.run({
          member_id: memberId,
          stream_id: input.streamId,
          revision: upsert.revision,
          order_key: upsert.orderKey,
          parents: JSON.stringify(upsert.parents ?? []),
          source_snapshot: JSON.stringify(upsert.sourceSnapshot),
          eligible_at: computeMemberEligibility(
            receipt.first_accepted_at,
            receipt.delay_seconds,
          ),
          first_accepted_at: receipt.first_accepted_at,
          cover_seq: receipt.receipt_seq,
          cover_receipt_id: receipt.receipt_id,
        });
        created += 1;
      }

      recomputeStreamNotBefore(input.streamId);
      return { created, updated, conflicted };
    },
  );

  const txApplyExclusionVerdicts = db.transaction(
    (input: {
      readonly streamId: string;
      readonly verdicts: readonly {
        readonly memberId: string;
        readonly state: MemberExclusionState;
        readonly ruleId?: string;
        readonly policyVersion: string;
      }[];
      readonly now: number;
    }): void => {
      const stmtVerdict = db.prepare(
        `UPDATE auto_commit_members
            SET status = ?, exclusion_state = ?, exclusion_rule_id = ?, exclusion_policy_version = ?,
                terminal_reason = ?
          WHERE member_id = ?`,
      );
      for (const verdict of input.verdicts) {
        const member = stmtMemberById.get(verdict.memberId) as
          MemberRow | undefined;
        if (
          !member ||
          member.stream_id !== input.streamId ||
          member.status !== "pending"
        )
          continue;
        const excluded = verdict.state === "excluded";
        // "unavailable" is terminal: unavailable/conflicted source evidence
        // blocks merging forever (design §5.1.1) and v1 has no manual allow
        // path, so the member fails explicitly — never silently re-keyed.
        const failed = verdict.state === "unavailable";
        stmtVerdict.run(
          excluded ? "skipped" : failed ? "failed" : member.status,
          verdict.state,
          verdict.ruleId ?? null,
          verdict.policyVersion,
          excluded
            ? "excluded_source"
            : failed
              ? (verdict.ruleId ?? "source_unavailable")
              : member.terminal_reason,
          verdict.memberId,
        );
      }
      recomputeStreamNotBefore(input.streamId);
    },
  );

  const txAcquireReservation = db.transaction(
    (
      streamId: string,
      ownerId: string,
      ttlMs: number,
      now: number,
    ): StreamReservation | undefined => {
      const head = stmtStreamHead.get(streamId) as StreamHeadRow | undefined;
      if (!head) return undefined;
      if (head.active_batch_id !== null) return undefined;
      if (
        head.reservation_token !== null &&
        head.reservation_expiry !== null &&
        head.reservation_expiry > now
      ) {
        return undefined;
      }
      const token = `${ownerId}-${randomUUID()}`;
      const version = head.version + 1;
      db.prepare(
        `UPDATE auto_commit_stream_heads
            SET reservation_owner = ?, reservation_token = ?, reservation_expiry = ?, version = ?
          WHERE stream_id = ?`,
      ).run(ownerId, token, now + ttlMs, version, streamId);
      return { streamId, token, expiry: now + ttlMs, version };
    },
  );

  const txRenewReservation = db.transaction(
    (streamId: string, token: string, ttlMs: number, now: number): boolean => {
      const head = stmtStreamHead.get(streamId) as StreamHeadRow | undefined;
      if (!head) return false;
      if (
        head.reservation_token !== token ||
        head.reservation_expiry === null ||
        head.reservation_expiry <= now
      ) {
        return false;
      }
      db.prepare(
        `UPDATE auto_commit_stream_heads SET reservation_expiry = ?, version = version + 1 WHERE stream_id = ?`,
      ).run(now + ttlMs, streamId);
      return true;
    },
  );

  const txReleaseReservation = db.transaction(
    (streamId: string, token: string): void => {
      const head = stmtStreamHead.get(streamId) as StreamHeadRow | undefined;
      if (!head) return;
      if (head.reservation_token !== token) return;
      db.prepare(
        `UPDATE auto_commit_stream_heads
          SET reservation_owner = NULL, reservation_token = NULL, reservation_expiry = NULL,
              version = version + 1
        WHERE stream_id = ?`,
      ).run(streamId);
    },
  );

  const txUpdateStreamHead = db.transaction(
    (
      streamId: string,
      expectedVersion: number,
      update: StreamHeadUpdate,
    ): boolean => {
      const head = stmtStreamHead.get(streamId) as StreamHeadRow | undefined;
      if (!head || head.version !== expectedVersion) return false;
      db.prepare(
        `UPDATE auto_commit_stream_heads
            SET not_before = ?, coverage_cursor = ?, history_generation = ?,
                resume_not_before = ?, assembly_cut_seq = ?, assembly_at = ?, version = ?
          WHERE stream_id = ?`,
      ).run(
        update.notBefore !== undefined ? update.notBefore : head.not_before,
        update.coverageCursor !== undefined
          ? update.coverageCursor
          : head.coverage_cursor,
        update.historyGeneration !== undefined
          ? update.historyGeneration
          : head.history_generation,
        update.resumeNotBefore !== undefined
          ? update.resumeNotBefore
          : head.resume_not_before,
        update.assemblyCutSeq !== undefined
          ? update.assemblyCutSeq
          : head.assembly_cut_seq,
        update.assemblyAt !== undefined ? update.assemblyAt : head.assembly_at,
        expectedVersion + 1,
        streamId,
      );
      // Mirror the memory backend: every head mutation re-derives the wake
      // bound from components (resume floor applied inside), so an explicit
      // notBefore write is transient by contract.
      recomputeStreamNotBefore(streamId);
      return true;
    },
  );
  const txRotateFairness = db.transaction((workspaceId: string): void => {
    ensureWorkspaceHead(workspaceId);
    db.prepare(
      `UPDATE auto_commit_workspace_heads SET fairness_seq = ?, version = version + 1 WHERE workspace_id = ?`,
    ).run(nextCounter("fairness_seq"), workspaceId);
  });

  const txSealBatch = db.transaction(
    (input: SealBatchInput): SealBatchResult => {
      const head = stmtStreamHead.get(input.streamId) as
        StreamHeadRow | undefined;
      if (!head) return { kind: "conflict", reason: "reservation_lost" };
      if (
        head.reservation_token !== input.reservationToken ||
        head.reservation_expiry === null ||
        head.reservation_expiry <= input.now
      ) {
        return { kind: "conflict", reason: "reservation_lost" };
      }
      if (head.version !== input.expectedStreamVersion) {
        return { kind: "conflict", reason: "stream_version_mismatch" };
      }
      if (head.active_batch_id !== null) {
        return { kind: "conflict", reason: "active_batch" };
      }
      if (
        input.members.length === 0 ||
        input.members.length > 50 ||
        stmtBatchById.get(input.batchId) ||
        new Set(input.members.map((m) => m.memberId)).size !==
          input.members.length
      )
        return { kind: "conflict", reason: "member_unavailable" };
      const stmtSealCheck = db.prepare(
        `SELECT * FROM auto_commit_members
        WHERE member_id = ? AND status = 'pending' AND batch_id IS NULL`,
      );
      for (const member of input.members) {
        const state = stmtSealCheck.get(member.memberId) as
          MemberRow | undefined;
        if (
          !state ||
          state.stream_id !== input.streamId ||
          (state.source_snapshot !== null &&
            (JSON.parse(state.source_snapshot) as SourceSnapshot).status ===
              "conflicted")
        ) {
          return {
            kind: "conflict",
            reason: "member_unavailable",
            memberId: member.memberId,
          };
        }
        if (state.eligible_at > input.now) {
          return {
            kind: "conflict",
            reason: "member_ineligible",
            memberId: member.memberId,
          };
        }
      }

      db.prepare(
        `INSERT INTO auto_commit_batches (
         batch_id, run_id, stream_id, workspace_id, trigger_name, vcs, source_namespace, scope_ref,
         history_generation, source_key, members, base, head, exclusion_policy_version,
         config_policy_version, status, attempt, max_attempts, retry_not_before, lease_token,
         lease_owner, lease_expiry, last_error, created_at
       ) VALUES (
         @batch_id, @run_id, @stream_id, @workspace_id, @trigger_name, @vcs, @source_namespace, @scope_ref,
         @history_generation, @source_key, @members, @base, @head, @exclusion_policy_version,
         @config_policy_version, 'dispatch_pending', 0, @max_attempts, NULL, NULL, NULL, NULL, NULL, @created_at
       )`,
      ).run({
        batch_id: input.batchId,
        run_id: input.runId,
        stream_id: input.streamId,
        workspace_id: head.workspace_id,
        trigger_name: head.trigger_name,
        vcs: head.vcs,
        source_namespace: head.source_namespace,
        scope_ref: head.scope_ref,
        history_generation: head.history_generation,
        source_key: input.sourceKey,
        members: JSON.stringify(input.members),
        base: input.base,
        head: input.head,
        exclusion_policy_version: input.exclusionPolicyVersion,
        config_policy_version: input.configPolicyVersion,
        max_attempts: input.maxAttempts,
        created_at: input.now,
      });
      db.prepare(
        `INSERT INTO auto_commit_outbox (batch_id, status, next_attempt_at, claim_token, claim_expiry)
       VALUES (?, 'pending', ?, NULL, NULL)`,
      ).run(input.batchId, input.now);
      const stmtMarkBatched = db.prepare(
        `UPDATE auto_commit_members SET status = 'batched', batch_id = ? WHERE member_id = ?`,
      );
      for (const member of input.members) {
        stmtMarkBatched.run(input.batchId, member.memberId);
      }
      db.prepare(
        `UPDATE auto_commit_stream_heads
          SET active_batch_id = ?, reservation_owner = NULL, reservation_token = NULL,
              reservation_expiry = NULL, version = version + 1
        WHERE stream_id = ?`,
      ).run(input.batchId, input.streamId);
      recomputeStreamNotBefore(input.streamId);
      return { kind: "sealed" };
    },
  );

  const txClaimDispatch = db.transaction(
    (
      now: number,
      ownerId: string,
      limit: number,
    ): readonly ClaimedDispatch[] => {
      const due = db
        .prepare(
          `SELECT * FROM auto_commit_outbox
            WHERE status = 'pending' AND next_attempt_at <= ?
              AND (claim_token IS NULL OR claim_expiry IS NULL OR claim_expiry <= ?)
            ORDER BY next_attempt_at ASC
            LIMIT ?`,
        )
        .all(now, now, limit) as OutboxRow[];
      const stmtClaim = db.prepare(
        `UPDATE auto_commit_outbox SET claim_token = ?, claim_expiry = ? WHERE batch_id = ?`,
      );
      const claimed: ClaimedDispatch[] = [];
      for (const entry of due) {
        const batch = stmtBatchById.get(entry.batch_id) as BatchRow | undefined;
        if (!batch) continue;
        const claimToken = `${ownerId}-${randomUUID()}`;
        stmtClaim.run(claimToken, now + DISPATCH_CLAIM_TTL_MS, entry.batch_id);
        claimed.push({ batch: rowToBatch(batch), claimToken });
      }
      return claimed;
    },
  );

  const txConfirmDispatch = db.transaction(
    (batchId: string, claimToken: string, now: number): void => {
      const entry = stmtOutboxById.get(batchId) as OutboxRow | undefined;
      const batch = stmtBatchById.get(batchId) as BatchRow | undefined;
      if (!entry || !batch || entry.claim_token !== claimToken) return;
      db.prepare(
        `UPDATE auto_commit_outbox SET status = 'dispatched', claim_token = NULL, claim_expiry = NULL
        WHERE batch_id = ?`,
      ).run(batchId);
      db.prepare(
        `UPDATE auto_commit_batches SET status = 'queued', lease_expiry = ? WHERE batch_id = ?`,
      ).run(now + DISPATCH_CLAIM_TTL_MS, batchId);
    },
  );

  const txAbortDispatch = db.transaction(
    (batchId: string, claimToken: string, nextAttemptAt: number): void => {
      const entry = stmtOutboxById.get(batchId) as OutboxRow | undefined;
      if (!entry || entry.claim_token !== claimToken) return;
      db.prepare(
        `UPDATE auto_commit_outbox
          SET status = 'pending', next_attempt_at = ?, claim_token = NULL, claim_expiry = NULL
        WHERE batch_id = ?`,
      ).run(nextAttemptAt, batchId);
    },
  );

  const txStartExecution = db.transaction(
    (
      batchId: string,
      ownerId: string,
      ttlMs: number,
      now: number,
      limits: { global: number; workspace: number },
    ): string | undefined => {
      const batch = stmtBatchById.get(batchId) as BatchRow | undefined;
      if (!batch) return undefined;
      if (batch.status !== "queued") return undefined;
      if (
        batch.lease_token !== null &&
        batch.lease_expiry !== null &&
        batch.lease_expiry > now
      ) {
        return undefined;
      }
      const globalActive = db
        .prepare(
          "SELECT COUNT(*) AS count FROM auto_commit_batches WHERE status = 'running' AND lease_expiry > ?",
        )
        .get(now) as { count: number };
      const workspaceActive = db
        .prepare(
          "SELECT COUNT(*) AS count FROM auto_commit_batches WHERE workspace_id = ? AND status = 'running' AND lease_expiry > ?",
        )
        .get(batch.workspace_id, now) as { count: number };
      if (
        globalActive.count >= limits.global ||
        workspaceActive.count >= limits.workspace
      )
        return undefined;
      const token = `${ownerId}-${randomUUID()}`;
      db.prepare(
        `UPDATE auto_commit_batches
            SET status = 'running', attempt = attempt + 1, lease_token = ?, lease_owner = ?, lease_expiry = ?
          WHERE batch_id = ?`,
      ).run(token, ownerId, now + ttlMs, batchId);
      return token;
    },
  );

  const txRenewLease = db.transaction(
    (batchId: string, token: string, ttlMs: number, now: number): boolean => {
      const batch = stmtBatchById.get(batchId) as BatchRow | undefined;
      if (!batch) return false;
      if (
        batch.status !== "running" ||
        batch.lease_token !== token ||
        batch.lease_expiry === null ||
        batch.lease_expiry <= now
      ) {
        return false;
      }
      db.prepare(
        `UPDATE auto_commit_batches SET lease_expiry = ? WHERE batch_id = ?`,
      ).run(now + ttlMs, batchId);
      return true;
    },
  );

  const txCompleteBatch = db.transaction(
    (
      batchId: string,
      token: string,
      completion: BatchCompletion,
      now: number,
    ): void => {
      const batch = stmtBatchById.get(batchId) as BatchRow | undefined;
      if (!batch) return;
      if (
        batch.status !== "running" ||
        batch.lease_token !== token ||
        (batch.lease_expiry ?? 0) <= now
      )
        return;
      const terminal = completion.outcome;
      db.prepare(
        `UPDATE auto_commit_batches
            SET status = ?, lease_token = NULL, lease_owner = NULL, lease_expiry = NULL
          WHERE batch_id = ?`,
      ).run(terminal, batchId);
      const terminalReason =
        completion.outcome === "skipped" ? completion.reason : null;
      const stmtCompleteMember = db.prepare(
        `UPDATE auto_commit_members SET status = ?, terminal_reason = ?
          WHERE member_id = ? AND batch_id = ?`,
      );
      for (const member of JSON.parse(
        batch.members,
      ) as readonly CommitBatchMember[]) {
        stmtCompleteMember.run(
          terminal,
          terminalReason,
          member.memberId,
          batchId,
        );
      }
      db.prepare(`DELETE FROM auto_commit_outbox WHERE batch_id = ?`).run(
        batchId,
      );
      clearStreamActiveBatch(batch.stream_id, batchId);
    },
  );

  const txFailBatch = db.transaction(
    (
      batchId: string,
      token: string,
      error: string,
      retryNotBefore: number | null,
      dead: boolean,
      now: number,
    ): void => {
      const batch = stmtBatchById.get(batchId) as BatchRow | undefined;
      if (!batch) return;
      if (
        batch.status !== "running" ||
        batch.lease_token !== token ||
        (batch.lease_expiry ?? 0) <= now
      )
        return;
      const exhausted = dead || batch.attempt >= batch.max_attempts;
      if (exhausted) {
        db.prepare(
          `UPDATE auto_commit_batches
              SET status = 'dead', last_error = ?, lease_token = NULL, lease_owner = NULL, lease_expiry = NULL
            WHERE batch_id = ?`,
        ).run(error, batchId);
        const stmtDeadMember = db.prepare(
          `UPDATE auto_commit_members SET status = 'dead', terminal_reason = ?
            WHERE member_id = ? AND batch_id = ?`,
        );
        for (const member of JSON.parse(
          batch.members,
        ) as readonly CommitBatchMember[]) {
          stmtDeadMember.run(error, member.memberId, batchId);
        }
        // The dead batch keeps stream.activeBatchId: the stream enters explicit
        // manual handling instead of silently regrouping (design §9).
      } else {
        db.prepare(
          `UPDATE auto_commit_batches
              SET status = 'retry_wait', last_error = ?, retry_not_before = ?,
                  lease_token = NULL, lease_owner = NULL, lease_expiry = NULL
            WHERE batch_id = ?`,
        ).run(error, retryNotBefore, batchId);
        db.prepare(
          `INSERT INTO auto_commit_outbox (batch_id, status, next_attempt_at, claim_token, claim_expiry)
           VALUES (?, 'pending', ?, NULL, NULL)
           ON CONFLICT(batch_id) DO UPDATE SET
             status = 'pending', next_attempt_at = excluded.next_attempt_at,
             claim_token = NULL, claim_expiry = NULL`,
        ).run(batchId, retryNotBefore ?? now);
      }
      recomputeStreamNotBefore(batch.stream_id);
    },
  );

  const txReclaimLeases = db.transaction(
    (now: number, limit: number): readonly string[] => {
      const expired = db
        .prepare(
          `SELECT * FROM auto_commit_batches
          WHERE status IN ('running', 'queued') AND lease_expiry IS NOT NULL AND lease_expiry <= ?
          ORDER BY lease_expiry ASC LIMIT ?`,
        )
        .all(now, limit) as BatchRow[];
      const reclaimed: string[] = [];
      for (const batch of expired) {
        if (reclaimed.length >= limit) break;
        if (batch.lease_token === null && batch.status !== "queued") continue;
        // Reclaim through the same failure path with a fresh outbox entry;
        // the expired token is invalidated implicitly by the status change.
        const exhausted =
          batch.status === "running" && batch.attempt >= batch.max_attempts;
        if (exhausted) {
          db.prepare(
            `UPDATE auto_commit_batches
              SET status = 'dead', last_error = 'lease_expired',
                  lease_token = NULL, lease_owner = NULL, lease_expiry = NULL
            WHERE batch_id = ?`,
          ).run(batch.batch_id);
          const stmtDeadMember = db.prepare(
            `UPDATE auto_commit_members SET status = 'dead', terminal_reason = 'lease_expired'
            WHERE member_id = ? AND batch_id = ?`,
          );
          for (const member of JSON.parse(
            batch.members,
          ) as readonly CommitBatchMember[]) {
            stmtDeadMember.run(member.memberId, batch.batch_id);
          }
        } else {
          db.prepare(
            `UPDATE auto_commit_batches
              SET status = 'retry_wait', last_error = 'lease_expired', retry_not_before = NULL,
                  lease_token = NULL, lease_owner = NULL, lease_expiry = NULL
            WHERE batch_id = ?`,
          ).run(batch.batch_id);
          db.prepare(
            `INSERT INTO auto_commit_outbox (batch_id, status, next_attempt_at, claim_token, claim_expiry)
           VALUES (?, 'pending', ?, NULL, NULL)
           ON CONFLICT(batch_id) DO UPDATE SET
             status = 'pending', next_attempt_at = excluded.next_attempt_at,
             claim_token = NULL, claim_expiry = NULL`,
          ).run(batch.batch_id, now);
        }
        recomputeStreamNotBefore(batch.stream_id);
        reclaimed.push(batch.batch_id);
      }
      return reclaimed;
    },
  );

  return {
    backendKind: "sqlite",

    async acceptReceipt(
      input: AcceptReceiptInput,
    ): Promise<AcceptReceiptResult> {
      return txAcceptReceipt.immediate(input) as AcceptReceiptResult;
    },

    async acceptRoutingReceipt(
      input: AcceptRoutingReceiptInput,
    ): Promise<AcceptRoutingReceiptResult> {
      return txAcceptRoutingReceipt.immediate(input) as AcceptRoutingReceiptResult;
    },

    async readDueRoutingReceipts(
      now: number,
      limit: number,
    ): Promise<readonly RoutingReceiptRecord[]> {
      const rows = db.prepare(
        `SELECT * FROM auto_commit_routing_receipts
          WHERE terminal_error IS NULL AND completed_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY first_accepted_at ASC
          LIMIT ?`,
      ).all(now, limit) as RoutingReceiptRow[];
      return rows.map(rowToRoutingReceipt);
    },

    async getRoutingReceipt(
      routingId: string,
    ): Promise<RoutingReceiptRecord | undefined> {
      const row = db.prepare(
        `SELECT * FROM auto_commit_routing_receipts WHERE routing_id = ?`,
      ).get(routingId) as RoutingReceiptRow | undefined;
      return row ? rowToRoutingReceipt(row) : undefined;
    },

    async recordRoutingReceiptFailure(
      routingId: string,
      error: string,
      retryAt: number | null,
    ): Promise<void> {
      db.prepare(
        `UPDATE auto_commit_routing_receipts
            SET attempts = attempts + 1,
                next_attempt_at = ?,
                terminal_error = CASE WHEN ? THEN ? ELSE terminal_error END
          WHERE routing_id = ? AND terminal_error IS NULL AND completed_at IS NULL`,
      ).run(retryAt, retryAt === null ? 1 : 0, error, routingId);
    },

    async recordRoutingReceiptResolution(
      routingId: string,
      resolution: readonly FrozenScopeResolution[],
      _now: number,
    ): Promise<RoutingReceiptRecord> {
      return txRoutingResolution(routingId, resolution);
    },

    async recordRoutingReceiptConversion(
      routingId: string,
      input: {
        readonly addedReceiptIds?: readonly string[];
        readonly complete?: boolean;
        readonly note?: string;
      },
      now: number,
    ): Promise<RoutingReceiptRecord> {
      return txRoutingConversion.immediate(routingId, input, now) as RoutingReceiptRecord;
    },

    async applyMetadataPage(
      input: ApplyMetadataPageInput,
    ): Promise<ApplyMetadataPageResult> {
      return txApplyMetadataPage.immediate(input) as ApplyMetadataPageResult;
    },

    async setReceiptMetadataCursor(
      receiptId: string,
      cursor: string | null,
    ): Promise<void> {
      // Progress clears any pending retry wake: the next attempt continues
      // from the persisted cursor on the normal schedule.
      const changed = db
        .prepare(
          `UPDATE auto_commit_receipts SET metadata_cursor = ?, metadata_next_attempt_at = NULL WHERE receipt_id = ?`,
        )
        .run(cursor, receiptId);
      if (changed.changes === 0) {
        throw new RangeError(`Unknown receipt ${receiptId}`);
      }
      const receipt = stmtReceiptById.get(receiptId) as ReceiptRow | undefined;
      if (receipt) {
        recomputeStreamNotBefore(receipt.stream_id);
      }
    },

    async recordReceiptMetadataFailure(
      receiptId: string,
      error: string,
      retryAt: number | null,
    ): Promise<void> {
      const changed = db
        .prepare(
          `UPDATE auto_commit_receipts
              SET metadata_attempts = metadata_attempts + 1,
                  metadata_next_attempt_at = ?,
                  metadata_terminal_error = ?
            WHERE receipt_id = ?`,
        )
        .run(retryAt, retryAt === null ? error : null, receiptId);
      if (changed.changes === 0) {
        throw new RangeError(`Unknown receipt ${receiptId}`);
      }
      const receipt = stmtReceiptById.get(receiptId) as ReceiptRow | undefined;
      if (receipt) {
        recomputeStreamNotBefore(receipt.stream_id);
      }
    },

    async readMembers(
      memberIds: readonly string[],
    ): Promise<readonly CommitMemberRecord[]> {
      if (memberIds.length > 512)
        throw new RangeError("Member lookup exceeds 512");
      if (memberIds.length === 0) return [];
      const placeholders = memberIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM auto_commit_members WHERE member_id IN (${placeholders})`,
        )
        .all(...memberIds) as MemberRow[];
      const byId = new Map(rows.map((row) => [row.member_id, row]));
      return memberIds.flatMap((id) => {
        const row = byId.get(id);
        return row ? [rowToMember(row)] : [];
      });
    },

    async applyExclusionVerdicts(input: {
      readonly streamId: string;
      readonly verdicts: readonly {
        readonly memberId: string;
        readonly state: MemberExclusionState;
        readonly ruleId?: string;
        readonly policyVersion: string;
      }[];
      readonly now: number;
    }): Promise<void> {
      txApplyExclusionVerdicts.immediate(input);
    },

    async readRunnableWorkspaceHeads(
      now: number,
      limit: number,
    ): Promise<readonly WorkspaceHead[]> {
      const rows = db
        .prepare(
          `SELECT * FROM auto_commit_workspace_heads
            WHERE not_before IS NOT NULL AND not_before <= ?
            ORDER BY fairness_seq ASC
            LIMIT ?`,
        )
        .all(now, limit) as WorkspaceHeadRow[];
      return rows.map(rowToWorkspaceHead);
    },

    async readStreamHeads(
      workspaceId: string,
      limit: number,
    ): Promise<readonly StreamHead[]> {
      const rows = db
        .prepare(
          `SELECT * FROM auto_commit_stream_heads
            WHERE workspace_id = ?
            ORDER BY (not_before IS NULL) ASC, not_before ASC, stream_id ASC
            LIMIT ?`,
        )
        .all(workspaceId, limit) as StreamHeadRow[];
      return rows.map(rowToStreamHead);
    },

    async readStreamHead(streamId: string): Promise<StreamHead | undefined> {
      const row = stmtStreamHead.get(streamId) as StreamHeadRow | undefined;
      return row ? rowToStreamHead(row) : undefined;
    },

    async readPendingMembers(
      streamId: string,
      cursor: string | null,
      limit: number,
    ): Promise<Page<CommitMemberRecord>> {
      // Metadata-pending members (null orderKey) first in member id order,
      // then verified members in VCS order. The cursor is the last item's
      // `${orderKey ?? ""}${memberId}`; the next page starts strictly after it.
      const rows = db
        .prepare(
          `SELECT * FROM auto_commit_members
            WHERE stream_id = ? AND status = 'pending'
              AND (COALESCE(order_key, '') || member_id) > ?
            ORDER BY (order_key IS NOT NULL) ASC, order_key ASC, member_id ASC
            LIMIT ?`,
        )
        .all(streamId, cursor ?? "", limit) as MemberRow[];
      const last = rows[rows.length - 1];
      const nextCursor =
        rows.length === limit && last
          ? `${last.order_key ?? ""}${last.member_id}`
          : null;
      return { items: rows.map(rowToMember), nextCursor };
    },

    async readStreamReceipts(
      streamId: string,
      fromSeq: number,
      toSeq: number,
      limit: number,
    ): Promise<readonly AutoCommitReceipt[]> {
      const rows = db
        .prepare(
          `SELECT * FROM auto_commit_receipts
            WHERE stream_id = ? AND receipt_seq > ? AND receipt_seq <= ?
            ORDER BY receipt_seq ASC
            LIMIT ?`,
        )
        .all(streamId, fromSeq, toSeq, limit) as ReceiptRow[];
      return rows.map(rowToReceipt);
    },

    async readMemberReceipts(
      memberId: string,
      cursor: string | null,
      limit: number,
    ): Promise<Page<string>> {
      const rows = db
        .prepare(
          `SELECT receipt_id FROM auto_commit_receipt_members
            WHERE member_id = ? AND receipt_id > ?
            ORDER BY receipt_id ASC
            LIMIT ?`,
        )
        .all(memberId, cursor ?? "", limit) as { receipt_id: string }[];
      const last = rows[rows.length - 1];
      return {
        items: rows.map((row) => row.receipt_id),
        nextCursor: rows.length === limit && last ? last.receipt_id : null,
      };
    },

    async readReceiptMembers(
      receiptId: string,
      cursor: string | null,
      limit: number,
    ): Promise<Page<CommitMemberRecord>> {
      const rows = db
        .prepare(
          `SELECT m.* FROM auto_commit_receipt_members rm
            JOIN auto_commit_members m ON m.member_id = rm.member_id
            WHERE rm.receipt_id = ? AND rm.member_id > ?
            ORDER BY rm.member_id ASC
            LIMIT ?`,
        )
        .all(receiptId, cursor ?? "", limit) as MemberRow[];
      const last = rows[rows.length - 1];
      return {
        items: rows.map(rowToMember),
        nextCursor: rows.length === limit && last ? last.member_id : null,
      };
    },

    async acquireStreamReservation(
      streamId: string,
      ownerId: string,
      ttlMs: number,
      now: number,
    ): Promise<StreamReservation | undefined> {
      return txAcquireReservation.immediate(streamId, ownerId, ttlMs, now) as
        StreamReservation | undefined;
    },

    async renewStreamReservation(
      streamId: string,
      token: string,
      ttlMs: number,
      now: number,
    ): Promise<boolean> {
      return txRenewReservation.immediate(
        streamId,
        token,
        ttlMs,
        now,
      ) as boolean;
    },

    async releaseStreamReservation(
      streamId: string,
      token: string,
      _now: number,
    ): Promise<void> {
      txReleaseReservation.immediate(streamId, token);
    },

    async updateStreamHead(
      streamId: string,
      expectedVersion: number,
      update: StreamHeadUpdate,
      _now: number,
    ): Promise<boolean> {
      return txUpdateStreamHead.immediate(
        streamId,
        expectedVersion,
        update,
      ) as boolean;
    },

    async rotateWorkspaceFairness(
      workspaceId: string,
      _now: number,
    ): Promise<void> {
      txRotateFairness.immediate(workspaceId);
    },

    async sealBatch(input: SealBatchInput): Promise<SealBatchResult> {
      return txSealBatch.immediate(input) as SealBatchResult;
    },

    async claimDispatch(
      now: number,
      ownerId: string,
      limit: number,
    ): Promise<readonly ClaimedDispatch[]> {
      return txClaimDispatch.immediate(
        now,
        ownerId,
        limit,
      ) as readonly ClaimedDispatch[];
    },

    async confirmDispatch(
      batchId: string,
      claimToken: string,
      now: number,
    ): Promise<void> {
      txConfirmDispatch.immediate(batchId, claimToken, now);
    },

    async abortDispatch(
      batchId: string,
      claimToken: string,
      nextAttemptAt: number,
      _now: number,
    ): Promise<void> {
      txAbortDispatch.immediate(batchId, claimToken, nextAttemptAt);
    },

    async startBatchExecution(
      batchId: string,
      ownerId: string,
      ttlMs: number,
      now: number,
      limits = { global: 1, workspace: 1 },
    ): Promise<string | undefined> {
      return txStartExecution.immediate(
        batchId,
        ownerId,
        ttlMs,
        now,
        limits,
      ) as string | undefined;
    },

    async deferBatchExecution(
      batchId: string,
      nextAttemptAt: number,
    ): Promise<void> {
      // Requeue a dispatched-but-not-started batch without consuming an
      // execution attempt (schedule-window deferral); running batches are
      // untouched. Mirrors the failBatch retry branch minus the error path.
      db.transaction(() => {
        const batch = stmtBatchById.get(batchId) as BatchRow | undefined;
        if (!batch || batch.status !== "queued") return;
        db.prepare(
          `UPDATE auto_commit_batches
            SET status = 'retry_wait', retry_not_before = ?, lease_expiry = NULL
          WHERE batch_id = ?`,
        ).run(nextAttemptAt, batchId);
        db.prepare(
          `INSERT INTO auto_commit_outbox (batch_id, status, next_attempt_at, claim_token, claim_expiry)
         VALUES (?, 'pending', ?, NULL, NULL)
         ON CONFLICT(batch_id) DO UPDATE SET
           status = 'pending', next_attempt_at = excluded.next_attempt_at,
           claim_token = NULL, claim_expiry = NULL`,
        ).run(batchId, nextAttemptAt);
        recomputeStreamNotBefore(batch.stream_id);
      }).immediate();
    },

    async checkpointBatchExecution(
      batchId: string,
      token: string,
      checkpoint: BatchExecutionCheckpoint,
      now: number,
    ): Promise<boolean> {
      const json = JSON.stringify(checkpoint);
      if (Buffer.byteLength(json) > 1_048_576)
        throw new RangeError("Execution checkpoint exceeds 1 MiB");
      return db
        .transaction(() => {
          const batch = stmtBatchById.get(batchId) as BatchRow | undefined;
          if (
            !batch ||
            batch.status !== "running" ||
            batch.lease_token !== token ||
            (batch.lease_expiry ?? 0) <= now
          )
            return false;
          db.prepare(
            "UPDATE auto_commit_batches SET execution_checkpoint = ? WHERE batch_id = ?",
          ).run(json, batchId);
          return true;
        })
        .immediate();
    },

    async renewBatchLease(
      batchId: string,
      token: string,
      ttlMs: number,
      now: number,
    ): Promise<boolean> {
      return txRenewLease.immediate(batchId, token, ttlMs, now) as boolean;
    },

    async completeBatch(
      batchId: string,
      token: string,
      completion: BatchCompletion,
      now: number,
    ): Promise<void> {
      txCompleteBatch.immediate(batchId, token, completion, now);
    },

    async failBatch(
      batchId: string,
      token: string,
      error: string,
      retryNotBefore: number | null,
      dead: boolean,
      now: number,
    ): Promise<void> {
      txFailBatch.immediate(batchId, token, error, retryNotBefore, dead, now);
    },

    async reclaimExpiredBatchLeases(
      now: number,
      limit: number,
    ): Promise<readonly string[]> {
      return txReclaimLeases.immediate(now, limit) as readonly string[];
    },

    async readBatch(batchId: string): Promise<CommitBatchRecord | undefined> {
      const row = stmtBatchById.get(batchId) as BatchRow | undefined;
      return row ? rowToBatch(row) : undefined;
    },

    async getReceipt(
      receiptId: string,
    ): Promise<ReceiptQueryResult | undefined> {
      const receipt = stmtReceiptById.get(receiptId) as ReceiptRow | undefined;
      if (!receipt) return undefined;
      const rows = db
        .prepare(
          `SELECT m.status AS status, COUNT(*) AS count
             FROM auto_commit_receipt_members rm
             JOIN auto_commit_members m ON m.member_id = rm.member_id
            WHERE rm.receipt_id = ?
            GROUP BY m.status`,
        )
        .all(receiptId) as { status: string; count: number }[];
      const counts: Record<string, number> = {
        pending: 0,
        batched: 0,
        completed: 0,
        skipped: 0,
        dead: 0,
        failed: 0,
      };
      for (const row of rows) {
        counts[row.status] = row.count;
      }
      return {
        receipt: rowToReceipt(receipt),
        memberCounts: counts as ReceiptQueryResult["memberCounts"],
      };
    },

    async readNextWake(): Promise<NextWake | undefined> {
      let best: NextWake | undefined;
      const consider = (at: number | null, reason: NextWake["reason"]) => {
        if (at === null) return;
        if (!best || at < best.at) {
          best = { at, reason };
        }
      };
      const headWake = db
        .prepare(
          `SELECT MIN(not_before) AS at FROM auto_commit_workspace_heads`,
        )
        .get() as {
        at: number | null;
      };
      consider(headWake.at, "delay");
      const routingWake = db.prepare(
        `SELECT MIN(COALESCE(next_attempt_at, first_accepted_at)) AS at
           FROM auto_commit_routing_receipts WHERE completed_at IS NULL AND terminal_error IS NULL`,
      ).get() as { at: number | null };
      consider(routingWake.at, "routing_resolution");
      const outboxWake = db
        .prepare(
          `SELECT MIN(next_attempt_at) AS at FROM auto_commit_outbox WHERE status = 'pending'`,
        )
        .get() as { at: number | null };
      consider(outboxWake.at, "outbox_dispatch");
      const leaseWake = db
        .prepare(
          `SELECT MIN(lease_expiry) AS at FROM auto_commit_batches WHERE status IN ('running', 'queued')`,
        )
        .get() as { at: number | null };
      consider(leaseWake.at, "lease_reclaim");
      return best;
    },

    close(): void {
      db.close();
    },
  };
}
