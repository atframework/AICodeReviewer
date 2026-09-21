/**
 * In-memory AutoCommitStore — the reference implementation of the scheduling
 * state machine. Single-process only: restart loses everything (memory queue's
 * documented non-persistence boundary; never presented as durable).
 *
 * Atomicity: every mutation runs in a synchronous critical section — no `await`
 * between check and write — so concurrent callers within the process serialize
 * naturally. Cross-process claims are impossible by construction.
 *
 * Head maintenance: stream/workspace `notBefore` bounds are recomputed exactly
 * from that stream's/ workspace's own records at mutation time — never by
 * scanning the global pending set (the anti-pattern the design forbids for the
 * legacy memory queue). Streams and workspaces are the bounded units.
 */

import { randomUUID } from "node:crypto";

import { computeMemberId, computeStreamId } from "./auto-commit-identity.js";
import type { CommitBatchStatus } from "./auto-commit-identity.js";
import type {
  AcceptReceiptInput,
  AcceptReceiptResult,
  AcceptRoutingReceiptInput,
  AcceptRoutingReceiptResult,
  FrozenScopeResolution,
  ApplyMetadataPageInput,
  ApplyMetadataPageResult,
  AutoCommitReceipt,
  AutoCommitStore,
  BatchCompletion,
  BatchExecutionCheckpoint,
  ClaimedDispatch,
  CommitBatchRecord,
  CommitMemberRecord,
  DispatchOutboxEntry,
  MemberExclusionState,
  NextWake,
  Page,
  ReceiptQueryResult,
  RoutingReceiptRecord,
  SealBatchInput,
  SealBatchResult,
  StreamHead,
  StreamHeadUpdate,
  StreamReservation,
  WorkspaceHead,
} from "./auto-commit-store.js";
import {
  computeMemberEligibility,
  mergeSourceEvidence,
} from "./auto-commit-store.js";

const DISPATCH_CLAIM_TTL_MS = 30_000;

interface ReceiptState extends AutoCommitReceipt {
  readonly streamId: string;
}

interface MemberState {
  record: CommitMemberRecord;
  /** Receipt seq of the earliest covering notification (persistent order). */
  coverSeq: number;
}

interface StreamState {
  head: StreamHead;
}

interface BatchState {
  record: CommitBatchRecord;
}

interface OutboxState {
  entry: DispatchOutboxEntry;
  claimToken: string | null;
  claimExpiry: number | null;
}

function toStreamHead(state: StreamState): StreamHead {
  return state.head;
}

export function createMemoryAutoCommitStore(): AutoCommitStore {
  const receipts = new Map<string, ReceiptState>();
  const receiptIdsByDelivery = new Map<string, string>();
  const routingReceipts = new Map<string, RoutingReceiptRecord>();
  const routingIdsByKey = new Map<string, string>();
  const members = new Map<string, MemberState>();
  const memberIdsByStream = new Map<string, Set<string>>();
  const receiptIdsByStream = new Map<string, Set<string>>();
  const memberIdsByReceipt = new Map<string, Set<string>>();
  const receiptIdsByMember = new Map<string, Set<string>>();
  const streams = new Map<string, StreamState>();
  const streamIdsByWorkspace = new Map<string, Set<string>>();
  const workspaceHeads = new Map<string, WorkspaceHead>();
  const batches = new Map<string, BatchState>();
  const outbox = new Map<string, OutboxState>();
  let receiptSeqCounter = 0;
  let fairnessCounter = 0;

  function addAssociation(receiptId: string, memberId: string): void {
    const byReceipt = memberIdsByReceipt.get(receiptId) ?? new Set<string>();
    byReceipt.add(memberId);
    memberIdsByReceipt.set(receiptId, byReceipt);
    const byMember = receiptIdsByMember.get(memberId) ?? new Set<string>();
    byMember.add(receiptId);
    receiptIdsByMember.set(memberId, byMember);
  }

  function workspaceHeadFor(workspaceId: string): WorkspaceHead {
    let head = workspaceHeads.get(workspaceId);
    if (!head) {
      head = {
        workspaceId,
        notBefore: null,
        fairnessSeq: ++fairnessCounter,
        version: 0,
      };
      workspaceHeads.set(workspaceId, head);
    }
    return head;
  }

  /** Exact recompute from this stream's own receipts, pending members, and active batch. */
  function recomputeStreamNotBefore(streamId: string): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    let notBefore: number | null = null;
    const consider = (value: number | null | undefined) => {
      if (value === null || value === undefined) return;
      notBefore = notBefore === null ? value : Math.min(notBefore, value);
    };
    const receiptIds = receiptIdsByStream.get(streamId);
    if (receiptIds) {
      for (const receiptId of receiptIds) {
        const receipt = receipts.get(receiptId);
        if (
          receipt &&
          receipt.receiptSeq > stream.head.coverageCursor &&
          receipt.metadataTerminalError === null
        ) {
          consider(
            Math.max(
              computeMemberEligibility(
                receipt.firstAcceptedAt,
                receipt.delaySeconds,
              ),
              receipt.metadataNextAttemptAt ?? 0,
            ),
          );
        }
      }
    }
    const memberIds = memberIdsByStream.get(streamId);
    if (memberIds) {
      for (const memberId of memberIds) {
        const member = members.get(memberId);
        if (member && member.record.status === "pending") {
          consider(member.record.eligibleAt);
        }
      }
    }
    if (stream.head.activeBatchId) {
      const batch = batches.get(stream.head.activeBatchId);
      if (batch && batch.record.status === "retry_wait") {
        consider(batch.record.retryNotBefore ?? 0);
      }
    }
    if (notBefore !== null && stream.head.resumeNotBefore !== null)
      notBefore = Math.max(notBefore, stream.head.resumeNotBefore);
    stream.head = { ...stream.head, notBefore };
    recomputeWorkspaceNotBefore(stream.head.workspaceId);
  }

  function recomputeWorkspaceNotBefore(workspaceId: string): void {
    const head = workspaceHeadFor(workspaceId);
    let notBefore: number | null = null;
    const streamIds = streamIdsByWorkspace.get(workspaceId);
    if (streamIds) {
      for (const streamId of streamIds) {
        const value = streams.get(streamId)?.head.notBefore;
        if (value !== null && value !== undefined) {
          notBefore = notBefore === null ? value : Math.min(notBefore, value);
        }
      }
    }
    workspaceHeads.set(workspaceId, {
      ...head,
      notBefore,
      version: head.version + 1,
    });
  }

  function requireStream(streamId: string): StreamState | undefined {
    return streams.get(streamId);
  }

  return {
    backendKind: "memory",

    async acceptReceipt(
      input: AcceptReceiptInput,
    ): Promise<AcceptReceiptResult> {
      const existingId = receiptIdsByDelivery.get(input.deliveryKey);
      if (existingId) {
        const existing = receipts.get(existingId);
        if (existing) {
          return { receipt: existing, duplicate: true };
        }
      }

      const streamId = computeStreamId({
        workspaceId: input.workspaceId,
        triggerName: input.triggerName,
        vcs: input.vcs,
        sourceNamespace: input.sourceNamespace,
        scopeRef: input.scopeRef,
        historyGeneration: input.historyGeneration,
      });
      receiptSeqCounter += 1;
      const receipt: ReceiptState = {
        receiptId: randomUUID(),
        receiptSeq: receiptSeqCounter,
        deliveryKey: input.deliveryKey,
        workspaceId: input.workspaceId,
        triggerName: input.triggerName,
        provider: input.provider,
        vcs: input.vcs,
        sourceNamespace: input.sourceNamespace,
        scopeRef: input.scopeRef,
        historyGeneration: input.historyGeneration,
        coverage: input.coverage,
        metadataCursor: null,
        metadataAttempts: 0,
        metadataNextAttemptAt: null,
        metadataTerminalError: null,
        resolution: input.resolution ?? null,
        configSnapshotId: input.configSnapshotId ?? null,
        timeoutReportedAt: null,
        envelope: input.envelope,
        firstAcceptedAt: input.now,
        delaySeconds: input.delaySeconds,
        policyVersion: input.policyVersion,
        streamId,
      };
      receipts.set(receipt.receiptId, receipt);
      receiptIdsByDelivery.set(input.deliveryKey, receipt.receiptId);

      const streamIds =
        streamIdsByWorkspace.get(input.workspaceId) ?? new Set<string>();
      streamIds.add(streamId);
      streamIdsByWorkspace.set(input.workspaceId, streamIds);
      const receiptIds = receiptIdsByStream.get(streamId) ?? new Set<string>();
      receiptIds.add(receipt.receiptId);
      receiptIdsByStream.set(streamId, receiptIds);

      if (!streams.has(streamId)) {
        streams.set(streamId, {
          head: {
            streamId,
            workspaceId: input.workspaceId,
            triggerName: input.triggerName,
            vcs: input.vcs,
            sourceNamespace: input.sourceNamespace,
            scopeRef: input.scopeRef,
            historyGeneration: input.historyGeneration,
            notBefore: null,
            activeBatchId: null,
            reservationOwner: null,
            reservationToken: null,
            reservationExpiry: null,
            coverageCursor: 0,
            latestReceiptSeq: 0,
            assemblyCutSeq: null,
            assemblyAt: null,
            resumeNotBefore: null,
            version: 0,
          },
        });
        workspaceHeadFor(input.workspaceId);
      }
      const acceptedStream = streams.get(streamId);
      if (acceptedStream)
        acceptedStream.head = {
          ...acceptedStream.head,
          latestReceiptSeq: receipt.receiptSeq,
        };
      recomputeStreamNotBefore(streamId);
      return { receipt, duplicate: false };
    },

    async listActiveConfigSnapshotIds(_now: number): Promise<readonly string[]> {
      const ids = new Set<string>();
      for (const receipt of receipts.values()) {
        if (receipt.configSnapshotId === null) continue;
        const memberIds = [...(memberIdsByReceipt.get(receipt.receiptId) ?? [])];
        const hasPending = memberIds.some((memberId) => members.get(memberId)?.record.status === "pending");
        const unexpanded = receipt.receiptSeq > (streams.get(receipt.streamId)?.head.coverageCursor ?? 0);
        if (hasPending || unexpanded || receipt.metadataTerminalError !== null) ids.add(receipt.configSnapshotId);
      }
      for (const batch of batches.values()) {
        if (batch.record.configSnapshotId === null) continue;
        if (batch.record.status !== "completed" && batch.record.status !== "skipped") {
          ids.add(batch.record.configSnapshotId);
        }
      }
      for (const receipt of routingReceipts.values()) {
        const envelope = receipt.envelope as { configSnapshotId?: unknown } | null;
        if (receipt.completedAt === null && typeof envelope?.configSnapshotId === "string") ids.add(envelope.configSnapshotId);
      }
      return [...ids];
    },

    async acceptRoutingReceipt(
      input: AcceptRoutingReceiptInput,
    ): Promise<AcceptRoutingReceiptResult> {
      const existingId = routingIdsByKey.get(input.routingKey);
      if (existingId) {
        const existing = routingReceipts.get(existingId);
        if (existing) {
          return { receipt: existing, duplicate: true };
        }
      }
      const record: RoutingReceiptRecord = {
        routingId: randomUUID(),
        routingKey: input.routingKey,
        provider: input.provider,
        triggerName: input.triggerName,
        envelope: input.envelope,
        parentDeliveryId: input.parentDeliveryId ?? null,
        firstAcceptedAt: input.now,
        attempts: 0,
        nextAttemptAt: null,
        terminalError: null,
        convertedReceiptIds: [],
        completedAt: null,
        note: null,
        resolution: null,
      };
      routingReceipts.set(record.routingId, record);
      routingIdsByKey.set(record.routingKey, record.routingId);
      return { receipt: record, duplicate: false };
    },

    async readDueRoutingReceipts(
      now: number,
      limit: number,
    ): Promise<readonly RoutingReceiptRecord[]> {
      const due: RoutingReceiptRecord[] = [];
      for (const record of routingReceipts.values()) {
        if (record.terminalError !== null || record.completedAt !== null) {
          continue;
        }
        if (record.nextAttemptAt !== null && record.nextAttemptAt > now) {
          continue;
        }
        due.push(record);
      }
      due.sort((a, b) => a.firstAcceptedAt - b.firstAcceptedAt);
      return due.slice(0, limit);
    },

    async getRoutingReceipt(
      routingId: string,
    ): Promise<RoutingReceiptRecord | undefined> {
      return routingReceipts.get(routingId);
    },

    async recordRoutingReceiptFailure(
      routingId: string,
      error: string,
      retryAt: number | null,
    ): Promise<void> {
      const record = routingReceipts.get(routingId);
      if (!record || record.terminalError !== null || record.completedAt !== null) {
        return;
      }
      routingReceipts.set(routingId, {
        ...record,
        attempts: record.attempts + 1,
        nextAttemptAt: retryAt,
        terminalError: retryAt === null ? error : null,
      });
    },

    async recordRoutingReceiptResolution(
      routingId: string,
      resolution: readonly FrozenScopeResolution[],
      _now: number,
    ): Promise<RoutingReceiptRecord> {
      const record = routingReceipts.get(routingId);
      if (!record) {
        throw new Error(`Unknown routing receipt ${routingId}.`);
      }
      if (record.resolution !== null) {
        return record;
      }
      const updated: RoutingReceiptRecord = { ...record, resolution };
      routingReceipts.set(routingId, updated);
      return updated;
    },

    async recordRoutingReceiptConversion(
      routingId: string,
      input: {
        readonly addedReceiptIds?: readonly string[];
        readonly complete?: boolean;
        readonly note?: string;
      },
      now: number,
    ): Promise<RoutingReceiptRecord> {
      const record = routingReceipts.get(routingId);
      if (!record) {
        throw new Error(`Unknown routing receipt ${routingId}.`);
      }
      const ids = new Set(record.convertedReceiptIds);
      for (const id of input.addedReceiptIds ?? []) {
        ids.add(id);
      }
      const updated: RoutingReceiptRecord = {
        ...record,
        convertedReceiptIds: [...ids],
        completedAt: input.complete === true ? record.completedAt ?? now : record.completedAt,
        note: input.note ?? record.note,
      };
      routingReceipts.set(routingId, updated);
      return updated;
    },

    async applyMetadataPage(
      input: ApplyMetadataPageInput,
    ): Promise<ApplyMetadataPageResult> {
      const receipt = receipts.get(input.receiptId);
      if (!receipt) {
        throw new RangeError(`Unknown receipt ${input.receiptId}`);
      }
      if (receipt.streamId !== input.streamId)
        throw new RangeError("Receipt stream mismatch");
      let created = 0;
      let updated = 0;
      const conflicted: string[] = [];

      for (const upsert of input.members) {
        const memberId = computeMemberId(input.streamId, upsert.revision);
        addAssociation(input.receiptId, memberId);
        const existing = members.get(memberId);

        if (existing) {
          // Earliest covering notification (by persistent receipt seq) owns the
          // (firstAcceptedAt, delay) pair; later/duplicate notifications never
          // reset it, regardless of expansion order or clock jumps.
          if (
            existing.record.status === "pending" &&
            receipt.receiptSeq < existing.coverSeq
          ) {
            existing.coverSeq = receipt.receiptSeq;
            existing.record = {
              ...existing.record,
              coverReceiptId: receipt.receiptId,
              firstAcceptedAt: receipt.firstAcceptedAt,
              eligibleAt: computeMemberEligibility(
                receipt.firstAcceptedAt,
                receipt.delaySeconds,
              ),
            };
          }
          if (
            existing.record.status === "pending" &&
            existing.record.batchId === null
          ) {
            const prior = existing.record.sourceSnapshot;
            if (prior === null) {
              existing.record = {
                ...existing.record,
                orderKey: upsert.orderKey,
                parents: upsert.parents,
                sourceSnapshot: upsert.sourceSnapshot,
              };
              updated += 1;
            } else {
              const snapshot = mergeSourceEvidence(
                prior,
                upsert.sourceSnapshot,
                existing.record.coverReceiptId === receipt.receiptId,
              );
              existing.record = {
                ...existing.record,
                sourceSnapshot: snapshot,
              };
              if (snapshot.status === "conflicted") conflicted.push(memberId);
              updated += 1;
            }
          }
          // Batched/terminal members only gain the idempotent association.
          continue;
        }

        const record: CommitMemberRecord = {
          memberId,
          streamId: input.streamId,
          revision: upsert.revision,
          coverReceiptId: receipt.receiptId,
          orderKey: upsert.orderKey,
          parents: upsert.parents,
          status: "pending",
          sourceSnapshot: upsert.sourceSnapshot,
          exclusion: { state: "undecided", ruleId: null, policyVersion: null },
          eligibleAt: computeMemberEligibility(
            receipt.firstAcceptedAt,
            receipt.delaySeconds,
          ),
          firstAcceptedAt: receipt.firstAcceptedAt,
          batchId: null,
          terminalReason: null,
        };
        members.set(memberId, { record, coverSeq: receipt.receiptSeq });
        const streamMembers =
          memberIdsByStream.get(input.streamId) ?? new Set<string>();
        streamMembers.add(memberId);
        memberIdsByStream.set(input.streamId, streamMembers);
        created += 1;
      }

      recomputeStreamNotBefore(input.streamId);
      return { created, updated, conflicted };
    },

    async setReceiptMetadataCursor(
      receiptId: string,
      cursor: string | null,
    ): Promise<void> {
      const receipt = receipts.get(receiptId);
      if (!receipt) {
        throw new RangeError(`Unknown receipt ${receiptId}`);
      }
      receipts.set(receiptId, {
        ...receipt,
        metadataCursor: cursor,
        metadataNextAttemptAt: null,
      });
      recomputeStreamNotBefore(receipt.streamId);
    },

    async recordReceiptMetadataFailure(
      receiptId: string,
      error: string,
      retryAt: number | null,
    ): Promise<void> {
      const receipt = receipts.get(receiptId);
      if (!receipt) throw new RangeError(`Unknown receipt ${receiptId}`);
      receipts.set(receiptId, {
        ...receipt,
        metadataAttempts: receipt.metadataAttempts + 1,
        metadataNextAttemptAt: retryAt,
        metadataTerminalError: retryAt === null ? error : null,
      });
      recomputeStreamNotBefore(receipt.streamId);
    },

    async readMembers(
      memberIds: readonly string[],
    ): Promise<readonly CommitMemberRecord[]> {
      if (memberIds.length > 512)
        throw new RangeError("Member lookup exceeds 512");
      return memberIds.flatMap((id) => {
        const state = members.get(id);
        return state ? [state.record] : [];
      });
    },

    async applyExclusionVerdicts(input: {
      readonly streamId: string;
      readonly verdicts: readonly {
        readonly memberId: string;
        readonly state: MemberExclusionState;
        readonly ruleId?: string;
        readonly policyVersion: string;
      }[];
      readonly now: number;
    }): Promise<void> {
      for (const verdict of input.verdicts) {
        const member = members.get(verdict.memberId);
        if (
          !member ||
          member.record.streamId !== input.streamId ||
          member.record.status !== "pending"
        )
          continue;
        const excluded = verdict.state === "excluded";
        // "unavailable" is terminal: unavailable/conflicted source evidence
        // blocks merging forever (design §5.1.1) and v1 has no manual allow
        // path, so the member fails explicitly — never silently re-keyed.
        const failed = verdict.state === "unavailable";
        member.record = {
          ...member.record,
          status: excluded
            ? "skipped"
            : failed
              ? "failed"
              : member.record.status,
          exclusion: {
            state: verdict.state,
            ruleId: verdict.ruleId ?? null,
            policyVersion: verdict.policyVersion,
          },
          ...(excluded ? { terminalReason: "excluded_source" } : {}),
          ...(failed
            ? { terminalReason: verdict.ruleId ?? "source_unavailable" }
            : {}),
        };
      }
      recomputeStreamNotBefore(input.streamId);
    },

    async readRunnableWorkspaceHeads(
      now: number,
      limit: number,
    ): Promise<readonly WorkspaceHead[]> {
      const due = [...workspaceHeads.values()].filter(
        (head) => head.notBefore !== null && head.notBefore <= now,
      );
      due.sort((a, b) => a.fairnessSeq - b.fairnessSeq);
      return due.slice(0, limit);
    },

    async readStreamHeads(
      workspaceId: string,
      limit: number,
    ): Promise<readonly StreamHead[]> {
      const streamIds = streamIdsByWorkspace.get(workspaceId);
      if (!streamIds) return [];
      const heads = [...streamIds]
        .map((streamId) => streams.get(streamId))
        .filter((stream): stream is StreamState => stream !== undefined)
        .map(toStreamHead);
      heads.sort((a, b) => {
        if (a.notBefore === null && b.notBefore === null)
          return a.streamId < b.streamId ? -1 : 1;
        if (a.notBefore === null) return 1;
        if (b.notBefore === null) return -1;
        return a.notBefore - b.notBefore;
      });
      return heads.slice(0, limit);
    },

    async readStreamHead(streamId: string): Promise<StreamHead | undefined> {
      return streams.get(streamId)?.head;
    },

    async readPendingMembers(
      streamId: string,
      cursor: string | null,
      limit: number,
    ): Promise<Page<CommitMemberRecord>> {
      const memberIds = memberIdsByStream.get(streamId);
      if (!memberIds) return { items: [], nextCursor: null };
      const pending = [...memberIds]
        .map((memberId) => members.get(memberId))
        .filter(
          (member): member is MemberState =>
            member !== undefined && member.record.status === "pending",
        )
        .map((member) => member.record);
      // Metadata-pending members (null orderKey) first in member id order,
      // then verified members in VCS order.
      pending.sort((a, b) => {
        if (a.orderKey === null && b.orderKey === null)
          return a.memberId < b.memberId ? -1 : 1;
        if (a.orderKey === null) return -1;
        if (b.orderKey === null) return 1;
        if (a.orderKey !== b.orderKey) return a.orderKey < b.orderKey ? -1 : 1;
        return a.memberId < b.memberId ? -1 : 1;
      });
      const startIndex =
        cursor === null
          ? 0
          : pending.findIndex((member) => memberCursor(member) > cursor);
      const slice = pending.slice(
        startIndex < 0 ? pending.length : startIndex,
        (startIndex < 0 ? pending.length : startIndex) + limit,
      );
      const last = slice[slice.length - 1];
      const nextCursor =
        slice.length === limit && last ? memberCursor(last) : null;
      return { items: slice, nextCursor };
    },

    async readStreamReceipts(
      streamId: string,
      fromSeq: number,
      toSeq: number,
      limit: number,
    ): Promise<readonly AutoCommitReceipt[]> {
      const receiptIds = receiptIdsByStream.get(streamId);
      if (!receiptIds) return [];
      return [...receiptIds]
        .map((receiptId) => receipts.get(receiptId))
        .filter(
          (receipt): receipt is ReceiptState =>
            receipt !== undefined &&
            receipt.receiptSeq > fromSeq &&
            receipt.receiptSeq <= toSeq,
        )
        .sort((a, b) => a.receiptSeq - b.receiptSeq)
        .slice(0, limit);
    },

    async readMemberReceipts(
      memberId: string,
      cursor: string | null,
      limit: number,
    ): Promise<Page<string>> {
      const receiptIds = [...(receiptIdsByMember.get(memberId) ?? [])].sort();
      const startIndex =
        cursor === null
          ? 0
          : receiptIds.findIndex((receiptId) => receiptId > cursor);
      const slice = receiptIds.slice(
        startIndex < 0 ? receiptIds.length : startIndex,
        (startIndex < 0 ? receiptIds.length : startIndex) + limit,
      );
      const last = slice[slice.length - 1];
      return {
        items: slice,
        nextCursor: slice.length === limit && last ? last : null,
      };
    },

    async readReceiptMembers(
      receiptId: string,
      cursor: string | null,
      limit: number,
    ): Promise<Page<CommitMemberRecord>> {
      const memberIds = [...(memberIdsByReceipt.get(receiptId) ?? [])].sort();
      const startIndex =
        cursor === null
          ? 0
          : memberIds.findIndex((memberId) => memberId > cursor);
      const pageIds = memberIds.slice(
        startIndex < 0 ? memberIds.length : startIndex,
        (startIndex < 0 ? memberIds.length : startIndex) + limit,
      );
      const items = pageIds
        .map((memberId) => members.get(memberId)?.record)
        .filter((record): record is CommitMemberRecord => record !== undefined);
      const last = pageIds[pageIds.length - 1];
      return {
        items,
        nextCursor: pageIds.length === limit && last ? last : null,
      };
    },

    async acquireStreamReservation(
      streamId: string,
      ownerId: string,
      ttlMs: number,
      now: number,
    ): Promise<StreamReservation | undefined> {
      const stream = requireStream(streamId);
      if (!stream) return undefined;
      const head = stream.head;
      if (head.activeBatchId !== null) return undefined;
      if (
        head.reservationToken !== null &&
        head.reservationExpiry !== null &&
        head.reservationExpiry > now
      ) {
        return undefined;
      }
      const token = `${ownerId}-${randomUUID()}`;
      const version = head.version + 1;
      stream.head = {
        ...head,
        reservationOwner: ownerId,
        reservationToken: token,
        reservationExpiry: now + ttlMs,
        version,
      };
      return { streamId, token, expiry: now + ttlMs, version };
    },

    async renewStreamReservation(
      streamId: string,
      token: string,
      ttlMs: number,
      now: number,
    ): Promise<boolean> {
      const stream = requireStream(streamId);
      if (!stream) return false;
      const head = stream.head;
      if (
        head.reservationToken !== token ||
        head.reservationExpiry === null ||
        head.reservationExpiry <= now
      ) {
        return false;
      }
      stream.head = {
        ...head,
        reservationExpiry: now + ttlMs,
        version: head.version + 1,
      };
      return true;
    },

    async releaseStreamReservation(
      streamId: string,
      token: string,
      _now: number,
    ): Promise<void> {
      const stream = requireStream(streamId);
      if (!stream) return;
      const head = stream.head;
      if (head.reservationToken !== token) return;
      stream.head = {
        ...head,
        reservationOwner: null,
        reservationToken: null,
        reservationExpiry: null,
        version: head.version + 1,
      };
    },

    async updateStreamHead(
      streamId: string,
      expectedVersion: number,
      update: StreamHeadUpdate,
      _now: number,
    ): Promise<boolean> {
      const stream = requireStream(streamId);
      if (!stream || stream.head.version !== expectedVersion) return false;
      stream.head = {
        ...stream.head,
        ...(update.notBefore !== undefined
          ? { notBefore: update.notBefore }
          : {}),
        ...(update.resumeNotBefore !== undefined
          ? { resumeNotBefore: update.resumeNotBefore }
          : {}),
        ...(update.assemblyCutSeq !== undefined
          ? { assemblyCutSeq: update.assemblyCutSeq }
          : {}),
        ...(update.assemblyAt !== undefined
          ? { assemblyAt: update.assemblyAt }
          : {}),
        ...(update.coverageCursor !== undefined
          ? { coverageCursor: update.coverageCursor }
          : {}),
        ...(update.historyGeneration !== undefined
          ? { historyGeneration: update.historyGeneration }
          : {}),
        version: expectedVersion + 1,
      };
      recomputeStreamNotBefore(streamId);
      return true;
    },

    async rotateWorkspaceFairness(
      workspaceId: string,
      _now: number,
    ): Promise<void> {
      const head = workspaceHeadFor(workspaceId);
      workspaceHeads.set(workspaceId, {
        ...head,
        fairnessSeq: ++fairnessCounter,
        version: head.version + 1,
      });
    },

    async sealBatch(input: SealBatchInput): Promise<SealBatchResult> {
      const stream = requireStream(input.streamId);
      if (!stream) return { kind: "conflict", reason: "reservation_lost" };
      const head = stream.head;
      if (
        head.reservationToken !== input.reservationToken ||
        head.reservationExpiry === null ||
        head.reservationExpiry <= input.now
      ) {
        return { kind: "conflict", reason: "reservation_lost" };
      }
      if (head.version !== input.expectedStreamVersion) {
        return { kind: "conflict", reason: "stream_version_mismatch" };
      }
      if (head.activeBatchId !== null) {
        return { kind: "conflict", reason: "active_batch" };
      }
      if (
        input.members.length === 0 ||
        input.members.length > 50 ||
        batches.has(input.batchId) ||
        new Set(input.members.map((m) => m.memberId)).size !==
          input.members.length
      )
        return { kind: "conflict", reason: "member_unavailable" };
      for (const member of input.members) {
        const state = members.get(member.memberId);
        if (
          !state ||
          state.record.streamId !== input.streamId ||
          state.record.status !== "pending" ||
          state.record.batchId !== null ||
          state.record.sourceSnapshot?.status === "conflicted"
        ) {
          return {
            kind: "conflict",
            reason: "member_unavailable",
            memberId: member.memberId,
          };
        }
        if (state.record.eligibleAt > input.now) {
          return {
            kind: "conflict",
            reason: "member_ineligible",
            memberId: member.memberId,
          };
        }
      }

      const batch: CommitBatchRecord = {
        executionCheckpoint: null,
        batchId: input.batchId,
        runId: input.runId,
        streamId: input.streamId,
        workspaceId: head.workspaceId,
        triggerName: head.triggerName,
        vcs: head.vcs,
        sourceNamespace: head.sourceNamespace,
        scopeRef: head.scopeRef,
        historyGeneration: head.historyGeneration,
        sourceKey: input.sourceKey,
        members: input.members,
        base: input.base,
        head: input.head,
        exclusionPolicyVersion: input.exclusionPolicyVersion,
        configPolicyVersion: input.configPolicyVersion,
        configSnapshotId: input.configSnapshotId ?? null,
        status: "dispatch_pending",
        attempt: 0,
        maxAttempts: input.maxAttempts,
        recoveryAttempt: 0,
        retryNotBefore: null,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiry: null,
        lastError: null,
        createdAt: input.now,
      };
      batches.set(input.batchId, { record: batch });
      outbox.set(input.batchId, {
        entry: {
          batchId: input.batchId,
          status: "pending",
          nextAttemptAt: input.now,
        },
        claimToken: null,
        claimExpiry: null,
      });
      for (const member of input.members) {
        const state = members.get(member.memberId);
        if (state) {
          state.record = {
            ...state.record,
            status: "batched",
            batchId: input.batchId,
          };
        }
      }
      stream.head = {
        ...head,
        activeBatchId: input.batchId,
        reservationOwner: null,
        reservationToken: null,
        reservationExpiry: null,
        version: head.version + 1,
      };
      recomputeStreamNotBefore(input.streamId);
      return { kind: "sealed" };
    },

    async claimDispatch(
      now: number,
      ownerId: string,
      limit: number,
      excludedWorkspaceIds: readonly string[] = [],
    ): Promise<readonly ClaimedDispatch[]> {
      const due = [...outbox.values()]
        .filter(
          (entry) =>
            entry.entry.status === "pending" &&
            entry.entry.nextAttemptAt <= now &&
            !excludedWorkspaceIds.includes(batches.get(entry.entry.batchId)?.record.workspaceId ?? "") &&
            (entry.claimToken === null ||
              entry.claimExpiry === null ||
              entry.claimExpiry <= now),
        )
        .sort((a, b) => a.entry.nextAttemptAt - b.entry.nextAttemptAt)
        .slice(0, limit);
      const claimed: ClaimedDispatch[] = [];
      for (const entry of due) {
        const batch = batches.get(entry.entry.batchId);
        if (!batch) continue;
        const claimToken = `${ownerId}-${randomUUID()}`;
        entry.claimToken = claimToken;
        entry.claimExpiry = now + DISPATCH_CLAIM_TTL_MS;
        claimed.push({ batch: batch.record, claimToken });
      }
      return claimed;
    },

    async confirmDispatch(
      batchId: string,
      claimToken: string,
      now: number,
    ): Promise<void> {
      const entry = outbox.get(batchId);
      const batch = batches.get(batchId);
      if (!entry || !batch || entry.claimToken !== claimToken) return;
      entry.entry = { ...entry.entry, status: "dispatched" };
      entry.claimToken = null;
      entry.claimExpiry = null;
      batch.record = {
        ...batch.record,
        status: "queued",
        leaseExpiry: now + DISPATCH_CLAIM_TTL_MS,
      };
    },

    async abortDispatch(
      batchId: string,
      claimToken: string,
      nextAttemptAt: number,
      _now: number,
    ): Promise<void> {
      const entry = outbox.get(batchId);
      if (!entry || entry.claimToken !== claimToken) return;
      entry.entry = { batchId, status: "pending", nextAttemptAt };
      entry.claimToken = null;
      entry.claimExpiry = null;
    },

    async startBatchExecution(
      batchId: string,
      ownerId: string,
      ttlMs: number,
      now: number,
      limits = { global: 1, workspace: 1 },
    ): Promise<string | undefined> {
      const batch = batches.get(batchId);
      if (!batch) return undefined;
      const record = batch.record;
      if (record.status !== "queued") return undefined;
      if (
        record.leaseToken !== null &&
        record.leaseExpiry !== null &&
        record.leaseExpiry > now
      ) {
        return undefined;
      }
      let globalActive = 0;
      let workspaceActive = 0;
      for (const state of batches.values()) {
        if (
          state.record.status === "running" &&
          (state.record.leaseExpiry ?? 0) > now
        ) {
          globalActive += 1;
          if (state.record.workspaceId === record.workspaceId)
            workspaceActive += 1;
        }
      }
      if (globalActive >= limits.global || workspaceActive >= limits.workspace)
        return undefined;
      const token = `${ownerId}-${randomUUID()}`;
      batch.record = {
        ...record,
        status: "running",
        attempt: record.attempt + 1,
        leaseToken: token,
        leaseOwner: ownerId,
        leaseExpiry: now + ttlMs,
      };
      return token;
    },

    async deferBatchExecution(
      batchId: string,
      nextAttemptAt: number,
    ): Promise<void> {
      const batch = batches.get(batchId);
      if (!batch || batch.record.status !== "queued") return;
      batch.record = {
        ...batch.record,
        status: "retry_wait",
        retryNotBefore: nextAttemptAt,
        leaseExpiry: null,
      };
      outbox.set(batchId, {
        entry: { batchId, status: "pending", nextAttemptAt },
        claimToken: null,
        claimExpiry: null,
      });
      recomputeStreamNotBefore(batch.record.streamId);
    },

    async checkpointBatchExecution(
      batchId: string,
      token: string,
      checkpoint: BatchExecutionCheckpoint,
      now: number,
    ): Promise<boolean> {
      const json = JSON.stringify(checkpoint);
      if (Buffer.byteLength(json) > 1_048_576)
        throw new RangeError("Execution checkpoint exceeds 1 MiB");
      const batch = batches.get(batchId);
      if (
        !batch ||
        batch.record.status !== "running" ||
        batch.record.leaseToken !== token ||
        (batch.record.leaseExpiry ?? 0) <= now
      )
        return false;
      batch.record = {
        ...batch.record,
        executionCheckpoint: JSON.parse(json) as BatchExecutionCheckpoint,
      };
      return true;
    },

    async renewBatchLease(
      batchId: string,
      token: string,
      ttlMs: number,
      now: number,
    ): Promise<boolean> {
      const batch = batches.get(batchId);
      if (!batch) return false;
      const record = batch.record;
      if (
        record.status !== "running" ||
        record.leaseToken !== token ||
        record.leaseExpiry === null ||
        record.leaseExpiry <= now
      ) {
        return false;
      }
      batch.record = { ...record, leaseExpiry: now + ttlMs };
      return true;
    },

    async completeBatch(
      batchId: string,
      token: string,
      completion: BatchCompletion,
      now: number,
    ): Promise<void> {
      const batch = batches.get(batchId);
      if (!batch) return;
      const record = batch.record;
      if (
        record.status !== "running" ||
        record.leaseToken !== token ||
        (record.leaseExpiry ?? 0) <= now
      )
        return;
      const terminal = completion.outcome;
      batch.record = {
        ...record,
        status: terminal,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiry: null,
      };
      for (const member of record.members) {
        const state = members.get(member.memberId);
        if (state && state.record.batchId === batchId) {
          state.record = {
            ...state.record,
            status: terminal,
            ...(terminal === "skipped" && completion.outcome === "skipped"
              ? { terminalReason: completion.reason }
              : {}),
          };
        }
      }
      outbox.delete(batchId);
      clearStreamActiveBatch(record.streamId, batchId);
    },

    async failBatch(
      batchId: string,
      token: string,
      error: string,
      retryNotBefore: number | null,
      dead: boolean,
      now: number,
    ): Promise<void> {
      const batch = batches.get(batchId);
      if (!batch) return;
      const record = batch.record;
      if (
        record.status !== "running" ||
        record.leaseToken !== token ||
        (record.leaseExpiry ?? 0) <= now
      )
        return;
      const exhausted = dead || record.attempt >= record.maxAttempts;
      if (exhausted && record.recoveryAttempt === 0) {
        // Would-be-terminal failure consumes the single automatic recovery:
        // fresh attempt budget, due outbox entry, same batch re-executes.
        batch.record = {
          ...record,
          status: "retry_wait",
          lastError: `recovery: ${error}`,
          retryNotBefore: now,
          attempt: 1,
          recoveryAttempt: 1,
          leaseToken: null,
          leaseOwner: null,
          leaseExpiry: null,
        };
        outbox.set(batchId, {
          entry: { batchId, status: "pending", nextAttemptAt: now },
          claimToken: null,
          claimExpiry: null,
        });
      } else if (exhausted) {
        // Recovery attempt failed too: skip terminally, release the stream.
        batch.record = {
          ...record,
          status: "skipped",
          lastError: `recovery exhausted: ${error}`,
          leaseToken: null,
          leaseOwner: null,
          leaseExpiry: null,
        };
        for (const member of record.members) {
          const state = members.get(member.memberId);
          if (state && state.record.batchId === batchId) {
            state.record = {
              ...state.record,
              status: "skipped",
              terminalReason: `recovery exhausted: ${error}`,
            };
          }
        }
        clearStreamActiveBatch(record.streamId, batchId);
      } else {
        batch.record = {
          ...record,
          status: "retry_wait",
          lastError: error,
          retryNotBefore,
          leaseToken: null,
          leaseOwner: null,
          leaseExpiry: null,
        };
        outbox.set(batchId, {
          entry: {
            batchId,
            status: "pending",
            nextAttemptAt: retryNotBefore ?? now,
          },
          claimToken: null,
          claimExpiry: null,
        });
      }
      recomputeStreamNotBefore(record.streamId);
    },

    async reclaimExpiredBatchLeases(
      now: number,
      limit: number,
    ): Promise<readonly string[]> {
      const reclaimed: string[] = [];
      for (const batch of batches.values()) {
        if (reclaimed.length >= limit) break;
        const record = batch.record;
        if (
          (record.status !== "running" && record.status !== "queued") ||
          record.leaseExpiry === null ||
          record.leaseExpiry > now
        ) {
          continue;
        }
        const token = record.leaseToken;
        if (token === null && record.status !== "queued") continue;
        reclaimLeaseRecord(record.batchId, now, "lease_expired");
        reclaimed.push(record.batchId);
      }
      return reclaimed;
    },

    async reclaimBatchesByOwner(
      ownerId: string,
      now: number,
    ): Promise<readonly string[]> {
      const reclaimed: string[] = [];
      for (const batch of batches.values()) {
        const record = batch.record;
        if (record.status !== "running" || record.leaseOwner !== ownerId) {
          continue;
        }
        reclaimLeaseRecord(record.batchId, now, "interrupted_by_restart");
        reclaimed.push(record.batchId);
      }
      return reclaimed;
    },

    async recoverDeadBatches(now: number): Promise<readonly string[]> {
      const recovered: string[] = [];
      // Only the oldest dead batch per stream re-arms (it re-claims the
      // stream's active slot); a younger same-stream dead batch would
      // otherwise execute concurrently with it.
      const claimedStreams = new Set<string>();
      const dead = [...batches.values()]
        .map((batch) => batch.record)
        .filter((record) => record.status === "dead")
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const record of dead) {
        const stream = streams.get(record.streamId);
        if (!stream) continue;
        const active = stream.head.activeBatchId;
        if (
          (active !== null && active !== record.batchId) ||
          claimedStreams.has(record.streamId)
        ) {
          continue;
        }
        batches.set(record.batchId, {
          record: {
            ...record,
            status: "retry_wait",
            lastError: `legacy dead batch recovered at boot${record.lastError ? `; previous: ${record.lastError}` : ""}`,
            retryNotBefore: now,
            attempt: 1,
            recoveryAttempt: 1,
            leaseToken: null,
            leaseOwner: null,
            leaseExpiry: null,
          },
        });
        outbox.set(record.batchId, {
          entry: { batchId: record.batchId, status: "pending", nextAttemptAt: now },
          claimToken: null,
          claimExpiry: null,
        });
        for (const member of record.members) {
          const state = members.get(member.memberId);
          if (state && state.record.batchId === record.batchId && state.record.status === "dead") {
            state.record = { ...state.record, status: "batched", terminalReason: null };
          }
        }
        if (active === null) {
          stream.head = {
            ...stream.head,
            activeBatchId: record.batchId,
            version: stream.head.version + 1,
          };
        }
        recomputeStreamNotBefore(record.streamId);
        claimedStreams.add(record.streamId);
        recovered.push(record.batchId);
      }
      return recovered;
    },

    async requeueBatchForRecovery(
      batchId: string,
      now: number,
      configSnapshotId: string | null = null,
    ): Promise<CommitBatchRecord | undefined> {
      const batch = batches.get(batchId);
      if (!batch) return undefined;
      const record = batch.record;
      if (record.status !== "dead" && record.status !== "skipped") {
        return undefined;
      }
      const stream = streams.get(record.streamId);
      const active = stream?.head.activeBatchId ?? null;
      if (!stream || (active !== null && active !== batchId)) {
        // Another batch holds the stream; re-arming now would execute two
        // non-terminal batches concurrently on the same stream.
        return undefined;
      }
      batch.record = {
        ...record,
        status: "retry_wait",
        lastError: `manual retry re-armed${record.lastError ? `; previous: ${record.lastError}` : ""}`,
        retryNotBefore: now,
        attempt: 1,
        recoveryAttempt: 1,
        executionCheckpoint: null,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiry: null,
        // A manual retry executes against the CURRENT admission generation:
        // operators re-arm precisely to pick up settings changed since the
        // original admission (e.g. a raised review.max_patch_bytes).
        configSnapshotId,
      };
      outbox.set(batchId, {
        entry: { batchId, status: "pending", nextAttemptAt: now },
        claimToken: null,
        claimExpiry: null,
      });
      for (const member of record.members) {
        const state = members.get(member.memberId);
        if (
          state &&
          state.record.batchId === batchId &&
          (state.record.status === "dead" || state.record.status === "skipped")
        ) {
          state.record = { ...state.record, status: "batched", terminalReason: null };
        }
      }
      if (active === null) {
        stream.head = {
          ...stream.head,
          activeBatchId: batchId,
          version: stream.head.version + 1,
        };
      }
      recomputeStreamNotBefore(record.streamId);
      return batch.record;
    },

    async readBatchesByStatus(
      statuses: readonly CommitBatchStatus[],
      limit: number,
      offset = 0,
      history?: { readonly maxCount: number; readonly before: number },
    ): Promise<readonly CommitBatchRecord[]> {
      const wanted = new Set<string>(statuses);
      const historyIds = history ? new Set([...batches.values()].map(entry => entry.record)
        .filter(batch => ["completed", "skipped", "dead"].includes(batch.status) && batch.createdAt >= history.before)
        .sort((a, b) => b.createdAt - a.createdAt || (a.batchId < b.batchId ? 1 : a.batchId > b.batchId ? -1 : 0))
        .slice(0, history.maxCount).map(batch => batch.batchId)) : undefined;
      const matched: CommitBatchRecord[] = [];
      for (const batch of batches.values()) {
        if (wanted.has(batch.record.status) && (!historyIds || !["completed", "skipped", "dead"].includes(batch.record.status) ||
          historyIds.has(batch.record.batchId) || streams.get(batch.record.streamId)?.head.activeBatchId === batch.record.batchId)) {
          matched.push(batch.record);
        }
      }
      matched.sort((a, b) => b.createdAt - a.createdAt || (a.batchId < b.batchId ? 1 : a.batchId > b.batchId ? -1 : 0));
      return matched.slice(offset, offset + limit);
    },

    async pruneBatchHistory(maxCount: number, before: number, limit = 500): Promise<number> {
      const terminal = [...batches.values()].map((entry) => entry.record)
        .filter((batch) => ["completed", "skipped", "dead"].includes(batch.status))
        .sort((a, b) => b.createdAt - a.createdAt || (a.batchId < b.batchId ? 1 : a.batchId > b.batchId ? -1 : 0));
      const expired = terminal.filter((batch, index) => (index >= maxCount || batch.createdAt < before)
        && streams.get(batch.streamId)?.head.activeBatchId !== batch.batchId).slice(0, limit);
      for (const batch of expired) {
        batches.delete(batch.batchId);
        outbox.delete(batch.batchId);
      }
      return expired.length;
    },

    async timeoutStaleQueue(
      cutoff: number,
      now: number,
      workspaceId?: string,
    ): Promise<readonly string[]> {
      const affectedStreams = new Set<string>();
      for (const state of members.values()) {
        const record = state.record;
        if (
          record.status !== "pending" ||
          record.batchId !== null ||
          record.eligibleAt >= cutoff
        ) {
          continue;
        }
        if (workspaceId !== undefined) {
          const stream = streams.get(record.streamId);
          if (stream?.head.workspaceId !== workspaceId) continue;
        }
        state.record = {
          ...record,
          status: "skipped",
          terminalReason: "queued_timeout",
        };
        affectedStreams.add(record.streamId);
      }
      for (const streamId of affectedStreams) {
        recomputeStreamNotBefore(streamId);
      }
      const timedOut: string[] = [];
      for (const [receiptId, receipt] of receipts.entries()) {
        if (
          receipt.timeoutReportedAt !== null ||
          receipt.firstAcceptedAt >= cutoff
        ) {
          continue;
        }
        if (workspaceId !== undefined && receipt.workspaceId !== workspaceId) {
          continue;
        }
        const memberIds = memberIdsByReceipt.get(receiptId);
        let open = false;
        if (memberIds) {
          for (const memberId of memberIds) {
            const status = members.get(memberId)?.record.status;
            if (status === "pending" || status === "batched") {
              open = true;
              break;
            }
          }
        }
        if (!open) {
          receipts.set(receiptId, { ...receipt, timeoutReportedAt: now });
          timedOut.push(receiptId);
        }
      }
      return timedOut;
    },

    async listRoutingIntakeIdsForReceipts(
      receiptIds: readonly string[],
    ): Promise<readonly string[]> {
      const wanted = new Set(receiptIds);
      const ids: string[] = [];
      for (const record of routingReceipts.values()) {
        if (record.convertedReceiptIds.some((id) => wanted.has(id))) {
          ids.push(record.routingId);
        }
      }
      return ids;
    },

    async readBatch(batchId: string): Promise<CommitBatchRecord | undefined> {
      return batches.get(batchId)?.record;
    },

    async getReceipt(
      receiptId: string,
    ): Promise<ReceiptQueryResult | undefined> {
      const receipt = receipts.get(receiptId);
      if (!receipt) return undefined;
      const counts: Record<string, number> = {
        pending: 0,
        batched: 0,
        completed: 0,
        skipped: 0,
        failed: 0,
        dead: 0,
      };
      const memberIds = memberIdsByReceipt.get(receiptId);
      if (memberIds) {
        for (const memberId of memberIds) {
          const member = members.get(memberId);
          if (member) {
            counts[member.record.status] =
              (counts[member.record.status] ?? 0) + 1;
          }
        }
      }
      return {
        receipt,
        memberCounts: counts as ReceiptQueryResult["memberCounts"],
      };
    },

    async readNextWake(): Promise<NextWake | undefined> {
      let best: NextWake | undefined;
      const consider = (at: number | null, reason: NextWake["reason"]) => {
        if (at === null) return;
        if (!best || at < best.at) {
          best = { at, reason };
        }
      };
      for (const head of workspaceHeads.values()) {
        consider(head.notBefore, "delay");
      }
      for (const receipt of routingReceipts.values()) {
        if (receipt.completedAt === null && receipt.terminalError === null) {
          consider(receipt.nextAttemptAt ?? receipt.firstAcceptedAt, "routing_resolution");
        }
      }
      for (const entry of outbox.values()) {
        if (entry.entry.status === "pending") {
          consider(entry.entry.nextAttemptAt, "outbox_dispatch");
        }
      }
      for (const batch of batches.values()) {
        if (
          batch.record.status === "running" ||
          batch.record.status === "queued"
        ) {
          consider(batch.record.leaseExpiry, "lease_reclaim");
        }
      }
      return best;
    },
  };

  function clearStreamActiveBatch(streamId: string, batchId: string): void {
    const stream = streams.get(streamId);
    if (stream && stream.head.activeBatchId === batchId) {
      stream.head = {
        ...stream.head,
        activeBatchId: null,
        version: stream.head.version + 1,
      };
    }
    recomputeStreamNotBefore(streamId);
  }

  /**
   * Shared lease-reclaim transition: retry_wait with a fresh outbox entry,
   * or — at exhausted attempts — the single automatic recovery, or a terminal
   * skip releasing the stream. Mirrors the sqlite transaction of the same
   * name; the expired token dies with the record replacement.
   */
  function reclaimLeaseRecord(
    batchId: string,
    now: number,
    reason: string,
  ): void {
    const batch = batches.get(batchId);
    if (!batch) return;
    const record = batch.record;
    const exhausted =
      record.status === "running" && record.attempt >= record.maxAttempts;
    if (exhausted && record.recoveryAttempt === 0) {
      batch.record = {
        ...record,
        status: "retry_wait",
        lastError: `${reason}: recovery re-armed`,
        retryNotBefore: null,
        attempt: 1,
        recoveryAttempt: 1,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiry: null,
      };
      outbox.set(batchId, {
        entry: { batchId, status: "pending", nextAttemptAt: now },
        claimToken: null,
        claimExpiry: null,
      });
    } else if (exhausted) {
      batch.record = {
        ...record,
        status: "skipped",
        lastError: `recovery exhausted: ${reason}`,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiry: null,
      };
      for (const member of record.members) {
        const state = members.get(member.memberId);
        if (state && state.record.batchId === batchId) {
          state.record = {
            ...state.record,
            status: "skipped",
            terminalReason: `recovery exhausted: ${reason}`,
          };
        }
      }
      clearStreamActiveBatch(record.streamId, batchId);
    } else {
      batch.record = {
        ...record,
        status: "retry_wait",
        lastError: reason,
        retryNotBefore: null,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiry: null,
      };
      outbox.set(batchId, {
        entry: { batchId, status: "pending", nextAttemptAt: now },
        claimToken: null,
        claimExpiry: null,
      });
    }
    recomputeStreamNotBefore(record.streamId);
  }
}

function memberCursor(member: CommitMemberRecord): string {
  return `${member.orderKey ?? ""}${member.memberId}`;
}
