import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  QueueBackoffConfig,
  QueueDequeueOptions,
  QueueEnqueueOptions,
  QueueJob,
  QueueJobStatus,
  QueueStats,
  ReviewQueue,
} from "./queue.js";
import { computeBackoffDelay, DEFAULT_MAX_ATTEMPTS, DEFAULT_QUEUE_BACKOFF } from "./queue.js";

export interface SqliteQueueOptions {
  readonly path: string;
  readonly lockTtlSeconds?: number;
}

const RECLAIM_INTERVAL_MS = 5000;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS review_queue_jobs (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    trigger_name TEXT NOT NULL,
    data TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
    status TEXT NOT NULL DEFAULT 'queued',
    enqueued_at INTEGER NOT NULL,
    started_at INTEGER,
    available_at INTEGER,
    last_error TEXT,
    worker_id TEXT,
    backoff TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_review_queue_seq
    ON review_queue_jobs(seq);
  CREATE INDEX IF NOT EXISTS idx_review_queue_status
    ON review_queue_jobs(status, available_at);
  CREATE INDEX IF NOT EXISTS idx_review_queue_workspace
    ON review_queue_jobs(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_review_queue_reclaim
    ON review_queue_jobs(status, started_at) WHERE status = 'running';
`;

interface QueueRow {
  id: string;
  workspace_id: string;
  trigger_name: string;
  data: string;
  attempt: number;
  max_attempts: number;
  status: string;
  enqueued_at: number;
  started_at: number | null;
  available_at: number | null;
  last_error: string | null;
  worker_id: string | null;
  backoff: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDb = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteStmt = any;

async function loadBetterSqlite3(): Promise<SqliteModule> {
  try {
    const mod = await import("better-sqlite3");
    return (mod as { default?: SqliteModule }).default ?? (mod as unknown as SqliteModule);
  } catch {
    throw new Error(
      "better-sqlite3 is not installed. Install it with: pnpm add better-sqlite3\n" +
        "SQLite queue requires the better-sqlite3 package.",
    );
  }
}

function rowToJob<T = unknown>(row: QueueRow): QueueJob<T> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    triggerName: row.trigger_name,
    data: JSON.parse(row.data) as T,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    status: row.status as QueueJobStatus,
    enqueuedAt: row.enqueued_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  };
}

export async function createSqliteQueue(options: SqliteQueueOptions): Promise<ReviewQueue> {
  const Database = await loadBetterSqlite3();
  const dir = dirname(options.path);
  mkdirSync(dir, { recursive: true });

  const db: SqliteDb = new Database(options.path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  db.exec(SCHEMA_SQL);

  const lockTtlMs = (options.lockTtlSeconds ?? 300) * 1000;
  const reclaimIntervalMs = Math.min(RECLAIM_INTERVAL_MS, Math.floor(lockTtlMs / 2));

  const stmtEnqueue = db.prepare(
    `INSERT INTO review_queue_jobs (id, seq, workspace_id, trigger_name, data, attempt, max_attempts, status, enqueued_at, backoff)
     VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM review_queue_jobs), @workspace_id, @trigger_name, @data, 0, @max_attempts, 'queued', @enqueued_at, @backoff)
     RETURNING *`,
  );
  const stmtGet = db.prepare(`SELECT * FROM review_queue_jobs WHERE id = ?`);
  const stmtComplete = db.prepare(
    `UPDATE review_queue_jobs SET status = 'completed' WHERE id = ? AND status = 'running'`,
  );
  const stmtRequeueRetry = db.prepare(
    `UPDATE review_queue_jobs
       SET status = 'queued', last_error = ?, available_at = ?, started_at = NULL, worker_id = NULL
     WHERE id = ? AND status = 'running'`,
  );
  const stmtDeadLetter = db.prepare(
    `UPDATE review_queue_jobs SET status = 'dead', last_error = ?, worker_id = NULL
     WHERE id = ? AND status = 'running'`,
  );
  const stmtStats = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
     FROM review_queue_jobs`,
  );
  const stmtDeadJobs = db.prepare(`SELECT * FROM review_queue_jobs WHERE status = 'dead'`);
  const stmtResetDead = db.prepare(
    `UPDATE review_queue_jobs
       SET status = 'queued', attempt = 0, last_error = NULL, started_at = NULL, worker_id = NULL, available_at = NULL
     WHERE id = ? AND status = 'dead'`,
  );
  const stmtPurgeDeadAll = db.prepare(`DELETE FROM review_queue_jobs WHERE status = 'dead'`);
  const stmtPurgeDeadAged = db.prepare(
    `DELETE FROM review_queue_jobs WHERE status = 'dead' AND enqueued_at <= ?`,
  );
  const stmtReclaimStale = db.prepare(
    `UPDATE review_queue_jobs
       SET status = 'queued', worker_id = NULL, started_at = NULL, available_at = @now
     WHERE status = 'running' AND started_at IS NOT NULL AND started_at <= @cutoff`,
  );

  const claimStmtCache = new Map<number, SqliteStmt>();
  function getClaimStmt(excludedCount: number): SqliteStmt {
    let stmt = claimStmtCache.get(excludedCount);
    if (stmt) return stmt;

    const excludeClause = excludedCount === 0
      ? "1 = 1"
      : `workspace_id NOT IN (${Array.from({ length: excludedCount }, () => "?").join(", ")})`;

    stmt = db.prepare(
      `UPDATE review_queue_jobs
         SET status = 'running', worker_id = ?, started_at = ?, attempt = attempt + 1
       WHERE id = (
         SELECT id FROM review_queue_jobs
           WHERE status = 'queued'
             AND (available_at IS NULL OR available_at <= ?)
             AND ${excludeClause}
           ORDER BY seq
           LIMIT 1
       )
       RETURNING *`,
    );
    claimStmtCache.set(excludedCount, stmt);
    return stmt;
  }

  let lastReclaimMs = 0;

  function maybeReclaim(now: number): void {
    if (now - lastReclaimMs < reclaimIntervalMs) return;
    lastReclaimMs = now;
    stmtReclaimStale.run({ now, cutoff: now - lockTtlMs });
  }

  return {
    kind: "sqlite",

    async enqueue<T>(data: T, opts: QueueEnqueueOptions): Promise<QueueJob<T>> {
      const id = randomUUID();
      const now = Date.now();
      const backoff = opts.backoff ?? DEFAULT_QUEUE_BACKOFF;
      const row = stmtEnqueue.get({
        id,
        workspace_id: opts.workspaceId,
        trigger_name: opts.triggerName,
        data: JSON.stringify(data),
        max_attempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        enqueued_at: now,
        backoff: JSON.stringify(backoff),
      }) as QueueRow;
      return rowToJob<T>(row);
    },

    async dequeue(
      workerId: string,
      _concurrencyLimit?: number,
      options?: QueueDequeueOptions,
    ): Promise<QueueJob | undefined> {
      const now = Date.now();
      maybeReclaim(now);

      const excluded = options?.excludedWorkspaceIds ?? [];
      const claimStmt = getClaimStmt(excluded.length);
      const params: (string | number)[] = [workerId, now, now, ...excluded];
      const row = claimStmt.get(...params) as QueueRow | undefined;
      if (!row) {
        return undefined;
      }
      return rowToJob(row);
    },

    async complete(jobId: string): Promise<void> {
      stmtComplete.run(jobId);
    },

    async fail(jobId: string, error: Error): Promise<void> {
      const row = stmtGet.get(jobId) as QueueRow | undefined;
      if (!row) return;
      if (row.status !== "running") return;

      const job = rowToJob(row);
      if (job.attempt < job.maxAttempts) {
        const backoff = row.backoff ? (JSON.parse(row.backoff) as QueueBackoffConfig) : DEFAULT_QUEUE_BACKOFF;
        const delay = computeBackoffDelay(job.attempt, backoff);
        const availableAt = delay > 0 ? Date.now() + delay : null;
        stmtRequeueRetry.run(error.message, availableAt, jobId);
      } else {
        stmtDeadLetter.run(error.message, jobId);
      }
    },

    async getStats(): Promise<QueueStats> {
      const row = stmtStats.get() as {
        queued: number | null;
        running: number | null;
        completed: number | null;
        failed: number | null;
        dead: number | null;
      };
      return {
        queued: row.queued ?? 0,
        running: row.running ?? 0,
        completed: row.completed ?? 0,
        failed: row.failed ?? 0,
        dead: row.dead ?? 0,
      };
    },

    async getJob(jobId: string): Promise<QueueJob | undefined> {
      const row = stmtGet.get(jobId) as QueueRow | undefined;
      if (!row) return undefined;
      return rowToJob(row);
    },

    async getDeadJobs(): Promise<readonly QueueJob[]> {
      const rows = stmtDeadJobs.all() as QueueRow[];
      return rows.map(rowToJob);
    },

    async requeueDead(jobId: string): Promise<QueueJob | undefined> {
      const result = stmtResetDead.run(jobId);
      if (result.changes === 0) return undefined;
      const row = stmtGet.get(jobId) as QueueRow | undefined;
      if (!row) return undefined;
      return rowToJob(row);
    },

    async purgeDead(maxAgeMs?: number): Promise<number> {
      if (maxAgeMs === undefined) {
        return stmtPurgeDeadAll.run().changes;
      }
      const cutoff = Date.now() - maxAgeMs;
      return stmtPurgeDeadAged.run(cutoff).changes;
    },

    close(): void {
      db.close();
    },
  };
}

