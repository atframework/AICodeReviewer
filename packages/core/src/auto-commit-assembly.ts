import { AUTO_COMMIT_BATCH_LIMITS, type SourceFieldStatus } from "./auto-commit-identity.js";

/**
 * Notification-aware assembly (contract: docs/ai/architecture.md §3.1.1 + docs/ai/decisions.md D35).
 *
 * Notifications are the receive unit, the stream is the scheduling unit, and
 * the sealed batch is the execution unit. Assembly runs on VERIFIED pending
 * members of one stream, ordered by true VCS history (`orderKey`), and cuts
 * maximal runs that may merge into one review batch. Pure: the scheduler
 * supplies candidates and `now`; the store seals the returned cuts.
 */

/** Coalescing bound across notifications; a complete Git push is never sliced. */
export const AUTO_COMMIT_MAX_BATCH_MEMBERS = 50;

export interface AssemblyCandidate {
  readonly memberId: string;
  readonly revision: string;
  /**
   * Verified VCS order key: zero-padded integers assigned during metadata
   * expansion, consecutive for adjacent commits. A numeric gap means an
   * excluded/unavailable/other-run member sits between the two survivors —
   * which is itself a merge boundary (design §5.2).
   */
  readonly orderKey: string;
  readonly parents: readonly string[];
  readonly sourceKey: string;
  readonly sourceStatus: SourceFieldStatus;
  readonly eligibleAt: number;
  /** Earliest covering Git push delivery; members of this unit are indivisible. */
  readonly pushReceiptId?: string;
  /**
   * Receipt id of a force-push/rewrite event. Members of one rewrite event
   * form an isolated batch (endpoint net diff); merging across events or
   * with ordinary members is forbidden (design §5.2).
   */
  readonly rewriteReceiptId?: string;
  /**
   * Execution config snapshot the covering receipt pinned at admission
   * (P4/H09). `null`/undefined marks legacy receipts accepted before
   * snapshot pinning. Members pinned to different snapshots never share a
   * batch: the executed plan must be one generation, so a snapshot change is
   * a batch boundary on both sides.
   */
  readonly configSnapshotId?: string | null;
}

export type AssemblyCutReason = "same_source_run" | "merge_commit" | "rewrite_event" | "config_boundary" | "push_event";

export interface AssemblyCut {
  readonly memberIds: readonly string[];
  readonly revisions: readonly string[];
  readonly reason: AssemblyCutReason;
  /** First/last member revisions — the fixed endpoints of the batch diff. */
  readonly baseRevision: string;
  readonly headRevision: string;
}

export interface AssemblyResult {
  /** Cuts whose members are all eligible at `now`; seal these. */
  readonly ready: readonly AssemblyCut[];
  /**
   * Pending tails whose first member is not yet eligible. Ordinary runs
   * wake when that member becomes eligible; indivisible Git push/rewrite units
   * wait for every member.
   */
  readonly waiting: readonly { readonly memberIds: readonly string[]; readonly eligibleAt: number }[];
  /**
   * Members with unavailable/conflicted evidence or an invalid push unit block
   * merging on both sides and must be handled by the retry/fail path, never
   * silently re-keyed or merged (design §5.1.1).
   */
  readonly blocked: readonly string[];
}

function orderNumber(orderKey: string): number {
  const value = Number(orderKey);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid assembly order key "${orderKey}".`);
  }
  return value;
}

/**
 * Cuts verified pending members into sealable batches. `candidates` MUST be
 * sorted ascending by numeric orderKey (store read order satisfies this).
 */
export function cutAutoCommitBatches(
  candidates: readonly AssemblyCandidate[],
  now: number,
  maxBatchMembers: number = AUTO_COMMIT_MAX_BATCH_MEMBERS,
): AssemblyResult {
  if (!Number.isInteger(maxBatchMembers) || maxBatchMembers < 1) {
    throw new RangeError("maxBatchMembers must be a positive integer.");
  }
  if (candidates.some(member => member.pushReceiptId !== undefined)) {
    return cutPushUnits(candidates, now, maxBatchMembers);
  }

  const ready: AssemblyCut[] = [];
  const waiting: { memberIds: string[]; eligibleAt: number }[] = [];
  const blocked: string[] = [];

  interface Run {
    members: AssemblyCandidate[];
    reason: AssemblyCutReason;
    closed: boolean;
  }

  const finishRun = (run: Run): void => {
    if (run.members.length === 0) {
      return;
    }
    // Overlong runs emit only their continuous prefix; the remainder is
    // never returned and therefore stays pending for the next scheduling
    // pass after the prefix seals (design §6.4).
    let slice = run.members.slice(0, maxBatchMembers);
    if (run.reason === "same_source_run") {
      const firstWaiting = slice.findIndex((member) => member.eligibleAt > now);
      const firstPending = slice[firstWaiting];
      if (firstPending) {
        const tail = slice.slice(firstWaiting);
        waiting.push({
          memberIds: tail.map((member) => member.memberId),
          eligibleAt: firstPending.eligibleAt,
        });
        // A future notification must not turn the first-receive delay into
        // sliding debounce. Seal only the eligible prefix and leave the
        // tail pending, without jumping over its first ineligible member.
        slice = slice.slice(0, firstWaiting);
        if (slice.length === 0) return;
      }
    }
    const eligibleAt = slice.reduce((max, member) => Math.max(max, member.eligibleAt), 0);
    const memberIds = slice.map((member) => member.memberId);
    if (eligibleAt <= now) {
      ready.push({
        memberIds,
        revisions: slice.map((member) => member.revision),
        reason: run.reason,
        baseRevision: slice[0]?.revision ?? "",
        headRevision: slice[slice.length - 1]?.revision ?? "",
      });
    } else {
      waiting.push({ memberIds, eligibleAt });
    }
  };

  let run: Run = { members: [], reason: "same_source_run", closed: false };
  for (const candidate of candidates) {
    // Unavailable/conflicted source evidence is a hard boundary on both sides.
    if (candidate.sourceStatus !== "known") {
      finishRun(run);
      run = { members: [], reason: "same_source_run", closed: false };
      blocked.push(candidate.memberId);
      continue;
    }

    // Merge commit: always its own batch (design §5.2).
    if (candidate.parents.length >= 2 && candidate.rewriteReceiptId === undefined) {
      finishRun(run);
      run = { members: [], reason: "same_source_run", closed: false };
      finishRun({ members: [candidate], reason: "merge_commit", closed: true });
      continue;
    }

    const previous = run.members[run.members.length - 1];
    // Execution snapshot boundary (H09): members accepted under different
    // config snapshots execute on different generations, so they can never
    // merge into one batch. Legacy (null) receipts group with their own kind.
    // Rewrite events keep whole-event identity (one receipt = one snapshot).
    if (
      previous !== undefined &&
      run.reason !== "rewrite_event" &&
      (candidate.configSnapshotId ?? null) !== (previous.configSnapshotId ?? null)
    ) {
      finishRun(run);
      run = { members: [candidate], reason: "config_boundary", closed: false };
      continue;
    }
    const startsNewRun =
      previous === undefined ||
      previous.sourceStatus !== "known" ||
      // Different rewrite event (or rewrite vs ordinary): never merge across.
      candidate.rewriteReceiptId !== previous.rewriteReceiptId ||
      // Excluded/unavailable members leave numeric gaps — hard separators.
      orderNumber(candidate.orderKey) !== orderNumber(previous.orderKey) + 1 ||
      // Git first-parent linkage: a rewritten commit can reuse an absolute
      // position while its parent points elsewhere — that is a history
      // boundary even when order keys happen to be consecutive. Linear
      // p4/svn candidates carry no parents and rely on position alone.
      (candidate.parents.length > 0 && candidate.parents[0] !== previous.revision) ||
      // Ordinary runs additionally require the same source key; rewrite
      // batches cover the whole event regardless of per-commit source.
      (candidate.rewriteReceiptId === undefined && candidate.sourceKey !== previous.sourceKey);
    if (startsNewRun) {
      finishRun(run);
      run = {
        members: [candidate],
        reason: candidate.rewriteReceiptId !== undefined ? "rewrite_event" : "same_source_run",
        closed: false,
      };
    } else {
      run.members.push(candidate);
    }
  }
  finishRun(run);

  return { ready, waiting, blocked };
}

/** Preserve delivery units before applying the older cross-delivery policy. */
function cutPushUnits(candidates: readonly AssemblyCandidate[], now: number, mergeLimit: number): AssemblyResult {
  const units: AssemblyCandidate[][] = [];
  for (const member of candidates) {
    const previous = units[units.length - 1];
    if (member.pushReceiptId !== undefined && previous?.[0]?.pushReceiptId === member.pushReceiptId) {
      previous.push(member);
    } else units.push([member]);
  }
  const occurrences = new Map<string, number>();
  for (const unit of units) {
    const id = unit[0]!.pushReceiptId;
    if (id !== undefined) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
  }
  const ready: AssemblyCut[] = [];
  const waiting: { memberIds: string[]; eligibleAt: number }[] = [];
  const blocked: string[] = [];
  let run: AssemblyCandidate[] = [];
  let mergeable = false;
  const finish = (): void => {
    if (run.length === 0) return;
    ready.push({ memberIds: run.map(m => m.memberId), revisions: run.map(m => m.revision),
      reason: run[0]!.rewriteReceiptId !== undefined ? "rewrite_event" : "push_event",
      baseRevision: run[0]!.revision, headRevision: run[run.length - 1]!.revision });
    run = [];
    mergeable = false;
  };
  for (const unit of units) {
    const first = unit[0]!;
    const rewrite = first.rewriteReceiptId !== undefined;
    const contiguous = unit.every((member, index) => index === 0 ||
      orderNumber(member.orderKey) === orderNumber(unit[index - 1]!.orderKey) + 1 &&
      (member.parents.length === 0 || member.parents[0] === unit[index - 1]!.revision));
    if (unit.length > AUTO_COMMIT_BATCH_LIMITS.maxMembersPerBatch ||
      first.pushReceiptId !== undefined && occurrences.get(first.pushReceiptId) !== 1 ||
      unit.some(m => m.sourceStatus !== "known" || (m.configSnapshotId ?? null) !== (first.configSnapshotId ?? null)) ||
      !rewrite && !contiguous) {
      finish();
      blocked.push(...unit.map(m => m.memberId));
      continue;
    }
    const eligibleAt = Math.max(...unit.map(m => m.eligibleAt));
    if (eligibleAt > now) {
      finish();
      waiting.push({ memberIds: unit.map(m => m.memberId), eligibleAt });
      continue;
    }
    // Mixed-author pushes and pushes containing a merge/rewrite are whole,
    // isolated units. Only uniform, continuous pushes coalesce across deliveries.
    const uniform = !rewrite && unit.every(m => m.sourceKey === first.sourceKey && m.parents.length < 2);
    const previous = run[run.length - 1];
    if (previous && (!mergeable || !uniform || run.length + unit.length > mergeLimit ||
      first.sourceKey !== previous.sourceKey || (first.configSnapshotId ?? null) !== (previous.configSnapshotId ?? null) ||
      orderNumber(first.orderKey) !== orderNumber(previous.orderKey) + 1 ||
      first.parents.length > 0 && first.parents[0] !== previous.revision)) finish();
    run.push(...unit);
    mergeable = uniform;
    if (!uniform || run.length >= mergeLimit) finish();
  }
  finish();
  return { ready, waiting, blocked };
}
