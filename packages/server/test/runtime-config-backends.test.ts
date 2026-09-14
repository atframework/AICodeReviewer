/**
 * RuntimeConfigManager live-backend matrix (E08/G4): the runtime-config
 * harness from runtime-config.test.ts replayed against the real PostgreSQL
 * and Redis config stores. The manager harness itself is store-agnostic (it
 * only needs a ConfigStore plus a scratch baseDir), so every leg runs the
 * identical publish/admission/restart/legacy-import sequence.
 *
 * PostgreSQL legs isolate per test via a random schema (dropped afterwards,
 * never touching shared state) and run only when AICR_PG_TEST_URL is set.
 * Redis legs isolate per test via a random key prefix (SCAN+UNLINK of that
 * prefix afterwards, never FLUSHDB) and run only when AICR_REDIS_TEST_URL is
 * set. Without the services both describes stay skipped.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPgConfigStore,
  createRedisConfigStore,
  prepareConfigPublication,
  publishConfig,
  type ConfigChangesetOperation,
  type ConfigStore,
} from "@aicr/core";
import { RuntimeConfigManager } from "../src/runtime-config.js";

const PG_URL = process.env.AICR_PG_TEST_URL;
const REDIS_URL = process.env.AICR_REDIS_TEST_URL;
const describePg = PG_URL ? describe : describe.skip;
const describeRedis = REDIS_URL ? describe : describe.skip;

const NAMESPACE = "runtime-backends";
const DIGEST = "a".repeat(64);

const FILE_DOCUMENT = {
  llm: {
    providers: [{ id: "file-main", kind: "ollama" }],
    model_chain: { default: [{ provider: "file-main", model: "file-model", role: "any" }] },
  },
};

const FILE_CONFIG = {
  llm: {
    providers: [{ id: "file-main", kind: "ollama" }],
    model_chain: { default: [{ provider: "file-main", model: "file-model", role: "any" }] },
  },
} as never;

function providerCreate(id: string, kind: string): ConfigChangesetOperation {
  return { op: "create", collection: "providers", record: { id, name: id, enabled: true, value: { id, kind } } };
}

/** One isolated durable scope (PG schema / Redis prefix) plus cleanup. */
interface BackendContext {
  readonly baseDir: string;
  /** Opens one more store connection against this test's durable scope. */
  openStore(): Promise<ConfigStore>;
  cleanup(): Promise<void>;
}

async function publishProviderRevision(
  manager: RuntimeConfigManager,
  publishStore: ConfigStore,
  providerId: string,
  baseRevision: number | null,
  operationId: string,
): Promise<{ revision: number; snapshotId: string }> {
  const prepared = prepareConfigPublication({
    namespace: NAMESPACE,
    baseRevision,
    operationId,
    actor: "test",
    file: FILE_DOCUMENT,
    fileDigest: DIGEST,
    current: baseRevision === null
      ? {}
      : ((await publishStore.readRevision(NAMESPACE, baseRevision))?.document ?? {}),
    operations: [providerCreate(providerId, "ollama")],
    formatVersion: 2,
  });
  const result = await publishConfig(publishStore, prepared, {
    install: async (preparedPublication, revision) => {
      await manager.install({
        effective: preparedPublication.effective,
        revision: revision.revision,
        revisionContentHash: revision.contentHash,
        fileDigest: revision.fileDigest,
        formatVersion: preparedPublication.formatVersion,
      });
    },
  });
  if (result.status !== "committed") {
    throw new Error(`publish failed: ${result.status}`);
  }
  return { revision: result.revision.revision, snapshotId: result.snapshotId };
}

function registerRuntimeBackendMatrix(getContext: () => BackendContext) {
  const makeManager = (store: ConfigStore) => new RuntimeConfigManager({
    fileConfig: FILE_CONFIG,
    fileDocument: FILE_DOCUMENT,
    fileDigest: DIGEST,
    store,
    namespace: NAMESPACE,
    baseDir: getContext().baseDir,
  });

  it("G4: publishes revision 1 and admission serves the merged generation", async () => {
    const store = await getContext().openStore();
    const manager = makeManager(store);
    await manager.admission();
    const published = await publishProviderRevision(manager, store, "db-main", null, "op-publish-1");
    expect(published.revision).toBe(1);

    const generation = await manager.admission();
    expect(generation.databaseRevision).toBe(1);
    expect(generation.snapshotId).toBe(published.snapshotId);
    expect(generation.config.llm.providers.map((provider) => provider.id).sort()).toEqual(["db-main", "file-main"]);
    // No head movement → the same generation object, no rebuild churn.
    expect(await manager.admission()).toBe(generation);
    manager.close();
  });

  it("G4: an external writer's head advance is adopted on the next admission (H01/H06)", async () => {
    const storeA = await getContext().openStore();
    const managerA = makeManager(storeA);
    const first = await publishProviderRevision(managerA, storeA, "db-a", null, "op-external-1");
    expect(managerA.current().databaseRevision).toBe(1);

    // A second store connection (the other replica/writer) commits revision 2
    // without any install into manager A.
    const storeB = await getContext().openStore();
    const current = (await storeB.readRevision(NAMESPACE, first.revision))?.document ?? {};
    const prepared = prepareConfigPublication({
      namespace: NAMESPACE,
      baseRevision: first.revision,
      operationId: "op-external-2",
      actor: "other-replica",
      file: FILE_DOCUMENT,
      fileDigest: DIGEST,
      current,
      operations: [providerCreate("db-b", "ollama")],
      formatVersion: 2,
    });
    const published = await publishConfig(storeB, prepared, {});
    expect(published.status).toBe("committed");

    // Manager A's NEXT admission() adopts revision 2 — no refresh call.
    const adopted = await managerA.admission();
    expect(adopted.databaseRevision).toBe(2);
    expect(adopted.snapshotId).not.toBeNull();
    expect(adopted.config.llm.providers.map((provider) => provider.id).sort()).toEqual(["db-a", "db-b", "file-main"]);
    managerA.close();
  });

  it("G4: a restarted store + manager adopts the durable head and resolves pinned generations", async () => {
    const storeA = await getContext().openStore();
    const managerA = makeManager(storeA);
    const first = await publishProviderRevision(managerA, storeA, "db-a", null, "op-restart-1");
    const second = await publishProviderRevision(managerA, storeA, "db-b", first.revision, "op-restart-2");
    managerA.close();
    await storeA.close();

    // Fresh store connection and manager against the same durable scope.
    const storeB = await getContext().openStore();
    const managerB = makeManager(storeB);
    const generation = await managerB.admission();
    expect(generation.databaseRevision).toBe(2);
    expect(generation.snapshotId).toBe(second.snapshotId);
    expect(generation.config.llm.providers.map((provider) => provider.id).sort()).toEqual(["db-a", "db-b", "file-main"]);

    // A pinned historical generation still resolves after the restart.
    const pinned = await managerB.resolveGeneration(first.snapshotId);
    expect(pinned.databaseRevision).toBe(1);
    expect(pinned.config.llm.providers.map((provider) => provider.id).sort()).toEqual(["db-a", "file-main"]);
    managerB.close();
  });

  it("G4/H12: null references keep one legacy_import baseline across publish and restart", async () => {
    const storeA = await getContext().openStore();
    const first = makeManager(storeA);
    await first.admission();
    const baseline = await first.legacyImport();
    await publishProviderRevision(first, storeA, "after-import", null, "op-after-import");
    expect((await first.resolveGeneration(null)).snapshotId).toBe(baseline);
    first.close();
    await storeA.close();

    const storeB = await getContext().openStore();
    const restarted = makeManager(storeB);
    await restarted.admission();
    expect((await restarted.resolveGeneration(null)).snapshotId).toBe(baseline);
    expect((await restarted.captureForTask()).databaseRevision).toBe(1);
    // The baseline is exactly one durable record, shared by both managers.
    const records = (await storeB.listRuntimeStates(NAMESPACE)).filter((record) => record.key === "legacy_import");
    expect(records).toHaveLength(1);
    expect(records[0]?.snapshotId).toBe(baseline);
    restarted.close();
  });
}

describePg("RuntimeConfigManager backend matrix [postgres] (E08/G4)", () => {
  let context: BackendContext;

  beforeEach(async () => {
    const schema = `test_${randomUUID().replaceAll("-", "_")}`;
    const baseDir = mkdtempSync(join(tmpdir(), "aicr-runtime-pg-"));
    const stores: ConfigStore[] = [];
    context = {
      baseDir,
      openStore: async () => {
        const store = await createPgConfigStore({ connection: { url: PG_URL! }, schema });
        stores.push(store);
        return store;
      },
      cleanup: async () => {
        await Promise.allSettled(stores.map((store) => store.close()));
        rmSync(baseDir, { recursive: true, force: true });
        // pg is an optional dependency of @aicr/core; resolve it from there
        // (same pattern as packages/cli/test/migrate.test.ts).
        const require = createRequire(join(process.cwd(), "packages/core/package.json"));
        const { Pool } = require("pg") as {
          Pool: new (options: { connectionString: string; max: number }) => {
            query(sql: string): Promise<unknown>;
            end(): Promise<void>;
          };
        };
        const pool = new Pool({ connectionString: PG_URL!, max: 1 });
        try {
          await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await pool.end();
        }
      },
    };
  });

  afterEach(async () => {
    await context.cleanup();
  });

  registerRuntimeBackendMatrix(() => context);
});

describeRedis("RuntimeConfigManager backend matrix [redis] (E08/G4)", () => {
  let context: BackendContext;

  beforeEach(async () => {
    const prefix = `aicr:config:test:${randomUUID()}:`;
    const baseDir = mkdtempSync(join(tmpdir(), "aicr-runtime-redis-"));
    const stores: ConfigStore[] = [];
    context = {
      baseDir,
      openStore: async () => {
        const store = await createRedisConfigStore({ connection: { url: REDIS_URL! }, prefix });
        stores.push(store);
        return store;
      },
      cleanup: async () => {
        await Promise.allSettled(stores.map((store) => store.close()));
        rmSync(baseDir, { recursive: true, force: true });
        // ioredis is an optional dependency of @aicr/core / @aicr/server;
        // remove only this test's keys, never FLUSHDB on a shared server.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import("ioredis");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const RedisCtor: any = mod.Redis ?? mod.default ?? mod;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client: any = new RedisCtor(REDIS_URL);
        try {
          let cursor = "0";
          do {
            const [next, keys] = (await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200)) as [string, string[]];
            cursor = next;
            if (keys.length > 0) {
              await client.unlink(...keys);
            }
          } while (cursor !== "0");
        } finally {
          await client.quit();
        }
      },
    };
  });

  afterEach(async () => {
    await context.cleanup();
  });

  registerRuntimeBackendMatrix(() => context);
});
