/**
 * PostgreSQL ConfigStore conformance (P2).
 *
 * Runs the shared ConfigStore suite against a real PostgreSQL service only
 * when AICR_PG_TEST_URL is set (e.g. `postgres://aicr@127.0.0.1:5432/aicr_test`).
 * Without a real service this file stays skipped.
 *
 * Each store instance gets its own schema (created by the store, pinned via
 * search_path), and afterAll closes every pool and DROPs those schemas
 * CASCADE, so the file is isolated and safe to run against a shared test
 * server.
 */

import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import type { ConfigStore, WriteSnapshotInput } from "../src/config-store.js";
import { isConfigError } from "../src/config-format.js";
import type { NamespaceMigrationPlan } from "../src/migration-runner.js";
import { MigrationRunner } from "../src/migration-runner.js";
import {
  createPgConfigMigrationStore,
  createPgConfigStore,
  pgConfigSqlStep,
} from "../src/pg-config-store.js";

import { runConfigStoreConformance } from "./config-store-conformance.js";

const PG_TEST_URL = process.env.AICR_PG_TEST_URL;

if (PG_TEST_URL) {
  const stores: ConfigStore[] = [];
  const schemas: string[] = [];

  afterAll(async () => {
    await Promise.allSettled(stores.map((store) => store.close()));
    // Remove every test schema: unique names make DROP CASCADE precise and
    // avoid touching shared tables. pg is loaded dynamically here as well
    // (optionalDependency; absent unless the PG backend is used — a static
    // import would crash the skip path on such hosts).
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

  runConfigStoreConformance({
    backendKind: "postgres",
    makeStore: async () => {
      const schema = `test_${randomUUID().replace(/-/g, "_")}`;
      const store = await createPgConfigStore({
        connection: { url: PG_TEST_URL },
        schema,
      });
      schemas.push(schema);
      stores.push(store);
      return store;
    },
  });

  describe("postgres config store migrations", () => {
    it("rolls back the whole batch when a step fails (M06)", async () => {
      const schema = `test_m06_${randomUUID().replace(/-/g, "_")}`;
      schemas.push(schema);
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: PG_TEST_URL,
        max: 1,
        options: `-c search_path=${schema}`,
      });
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        const plan: NamespaceMigrationPlan = {
          namespace: "config-m06",
          targetVersion: 2,
          steps: [
            pgConfigSqlStep("001_good", 0, 1, "CREATE TABLE m06_one (id TEXT);"),
            pgConfigSqlStep("002_bad", 1, 2, "CREATE TABLE m06_two (id TEXT BOGUS);"),
          ],
        };
        const runner = new MigrationRunner(
          createPgConfigMigrationStore(client),
          [plan],
          { now: () => 1_800_000_000_000 },
        );
        await expect(runner.apply()).rejects.toThrow();
        // The failed step aborts the one batch transaction: the good step's
        // DDL and its ledger row are rolled back with it (M06).
        const ledger = await client.query(
          "SELECT to_regclass('schema_migrations') AS name",
        );
        expect(ledger.rows[0]?.name).toBeNull();
        const tables = await client.query(
          `SELECT COUNT(*)::integer AS n FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = 'm06_one'`,
          [schema],
        );
        expect(Number(tables.rows[0]?.n)).toBe(0);
      } finally {
        client.release();
        await pool.end();
      }
    });

    it("refuses a low-privilege role with a clear error and creates no tables (M08)", async () => {
      // Role gets CONNECT + schema USAGE but no CREATE: startup must fail
      // with a bounded store_unavailable, not a raw driver error, and the
      // migration transaction must leave zero tables behind.
      const suffix = randomUUID().replace(/-/g, "");
      const role = `aicr_low_${suffix.slice(0, 20)}`;
      const schema = `test_m08_${suffix.slice(0, 20)}`;
      schemas.push(schema);
      const { Pool } = await import("pg");
      const admin = new Pool({ connectionString: PG_TEST_URL, max: 1 });
      try {
        const database = new URL(PG_TEST_URL).pathname.slice(1);
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'm08-pass'`);
        await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);

        const url = new URL(PG_TEST_URL);
        url.username = role;
        url.password = "m08-pass";
        await expect(
          createPgConfigStore({ connection: { url: url.toString() }, schema }),
        ).rejects.toSatisfy(
          (error: unknown) => isConfigError(error, "store_unavailable"),
        );

        const tables = await admin.query(
          `SELECT COUNT(*)::integer AS n FROM information_schema.tables WHERE table_schema = $1`,
          [schema],
        );
        expect(Number(tables.rows[0]?.n)).toBe(0);
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
        await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
        await admin.end();
      }
    });
  });

  // Snapshot mutation races (spec §7.2: a signed-out task's snapshot must
  // never vanish under it; writeSnapshot is idempotent per id). A real pool
  // gives genuine statement-level concurrency, so the delete/ref-count race
  // is repeated: either linearization is legal, the spec violation is not.
  describe("postgres config store snapshot races", () => {
    const T0 = 1_800_000_000_000;

    function snapshot(overrides: Partial<WriteSnapshotInput> = {}): WriteSnapshotInput {
      return {
        id: "snap-race",
        namespace: "test-ns-race",
        fileDigest: "file-digest-1",
        databaseRevision: 1,
        resolverVersion: 1,
        sanitizedEffectiveConfig: { llm: { providers: ["p1"] } },
        contentHash: "snap-hash-1",
        now: T0,
        ...overrides,
      };
    }

    async function makeStore(): Promise<ConfigStore> {
      const schema = `test_${randomUUID().replace(/-/g, "_")}`;
      const store = await createPgConfigStore({
        connection: { url: PG_TEST_URL },
        schema,
      });
      schemas.push(schema);
      stores.push(store);
      return store;
    }

    it("T3: deleteSnapshot racing a ref-count landing never deletes a referenced row", async () => {
      const store = await makeStore();
      for (let round = 0; round < 20; round += 1) {
        const id = `snap-race-t3-${round}`;
        await store.writeSnapshot(snapshot({ id }));
        const [adjusted, deleted] = await Promise.allSettled([
          store.adjustSnapshotRefCount(id, +1),
          store.deleteSnapshot(id),
        ]);
        const surviving = await store.readSnapshot(id);
        if (deleted.status === "fulfilled") {
          // The delete won before the ref-count landed: the row is gone and
          // the adjust found nothing to bump.
          expect(surviving).toBeNull();
          expect(adjusted.status).toBe("fulfilled");
          if (adjusted.status === "fulfilled") expect(adjusted.value).toBeNull();
        } else {
          // The ref-count won: the delete fails atomically and the
          // referenced row survives intact.
          expect(isConfigError(deleted.reason, "snapshot_invalid")).toBe(true);
          expect(surviving?.refCount).toBe(1);
        }
      }
    });

    it("T4: concurrent writeSnapshot folds identical content into the stored record; different content loses with snapshot_invalid", async () => {
      const store = await makeStore();
      const identical = snapshot({ id: "snap-race-t4" });
      const [first, second] = await Promise.all([
        store.writeSnapshot(identical),
        store.writeSnapshot(identical),
      ]);
      expect(second).toEqual(first);
      expect(first.contentHash).toBe("snap-hash-1");

      const settled = await Promise.allSettled([
        store.writeSnapshot(snapshot({ id: "snap-race-t4b", contentHash: "snap-hash-x" })),
        store.writeSnapshot(snapshot({
          id: "snap-race-t4b",
          contentHash: "snap-hash-y",
          sanitizedEffectiveConfig: { llm: { providers: ["p2"] } },
        })),
      ]);
      const winner = settled.find((result) => result.status === "fulfilled");
      const loser = settled.find((result) => result.status === "rejected");
      expect(winner?.status).toBe("fulfilled");
      expect(loser?.status).toBe("rejected");
      if (winner?.status === "fulfilled" && loser?.status === "rejected") {
        expect(isConfigError(loser.reason, "snapshot_invalid")).toBe(true);
        // The winner's row is the one that survives.
        expect((await store.readSnapshot("snap-race-t4b"))?.contentHash).toBe(winner.value.contentHash);
      }
    });
  });

} else {
  describe.skip("ConfigStore conformance [postgres] (AICR_PG_TEST_URL not set)", () => {
    it("requires a real PostgreSQL service; see file header", () => {});
  });
}
