/**
 * Config snapshot retention (P2 item 96): reclaims runtime snapshots that no
 * live work references.
 *
 * Write-order contract (recovery): the runtime commits a snapshot row to the
 * ConfigStore BEFORE any receipt/job references it, so a crash can leave an
 * unreferenced snapshot (reclaimed here) but never a dangling reference.
 *
 * Reclaim rule: a snapshot is deletable when the ConfigStore reports it
 * unpinned with refcount zero past the age cutoff AND no reference source
 * (auto-commit receipts/batches, queue jobs, …) lists it as active. Sources
 * are polled at sweep time; a source that fails aborts the sweep — deleting
 * on a stale reference view would break running executions.
 */

import type { ConfigStore } from "./config-store.js";

/** Anything that can hold live references to config snapshots. */
export interface ConfigSnapshotReferenceSource {
  listActiveConfigSnapshotIds(now: number): Promise<readonly string[]>;
}

export interface SweepConfigSnapshotsOptions {
  readonly namespace: string;
  /** Only snapshots created at or before this timestamp are candidates. */
  readonly olderThan: number;
  readonly now: number;
  /** Candidate ceiling per sweep; bounds one run's work (default 100). */
  readonly limit?: number | undefined;
  readonly referencedBy: readonly ConfigSnapshotReferenceSource[];
}

export interface SweepConfigSnapshotsResult {
  /** Snapshots deleted in this sweep. */
  readonly deleted: readonly string[];
  /** Candidates kept because a reference source still lists them. */
  readonly kept: readonly string[];
}

export async function sweepUnreferencedConfigSnapshots(
  store: ConfigStore,
  options: SweepConfigSnapshotsOptions,
): Promise<SweepConfigSnapshotsResult> {
  const candidates = await store.listUnreferencedSnapshots(
    options.namespace,
    options.olderThan,
    options.limit ?? 100,
  );
  if (candidates.length === 0) return { deleted: [], kept: [] };

  const referenced = new Set<string>();
  for (const source of options.referencedBy) {
    for (const id of await source.listActiveConfigSnapshotIds(options.now)) {
      referenced.add(id);
    }
  }

  const deleted: string[] = [];
  const kept: string[] = [];
  for (const candidate of candidates) {
    if (referenced.has(candidate.id)) {
      kept.push(candidate.id);
      continue;
    }
    // Re-check inside the store: deleteSnapshot still refuses pinned or
    // refcounted rows, so a pin racing this sweep is a bounded skip, never
    // a deleted-in-use snapshot.
    try {
      await store.deleteSnapshot(candidate.id);
      deleted.push(candidate.id);
    } catch {
      kept.push(candidate.id);
    }
  }
  return { deleted, kept };
}
