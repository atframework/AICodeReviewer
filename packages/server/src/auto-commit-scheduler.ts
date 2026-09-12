import {
  computeMemberId,
  cutAutoCommitBatches,
  decideExclusion,
  deriveSourceKey,
  exclusionInputFromSnapshotFields,
  isAllowedInstant,
  nextAllowedInstant,
  type AssemblyCandidate,
  type AutoCommitReceipt,
  type AutoCommitStore,
  type StreamKeyInput,
  type CommitBatchRecord,
  type CommitMemberRecord,
  type MemberExclusionState,
  type ResolvedAutoCommitPolicy,
  type SealBatchResult,
  type SourceSnapshot,
  type SourceSnapshotFields,
  type StreamHead,
} from "@aicr/core";
import type { CommitMetadataRecord, VcsAdapter } from "@aicr/vcs";

/**
 * Auto-commit scheduling loop (design §7, test matrix P/S/Q/E rows).
 *
 * One scheduler owns one debounced timer — never one timer per commit
 * (F06). `kick()` re-arms after webhook acceptance; the timer fires at the
 * store's earliest scheduling signal (`readNextWake`). Each tick:
 *
 * 1. EXPAND runnable streams: page bounded VCS metadata, snapshot raw source
 *    fields, apply exclusion verdicts, advance the coverage cursor.
 * 2. ASSEMBLE: cut verified pending members (assembly module) and seal
 *    ready cuts under a stream reservation.
 * 3. DISPATCH: claim due outbox entries, lease the batch inside the
 *    execution window, run the injected executor, complete/fail with
 *    window-gated retry.
 *
 * Crash recovery: unconfirmed outbox claims expire and become claimable
 * again; expired batch leases return to retry/dead per attempts; receipts,
 * members, and cursors are persistent, so a restart resumes without member
 * loss or duplicate analysis (sealed batches never re-group).
 */

export interface BatchExecutionContext {
  readonly batch: CommitBatchRecord;
  readonly members: readonly CommitMemberRecord[];
  /** Earliest covering receipt of the batch's first member (routing data). */
  readonly receipt: AutoCommitReceipt;
  readonly leaseToken: string;
  readonly signal?: AbortSignal;
}

type MetadataAdapter = VcsAdapter & {
  listCommitMetadataPage: NonNullable<VcsAdapter["listCommitMetadataPage"]>;
};

export interface AutoCommitSchedulerOptions {
  readonly store: AutoCommitStore;
  readonly getPolicy: (workspaceId: string) => ResolvedAutoCommitPolicy;
  /** Adapter per stream; must implement listCommitMetadataPage to expand. */
  readonly getAdapter: (stream: StreamKeyInput) => MetadataAdapter | undefined;
  readonly executeBatch: (context: BatchExecutionContext) => Promise<void>;
  readonly now?: () => number;
  /** Consumer identity for reservations, claims, and leases. */
  readonly consumerId?: string;
  readonly metadataPageSize?: number;
  readonly maxMetadataPagesPerReceipt?: number;
  /** Receipts expanded per stream tick; a read bound, never a batch boundary. */
  readonly receiptPageSize?: number;
  readonly maxExpansionAttempts?: number;
  readonly batchMaxAttempts?: number;
  readonly leaseMs?: number;
  readonly leaseRenewMs?: number;
  readonly dispatchRetryBaseMs?: number;
  /** Workspace/stream heads scanned per tick (bounded, never full scans). */
  readonly streamScanLimit?: number;
  /**
   * Routing-stage resolver (spec §5.2 stage C): converts pending p4/svn
   * routing receipts into formal receipts before expansion runs. Returns
   * the earliest pending retryAt for precise re-arming.
   */
  readonly routingResolver?: { resolveDue(now: number): Promise<number | undefined> };
  /** Idle safety poll when no wake signal exists (not per-item polling). */
  readonly idlePollMs?: number;
  readonly globalConcurrency?: number;
  readonly perWorkspaceConcurrency?: number;
}

interface SchedulerTuning {
  readonly consumerId: string;
  readonly metadataPageSize: number;
  readonly maxMetadataPagesPerReceipt: number;
  readonly receiptPageSize: number;
  readonly maxExpansionAttempts: number;
  readonly batchMaxAttempts: number;
  readonly leaseMs: number;
  readonly leaseRenewMs: number;
  readonly dispatchRetryBaseMs: number;
  readonly streamScanLimit: number;
  readonly idlePollMs: number;
  readonly reservationTtlMs: number;
  readonly dispatchClaimLimit: number;
  readonly globalConcurrency: number;
  readonly perWorkspaceConcurrency: number;
}

const DEFAULTS: SchedulerTuning = {
  consumerId: "auto-commit-scheduler",
  metadataPageSize: 256,
  maxMetadataPagesPerReceipt: 8,
  receiptPageSize: 16,
  maxExpansionAttempts: 5,
  batchMaxAttempts: 3,
  leaseMs: 120_000,
  leaseRenewMs: 40_000,
  dispatchRetryBaseMs: 30_000,
  streamScanLimit: 32,
  idlePollMs: 30_000,
  reservationTtlMs: 30_000,
  dispatchClaimLimit: 8,
  globalConcurrency: 1,
  perWorkspaceConcurrency: 1,
};

export class AutoCommitScheduler {
  private readonly store: AutoCommitStore;
  private readonly getPolicy: AutoCommitSchedulerOptions["getPolicy"];
  private readonly getAdapter: AutoCommitSchedulerOptions["getAdapter"];
  private readonly routingResolver: AutoCommitSchedulerOptions["routingResolver"];
  private readonly executeBatch: AutoCommitSchedulerOptions["executeBatch"];
  private readonly now: () => number;
  private readonly options: SchedulerTuning;
  private timer: NodeJS.Timeout | null = null;
  private routingWake: number | undefined = undefined;
  private running = false;
  private ticking = false;
  private pendingKick = false;
  private stopping = false;
  private tickCompletion: Promise<void> | null = null;

  constructor(options: AutoCommitSchedulerOptions) {
    this.store = options.store;
    this.getPolicy = options.getPolicy;
    this.getAdapter = options.getAdapter;
    this.routingResolver = options.routingResolver;
    this.executeBatch = options.executeBatch;
    this.now = options.now ?? Date.now;
    this.options = {
      consumerId: options.consumerId ?? DEFAULTS.consumerId,
      metadataPageSize: options.metadataPageSize ?? DEFAULTS.metadataPageSize,
      maxMetadataPagesPerReceipt:
        options.maxMetadataPagesPerReceipt ??
        DEFAULTS.maxMetadataPagesPerReceipt,
      receiptPageSize: options.receiptPageSize ?? DEFAULTS.receiptPageSize,
      maxExpansionAttempts:
        options.maxExpansionAttempts ?? DEFAULTS.maxExpansionAttempts,
      batchMaxAttempts: options.batchMaxAttempts ?? DEFAULTS.batchMaxAttempts,
      leaseMs: options.leaseMs ?? DEFAULTS.leaseMs,
      leaseRenewMs: options.leaseRenewMs ?? DEFAULTS.leaseRenewMs,
      dispatchRetryBaseMs:
        options.dispatchRetryBaseMs ?? DEFAULTS.dispatchRetryBaseMs,
      streamScanLimit: options.streamScanLimit ?? DEFAULTS.streamScanLimit,
      idlePollMs: options.idlePollMs ?? DEFAULTS.idlePollMs,
      reservationTtlMs: DEFAULTS.reservationTtlMs,
      dispatchClaimLimit: DEFAULTS.dispatchClaimLimit,
      globalConcurrency:
        options.globalConcurrency ?? DEFAULTS.globalConcurrency,
      perWorkspaceConcurrency:
        options.perWorkspaceConcurrency ?? DEFAULTS.perWorkspaceConcurrency,
    };
  }

  /** Arm the loop. Crash leftovers are reclaimed by normal claim/lease expiry. */
  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = true;
    this.arm(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async stopAndDrain(): Promise<void> {
    this.stopping = true;
    this.stop();
    await this.tickCompletion;
  }

  /** Called after webhook acceptance; debounced into the single timer. */
  kick(): void {
    if (!this.running) return;
    if (this.ticking) {
      this.pendingKick = true;
      return;
    }
    this.arm(0);
  }

  private arm(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.tick().catch(() => {
          // A failed tick must never kill the loop (F10); the safety poll
          // re-arms and the next wake signal re-schedules work.
          if (this.running) this.arm(this.options.idlePollMs);
        });
      },
      Math.max(0, Math.min(delayMs, this.options.idlePollMs, 2_147_483_647)),
    );
    this.timer.unref?.();
  }

  /** One full expand → assemble → dispatch pass. Public for tests. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.ticking) {
      this.pendingKick = true;
      return;
    }
    this.ticking = true;
    let finishTick = (): void => {};
    this.tickCompletion = new Promise<void>((resolve) => {
      finishTick = resolve;
    });
    try {
      const now = this.now();
      // Stage C first: routing receipts become formal receipts the same
      // tick, so p4/svn admissions reach expansion without extra latency.
      // A routing failure must never kill the tick loop (F10); per-record
      // retries are already persisted by the resolver.
      this.routingWake = await this.routingResolver?.resolveDue(now).catch(() => undefined);
      await this.store.reclaimExpiredBatchLeases(
        now,
        this.options.streamScanLimit,
      );
      await this.expandAndAssemble(now);
      await this.dispatchDue(this.now());
    } finally {
      try {
        if (this.pendingKick) {
          this.pendingKick = false;
          this.arm(0);
        } else {
          const wake = await this.store.readNextWake().catch(() => undefined);
          const storeWake = wake ? wake.at - this.now() : undefined;
          const routingWake = this.routingWake !== undefined ? this.routingWake - this.now() : undefined;
          const delay =
            storeWake === undefined ? routingWake
            : routingWake === undefined ? storeWake
            : Math.min(storeWake, routingWake);
          this.arm(
            delay !== undefined ? Math.max(0, delay) : this.options.idlePollMs,
          );
        }
      } finally {
        this.ticking = false;
        this.tickCompletion = null;
        finishTick();
      }
    }
  }

  // ------------------------------------------------------------------
  // Expansion + assembly
  // ------------------------------------------------------------------

  private async expandAndAssemble(now: number): Promise<void> {
    const heads = await this.store.readRunnableWorkspaceHeads(
      now,
      this.options.streamScanLimit,
    );
    for (const head of heads) {
      const streams = await this.store.readStreamHeads(
        head.workspaceId,
        this.options.streamScanLimit,
      );
      for (const stream of streams) {
        if (this.stopping) return;
        if (stream.notBefore !== null && stream.notBefore > now) continue;
        await this.processStream(stream, now);
      }
      await this.store.rotateWorkspaceFairness(head.workspaceId, now);
    }
  }

  private async processStream(stream: StreamHead, now: number): Promise<void> {
    if (stream.activeBatchId) return;
    const policy = this.getPolicySafe(stream.workspaceId);
    if (!policy || !isAllowedInstant(policy.schedule, this.now())) {
      const head = await this.store.readStreamHead(stream.streamId);
      if (head)
        await this.store.updateStreamHead(
          stream.streamId,
          head.version,
          {
            resumeNotBefore: policy
              ? nextAllowedInstant(policy.schedule, this.now())
              : now + this.options.idlePollMs,
          },
          this.now(),
        );
      return;
    }

    const streamRef: StreamKeyInput = {
      workspaceId: stream.workspaceId,
      triggerName: stream.triggerName,
      vcs: stream.vcs,
      sourceNamespace: stream.sourceNamespace,
      scopeRef: stream.scopeRef,
      historyGeneration: stream.historyGeneration,
    };

    const reservation = await this.store.acquireStreamReservation(
      stream.streamId,
      this.options.consumerId,
      this.options.reservationTtlMs,
      this.now(),
    );
    if (!reservation) return;
    let leaseLost = false;
    const renew = setInterval(
      () => {
        void this.store
          .renewStreamReservation(
            stream.streamId,
            reservation.token,
            this.options.reservationTtlMs,
            this.now(),
          )
          .then(
            (ok) => {
              if (!ok) leaseLost = true;
            },
            () => {
              leaseLost = true;
            },
          );
      },
      Math.max(1, Math.floor(this.options.reservationTtlMs / 3)),
    );
    renew.unref?.();
    try {
      let head = await this.store.readStreamHead(stream.streamId);
      if (!head || head.activeBatchId) return;
      if (head.assemblyCutSeq === null) {
        if (
          !(await this.store.updateStreamHead(
            stream.streamId,
            head.version,
            {
              assemblyCutSeq: head.latestReceiptSeq,
              assemblyAt: now,
              resumeNotBefore: null,
            },
            this.now(),
          ))
        )
          return;
        head = await this.store.readStreamHead(stream.streamId);
        if (!head) return;
      }
      // Persist a fixed receive frontier. New notifications belong to the
      // next assembly, so continuous ingress cannot move this finish line.
      const caughtUp = await this.expandStream(head, streamRef, policy, now);
      if (caughtUp && !leaseLost && !this.stopping) {
        await this.assembleStream(
          head,
          streamRef,
          policy,
          head.assemblyAt ?? now,
          reservation.token,
        );
        const current = await this.store.readStreamHead(stream.streamId);
        if (
          current &&
          (current.reservationToken === reservation.token ||
            current.activeBatchId !== null)
        ) {
          await this.store.updateStreamHead(
            stream.streamId,
            current.version,
            {
              assemblyCutSeq: null,
              assemblyAt: null,
            },
            this.now(),
          );
        }
      }
    } finally {
      clearInterval(renew);
      await this.store.releaseStreamReservation(
        stream.streamId,
        reservation.token,
        this.now(),
      );
    }
  }

  private getPolicySafe(
    workspaceId: string,
  ): ResolvedAutoCommitPolicy | undefined {
    try {
      return this.getPolicy(workspaceId);
    } catch {
      return undefined;
    }
  }

  /**
   * Expand un-expanded receipts in persistent seq order: bounded metadata
   * pages, raw source snapshots, exclusion verdicts, cursor advance.
   * `receiptPageSize` is a per-tick read bound, never a batch boundary:
   * its upper bound is the persisted assembly cut, using global receipt
   * sequence numbers without assuming dense per-stream numbering. Assembly
   * waits until this cut is fully expanded.
   */
  private async expandStream(
    stream: StreamHead,
    streamRef: StreamKeyInput,
    policy: ResolvedAutoCommitPolicy,
    now: number,
  ): Promise<boolean> {
    // One extra receipt probes whether the page reached the log end.
    const receipts = await this.store.readStreamReceipts(
      stream.streamId,
      stream.coverageCursor,
      stream.assemblyCutSeq ?? stream.latestReceiptSeq,
      this.options.receiptPageSize + 1,
    );
    if (receipts.length === 0) return true;

    const adapter = this.getAdapter(streamRef);
    for (const receipt of receipts.slice(0, this.options.receiptPageSize)) {
      if (this.stopping || !isAllowedInstant(policy.schedule, this.now()))
        return false;
      if (
        receipt.metadataNextAttemptAt !== null &&
        receipt.metadataNextAttemptAt > this.now()
      )
        return false;
      const result = await this.expandReceipt(
        stream,
        streamRef,
        receipt,
        adapter,
        policy,
        now,
      );
      if (result !== "expanded") {
        // Retry gate engaged or the metadata page budget ran out mid-range;
        // the receipt's un-advanced cursor re-wakes the stream on schedule.
        return false;
      }
      const head = await this.store.readStreamHead(stream.streamId);
      if (!head) return false;
      await this.store.updateStreamHead(
        stream.streamId,
        head.version,
        {
          coverageCursor: receipt.receiptSeq,
        },
        now,
      );
    }
    return receipts.length <= this.options.receiptPageSize;
  }

  /**
   * Expand one receipt's coverage range, applying each metadata page as it
   * arrives and persisting the resume cursor after it (members first, cursor
   * second — a crash between the two re-reads an idempotent page instead of
   * skipping it). Returns:
   * - `expanded`: the range is fully verified (or its members terminally
   *   failed); the receipt seq may be crossed.
   * - `retry`: transient metadata failure; the backoff gate owns the re-wake.
   * - `incomplete`: the per-tick page budget ran out mid-range; the
   *   persisted cursor resumes next tick. Never loses the tail (N05/N08).
   */
  private async expandReceipt(
    stream: StreamHead,
    streamRef: StreamKeyInput,
    receipt: AutoCommitReceipt,
    adapter: MetadataAdapter | undefined,
    policy: ResolvedAutoCommitPolicy,
    now: number,
  ): Promise<"expanded" | "retry" | "incomplete"> {
    const coverage = receipt.coverage;
    const headRevision =
      coverage.kind === "range" ? coverage.head : coverage.revision;
    const baseRevision =
      coverage.kind === "range"
        ? coverage.base
        : stream.vcs !== "git" &&
            /^\d+$/u.test(coverage.revision) &&
            BigInt(coverage.revision) > 0n
          ? String(BigInt(coverage.revision) - 1n)
          : undefined;
    if (receipt.metadataTerminalError !== null) {
      await this.failReceiptMembers(
        stream,
        receipt,
        now,
        receipt.metadataTerminalError,
      );
      return "expanded";
    }
    if (!adapter?.listCommitMetadataPage) {
      return (await this.noteExpansionFailure(
        stream,
        receipt,
        now,
        "metadata_adapter_unavailable",
      ))
        ? "expanded"
        : "retry";
    }
    let pageCursor: string | undefined = receipt.metadataCursor ?? undefined;

    for (
      let page = 0;
      page < this.options.maxMetadataPagesPerReceipt;
      page += 1
    ) {
      if (this.stopping || !isAllowedInstant(policy.schedule, this.now()))
        return "incomplete";
      let result;
      try {
        result = await adapter.listCommitMetadataPage({
          scopeRef: stream.scopeRef,
          ...(baseRevision ? { baseRevision } : {}),
          headRevision,
          ...(pageCursor ? { cursor: pageCursor } : {}),
          maxRecords: this.options.metadataPageSize,
          maxBytes: 1_048_576,
        });
      } catch (error) {
        return (await this.noteExpansionFailure(
          stream,
          receipt,
          this.now(),
          error instanceof Error ? error.message : "metadata_read_failed",
        ))
          ? "expanded"
          : "retry";
      }
      if (result.status === "unavailable") {
        return (await this.noteExpansionFailure(
          stream,
          receipt,
          now,
          result.unavailableReason ?? "metadata_unavailable",
        ))
          ? "expanded"
          : "retry";
      }
      const nextCursor = result.nextCursor ?? null;
      if (
        result.status === "partial" &&
        (!nextCursor || nextCursor === pageCursor)
      ) {
        // A partial page without a resume cursor cannot prove the tail; fail
        // loudly instead of silently treating the range as complete.
        return (await this.noteExpansionFailure(
          stream,
          receipt,
          now,
          "metadata_page_missing_cursor",
        ))
          ? "expanded"
          : "retry";
      }
      // Members are created from the VCS-verified history of the coverage
      // range — never from the webhook payload's commit array, which providers
      // truncate (GitHub 2048, GitLab 20). The page records ARE ground truth;
      // a payload-asserted revision that history denies simply never becomes
      // a member, and an unreadable range fails the whole read (G08).
      if (
        !(await this.applyMetadataRecords(
          stream,
          streamRef,
          receipt,
          result.records,
          policy,
          now,
        ))
      ) {
        return (await this.noteExpansionFailure(
          stream,
          receipt,
          this.now(),
          "source_or_exclusion_unavailable",
        ))
          ? "expanded"
          : "retry";
      }
      if (result.status === "complete") {
        await this.store.setReceiptMetadataCursor(receipt.receiptId, null, now);
        return "expanded";
      }
      await this.store.setReceiptMetadataCursor(
        receipt.receiptId,
        nextCursor,
        now,
      );
      pageCursor = nextCursor ?? undefined;
    }
    return "incomplete";
  }

  /** Upsert one verified page and record its exclusion verdicts (§5.3). */
  private async applyMetadataRecords(
    stream: StreamHead,
    streamRef: StreamKeyInput,
    receipt: AutoCommitReceipt,
    records: readonly CommitMetadataRecord[],
    policy: ResolvedAutoCommitPolicy,
    now: number,
  ): Promise<boolean> {
    if (records.length === 0) return true;
    const upserts: {
      revision: string;
      orderKey: string;
      parents: readonly string[];
      sourceSnapshot: SourceSnapshot;
    }[] = [];
    for (const record of records) {
      const snapshot: SourceSnapshot = {
        ...snapshotFromRecord(streamRef, record, policy.policyVersion, now),
        ...(receipt.coverage.kind === "range"
          ? { historyBaseRevision: receipt.coverage.base }
          : {}),
      };
      upserts.push({
        revision: record.revision,
        orderKey: record.orderKey,
        parents: record.parents,
        sourceSnapshot: snapshot,
      });
    }
    await this.store.applyMetadataPage({
      streamId: stream.streamId,
      receiptId: receipt.receiptId,
      members: upserts,
      now,
    });
    const persisted = await this.store.readMembers(
      records.map((record) =>
        computeMemberId(stream.streamId, record.revision),
      ),
    );
    return this.decideMembers(stream, persisted, policy, now);
  }

  private async decideMembers(
    stream: StreamHead,
    members: readonly CommitMemberRecord[],
    policy: ResolvedAutoCommitPolicy,
    now: number,
  ): Promise<boolean> {
    const verdicts: {
      memberId: string;
      state: MemberExclusionState;
      ruleId?: string;
      policyVersion: string;
    }[] = [];
    let known = true;
    for (const member of members) {
      if (member.status !== "pending" || member.batchId !== null) continue;
      const snapshot = member.sourceSnapshot;
      const decision = decideExclusion(
        policy.exclusions,
        stream.vcs,
        exclusionInputFromSnapshotFields(snapshot?.fields ?? {}),
      );
      const memberId = member.memberId;
      if (decision.kind === "excluded") {
        verdicts.push({
          memberId,
          state: "excluded",
          ruleId: decision.ruleId,
          policyVersion: policy.policyVersion,
        });
      } else if (decision.kind === "unknown" || snapshot?.status !== "known") {
        known = false;
        verdicts.push({
          memberId,
          state: "undecided",
          policyVersion: policy.policyVersion,
        });
      } else {
        verdicts.push({
          memberId,
          state: "allowed",
          policyVersion: policy.policyVersion,
        });
      }
    }

    await this.store.applyExclusionVerdicts({
      streamId: stream.streamId,
      verdicts,
      now,
    });
    return known;
  }

  /** Bounded metadata retry; exhaustion fails the receipt's members explicitly. */
  private async noteExpansionFailure(
    stream: StreamHead,
    receipt: AutoCommitReceipt,
    now: number,
    reason: string,
  ): Promise<boolean> {
    const current = await this.store.getReceipt(receipt.receiptId);
    const attempts =
      (current?.receipt.metadataAttempts ?? receipt.metadataAttempts) + 1;
    if (attempts >= this.options.maxExpansionAttempts) {
      await this.store.recordReceiptMetadataFailure(
        receipt.receiptId,
        reason.slice(0, 200),
        null,
        now,
      );
      await this.failReceiptMembers(stream, receipt, now, reason);
      return true;
    }
    const nextAt =
      now + this.options.dispatchRetryBaseMs * 2 ** Math.min(20, attempts - 1);
    await this.store.recordReceiptMetadataFailure(
      receipt.receiptId,
      reason.slice(0, 200),
      nextAt,
      now,
    );
    const head = await this.store.readStreamHead(stream.streamId);
    if (head)
      await this.store.updateStreamHead(
        stream.streamId,
        head.version,
        { resumeNotBefore: nextAt },
        now,
      );
    return false;
  }

  private async failReceiptMembers(
    stream: StreamHead,
    receipt: AutoCommitReceipt,
    now: number,
    reason: string,
  ): Promise<void> {
    let cursor: string | null = null;
    do {
      const membersPage = await this.store.readReceiptMembers(
        receipt.receiptId,
        cursor,
        512,
      );
      await this.store.applyExclusionVerdicts({
        streamId: stream.streamId,
        verdicts: membersPage.items.map((member) => ({
          memberId: member.memberId,
          state: "unavailable" as const,
          ruleId: reason.slice(0, 200),
          policyVersion: receipt.policyVersion,
        })),
        now,
      });
      cursor = membersPage.nextCursor;
    } while (cursor !== null);
  }

  /**
   * Cut verified pending members and seal ready batches under the stream
   * reservation. Seal is atomic with outbox append (store contract).
   */
  private async assembleStream(
    stream: StreamHead,
    streamRef: StreamKeyInput,
    policy: ResolvedAutoCommitPolicy,
    now: number,
    reservationToken: string,
  ): Promise<void> {
    if (!isAllowedInstant(policy.schedule, this.now())) {
      const head = await this.store.readStreamHead(stream.streamId);
      if (head) {
        // Persist the calendar bound as the resume floor, not a notBefore
        // override: head recomputation re-derives notBefore from components
        // and applies resumeNotBefore as a floor, so the gate survives every
        // later receipt/member/batch-driven recompute.
        await this.store.updateStreamHead(
          stream.streamId,
          head.version,
          {
            resumeNotBefore: nextAllowedInstant(policy.schedule, this.now()),
          },
          this.now(),
        );
      }
      return;
    }

    let pending = await this.store.readPendingMembers(
      stream.streamId,
      null,
      512,
    );
    const stale = pending.items.filter(
      (member) => member.exclusion.policyVersion !== policy.policyVersion,
    );
    if (stale.length > 0) {
      await this.decideMembers(stream, stale, policy, this.now());
      pending = await this.store.readPendingMembers(stream.streamId, null, 512);
    }
    // A new exclusion policy can require evidence absent from an already
    // expanded receipt. Re-read its bounded metadata pages through the same
    // durable retry budget; an undecided member must not cause a hot loop.
    const unresolved = pending.items.find(
      (member) => member.exclusion.state === "undecided",
    );
    if (unresolved) {
      const view = await this.store.getReceipt(unresolved.coverReceiptId);
      if (!view) return;
      if (
        view.receipt.metadataNextAttemptAt !== null &&
        view.receipt.metadataNextAttemptAt > this.now()
      ) {
        const head = await this.store.readStreamHead(stream.streamId);
        if (head)
          await this.store.updateStreamHead(
            stream.streamId,
            head.version,
            { resumeNotBefore: view.receipt.metadataNextAttemptAt },
            this.now(),
          );
        return;
      }
      if (
        (await this.expandReceipt(
          stream,
          streamRef,
          view.receipt,
          this.getAdapter(streamRef),
          policy,
          this.now(),
        )) !== "expanded"
      )
        return;
      pending = await this.store.readPendingMembers(stream.streamId, null, 512);
    }
    const verified = pending.items.filter(
      (member) =>
        member.orderKey !== null &&
        member.status === "pending" &&
        member.exclusion.state === "allowed",
    );
    if (verified.length === 0) return;

    // Range shape must come from VCS verification. A consumed/excluded
    // prefix does not turn the remaining ordinary commits into a rewrite.
    const rewriteReceiptIds = new Set(
      verified
        .filter((member) => member.sourceSnapshot?.historyRewrite === true)
        .map((member) => member.coverReceiptId),
    );
    for (const receiptId of rewriteReceiptIds) {
      const view = await this.store.getReceipt(receiptId);
      if (
        !view ||
        view.memberCounts.skipped > 0 ||
        view.memberCounts.failed > 0 ||
        view.memberCounts.completed > 0 ||
        view.memberCounts.pending > 50
      ) {
        if (view)
          await this.failReceiptMembers(
            stream,
            view.receipt,
            this.now(),
            "exclusion_scope_conflict",
          );
        return;
      }
    }

    const candidates: AssemblyCandidate[] = verified.map((member) => ({
      memberId: member.memberId,
      revision: member.revision,
      orderKey: member.orderKey ?? "0",
      parents: member.parents,
      sourceKey: member.sourceSnapshot?.sourceKey ?? "",
      sourceStatus: member.sourceSnapshot?.status ?? "unavailable",
      eligibleAt: member.eligibleAt,
      ...(rewriteReceiptIds.has(member.coverReceiptId)
        ? { rewriteReceiptId: member.coverReceiptId }
        : {}),
    }));

    const assembly = cutAutoCommitBatches(candidates, now);
    for (const cut of assembly.ready) {
      const sealed = await this.sealCut(
        stream,
        policy,
        cut.memberIds,
        verified,
        this.now(),
        reservationToken,
      );
      if (!sealed) return; // reservation lost or version conflict; retry next tick
      return; // A stream owns one active batch; later cuts remain pending.
    }
  }

  private async sealCut(
    stream: StreamHead,
    policy: ResolvedAutoCommitPolicy,
    memberIds: readonly string[],
    verified: readonly CommitMemberRecord[],
    now: number,
    reservationToken: string,
  ): Promise<boolean> {
    const byId = new Map(verified.map((member) => [member.memberId, member]));
    const members = memberIds.map((memberId) => {
      const record = byId.get(memberId);
      if (!record) throw new Error(`assembly member ${memberId} missing`);
      return {
        memberId,
        revision: record.revision,
        sourceKey: record.sourceSnapshot?.sourceKey ?? "",
      };
    });
    const first = members[0];
    const last = members[members.length - 1];
    if (!first || !last) return false;
    const head = await this.store.readStreamHead(stream.streamId);
    if (!head) return false;
    const result: SealBatchResult = await this.store.sealBatch({
      streamId: stream.streamId,
      reservationToken,
      expectedStreamVersion: head.version,
      batchId: computeMemberId(
        stream.streamId,
        `batch:${first.revision}:${members.length}:${now}`,
      ),
      runId: computeMemberId(stream.streamId, `run:${first.revision}:${now}`),
      members,
      base:
        (byId.get(first.memberId)?.sourceSnapshot?.historyRewrite === true
          ? byId.get(first.memberId)?.sourceSnapshot?.historyBaseRevision
          : undefined) ??
        byId.get(first.memberId)?.parents[0] ??
        (stream.vcs !== "git" &&
        /^\d+$/u.test(first.revision) &&
        BigInt(first.revision) > 0n
          ? String(BigInt(first.revision) - 1n)
          : first.revision),
      head: last.revision,
      sourceKey: first.sourceKey,
      exclusionPolicyVersion: policy.exclusions.canonical,
      configPolicyVersion: policy.policyVersion,
      maxAttempts: this.options.batchMaxAttempts,
      now,
    });
    return result.kind === "sealed";
  }

  // ------------------------------------------------------------------
  // Dispatch
  // ------------------------------------------------------------------

  private async dispatchDue(_now: number): Promise<void> {
    for (
      let i = 0;
      i < this.options.dispatchClaimLimit && !this.stopping;
      i += 1
    ) {
      const claimed = await this.store.claimDispatch(
        this.now(),
        this.options.consumerId,
        1,
      );
      const entry = claimed[0];
      if (!entry) return;
      await this.dispatchOne(entry.batch, entry.claimToken, this.now());
    }
  }

  private async dispatchOne(
    batch: CommitBatchRecord,
    claimToken: string,
    now: number,
  ): Promise<void> {
    const policy = this.getPolicySafe(batch.workspaceId);
    if (!policy) {
      await this.store.abortDispatch(
        batch.batchId,
        claimToken,
        now + this.options.idlePollMs,
        now,
      );
      return;
    }
    // New attempts start only inside the execution window (design §2):
    // defer the outbox entry to the next allowed instant.
    if (!isAllowedInstant(policy.schedule, now)) {
      await this.store.abortDispatch(
        batch.batchId,
        claimToken,
        nextAllowedInstant(policy.schedule, now),
        now,
      );
      return;
    }

    // Confirm first: the outbox claim transitions the batch dispatch_pending
    // → queued, and startBatchExecution leases only queued batches (store
    // contract; conformance Q14 pins this order).
    await this.store.confirmDispatch(batch.batchId, claimToken, now);
    const leaseToken = await this.store.startBatchExecution(
      batch.batchId,
      this.options.consumerId,
      this.options.leaseMs,
      now,
      {
        global: this.options.globalConcurrency,
        workspace: this.options.perWorkspaceConcurrency,
      },
    );
    if (!leaseToken) {
      await this.store.deferBatchExecution(
        batch.batchId,
        this.now() + this.options.idlePollMs,
        this.now(),
      );
      return;
    }
    const active = await this.store.readBatch(batch.batchId);
    if (!active || active.leaseToken !== leaseToken) return;
    batch = active;
    const members = await this.store.readMembers(
      batch.members.map((entry) => entry.memberId),
    );
    const firstReceiptId = members[0]?.coverReceiptId;
    const receipt = firstReceiptId
      ? await this.store.getReceipt(firstReceiptId)
      : undefined;
    if (!receipt || members.length !== batch.members.length) {
      await this.store.failBatch(
        batch.batchId,
        leaseToken,
        "routing receipt missing",
        null,
        true,
        now,
      );
      return;
    }

    const abort = new AbortController();
    const renew = setInterval(() => {
      void this.store
        .renewBatchLease(
          batch.batchId,
          leaseToken,
          this.options.leaseMs,
          this.now(),
        )
        .then(
          (ok) => {
            if (!ok) abort.abort();
          },
          () => abort.abort(),
        );
    }, this.options.leaseRenewMs);
    renew.unref?.();
    try {
      await this.executeBatch({
        batch,
        members,
        receipt: receipt.receipt,
        leaseToken,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      await this.store.completeBatch(
        batch.batchId,
        leaseToken,
        { outcome: "completed" },
        this.now(),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "execution failed";
      const retryAt = nextAllowedInstant(
        policy.schedule,
        this.now() +
          this.options.dispatchRetryBaseMs *
            2 ** Math.max(0, batch.attempt - 1),
      );
      const permanent =
        typeof error === "object" &&
        error !== null &&
        "retryable" in error &&
        error.retryable === false;
      const dead = permanent || batch.attempt >= batch.maxAttempts;
      await this.store.failBatch(
        batch.batchId,
        leaseToken,
        message,
        dead ? null : retryAt,
        dead,
        this.now(),
      );
    } finally {
      clearInterval(renew);
    }
  }
}

/** Raw VCS record → persisted source snapshot (design §5.1.1). */
export function snapshotFromRecord(
  stream: StreamKeyInput,
  record: CommitMetadataRecord,
  rulesVersion: string,
  observedAt: number,
): SourceSnapshot {
  const evidence = (
    value: string | undefined,
  ): { status: "known" | "unavailable"; value?: string } =>
    value !== undefined && value.length > 0
      ? { status: "known", value }
      : { status: "unavailable" };
  const fields: SourceSnapshotFields = (() => {
    switch (stream.vcs) {
      case "git":
        return {
          authorName: evidence(record.authorName),
          authorEmail: evidence(record.authorEmail),
          committerName: evidence(record.committerName),
          committerEmail: evidence(record.committerEmail),
        };
      case "p4":
        return {
          user: evidence(record.p4User),
          client: evidence(record.p4Client),
        };
      case "svn":
        return { svnAuthor: evidence(record.svnAuthor) };
    }
  })();
  const sourceKey = deriveSourceKey(stream.vcs, stream.sourceNamespace, fields);
  return {
    ...(record.historyRewrite !== undefined
      ? { historyRewrite: record.historyRewrite }
      : {}),
    v: 1,
    vcs: stream.vcs,
    sourceNamespace: stream.sourceNamespace,
    revision: record.revision,
    fields,
    command: `${stream.vcs} listCommitMetadataPage`,
    observedAt,
    rulesVersion,
    sourceKey,
    status: sourceKey === null ? "unavailable" : "known",
  };
}
