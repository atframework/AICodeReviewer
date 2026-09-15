import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { isConfigError } from "../src/config-format.js";
import { MigrationRunner } from "../src/migration-runner.js";
import type { AppliedMigration, MigrationStore, NamespaceMigrationPlan } from "../src/migration-runner.js";
import { createSqliteMigrationStore, sqliteSqlStep } from "../src/sqlite-migration-store.js";

const execFileAsync = promisify(execFile);

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(source: string): unknown;
  prepare(source: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T & { immediate: T };
  close(): void;
}
interface SqliteModule {
  new (path: string): SqliteDatabase;
}

// better-sqlite3 is an optionalDependency (native build may be absent); the
// dynamic import mirrors the production loader and fails only here if missing.
async function openDb(path: string): Promise<SqliteDatabase> {
  const mod = (await import("better-sqlite3")) as unknown as { default: SqliteModule };
  return new mod.default(path);
}

const tempDirs: string[] = [];
const openDbs: SqliteDatabase[] = [];

afterAll(async () => {
  for (const db of openDbs) db.close();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function freshDb(): Promise<SqliteDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "aicr-migrations-"));
  tempDirs.push(dir);
  const db = await openDb(join(dir, "m.sqlite"));
  openDbs.push(db);
  return db;
}

const T0 = 1_800_000_000_000;

function plan(namespace = "store", sql?: string): NamespaceMigrationPlan {
  const stem = namespace.replace(/[^a-z0-9_]/gi, "_");
  return {
    namespace,
    targetVersion: 2,
    steps: [
      sqliteSqlStep("001_first", 0, 1, sql ?? `CREATE TABLE ${stem}_one (id TEXT);`),
      sqliteSqlStep("002_second", 1, 2, `CREATE TABLE ${stem}_two (id TEXT);`),
    ],
  };
}

describe("MigrationRunner (sqlite executor)", () => {
  it("persists protocol requirements and rejects an incompatible reader or writer before DDL", async () => {
    const db = await freshDb();
    const future = { namespace: "config", targetVersion: 1,
      steps: [{ ...sqliteSqlStep("001_future", 0, 1, "CREATE TABLE future_data (id TEXT)"), minReaderProtocol: 2, minWriterProtocol: 3 }] };
    const oldReader = new MigrationRunner(createSqliteMigrationStore(db), [future], { protocol: { reader: 1, writer: 3 } });
    const oldWriter = new MigrationRunner(createSqliteMigrationStore(db), [future], { protocol: { reader: 2, writer: 2 } });
    for (const runner of [oldReader, oldWriter]) {
      await expect(runner.apply()).rejects.toMatchObject({ code: "schema_version_unsupported" });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    }
    const compatible = new MigrationRunner(createSqliteMigrationStore(db), [future], { protocol: { reader: 2, writer: 3 } });
    await compatible.apply();
    expect(db.prepare("SELECT min_reader_protocol, min_writer_protocol, transaction_mode FROM schema_migrations").get())
      .toEqual({ min_reader_protocol: 2, min_writer_protocol: 3, transaction_mode: "atomic" });
    await expect(oldWriter.check()).rejects.toMatchObject({ code: "schema_version_unsupported" });
    expect((await compatible.status())[0]?.protocol.compatible).toBe(true);
  });

  it("adds protocol metadata to a legacy ledger without changing its SQL checksum", async () => {
    const db = await freshDb();
    const p = plan();
    db.exec("CREATE TABLE schema_migrations(namespace TEXT,id TEXT,checksum TEXT,from_version INTEGER,to_version INTEGER,app_version TEXT,applied_at INTEGER, PRIMARY KEY(namespace,id))");
    db.exec(String((p.steps[0]!.payload as { sql: string }).sql));
    db.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?,?,?,?)").run("store", p.steps[0]!.id, p.steps[0]!.checksum, 0, 1, "historical", T0);
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [p]);
    expect((await runner.check()).needsMigration).toEqual(["store"]);
    expect(db.prepare("PRAGMA table_info(schema_migrations)").all()).toHaveLength(7);
    await runner.apply();
    const rows = db.prepare("SELECT checksum,min_reader_protocol,min_writer_protocol FROM schema_migrations ORDER BY to_version").all();
    expect(rows).toEqual(p.steps.map(step => ({ checksum: step.checksum, min_reader_protocol: 1, min_writer_protocol: 1 })));
    db.prepare("UPDATE schema_migrations SET min_writer_protocol=2 WHERE id=?").run(p.steps[0]!.id);
    await expect(runner.apply()).rejects.toMatchObject({ code: "schema_version_unsupported" });
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid protocol requirement %s before opening a store", (minReaderProtocol) => {
    const p = plan();
    expect(() => new MigrationRunner({} as MigrationStore, [{ ...p, steps: [{ ...p.steps[0]!, minReaderProtocol }, p.steps[1]!] }]))
      .toThrowError(expect.objectContaining({ code: "migration_failed" }));
  });

  it("rejects nontransactional migration bodies rather than claiming atomic execution", () => {
    const p = plan();
    const unsupported = { ...p.steps[0]!, transactionMode: "nontransactional" } as unknown as typeof p.steps[number];
    expect(() => new MigrationRunner({} as MigrationStore, [{ ...p, steps: [unsupported, p.steps[1]!] }]))
      .toThrowError(expect.objectContaining({ code: "migration_failed" }));
  });
  it("applies pending steps and reports status (M01)", async () => {
    const db = await freshDb();
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [plan()], { now: () => T0 });

    const before = await runner.status();
    expect(before[0]?.pendingIds).toEqual(["001_first", "002_second"]);
    expect(before[0]?.currentVersion).toBe(0);

    const result = await runner.apply();
    expect(result.appliedByNamespace["store"]).toEqual(["001_first", "002_second"]);

    const after = await runner.status();
    expect(after[0]?.currentVersion).toBe(2);
    expect(after[0]?.pendingIds).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'store_two'").all()).toHaveLength(1);

    // Re-apply is a no-op (M06 restart idempotence).
    const again = await runner.apply();
    expect(again.appliedByNamespace["store"]).toEqual([]);
  });

  it("records ledger rows with app version and timestamp", async () => {
    const db = await freshDb();
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [plan()], {
      appVersion: "1.2.3",
      now: () => T0,
    });
    await runner.apply();
    const rows = db.prepare("SELECT * FROM schema_migrations WHERE namespace = 'store' ORDER BY to_version").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.["app_version"]).toBe("1.2.3");
    expect(rows[0]?.["applied_at"]).toBe(T0);
    expect(typeof rows[0]?.["checksum"]).toBe("string");
  });

  it("check() reports pending namespaces and stays clean afterwards (M17 --check)", async () => {
    const db = await freshDb();
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [plan()]);
    const dirty = await runner.check();
    expect(dirty.ok).toBe(true);
    expect(dirty.needsMigration).toEqual(["store"]);
    await runner.apply();
    const clean = await runner.check();
    expect(clean.needsMigration).toEqual([]);
  });

  it("refuses drifted checksums instead of writing (M16)", async () => {
    const db = await freshDb();
    await new MigrationRunner(createSqliteMigrationStore(db), [plan()]).apply();
    // Tamper with the recorded checksum: the program no longer matches.
    db.prepare("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE id = '001_first'").run();
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [plan()]);
    await expect(runner.apply()).rejects.toSatisfy((error) => isConfigError(error, "schema_version_unsupported"));
    await expect(runner.check()).rejects.toSatisfy((error) => isConfigError(error, "schema_version_unsupported"));
  });

  it("refuses an unknown higher version from a newer program (M16)", async () => {
    const db = await freshDb();
    await new MigrationRunner(createSqliteMigrationStore(db), [plan()]).apply();
    db.prepare(
      `INSERT INTO schema_migrations (namespace, id, checksum, from_version, to_version, app_version, applied_at)
       VALUES ('store', '099_future', 'abc', 2, 99, '9.9.9', 1)`,
    ).run();
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [plan()]);
    await expect(runner.apply()).rejects.toSatisfy((error) => isConfigError(error, "schema_version_unsupported"));
  });

  it("bridged legacy rows without checksum are grandfathered (M16)", async () => {
    const db = await freshDb();
    await new MigrationRunner(createSqliteMigrationStore(db), [plan()]).apply();
    // Simulate a bridged _migrations row: known id, no checksum.
    db.prepare("UPDATE schema_migrations SET checksum = NULL WHERE id = '001_first'").run();
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [plan()]);
    const check = await runner.check();
    expect(check.ok).toBe(true);
    expect(check.needsMigration).toEqual([]);
  });

  it("rejects non-contiguous plans at construction", () => {
    const bad: NamespaceMigrationPlan = {
      namespace: "broken",
      targetVersion: 2,
      steps: [
        sqliteSqlStep("001_first", 0, 1, "CREATE TABLE a (id TEXT);"),
        sqliteSqlStep("003_gap", 2, 3, "CREATE TABLE b (id TEXT);"),
      ],
    };
    expect(() => new MigrationRunner(createSqliteMigrationStore({} as SqliteDatabase), [bad]))
      .toThrowError(/not contiguous/);
  });

  it("concurrent applies from two processes settle once (M04)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aicr-migrations-"));
    tempDirs.push(dir);
    const path = join(dir, "race.sqlite").replaceAll("\\", "/");

    // Real OS processes: better-sqlite3 blocks the event loop while waiting
    // on a lock, so an in-process Promise.all race would deadlock against
    // itself. Two booting aicr instances are the deployment scenario M04
    // covers; each prints its applied step ids as JSON.
    const script = `
      const { MigrationRunner } = await import("./packages/core/src/migration-runner.ts");
      const { createSqliteMigrationStore, sqliteSqlStep } = await import("./packages/core/src/sqlite-migration-store.ts");
      const { createRequire } = await import("node:module");
      const require = createRequire(process.cwd() + "/packages/core/package.json");
      const Database = require("better-sqlite3");
      const db = new Database(${JSON.stringify(path)});
      db.pragma("busy_timeout = 10000");
      const plan = { namespace: "store", targetVersion: 2, steps: [
        sqliteSqlStep("001_first", 0, 1, "CREATE TABLE store_one (id TEXT);"),
        sqliteSqlStep("002_second", 1, 2, "CREATE TABLE store_two (id TEXT);"),
      ]};
      const runner = new MigrationRunner(createSqliteMigrationStore(db), [plan]);
      const result = await runner.apply();
      console.log(JSON.stringify(result.appliedByNamespace["store"]));
      db.close();
    `;
    const runChild = () => execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 30_000,
    });
    const [a, b] = await Promise.all([runChild(), runChild()]);
    const appliedA = JSON.parse(a.stdout.trim()) as string[];
    const appliedB = JSON.parse(b.stdout.trim()) as string[];
    // The loser observed the winner's rows inside the lock and applied nothing.
    expect([...appliedA, ...appliedB]).toEqual(["001_first", "002_second"]);

    const { default: Database } = (await import("better-sqlite3")) as unknown as { default: SqliteModule };
    const verify = new Database(path);
    openDbs.push(verify);
    const rows = verify.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE namespace = 'store'").get() as { n: number };
    expect(rows.n).toBe(2);
  }, 60_000);

  it("a contender past its busy_timeout fails with a bounded SQLITE_BUSY-style error, never a hang (G6)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aicr-migrations-busy-"));
    tempDirs.push(dir);
    const path = join(dir, "busy.sqlite").replaceAll("\\", "/");

    // Child A holds BEGIN IMMEDIATE far longer than child B's busy_timeout.
    // better-sqlite3 blocks the event loop while waiting on a lock, so the
    // contention has to come from a real second process (same rationale as
    // the M04 race above). The busy_timeout seam is the connection pragma
    // the production stores set (createSqliteConfigStore:
    // `busy_timeout = options.busyTimeoutMs ?? 5000`); here the executor is
    // constructed directly over a connection tuned down to 500ms so the
    // bound is observable in test time.
    // Real wall-clock hold: SQLITE_BUSY contention against busy_timeout is
    // platform-clock behavior in a separate process, so fake timers cannot
    // stand in here.
    const holdScript = `
      const { createRequire } = await import("node:module");
      const require = createRequire(process.cwd() + "/packages/core/package.json");
      const Database = require("better-sqlite3");
      const db = new Database(${JSON.stringify(path)});
      db.pragma("busy_timeout = 10000");
      db.exec("BEGIN IMMEDIATE");
      db.exec("CREATE TABLE IF NOT EXISTS hold (id TEXT)");
      console.log("locked");
      process.stdin.resume();
      process.stdin.once("end", () => { db.exec("COMMIT"); db.close(); });
    `;
    const applyScript = `
      const { MigrationRunner } = await import("./packages/core/src/migration-runner.ts");
      const { createSqliteMigrationStore, sqliteSqlStep } = await import("./packages/core/src/sqlite-migration-store.ts");
      const { createRequire } = await import("node:module");
      const require = createRequire(process.cwd() + "/packages/core/package.json");
      const Database = require("better-sqlite3");
      const db = new Database(${JSON.stringify(path)});
      db.pragma("busy_timeout = 500");
      const plan = { namespace: "store", targetVersion: 2, steps: [
        sqliteSqlStep("001_first", 0, 1, "CREATE TABLE store_one (id TEXT);"),
        sqliteSqlStep("002_second", 1, 2, "CREATE TABLE store_two (id TEXT);"),
      ]};
      await new MigrationRunner(createSqliteMigrationStore(db), [plan]).apply();
      console.log("applied");
      db.close();
    `;

    const holder = spawn(process.execPath, ["--input-type=module", "-e", holdScript], { cwd: process.cwd(), windowsHide: true });
    const closed = new Promise<void>(resolve => { holder.once("close", () => resolve()); });
    let holderOutput = "";
    holder.stdout.on("data", (chunk: Buffer) => { holderOutput += String(chunk); });
    holder.stderr.on("data", (chunk: Buffer) => { holderOutput += String(chunk); });
    try {
      let readinessTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          readinessTimer = setTimeout(() => reject(new Error(`lock holder did not become ready: ${holderOutput}`)), 10_000);
          holder.stdout.on("data", () => { if (holderOutput.includes("locked\n") || holderOutput.includes("locked\r\n")) resolve(); });
          holder.once("error", reject);
          holder.once("exit", code => reject(new Error(`lock holder exited early (${code}): ${holderOutput}`)));
        });
      } finally { clearTimeout(readinessTimer); }
      // The holder releases only after the contender settles, independent of
      // machine load. The process timeout bounds a regression that ignores busy_timeout.
      const failure = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", applyScript], {
        cwd: process.cwd(), windowsHide: true, timeout: 10_000,
      }).then(() => null, (error: unknown) => error);
      expect(failure).not.toBeNull();
      const text = failure instanceof Error && "stderr" in failure && typeof failure.stderr === "string"
        ? failure.stderr : String(failure);
      expect(text).toMatch(/database is locked|SQLITE_BUSY/);
    } finally {
      holder.stdin.end();
      const cleanupTimer = setTimeout(() => { holder.kill(); }, 5_000);
      try { await closed; } finally { clearTimeout(cleanupTimer); }
    }
    expect(holder.exitCode).toBe(0);

    // The loser left nothing behind: no ledger table, no step tables — the
    // file still belongs to the holder's (committed) `hold` table only.
    const { default: Database } = (await import("better-sqlite3")) as unknown as { default: SqliteModule };
    const verify = new Database(path);
    openDbs.push(verify);
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'store_one'").get()).toBeUndefined();
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'store_two'").get()).toBeUndefined();
  }, 30_000);

  it("a failing step rolls back the whole batch atomically (M06)", async () => {
    const db = await freshDb();
    const broken: NamespaceMigrationPlan = {
      namespace: "store",
      targetVersion: 2,
      steps: [
        sqliteSqlStep("001_first", 0, 1, "CREATE TABLE kept (id TEXT);"),
        sqliteSqlStep("002_broken", 1, 2, "CREATE TABLE broken (syntax error here;"),
      ],
    };
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [broken]);
    await expect(runner.apply()).rejects.toThrow();
    // Neither the DDL nor the ledger rows survived the rollback.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'kept'").all()).toHaveLength(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
  });

  it("isolates namespaces in one ledger", async () => {
    const db = await freshDb();
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [
      plan("store"),
      plan("config", "CREATE TABLE c_one (id TEXT);"),
    ]);
    await runner.apply();
    const statuses = await runner.status();
    expect(statuses).toHaveLength(2);
    expect(statuses.every((s) => s.currentVersion === 2)).toBe(true);
    const rows = db.prepare("SELECT DISTINCT namespace FROM schema_migrations").all() as Array<{ namespace: string }>;
    expect(rows.map((row) => row.namespace).sort()).toEqual(["config", "store"]);
  });
});

describe("MigrationRunner read-only status probe (migrate=verify)", () => {
  function fakeStore(ledgerExists: boolean, applied: readonly AppliedMigration[] = []) {
    const calls: string[] = [];
    const store: MigrationStore = {
      backendKind: "fake",
      ensureLedger() {
        calls.push("ensureLedger");
        return Promise.resolve();
      },
      ledgerExists() {
        calls.push("ledgerExists");
        return Promise.resolve(ledgerExists);
      },
      withMigrationLock(fn) {
        return fn();
      },
      readApplied() {
        calls.push("readApplied");
        return Promise.resolve(applied);
      },
      applyStep() {
        calls.push("applyStep");
        return Promise.resolve();
      },
      recordApplied() {
        calls.push("recordApplied");
        return Promise.resolve();
      },
    };
    return { store, calls };
  }

  it("computes all-pending without any DDL when the ledger is missing", async () => {
    const { store, calls } = fakeStore(false);
    const runner = new MigrationRunner(store, [plan()]);

    const statuses = await runner.status();
    expect(statuses[0]?.pendingIds).toEqual(["001_first", "002_second"]);
    expect(statuses[0]?.currentVersion).toBe(0);
    // The verify path must not CREATE the ledger: no ensureLedger, and the
    // missing table is never read.
    expect(calls).toEqual(["ledgerExists"]);

    const check = await runner.check();
    expect(check.needsMigration).toEqual(["store"]);
    expect(calls).toEqual(["ledgerExists", "ledgerExists"]);
  });

  it("reads an existing ledger without re-creating it", async () => {
    const applied: AppliedMigration = {
      id: "001_first",
      checksum: plan().steps[0]!.checksum,
      fromVersion: 0,
      toVersion: 1,
      appVersion: null,
      appliedAt: T0,
    };
    const { store, calls } = fakeStore(true, [applied]);
    const runner = new MigrationRunner(store, [plan()]);

    const statuses = await runner.status();
    expect(statuses[0]?.pendingIds).toEqual(["002_second"]);
    expect(calls).toEqual(["ledgerExists", "readApplied"]);
  });

  it("keeps the SQLite status probe free of ledger writes", async () => {
    const db = await freshDb();
    const runner = new MigrationRunner(createSqliteMigrationStore(db), [plan()]);
    const statuses = await runner.status();
    expect(statuses[0]?.pendingIds).toEqual(["001_first", "002_second"]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").all()).toHaveLength(0);
  });
});
