/** Read-only status/check and explicit upgrades for both deployment namespaces. */
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import {
  computeNamespaceMigrationStatus, ConfigError, createConfigStoreMigrationPlan,
  createPgConfigMigrationStore, createPgConfigStoreMigrationPlan, loadConfigFile,
  MigrationRunner, type NamespaceMigrationStatus, type PgConfigMigrationClient,
  type SqliteMigrationDatabase,
} from "@aicr/core";
import { createSqliteApplicationMigrationStore, SQLITE_STORE_MIGRATION_PLAN, STORE_MIGRATION_PLAN } from "@aicr/store";

export const MIGRATE_EXIT = { ok: 0, pending: 1, unsafe: 2 } as const;

export interface MigrateCommandOptions {
  readonly cwd: string;
  readonly configPath?: string | undefined;
  readonly mode: "status" | "check" | "apply";
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

function renderStatus(statuses: readonly NamespaceMigrationStatus[]): string {
  return JSON.stringify(statuses.map((status) => ({
    namespace: status.namespace, currentVersion: status.currentVersion,
    targetVersion: status.targetVersion, applied: status.appliedIds,
    pending: status.pendingIds, drifted: status.driftedIds,
    unknownHigherVersion: status.unknownHigherVersion,
  })), null, 2) + "\n";
}

function report(options: MigrateCommandOptions, statuses: readonly NamespaceMigrationStatus[]): number {
  options.stdout.write(renderStatus(statuses));
  if (options.mode === "status") return MIGRATE_EXIT.ok;
  for (const status of statuses) {
    if (status.driftedIds.length > 0 || status.unknownHigherVersion !== null) {
      options.stderr.write('aicr migrate: unsafe migration ledger in namespace "' + status.namespace + '" (drift or newer schema).\n');
      return MIGRATE_EXIT.unsafe;
    }
  }
  return statuses.some((status) => status.pendingIds.length > 0) ? MIGRATE_EXIT.pending : MIGRATE_EXIT.ok;
}

async function execute(options: MigrateCommandOptions, runner: MigrationRunner): Promise<number> {
  if (options.mode !== "apply") return report(options, await runner.status());
  const result = await runner.apply();
  const applied = Object.entries(result.appliedByNamespace)
    .filter(([, ids]) => ids.length > 0)
    .map(([namespace, ids]) => namespace + ": " + ids.join(", "));
  options.stdout.write(renderStatus(result.statuses));
  options.stdout.write(applied.length > 0 ? "applied: " + applied.join("; ") + "\n" : "already up to date\n");
  return MIGRATE_EXIT.ok;
}

export async function runMigrateCommand(options: MigrateCommandOptions): Promise<number> {
  try {
    const config = await loadConfigFile(resolve(options.cwd, options.configPath ?? "config.yaml"));
    const database = config.storage.database;
    const coreRequire = createRequire(createRequire(import.meta.url).resolve("@aicr/core"));
    if (database.kind === "sqlite") {
      const plans = [createConfigStoreMigrationPlan(), SQLITE_STORE_MIGRATION_PLAN];
      const path = resolve(options.cwd, database.sqlite.path);
      if (options.mode !== "apply" && !existsSync(path)) {
        return report(options, plans.map((plan) => computeNamespaceMigrationStatus(plan.namespace, plan, [])));
      }
      if (options.mode === "apply") mkdirSync(dirname(path), { recursive: true });
      type Database = SqliteMigrationDatabase & { pragma(sql: string): unknown; close(): void };
      const Sqlite = coreRequire("better-sqlite3") as new (path: string, options: { readonly: boolean }) => Database;
      const db = new Sqlite(path, { readonly: options.mode !== "apply" });
      try {
        db.pragma("busy_timeout = 5000");
        return await execute(options, new MigrationRunner(createSqliteApplicationMigrationStore(db), plans));
      } finally { db.close(); }
    }
    const postgres = database.postgres;
    const url = (postgres?.url_env ? process.env[postgres.url_env] : undefined)
      ?? (typeof postgres?.url === "string" ? postgres.url : undefined);
    if (!url) throw new ConfigError("store_unavailable", "PostgreSQL migration requires postgres.url_env or postgres.url.");
    type Client = PgConfigMigrationClient & { connect(): Promise<void>; end(): Promise<void> };
    const { Client } = coreRequire("pg") as { Client: new (options: { connectionString: string; connectionTimeoutMillis: number }) => Client };
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      // Both namespaces share a transaction and the startup advisory lock.
      return await execute(options, new MigrationRunner(createPgConfigMigrationStore(client), [createPgConfigStoreMigrationPlan(), STORE_MIGRATION_PLAN]));
    } finally { await client.end(); }
  } catch (error) {
    // Driver failures may contain credentials; expose authored errors only.
    options.stderr.write("aicr migrate " + options.mode + ": " + (error instanceof ConfigError ? error.message : "Could not access or migrate the database; check connection, permissions and schema.") + "\n");
    return MIGRATE_EXIT.unsafe;
  }
}
