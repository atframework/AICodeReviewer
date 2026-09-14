/**
 * E08 fixture: a config database built with ONLY the real 001 step applied
 * (the pre-002 program's ledger state: 001 DDL + its ledger row) plus seeded
 * revision/head/audit/snapshot rows in the 001 shape. Opening it with the
 * current store must apply only 002 (`config_runtime_state`) and preserve
 * every seeded row (M02/M16: additive upgrade, never a half-upgrade).
 *
 * The compatibility case keeps an old SQL connection open and writes AFTER
 * the additive upgrade. It does not simulate an old binary racing migration;
 * cross-process lock contention is covered by migration-runner.test.ts.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { ConfigStore } from "../src/config-store.js";
import { contentHashOf } from "../src/config-store.js";
import { configSnapshotId, CONFIG_RESOLVER_VERSION, prepareConfigPublication } from "../src/config-publish.js";
import { mergeConfigSources, validateDatabaseDocument } from "../src/config-source.js";
import { parseEffectiveConfig } from "../src/config.js";
import { MigrationRunner } from "../src/migration-runner.js";
import type { NamespaceMigrationPlan } from "../src/migration-runner.js";
import {
  CONFIG_STORE_MIGRATIONS,
  CONFIG_STORE_NAMESPACE,
  createSqliteConfigStore,
} from "../src/sqlite-config-store.js";
import { createSqliteMigrationStore } from "../src/sqlite-migration-store.js";
import {
  createPgConfigMigrationStore,
  createPgConfigStore,
  PG_CONFIG_STORE_MIGRATIONS,
} from "../src/pg-config-store.js";

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

const T0 = 1_800_000_000_000;
const STEP_001 = CONFIG_STORE_MIGRATIONS[0]!;
const STEP_002 = CONFIG_STORE_MIGRATIONS[1]!;

const tempDirs: string[] = [];
const openDbs: SqliteDatabase[] = [];
const stores: ConfigStore[] = [];

const FILE_DIGEST = "a".repeat(64);
const prepared = prepareConfigPublication({ namespace: "default", baseRevision: null, operationId: "op-legacy-1",
  actor: "admin@example.com", file: {}, fileDigest: FILE_DIGEST, current: {}, formatVersion: 1,
  operations: [
    { op: "create", collection: "providers", record: { id: "p1", name: "p1", enabled: true, value: { id: "p1", kind: "ollama" } } },
    { op: "create", collection: "model_groups", record: { id: "g1", name: "g1", enabled: true, value: [{ provider: "p1", model: "legacy-model", role: "any" }] } },
    { op: "set", path: ["llm", "default_model_chain"], value: "g1" },
  ],
});
const SEEDED_DOCUMENT = prepared.document;
const SEEDED_SNAPSHOT_CONFIG = prepared.effective;
const DOCUMENT_HASH = contentHashOf(SEEDED_DOCUMENT);
const SNAPSHOT_HASH = contentHashOf(SEEDED_SNAPSHOT_CONFIG);
const SNAPSHOT_ID = configSnapshotId({ namespace: "default", revision: 1, contentHash: DOCUMENT_HASH, fileDigest: FILE_DIGEST, formatVersion: 1 });

/** A plan that stops at version 1: exactly what a pre-002 program ran. */
function plan001(): NamespaceMigrationPlan {
  return { namespace: CONFIG_STORE_NAMESPACE, targetVersion: 1, steps: [STEP_001] };
}

/**
 * Builds the on-disk state a pre-002 program leaves behind: the 001 step
 * applied through the real runner (real DDL, real ledger row and checksum),
 * plus one committed revision chain and one snapshot in the 001 shape.
 * Returns the open database so G7 can keep the "old writer" connected.
 */
async function buildLegacy001Db(path: string): Promise<SqliteDatabase> {
  expect(STEP_001.id).toBe("001_config_initial");
  expect(STEP_002.id).toBe("002_config_runtime_state");
  const db = await openDb(path);
  openDbs.push(db);
  await new MigrationRunner(createSqliteMigrationStore(db), [plan001()], { now: () => T0 }).apply();

  db.prepare(
    `INSERT INTO config_revisions (
       namespace, revision, parent_revision, format_version, document, content_hash,
       file_digest, created_at, actor, operation_id
     ) VALUES ('default', 1, NULL, 1, ?, '${DOCUMENT_HASH}', '${FILE_DIGEST}', ?, 'admin@example.com', 'op-legacy-1')`,
  ).run(JSON.stringify(SEEDED_DOCUMENT), T0);
  db.prepare(
    `INSERT INTO config_heads (namespace, active_revision, generation) VALUES ('default', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO config_audit (
       id, namespace, operation_id, before_revision, after_revision, action,
       entity_refs, redacted_diff, actor, timestamp
     ) VALUES ('audit-legacy-1', 'default', 'op-legacy-1', NULL, 1, 'publish', '[]', '{}', 'admin@example.com', ?)`,
  ).run(T0);
  db.prepare(
    `INSERT INTO config_runtime_snapshots (
       id, namespace, file_digest, database_revision, resolver_version,
       sanitized_effective_config, content_hash, created_at, pinned, ref_count
     ) VALUES ('${SNAPSHOT_ID}', 'default', '${FILE_DIGEST}', 1, ${CONFIG_RESOLVER_VERSION}, ?, '${SNAPSHOT_HASH}', ?, 0, 0)`,
  ).run(JSON.stringify(SEEDED_SNAPSHOT_CONFIG), T0);
  return db;
}

function ledgerIds(db: SqliteDatabase): string[] {
  const rows = db.prepare(
    `SELECT id FROM schema_migrations WHERE namespace = ? ORDER BY to_version`,
  ).all(CONFIG_STORE_NAMESPACE) as { id: string }[];
  return rows.map((row) => row.id);
}

async function expectSeededRowsReadable(store: ConfigStore): Promise<void> {
  const head = await store.readHead("default");
  expect(head).toMatchObject({ activeRevision: 1, generation: "1" });
  const revision = await store.readRevision("default", 1);
  expect(revision).toMatchObject({
    revision: 1,
    operationId: "op-legacy-1",
    actor: "admin@example.com",
    contentHash: DOCUMENT_HASH,
    fileDigest: FILE_DIGEST,
  });
  expect(revision?.document).toEqual(SEEDED_DOCUMENT);
  const audit = await store.readAudit("default");
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ id: "audit-legacy-1", operationId: "op-legacy-1", action: "publish", afterRevision: 1 });
  const snapshot = await store.readSnapshot(SNAPSHOT_ID);
  expect(snapshot).toMatchObject({
    contentHash: SNAPSHOT_HASH,
    fileDigest: FILE_DIGEST,
    pinned: false,
    refCount: 0,
    sanitizedEffectiveConfig: SEEDED_SNAPSHOT_CONFIG,
  });
  // Preserved bytes must remain consumable, not merely readable as opaque JSON.
  const database = validateDatabaseDocument(revision!.document, revision!.formatVersion);
  const merged = mergeConfigSources({ file: {}, database, formatVersion: revision!.formatVersion });
  expect(parseEffectiveConfig(merged.document, revision!.formatVersion)).toEqual(SEEDED_SNAPSHOT_CONFIG);
  expect(configSnapshotId(revision!)).toBe(SNAPSHOT_ID);
  expect(contentHashOf(parseEffectiveConfig(snapshot!.sanitizedEffectiveConfig, 2))).toBe(SNAPSHOT_HASH);
}

afterAll(async () => {
  await Promise.allSettled(stores.map((store) => store.close()));
  for (const db of openDbs) db.close();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

describe("config migration fixture [sqlite] (001→002)", () => {
  it("applies only 002 onto a real 001 ledger and preserves every seeded 001 row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aicr-config-fixture-"));
    tempDirs.push(dir);
    const path = join(dir, "config.sqlite");
    const legacy = await buildLegacy001Db(path);
    legacy.close();

    const store = await createSqliteConfigStore({ path });
    stores.push(store);

    // Only 002 was applied on top of the historical 001 row.
    const probe = await openDb(path);
    openDbs.push(probe);
    expect(ledgerIds(probe)).toEqual([STEP_001.id, STEP_002.id]);

    await expectSeededRowsReadable(store);

    // Reopening is a no-op: the ledger stays exactly at the two rows.
    await store.close();
    const reopened = await createSqliteConfigStore({ path });
    stores.push(reopened);
    expect(ledgerIds(probe)).toEqual([STEP_001.id, STEP_002.id]);
    expect((await reopened.readHead("default"))?.activeRevision).toBe(1);
  });

  it("a still-open 001 SQL writer commits compatible rows after the additive upgrade", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aicr-config-fixture-g7-"));
    tempDirs.push(dir);
    const path = join(dir, "config.sqlite");
    // The old writer is a raw connection that only knows 001-era SQL.
    const oldWriter = await buildLegacy001Db(path);

    // While the old writer stays connected, the current program opens the
    // same file: the runner takes BEGIN IMMEDIATE, applies 002, commits.
    // 002 is additive, so nothing the old writer wrote is invalidated.
    const store = await createSqliteConfigStore({ path });
    stores.push(store);

    // The old writer commits revision 2 with exactly the 001-era column
    // list (002 added no columns to the 001 tables) and moves the head the
    // same way the 001-era program did.
    oldWriter.transaction(() => {
      oldWriter.prepare(
      `INSERT INTO config_revisions (
         namespace, revision, parent_revision, format_version, document, content_hash,
         file_digest, created_at, actor, operation_id
       ) VALUES ('default', 2, 1, 1, ?, '${DOCUMENT_HASH}', '${FILE_DIGEST}', ?, 'admin@example.com', 'op-legacy-2')`,
    ).run(JSON.stringify(SEEDED_DOCUMENT), T0 + 1000);
    oldWriter.prepare(
      `UPDATE config_heads SET active_revision = 2, generation = generation + 1 WHERE namespace = 'default'`,
    ).run();
    }).immediate();
    oldWriter.close();

    // Both generations of rows are valid through the current API, and the
    // ledger shows the upgrade ran exactly once.
    const probe = await openDb(path);
    openDbs.push(probe);
    expect(ledgerIds(probe)).toEqual([STEP_001.id, STEP_002.id]);
    const head = await store.readHead("default");
    expect(head).toMatchObject({ activeRevision: 2, generation: "2" });
    expect((await store.readRevision("default", 1))?.operationId).toBe("op-legacy-1");
    expect((await store.readRevision("default", 2))?.operationId).toBe("op-legacy-2");

    // The upgraded store continues the chain from the old writer's head.
    const next = await store.commitChangeset({
      namespace: "default",
      baseRevision: 2,
      fileDigest: FILE_DIGEST,
      operationId: "op-new-3",
      actor: "admin@example.com",
      document: SEEDED_DOCUMENT,
      formatVersion: 1,
      audit: { action: "publish", entityRefs: [], redactedDiff: {} },
      now: T0 + 2000,
    });
    expect(next.status).toBe("committed");
    expect(next.head.activeRevision).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL leg (live service only)
// ---------------------------------------------------------------------------

const PG_TEST_URL = process.env.AICR_PG_TEST_URL;
const describePg = PG_TEST_URL ? describe : describe.skip;

describePg("config migration fixture [postgres] (001→002)", () => {
  const schemas: string[] = [];

  afterAll(async () => {
    // pg is loaded dynamically here as well (optionalDependency; absent
    // unless the PG backend is used — a static import would crash the skip
    // path on such hosts).
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL, max: 1 });
    try {
      for (const schema of schemas) {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await pool.end();
    }
  });

  it("applies only 002_pg_config_runtime_state onto a hand-built 001 schema and preserves every seeded row", async () => {
    const { Pool } = await import("pg");
    const step001 = PG_CONFIG_STORE_MIGRATIONS[0]!;
    const step002 = PG_CONFIG_STORE_MIGRATIONS[1]!;
    expect(step001.id).toBe("001_pg_config_initial");
    expect(step002.id).toBe("002_pg_config_runtime_state");

    const schema = `test_${randomUUID().replace(/-/g, "_")}`;
    schemas.push(schema);

    // Hand-build the pre-002 state: real 001 DDL + ledger row via the runner,
    // then seeded rows in the 001 shape.
    const setup = new Pool({
      connectionString: PG_TEST_URL,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    const client = await setup.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await new MigrationRunner(createPgConfigMigrationStore(client), [
        { namespace: CONFIG_STORE_NAMESPACE, targetVersion: 1, steps: [step001] },
      ], { now: () => T0 }).apply();

      await client.query(
        `INSERT INTO config_revisions (
           namespace, revision, parent_revision, format_version, document, content_hash,
           file_digest, created_at, actor, operation_id
         ) VALUES ('default', 1, NULL, 1, $1::jsonb, '${DOCUMENT_HASH}', '${FILE_DIGEST}', $2, 'admin@example.com', 'op-legacy-1')`,
        [JSON.stringify(SEEDED_DOCUMENT), T0],
      );
      await client.query(
        `INSERT INTO config_heads (namespace, active_revision, generation) VALUES ('default', 1, 1)`,
      );
      await client.query(
        `INSERT INTO config_audit (
           id, namespace, operation_id, before_revision, after_revision, action,
           entity_refs, redacted_diff, actor, timestamp
         ) VALUES ('audit-legacy-1', 'default', 'op-legacy-1', NULL, 1, 'publish', '[]'::jsonb, '{}'::jsonb, 'admin@example.com', $1)`,
        [T0],
      );
      await client.query(
        `INSERT INTO config_runtime_snapshots (
           id, namespace, file_digest, database_revision, resolver_version,
           sanitized_effective_config, content_hash, created_at, pinned, ref_count
         ) VALUES ('${SNAPSHOT_ID}', 'default', '${FILE_DIGEST}', 1, ${CONFIG_RESOLVER_VERSION}, $1::jsonb, '${SNAPSHOT_HASH}', $2, FALSE, 0)`,
        [JSON.stringify(SEEDED_SNAPSHOT_CONFIG), T0],
      );
    } finally {
      client.release();
      await setup.end();
    }

    // The current store opens the 001-state schema: only 002 is applied.
    const store = await createPgConfigStore({ connection: { url: PG_TEST_URL! }, schema });
    stores.push(store);

    const probe = new Pool({
      connectionString: PG_TEST_URL,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    try {
      const ledger = await probe.query(
        `SELECT id FROM schema_migrations WHERE namespace = $1 ORDER BY to_version`,
        [CONFIG_STORE_NAMESPACE],
      );
      expect(ledger.rows.map((row: { id: string }) => row.id)).toEqual([step001.id, step002.id]);
    } finally {
      await probe.end();
    }

    await expectSeededRowsReadable(store);
  });
});
