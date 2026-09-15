/**
 * Runtime config manager (architecture §3.15.2, P4). Owns immutable configuration
 * generations built from (raw file document + database revision + defaults),
 * each carrying its parsed effective config, compiled execution graph, and
 * workspace runtime.
 *
 * Invariants:
 * - One task reads one generation. Admission paths call `admission()` which
 *   re-reads the durable head (H15: a replica either sees the new version or
 *   must not accept work) and never serves a stale generation silently.
 * - Persisted work pins its `snapshotId` at admission; execution resolves it
 *   via `lease()` (H08). A pinned snapshot that can no longer be loaded is a
 *   hard failure, never a silent fall-forward to a newer config (H12).
 * - `install()` is the publishConfig generation hook: it activates an already
 *   committed revision locally. Retired generations stay alive until their
 *   last lease is released (H16); disposal hooks run exactly once.
 * - File-only mode (no config store) exposes exactly one static generation —
 *   identical to the pre-P4 process-lifetime config behavior.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  validateConfigNamespace,
  assertConfigSecretPolicy,
  compileExecutionGraph,
  configSnapshotId as computeSnapshotId,
  CONFIG_RESOLVER_VERSION,
  ConfigError,
  contentHashOf,
  isConfigError,
  mergeConfigSources,
  parseEffectiveConfig,
  scrubText,
  isPlainObject,
  sweepUnreferencedConfigSnapshots,
  validateDatabaseDocument,
  type AppConfig,
  type AppConfigInput,
  type ConfigRuntimeSnapshotRecord,
  type ConfigStore,
  type ConfigRuntimeState,
  type ConfigSnapshotReferenceSource,
  type EffectiveConfigV2,
  type ExecutionGraph,
} from "@aicr/core";
import { createWorkspaceRuntime, type WorkspaceRuntime } from "./workspace-runtime.js";

export interface RuntimeConfigGeneration {
  /** Durable snapshot id, or `null` for the file-only generation (legacy). */
  readonly snapshotId: string | null;
  /** Database revision this generation was built from; null when file-only. */
  readonly databaseRevision: number | null;
  /** File digest the generation merged against; null when unknown. */
  readonly fileDigest: string | null;
  readonly config: EffectiveConfigV2;
  readonly graph: ExecutionGraph;
  readonly workspaceRuntime: WorkspaceRuntime;
}

interface GenerationEntry {
  readonly generation: RuntimeConfigGeneration;
  retired: boolean;
  refCount: number;
  disposed: boolean;
  readonly dispose: (() => void) | undefined;
}

export interface RuntimeConfigLease {
  readonly generation: RuntimeConfigGeneration;
  /** Idempotent; drops one reference, disposing a retired entry at zero. */
  release(): void;
}

export interface RuntimeConfigManagerOptions {
  /** Parsed file config (bootstrap slice; always available). */
  readonly fileConfig: AppConfig;
  /**
   * Legacy-converted raw file document (pre-defaults). Required in database
   * mode: the merge contract forbids feeding defaults-filled documents.
   */
  readonly fileDocument?: AppConfigInput | undefined;
  /** SHA-256 of the exact file bytes; enables file_config_mismatch checks. */
  readonly fileDigest?: string | undefined;
  /** Config store handle; absent selects file-only mode. The manager never closes it. */
  readonly store?: ConfigStore | undefined;
  readonly namespace: string;
  readonly baseDir: string;
  /** Generation-scoped resource disposal (H16); runs once at zero refs. */
  readonly onGenerationDispose?: ((generation: RuntimeConfigGeneration) => void) | undefined;
}

export interface RuntimeConfigStatus {
  readonly mode: "file-only" | "database";
  readonly snapshotId: string | null;
  readonly databaseRevision: number | null;
  readonly fileDigest: string | null;
  /** Active leases across all generations (current + pinned history). */
  readonly activeLeases: number;
  /** Generations built since process start (admission swaps included). */
  readonly generationsBuilt: number;
  readonly draining: boolean;
  readonly pendingTasks: number;
}

function buildGeneration(input: {
  readonly config: EffectiveConfigV2;
  readonly snapshotId: string | null;
  readonly databaseRevision: number | null;
  readonly fileDigest: string | null;
  readonly baseDir: string;
}): RuntimeConfigGeneration {
  const config = freezeConfig(structuredClone(input.config));
  return Object.freeze({
    snapshotId: input.snapshotId,
    databaseRevision: input.databaseRevision,
    fileDigest: input.fileDigest,
    config,
    graph: Object.freeze(compileExecutionGraph(config)),
    workspaceRuntime: createWorkspaceRuntime(config, input.baseDir),
  });
}

function freezeConfig<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeConfig);
    Object.freeze(value);
  }
  return value;
}

export class RuntimeConfigManager {
  readonly instanceId = randomUUID();
  private legacySnapshotId: string | undefined;
  private instanceVersion: number | null = null;
  private heartbeatQueue: Promise<void> = Promise.resolve();

  /** One persistent baseline, selected before any old work may be claimed. */
  async legacyImport(): Promise<string | null> {
    if (!this.store) return null;
    if (this.legacySnapshotId) return this.legacySnapshotId;
    let record = await this.store.readRuntimeState(this.namespace, "legacy_import");
    if (!record) {
      const generation = await this.admission();
      record = await this.store.writeRuntimeState({ namespace: this.namespace, key: "legacy_import", expectedVersion: null,
        snapshotId: generation.snapshotId, value: { source: "legacy_import", databaseRevision: generation.databaseRevision, fileDigest: generation.fileDigest }, now: Date.now() });
      record ??= await this.store.readRuntimeState(this.namespace, "legacy_import");
    }
    if (!record?.snapshotId) throw new ConfigError("snapshot_invalid", "Legacy import baseline is unavailable.");
    this.legacySnapshotId = record.snapshotId;
    return record.snapshotId;
  }

  async beginSnapshotPin(snapshotId: string | null): Promise<ConfigRuntimeState | null> {
    if (!this.store || !snapshotId) return null;
    const record = await this.store.writeRuntimeState({ namespace: this.namespace, key: `pin/${randomUUID()}`,
      expectedVersion: null, snapshotId, value: { state: "active", instanceId: this.instanceId }, now: Date.now() });
    if (!record) throw new ConfigError("store_unavailable", "Cannot acquire an admission pin.");
    return record;
  }

  /** Leave a durable ended pin until a sweep verifies every task backend. */
  async endSnapshotPin(pin: ConfigRuntimeState | null): Promise<void> {
    if (!this.store || !pin) return;
    const result = await this.store.writeRuntimeState({ namespace: this.namespace, key: pin.key, expectedVersion: pin.version,
      snapshotId: pin.snapshotId, value: { state: "ended", instanceId: this.instanceId }, now: Date.now() });
    if (!result) throw new ConfigError("store_unavailable", "Admission pin expired before confirmation.");
  }

  async withAdmissionPin<T>(snapshotId: string | null, accept: () => Promise<T>): Promise<T> {
    const pin = await this.beginSnapshotPin(snapshotId);
    let result: T;
    try { result = await accept(); } catch (error) {
      // Failed/unknown writes remain pinned until all backends can be checked.
      await this.endSnapshotPin(pin).catch(() => {});
      throw error;
    }
    await this.endSnapshotPin(pin);
    return result;
  }

  async heartbeat(): Promise<void> {
    const pending = this.heartbeatQueue.then(() => this.writeHeartbeat());
    this.heartbeatQueue = pending.catch(() => {});
    return pending;
  }

  private async writeHeartbeat(): Promise<void> {
    if (!this.store || this.closed) return;
    const current = this.currentEntry.generation;
    const record = await this.store.writeRuntimeState({ namespace: this.namespace, key: `instance/${this.instanceId}`,
      expectedVersion: this.instanceVersion, snapshotId: current.snapshotId,
      value: this.status(), now: Date.now() });
    if (!record) {
      // A disconnected instance may have been retired by another replica.
      const existing = await this.store.readRuntimeState(this.namespace, `instance/${this.instanceId}`);
      this.instanceVersion = existing?.version ?? null;
      throw new ConfigError("store_unavailable", "Instance activation record changed; retry admission.");
    }
    this.instanceVersion = record.version;
  }

  async instanceStatuses(): Promise<readonly ConfigRuntimeState[]> {
    return this.store ? (await this.store.listRuntimeStates(this.namespace)).filter(record => record.key.startsWith("instance/")) : [];
  }

  async sweepSnapshots(sources: readonly ConfigSnapshotReferenceSource[], now = Date.now()): Promise<void> {
    if (!this.store || this.closed) return;
    // Read pins first. A new admission racing the subsequent source queries
    // leaves a newer pin that this sweep cannot release.
    const records = await this.store.listRuntimeStates(this.namespace);
    const references = new Set<string>();
    for (const source of sources) for (const id of await source.listActiveConfigSnapshotIds(now)) references.add(id);
    const liveInstances = new Set(records.filter(record => record.key.startsWith("instance/") && record.updatedAt > now - 300_000)
      .map(record => record.key.slice("instance/".length)));
    const local = this.currentEntry.generation.snapshotId;
    if (local) references.add(local);
    for (const record of records) {
      if (record.key.startsWith("instance/") && record.updatedAt <= now - 300_000 && record.key !== `instance/${this.instanceId}`) {
        await this.store.deleteRuntimeState(this.namespace, record.key, record.version);
      }
      if (!record.key.startsWith("pin/") || !record.snapshotId || references.has(record.snapshotId) || !isPlainObject(record.value)) continue;
      const abandoned = record.updatedAt <= now - 300_000 && !liveInstances.has(String(record.value.instanceId));
      if (record.value.state === "ended" || abandoned) await this.store.deleteRuntimeState(this.namespace, record.key, record.version);
    }
    const result = await sweepUnreferencedConfigSnapshots(this.store, { namespace: this.namespace, olderThan: now - 300_000,
      now, referencedBy: [{ listActiveConfigSnapshotIds: async () => [...references] }] });
    for (const id of result.deleted) {
      this.forgetPinned(id);
      const metadata = await this.store.readRuntimeState(this.namespace, `catalog/${id}`);
      if (metadata) await this.store.deleteRuntimeState(this.namespace, metadata.key, metadata.version);
    }
  }
  private readonly store: ConfigStore | undefined;
  private readonly namespace: string;
  private readonly baseDir: string;
  private readonly fileConfig: AppConfig;
  private readonly fileDocument: AppConfigInput | undefined;
  private readonly fileDigest: string | null;
  private readonly onGenerationDispose: ((generation: RuntimeConfigGeneration) => void) | undefined;

  private currentEntry: GenerationEntry;
  /** Pinned historical generations, keyed by snapshotId (current excluded). */
  private readonly pinnedEntries = new Map<string, GenerationEntry>();
  /** Ownership is independent of which snapshot currently occupies a cache slot. */
  private readonly entries = new Set<GenerationEntry>();
  private generationsBuilt = 0;
  private closed = false;
  private draining = false;
  private pendingTasks = 0;
  private refreshQueue: Promise<unknown> = Promise.resolve();
  private readonly loading = new Map<string, Promise<GenerationEntry>>();
  private readonly scope = new AsyncLocalStorage<RuntimeConfigGeneration>();
  private generationPreparer: ((generation: RuntimeConfigGeneration) => Promise<void>) | undefined;
  private readonly prepared = new WeakMap<RuntimeConfigGeneration, Promise<void>>();

  /** Bootstrap installs this before dispatchers/workers become reachable. */
  async setGenerationPreparer(prepare: (generation: RuntimeConfigGeneration) => Promise<void>): Promise<void> {
    if (this.generationPreparer) throw new Error("Generation preparer is already installed.");
    this.generationPreparer = prepare;
    await this.prepareGeneration(this.currentEntry.generation);
  }

  private async prepareGeneration(generation: RuntimeConfigGeneration): Promise<void> {
    if (!this.generationPreparer) return;
    let prepared = this.prepared.get(generation);
    if (!prepared) {
      prepared = this.generationPreparer(generation).catch(error => {
        this.prepared.delete(generation);
        throw error;
      });
      this.prepared.set(generation, prepared);
    }
    await prepared;
  }

  constructor(options: RuntimeConfigManagerOptions) {
    this.store = options.store;
    this.namespace = options.namespace;
    this.baseDir = options.baseDir;
    this.fileConfig = structuredClone(options.fileConfig);
    this.fileDocument = options.fileDocument === undefined ? undefined : structuredClone(options.fileDocument);
    this.fileDigest = options.fileDigest ?? null;
    this.onGenerationDispose = options.onGenerationDispose;
    validateConfigNamespace(this.namespace);
    if (this.store !== undefined && this.fileDocument === undefined) {
      throw new ConfigError(
        "store_unavailable",
        "config_sources.database.enabled requires the raw (legacy-converted) file document for source merging; load the config through parseConfigDocumentText and pass it to bootstrap.",
      );
    }
    if (this.store !== undefined && !/^[0-9a-f]{64}$/.test(this.fileDigest ?? "")) {
      throw new ConfigError("file_config_mismatch", "Database configuration requires the SHA-256 digest of the raw file document.");
    }
    this.currentEntry = this.registerEntry(
      buildGeneration({
        config: parseEffectiveConfig(this.fileConfig, 1),
        snapshotId: null,
        databaseRevision: null,
        fileDigest: this.fileDigest,
        baseDir: this.baseDir,
      }),
      undefined,
    );
  }

  get mode(): "file-only" | "database" {
    return this.store === undefined ? "file-only" : "database";
  }

  /** Current generation without any barrier; for read-only status surfaces. */
  current(): RuntimeConfigGeneration {
    return this.scope.getStore() ?? this.currentEntry.generation;
  }

  async captureForTask(): Promise<RuntimeConfigGeneration> {
    return this.scope.getStore() ?? this.admission();
  }

  /** Shared background loops must not inherit a request's pinned view. */
  withoutGeneration<T>(run: () => T): T {
    return this.scope.exit(run);
  }

  /** Bind all config consumers, including asynchronous credential lookup. */
  async withGeneration<T>(generation: RuntimeConfigGeneration, run: () => Promise<T>): Promise<T> {
    const lease = await this.lease(generation.snapshotId);
    try {
      return await this.withAdmissionPin(lease.generation.snapshotId, () => this.scope.run(lease.generation, run));
    } finally {
      lease.release();
    }
  }

  /** Accepted async work includes timers, retries and final persistence. */
  retainBackgroundTask(): () => void {
    this.assertOpen();
    this.pendingTasks++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingTasks--;
    };
  }

  stopAdmission(): void {
    this.draining = true;
  }

  status(): RuntimeConfigStatus {
    const current = this.currentEntry.generation;
    let activeLeases = 0;
    for (const entry of this.entries) activeLeases += entry.refCount;
    return {
      mode: this.mode,
      snapshotId: current.snapshotId,
      databaseRevision: current.databaseRevision,
      fileDigest: current.fileDigest,
      activeLeases,
      draining: this.draining,
      pendingTasks: this.pendingTasks,
      generationsBuilt: this.generationsBuilt,
    };
  }

  /**
   * Admission barrier (H15): re-reads the durable head and guarantees the
   * caller either admits against the newest revision or fails. Background
   * notify/poll only accelerate this; they never replace it.
   */
  async admission(): Promise<RuntimeConfigGeneration> {
    const refresh = this.refreshQueue.then(async () => {
      this.assertOpen();
      if (this.draining) throw new ConfigError("store_unavailable", "Runtime configuration is draining; admission and claim are stopped.");
      const generation = await this.adoptHead();
      await this.prepareGeneration(generation);
      return generation;
    });
    this.refreshQueue = refresh.catch(() => {});
    return refresh;
  }

  private async adoptHead(): Promise<RuntimeConfigGeneration> {
    this.assertOpen();
    if (this.store === undefined) {
      return this.currentEntry.generation;
    }
    const head = await this.store.readHead(this.namespace);
    const current = this.currentEntry.generation;
    if (head === null) {
      if (current.databaseRevision === null && current.snapshotId !== null) {
        return current;
      }
      if (current.databaseRevision !== null) {
        throw new ConfigError("snapshot_invalid", "The active configuration head disappeared; refusing a file-only fallback.");
      }
      await this.refreshFromHead(null);
      return this.currentEntry.generation;
    }
    if (current.databaseRevision !== null && head.activeRevision < current.databaseRevision) {
      throw new ConfigError("snapshot_invalid", "The durable configuration head moved backwards.");
    }
    if (head.activeRevision === current.databaseRevision && current.snapshotId !== null) {
      return current;
    }
    await this.refreshFromHead(head.activeRevision);
    return this.currentEntry.generation;
  }

  /**
   * Execution pin (H08): resolves the generation for a task's admission-time
   * snapshot. Old null references resolve lazily to the single durable
   * legacy_import baseline established before workers start.
   *
   * Use lease() / withGeneration() to keep resource ownership through execution.
   * Unleased resolved objects may be reconstructed after retirement.
   */
  async resolveGeneration(snapshotId: string | null): Promise<RuntimeConfigGeneration> {
    const scoped = this.scope.getStore();
    if (scoped && (snapshotId === null || scoped.snapshotId === snapshotId)) return scoped;
    const generation = (await this.entryFor(snapshotId)).generation;
    await this.prepareGeneration(generation);
    return generation;
  }

  private async entryFor(snapshotId: string | null): Promise<GenerationEntry> {
    this.assertOpen();
    if (snapshotId === null) {
      const scoped = this.scope.getStore();
      if (scoped?.snapshotId) return this.entryFor(scoped.snapshotId);
      if (this.store) return this.entryFor(await this.legacyImport());
      return this.currentEntry;
    }
    if (snapshotId === this.currentEntry.generation.snapshotId) return this.currentEntry;
    const cached = this.pinnedEntries.get(snapshotId);
    if (cached && !cached.disposed) return cached;
    let pending = this.loading.get(snapshotId);
    if (!pending) {
      pending = this.loadSnapshotGeneration(snapshotId).then((generation) => {
        this.assertOpen();
        // A concurrent admission may have installed this snapshot meanwhile.
        if (this.currentEntry.generation.snapshotId === snapshotId) return this.currentEntry;
        const existing = this.pinnedEntries.get(snapshotId);
        if (existing && !existing.disposed) return existing;
        const entry = this.registerEntry(generation, undefined);
        entry.retired = true;
        this.pinnedEntries.set(snapshotId, entry);
        return entry;
      });
      this.loading.set(snapshotId, pending);
    }
    try {
      return await pending;
    } finally {
      if (this.loading.get(snapshotId) === pending) this.loading.delete(snapshotId);
    }
  }

  async lease(snapshotId: string | null): Promise<RuntimeConfigLease> {
    const finish = this.retainBackgroundTask();
    try {
      let entry = await this.entryFor(snapshotId);
      // Retirement may run while entryFor's promise resumes; never acquire
      // resources that have already been disposed.
      while (entry.disposed) entry = await this.entryFor(snapshotId);
      const lease = this.acquireEntry(entry);
      try {
        await this.prepareGeneration(entry.generation);
        return lease;
      } catch (error) { lease.release(); throw error; }
    } finally { finish(); }
  }

  /** Adopt the durable head; a delayed install can never reinstall an older revision. */
  async install(input: {
    readonly effective: EffectiveConfigV2;
    readonly revision: number;
    readonly revisionContentHash: string;
    readonly fileDigest: string | null;
    readonly formatVersion: number;
  }): Promise<RuntimeConfigGeneration> {
    this.assertOpen();
    if (input.fileDigest !== this.fileDigest) {
      throw new ConfigError("file_config_mismatch", "The published file digest differs from this replica.");
    }
    if (!this.store) throw new ConfigError("store_unavailable", "Publication requires a durable configuration store.");
    return this.admission();
  }

  /** Drops cached pinned generations whose snapshot rows were reclaimed. */
  forgetPinned(snapshotId: string): void {
    const entry = this.pinnedEntries.get(snapshotId);
    if (entry === undefined) return;
    if (entry === this.currentEntry || entry.refCount > 0) return;
    this.pinnedEntries.delete(snapshotId);
    this.disposeEntry(entry);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ConfigError("store_unavailable", "RuntimeConfigManager is closed.");
    }
  }

  private registerEntry(generation: RuntimeConfigGeneration, dispose: (() => void) | undefined): GenerationEntry {
    this.generationsBuilt += 1;
    const entry = { generation, retired: false, refCount: 0, disposed: false, dispose };
    this.entries.add(entry);
    return entry;
  }

  private acquireEntry(entry: GenerationEntry): RuntimeConfigLease {
    entry.refCount += 1;
    let released = false;
    return {
      generation: entry.generation,
      release: () => {
        if (released) return;
        released = true;
        entry.refCount -= 1;
        if (entry.refCount === 0 && entry.retired) {
          this.disposeEntry(entry);
        }
        if (this.closed && this.status().activeLeases === 0) this.scope.disable();
      },
    };
  }

  private disposeEntry(entry: GenerationEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    this.entries.delete(entry);
    const id = entry.generation.snapshotId;
    if (id && this.pinnedEntries.get(id) === entry) this.pinnedEntries.delete(id);
    this.onGenerationDispose?.(entry.generation);
    entry.dispose?.();
  }

  private swapCurrent(next: GenerationEntry): void {
    const previous = this.currentEntry;
    this.assertOpen();
    if (previous === next) return;
    next.retired = false;
    previous.retired = true;
    this.currentEntry = next;
    if (previous.refCount === 0) {
      this.disposeEntry(previous);
    }
  }

  private async refreshFromHead(activeRevision: number | null): Promise<void> {
    if (this.store === undefined || this.fileDocument === undefined) {
      throw new ConfigError("store_unavailable", "RuntimeConfigManager refresh requires a config store and file document.");
    }
    const generation = await this.buildGenerationForRevision(activeRevision);
    this.assertOpen();
    let entry = generation.snapshotId ? this.pinnedEntries.get(generation.snapshotId) : undefined;
    if (!entry || entry.disposed) {
      entry = this.registerEntry(generation, undefined);
      entry.retired = true;
      if (generation.snapshotId) this.pinnedEntries.set(generation.snapshotId, entry);
    }
    // A worker may have loaded this snapshot before the replica adopted its
    // head. Share its resources and hold them across asynchronous preparation.
    const lease = this.acquireEntry(entry);
    try {
      await this.prepareGeneration(entry.generation);
      this.swapCurrent(entry);
    } finally { lease.release(); }
  }

  private async buildGenerationForRevision(activeRevision: number | null): Promise<RuntimeConfigGeneration> {
    if (this.store === undefined || this.fileDocument === undefined) {
      throw new ConfigError("store_unavailable", "RuntimeConfigManager requires a config store and file document.");
    }
    if (activeRevision === null) {
      const effective = this.currentEntry.generation.config;
      const hash = contentHashOf(effective);
      const snapshot = await this.store.writeSnapshot({
        id: computeSnapshotId({ namespace: this.namespace, revision: 0, contentHash: hash,
          fileDigest: this.fileDigest, formatVersion: 2 }),
        namespace: this.namespace, databaseRevision: 0, fileDigest: this.fileDigest,
        resolverVersion: CONFIG_RESOLVER_VERSION, sanitizedEffectiveConfig: effective,
        contentHash: hash, now: Date.now(),
      });
      return this.generationFromSnapshot(snapshot, effective);
    }
    const revision = await this.store.readRevision(this.namespace, activeRevision);
    if (revision === null) {
      throw new ConfigError("entity_not_found", "The active configuration revision is unreadable.");
    }
    // Validate identity BEFORE any recovery write. A mismatched replica must
    // never poison the shared snapshot using its own file contents.
    if (revision.fileDigest !== this.fileDigest) {
      throw new ConfigError("file_config_mismatch", "The active revision file digest differs from this replica.");
    }
    const expectedSnapshotId = computeSnapshotId(revision);
    const database = validateDatabaseDocument(revision.document, revision.formatVersion);
    const merged = mergeConfigSources({ file: this.fileDocument, database, formatVersion: revision.formatVersion });
    const effective = parseEffectiveConfig(merged.document, revision.formatVersion);
    assertConfigSecretPolicy(this.fileDocument, database, effective);
    let snapshot = await this.store.readSnapshot(expectedSnapshotId);
    if (snapshot === null) {
      snapshot = await this.store.writeSnapshot({
        id: expectedSnapshotId, namespace: this.namespace, fileDigest: revision.fileDigest,
        databaseRevision: revision.revision, resolverVersion: CONFIG_RESOLVER_VERSION,
        sanitizedEffectiveConfig: effective, contentHash: contentHashOf(effective), now: Date.now(),
      });
    }
    return this.validateSnapshot(snapshot, expectedSnapshotId, activeRevision, revision.fileDigest);
  }

  private validateSnapshot(snapshot: ConfigRuntimeSnapshotRecord, id: string,
    revision: number, fileDigest: string | null): RuntimeConfigGeneration {
    if (snapshot.id !== id || snapshot.namespace !== this.namespace ||
      snapshot.databaseRevision !== revision || snapshot.fileDigest !== fileDigest ||
      snapshot.resolverVersion !== CONFIG_RESOLVER_VERSION) {
      throw new ConfigError("snapshot_invalid", "Config snapshot identity or resolver version mismatch.");
    }
    const effective = parseEffectiveConfig(snapshot.sanitizedEffectiveConfig, 2);
    if (contentHashOf(effective) !== snapshot.contentHash) {
      // Immutable rows cannot be repaired in place. Fail closed for operator recovery.
      throw new ConfigError("snapshot_invalid", "Config snapshot content hash mismatch.");
    }
    return this.generationFromSnapshot(snapshot, effective);
  }

  private generationFromSnapshot(
    snapshot: ConfigRuntimeSnapshotRecord,
    effective: EffectiveConfigV2,
  ): RuntimeConfigGeneration {
    return buildGeneration({
      config: effective,
      snapshotId: snapshot.id,
      databaseRevision: snapshot.databaseRevision === 0 ? null : snapshot.databaseRevision,
      fileDigest: snapshot.fileDigest,
      baseDir: this.baseDir,
    });
  }

  private async loadSnapshotGeneration(snapshotId: string): Promise<RuntimeConfigGeneration> {
    if (this.store === undefined) {
      throw new ConfigError("store_unavailable", "Pinned config snapshots require a config store.");
    }
    const snapshot = await this.store.readSnapshot(snapshotId);
    if (snapshot === null) {
      // H12: pinned work must not silently drift to a newer generation.
      throw new ConfigError(
        "snapshot_invalid",
        `Pinned config snapshot "${snapshotId}" is missing; its task cannot execute against a different generation.`,
      );
    }
    if (snapshot.namespace !== this.namespace) {
      throw new ConfigError("snapshot_invalid", "Pinned config snapshot belongs to another namespace.");
    }
    const revision = snapshot.databaseRevision === 0 ? null : await this.store.readRevision(this.namespace, snapshot.databaseRevision);
    if (snapshot.databaseRevision !== 0 && revision === null) {
      throw new ConfigError("snapshot_invalid", "Pinned snapshot revision is missing.");
    }
    const expectedId = computeSnapshotId(revision ?? {
      namespace: this.namespace, revision: 0, contentHash: snapshot.contentHash,
      fileDigest: snapshot.fileDigest, formatVersion: 2,
    });
    if (snapshotId !== expectedId) throw new ConfigError("snapshot_invalid", "Pinned snapshot identity mismatch.");
    return this.validateSnapshot(snapshot, expectedId, snapshot.databaseRevision, revision?.fileDigest ?? snapshot.fileDigest);
  }

  /** Stops serving generations; in-flight leases still release cleanly. */
  async drain(): Promise<void> {
    this.stopAdmission();
    await this.refreshQueue;
    await this.heartbeatQueue;
    while (this.status().activeLeases > 0 || this.pendingTasks > 0) await new Promise(resolve => setTimeout(resolve, 25));
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries) {
      entry.retired = true;
      if (entry.refCount === 0) this.disposeEntry(entry);
    }
    if (this.status().activeLeases === 0) this.scope.disable();
  }
}

/** Maps any manager/store failure to a bounded admission-unavailable signal. */
export function admissionUnavailableReason(error: unknown): string {
  if (isConfigError(error)) {
    return `${error.code}: ${scrubText(error.message).text}`;
  }
  return "Configuration store is unavailable.";
}
