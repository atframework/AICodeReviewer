import { describe, expect, it } from "vitest";

import {
  AUTO_COMMIT_MAX_BATCH_MEMBERS,
  cutAutoCommitBatches,
  type AssemblyCandidate,
} from "../src/auto-commit-assembly.js";

const T0 = 1_700_000_000_000;

let orderCounter = 0;
function member(partial: Partial<AssemblyCandidate> & { readonly memberId: string }): AssemblyCandidate {
  orderCounter += 1;
  return {
    revision: partial.memberId,
    orderKey: String(orderCounter).padStart(12, "0"),
    parents: [],
    sourceKey: "v1|git|alice|alice@example.com",
    sourceStatus: "known",
    eligibleAt: T0,
    ...partial,
  };
}

describe("cutAutoCommitBatches", () => {
  it("cuts interleaved sources by true VCS order: A1 A2 B1 A3", () => {
    orderCounter = 0;
    const a1 = member({ memberId: "A1" });
    const a2 = member({ memberId: "A2" });
    const b1 = member({ memberId: "B1", sourceKey: "v1|git|bob|bob@example.com" });
    const a3 = member({ memberId: "A3" });
    const result = cutAutoCommitBatches([a1, a2, b1, a3], T0 + 1);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["A1", "A2"], ["B1"], ["A3"]]);
    expect(result.ready[0]?.reason).toBe("same_source_run");
    expect(result.ready[0]?.baseRevision).toBe("A1");
    expect(result.ready[0]?.headRevision).toBe("A2");
  });

  it("treats an excluded member's order-key gap as a hard separator", () => {
    orderCounter = 0;
    const a1 = member({ memberId: "A1" });
    const a2 = member({ memberId: "A2" });
    // B1 was excluded -> no longer pending -> its orderKey slot is missing.
    orderCounter += 1;
    const a3 = member({ memberId: "A3" });
    const result = cutAutoCommitBatches([a1, a2, a3], T0 + 1);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["A1", "A2"], ["A3"]]);
  });

  it("merges contiguous same-source members across receipts", () => {
    orderCounter = 0;
    // Contiguity comes from order keys; receipt boundaries are invisible here
    // by design (stream is the scheduling unit, not the notification).
    const a1 = member({ memberId: "A1" });
    const a2 = member({ memberId: "A2" });
    const a3 = member({ memberId: "A3" });
    const result = cutAutoCommitBatches([a1, a2, a3], T0 + 1);
    expect(result.ready).toHaveLength(1);
    expect(result.ready[0]?.memberIds).toEqual(["A1", "A2", "A3"]);
  });

  it("isolates a merge commit into its own batch with parents preserved", () => {
    orderCounter = 0;
    const a1 = member({ memberId: "A1" });
    const merge = member({ memberId: "M1", parents: ["A1", "B1"] });
    const a2 = member({ memberId: "A2" });
    const result = cutAutoCommitBatches([a1, merge, a2], T0 + 1);
    expect(result.ready.map((cut) => [cut.reason, cut.memberIds])).toEqual([
      ["same_source_run", ["A1"]],
      ["merge_commit", ["M1"]],
      ["same_source_run", ["A2"]],
    ]);
  });

  it("isolates rewrite events per receipt and never merges across them", () => {
    orderCounter = 0;
    const a1 = member({ memberId: "A1" });
    const r1 = member({ memberId: "R1", rewriteReceiptId: "receipt-1", sourceKey: "v1|git|bob|bob@example.com" });
    const r2 = member({ memberId: "R2", rewriteReceiptId: "receipt-1", sourceKey: "v1|git|carl|carl@example.com" });
    const r3 = member({ memberId: "R3", rewriteReceiptId: "receipt-2" });
    const result = cutAutoCommitBatches([a1, r1, r2, r3], T0 + 1);
    expect(result.ready.map((cut) => [cut.reason, cut.memberIds])).toEqual([
      ["same_source_run", ["A1"]],
      // One rewrite event = one isolated batch, even with mixed sources.
      ["rewrite_event", ["R1", "R2"]],
      ["rewrite_event", ["R3"]],
    ]);
  });

  it("cuts at first-parent linkage breaks even when order keys are consecutive", () => {
    orderCounter = 0;
    // Rewritten history reuses absolute positions: A2' has position 3 but its
    // parent is no longer A1's successor — the link break is the boundary.
    const a1 = member({ memberId: "sha-a1" });
    const a2 = member({ memberId: "sha-a2", parents: ["sha-a1"] });
    const rewritten = member({ memberId: "sha-a3-new", parents: ["sha-other"] });
    const result = cutAutoCommitBatches([a1, a2, rewritten], T0 + 1);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["sha-a1", "sha-a2"], ["sha-a3-new"]]);
  });
  it("blocks unavailable/conflicted members without merging or dropping them", () => {
    orderCounter = 0;
    const a1 = member({ memberId: "A1" });
    const u1 = member({ memberId: "U1", sourceStatus: "unavailable" });
    const c1 = member({ memberId: "C1", sourceStatus: "conflicted" });
    const a2 = member({ memberId: "A2" });
    const result = cutAutoCommitBatches([a1, u1, c1, a2], T0 + 1);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["A1"], ["A2"]]);
    expect(result.blocked).toEqual(["U1", "C1"]);
  });

  it("seals the eligible prefix without waiting for a later notification", () => {
    orderCounter = 0;
    const a1 = member({ memberId: "A1", eligibleAt: T0 });
    const a2 = member({ memberId: "A2", eligibleAt: T0 + 120_000 });
    const early = cutAutoCommitBatches([a1, a2], T0 + 1);
    expect(early.ready.map((cut) => cut.memberIds)).toEqual([["A1"]]);
    expect(early.waiting).toEqual([{ memberIds: ["A2"], eligibleAt: T0 + 120_000 }]);
    const late = cutAutoCommitBatches([a1, a2], T0 + 120_000);
    expect(late.ready.map((cut) => cut.memberIds)).toEqual([["A1", "A2"]]);
  });

  it("does not cross an ineligible member when later members are already due", () => {
    orderCounter = 0;
    const a1 = member({ memberId: "A1" });
    const a2 = member({ memberId: "A2", eligibleAt: T0 + 120_000 });
    const a3 = member({ memberId: "A3" });
    const result = cutAutoCommitBatches([a1, a2, a3], T0);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["A1"]]);
    expect(result.waiting).toEqual([{ memberIds: ["A2", "A3"], eligibleAt: T0 + 120_000 }]);
  });

  it("wakes a pending tail at its first member's delay without waiting for later arrivals", () => {
    orderCounter = 0;
    const a1 = member({ memberId: "A1", eligibleAt: T0 + 60_000 });
    const a2 = member({ memberId: "A2", eligibleAt: T0 + 120_000 });
    const result = cutAutoCommitBatches([a1, a2], T0);
    expect(result.ready).toEqual([]);
    expect(result.waiting).toEqual([{ memberIds: ["A1", "A2"], eligibleAt: T0 + 60_000 }]);
    const next = cutAutoCommitBatches([a1, a2], T0 + 60_000);
    expect(next.ready.map((cut) => cut.memberIds)).toEqual([["A1"]]);
    expect(next.waiting).toEqual([{ memberIds: ["A2"], eligibleAt: T0 + 120_000 }]);
  });

  it("keeps a rewrite event indivisible when its members have different delays", () => {
    orderCounter = 0;
    const r1 = member({ memberId: "R1", rewriteReceiptId: "rewrite" });
    const r2 = member({ memberId: "R2", rewriteReceiptId: "rewrite", eligibleAt: T0 + 120_000 });
    const result = cutAutoCommitBatches([r1, r2], T0);
    expect(result.ready).toEqual([]);
    expect(result.waiting).toEqual([{ memberIds: ["R1", "R2"], eligibleAt: T0 + 120_000 }]);
  });

  it("prefix-splits runs longer than the batch cap", () => {
    orderCounter = 0;
    const members = Array.from({ length: AUTO_COMMIT_MAX_BATCH_MEMBERS + 3 }, (_, index) =>
      member({ memberId: `A${index}` }),
    );
    const result = cutAutoCommitBatches(members, T0 + 1);
    expect(result.ready).toHaveLength(1);
    expect(result.ready[0]?.memberIds).toHaveLength(AUTO_COMMIT_MAX_BATCH_MEMBERS);
    expect(result.ready[0]?.headRevision).toBe(`A${AUTO_COMMIT_MAX_BATCH_MEMBERS - 1}`);
  });

  it("rejects a non-positive batch cap", () => {
    expect(() => cutAutoCommitBatches([], T0, 0)).toThrow(RangeError);
  });
});
