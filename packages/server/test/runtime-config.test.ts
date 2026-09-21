/**
 * RuntimeConfigManager tests (P4): generation lifecycle, admission barrier,
 * publish install hook, pinned-snapshot execution, lease disposal, and the
 * file-only fallback. Backed by the real SQLite config store plus the core
 * publish service for realistic head/snapshot material.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryConfigStore,
  createInMemoryQueue,
  createSqliteQueue,
  createConfigSecretSealing,
  isSealedSecretValue,
  parseConfigSecretsKeyMaterial,
  prepareConfigPublication,
  publishConfig,
  type ConfigChangesetOperation,
  type ConfigStore,
} from "@aicr/core";
import { createSqliteConfigStore } from "@aicr/core";
import { RuntimeConfigManager, type RuntimeConfigGeneration } from "../src/runtime-config.js";
import { createRuntimeQueue } from "../src/runtime-queue.js";

const NAMESPACE = "runtime-test";
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

let dir: string;
let store: ConfigStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aicr-runtime-config-"));
  store = await createSqliteConfigStore({ path: join(dir, "config.sqlite") });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function publishProviderRevision(
  manager: RuntimeConfigManager,
  providerId: string,
  baseRevision: number | null,
  operationId: string,
  publishStore: ConfigStore = store,
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

describe("RuntimeConfigManager", () => {
  const makeManager = () => new RuntimeConfigManager({ fileConfig: FILE_CONFIG, fileDocument: FILE_DOCUMENT,
    fileDigest: DIGEST, store, namespace: NAMESPACE, baseDir: dir });

  it("H12: null historical references keep one legacy_import across publish and restart", async () => {
    const first = makeManager();
    await first.admission();
    const baseline = await first.legacyImport();
    await publishProviderRevision(first, "after-import", null, "publish-after-import");
    expect((await first.resolveGeneration(null)).snapshotId).toBe(baseline);
    first.close();
    const restarted = makeManager();
    await restarted.admission();
    expect((await restarted.resolveGeneration(null)).snapshotId).toBe(baseline);
    expect((await restarted.captureForTask()).databaseRevision).toBe(1);
    restarted.close();
  });

  it.each(["ended", "abandoned"])("H11: %s pins are reclaimed only after all task backends are readable", async state => {
    const manager = makeManager();
    await manager.legacyImport();
    const old = await publishProviderRevision(manager, "old", null, "old-publication");
    const pin = await manager.beginSnapshotPin(old.snapshotId);
    if (state === "ended") await manager.endSnapshotPin(pin);
    await publishProviderRevision(manager, "new", 1, "new-publication");
    const unavailable = { listActiveConfigSnapshotIds: async () => { throw new Error("receipt backend offline"); } };
    await expect(manager.sweepSnapshots([unavailable], Date.now() + 600_000)).rejects.toThrow("receipt backend offline");
    expect(await store.readSnapshot(old.snapshotId)).not.toBeNull();
    await manager.sweepSnapshots([{ listActiveConfigSnapshotIds: async () => [old.snapshotId] }], Date.now() + 600_000);
    expect(await store.readSnapshot(old.snapshotId)).not.toBeNull();
    await manager.sweepSnapshots([{ listActiveConfigSnapshotIds: async () => [] }], Date.now() + 600_000);
    expect(await store.readSnapshot(old.snapshotId)).toBeNull();
    manager.close();
  });

  it("H11: failed pin persistence prevents the admission callback", async () => {
    const manager = makeManager();
    const generation = await manager.admission();
    const accept = vi.fn(async () => "accepted");
    const failure = vi.spyOn(store, "writeRuntimeState").mockRejectedValueOnce(new Error("pin unavailable"));
    await expect(manager.withAdmissionPin(generation.snapshotId, accept)).rejects.toThrow("pin unavailable");
    expect(accept).not.toHaveBeenCalled();
    failure.mockRestore();
    manager.close();
  });

  it("H16: drain waits for the running generation and its durable pin release", async () => {
    vi.useFakeTimers();
    try {
      const manager = makeManager();
      const generation = await manager.admission();
      let release!: () => void;
      const body = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const task = manager.withGeneration(generation, async () => { entered(); await body; });
      await ready;
      let drained = false;
      const draining = manager.drain().then(() => { drained = true; });
      // Two full drain poll ticks (25ms each) must pass without completing.
      await vi.advanceTimersByTimeAsync(60);
      expect(drained).toBe(false);
      release();
      await task;
      // The next poll tick observes the release and finishes the drain.
      await vi.advanceTimersByTimeAsync(30);
      await draining;
      const pins = (await store.listRuntimeStates(NAMESPACE)).filter(record => record.key.startsWith("pin/"));
      expect(pins).toHaveLength(1);
      expect(pins[0]?.value).toMatchObject({ state: "ended" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("H16: adopting a snapshot already leased by a worker preserves ownership through drain", async () => {
    const publisher = makeManager();
    const published = await publishProviderRevision(publisher, "remote", null, "remote-publication");
    publisher.close();
    const disposed = vi.fn();
    const manager = new RuntimeConfigManager({ fileConfig: FILE_CONFIG, fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST, store, namespace: NAMESPACE, baseDir: dir, onGenerationDispose: disposed });
    const prepare = vi.fn<(generation: RuntimeConfigGeneration) => Promise<void>>(async () => {});
    await manager.setGenerationPreparer(prepare);
    const lease = await manager.lease(published.snapshotId);
    vi.useFakeTimers();
    try {
      const adopted = await manager.admission();
      expect(adopted).toBe(lease.generation);
      expect(manager.status().activeLeases).toBe(1);
      expect(prepare.mock.calls.filter(([generation]) => generation.snapshotId === published.snapshotId)).toHaveLength(1);
      let drained = false;
      const draining = manager.drain().then(() => { drained = true; });
      // Two full drain poll ticks (25ms each) must pass without completing.
      await vi.advanceTimersByTimeAsync(60);
      expect(drained).toBe(false);
      expect(disposed.mock.calls.some(([generation]) => generation.snapshotId === published.snapshotId)).toBe(false);
      lease.release();
      // The next poll tick observes the release and finishes the drain.
      await vi.advanceTimersByTimeAsync(30);
      await draining;
      expect(disposed.mock.calls.filter(([generation]) => generation.snapshotId === published.snapshotId)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      lease.release();
      manager.close();
    }
  });

  it("M17: drain refuses new admissions but waits for accepted timers and their final writes", async () => {
    vi.useFakeTimers();
    try {
      const manager = makeManager();
      const generation = await manager.admission();
      const finish = manager.retainBackgroundTask();
      let drained = false;
      const draining = manager.drain().then(() => { drained = true; });
      await expect(manager.admission()).rejects.toThrow("draining");
      expect(manager.status()).toMatchObject({ draining: true, pendingTasks: 1 });
      // The accepted timer can still acquire its pinned generation after drain starts.
      await manager.withGeneration(generation, async () => {});
      // Two full drain poll ticks (25ms each) must pass without completing.
      await vi.advanceTimersByTimeAsync(60);
      expect(drained).toBe(false);
      finish();
      finish();
      // The next poll tick observes the released task and finishes the drain.
      await vi.advanceTimersByTimeAsync(30);
      await draining;
      expect(manager.status().pendingTasks).toBe(0);
      await expect(manager.admission()).rejects.toThrow("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("H16: drain waits while an accepted historical lease is still loading", async () => {
    const manager = makeManager();
    const first = await publishProviderRevision(manager, "old-loading", null, "old-loading");
    await publishProviderRevision(manager, "new-loading", 1, "new-loading");
    const read = store.readSnapshot.bind(store);
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(store, "readSnapshot").mockImplementation(async id => {
      if (id === first.snapshotId) { entered(); await barrier; }
      return read(id);
    });
    const pendingLease = manager.lease(first.snapshotId);
    await started;
    vi.useFakeTimers();
    let drained = false;
    const draining = manager.drain().then(() => { drained = true; });
    try {
      // Two full drain poll ticks (25ms each) must pass without completing.
      await vi.advanceTimersByTimeAsync(60);
      expect(drained).toBe(false);
      resume();
      const lease = await pendingLease;
      expect(manager.status().activeLeases).toBe(1);
      lease.release();
      // The next poll tick observes the release and finishes the drain.
      await vi.advanceTimersByTimeAsync(30);
      await draining;
    } finally {
      vi.useRealTimers();
      resume();
      (await pendingLease.catch(() => null))?.release();
      await draining;
      spy.mockRestore();
    }
  });

  it.each(["memory", "sqlite"])("H08/H10: %s queue versions survive duplicate enqueue, publish and restart", async kind => {
    const manager = makeManager();
    await manager.legacyImport();
    const openQueue = () => kind === "sqlite" ? createSqliteQueue({ path: join(dir, "queue.sqlite") }) : Promise.resolve(createInMemoryQueue());
    let rawQueue = await openQueue();
    const wrapped = createRuntimeQueue(rawQueue, store, NAMESPACE, manager);
    const old = await publishProviderRevision(manager, "old", null, "queue-old");
    const job = await wrapped.queue.enqueue({ sentinel: "original" }, { id: "stable", workspaceId: "ws", triggerName: "test" });
    await publishProviderRevision(manager, "new", 1, "queue-new");
    const duplicate = await wrapped.queue.enqueue({ sentinel: "replacement" }, { id: "stable", workspaceId: "ws", triggerName: "test" });
    expect(duplicate.configVersion).toEqual(job.configVersion);
    expect(duplicate.data).toEqual({ sentinel: "original" });
    manager.close();
    if (kind === "sqlite") {
      rawQueue.close?.();
      rawQueue = await openQueue();
    }
    const restarted = makeManager();
    await restarted.admission();
    const recovered = createRuntimeQueue(rawQueue, store, NAMESPACE, restarted);
    const claimed = await recovered.queue.dequeue("worker");
    expect(claimed?.configVersion?.configSnapshotId).toBe(old.snapshotId);
    expect((await restarted.resolveGeneration(claimed!.configVersion!.configSnapshotId)).databaseRevision).toBe(1);
    expect(await recovered.listActiveConfigSnapshotIds(Date.now())).toEqual([old.snapshotId]);
    await recovered.queue.complete(job.id);
    expect(await recovered.listActiveConfigSnapshotIds(Date.now())).toEqual([]);
    expect((await recovered.queue.getJob(job.id))?.configVersion).toEqual(job.configVersion);
    restarted.close();
    rawQueue.close?.();
  });

  it("file-only mode keeps a single static generation", async () => {
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    expect(manager.mode).toBe("file-only");
    const generation = await manager.admission();
    expect(generation.snapshotId).toBeNull();
    expect(generation.databaseRevision).toBeNull();
    // Admission is idempotent without a store: same generation object.
    expect(await manager.admission()).toBe(generation);
    // Legacy pins resolve to the current generation.
    expect((await manager.resolveGeneration(null)).config.llm.providers[0]?.id).toBe("file-main");
  });

  it("H18: corrupt queue version metadata fails instead of adopting the legacy baseline", async () => {
    const manager = makeManager();
    await manager.legacyImport();
    const wrapped = createRuntimeQueue(createInMemoryQueue(), store, NAMESPACE, manager);
    const job = await wrapped.queue.enqueue({}, { id: "corrupt", workspaceId: "ws", triggerName: "trigger" });
    const key = "queue/memory/corrupt";
    const record = await store.readRuntimeState(NAMESPACE, key);
    expect(record).not.toBeNull();
    await store.writeRuntimeState({ namespace: NAMESPACE, key, expectedVersion: record!.version,
      snapshotId: job.configVersion!.configSnapshotId, value: {}, now: Date.now() });
    await expect(wrapped.queue.getJob(job.id)).rejects.toThrow("version record is corrupt");
    await expect(wrapped.listActiveConfigSnapshotIds(Date.now() + 600_000)).rejects.toThrow("version record is corrupt");
    manager.close();
  });

  it("requires the raw file document in database mode (fail-closed)", () => {
    expect(() => new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
    })).toThrow(/requires the raw/);
  });

  it("database mode with an empty namespace serves the merged file view", async () => {
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    const generation = await manager.admission();
    expect(generation.databaseRevision).toBeNull();
    expect(generation.config.llm.providers.map((provider) => provider.id)).toEqual(["file-main"]);
  });

  it("adoption at startup and refresh on head advance (H01/H06)", async () => {
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    await manager.admission();
    expect(manager.current().config.llm.providers).toHaveLength(1);

    // Another writer publishes revision 1.
    const prepared = prepareConfigPublication({
      namespace: NAMESPACE,
      baseRevision: null,
      operationId: "external-1",
      actor: "other-replica",
      file: FILE_DOCUMENT,
      fileDigest: DIGEST,
      current: {},
      operations: [providerCreate("db-main", "ollama")],
      formatVersion: 2,
    });
    const published = await publishConfig(store, prepared, {});
    expect(published.status).toBe("committed");

    // The local admission barrier sees the new generation.
    const generation = await manager.admission();
    expect(generation.databaseRevision).toBe(1);
    expect(generation.snapshotId).not.toBeNull();
    const ids = generation.config.llm.providers.map((provider) => provider.id).sort();
    expect(ids).toEqual(["db-main", "file-main"]);

    // No head movement → same generation object (no rebuild churn).
    expect(await manager.admission()).toBe(generation);
  });

  it("install hook activates the committed revision immediately", async () => {
    const disposed: string[] = [];
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
      onGenerationDispose: (generation) => disposed.push(generation.snapshotId ?? "file-only"),
    });
    await manager.admission();
    const first = manager.current();
    const { snapshotId } = await publishProviderRevision(manager, "db-main", null, "op-install-1");
    expect(manager.current().snapshotId).toBe(snapshotId);
    expect(manager.current().databaseRevision).toBe(1);
    // The retired empty generation had no lease → disposed immediately (H16).
    expect(disposed).toContain("file-only");
    expect(manager.current()).not.toBe(first);
  });

  it("execution pins resolve the admission snapshot, not the current head (H08)", async () => {
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    await manager.admission();
    const first = await publishProviderRevision(manager, "db-a", null, "op-pin-1");
    const lease = await manager.lease(first.snapshotId);
    const pinned = lease.generation;
    expect(pinned.config.llm.providers.map((provider) => provider.id).sort()).toEqual(["db-a", "file-main"]);

    // A second publish advances the head; the pin still resolves revision 1.
    await publishProviderRevision(manager, "db-b", first.revision, "op-pin-2");
    expect(manager.current().databaseRevision).toBe(2);
    const stillPinned = await manager.resolveGeneration(first.snapshotId);
    expect(stillPinned).toBe(pinned);
    expect(stillPinned.config.llm.providers.map((provider) => provider.id).sort()).toEqual(["db-a", "file-main"]);
    // null pin = legacy → current generation.
    expect((await manager.resolveGeneration(null)).databaseRevision).toBe(2);
    lease.release();
  });

  it("a missing pinned snapshot fails loudly instead of drifting (H12)", async () => {
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    await expect(manager.resolveGeneration("cfg-does-not-exist")).rejects.toThrow(/missing/);
  });

  it("admission stops on file digest mismatch instead of serving a stale merge (H18)", async () => {
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    await publishProviderRevision(manager, "db-main", null, "op-digest-1");
    await manager.admission();

    // A different process boots with a different file but the same store…
    const drifted = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: "b".repeat(64),
      store,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    await expect(drifted.admission()).rejects.toThrow(/file digest/);
    // The already-installed manager keeps admitting: its file is unchanged.
    await expect(manager.admission()).resolves.toBeDefined();
  });

  it("leases dispose retired generations only after the last release (H16)", async () => {
    const disposed: (string | null)[] = [];
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
      onGenerationDispose: (generation) => disposed.push(generation.snapshotId),
    });
    await manager.admission();
    const first = await publishProviderRevision(manager, "db-a", null, "op-lease-1");
    // The initial empty-DB generation was retired (unleased) by that publish.
    disposed.length = 0;
    const leaseA = await manager.lease(first.snapshotId);
    const leaseB = await manager.lease(first.snapshotId);
    expect(manager.status().activeLeases).toBe(2);

    await publishProviderRevision(manager, "db-b", first.revision, "op-lease-2");
    leaseA.release();
    expect(disposed).toEqual([]); // leaseB still holds the generation
    leaseB.release();
    expect(disposed).toEqual([first.snapshotId]);
    // Double release is a no-op.
    leaseB.release();
    expect(disposed).toEqual([first.snapshotId]);
  });

  it("restart adopts the durable head and repairs a missing snapshot", async () => {
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    const first = await publishProviderRevision(manager, "db-a", null, "op-restart-1");

    // Simulate a crashed writer that committed but never wrote the snapshot.
    const second = prepareConfigPublication({
      namespace: NAMESPACE,
      baseRevision: first.revision,
      operationId: "op-restart-2",
      actor: "test",
      file: FILE_DOCUMENT,
      fileDigest: DIGEST,
      current: (await store.readRevision(NAMESPACE, first.revision))?.document ?? {},
      operations: [providerCreate("db-b", "ollama")],
      formatVersion: 2,
    });
    const result = await publishConfig(store, second, {});
    expect(result.status).toBe("committed");

    const restarted = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    const generation = await restarted.admission();
    expect(generation.databaseRevision).toBe(2);
    expect(generation.snapshotId).not.toBeNull();
    // The self-healed snapshot is durable now.
    expect(await store.readSnapshot(generation.snapshotId!)).not.toBeNull();
    expect(generation.config.llm.providers.map((provider) => provider.id).sort()).toEqual(["db-a", "db-b", "file-main"]);
  });

  it("memory store satisfies the same manager contract", async () => {
    const memoryStore = createMemoryConfigStore();
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG,
      fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST,
      store: memoryStore,
      namespace: NAMESPACE,
      baseDir: dir,
    });
    await publishProviderRevision(manager, "db-memory", null, "op-memory-1", memoryStore);
    const generation = await manager.admission();
    expect(generation.config.llm.providers.map((provider) => provider.id).sort()).toEqual(["db-memory", "file-main"]);
    await memoryStore.close();
  });
});

describe("secret sealing (literal credentials at rest)", () => {
  const KEY_A = Buffer.alloc(32, 0xa).toString("base64");
  const KEY_B = Buffer.alloc(32, 0xb).toString("base64");
  const sealingA = () => createConfigSecretSealing(parseConfigSecretsKeyMaterial(KEY_A));

  function triggerCreate(name: string, token: string): ConfigChangesetOperation {
    return {
      op: "create", collection: "triggers",
      record: { id: `rec-${name}`, name, enabled: true, value: { name, kind: "gitea", base_url: "https://gitea.example", token } },
    };
  }

  async function publishSealedTrigger(
    manager: RuntimeConfigManager,
    sealing: ReturnType<typeof sealingA>,
    baseRevision: number | null,
    operationId: string,
  ): Promise<{ revision: number; snapshotId: string }> {
    const raw = prepareConfigPublication({
      namespace: NAMESPACE,
      baseRevision,
      operationId,
      actor: "test",
      file: FILE_DOCUMENT,
      fileDigest: DIGEST,
      current: baseRevision === null
        ? {}
        : ((await store.readRevision(NAMESPACE, baseRevision))?.document ?? {}),
      operations: [triggerCreate("gitea-main", "gtok-plain-secret")],
      formatVersion: 2,
    });
    const result = await publishConfig(store, raw, {
      secretSealing: sealing,
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
    if (result.status !== "committed") throw new Error(`publish failed: ${result.status}`);
    return { revision: result.revision.revision, snapshotId: result.snapshotId };
  }

  it("persists only ciphertext in revisions and snapshots while generations see plaintext", async () => {
    const sealing = sealingA();
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG, fileDocument: FILE_DOCUMENT, fileDigest: DIGEST,
      store, namespace: NAMESPACE, baseDir: dir, secretSealing: sealing,
    });
    await manager.admission();
    const { revision, snapshotId } = await publishSealedTrigger(manager, sealing, null, "sealed-trigger-1");

    const revisionRow = await store.readRevision(NAMESPACE, revision);
    const storedTrigger = (revisionRow?.document.entities?.triggers?.["rec-gitea-main"]?.value ?? {}) as Record<string, unknown>;
    expect(isSealedSecretValue(storedTrigger.token)).toBe(true);
    expect(JSON.stringify(revisionRow?.document)).not.toContain("gtok-plain-secret");

    const snapshot = await store.readSnapshot(snapshotId);
    expect(JSON.stringify(snapshot?.sanitizedEffectiveConfig)).not.toContain("gtok-plain-secret");
    const snapshotTrigger = (snapshot?.sanitizedEffectiveConfig as { triggers: Record<string, unknown>[] }).triggers[0]!;
    expect(isSealedSecretValue(snapshotTrigger.token)).toBe(true);

    const generation = await manager.captureForTask();
    const trigger = (generation.config as { triggers: Record<string, unknown>[] }).triggers[0]!;
    expect(trigger.token).toBe("gtok-plain-secret");
    manager.close();
  });

  it("fails closed when the sealing key is missing at runtime", async () => {
    const sealing = sealingA();
    const writer = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG, fileDocument: FILE_DOCUMENT, fileDigest: DIGEST,
      store, namespace: NAMESPACE, baseDir: dir, secretSealing: sealing,
    });
    await writer.admission();
    await publishSealedTrigger(writer, sealing, null, "sealed-trigger-2");
    writer.close();

    const keyless = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG, fileDocument: FILE_DOCUMENT, fileDigest: DIGEST,
      store, namespace: NAMESPACE, baseDir: dir,
    });
    await expect(keyless.admission()).rejects.toThrow(/AICR_CONFIG_SECRETS_KEY/u);
    keyless.close();
  });

  it("opens values sealed with a retired key after rotation", async () => {
    const sealing = sealingA();
    const writer = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG, fileDocument: FILE_DOCUMENT, fileDigest: DIGEST,
      store, namespace: NAMESPACE, baseDir: dir, secretSealing: sealing,
    });
    await writer.admission();
    await publishSealedTrigger(writer, sealing, null, "sealed-trigger-3");
    writer.close();

    const rotated = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG, fileDocument: FILE_DOCUMENT, fileDigest: DIGEST,
      store, namespace: NAMESPACE, baseDir: dir,
      secretSealing: createConfigSecretSealing(parseConfigSecretsKeyMaterial(KEY_B), [parseConfigSecretsKeyMaterial(KEY_A)]),
    });
    await rotated.admission();
    const generation = await rotated.captureForTask();
    const trigger = (generation.config as { triggers: Record<string, unknown>[] }).triggers[0]!;
    expect(trigger.token).toBe("gtok-plain-secret");
    rotated.close();
  });

  it("requires no key when only env references are used", async () => {
    const manager = new RuntimeConfigManager({
      fileConfig: FILE_CONFIG, fileDocument: FILE_DOCUMENT, fileDigest: DIGEST,
      store, namespace: NAMESPACE, baseDir: dir,
    });
    await manager.admission();
    await publishProviderRevision(manager, "plain-provider", null, "plain-publication");
    expect((await manager.captureForTask()).databaseRevision).toBe(1);
    manager.close();
  });
});

describe("generation regression boundaries", () => {
  function create(overrides: Partial<ConstructorParameters<typeof RuntimeConfigManager>[0]> = {}) {
    return new RuntimeConfigManager({ fileConfig: FILE_CONFIG, fileDocument: FILE_DOCUMENT,
      fileDigest: DIGEST, store, namespace: NAMESPACE, baseDir: dir, ...overrides });
  }

  it("persists the empty namespace generation so pre-publication work survives restart", async () => {
    const manager = create();
    const empty = await manager.admission();
    expect(empty.snapshotId).toMatch(/^cfg-/);
    expect((await store.readSnapshot(empty.snapshotId!))?.databaseRevision).toBe(0);
    await publishProviderRevision(manager, "later", null, "op-empty-pin");
    const restarted = create();
    await restarted.admission();
    const old = await restarted.resolveGeneration(empty.snapshotId);
    expect(old.config.llm.providers.map(p => p.id)).toEqual(["file-main"]);
  });

  it("freezes config descendants and does not retain caller-owned input objects", async () => {
    const input = structuredClone(FILE_CONFIG);
    const manager = create({ fileConfig: input });
    const generation = await manager.admission();
    expect(Object.isFrozen(generation.config.llm.providers[0])).toBe(true);
    expect(() => { generation.config.llm.providers[0]!.id = "mutated"; }).toThrow();
  });

  it("rejects a missing head after publication instead of reverting to file-only", async () => {
    const manager = create();
    await publishProviderRevision(manager, "db", null, "op-vanished");
    vi.spyOn(store, "readHead").mockResolvedValueOnce(null);
    await expect(manager.admission()).rejects.toThrow(/disappeared/);
    expect(manager.current().databaseRevision).toBe(1);
  });

  it("checks file identity before attempting missing-snapshot recovery", async () => {
    const manager = create();
    await publishProviderRevision(manager, "db", null, "op-mismatch");
    const read = vi.spyOn(store, "readSnapshot").mockResolvedValue(null);
    const write = vi.spyOn(store, "writeSnapshot");
    await expect(create({ fileDigest: "b".repeat(64) }).admission()).rejects.toThrow(/file digest/);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not activate corrupt immutable snapshots", async () => {
    const manager = create();
    const { snapshotId } = await publishProviderRevision(manager, "db", null, "op-corrupt");
    const snapshot = (await store.readSnapshot(snapshotId))!;
    vi.spyOn(store, "readSnapshot").mockResolvedValue({ ...snapshot, contentHash: "bad" });
    await expect(create().admission()).rejects.toThrow(/hash mismatch/);
  });

  it("rejects cross-namespace historical snapshots", async () => {
    const manager = create();
    const first = await publishProviderRevision(manager, "db", null, "op-namespace");
    await expect(create({ namespace: "unrelated" }).resolveGeneration(first.snapshotId)).rejects.toThrow(/namespace/);
  });

  it("a delayed publication install adopts the latest head", async () => {
    const manager = create();
    await publishProviderRevision(manager, "a", null, "op-late-1");
    const first = manager.current();
    const revision = (await store.readRevision(NAMESPACE, 1))!;
    await publishProviderRevision(manager, "b", 1, "op-late-2");
    await manager.install({ effective: first.config, revision: 1, revisionContentHash: revision.contentHash,
      fileDigest: DIGEST, formatVersion: 2 });
    expect(manager.current().databaseRevision).toBe(2);
  });

  it("concurrent historical leases share ownership and close waits for the last release", async () => {
    const disposed: (string | null)[] = [];
    const manager = create({ onGenerationDispose: g => disposed.push(g.snapshotId) });
    const first = await publishProviderRevision(manager, "a", null, "op-load-1");
    await publishProviderRevision(manager, "b", 1, "op-load-2");
    disposed.length = 0;
    const [a, b] = await Promise.all([manager.lease(first.snapshotId), manager.lease(first.snapshotId)]);
    expect(a.generation).toBe(b.generation);
    expect(manager.status().activeLeases).toBe(2);
    manager.close();
    expect(disposed).not.toContain(first.snapshotId);
    a.release();
    expect(disposed).not.toContain(first.snapshotId);
    b.release();
    expect(disposed.filter(id => id === first.snapshotId)).toHaveLength(1);
    await expect(manager.admission()).rejects.toThrow(/closed/);
  });

  it("forgetPinned cannot dispose the active generation", async () => {
    const disposed: (string | null)[] = [];
    const manager = create({ onGenerationDispose: g => disposed.push(g.snapshotId) });
    const current = await manager.admission();
    await manager.resolveGeneration(current.snapshotId);
    disposed.length = 0;
    manager.forgetPinned(current.snapshotId!);
    expect(disposed).toEqual([]);
  });
});
