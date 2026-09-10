import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

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
import { createSqliteAutoCommitStore } from "../src/sqlite-auto-commit-store.js";

import { runAutoCommitStoreConformance } from "./auto-commit-store-conformance.js";

const NS = "https://git.example.com/org/repo";
const SCOPE = "refs/heads/main";
const T0 = 1_800_000_000_000;

const opened: { store: AutoCommitStore; dir: string }[] = [];

afterEach(() => {
  // Close every handle first: Windows denies directory removal while any
  // connection still holds the db/-wal/-shm files open.
  for (const entry of opened) {
    entry.store.close?.();
  }
  let entry = opened.pop();
  while (entry) {
    rmSync(entry.dir, { recursive: true, force: true });
    entry = opened.pop();
  }
});

async function openStore(
  dir?: string,
): Promise<{ store: AutoCommitStore; dir: string; dbPath: string }> {
  const workDir =
    dir ?? mkdtempSync(join(tmpdir(), "aicr-auto-commit-sqlite-"));
  const dbPath = join(workDir, "store.db");
  const store = await createSqliteAutoCommitStore({ path: dbPath });
  opened.push({ store, dir: workDir });
  return { store, dir: workDir, dbPath };
}

runAutoCommitStoreConformance({
  backendKind: "sqlite",
  makeStore: async () => (await openStore()).store,
});

function gitSnapshot(revision: string): SourceSnapshot {
  return {
    v: 1,
    vcs: "git",
    sourceNamespace: NS,
    revision,
    fields: {
      authorName: { status: "known", value: "alice" },
      authorEmail: { status: "known", value: "alice@example.com" },
    },
    command: "git log --format=%H%x1f%P%x1f%an%x1f%ae",
    observedAt: T0,
    rulesVersion: "rules-v1",
    sourceKey: computeSourceKey(NS, {
      vcs: "git",
      authorName: "alice",
      authorEmail: "alice@example.com",
    }),
    status: "known",
  };
}

function receiptInput(
  overrides: Partial<AcceptReceiptInput> = {},
): AcceptReceiptInput {
  return {
    deliveryKey: "gitea:persist-1",
    workspaceId: "ws1",
    triggerName: "gitea",
    provider: "gitea",
    vcs: "git",
    sourceNamespace: NS,
    scopeRef: SCOPE,
    historyGeneration: 0,
    coverage: { kind: "range", base: "A0", head: "A1" },
    envelope: { ref: SCOPE },
    delaySeconds: 0,
    policyVersion: "pol-1",
    now: T0,
    ...overrides,
  };
}

function membersOf(
  revisions: readonly string[],
  orderStart: number,
): MemberMetadataUpsert[] {
  return revisions.map((revision, index) => ({
    revision,
    orderKey: String(orderStart + index).padStart(12, "0"),
    parents: [index === 0 ? "A0" : (revisions[index - 1] ?? "A0")],
    sourceSnapshot: gitSnapshot(revision),
  }));
}

describe("createSqliteAutoCommitStore persistence", () => {
  it("keeps receipt/member/batch state across close and reopen (Q09/Q16)", async () => {
    const first = await openStore();
    const accepted = await first.store.acceptReceipt(receiptInput());
    const streamId = computeStreamId(accepted.receipt);
    await first.store.applyMetadataPage({
      streamId,
      receiptId: accepted.receipt.receiptId,
      members: membersOf(["A1"], 1),
      now: T0,
    });
    const member = (await first.store.readPendingMembers(streamId, null, 10))
      .items[0];
    const reservation = await first.store.acquireStreamReservation(
      streamId,
      "sched",
      60_000,
      T0,
    );
    const sealed = await first.store.sealBatch({
      streamId,
      reservationToken: reservation?.token ?? "",
      expectedStreamVersion: reservation?.version ?? -1,
      batchId: "batch-persist",
      runId: "run-persist",
      members: [
        { memberId: member?.memberId ?? "", revision: "A1", sourceKey: "k" },
      ],
      base: "A0",
      head: "A1",
      sourceKey: "k",
      exclusionPolicyVersion: "pol-1",
      configPolicyVersion: "pol-1",
      maxAttempts: 3,
      now: T0,
    });
    expect(sealed.kind).toBe("sealed");
    first.store.close?.();

    const second = await openStore(first.dir);
    const receiptView = await second.store.getReceipt(
      accepted.receipt.receiptId,
    );
    expect(receiptView?.receipt.deliveryKey).toBe("gitea:persist-1");
    expect(receiptView?.memberCounts.batched).toBe(1);
    const batch = await second.store.readBatch("batch-persist");
    expect(batch?.status).toBe("dispatch_pending");
    expect(batch?.members.map((entry) => entry.revision)).toEqual(["A1"]);
    expect((await second.store.readStreamHead(streamId))?.activeBatchId).toBe(
      "batch-persist",
    );
    // The member stays batched; it does not reappear as pending.
    expect(
      (await second.store.readPendingMembers(streamId, null, 10)).items,
    ).toEqual([]);
    // The persistent receipt seq continues across reopen.
    const next = await second.store.acceptReceipt(
      receiptInput({ deliveryKey: "gitea:persist-2", now: T0 + 1000 }),
    );
    expect(next.receipt.receiptSeq).toBe(2);
    // Redelivery of the first key is still idempotent after reopen.
    const redelivered = await second.store.acceptReceipt(
      receiptInput({ now: T0 + 2000 }),
    );
    expect(redelivered.duplicate).toBe(true);
    expect(redelivered.receipt.receiptId).toBe(accepted.receipt.receiptId);
  });

  it("reopens the same path idempotently (migration is re-entrant)", async () => {
    const first = await openStore();
    const accepted = await first.store.acceptReceipt(receiptInput());
    // A second store on the same file (while the first is still open) finds the
    // schema and version row already in place and starts cleanly.
    const second = await openStore(first.dir);
    const receiptView = await second.store.getReceipt(
      accepted.receipt.receiptId,
    );
    expect(receiptView?.receipt.receiptId).toBe(accepted.receipt.receiptId);
    second.store.close?.();
    // Reopening after close is equally idempotent.
    const third = await openStore(first.dir);
    expect(
      (await third.store.getReceipt(accepted.receipt.receiptId))?.receipt
        .deliveryKey,
    ).toBe("gitea:persist-1");
  });

  it("migrates a v1 file: receipts gain the metadata cursor without data loss", async () => {
    const first = await openStore();
    const accepted = await first.store.acceptReceipt(receiptInput());
    const receiptId = accepted.receipt.receiptId;
    first.store.close?.();

    // Rebuild the v1 shape on disk: drop every column added by v2/v3/v4, then
    // stamp the version row 1. One DROP COLUMN per ALTER (SQLite 3.35+).
    const raw = new Database(first.dbPath);
    raw.exec(`
      ALTER TABLE auto_commit_receipts DROP COLUMN metadata_cursor;
      ALTER TABLE auto_commit_receipts DROP COLUMN metadata_attempts;
      ALTER TABLE auto_commit_receipts DROP COLUMN metadata_next_attempt_at;
      ALTER TABLE auto_commit_receipts DROP COLUMN metadata_terminal_error;
      ALTER TABLE auto_commit_stream_heads DROP COLUMN latest_receipt_seq;
      ALTER TABLE auto_commit_stream_heads DROP COLUMN assembly_cut_seq;
      ALTER TABLE auto_commit_stream_heads DROP COLUMN assembly_at;
      ALTER TABLE auto_commit_stream_heads DROP COLUMN resume_not_before;
      ALTER TABLE auto_commit_batches DROP COLUMN execution_checkpoint;
    `);
    raw
      .prepare(`UPDATE auto_commit_meta SET schema_version = 1 WHERE id = 1`)
      .run();
    raw.close();

    const migrated = await openStore(first.dir);
    const receiptView = await migrated.store.getReceipt(receiptId);
    expect(receiptView?.receipt.deliveryKey).toBe("gitea:persist-1");
    expect(receiptView?.receipt.metadataCursor).toBeNull();
    // The migrated store accepts cursor writes and new receipts.
    await migrated.store.setReceiptMetadataCursor(receiptId, "page-2", T0 + 10);
    expect(
      (await migrated.store.getReceipt(receiptId))?.receipt.metadataCursor,
    ).toBe("page-2");
    const next = await migrated.store.acceptReceipt(
      receiptInput({ deliveryKey: "gitea:persist-2", now: T0 + 1000 }),
    );
    expect(next.receipt.receiptSeq).toBe(2);
  });

  it.each([false, true])(
    "migrates v3 atomically with an existing checkpoint column: %s",
    async (hasCheckpoint) => {
      const first = await openStore();
      const accepted = await first.store.acceptReceipt(receiptInput());
      first.store.close?.();
      const raw = new Database(first.dbPath);
      if (!hasCheckpoint)
        raw.exec(
          "ALTER TABLE auto_commit_batches DROP COLUMN execution_checkpoint",
        );
      raw.exec("UPDATE auto_commit_meta SET schema_version = 3 WHERE id = 1");
      raw.close();
      const migrated = await openStore(first.dir);
      expect(
        (await migrated.store.getReceipt(accepted.receipt.receiptId))?.receipt
          .deliveryKey,
      ).toBe("gitea:persist-1");
      const verify = new Database(first.dbPath);
      expect(
        verify.prepare("SELECT schema_version FROM auto_commit_meta").get(),
      ).toEqual({ schema_version: 4 });
      expect(
        verify.prepare("PRAGMA table_info(auto_commit_batches)").all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "execution_checkpoint" }),
        ]),
      );
      verify.close();
    },
  );
});
