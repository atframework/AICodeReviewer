import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { createPgConfigStore, createSqliteConfigStore } from "@aicr/core";
import { closeStoreDb, createStoreDb } from "@aicr/store";

import { afterAll, describe, expect, it } from "vitest";

import { runCli } from "../src/app.js";
import { MIGRATE_EXIT } from "../src/migrate.js";

class MemoryWriter {
  public output = "";

  write(text: string): void {
    this.output += text;
  }
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function fixture(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "aicr-cli-migrate-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "app.sqlite");
  await mkdir(join(dir, "data"), { recursive: true });
  await writeFile(
    join(dir, "config.yaml"),
    [
      "storage:",
      "  database:",
      "    kind: sqlite",
      `    sqlite: { path: ${JSON.stringify(dbPath)} }`,
      "",
    ].join("\n"),
    "utf8",
  );
  return { dir, dbPath };
}

interface SqliteDatabase {
  prepare(source: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  exec(source: string): unknown;
  close(): void;
}

async function openDb(path: string): Promise<SqliteDatabase> {
  const { createRequire } = await import("node:module");
  const require = createRequire(join(process.cwd(), "packages/core/package.json"));
  const Database = require("better-sqlite3") as new (p: string) => SqliteDatabase;
  return new Database(path);
}

describe("aicr migrate", () => {
  it("does not report clean when only the config namespace is upgraded", async () => {
    const { dir, dbPath } = await fixture();
    const configStore = await createSqliteConfigStore({ path: dbPath });
    await configStore.close();
    const output = new MemoryWriter();
    expect(await runCli(["migrate", "--check"], { cwd: dir, stdout: output, stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.pending);
    expect(JSON.parse(output.output)).toMatchObject([{ namespace: "config", pending: [] }, { namespace: "store", currentVersion: 0 }]);
    expect(await runCli(["migrate", "--apply"], { cwd: dir, stdout: new MemoryWriter(), stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.ok);
    await closeStoreDb(createStoreDb({ kind: "sqlite", path: dbPath, migrationMode: "verify" }));
  });

  it("resolves relative database paths from the command cwd and creates their parent on apply", async () => {
    const { dir } = await fixture();
    await writeFile(join(dir, "config.yaml"), "storage:\n  database:\n    kind: sqlite\n    sqlite: { path: nested/app.sqlite }\n");
    expect(await runCli(["migrate", "--apply"], { cwd: dir, stdout: new MemoryWriter(), stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.ok);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "nested", "app.sqlite"))).toBe(true);
  });

  it.skipIf(!process.env.AICR_PG_TEST_URL)("checks and upgrades both PostgreSQL namespaces, then verify startup succeeds", async () => {
    const { dir } = await fixture();
    const schema = `cli_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.AICR_PG_TEST_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const require = createRequire(join(process.cwd(), "packages/core/package.json"));
    type Client = { connect(): Promise<void>; query(sql: string): Promise<{ rows: unknown[] }>; end(): Promise<void> };
    const { Client } = require("pg") as { Client: new (options: { connectionString: string }) => Client };
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await writeFile(join(dir, "config.yaml"), `storage:\n  database:\n    kind: postgres\n    postgres: { url: ${JSON.stringify(url.toString())} }\n`);
      const output = new MemoryWriter();
      expect(await runCli(["migrate", "--check"], { cwd: dir, stdout: output, stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.pending);
      expect((await client.query("SELECT to_regclass('schema_migrations') AS name")).rows).toEqual([{ name: null }]);
      expect(await runCli(["migrate", "--apply"], { cwd: dir, stdout: new MemoryWriter(), stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.ok);
      expect(await runCli(["migrate", "--check"], { cwd: dir, stdout: new MemoryWriter(), stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.ok);
      const configStore = await createPgConfigStore({ connection: { url: url.toString() }, migrationMode: "verify" });
      await configStore.close();
      await closeStoreDb(await createStoreDb({ kind: "postgres", url: url.toString(), migrationMode: "verify" }));
      await client.query("UPDATE schema_migrations SET checksum = 'bad' WHERE namespace = 'store'");
      expect(await runCli(["migrate", "--check"], { cwd: dir, stdout: new MemoryWriter(), stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.unsafe);
    } finally {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    }
  });

  it("--status is read-only and reports an empty ledger on a fresh database", async () => {
    const { dir, dbPath } = await fixture();
    const stdout = new MemoryWriter();
    const code = await runCli(["migrate", "--status"], { cwd: dir, stdout, stderr: new MemoryWriter() });
    expect(code).toBe(MIGRATE_EXIT.ok);
    const report = JSON.parse(stdout.output) as Array<{ namespace: string; pending: string[] }>;
    expect(report).toHaveLength(2);
    expect(report[0]?.namespace).toBe("config");
    expect(report[0]?.pending).toEqual(["001_config_initial"]);
    expect(report[1]?.namespace).toBe("store");
    expect(report[1]?.pending).toHaveLength(9);
    // Truly read-only (M19): a status probe never creates the database file.
    const { existsSync } = await import("node:fs");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("--apply creates the schema and --check turns clean with matching exit codes (M19)", async () => {
    const { dir, dbPath } = await fixture();

    const beforeCheck = await runCli(["migrate", "--check"], { cwd: dir, stdout: new MemoryWriter(), stderr: new MemoryWriter() });
    expect(beforeCheck).toBe(MIGRATE_EXIT.pending);

    const applyOut = new MemoryWriter();
    const applyCode = await runCli(["migrate", "--apply"], { cwd: dir, stdout: applyOut, stderr: new MemoryWriter() });
    expect(applyCode).toBe(MIGRATE_EXIT.ok);
    expect(applyOut.output).toContain("applied: config: 001_config_initial");

    const afterCheck = await runCli(["migrate", "--check"], { cwd: dir, stdout: new MemoryWriter(), stderr: new MemoryWriter() });
    expect(afterCheck).toBe(MIGRATE_EXIT.ok);

    // The ledger and tables are real (M01 evidence through the CLI surface).
    const db = await openDb(dbPath);
    const rows = db.prepare("SELECT id, to_version FROM schema_migrations WHERE namespace = 'config'").all() as Array<{ id: string; to_version: number }>;
    expect(rows).toEqual([{ id: "001_config_initial", to_version: 1 }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'config_revisions'").all()).toHaveLength(1);
    db.close();

    // Re-apply is a no-op, not an error (M06 restart idempotence).
    const again = new MemoryWriter();
    expect(await runCli(["migrate", "--apply"], { cwd: dir, stdout: again, stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.ok);
    expect(again.output).toContain("already up to date");
  });

  it("--check exits 2 on ledger drift instead of applying anything (M16)", async () => {
    const { dir, dbPath } = await fixture();
    expect(await runCli(["migrate", "--apply"], { cwd: dir, stdout: new MemoryWriter(), stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.ok);

    const db = await openDb(dbPath);
    db.exec("UPDATE schema_migrations SET checksum = 'tampered' WHERE id = '001_config_initial'");
    db.close();

    const stderr = new MemoryWriter();
    expect(await runCli(["migrate", "--check"], { cwd: dir, stdout: new MemoryWriter(), stderr })).toBe(MIGRATE_EXIT.unsafe);
    expect(stderr.output).toContain("drift");
    // Drift must never self-heal: apply also refuses.
    expect(await runCli(["migrate", "--apply"], { cwd: dir, stdout: new MemoryWriter(), stderr: new MemoryWriter() })).toBe(MIGRATE_EXIT.unsafe);
  });

  it("requires exactly one mode flag", async () => {
    const { dir } = await fixture();
    const stderr = new MemoryWriter();
    expect(await runCli(["migrate"], { cwd: dir, stdout: new MemoryWriter(), stderr })).toBe(2);
    expect(stderr.output).toContain("exactly one");
  });
});
