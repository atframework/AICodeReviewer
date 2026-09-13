import { randomUUID } from "node:crypto";
import { ConfigError, isPlainObject, type ConfigRuntimeState, type ConfigStore, type ExecutionConfigVersion, type QueueEnqueueOptions, type QueueJob, type ReviewQueue } from "@aicr/core";
import type { RuntimeConfigManager } from "./runtime-config.js";

/** AICR-owned version ledger; never writes BullMQ's private storage. */
export function createRuntimeQueue(queue: ReviewQueue, store: ConfigStore, namespace: string, manager: RuntimeConfigManager): {
  queue: ReviewQueue;
  listActiveConfigSnapshotIds(now: number): Promise<readonly string[]>;
} {
  const keyFor = (id: string) => `queue/${queue.kind}/${id}`;
  const versionFor = (record: ConfigRuntimeState): ExecutionConfigVersion => {
    const value = isPlainObject(record.value) ? record.value : {};
    const version = isPlainObject(value.configVersion) ? value.configVersion : {};
    if (typeof value.jobId !== "string" || keyFor(value.jobId) !== record.key ||
        typeof version.configSnapshotId !== "string" || !version.configSnapshotId ||
        (record.snapshotId !== null && record.snapshotId !== version.configSnapshotId) ||
        (version.databaseRevision !== null && !(Number.isSafeInteger(version.databaseRevision) && Number(version.databaseRevision) >= 0)) ||
        typeof version.fileDigest !== "string" || !/^[0-9a-f]{64}$/.test(version.fileDigest)) {
      throw new ConfigError("snapshot_invalid", "Queue configuration version record is corrupt.");
    }
    return version as unknown as ExecutionConfigVersion;
  };
  const hydrate = async <T>(job: QueueJob<T> | undefined): Promise<QueueJob<T> | undefined> => {
    if (!job) return undefined;
    const record = await store.readRuntimeState(namespace, keyFor(job.id));
    if (record) return { ...job, configVersion: versionFor(record) };
    // Pre-upgrade jobs keep the deployment's single durable import baseline.
    const generation = await manager.resolveGeneration(await manager.legacyImport());
    return { ...job, configVersion: { configSnapshotId: generation.snapshotId, databaseRevision: generation.databaseRevision, fileDigest: generation.fileDigest } };
  };
  return {
    queue: {
      ...queue,
      async enqueue<T>(data: T, options: QueueEnqueueOptions): Promise<QueueJob<T>> {
        const id = options.id ?? randomUUID();
        const existing = await hydrate(await queue.getJob(id));
        if (existing) return existing as QueueJob<T>;
        const generation = await manager.captureForTask();
        const configVersion: ExecutionConfigVersion = { configSnapshotId: generation.snapshotId,
          databaseRevision: generation.databaseRevision, fileDigest: generation.fileDigest };
        let record = await store.writeRuntimeState({ namespace, key: keyFor(id), expectedVersion: null,
          snapshotId: generation.snapshotId, value: { configVersion, instanceId: manager.instanceId, phase: "preparing", jobId: id }, now: Date.now() });
        record ??= await store.readRuntimeState(namespace, keyFor(id));
        if (!record?.snapshotId) throw new ConfigError("snapshot_invalid", "Queue version reservation is unavailable.");
        versionFor(record);
        const job = await queue.enqueue(data, { ...options, id });
        const confirmed = await store.writeRuntimeState({ namespace, key: record.key, expectedVersion: record.version,
          snapshotId: record.snapshotId, value: { ...(record.value as object), phase: "enqueued" }, now: Date.now() });
        if (!confirmed) {
          const winner = await store.readRuntimeState(namespace, record.key);
          if (!winner?.snapshotId) throw new ConfigError("store_unavailable", "Queue version reservation expired before acceptance.");
        }
        return (await hydrate(job))!;
      },
      async dequeue(...args) { return hydrate(await queue.dequeue(...args)); },
      async getJob(id) { return hydrate(await queue.getJob(id)); },
      async getDeadJobs() { return Promise.all((await queue.getDeadJobs()).map(async job => (await hydrate(job))!)); },
      async requeueDead(id) { return hydrate(await queue.requeueDead(id)); },
    },
    async listActiveConfigSnapshotIds(now) {
      const records = await store.listRuntimeStates(namespace);
      const live = new Set(records.filter(record => record.key.startsWith("instance/") && record.updatedAt > now - 300_000)
        .map(record => record.key.slice("instance/".length)));
      const references = new Set<string>();
      const retired: typeof records[number][] = [];
      for (const record of records) {
        if (!record.key.startsWith(`queue/${queue.kind}/`) || !record.snapshotId) continue;
        versionFor(record);
        const value = record.value as { jobId: string; phase: string; instanceId: string };
        const job = await queue.getJob(value.jobId);
        const preparing = value.phase === "preparing" && (record.updatedAt > now - 300_000 || live.has(value.instanceId));
        if (preparing || (job && job.status !== "completed")) references.add(record.snapshotId);
        else retired.push(record);
      }
      // Query every job before releasing anything; unavailable storage stops GC.
      for (const record of retired) await store.writeRuntimeState({ namespace, key: record.key, expectedVersion: record.version,
        snapshotId: null, value: record.value, now });
      return [...references];
    },
  };
}
