import { describe, expect, it } from "vitest";
import { AUTO_COMMIT_BATCH_LIMITS } from "../src/auto-commit-identity.js";

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

describe("cutAutoCommitBatches config snapshot boundaries (H09)", () => {
  it("members pinned to different snapshots never share a batch", () => {
    const a = member({ memberId: "r1", configSnapshotId: "cfg-old" });
    const b = member({ memberId: "r2", configSnapshotId: "cfg-old" });
    const c = member({ memberId: "r3", configSnapshotId: "cfg-new" });
    const d = member({ memberId: "r4", configSnapshotId: "cfg-new" });

    const result = cutAutoCommitBatches([a, b, c, d], T0);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["r1", "r2"], ["r3", "r4"]]);
    expect(result.ready.map((cut) => cut.reason)).toEqual(["same_source_run", "config_boundary"]);
  });

  it("legacy (null snapshot) members group with their own kind only", () => {
    const legacy = member({ memberId: "l1", configSnapshotId: null });
    const pinned = member({ memberId: "p1", configSnapshotId: "cfg-1" });
    const legacy2 = member({ memberId: "l2", configSnapshotId: null });

    const result = cutAutoCommitBatches([legacy, pinned, legacy2], T0);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["l1"], ["p1"], ["l2"]]);
    // The first cut keeps its ordinary-run reason; boundary labeling starts
    // with the run that the pin change opens.
    expect(result.ready.map((cut) => cut.reason)).toEqual(["same_source_run", "config_boundary", "config_boundary"]);
  });

  it("undefined snapshot behaves as legacy null", () => {
    const a = member({ memberId: "u1" });
    const b = member({ memberId: "p1", configSnapshotId: "cfg-1" });
    const c = member({ memberId: "u2" });

    const result = cutAutoCommitBatches([a, b, c], T0);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["u1"], ["p1"], ["u2"]]);
  });

  it("a snapshot boundary after a merge commit still isolates the merge", () => {
    const a = member({ memberId: "m1", parents: ["p0", "p2"], configSnapshotId: "cfg-1" });
    const b = member({ memberId: "r1", configSnapshotId: "cfg-1" });
    const c = member({ memberId: "r2", configSnapshotId: "cfg-2" });

    const result = cutAutoCommitBatches([a, b, c], T0);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["m1"], ["r1"], ["r2"]]);
    expect(result.ready.map((cut) => cut.reason)).toEqual(["merge_commit", "same_source_run", "config_boundary"]);
  });

  it("rewrite events keep their single-batch identity across snapshot checks", () => {
    const a = member({ memberId: "w1", rewriteReceiptId: "rw-1", configSnapshotId: "cfg-1" });
    const b = member({ memberId: "w2", rewriteReceiptId: "rw-1", configSnapshotId: "cfg-1" });
    const c = member({ memberId: "r1", configSnapshotId: "cfg-2" });

    const result = cutAutoCommitBatches([a, b, c], T0);
    expect(result.ready.map((cut) => cut.memberIds)).toEqual([["w1", "w2"], ["r1"]]);
    expect(result.ready.map((cut) => cut.reason)).toEqual(["rewrite_event", "same_source_run"]);
  });

  it("delivery and member identity stay intact: no member is dropped or duplicated", () => {
    const members = [
      member({ memberId: "r1", configSnapshotId: "cfg-1" }),
      member({ memberId: "r2", configSnapshotId: "cfg-2" }),
      member({ memberId: "r3", configSnapshotId: "cfg-2" }),
    ];
    const result = cutAutoCommitBatches(members, T0);
    const seen = result.ready.flatMap((cut) => cut.memberIds);
    expect(seen.sort()).toEqual(["r1", "r2", "r3"]);
  });
});

describe("Git push delivery units", () => {
  function push(id: string, count: number, overrides: Partial<AssemblyCandidate> = {}): AssemblyCandidate[] {
    return Array.from({ length: count }, (_, index) => member({ memberId: `${id}-${index}`, pushReceiptId: id, ...overrides }));
  }
  it("keeps alternating authors and merge commits of one push together", () => {
    orderCounter = 0;
    const members = push("delivery", 4);
    members[1] = { ...members[1]!, sourceKey: "bob" };
    members[2] = { ...members[2]!, parents: [members[1]!.revision, "side-branch"] };
    expect(cutAutoCommitBatches(members, T0).ready.map(cut => cut.memberIds)).toEqual([members.map(m => m.memberId)]);
  });
  it("coalesces continuous uniform pushes, but isolates a mixed-author push", () => {
    orderCounter = 0;
    const first = push("one", 2);
    const second = push("two", 2);
    const mixed = push("mixed", 2);
    mixed[0] = { ...mixed[0]!, sourceKey: "bob" };
    const last = push("last", 1);
    expect(cutAutoCommitBatches([...first, ...second, ...mixed, ...last], T0).ready.map(cut => cut.memberIds)).toEqual([
      [...first, ...second].map(m => m.memberId), mixed.map(m => m.memberId), last.map(m => m.memberId),
    ]);
  });
  it("never slices a 550-member push at the coalescing limit", () => {
    orderCounter = 0;
    const members = push("large", 550);
    expect(cutAutoCommitBatches(members, T0).ready[0]?.memberIds).toEqual(members.map(m => m.memberId));
  });
  it("cuts between complete pushes when coalescing would exceed 50", () => {
    orderCounter = 0;
    const first = push("one", 40);
    const second = push("two", 20);
    expect(cutAutoCommitBatches([...first, ...second], T0).ready.map(cut => cut.memberIds.length)).toEqual([40, 20]);
  });
  it("waits for every member of a push without delaying an earlier ready push", () => {
    orderCounter = 0;
    const first = push("ready", 1);
    const later = push("later", 2);
    later[1] = { ...later[1]!, eligibleAt: T0 + 1000 };
    const result = cutAutoCommitBatches([...first, ...later], T0);
    expect(result.ready[0]?.memberIds).toEqual(first.map(m => m.memberId));
    expect(result.waiting).toEqual([{ memberIds: later.map(m => m.memberId), eligibleAt: T0 + 1000 }]);
  });
  it("blocks the whole push for an exclusion gap or unknown source evidence", () => {
    orderCounter = 0;
    const members = push("gap", 3);
    for (const broken of [members.filter((_, i) => i !== 1), [members[0]!, { ...members[1]!, sourceStatus: "unavailable" as const }, members[2]!]]) {
      const result = cutAutoCommitBatches(broken, T0);
      expect(result.ready).toEqual([]);
      expect(result.blocked).toEqual(broken.map(m => m.memberId));
    }
  });
  it("blocks a receipt interleaved by another covering delivery", () => {
    orderCounter = 0;
    const first = push("one", 1);
    const second = push("two", 1);
    const tail = push("one", 1);
    const result = cutAutoCommitBatches([...first, ...second, ...tail], T0);
    expect(result.blocked).toEqual([...first, ...tail].map(m => m.memberId));
    expect(result.ready[0]?.memberIds).toEqual(second.map(m => m.memberId));
  });
  it("honors configuration boundaries between pushes and rejects mixed pins within one", () => {
    orderCounter = 0;
    const first = push("one", 1, { configSnapshotId: "old" });
    const second = push("two", 1, { configSnapshotId: "new" });
    expect(cutAutoCommitBatches([...first, ...second], T0).ready).toHaveLength(2);
    expect(cutAutoCommitBatches([first[0]!, { ...second[0]!, pushReceiptId: "one" }], T0).blocked).toHaveLength(2);
  });
  it("blocks oversized pushes completely instead of producing several tasks", () => {
    orderCounter = 0;
    const members = push("oversized", AUTO_COMMIT_BATCH_LIMITS.maxMembersPerBatch + 1);
    const result = cutAutoCommitBatches(members, T0);
    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual(members.map(m => m.memberId));
  });
  it("keeps a rewrite push isolated with its original endpoint scope", () => {
    orderCounter = 0;
    const rewrite = push("rewrite", 2, { rewriteReceiptId: "rewrite" });
    rewrite[1] = { ...rewrite[1]!, sourceKey: "bob", parents: ["other"] };
    const next = push("next", 1);
    expect(cutAutoCommitBatches([...rewrite, ...next], T0).ready.map(cut => cut.reason)).toEqual(["rewrite_event", "push_event"]);
  });
  it("coalesces legacy members without a push receipt with adjacent uniform pushes", () => {
    orderCounter = 0;
    // Pre-upgrade rows carry no pushReceiptId: they form singleton units and
    // follow the same cross-delivery merge rules as one-commit pushes.
    const legacyHead = [member({ memberId: "L1" })];
    const delivery = push("delivery", 2);
    const legacyTail = [member({ memberId: "L2" })];
    const result = cutAutoCommitBatches([...legacyHead, ...delivery, ...legacyTail], T0);
    expect(result.ready.map(cut => cut.memberIds)).toEqual([["L1", "delivery-0", "delivery-1", "L2"]]);
  });
  it("blocks a push split by an interleaved legacy member, which still seals", () => {
    orderCounter = 0;
    const head = push("one", 1);
    const legacy = [member({ memberId: "L1" })];
    const tail = [{ ...member({ memberId: "one-tail" }), pushReceiptId: "one" }];
    const result = cutAutoCommitBatches([...head, ...legacy, ...tail], T0);
    expect(result.blocked).toEqual([...head, ...tail].map(m => m.memberId));
    expect(result.ready.map(cut => cut.memberIds)).toEqual([["L1"]]);
  });
});
