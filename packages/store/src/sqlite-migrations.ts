import {
  createSqliteMigrationStore,
  sqliteSqlStep,
  type MigrationStore,
  type NamespaceMigrationPlan,
  type SqliteMigrationDatabase,
} from "@aicr/core";

import { STORE_SQLITE_MIGRATIONS } from "./database.js";

/** Preserve the shipped name-only ledger; do not invent historical checksums. */
export const SQLITE_STORE_MIGRATION_PLAN: NamespaceMigrationPlan = {
  namespace: "store",
  targetVersion: STORE_SQLITE_MIGRATIONS.length,
  steps: STORE_SQLITE_MIGRATIONS.map((step, index) => sqliteSqlStep(step.name, index, index + 1, step.sql)),
};

/** Both namespaces share one connection and one BEGIN IMMEDIATE transaction. */
export function createSqliteApplicationMigrationStore(db: SqliteMigrationDatabase): MigrationStore {
  const configStore = createSqliteMigrationStore(db);
  const exists = (name: string): boolean => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  return {
    ...configStore,
    ledgerExists: () => Promise.resolve(exists("_migrations") || exists("schema_migrations")),
    async ensureLedger() {
      await configStore.ensureLedger();
      db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )`);
    },
    async readApplied(namespace) {
      if (namespace !== "store") return exists("schema_migrations") ? configStore.readApplied(namespace) : [];
      if (!exists("_migrations")) return [];
      const rows = db.prepare("SELECT name, applied_at FROM _migrations ORDER BY name").all() as { name: string; applied_at: number }[];
      return rows.map((row, index) => {
        const known = SQLITE_STORE_MIGRATION_PLAN.steps.find((step) => step.id === row.name);
        return {
          id: row.name, checksum: null,
          fromVersion: known?.fromVersion ?? index,
          toVersion: known?.toVersion ?? index + 1,
          appVersion: null, appliedAt: row.applied_at,
        };
      });
    },
    async recordApplied(namespace, step, appVersion, now) {
      if (namespace !== "store") return configStore.recordApplied(namespace, step, appVersion, now);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(step.id, now);
    },
  };
}
