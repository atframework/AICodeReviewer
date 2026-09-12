import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPgConfigStore, createSqliteConfigStore } from "@aicr/core";
import { closeStoreDb, createStoreDb } from "../src/database.js";

const root = resolve("build/tmp/p2p3-migration-tests");
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, "case-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("verify startup is read-only before accepting the database", () => {
  it("does not create a missing SQLite database or directory", async () => {
    const path = join(directory, "absent", "data.sqlite");
    expect(() => createStoreDb({ kind: "sqlite", path, migrationMode: "verify" })).toThrow();
    await expect(createSqliteConfigStore({ path, migrationMode: "verify" })).rejects.toThrow();
    expect(existsSync(join(directory, "absent"))).toBe(false);
  });
  it("does not alter an existing legacy SQLite file when migrations are pending", async () => {
    const path = join(directory, "legacy.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep');");
    db.close();
    const before = readFileSync(path);
    expect(() => createStoreDb({ kind: "sqlite", path, migrationMode: "verify" })).toThrow();
    await expect(createSqliteConfigStore({ path, migrationMode: "verify" })).rejects.toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
  it.each(["DELETE FROM _migrations WHERE name = '002_reflection_memory'", "INSERT INTO _migrations (name) VALUES ('999_future')"])("rejects a non-prefix business ledger: %s", async (corrupt) => {
    const path = join(directory, `${randomUUID()}.sqlite`);
    const store = createStoreDb(path);
    // Use the actual second id so the fixture stays tied to the shipped ledger.
    if (corrupt.startsWith("DELETE")) store.sqlite.exec("DELETE FROM _migrations WHERE id = 2");
    else store.sqlite.exec(corrupt);
    await closeStoreDb(store);
    expect(() => createStoreDb({ kind: "sqlite", path, migrationMode: "auto" })).toThrow(/ledger/u);
  });
  it("accepts an upgraded SQLite database in verify mode", async () => {
    const path = join(directory, "ready.sqlite");
    await closeStoreDb(createStoreDb(path));
    const store = createStoreDb({ kind: "sqlite", path, migrationMode: "verify" });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM _migrations").get()).toEqual({ n: 9 });
    await closeStoreDb(store);
  });
});

describe.skipIf(!process.env.AICR_PG_TEST_URL)("PostgreSQL migration review", () => {
  it("verify refuses a missing schema without creating it", async () => {
    const url = process.env.AICR_PG_TEST_URL!;
    const schema = `verify_${randomUUID().replaceAll("-", "")}`;
    await expect(createStoreDb({ kind: "postgres", url, schema, migrationMode: "verify" })).rejects.toThrow();
    await expect(createPgConfigStore({ connection: { url }, schema, migrationMode: "verify" })).rejects.toThrow();
    const pool = new pg.Pool({ connectionString: url });
    try { expect((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rows).toHaveLength(0); }
    finally { await pool.end(); }
  });
  it("serializes first schema and ledger creation across config and business stores", async () => {
    const url = process.env.AICR_PG_TEST_URL!;
    const schema = `Both_${randomUUID().replaceAll("-", "")}`;
    const results = await Promise.allSettled([
      createStoreDb({ kind: "postgres", url, schema }),
      createPgConfigStore({ connection: { url }, schema }),
    ]);
    try { expect(results.every((result) => result.status === "fulfilled")).toBe(true); }
    finally {
      if (results[0].status === "fulfilled") await closeStoreDb(results[0].value);
      if (results[1].status === "fulfilled") await results[1].value.close();
      const pool = new pg.Pool({ connectionString: url });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    }
  });
});
