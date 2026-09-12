/**
 * Shared ConfigStore conformance scenarios (S01–S13 of the P2 matrix). Every
 * backend — memory, real SQLite files, PostgreSQL, and Redis when a service
 * is available — must pass the identical logical contract.
 *
 * Time is injected explicitly through `now` parameters; no fake timers, no
 * sleeping. Backends must isolate per factory call (fresh file / unique
 * Redis prefix / dedicated PG schema) so cases never share state.
 */

import { describe, expect, it } from "vitest";

import { ConfigError, isConfigError } from "../src/config-format.js";
import type { DatabaseConfigDocument } from "../src/config-source.js";
import type {
  AdminSessionRecord,
  CommitChangesetInput,
  ConfigStore,
  WriteSnapshotInput,
} from "../src/config-store.js";
import { contentHashOf } from "../src/config-store.js";

const NS_A = "test-ns-a";
const NS_B = "test-ns-b";
const T0 = 1_800_000_000_000;

export interface ConfigStoreFactory {
  readonly backendKind: string;
  makeStore(): Promise<ConfigStore> | ConfigStore;
}

function doc(marker: string): DatabaseConfigDocument {
  return {
    formatVersion: 1,
    entities: {
      providers: {
        [marker]: {
          id: marker,
          name: marker,
          enabled: true,
          value: { kind: "openai_compatible", api_key_env: "AICR_TEST_KEY" },
        },
      },
    },
    globals: {},
  };
}

function commit(overrides: Partial<CommitChangesetInput> = {}): CommitChangesetInput {
  const document = overrides.document ?? doc("p1");
  return {
    namespace: NS_A,
    baseRevision: null,
    fileDigest: "file-digest-1",
    operationId: "op-1",
    actor: "admin@example.com",
    document,
    formatVersion: 1,
    audit: {
      action: "publish",
      entityRefs: [`provider:${Object.keys(document.entities?.providers ?? {})[0] ?? "none"}`],
      redactedDiff: { providers: { added: ["p1"] } },
    },
    now: T0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<WriteSnapshotInput> = {}): WriteSnapshotInput {
  return {
    id: "snap-1",
    namespace: NS_A,
    fileDigest: "file-digest-1",
    databaseRevision: 1,
    resolverVersion: 1,
    sanitizedEffectiveConfig: { llm: { providers: ["p1"] } },
    contentHash: "snap-hash-1",
    now: T0,
    ...overrides,
  };
}

function session(tokenHash: string, expiresAt: number): AdminSessionRecord {
  return { tokenHash, createdAt: T0, expiresAt };
}

export function runConfigStoreConformance(factory: ConfigStoreFactory): void {
  describe(`ConfigStore conformance [${factory.backendKind}]`, () => {
    it.each([{ fileDigest: "other-file" }, { formatVersion: 2 }])("rejects a reused operation with different execution inputs: %j", async (override) => {
      const store = await factory.makeStore();
      await store.commitChangeset(commit());
      await expect(store.commitChangeset(commit(override))).rejects.toMatchObject({ code: "operation_conflict" });
      expect((await store.readHead(NS_A))?.activeRevision).toBe(1);
    });

    it.each([
      { namespace: NS_B }, { fileDigest: "other-file" }, { databaseRevision: 2 }, { resolverVersion: 2 },
      { sanitizedEffectiveConfig: { review: { max_files: 1 } } },
    ])("rejects snapshot identity/payload conflicts even with the same claimed hash: %j", async (override) => {
      const store = await factory.makeStore();
      const first = await store.writeSnapshot(snapshot());
      await expect(store.writeSnapshot(snapshot(override))).rejects.toMatchObject({ code: "snapshot_invalid" });
      expect(await store.readSnapshot(first.id)).toEqual(first);
    });

    it("creates the first revision on an empty namespace and returns immutable copies (S01)", async () => {
      const store = await factory.makeStore();
      expect(await store.readHead(NS_A)).toBeNull();
      expect(await store.readRevision(NS_A, 1)).toBeNull();

      const first = await store.commitChangeset(commit());
      expect(first.status).toBe("committed");
      if (first.status !== "committed") return;
      expect(first.revision.revision).toBe(1);
      expect(first.revision.parentRevision).toBeNull();
      expect(first.head.activeRevision).toBe(1);
      expect(first.head.generation).toBe("1");

      // Mutating the returned record must not corrupt the store (S01).
      const reread = await store.readRevision(NS_A, 1);
      expect(reread?.document).toEqual(doc("p1"));
      if (reread !== null && first.revision.document.entities !== undefined) {
        (first.revision.document.entities as Record<string, unknown>).providers = {};
        const again = await store.readRevision(NS_A, 1);
        expect(again?.document).toEqual(doc("p1"));
        expect(reread.document).toEqual(doc("p1"));
      }
    });

    it("serializes concurrent changesets: one commits, one conflicts (S02)", async () => {
      const store = await factory.makeStore();
      const first = await store.commitChangeset(commit());
      expect(first.status).toBe("committed");

      const [winner, loser] = await Promise.all([
        store.commitChangeset(commit({ operationId: "op-2", document: doc("p2"), baseRevision: 1, now: T0 + 1 })),
        store.commitChangeset(commit({ operationId: "op-3", document: doc("p3"), baseRevision: 1, now: T0 + 1 })),
      ]);
      const results = [winner, loser];
      expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
      expect(results.filter((r) => r.status === "revision_conflict")).toHaveLength(1);

      const head = await store.readHead(NS_A);
      expect(head?.activeRevision).toBe(2);
      // Audit corresponds to the single committed revision.
      const audit = await store.readAudit(NS_A);
      expect(audit).toHaveLength(2);
      expect(audit[0]?.afterRevision).toBe(2);
    });

    it("dedupes operationId retries and rejects same-id different-content (S03)", async () => {
      const store = await factory.makeStore();
      const first = await store.commitChangeset(commit());
      expect(first.status).toBe("committed");

      // Lost response: the identical retry returns the original revision.
      const retry = await store.commitChangeset(commit());
      expect(retry.status).toBe("committed");
      if (retry.status === "committed" && first.status === "committed") {
        expect(retry.duplicate).toBe(true);
        expect(retry.revision.revision).toBe(first.revision.revision);
      }
      expect((await store.readHead(NS_A))?.activeRevision).toBe(1);

      // Same operationId with different content is an error, never a fork.
      await expect(
        store.commitChangeset(commit({ document: doc("p2") })),
      ).rejects.toSatisfy((error) => isConfigError(error, "operation_conflict"));

      // The operation stays queryable after the fact (response-loss recovery).
      const viaOperation = await store.readOperation(NS_A, "op-1");
      expect(viaOperation?.operationId).toBe("op-1");
      expect(viaOperation?.revision).toBe(1);
      expect(await store.readOperation(NS_A, "op-missing")).toBeNull();
    });

    it("keeps head and visible document unchanged when a changeset is rejected (S04)", async () => {
      const store = await factory.makeStore();
      await store.commitChangeset(commit());
      // A stale baseRevision models a batch that failed validation upstream:
      // nothing may be half-committed.
      const stale = await store.commitChangeset(commit({ operationId: "op-2", baseRevision: 99 }));
      expect(stale.status).toBe("revision_conflict");
      expect((await store.readHead(NS_A))?.activeRevision).toBe(1);
      expect(await store.readRevision(NS_A, 2)).toBeNull();
      const audit = await store.readAudit(NS_A);
      expect(audit).toHaveLength(1);
    });

    it("pins, refcounts, reopens, and GC-protects snapshots (S05)", async () => {
      const store = await factory.makeStore();
      await store.commitChangeset(commit());
      const written = await store.writeSnapshot(snapshot());
      expect(written.refCount).toBe(0);
      expect(written.pinned).toBe(false);

      // Identical rewrite is idempotent; conflicting id is rejected.
      const again = await store.writeSnapshot(snapshot());
      expect(again.contentHash).toBe(written.contentHash);
      await expect(store.writeSnapshot(snapshot({ contentHash: "different" })))
        .rejects.toSatisfy((error) => isConfigError(error, "snapshot_invalid"));

      // Reopen: the durable record reads back completely (S10 restart analog).
      const reopened = await store.readSnapshot("snap-1");
      expect(reopened?.sanitizedEffectiveConfig).toEqual({ llm: { providers: ["p1"] } });

      // Referenced snapshots are never GC candidates.
      await store.adjustSnapshotRefCount("snap-1", +1);
      await store.setSnapshotPinned("snap-1", true);
      expect(await store.listUnreferencedSnapshots(NS_A, T0 + 1)).toEqual([]);
      await expect(store.deleteSnapshot("snap-1")).rejects.toSatisfy((error) =>
        isConfigError(error, "snapshot_invalid"));

      await store.setSnapshotPinned("snap-1", false);
      await store.adjustSnapshotRefCount("snap-1", -1);
      await store.adjustSnapshotRefCount("snap-1", -5); // clamps at zero
      const candidates = await store.listUnreferencedSnapshots(NS_A, T0 + 1);
      expect(candidates.map((entry) => entry.id)).toEqual(["snap-1"]);
      await store.deleteSnapshot("snap-1");
      expect(await store.readSnapshot("snap-1")).toBeNull();
    });

    it("records audit atomically with actor, time, and refs — no secret material (S06)", async () => {
      const store = await factory.makeStore();
      await store.commitChangeset(commit({
        audit: {
          action: "publish",
          entityRefs: ["provider:p1"],
          redactedDiff: { providers: { p1: { api_key_env: { ref: "AICR_TEST_KEY" } } } },
        },
      }));
      const audit = await store.readAudit(NS_A);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor).toBe("admin@example.com");
      expect(audit[0]?.timestamp).toBe(T0);
      expect(audit[0]?.entityRefs).toEqual(["provider:p1"]);
      expect(audit[0]?.beforeRevision).toBeNull();
      expect(audit[0]?.afterRevision).toBe(1);
      // The store persists exactly what it was given; the contract forbids
      // callers from ever handing over secret values (redacted upstream).
      expect(JSON.stringify(audit[0]?.redactedDiff)).not.toContain("sk-");

      const byOperation = await store.readAudit(NS_A, { operationId: "op-1" });
      expect(byOperation).toHaveLength(1);
      expect(await store.readAudit(NS_A, { operationId: "op-none" })).toEqual([]);
    });

    it("restores create a new revision with a new parent, never a downgrade (S07)", async () => {
      const store = await factory.makeStore();
      const r1 = await store.commitChangeset(commit());
      expect(r1.status).toBe("committed");
      await store.commitChangeset(commit({ operationId: "op-2", baseRevision: 1, document: doc("p2"), now: T0 + 1 }));

      // Restore = commit the r1 document as a new revision on top of head.
      const r1doc = await store.readRevision(NS_A, 1);
      const restored = await store.commitChangeset(commit({
        operationId: "op-3",
        baseRevision: 2,
        document: r1doc!.document,
        audit: { action: "restore", entityRefs: [], redactedDiff: { restoredFrom: 1 } },
        now: T0 + 2,
      }));
      expect(restored.status).toBe("committed");
      if (restored.status !== "committed") return;
      expect(restored.revision.revision).toBe(3);
      expect(restored.revision.parentRevision).toBe(2);
      expect(restored.revision.document).toEqual(doc("p1"));
      expect((await store.readHead(NS_A))?.activeRevision).toBe(3);
      // Old revisions remain readable.
      expect((await store.readRevision(NS_A, 2))?.document).toEqual(doc("p2"));
    });

    it("upserts bindings idempotently and rejects root conflicts (S08)", async () => {
      const store = await factory.makeStore();
      const input = {
        instanceId: "inst-1",
        definitionId: "def-1",
        canonicalProjectKey: "git:host:org/repo",
        layoutVersion: 2,
        relativeRoot: "def-1/abc123",
        now: T0,
      };
      const first = await store.upsertWorkspaceBinding(input);
      expect(first.state).toBe("active");
      expect(first.createdAt).toBe(T0);
      // Same full identity is an idempotent touch, not a new record.
      const touched = await store.upsertWorkspaceBinding({ ...input, now: T0 + 10 });
      expect(touched.createdAt).toBe(T0);
      expect(touched.lastSeenAt).toBe(T0 + 10);

      // A different identity may never share the root (S08).
      await expect(store.upsertWorkspaceBinding({ ...input, instanceId: "inst-2" }))
        .rejects.toSatisfy((error) => isConfigError(error, "binding_conflict"));
      // Same identity may never silently move roots either.
      await expect(store.upsertWorkspaceBinding({ ...input, relativeRoot: "def-1/other" }))
        .rejects.toSatisfy((error) => isConfigError(error, "binding_conflict"));

      const listed = await store.listWorkspaceBindings(NS_A);
      expect(listed).toHaveLength(1);
      const disabled = await store.setWorkspaceBindingState("inst-1", "disabled", T0 + 20);
      expect(disabled?.state).toBe("disabled");
      expect((await store.readWorkspaceBinding("inst-1"))?.state).toBe("disabled");
      expect(await store.readWorkspaceBinding("inst-missing")).toBeNull();
    });

    it("isolates namespaces fully (S09)", async () => {
      const store = await factory.makeStore();
      await store.commitChangeset(commit({ namespace: NS_A }));
      await store.commitChangeset(commit({ namespace: NS_B, operationId: "op-b1", document: doc("pb") }));

      expect((await store.readHead(NS_A))?.activeRevision).toBe(1);
      expect((await store.readHead(NS_B))?.activeRevision).toBe(1);
      expect((await store.readRevision(NS_A, 1))?.document).toEqual(doc("p1"));
      expect((await store.readRevision(NS_B, 1))?.document).toEqual(doc("pb"));
      expect(await store.readAudit(NS_B)).toHaveLength(1);

      // Same operationId in another namespace is an independent operation.
      const other = await store.commitChangeset(commit({ namespace: NS_B, operationId: "op-1", baseRevision: 1, document: doc("pb2"), now: T0 + 1 }));
      expect(other.status).toBe("committed");

      // Snapshot GC in one namespace never lists another's records.
      await store.writeSnapshot(snapshot({ id: "snap-a", namespace: NS_A }));
      await store.writeSnapshot(snapshot({ id: "snap-b", namespace: NS_B }));
      expect((await store.listUnreferencedSnapshots(NS_A, T0 + 1)).map((s) => s.id)).toEqual(["snap-a"]);
      await store.deleteSnapshot("snap-a");
      expect(await store.readSnapshot("snap-b")).not.toBeNull();
    });

    it("reports integer/Unicode/JSON/time values without precision or shape loss (S11)", async () => {
      const store = await factory.makeStore();
      const unicode = "p-測試-😀";
      const bigNow = T0 + 123_456_789;
      const first = await store.commitChangeset(commit({
        document: doc(unicode),
        now: bigNow,
        audit: { action: "publish", entityRefs: [`provider:${unicode}`], redactedDiff: { note: "unicode-測試" } },
      }));
      expect(first.status).toBe("committed");

      const reread = await store.readRevision(NS_A, 1);
      expect(reread?.document).toEqual(doc(unicode));
      expect(reread?.createdAt).toBe(bigNow);

      // Generation stays a decimal string even after many moves (S11).
      let base = 1;
      for (let i = 2; i <= 12; i += 1) {
        const result = await store.commitChangeset(commit({
          operationId: `op-${i}`,
          baseRevision: base,
          document: doc(`p${i}`),
          now: bigNow + i,
        }));
        expect(result.status).toBe("committed");
        base = i;
      }
      const head = await store.readHead(NS_A);
      expect(head?.generation).toBe("12");
      expect(typeof head?.generation).toBe("string");

      const audit = await store.readAudit(NS_A);
      expect(audit[audit.length - 1]?.entityRefs).toEqual([`provider:${unicode}`]);
    });

    it("stores sessions by hash with expiry and durable revocation (S12)", async () => {
      const store = await factory.makeStore();
      const hash = "a".repeat(64);
      await store.saveAdminSession(session(hash, T0 + 1000));
      expect(await store.readAdminSession(hash, T0 + 500)).not.toBeNull();
      // Expired sessions read as absent.
      expect(await store.readAdminSession(hash, T0 + 1000)).toBeNull();
      // No plaintext token material: the record only ever carries the hash.
      const record = await store.readAdminSession(hash, T0 + 500);
      expect(Object.keys(record ?? {})).toEqual(["tokenHash", "createdAt", "expiresAt"]);

      // Revocation is immediate and durable (a second replica reading the
      // same backend must observe the logout).
      await store.deleteAdminSession(hash);
      expect(await store.readAdminSession(hash, T0 + 500)).toBeNull();

      await store.saveAdminSession(session("b".repeat(64), T0 - 1));
      await store.saveAdminSession(session("c".repeat(64), T0 + 5000));
      expect(await store.deleteExpiredAdminSessions(T0, 10)).toBe(1);
      expect(await store.readAdminSession("c".repeat(64), T0 + 1)).not.toBeNull();
    });

    it("fails closed after close() and tolerates double close (S13)", async () => {
      const store = await factory.makeStore();
      await store.commitChangeset(commit());
      await store.close();
      await store.close();
      await expect(store.readHead(NS_A)).rejects.toSatisfy((error) =>
        error instanceof ConfigError && error.code === "store_unavailable");
      await expect(store.commitChangeset(commit({ operationId: "op-2", baseRevision: 1 }))).rejects.toSatisfy((error) =>
        isConfigError(error, "store_unavailable"));
    });

    it("lists revisions newest-first with cursor pagination", async () => {
      const store = await factory.makeStore();
      for (let i = 1; i <= 5; i += 1) {
        await store.commitChangeset(commit({
          operationId: `op-${i}`,
          baseRevision: i === 1 ? null : i - 1,
          document: doc(`p${i}`),
          now: T0 + i,
        }));
      }
      const page1 = await store.listRevisions(NS_A, { limit: 2 });
      expect(page1.map((r) => r.revision)).toEqual([5, 4]);
      const page2 = await store.listRevisions(NS_A, { before: 4, limit: 2 });
      expect(page2.map((r) => r.revision)).toEqual([3, 2]);
      const page3 = await store.listRevisions(NS_A, { before: 2 });
      expect(page3.map((r) => r.revision)).toEqual([1]);
    });

    it("contentHashOf is deterministic regardless of key order", () => {
      const a = doc("p1");
      const b: DatabaseConfigDocument = {
        globals: {},
        formatVersion: 1,
        entities: { providers: { p1: { enabled: true, name: "p1", id: "p1", value: { api_key_env: "AICR_TEST_KEY", kind: "openai_compatible" } } } },
      };
      expect(contentHashOf(a)).toBe(contentHashOf(b));
      expect(contentHashOf(doc("p1"))).not.toBe(contentHashOf(doc("p2")));
    });
  });
}
