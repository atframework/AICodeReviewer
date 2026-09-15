/**
 * better-sqlite3 executor for the MigrationRunner contract.
 *
 * Owns the shared `schema_migrations` ledger table. Every apply batch runs
 * inside one BEGIN IMMEDIATE transaction, which is both the migration lock
 * (the WAL writer lock serializes processes) and the atomicity boundary
 * (M04/M06): a crash leaves the whole batch rolled back, never a recorded
 * step without its DDL or vice versa.
 */

import { createHash } from "node:crypto";

import type {
  AppliedMigration,
  MigrationStep,
  MigrationStore,
} from "./migration-runner.js";

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Minimal shape of a better-sqlite3 database the executor relies on. */
export interface SqliteMigrationDatabase {
  exec(source: string): unknown;
  prepare(source: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T & { immediate: T };
  /** True while a transaction is open on this connection. */
  readonly inTransaction: boolean;
}

export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

interface LedgerRow {
  id: string;
  checksum: string | null;
  from_version: number;
  to_version: number;
  app_version: string | null;
  applied_at: number;
  min_reader_protocol?: number;
  min_writer_protocol?: number;
  transaction_mode?: "atomic";
}

/** Builds a SQL step whose checksum pins the body (M16 drift detection). */
export function sqliteSqlStep(id: string, fromVersion: number, toVersion: number, sql: string, description?: string): MigrationStep {
  return {
    id,
    fromVersion,
    toVersion,
    checksum: createHash("sha256").update(`${id}\n${sql}`).digest("hex"),
    description,
    payload: { sql },
    minReaderProtocol: 1,
    minWriterProtocol: 1,
    transactionMode: "atomic",
  };
}

function sqlOf(step: MigrationStep): string {
  const payload = step.payload as { sql?: unknown } | undefined;
  if (payload === undefined || typeof payload.sql !== "string") {
    throw new Error(`sqlite migration store cannot apply non-SQL step "${step.id}"`);
  }
  return payload.sql;
}

export function createSqliteMigrationStore(db: SqliteMigrationDatabase): MigrationStore {
  return {
    backendKind: "sqlite",

    ledgerExists() {
      return Promise.resolve(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(SCHEMA_MIGRATIONS_TABLE) !== undefined);
    },

    ensureLedger() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
          namespace TEXT NOT NULL,
          id TEXT NOT NULL,
          checksum TEXT,
          from_version INTEGER NOT NULL,
          to_version INTEGER NOT NULL,
          app_version TEXT,
          applied_at INTEGER NOT NULL,
          PRIMARY KEY (namespace, id)
        );
      `);
      const columns = new Set((db.prepare(`PRAGMA table_info(${SCHEMA_MIGRATIONS_TABLE})`).all() as { name: string }[]).map(row => row.name));
      for (const [name, declaration] of [
        ["min_reader_protocol", "INTEGER NOT NULL DEFAULT 1"],
        ["min_writer_protocol", "INTEGER NOT NULL DEFAULT 1"],
        ["transaction_mode", "TEXT NOT NULL DEFAULT 'atomic'"],
      ] as const) {
        if (!columns.has(name)) db.exec(`ALTER TABLE ${SCHEMA_MIGRATIONS_TABLE} ADD COLUMN ${name} ${declaration}`);
      }
      return Promise.resolve();
    },

    readApplied(namespace) {
      const rows = db.prepare(
        `SELECT *
           FROM ${SCHEMA_MIGRATIONS_TABLE}
          WHERE namespace = ?
          ORDER BY to_version ASC`,
      ).all(namespace) as LedgerRow[];
      return Promise.resolve(rows.map((row): AppliedMigration => ({
        id: row.id,
        checksum: row.checksum,
        fromVersion: row.from_version,
        toVersion: row.to_version,
        appVersion: row.app_version,
        appliedAt: row.applied_at,
        ...(row.min_reader_protocol !== undefined ? { minReaderProtocol: row.min_reader_protocol } : {}),
        ...(row.min_writer_protocol !== undefined ? { minWriterProtocol: row.min_writer_protocol } : {}),
        ...(row.transaction_mode !== undefined ? { transactionMode: row.transaction_mode } : {}),
      })));
    },

    async withMigrationLock(fn) {
      // Explicit boundaries, NOT db.transaction(fn): that helper is a
      // synchronous wrapper and would COMMIT at fn's first await, dropping
      // later DDL outside the transaction. All executor SQL below still
      // executes synchronously at call time, and BEGIN IMMEDIATE holds the
      // WAL write lock for the whole batch — a crash mid-batch rolls back,
      // a concurrent winner is observed on the in-lock ledger re-read (M04).
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        // SQLite may have already rolled back on its own (IOERR/FULL); a
        // second ROLLBACK would mask the original migration error (M05/M06).
        if (db.inTransaction) {
          db.exec("ROLLBACK");
        }
        throw error;
      }
    },

    applyStep(step) {
      db.exec(sqlOf(step));
      return Promise.resolve();
    },

    recordApplied(namespace, step, appVersion, now) {
      db.prepare(
        `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}
           (namespace, id, checksum, from_version, to_version, app_version, applied_at, min_reader_protocol, min_writer_protocol, transaction_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(namespace, step.id, step.checksum, step.fromVersion, step.toVersion, appVersion, now,
        step.minReaderProtocol ?? 1, step.minWriterProtocol ?? 1, step.transactionMode ?? "atomic");
      return Promise.resolve();
    },
  };
}
