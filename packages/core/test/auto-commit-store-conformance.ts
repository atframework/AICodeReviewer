/**
 * Shared AutoCommitStore conformance scenarios. Every backend (memory, real
 * SQLite files, Redis when a service is available) must pass the identical
 * logical contract — the test matrix's Q/N sections depend on this suite.
 *
 * Time is injected explicitly through `now` parameters; no fake timers, no
 * sleeping.
 */

import { describe, expect, it } from "vitest";

import {
  computeSourceKey,
  computeStreamId,
  type SourceSnapshot,
} from "../src/auto-commit-identity.js";
import type {
  AcceptReceiptInput,
  AutoCommitStore,
  MemberMetadataUpsert,
} from "../src/auto-commit-store.js";
import { computeMemberEligibility } from "../src/auto-commit-store.js";

const NS = "https://git.example.com/org/repo";
const SCOPE = "refs/heads/main";
const T0 = 1_800_000_000_000;

export interface StoreFactory {
  readonly backendKind: string;
  makeStore(): Promise<AutoCommitStore> | AutoCommitStore;
}

function gitSnapshot(
  revision: string,
  name: string,
  email: string,
): SourceSnapshot {
  return {
    v: 1,
    vcs: "git",
    sourceNamespace: NS,
    revision,
    fields: {
      authorName: { status: "known", value: name },
      authorEmail: { status: "known", value: email },
    },
    command: "git log --format=%H%x1f%P%x1f%an%x1f%ae",
    observedAt: T0,
    rulesVersion: "rules-v1",
    sourceKey: computeSourceKey(NS, {
      vcs: "git",
      authorName: name,
      authorEmail: email,
    }),
    status: "known",
  };
}

function receiptInput(
  overrides: Partial<AcceptReceiptInput> = {},
): AcceptReceiptInput {
  return {
    deliveryKey: "gitea:delivery-1",
    workspaceId: "ws1",
    triggerName: "gitea",
    provider: "gitea",
    vcs: "git",
    sourceNamespace: NS,
    scopeRef: SCOPE,
    historyGeneration: 0,
    coverage: { kind: "range", base: "A0", head: "A3" },
    envelope: { ref: SCOPE },
    delaySeconds: 120,
    policyVersion: "pol-1",
    now: T0,
    ...overrides,
  };
}

function membersOf(
  revisions: readonly string[],
  orderStart: number,
  name = "alice",
  email = "alice@example.com",
): MemberMetadataUpsert[] {
  return revisions.map((revision, index) => ({
    revision,
    orderKey: String(orderStart + index).padStart(12, "0"),
    sourceSnapshot: gitSnapshot(revision, name, email),
  }));
}

export function runAutoCommitStoreConformance(factory: StoreFactory): void {
  async function prepareBatch(
    store: AutoCommitStore,
    batchId: string,
    workspaceId = "ws1",
  ): Promise<void> {
    const accepted = await store.acceptReceipt(
      receiptInput({
        deliveryKey: batchId,
        workspaceId,
        scopeRef: `refs/heads/${batchId}`,
        delaySeconds: 0,
      }),
    );
    const streamId = computeStreamId(accepted.receipt);
    const metadata = membersOf(["A1"], 1);
    await store.applyMetadataPage({
      streamId,
      receiptId: accepted.receipt.receiptId,
      members: metadata,
      now: T0,
    });
    const member = (await store.readPendingMembers(streamId, null, 1))
      .items[0]!;
    await store.applyExclusionVerdicts({
      streamId,
      verdicts: [
        { memberId: member.memberId, state: "allowed", policyVersion: "pol-1" },
      ],
      now: T0,
    });
    const reservation = await store.acquireStreamReservation(
      streamId,
      "scheduler",
      60_000,
      T0,
    );
    expect(reservation).toBeDefined();
    expect(
      await store.sealBatch({
        streamId,
        reservationToken: reservation!.token,
        expectedStreamVersion: reservation!.version,
        batchId,
        runId: `run-${batchId}`,
        members: [
          {
            memberId: member.memberId,
            revision: "A1",
            sourceKey: metadata[0]!.sourceSnapshot.sourceKey!,
          },
        ],
        base: "A0",
        head: "A1",
        sourceKey: metadata[0]!.sourceSnapshot.sourceKey!,
        exclusionPolicyVersion: "rules-v1",
        configPolicyVersion: "pol-1",
        maxAttempts: 2,
        now: T0,
      }),
    ).toEqual({ kind: "sealed" });
  }
  describe(`AutoCommitStore conformance [${factory.backendKind}]`, () => {
    it("enforces global and workspace execution limits atomically and releases capacity", async () => {
      const store = await factory.makeStore();
      await prepareBatch(store, "limit-a", "ws-a");
      await prepareBatch(store, "limit-b", "ws-a");
      await prepareBatch(store, "limit-c", "ws-b");
      for (const entry of await store.claimDispatch(T0, "worker", 3))
        await store.confirmDispatch(entry.batch.batchId, entry.claimToken, T0);
      const leaseA = await store.startBatchExecution(
        "limit-a",
        "a",
        1_000,
        T0,
        { global: 2, workspace: 1 },
      );
      expect(leaseA).toBeDefined();
      expect(
        await store.startBatchExecution("limit-b", "b", 1_000, T0, {
          global: 2,
          workspace: 1,
        }),
      ).toBeUndefined();
      expect(
        await store.startBatchExecution("limit-c", "c", 1_000, T0, {
          global: 1,
          workspace: 1,
        }),
      ).toBeUndefined();
      const leaseC = await store.startBatchExecution(
        "limit-c",
        "c",
        1_000,
        T0,
        { global: 2, workspace: 1 },
      );
      expect(leaseC).toBeDefined();
      await store.completeBatch(
        "limit-a",
        leaseA!,
        { outcome: "completed" },
        T0 + 1,
      );
      expect(
        await store.startBatchExecution("limit-b", "b", 1_000, T0 + 1, {
          global: 2,
          workspace: 1,
        }),
      ).toBeDefined();
    });

    it("recovers dispatch-confirmed batches without consuming an execution attempt", async () => {
      const store = await factory.makeStore();
      await prepareBatch(store, "queued-crash");
      const entry = (await store.claimDispatch(T0, "worker", 1))[0]!;
      await store.confirmDispatch(entry.batch.batchId, entry.claimToken, T0);
      const queued = await store.readBatch(entry.batch.batchId);
      expect(queued?.attempt).toBe(0);
      expect(queued?.leaseExpiry).toBeGreaterThan(T0);
      expect(
        await store.reclaimExpiredBatchLeases(queued!.leaseExpiry!, 1),
      ).toEqual([entry.batch.batchId]);
      const reclaimed = (
        await store.claimDispatch(queued!.leaseExpiry!, "restart", 1)
      )[0]!;
      await store.confirmDispatch(
        entry.batch.batchId,
        reclaimed.claimToken,
        queued!.leaseExpiry!,
      );
      expect(
        await store.startBatchExecution(
          entry.batch.batchId,
          "restart",
          1_000,
          queued!.leaseExpiry!,
        ),
      ).toBeDefined();
      expect((await store.readBatch(entry.batch.batchId))?.attempt).toBe(1);
    });

    it("fences stale result/checkpoint writes and keeps the saved result across lease recovery", async () => {
      const store = await factory.makeStore();
      await prepareBatch(store, "checkpoint");
      const entry = (await store.claimDispatch(T0, "worker", 1))[0]!;
      await store.confirmDispatch("checkpoint", entry.claimToken, T0);
      const lease = (await store.startBatchExecution(
        "checkpoint",
        "worker",
        1_000,
        T0,
      ))!;
      const checkpoint = {
        phase: "completed" as const,
        result: { summary: "saved" },
      };
      expect(
        await store.checkpointBatchExecution(
          "checkpoint",
          lease,
          checkpoint,
          T0 + 1,
        ),
      ).toBe(true);
      expect(
        await store.checkpointBatchExecution(
          "checkpoint",
          lease,
          { phase: "started" },
          T0 + 1_000,
        ),
      ).toBe(false);
      await store.completeBatch(
        "checkpoint",
        lease,
        { outcome: "completed" },
        T0 + 1_000,
      );
      await store.failBatch(
        "checkpoint",
        lease,
        "stale",
        null,
        true,
        T0 + 1_000,
      );
      expect((await store.readBatch("checkpoint"))?.status).toBe("running");
      await store.reclaimExpiredBatchLeases(T0 + 1_000, 1);
      const restored = await store.readBatch("checkpoint");
      expect(restored?.executionCheckpoint).toEqual(checkpoint);
      expect(restored?.status).toBe("retry_wait");
    });

    it("fills unavailable source evidence without erasing known fields or clearing conflicts", async () => {
      const store = await factory.makeStore();
      const accepted = await store.acceptReceipt(receiptInput());
      const streamId = computeStreamId(accepted.receipt);
      const observation = membersOf(["A1"], 1)[0]!;
      await store.applyMetadataPage({
        streamId,
        receiptId: accepted.receipt.receiptId,
        now: T0,
        members: [
          {
            ...observation,
            sourceSnapshot: {
              ...observation.sourceSnapshot,
              status: "unavailable",
              sourceKey: null,
              fields: {
                authorName: { status: "known", value: "alice" },
                authorEmail: { status: "unavailable" },
              },
            },
          },
        ],
      });
      // Complementary partial observations must form the same key as one
      // complete observation, including in Redis's atomic page update.
      await store.applyMetadataPage({
        streamId,
        receiptId: accepted.receipt.receiptId,
        now: T0 + 1,
        members: [
          {
            ...observation,
            sourceSnapshot: {
              ...observation.sourceSnapshot,
              status: "unavailable",
              sourceKey: null,
              fields: {
                authorName: { status: "unavailable" },
                authorEmail: { status: "known", value: "alice@example.com" },
              },
            },
          },
        ],
      });
      expect(
        (await store.readPendingMembers(streamId, null, 1)).items[0]
          ?.sourceSnapshot?.sourceKey,
      ).toBe(observation.sourceSnapshot.sourceKey);
      await store.applyMetadataPage({
        streamId,
        receiptId: accepted.receipt.receiptId,
        now: T0 + 2,
        members: membersOf(["A1"], 1, "bob", "alice@example.com"),
      });
      await store.applyMetadataPage({
        streamId,
        receiptId: accepted.receipt.receiptId,
        now: T0 + 3,
        members: [observation],
      });
      expect(
        (await store.readPendingMembers(streamId, null, 1)).items[0]
          ?.sourceSnapshot?.status,
      ).toBe("conflicted");
    });

    it("keeps concurrent conflicting observations and the earliest receipt's range evidence", async () => {
      const store = await factory.makeStore();
      const first = await store.acceptReceipt(receiptInput());
      const later = await store.acceptReceipt(
        receiptInput({ deliveryKey: "later-range" }),
      );
      const streamId = computeStreamId(first.receipt);
      const initial = membersOf(["A1"], 1)[0]!;
      const apply = (receiptId: string, name: string, rewrite: boolean) =>
        store.applyMetadataPage({
          streamId,
          receiptId,
          now: T0,
          members: [
            {
              ...initial,
              sourceSnapshot: {
                ...gitSnapshot("A1", name, "alice@example.com"),
                historyRewrite: rewrite,
                historyBaseRevision: rewrite ? "old-head" : "A0",
              },
            },
          ],
        });
      // Expand the later notification first, then race two observations.
      await apply(later.receipt.receiptId, "alice", true);
      await Promise.all([
        apply(first.receipt.receiptId, "alice", false),
        apply(later.receipt.receiptId, "bob", true),
      ]);
      const result = (await store.readPendingMembers(streamId, null, 1))
        .items[0]!;
      expect(result.coverReceiptId).toBe(first.receipt.receiptId);
      expect(result.sourceSnapshot?.historyRewrite).toBe(false);
      expect(result.sourceSnapshot?.historyBaseRevision).toBe("A0");
      expect(result.sourceSnapshot?.status).toBe("conflicted");
      expect(result.sourceSnapshot?.fields.authorName?.status).toBe(
        "conflicted",
      );
      expect(
        (await store.readMemberReceipts(result.memberId, null, 10)).items,
      ).toHaveLength(2);
    });

    it("accepts receipts idempotently per delivery key (Q02/N02)", async () => {
      const store = await factory.makeStore();
      const first = await store.acceptReceipt(receiptInput());
      expect(first.duplicate).toBe(false);
      expect(first.receipt.firstAcceptedAt).toBe(T0);
      expect(first.receipt.receiptSeq).toBe(1);

      const redelivered = await store.acceptReceipt(
        receiptInput({ now: T0 + 60_000 }),
      );
      expect(redelivered.duplicate).toBe(true);
      expect(redelivered.receipt.receiptId).toBe(first.receipt.receiptId);
      // Redelivery never resets the first acceptance time.
      expect(redelivered.receipt.firstAcceptedAt).toBe(T0);

      // A different delivery id covering the same range is a new receipt.
      const other = await store.acceptReceipt(
        receiptInput({ deliveryKey: "gitea:delivery-2" }),
      );
      expect(other.duplicate).toBe(false);
      expect(other.receipt.receiptSeq).toBe(2);
    });

    it("keeps the earliest covering notification's acceptance pair (N04, expansion order independent)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({
          deliveryKey: "d:N1",
          coverage: { kind: "range", base: "A0", head: "A3" },
          now: T0,
          delaySeconds: 120,
        }),
      );
      const n2 = await store.acceptReceipt(
        receiptInput({
          deliveryKey: "d:N2",
          coverage: { kind: "range", base: "A3", head: "A5" },
          now: T0 + 30_000,
          delaySeconds: 60,
        }),
      );
      // Expand N2 first: A4/A5 are created with N2's pair.
      await store.applyMetadataPage({
        streamId: computeStreamId(n1.receipt),
        receiptId: n2.receipt.receiptId,
        members: membersOf(["A4", "A5"], 4),
        now: T0 + 31_000,
      });
      // Then N1's page also covers A4/A5 via overlap plus A1–A3.
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1", "A2", "A3", "A4", "A5"], 1),
        now: T0 + 32_000,
      });
      const page = await store.readPendingMembers(streamId, null, 10);
      expect(page.items.map((member) => member.revision)).toEqual([
        "A1",
        "A2",
        "A3",
        "A4",
        "A5",
      ]);
      for (const member of page.items) {
        // N1 has the lower persistent seq → its (firstAcceptedAt, delay) governs.
        expect(member.firstAcceptedAt).toBe(T0);
        expect(member.eligibleAt).toBe(computeMemberEligibility(T0, 120));
      }
    });

    it("survives clock rollback: persistent seq, not wall time, picks the earliest notification", async () => {
      const store = await factory.makeStore();
      // N1 accepted first but with a LATER wall clock (clock jumped).
      const n1 = await store.acceptReceipt(
        receiptInput({
          deliveryKey: "d:rb-1",
          now: T0 + 90_000,
          delaySeconds: 30,
        }),
      );
      const n2 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:rb-2", now: T0, delaySeconds: 10 }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n2.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0 + 91_000,
      });
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0 + 92_000,
      });
      const page = await store.readPendingMembers(streamId, null, 10);
      // N1 has the lower receiptSeq → its (later) wall time still wins.
      expect(page.items[0]?.firstAcceptedAt).toBe(T0 + 90_000);
      expect(page.items[0]?.eligibleAt).toBe(
        computeMemberEligibility(T0 + 90_000, 30),
      );
    });

    it("marks conflicting re-observations and blocks merging (P11/S07)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:conflict" }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0,
      });
      const tampered = membersOf(["A1"], 1, "mallory", "mallory@example.com");
      const result = await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: tampered,
        now: T0 + 1000,
      });
      expect(result.conflicted).toHaveLength(1);
      const page = await store.readPendingMembers(streamId, null, 10);
      const snapshot = page.items[0]?.sourceSnapshot;
      expect(snapshot?.status).toBe("conflicted");
      expect(snapshot?.sourceKey).toBeNull();
      expect(snapshot?.fields.authorName?.status).toBe("conflicted");
      expect(snapshot?.fields.authorName?.previousValue).toBe("alice");
      expect(snapshot?.fields.authorName?.value).toBe("mallory");
    });

    it("associates terminal members idempotently without reviving them (N09/B05)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:term-1" }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0,
      });
      const member = (await store.readPendingMembers(streamId, null, 10))
        .items[0];
      expect(member).toBeDefined();

      // Seal and complete the batch containing A1.
      const reservation = await store.acquireStreamReservation(
        streamId,
        "sched-1",
        60_000,
        T0 + 130_000,
      );
      expect(reservation).toBeDefined();
      const sealed = await store.sealBatch({
        streamId,
        reservationToken: reservation?.token ?? "",
        expectedStreamVersion: reservation?.version ?? -1,
        batchId: "batch-1",
        runId: "run-1",
        members: [
          {
            memberId: member?.memberId ?? "",
            revision: "A1",
            sourceKey: member?.sourceSnapshot?.sourceKey ?? "",
          },
        ],
        base: "A0",
        head: "A1",
        sourceKey: member?.sourceSnapshot?.sourceKey ?? "",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 3,
        now: T0 + 130_000,
      });
      expect(sealed.kind).toBe("sealed");
      await dispatchOnce(store, T0 + 131_000);
      const token = await store.startBatchExecution(
        "batch-1",
        "worker-1",
        60_000,
        T0 + 132_000,
      );
      expect(token).toBeDefined();
      await store.completeBatch(
        "batch-1",
        token ?? "",
        { outcome: "completed" },
        T0 + 133_000,
      );

      // A later notification re-covers A1 and adds A2.
      const n2 = await store.acceptReceipt(
        receiptInput({
          deliveryKey: "d:term-2",
          coverage: { kind: "range", base: "A0", head: "A2" },
          now: T0 + 140_000,
        }),
      );
      await store.applyMetadataPage({
        streamId,
        receiptId: n2.receipt.receiptId,
        members: membersOf(["A1", "A2"], 1),
        now: T0 + 141_000,
      });
      const receiptView = await store.getReceipt(n1.receipt.receiptId);
      expect(receiptView?.memberCounts.completed).toBe(1);
      const pending = await store.readPendingMembers(streamId, null, 10);
      expect(pending.items.map((member) => member.revision)).toEqual(["A2"]);
      // The completed A1 keeps its original batch; association is queryable.
      const a1Receipts = await store.readMemberReceipts(
        (
          await store.readReceiptMembers(n2.receipt.receiptId, null, 10)
        ).items.find((m) => m.revision === "A1")?.memberId ?? "",
        null,
        10,
      );
      expect(a1Receipts.items).toContain(n1.receipt.receiptId);
      expect(a1Receipts.items).toContain(n2.receipt.receiptId);
    });

    it("serializes reservations and rejects stale seals (Q04)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:race" }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0,
      });

      const first = await store.acquireStreamReservation(
        streamId,
        "consumer-a",
        60_000,
        T0 + 130_000,
      );
      const second = await store.acquireStreamReservation(
        streamId,
        "consumer-b",
        60_000,
        T0 + 130_000,
      );
      expect(first).toBeDefined();
      expect(second).toBeUndefined();

      const member = (await store.readPendingMembers(streamId, null, 10))
        .items[0];
      const stale = await store.sealBatch({
        streamId,
        reservationToken: "bogus-token",
        expectedStreamVersion: first?.version ?? -1,
        batchId: "batch-x",
        runId: "run-x",
        members: [
          { memberId: member?.memberId ?? "", revision: "A1", sourceKey: "k" },
        ],
        base: "A0",
        head: "A1",
        sourceKey: "k",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 3,
        now: T0 + 130_000,
      });
      expect(stale.kind).toBe("conflict");
      expect(stale.kind === "conflict" ? stale.reason : "").toBe(
        "reservation_lost",
      );

      const wrongVersion = await store.sealBatch({
        streamId,
        reservationToken: first?.token ?? "",
        expectedStreamVersion: (first?.version ?? 0) + 99,
        batchId: "batch-x",
        runId: "run-x",
        members: [
          { memberId: member?.memberId ?? "", revision: "A1", sourceKey: "k" },
        ],
        base: "A0",
        head: "A1",
        sourceKey: "k",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 3,
        now: T0 + 130_000,
      });
      expect(wrongVersion.kind).toBe("conflict");
      expect(wrongVersion.kind === "conflict" ? wrongVersion.reason : "").toBe(
        "stream_version_mismatch",
      );
    });

    it("rejects sealing ineligible or already-batched members (T03/B07)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:elig", delaySeconds: 120 }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1", "A2"], 1),
        now: T0,
      });
      const members = (await store.readPendingMembers(streamId, null, 10))
        .items;

      // Before eligibility: sealing fails per-member.
      const reservation = await store.acquireStreamReservation(
        streamId,
        "sched",
        60_000,
        T0 + 60_000,
      );
      const early = await store.sealBatch({
        streamId,
        reservationToken: reservation?.token ?? "",
        expectedStreamVersion: reservation?.version ?? -1,
        batchId: "batch-e",
        runId: "run-e",
        members: members.map((member) => ({
          memberId: member.memberId,
          revision: member.revision,
          sourceKey: "k",
        })),
        base: "A0",
        head: "A2",
        sourceKey: "k",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 3,
        now: T0 + 60_000,
      });
      expect(early.kind).toBe("conflict");
      expect(early.kind === "conflict" ? early.reason : "").toBe(
        "member_ineligible",
      );

      // After eligibility: seal A1 only; A2 remains pending for a later batch.
      await store.releaseStreamReservation(
        streamId,
        reservation?.token ?? "",
        T0 + 60_000,
      );
      const reservation2 = await store.acquireStreamReservation(
        streamId,
        "sched",
        60_000,
        T0 + 121_000,
      );
      const sealed = await store.sealBatch({
        streamId,
        reservationToken: reservation2?.token ?? "",
        expectedStreamVersion: reservation2?.version ?? -1,
        batchId: "batch-a1",
        runId: "run-a1",
        members: [
          {
            memberId: members[0]?.memberId ?? "",
            revision: "A1",
            sourceKey: "k",
          },
        ],
        base: "A0",
        head: "A1",
        sourceKey: "k",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 3,
        now: T0 + 121_000,
      });
      expect(sealed.kind).toBe("sealed");
      // The stream has an active batch: no new reservation/seal until it ends.
      expect(
        await store.acquireStreamReservation(
          streamId,
          "sched",
          60_000,
          T0 + 122_000,
        ),
      ).toBeUndefined();
      const secondSeal = await store.sealBatch({
        streamId,
        reservationToken: reservation2?.token ?? "",
        expectedStreamVersion: reservation2?.version ?? -1,
        batchId: "batch-a2",
        runId: "run-a2",
        members: [
          {
            memberId: members[1]?.memberId ?? "",
            revision: "A2",
            sourceKey: "k",
          },
        ],
        base: "A1",
        head: "A2",
        sourceKey: "k",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 3,
        now: T0 + 122_000,
      });
      expect(secondSeal.kind).toBe("conflict");
    });

    it("records exclusions as skipped separators with no run/job/outbox (X13/X16)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:excl" }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: [
          ...membersOf(["A1"], 1),
          ...membersOf(["X"], 2, "ci-bot", "ci-bot@example.com"),
          ...membersOf(["A2"], 3),
        ],
        now: T0,
      });
      const members = (await store.readPendingMembers(streamId, null, 10))
        .items;
      const x = members.find((member) => member.revision === "X");
      await store.applyExclusionVerdicts({
        streamId,
        verdicts: [
          {
            memberId: members[0]?.memberId ?? "",
            state: "allowed",
            policyVersion: "pol-1",
          },
          {
            memberId: x?.memberId ?? "",
            state: "excluded",
            ruleId: "bot-rule",
            policyVersion: "pol-1",
          },
          {
            memberId: members[2]?.memberId ?? "",
            state: "allowed",
            policyVersion: "pol-1",
          },
        ],
        now: T0 + 1000,
      });
      const view = await store.getReceipt(n1.receipt.receiptId);
      expect(view?.memberCounts.skipped).toBe(1);
      // Only A1/A2 stay pending; X is a durable separator with evidence.
      const pending = await store.readPendingMembers(streamId, null, 10);
      expect(pending.items.map((member) => member.revision)).toEqual([
        "A1",
        "A2",
      ]);
      const skippedMember = (
        await store.readReceiptMembers(n1.receipt.receiptId, null, 10)
      ).items.find((member) => member.revision === "X");
      expect(skippedMember?.status).toBe("skipped");
      expect(skippedMember?.terminalReason).toBe("excluded_source");
      expect(skippedMember?.exclusion.ruleId).toBe("bot-rule");
    });

    it("runs the dispatch → execution → completion lifecycle with lease checks (Q11/Q12)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:life" }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0,
      });
      const member = (await store.readPendingMembers(streamId, null, 10))
        .items[0];
      const reservation = await store.acquireStreamReservation(
        streamId,
        "sched",
        60_000,
        T0 + 130_000,
      );
      await store.sealBatch({
        streamId,
        reservationToken: reservation?.token ?? "",
        expectedStreamVersion: reservation?.version ?? -1,
        batchId: "batch-l",
        runId: "run-l",
        members: [
          { memberId: member?.memberId ?? "", revision: "A1", sourceKey: "k" },
        ],
        base: "A0",
        head: "A1",
        sourceKey: "k",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 2,
        now: T0 + 130_000,
      });

      // Dispatch claim → confirm.
      const claimed = await store.claimDispatch(T0 + 130_000, "dispatcher", 10);
      expect(claimed).toHaveLength(1);
      await store.confirmDispatch(
        "batch-l",
        claimed[0]?.claimToken ?? "",
        T0 + 130_100,
      );
      expect((await store.readBatch("batch-l"))?.status).toBe("queued");

      // Execution lease; renew extends; expired-then-reclaimed rejects the old token.
      const token = await store.startBatchExecution(
        "batch-l",
        "worker-1",
        10_000,
        T0 + 131_000,
      );
      expect(token).toBeDefined();
      expect((await store.readBatch("batch-l"))?.attempt).toBe(1);
      expect(
        await store.renewBatchLease(
          "batch-l",
          token ?? "",
          10_000,
          T0 + 135_000,
        ),
      ).toBe(true);
      const reclaimed = await store.reclaimExpiredBatchLeases(T0 + 200_000, 10);
      expect(reclaimed).toEqual(["batch-l"]);
      expect(
        await store.renewBatchLease(
          "batch-l",
          token ?? "",
          10_000,
          T0 + 200_001,
        ),
      ).toBe(false);
      await store.completeBatch(
        "batch-l",
        token ?? "",
        { outcome: "completed" },
        T0 + 200_001,
      );
      expect((await store.readBatch("batch-l"))?.status).toBe("retry_wait");

      // Re-claim from the outbox created by reclaim and finish.
      const reclaimedDispatch = await store.claimDispatch(
        T0 + 200_001,
        "dispatcher",
        10,
      );
      expect(reclaimedDispatch).toHaveLength(1);
      await store.confirmDispatch(
        "batch-l",
        reclaimedDispatch[0]?.claimToken ?? "",
        T0 + 200_002,
      );
      const token2 = await store.startBatchExecution(
        "batch-l",
        "worker-2",
        10_000,
        T0 + 200_003,
      );
      expect(token2).toBeDefined();
      expect((await store.readBatch("batch-l"))?.attempt).toBe(2);
      await store.completeBatch(
        "batch-l",
        token2 ?? "",
        { outcome: "completed" },
        T0 + 200_004,
      );
      const done = await store.readBatch("batch-l");
      expect(done?.status).toBe("completed");
      const receiptView = await store.getReceipt(n1.receipt.receiptId);
      expect(receiptView?.memberCounts.completed).toBe(1);
      expect((await store.readStreamHead(streamId))?.activeBatchId).toBeNull();
    });

    it("fails with batch-level retry and ends dead after maxAttempts (Q14)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:retry" }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0,
      });
      const member = (await store.readPendingMembers(streamId, null, 10))
        .items[0];
      const reservation = await store.acquireStreamReservation(
        streamId,
        "sched",
        60_000,
        T0 + 130_000,
      );
      await store.sealBatch({
        streamId,
        reservationToken: reservation?.token ?? "",
        expectedStreamVersion: reservation?.version ?? -1,
        batchId: "batch-r",
        runId: "run-r",
        members: [
          { memberId: member?.memberId ?? "", revision: "A1", sourceKey: "k" },
        ],
        base: "A0",
        head: "A1",
        sourceKey: "k",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 2,
        now: T0 + 130_000,
      });

      await dispatchOnce(store, T0 + 130_000);
      const token = await store.startBatchExecution(
        "batch-r",
        "w",
        60_000,
        T0 + 131_000,
      );
      const retryAt = T0 + 200_000;
      await store.failBatch(
        "batch-r",
        token ?? "",
        "transient-io",
        retryAt,
        false,
        T0 + 132_000,
      );
      expect((await store.readBatch("batch-r"))?.status).toBe("retry_wait");
      // Not claimable before retryNotBefore.
      expect(
        await store.claimDispatch(T0 + 150_000, "dispatcher", 10),
      ).toHaveLength(0);
      const retryClaim = await store.claimDispatch(retryAt, "dispatcher", 10);
      expect(retryClaim).toHaveLength(1);
      await store.confirmDispatch(
        "batch-r",
        retryClaim[0]?.claimToken ?? "",
        retryAt,
      );

      // Second attempt dies → dead, members dead, stream stays for manual handling.
      const token2 = await store.startBatchExecution(
        "batch-r",
        "w",
        60_000,
        retryAt + 1000,
      );
      await store.failBatch(
        "batch-r",
        token2 ?? "",
        "transient-io",
        null,
        false,
        retryAt + 2000,
      );
      const deadBatch = await store.readBatch("batch-r");
      expect(deadBatch?.status).toBe("dead");
      const view = await store.getReceipt(n1.receipt.receiptId);
      expect(view?.memberCounts.dead).toBe(1);
      expect((await store.readStreamHead(streamId))?.activeBatchId).toBe(
        "batch-r",
      );
    });

    it("reports the earliest scheduling signal across heads, outbox, and leases", async () => {
      const store = await factory.makeStore();
      expect(await store.readNextWake()).toBeUndefined();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:wake", delaySeconds: 120 }),
      );
      const wake = await store.readNextWake();
      expect(wake?.at).toBe(computeMemberEligibility(T0, 120));
      expect(wake?.reason).toBe("delay");

      // A pending outbox entry earlier than the head wins.
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0,
      });
      const expandedHead = await store.readStreamHead(streamId);
      await store.updateStreamHead(
        streamId,
        expandedHead?.version ?? -1,
        { coverageCursor: 1, notBefore: null },
        T0,
      );
      const member = (await store.readPendingMembers(streamId, null, 10))
        .items[0];
      const reservation = await store.acquireStreamReservation(
        streamId,
        "sched",
        60_000,
        T0 + 121_000,
      );
      await store.sealBatch({
        streamId,
        reservationToken: reservation?.token ?? "",
        expectedStreamVersion: reservation?.version ?? -1,
        batchId: "batch-w",
        runId: "run-w",
        members: [
          { memberId: member?.memberId ?? "", revision: "A1", sourceKey: "k" },
        ],
        base: "A0",
        head: "A1",
        sourceKey: "k",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 1,
        now: T0 + 121_000,
      });
      expect((await store.readNextWake())?.reason).toBe("outbox_dispatch");
    });

    it("rotates workspace fairness after consuming a prepare slot (Q07)", async () => {
      const store = await factory.makeStore();
      await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:fair-1", workspaceId: "ws-a" }),
      );
      await store.acceptReceipt(
        receiptInput({
          deliveryKey: "d:fair-2",
          workspaceId: "ws-b",
          now: T0 + 1000,
        }),
      );
      const first = await store.readRunnableWorkspaceHeads(T0 + 121_000, 10);
      expect(first.map((head) => head.workspaceId)).toEqual(["ws-a", "ws-b"]);
      await store.rotateWorkspaceFairness("ws-a", T0 + 122_000);
      const second = await store.readRunnableWorkspaceHeads(T0 + 122_000, 10);
      expect(second.map((head) => head.workspaceId)).toEqual(["ws-b", "ws-a"]);
    });

    it("bounds pending member reads by page and keeps VCS order (B09/F04)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:pages" }),
      );
      const streamId = computeStreamId(n1.receipt);
      const revisions = Array.from(
        { length: 10 },
        (_, index) => `C${index + 1}`,
      );
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(revisions, 1),
        now: T0,
      });
      const page1 = await store.readPendingMembers(streamId, null, 4);
      expect(page1.items.map((member) => member.revision)).toEqual([
        "C1",
        "C2",
        "C3",
        "C4",
      ]);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await store.readPendingMembers(
        streamId,
        page1.nextCursor,
        4,
      );
      expect(page2.items.map((member) => member.revision)).toEqual([
        "C5",
        "C6",
        "C7",
        "C8",
      ]);
      const page3 = await store.readPendingMembers(
        streamId,
        page2.nextCursor,
        4,
      );
      expect(page3.items.map((member) => member.revision)).toEqual([
        "C9",
        "C10",
      ]);
      expect(page3.nextCursor).toBeNull();
    });

    it("reads stream receipts within an assembly cut (§5.2.1)", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:cut-1" }),
      );
      await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:cut-2", now: T0 + 1000 }),
      );
      await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:cut-3", now: T0 + 2000 }),
      );
      const streamId = computeStreamId(n1.receipt);
      const cut = await store.readStreamReceipts(streamId, 0, 2, 10);
      expect(cut.map((receipt) => receipt.deliveryKey)).toEqual([
        "d:cut-1",
        "d:cut-2",
      ]);
      const later = await store.readStreamReceipts(streamId, 2, 3, 10);
      expect(later.map((receipt) => receipt.deliveryKey)).toEqual(["d:cut-3"]);
    });

    it("round-trips the receipt metadata resume cursor (N05/N08)", async () => {
      const store = await factory.makeStore();
      const accepted = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:cursor-1" }),
      );
      const receiptId = accepted.receipt.receiptId;
      expect(accepted.receipt.metadataCursor).toBeNull();

      await store.setReceiptMetadataCursor(receiptId, "page-3", T0 + 10);
      expect((await store.getReceipt(receiptId))?.receipt.metadataCursor).toBe(
        "page-3",
      );

      await store.setReceiptMetadataCursor(receiptId, null, T0 + 20);
      expect(
        (await store.getReceipt(receiptId))?.receipt.metadataCursor,
      ).toBeNull();

      await expect(
        store.setReceiptMetadataCursor("missing-receipt", "x", T0),
      ).rejects.toThrow(RangeError);
    });

    it("accounts metadata failures durably and stops terminal receipts from waking the stream", async () => {
      const store = await factory.makeStore();
      const accepted = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:meta-fail" }),
      );
      const receiptId = accepted.receipt.receiptId;
      const streamId = computeStreamId(accepted.receipt);
      expect(accepted.receipt.metadataAttempts).toBe(0);
      expect(accepted.receipt.metadataTerminalError).toBeNull();

      // Transient failure: bounded retry wake at max(eligibility, retryAt).
      const retryAt = T0 + 300_000;
      await store.recordReceiptMetadataFailure(
        receiptId,
        "vcs-timeout",
        retryAt,
        T0 + 1000,
      );
      let view = (await store.getReceipt(receiptId))?.receipt;
      expect(view?.metadataAttempts).toBe(1);
      expect(view?.metadataNextAttemptAt).toBe(retryAt);
      expect(view?.metadataTerminalError).toBeNull();
      expect((await store.readStreamHead(streamId))?.notBefore).toBe(retryAt);

      // Progress clears the retry wake; the normal delay bound applies again.
      await store.setReceiptMetadataCursor(receiptId, "page-1", T0 + 2000);
      view = (await store.getReceipt(receiptId))?.receipt;
      expect(view?.metadataNextAttemptAt).toBeNull();
      expect((await store.readStreamHead(streamId))?.notBefore).toBe(
        T0 + 120_000,
      );

      // Terminal failure: recorded with the reason, no longer wakes the stream.
      await store.recordReceiptMetadataFailure(
        receiptId,
        "metadata-unreadable",
        null,
        T0 + 3000,
      );
      view = (await store.getReceipt(receiptId))?.receipt;
      expect(view?.metadataAttempts).toBe(2);
      expect(view?.metadataNextAttemptAt).toBeNull();
      expect(view?.metadataTerminalError).toBe("metadata-unreadable");
      expect((await store.readStreamHead(streamId))?.notBefore).toBeNull();

      await expect(
        store.recordReceiptMetadataFailure("missing-receipt", "x", null, T0),
      ).rejects.toThrow(RangeError);
    });

    it("reads members by id preserving request order and omitting unknowns", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:read-members" }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1", "A2"], 1),
        now: T0,
      });
      const pending = await store.readPendingMembers(streamId, null, 10);
      const [m1, m2] = pending.items.map((member) => member.memberId);
      const ordered = await store.readMembers([
        m2 ?? "",
        m1 ?? "",
        "unknown-member",
      ]);
      expect(ordered.map((member) => member.memberId)).toEqual([m2, m1]);
      await expect(
        store.readMembers(
          Array.from({ length: 513 }, (_, index) => `m-${index}`),
        ),
      ).rejects.toThrow(RangeError);
    });

    it("defers a queued batch without consuming an attempt and leaves running batches untouched", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:defer" }),
      );
      const streamId = computeStreamId(n1.receipt);
      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0,
      });
      const member = (await store.readPendingMembers(streamId, null, 10))
        .items[0];
      const reservation = await store.acquireStreamReservation(
        streamId,
        "sched",
        60_000,
        T0 + 130_000,
      );
      await store.sealBatch({
        streamId,
        reservationToken: reservation?.token ?? "",
        expectedStreamVersion: reservation?.version ?? -1,
        batchId: "batch-d",
        runId: "run-d",
        members: [
          { memberId: member?.memberId ?? "", revision: "A1", sourceKey: "k" },
        ],
        base: "A0",
        head: "A1",
        sourceKey: "k",
        exclusionPolicyVersion: "pol-1",
        configPolicyVersion: "pol-1",
        maxAttempts: 2,
        now: T0 + 130_000,
      });
      await dispatchOnce(store, T0 + 130_000);
      expect((await store.readBatch("batch-d"))?.status).toBe("queued");

      // Schedule window closed: requeue to the next allowed instant; no
      // attempt is consumed and the outbox holds the deferred wake.
      const nextWindow = T0 + 400_000;
      await store.deferBatchExecution("batch-d", nextWindow, T0 + 131_000);
      const deferred = await store.readBatch("batch-d");
      expect(deferred?.status).toBe("retry_wait");
      expect(deferred?.attempt).toBe(0);
      expect(deferred?.retryNotBefore).toBe(nextWindow);
      expect(
        await store.claimDispatch(T0 + 200_000, "dispatcher", 10),
      ).toHaveLength(0);
      const claim = await store.claimDispatch(nextWindow, "dispatcher", 10);
      expect(claim).toHaveLength(1);
      await store.confirmDispatch(
        "batch-d",
        claim[0]?.claimToken ?? "",
        nextWindow,
      );
      const token = await store.startBatchExecution(
        "batch-d",
        "w",
        60_000,
        nextWindow + 1000,
      );
      expect(token).toBeDefined();
      expect((await store.readBatch("batch-d"))?.attempt).toBe(1);

      // Running batches are not deferrable.
      await store.deferBatchExecution(
        "batch-d",
        nextWindow + 60_000,
        nextWindow + 2000,
      );
      expect((await store.readBatch("batch-d"))?.status).toBe("running");
    });

    it("persists the assembly cut and applies the resume floor on head recomputation", async () => {
      const store = await factory.makeStore();
      const n1 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:floor-1" }),
      );
      const streamId = computeStreamId(n1.receipt);
      const n2 = await store.acceptReceipt(
        receiptInput({ deliveryKey: "d:floor-2", now: T0 + 1000 }),
      );
      expect(n2.receipt.receiptSeq).toBe(2);
      const headAfterAccepts = await store.readStreamHead(streamId);
      expect(headAfterAccepts?.latestReceiptSeq).toBe(2);

      await store.applyMetadataPage({
        streamId,
        receiptId: n1.receipt.receiptId,
        members: membersOf(["A1"], 1),
        now: T0,
      });
      const floorAt = T0 + 500_000;
      const head = await store.readStreamHead(streamId);
      const updated = await store.updateStreamHead(
        streamId,
        head?.version ?? -1,
        { resumeNotBefore: floorAt, assemblyCutSeq: 2, assemblyAt: T0 + 2000 },
        T0 + 2000,
      );
      expect(updated).toBe(true);
      const gated = await store.readStreamHead(streamId);
      expect(gated?.assemblyCutSeq).toBe(2);
      expect(gated?.assemblyAt).toBe(T0 + 2000);
      expect(gated?.resumeNotBefore).toBe(floorAt);
      // Pending work is due earlier, but the floor holds the wake back.
      expect(gated?.notBefore).toBe(floorAt);

      // A later component-driven recompute keeps the floor instead of
      // reverting to the raw member eligibility.
      await store.applyMetadataPage({
        streamId,
        receiptId: n2.receipt.receiptId,
        members: membersOf(["A2"], 2),
        now: T0 + 3000,
      });
      expect((await store.readStreamHead(streamId))?.notBefore).toBe(floorAt);
    });

    it("accepts routing receipts idempotently per routing key (W14)", async () => {
      const store = await factory.makeStore();
      const first = await store.acceptRoutingReceipt({
        routingKey: "p4:delivery-1",
        provider: "p4",
        triggerName: "p4-main",
        envelope: { change: "12345" },
        parentDeliveryId: "delivery-1",
        now: T0,
      });
      expect(first.duplicate).toBe(false);
      expect(first.receipt.firstAcceptedAt).toBe(T0);
      expect(first.receipt.attempts).toBe(0);
      expect(first.receipt.convertedReceiptIds).toEqual([]);
      expect(first.receipt.completedAt).toBeNull();

      const replay = await store.acceptRoutingReceipt({
        routingKey: "p4:delivery-1",
        provider: "p4",
        triggerName: "p4-main",
        envelope: { change: "12345" },
        now: T0 + 60_000,
      });
      expect(replay.duplicate).toBe(true);
      expect(replay.receipt.routingId).toBe(first.receipt.routingId);
      expect(replay.receipt.firstAcceptedAt).toBe(T0);

      const other = await store.acceptRoutingReceipt({
        routingKey: "p4:delivery-2",
        provider: "p4",
        triggerName: "p4-main",
        envelope: { change: "12346" },
        now: T0,
      });
      expect(other.duplicate).toBe(false);
      expect(other.receipt.routingId).not.toBe(first.receipt.routingId);

      // Single-record reads: any state, unknown ids miss cleanly.
      const fetched = await store.getRoutingReceipt(first.receipt.routingId);
      expect(fetched?.routingKey).toBe("p4:delivery-1");
      expect(fetched?.firstAcceptedAt).toBe(T0);
      expect(await store.getRoutingReceipt("routing-missing")).toBeUndefined();
    });

    it("includes pending routing retries in durable wake selection", async () => {
      const store = await factory.makeStore();
      const later = await store.acceptRoutingReceipt({ routingKey: "routing-later", provider: "p4", triggerName: "p4", envelope: { revision: "2" }, now: T0 + 10 });
      const earlier = await store.acceptRoutingReceipt({ routingKey: "routing-earlier", provider: "p4", triggerName: "p4", envelope: { revision: "1" }, now: T0 });
      expect((await store.readDueRoutingReceipts(T0 + 10, 1))[0]?.routingId).toBe(earlier.receipt.routingId);
      expect(await store.readNextWake()).toEqual({ at: T0, reason: "routing_resolution" });
      await store.recordRoutingReceiptFailure(earlier.receipt.routingId, "retry", T0 + 1000);
      expect(await store.readNextWake()).toEqual({ at: T0 + 10, reason: "routing_resolution" });
      await store.recordRoutingReceiptConversion(later.receipt.routingId, { complete: true }, T0 + 20);
      expect(await store.readNextWake()).toEqual({ at: T0 + 1000, reason: "routing_resolution" });
      await store.recordRoutingReceiptFailure(earlier.receipt.routingId, "terminal", null);
      expect(await store.readNextWake()).toBeUndefined();
    });

    it("schedules routing resolution with durable backoff and terminal failure (V08)", async () => {
      const store = await factory.makeStore();
      const accepted = await store.acceptRoutingReceipt({
        routingKey: "svn:delivery-1",
        provider: "svn",
        triggerName: "svn-main",
        envelope: { revision: "42" },
        now: T0,
      });
      const id = accepted.receipt.routingId;
      expect((await store.readDueRoutingReceipts(T0, 10)).map((r) => r.routingId)).toContain(id);

      // Backoff: not due before the retry instant, due again at it.
      await store.recordRoutingReceiptFailure(id, "svn info timed out", T0 + 5000);
      expect(await store.readDueRoutingReceipts(T0 + 4000, 10)).toEqual([]);
      expect((await store.readDueRoutingReceipts(T0 + 5000, 10)).map((r) => r.routingId)).toContain(id);
      const retried = (await store.readDueRoutingReceipts(T0 + 5000, 10)).find((r) => r.routingId === id);
      expect(retried?.attempts).toBe(1);
      expect(retried?.terminalError).toBeNull();

      // Terminal failure leaves the due set forever but keeps the record.
      await store.recordRoutingReceiptFailure(id, "svn info conflict", null);
      expect(await store.readDueRoutingReceipts(T0 + 60_000, 10)).toEqual([]);
      const terminal = await store.getRoutingReceipt(id);
      expect(terminal?.terminalError).toBe("svn info conflict");
      expect(terminal?.completedAt).toBeNull();
    });

    it("records routing conversions idempotently and completes exactly once (W14)", async () => {
      const store = await factory.makeStore();
      const accepted = await store.acceptRoutingReceipt({
        routingKey: "p4:delivery-9",
        provider: "p4",
        triggerName: "p4-main",
        envelope: { change: "99" },
        parentDeliveryId: "delivery-9",
        now: T0,
      });
      const id = accepted.receipt.routingId;

      const step1 = await store.recordRoutingReceiptConversion(id, { addedReceiptIds: ["r-1"] }, T0 + 1);
      expect(step1.convertedReceiptIds).toEqual(["r-1"]);
      expect(step1.completedAt).toBeNull();
      expect((await store.readDueRoutingReceipts(T0 + 1, 10)).map((r) => r.routingId)).toContain(id);

      // Crash-and-rerun: the same conversion adds nothing twice.
      const step2 = await store.recordRoutingReceiptConversion(id, { addedReceiptIds: ["r-1", "r-2"] }, T0 + 2);
      expect(step2.convertedReceiptIds).toEqual(["r-1", "r-2"]);

      const done = await store.recordRoutingReceiptConversion(id, { complete: true, note: "resolved" }, T0 + 3);
      expect(done.completedAt).toBe(T0 + 3);
      expect(done.note).toBe("resolved");
      expect(await store.readDueRoutingReceipts(T0 + 60_000, 10)).toEqual([]);

      // Late duplicate completion keeps the original timestamp.
      const again = await store.recordRoutingReceiptConversion(id, { complete: true }, T0 + 99_999);
      expect(again.completedAt).toBe(T0 + 3);
    });

    it("freezes the routing interpretation once: later writes never overwrite (V14)", async () => {
      const store = await factory.makeStore();
      const accepted = await store.acceptRoutingReceipt({
        routingKey: "p4:delivery-77",
        provider: "p4",
        triggerName: "p4-main",
        envelope: { revision: "100" },
        now: T0,
      });
      const id = accepted.receipt.routingId;
      expect(accepted.receipt.resolution).toBeNull();

      const first = await store.recordRoutingReceiptResolution(id, [
        { repoRef: "//depot/a", outcome: "match", resolution: { kind: "match", definitionId: "ws-a" } },
        { repoRef: "//depot/b", outcome: "no_match", note: "no match rule" },
      ], T0 + 1);
      expect(first.resolution).toHaveLength(2);

      // A retried/concurrent interpretation under changed config must not win.
      const second = await store.recordRoutingReceiptResolution(id, [
        { repoRef: "//depot/a", outcome: "no_match", note: "config changed" },
      ], T0 + 2);
      expect(second.resolution).toEqual(first.resolution);
      expect((await store.getRoutingReceipt(id))?.resolution).toEqual(first.resolution);
    });

    it("preserves an empty frozen interpretation through retries and duplicate intake (V14)", async () => {
      const store = await factory.makeStore();
      const input = { routingKey: "svn:empty-scopes", provider: "svn", triggerName: "svn", envelope: { revision: "42" }, now: T0 };
      const accepted = await store.acceptRoutingReceipt(input);
      const id = accepted.receipt.routingId;
      const frozen = await store.recordRoutingReceiptResolution(id, [], T0 + 1);
      expect(frozen.resolution).toEqual([]);
      expect(frozen.convertedReceiptIds).toEqual([]);
      await store.recordRoutingReceiptFailure(id, "retry conversion", T0 + 2);
      expect((await store.readDueRoutingReceipts(T0 + 2, 10))[0]?.resolution).toEqual([]);
      expect((await store.acceptRoutingReceipt(input)).receipt.resolution).toEqual([]);
      expect((await store.recordRoutingReceiptResolution(id, [{ repoRef: "changed", outcome: "no_match" }], T0 + 3)).resolution).toEqual([]);
      expect((await store.recordRoutingReceiptConversion(id, { complete: true }, T0 + 4)).resolution).toEqual([]);
      expect((await store.getRoutingReceipt(id))?.convertedReceiptIds).toEqual([]);
    });

    it("freezes the admission resolution snapshot on receipts (V14)", async () => {
      const store = await factory.makeStore();
      const resolution = { kind: "match", definitionId: "ws1", binding: { definitionId: "ws1", instanceId: "instance-original", workPath: "old-path" },
        variables: { source: { project_key: "p4:server:scope" }, p4: { user: "submitter", stream: null } },
        provenance: { "p4.user": "vcs_verified", "p4.stream": "unavailable" } } as const;
      const accepted = await store.acceptReceipt(receiptInput({ resolution }));
      expect(accepted.receipt.resolution).toEqual(resolution);

      // Replay with a different resolution keeps the frozen original.
      const replay = await store.acceptReceipt(
        receiptInput({ resolution: { kind: "legacy_binding", definitionId: "other" }, now: T0 + 60_000 }),
      );
      expect(replay.duplicate).toBe(true);
      expect(replay.receipt.resolution).toEqual(resolution);

      // Legacy accepts without a resolution read as null (recompute fallback).
      const legacy = await store.acceptReceipt(receiptInput({ deliveryKey: "gitea:delivery-2" }));
      expect(legacy.receipt.resolution).toBeNull();
    });
  });
}

async function dispatchOnce(
  store: AutoCommitStore,
  now: number,
): Promise<void> {
  const claimed = await store.claimDispatch(now, "dispatcher", 10);
  for (const claim of claimed) {
    await store.confirmDispatch(claim.batch.batchId, claim.claimToken, now);
  }
}
