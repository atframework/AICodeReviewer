import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryAutoCommitStore,
  createSqliteAutoCommitStore,
  computeSourceKey,
  resolveAutoCommitPolicy,
  type AutoCommitStore,
  type CommitMetadataPage,
  type ResolvedAutoCommitPolicy,
} from "@aicr/core";
import { describe, expect, it, vi } from "vitest";

import {
  AutoCommitScheduler,
  type BatchExecutionContext,
} from "../src/auto-commit-scheduler.js";

/**
 * Scheduler flow tests with the memory store, a scripted metadata adapter,
 * and an injected clock — logic is exercised through tick(), never through
 * fake timers (F06). The adapter walks a scripted commit table like a real
 * first-parent VCS read.
 */

const T0 = 1_700_000_000_000;

interface ScriptedCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly committerEmail?: string;
}

class ScriptedAdapter {
  public unavailable = false;
  public readonly calls: { base?: string; head: string; cursor?: string }[] =
    [];
  private readonly bySha = new Map<string, ScriptedCommit>();
  private readonly positions = new Map<string, number>();

  constructor(commits: readonly ScriptedCommit[]) {
    for (const commit of commits) this.bySha.set(commit.sha, commit);
    // Absolute first-parent positions (mirrors rev-list --count): distance
    // to the first unknown ancestor. Rewritten commits collide with the
    // positions they replaced, exactly like real history.
    for (const commit of commits) {
      let position = 0;
      let cursor: string | undefined = commit.sha;
      while (cursor && this.bySha.has(cursor)) {
        position += 1;
        cursor = this.bySha.get(cursor)?.parents[0];
      }
      this.positions.set(commit.sha, position);
    }
  }

  readonly kind = "git" as const;

  async listCommitMetadataPage(query: {
    scopeRef: string;
    baseRevision?: string;
    headRevision: string;
    cursor?: string;
    maxRecords: number;
    maxBytes: number;
  }): Promise<CommitMetadataPage> {
    this.calls.push({
      ...(query.baseRevision ? { base: query.baseRevision } : {}),
      head: query.headRevision,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    if (this.unavailable) {
      return {
        vcs: "git",
        records: [],
        status: "unavailable",
        unavailableReason: "scripted outage",
      };
    }
    // First-parent walk from head, excluding the base and its ancestors —
    // like rev-list base..head. The walk stops at the first unknown sha
    // (scripted root) or at the base; a base absent from the chain (a
    // rewritten range) still yields the full reachable chain, as git does.
    const chain: ScriptedCommit[] = [];
    let cursor: string | undefined = query.headRevision;
    while (cursor && cursor !== query.baseRevision) {
      const commit = this.bySha.get(cursor);
      if (!commit) break;
      chain.push(commit);
      cursor = commit.parents[0];
    }
    chain.reverse();
    const historyRewrite =
      chain.length > 0 && chain[0]?.parents[0] !== query.baseRevision;
    // Honor the page contract: cursor names the first record of the page
    // (inclusive); an over-long range returns a partial page plus nextCursor.
    const start = query.cursor
      ? Math.max(
          0,
          chain.findIndex((commit) => commit.sha === query.cursor),
        )
      : 0;
    const slice = chain.slice(start, start + query.maxRecords);
    const next = chain[start + slice.length];
    const records = slice.map((commit) => ({
      revision: commit.sha,
      orderKey: String(this.positions.get(commit.sha) ?? 0).padStart(12, "0"),
      parents: commit.parents,
      ...(commit.authorName ? { authorName: commit.authorName } : {}),
      ...(commit.authorEmail ? { authorEmail: commit.authorEmail } : {}),
      changedPaths: [],
      historyRewrite,
      ...(commit.committerEmail
        ? { committerEmail: commit.committerEmail }
        : {}),
    }));
    return next
      ? { vcs: "git", records, status: "partial", nextCursor: next.sha }
      : { vcs: "git", records, status: "complete" };
  }

  async listChanges(): Promise<never> {
    throw new Error("unused");
  }
  async fetchScoped(): Promise<never> {
    throw new Error("unused");
  }
  async fetchExtraContext(): Promise<never> {
    throw new Error("unused");
  }
}

function makePolicy(
  config?: Parameters<typeof resolveAutoCommitPolicy>[0],
): ResolvedAutoCommitPolicy {
  return resolveAutoCommitPolicy(config, undefined, undefined);
}

async function accept(
  store: AutoCommitStore,
  policy: ResolvedAutoCommitPolicy,
  deliveryKey: string,
  base: string,
  head: string,
  now: number,
  delaySeconds = 0,
  workspaceId = "ws1",
): Promise<void> {
  const result = await store.acceptReceipt({
    deliveryKey,
    workspaceId,
    triggerName: "gitea",
    provider: "gitea",
    vcs: "git",
    sourceNamespace: "git:example.com/org/repo",
    scopeRef: "refs/heads/main",
    historyGeneration: 0,
    coverage: { kind: "range", base, head },
    envelope: { repoRef: "org/repo" },
    delaySeconds,
    policyVersion: policy.policyVersion,
    now,
  });
  if (result.duplicate) throw new Error(`duplicate delivery ${deliveryKey}`);
}

function makeScheduler(options: {
  store: AutoCommitStore;
  adapter: ScriptedAdapter;
  policy: ResolvedAutoCommitPolicy;
  executed: BatchExecutionContext[];
  now: () => number;
  failExecutions?: number;
  tuning?: Partial<ConstructorParameters<typeof AutoCommitScheduler>[0]>;
}): AutoCommitScheduler {
  let failuresLeft = options.failExecutions ?? 0;
  return new AutoCommitScheduler({
    store: options.store,
    getPolicy: () => options.policy,
    getAdapter: () => options.adapter as never,
    executeBatch: async (context) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("scripted execution failure");
      }
      options.executed.push(context);
    },
    now: options.now,
    batchMaxAttempts: 2,
    dispatchRetryBaseMs: 1_000,
    ...options.tuning,
  });
}

const alice = { authorName: "Alice", authorEmail: "alice@example.com" };

describe("AutoCommitScheduler", () => {
  it("uses receipt snapshots for metadata and splits batches on the snapshot boundary", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([{ sha: "A1", parents: ["A0"], ...alice }, { sha: "A2", parents: ["A1"], ...alice }]);
    const getAdapter = vi.fn(async () => adapter as never);
    const executed: BatchExecutionContext[] = [];
    for (const [index, snapshot] of ["cfg-first", "cfg-second"].entries()) {
      await store.acceptReceipt({ deliveryKey: `snapshot-${index}`, workspaceId: "ws1", triggerName: "gitea",
        provider: "gitea", vcs: "git", sourceNamespace: "git:example.com/org/repo", scopeRef: "refs/heads/main", historyGeneration: 0,
        coverage: { kind: "range", base: `A${index}`, head: `A${index + 1}` }, envelope: { repoRef: "org/repo" },
        delaySeconds: 0, policyVersion: policy.policyVersion, configSnapshotId: snapshot, now: T0 });
    }
    const scheduler = makeScheduler({ store, policy, adapter, executed, now: () => T0, tuning: { getAdapter } });
    for (let i = 0; i < 5; ++i) await scheduler.tick();
    expect(getAdapter.mock.calls.map(call => (call as unknown[])[1])).toEqual(expect.arrayContaining(["cfg-first", "cfg-second"]));
    expect(executed.map(ctx => ctx.batch.configSnapshotId)).toEqual(["cfg-first", "cfg-second"]);
    expect(executed.flatMap(ctx => ctx.members.map(member => member.revision))).toEqual(["A1", "A2"]);
  });
  it("isolates a stream whose pinned snapshot fails to resolve and still serves healthy streams", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const store = createMemoryAutoCommitStore();
      const policy = makePolicy({ delay_seconds: 0 });
      const adapter = new ScriptedAdapter([
        { sha: "A0", parents: [] , ...alice },
        { sha: "A1", parents: ["A0"], ...alice },
        { sha: "B0", parents: [] , ...alice },
        { sha: "B1", parents: ["B0"], ...alice },
      ]);
      const executed: BatchExecutionContext[] = [];
      await store.acceptReceipt({ deliveryKey: "healthy", workspaceId: "ws1", triggerName: "gitea",
        provider: "gitea", vcs: "git", sourceNamespace: "git:example.com/org/one", scopeRef: "refs/heads/main", historyGeneration: 0,
        coverage: { kind: "range", base: "A0", head: "A1" }, envelope: { repoRef: "org/one" },
        delaySeconds: 0, policyVersion: policy.policyVersion, configSnapshotId: "cfg-good", now: T0 });
      await store.acceptReceipt({ deliveryKey: "broken", workspaceId: "ws2", triggerName: "gitea",
        provider: "gitea", vcs: "git", sourceNamespace: "git:example.com/org/two", scopeRef: "refs/heads/main", historyGeneration: 0,
        coverage: { kind: "range", base: "B0", head: "B1" }, envelope: { repoRef: "org/two" },
        delaySeconds: 0, policyVersion: policy.policyVersion, configSnapshotId: "cfg-broken", now: T0 });
      const getAdapter = vi.fn(async (stream: { workspaceId: string }) => {
        if (stream.workspaceId === "ws2") {
          throw new Error("snapshot_invalid: Config snapshot content hash mismatch.");
        }
        return adapter as never;
      });
      let now = T0;
      const scheduler = makeScheduler({ store, policy, adapter, executed, now: () => now, tuning: { getAdapter } });
      await scheduler.tick();
      // The healthy stream sealed and executed despite the sibling throwing.
      expect(executed).toHaveLength(1);
      expect(executed[0]!.batch.workspaceId).toBe("ws1");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("auto-commit stream processing failed"));
      // The failing stream is retried after its persisted backoff, not dropped.
      now += 5_000;
      await scheduler.tick();
      expect(getAdapter.mock.calls.filter((call) => (call[0] as { workspaceId: string }).workspaceId === "ws2").length).toBeGreaterThan(1);
    } finally {
      warn.mockRestore();
    }
  });
  it("backs off a broken stream so another stream in the same workspace passes a bounded scan", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const store = createMemoryAutoCommitStore();
      const policy = makePolicy({ delay_seconds: 0 });
      const adapter = new ScriptedAdapter([
        { sha: "A1", parents: ["A0"], ...alice },
        { sha: "B1", parents: ["B0"], ...alice },
      ]);
      const executed: BatchExecutionContext[] = [];
      let now = T0 + 1;
      for (const [name, base, acceptedAt] of [
        ["broken", "A0", T0], ["healthy", "B0", T0 + 1],
      ] as const) {
        await store.acceptReceipt({ deliveryKey: name, workspaceId: "ws1", triggerName: "gitea",
          provider: "gitea", vcs: "git", sourceNamespace: `git:example.com/org/${name}`, scopeRef: "refs/heads/main", historyGeneration: 0,
          coverage: { kind: "range", base, head: base === "A0" ? "A1" : "B1" }, envelope: { repoRef: `org/${name}` },
          delaySeconds: 0, policyVersion: policy.policyVersion, configSnapshotId: name, now: acceptedAt });
      }
      let broken = true;
      const getAdapter = vi.fn(async (_stream: unknown, snapshot: string | null | undefined) => {
        if (snapshot === "broken" && broken) throw new Error("snapshot_invalid");
        return adapter as never;
      });
      const scheduler = makeScheduler({ store, policy, adapter, executed, now: () => now,
        tuning: { streamScanLimit: 1, getAdapter } });
      await scheduler.tick();
      expect(executed).toHaveLength(0);
      const brokenHead = (await store.readStreamHeads("ws1", 2)).find(head => head.sourceNamespace.endsWith("/broken"));
      expect(brokenHead?.resumeNotBefore).toBeGreaterThan(now);
      await scheduler.tick();
      expect(executed.map(ctx => ctx.batch.sourceNamespace)).toEqual(["git:example.com/org/healthy"]);
      broken = false;
      now = brokenHead!.resumeNotBefore!;
      await scheduler.tick();
      expect(executed.map(ctx => ctx.batch.sourceNamespace)).toEqual([
        "git:example.com/org/healthy", "git:example.com/org/broken",
      ]);
    } finally {
      warn.mockRestore();
    }
  });
  it("keeps a failed stream's backoff across SQLite scheduler restarts", async () => {
    const temporaryRoot = join(process.cwd(), "build", "tmp");
    await mkdir(temporaryRoot, { recursive: true });
    const dir = await mkdtemp(join(temporaryRoot, "auto-commit-backoff-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let store: AutoCommitStore | undefined;
    try {
      const policy = makePolicy({ delay_seconds: 0 });
      const adapter = new ScriptedAdapter([
        { sha: "A1", parents: ["A0"], ...alice },
        { sha: "B1", parents: ["B0"], ...alice },
      ]);
      const dbPath = join(dir, "auto-commit.sqlite");
      let now = T0 + 1;
      store = await createSqliteAutoCommitStore({ path: dbPath });
      for (const [name, base, acceptedAt] of [
        ["broken", "A0", T0], ["healthy", "B0", T0 + 1],
      ] as const) {
        await store.acceptReceipt({ deliveryKey: name, workspaceId: "ws1", triggerName: "gitea",
          provider: "gitea", vcs: "git", sourceNamespace: `git:example.com/org/${name}`, scopeRef: "refs/heads/main", historyGeneration: 0,
          coverage: { kind: "range", base, head: base === "A0" ? "A1" : "B1" }, envelope: { repoRef: `org/${name}` },
          delaySeconds: 0, policyVersion: policy.policyVersion, configSnapshotId: name, now: acceptedAt });
      }
      const getAdapter = vi.fn(async (_stream: unknown, snapshot: string | null | undefined) => {
        if (snapshot === "broken") throw new Error("snapshot_invalid");
        return adapter as never;
      });
      const first = makeScheduler({ store, policy, adapter, executed: [], now: () => now,
        tuning: { streamScanLimit: 1, getAdapter } });
      await first.tick();
      const failed = (await store.readStreamHeads("ws1", 2)).find(head => head.sourceNamespace.endsWith("/broken"));
      expect(failed?.resumeNotBefore).toBe(T0 + 1 + 5_000);
      store.close?.();
      store = await createSqliteAutoCommitStore({ path: dbPath });
      const executed: BatchExecutionContext[] = [];
      const restarted = makeScheduler({ store, policy, adapter, executed, now: () => now,
        tuning: { streamScanLimit: 1, getAdapter } });
      await restarted.tick();
      expect(executed.map(ctx => ctx.batch.sourceNamespace)).toEqual(["git:example.com/org/healthy"]);
      now = failed!.resumeNotBefore!;
      await restarted.tick();
      expect(getAdapter.mock.calls.filter(call => call[1] === "broken")).toHaveLength(2);
    } finally {
      store?.close?.();
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("backs off missing adapters and records terminal failure instead of continuously polling", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    let now = T0;
    const scheduler = new AutoCommitScheduler({
      store,
      getPolicy: () => policy,
      getAdapter: () => undefined,
      executeBatch: vi.fn(),
      now: () => now,
      maxExpansionAttempts: 2,
      dispatchRetryBaseMs: 1000,
    });
    await accept(store, policy, "no-adapter", "A0", "A1", now);
    await scheduler.tick();
    expect((await store.readNextWake())?.at).toBe(T0 + 1000);
    const stream = (await store.readStreamHeads("ws1", 1))[0]!;
    const receipt = (
      await store.readStreamReceipts(
        stream.streamId,
        0,
        Number.MAX_SAFE_INTEGER,
        1,
      )
    )[0]!;
    await scheduler.tick();
    expect(
      (await store.getReceipt(receipt.receiptId))?.receipt.metadataAttempts,
    ).toBe(1);
    now += 1000;
    await scheduler.tick();
    expect(
      (await store.getReceipt(receipt.receiptId))?.receipt
        .metadataTerminalError,
    ).toBe("metadata_adapter_unavailable");
    expect(await store.readNextWake()).toBeUndefined();
  });

  it("refreshes missing evidence with bounded retries after the exclusion policy changes", async () => {
    const store = createMemoryAutoCommitStore();
    let policy = makePolicy({ delay_seconds: 0 });
    let now = T0;
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => now,
      tuning: { getPolicy: () => policy, maxExpansionAttempts: 2 },
    });
    await accept(store, policy, "policy-change", "A0", "A1", now, 120);
    const stream = (await store.readStreamHeads("ws1", 1))[0]!;
    const receipt = (
      await store.readStreamReceipts(
        stream.streamId,
        0,
        Number.MAX_SAFE_INTEGER,
        1,
      )
    )[0]!;
    // A page expanded under the old policy but not yet sealed.
    await store.applyMetadataPage({
      streamId: stream.streamId,
      receiptId: receipt.receiptId,
      now,
      members: [
        {
          revision: "A1",
          orderKey: "000000000001",
          parents: ["A0"],
          sourceSnapshot: {
            v: 1,
            vcs: "git",
            sourceNamespace: stream.sourceNamespace,
            revision: "A1",
            command: "git log",
            observedAt: now,
            rulesVersion: policy.policyVersion,
            sourceKey: computeSourceKey(stream.sourceNamespace, {
              vcs: "git",
              ...alice,
            }),
            status: "known",
            fields: {
              authorName: { status: "known", value: alice.authorName },
              authorEmail: { status: "known", value: alice.authorEmail },
            },
          },
        },
      ],
    });
    const head = (await store.readStreamHead(stream.streamId))!;
    await store.updateStreamHead(
      stream.streamId,
      head.version,
      { coverageCursor: receipt.receiptSeq },
      now,
    );
    policy = makePolicy({
      delay_seconds: 0,
      exclude_sources: [
        { id: "ci", vcs: "git", match: { committer_email: { glob: "ci@*" } } },
      ],
    });
    now += 120_000;
    await scheduler.tick();
    expect(adapter.calls).toHaveLength(1);
    expect((await store.readNextWake())?.at).toBe(now + 1000);
    now += 1000;
    await scheduler.tick();
    expect(adapter.calls).toHaveLength(2);
    expect(
      (await store.getReceipt(receipt.receiptId))?.memberCounts.failed,
    ).toBe(1);
    expect(executed).toEqual([]);
  });

  it.each(["p4", "svn"] as const)(
    "uses the preceding numeric endpoint for a single %s notification",
    async (vcs) => {
      const store = createMemoryAutoCommitStore();
      const policy = makePolicy({ delay_seconds: 0 });
      const listCommitMetadataPage = vi.fn().mockResolvedValue({
        vcs,
        status: "complete",
        records: [
          {
            revision: "10",
            orderKey: "000000000010",
            parents: [],
            changedPaths: [],
            p4User: "alice",
            p4Client: "task-client",
            svnAuthor: "alice",
          },
        ],
      });
      const executed: BatchExecutionContext[] = [];
      const scheduler = new AutoCommitScheduler({
        store,
        getPolicy: () => policy,
        getAdapter: () => ({ kind: vcs, listCommitMetadataPage }) as never,
        now: () => T0,
        executeBatch: async (context) => {
          executed.push(context);
        },
      });
      await store.acceptReceipt({
        deliveryKey: "single",
        workspaceId: "ws1",
        triggerName: vcs,
        provider: vcs,
        vcs,
        sourceNamespace: "repo",
        scopeRef: "scope",
        historyGeneration: 0,
        coverage: { kind: "single", revision: "10" },
        envelope: {},
        delaySeconds: 0,
        policyVersion: policy.policyVersion,
        now: T0,
      });
      await scheduler.tick();
      expect(listCommitMetadataPage).toHaveBeenCalledWith(
        expect.objectContaining({ baseRevision: "9", headRevision: "10" }),
      );
      expect(executed).toHaveLength(1);
      expect(executed[0]?.batch).toMatchObject({ base: "9", head: "10" });
    },
  );

  it("does not fetch metadata outside the allowed window", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({
      delay_seconds: 0,
      schedule: {
        timezone: "UTC",
        rules: [{ days: ["mon"], windows: [{ start: "18:00", end: "24:00" }] }],
      },
    });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    const now = Date.UTC(2026, 8, 7, 12);
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => now,
    });
    await accept(store, policy, "closed", "A0", "A1", now);
    await scheduler.tick();
    expect(adapter.calls).toEqual([]);
    expect(executed).toEqual([]);
    expect((await store.readNextWake())?.at).toBe(Date.UTC(2026, 8, 7, 18));
  });

  it("keeps a fixed assembly frontier under continuous new notifications", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter(
      Array.from({ length: 7 }, (_, i) => ({
        sha: `A${i + 1}`,
        parents: [`A${i}`],
        ...alice,
      })),
    );
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
      tuning: { receiptPageSize: 1 },
    });
    for (let i = 1; i <= 3; i++)
      await accept(store, policy, `d${i}`, `A${i - 1}`, `A${i}`, T0);
    for (let i = 4; i <= 6; i++) {
      await scheduler.tick();
      await accept(store, policy, `d${i}`, `A${i - 1}`, `A${i}`, T0);
    }
    expect(executed.map((x) => x.members.map((m) => m.revision))).toEqual([
      ["A1", "A2", "A3"],
    ]);
    for (let i = 0; i < 4; i++) await scheduler.tick();
    expect(executed.map((x) => x.members.map((m) => m.revision))).toEqual([
      ["A1", "A2", "A3"],
      ["A4", "A5", "A6"],
    ]);
  });

  it("persists metadata retry budgets and wake times across scheduler restarts", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    adapter.unavailable = true;
    const executed: BatchExecutionContext[] = [];
    let now = T0;
    await accept(store, policy, "retry", "A0", "A1", now);
    for (let attempt = 0; attempt < 3; attempt++) {
      const scheduler = makeScheduler({
        store,
        adapter,
        policy,
        executed,
        now: () => now,
        tuning: { maxExpansionAttempts: 3 },
      });
      await scheduler.tick();
      await scheduler.tick();
      expect(adapter.calls).toHaveLength(attempt + 1);
      now += 1_000 * 2 ** attempt;
    }
    const stream = (await store.readStreamHeads("ws1", 1))[0]!;
    const receipt = (
      await store.readStreamReceipts(
        stream.streamId,
        0,
        Number.MAX_SAFE_INTEGER,
        1,
      )
    )[0]!;
    expect(receipt.metadataAttempts).toBe(3);
    expect(receipt.metadataTerminalError).toBe("scripted outage");
    expect(stream.coverageCursor).toBe(receipt.receiptSeq);
    expect(executed).toEqual([]);
  });

  it("does not allow unknown committer evidence to bypass an exclusion rule", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({
      delay_seconds: 0,
      exclude_sources: [
        { id: "ci", vcs: "git", match: { committer_email: { glob: "ci@*" } } },
      ],
    });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    let now = T0;
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => now,
      tuning: { maxExpansionAttempts: 2 },
    });
    await accept(store, policy, "unknown", "A0", "A1", now);
    await scheduler.tick();
    expect(executed).toEqual([]);
    now += 1_000;
    await scheduler.tick();
    const stream = (await store.readStreamHeads("ws1", 1))[0]!;
    const receipt = (
      await store.readStreamReceipts(
        stream.streamId,
        0,
        Number.MAX_SAFE_INTEGER,
        1,
      )
    )[0]!;
    expect(
      (await store.getReceipt(receipt.receiptId))?.memberCounts.failed,
    ).toBe(1);
    expect(executed).toEqual([]);
  });

  it("loads every sealed member after a receipt grows beyond 512 members without association fanout", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter(
      Array.from({ length: 550 }, (_, i) => ({
        sha: `A${i + 1}`,
        parents: [`A${i}`],
        ...alice,
      })),
    );
    const executed: BatchExecutionContext[] = [];
    const fanout = vi.spyOn(store, "readMemberReceipts");
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
    });
    await accept(store, policy, "large", "A0", "A550", T0);
    for (let i = 0; i < 12; i++) await scheduler.tick();
    expect(executed).toHaveLength(11);
    expect(executed.flatMap((x) => x.members.map((m) => m.revision))).toEqual(
      Array.from({ length: 550 }, (_, i) => `A${i + 1}`),
    );
    expect(fanout).not.toHaveBeenCalled();
  });

  it("rechecks the current time before starting the next dispatched batch", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({
      delay_seconds: 0,
      schedule: {
        timezone: "UTC",
        rules: [{ days: ["mon"], windows: [{ start: "12:00", end: "13:00" }] }],
      },
    });
    let now = Date.UTC(2026, 8, 7, 12, 59, 59);
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => now,
      tuning: {
        executeBatch: async (context) => {
          executed.push(context);
          now = Date.UTC(2026, 8, 7, 13, 0, 1);
        },
      },
    });
    await accept(store, policy, "w1", "A0", "A1", now, 0, "ws1");
    await accept(store, policy, "w2", "A0", "A1", now, 0, "ws2");
    await scheduler.tick();
    expect(executed).toHaveLength(1);
    expect((await store.readNextWake())?.at).toBe(Date.UTC(2026, 8, 14, 12));
  });

  it("aborts the running batch on drain, re-queues it, and starts no later batch", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
      tuning: {
        // An execution that ignores the abort signal is the worst case: the
        // drain still cannot complete the batch, so it must be left for the
        // lease-expiry reclaim of the next process start.
        executeBatch: async (context) => {
          executed.push(context);
          entered.resolve();
          await release.promise;
        },
      },
    });
    await accept(store, policy, "w1", "A0", "A1", T0, 0, "ws1");
    await accept(store, policy, "w2", "A0", "A1", T0, 0, "ws2");
    const tick = scheduler.tick();
    await entered.promise;
    expect(executed[0]?.signal).toBeDefined();
    expect(executed[0]?.signal?.aborted).toBe(false);
    let drained = false;
    const drain = scheduler.stopAndDrain().then(() => {
      drained = true;
    });
    // The drain aborts in-flight executions immediately; only the stubborn
    // (signal-ignoring) execution keeps the tick pending.
    expect(executed[0]?.signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await Promise.all([tick, drain]);
    expect(drained).toBe(true);
    expect(executed).toHaveLength(1);
    // The aborted execution must not be recorded as completed.
    const batch = await store.readBatch(executed[0]!.batch.batchId);
    expect(batch?.status).toBe("running");
    // The next process start reclaims the expired lease and retries.
    const reclaimed = await store.reclaimExpiredBatchLeases(
      (batch?.leaseExpiry ?? T0) + 1,
      10,
    );
    expect(reclaimed).toEqual([executed[0]!.batch.batchId]);
    expect(
      (await store.readBatch(executed[0]!.batch.batchId))?.status,
    ).toBe("retry_wait");
  });

  it("re-queues an abort-aware execution immediately on drain", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    const entered = Promise.withResolvers<void>();
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
      tuning: {
        executeBatch: async (context) => {
          executed.push(context);
          entered.resolve();
          // Real executions observe the abort signal and fail fast; the
          // scheduler converts that into an immediate retry_wait re-queue.
          await new Promise<never>((_resolve, reject) => {
            context.signal?.addEventListener("abort", () =>
              reject(new Error("interrupted_by_shutdown")),
            );
          });
        },
      },
    });
    await accept(store, policy, "w1", "A0", "A1", T0, 0, "ws1");
    const tick = scheduler.tick();
    await entered.promise;
    await scheduler.stopAndDrain();
    await tick;
    const batch = await store.readBatch(executed[0]!.batch.batchId);
    expect(batch?.status).toBe("retry_wait");
    expect(batch?.lastError).toBe("interrupted_by_shutdown");
  });

  it("does not reinterpret an excluded ordinary prefix as a mixed-source rewrite", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({
      delay_seconds: 0,
      exclude_sources: [
        { id: "bots", vcs: "git", match: { author_email: { glob: "bot@*" } } },
      ],
    });
    const adapter = new ScriptedAdapter([
      {
        sha: "bot",
        parents: ["A0"],
        authorName: "Bot",
        authorEmail: "bot@example.com",
      },
      { sha: "A1", parents: ["bot"], ...alice },
      {
        sha: "B1",
        parents: ["A1"],
        authorName: "Bob",
        authorEmail: "bob@example.com",
      },
    ]);
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
    });
    await accept(store, policy, "ordinary", "A0", "B1", T0);
    await scheduler.tick();
    await scheduler.tick();
    expect(executed.map((x) => x.members.map((m) => m.revision))).toEqual([
      ["A1"],
      ["B1"],
    ]);
  });

  it("merges contiguous same-source commits across notifications into one batch", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
      { sha: "A2", parents: ["A1"], ...alice },
      { sha: "A3", parents: ["A2"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
    });

    await accept(store, policy, "d1", "A0", "A2", T0);
    await accept(store, policy, "d2", "A2", "A3", T0);
    await scheduler.tick();

    expect(executed).toHaveLength(1);
    expect(executed[0]?.members.map((member) => member.revision)).toEqual([
      "A1",
      "A2",
      "A3",
    ]);
    expect(executed[0]?.batch.base).toBe("A0");
    expect(executed[0]?.batch.head).toBe("A3");
    const stored = await store.readBatch(executed[0]?.batch.batchId ?? "");
    expect(stored?.status).toBe("completed");
    const heads = await store.readStreamHeads("ws1", 8);
    expect(heads[0]?.activeBatchId).toBeNull();
  });

  it("waits for the first-receive delay before sealing", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 120 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    let now = T0;
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => now,
    });

    await accept(store, policy, "d1", "A0", "A1", now, 120);
    await scheduler.tick();
    expect(executed).toHaveLength(0);

    now = T0 + 120_000;
    await scheduler.tick();
    expect(executed).toHaveLength(1);
  });

  it("excludes bot commits and cuts the run at the exclusion gap", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({
      delay_seconds: 0,
      exclude_sources: [
        { id: "bots", vcs: "git", match: { author_email: { glob: "*bot*" } } },
      ],
    });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
      {
        sha: "B1",
        parents: ["A1"],
        authorName: "Bot",
        authorEmail: "bot@example.com",
      },
      { sha: "A2", parents: ["B1"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
    });

    await accept(store, policy, "d1", "A0", "A2", T0);
    await scheduler.tick();
    // One active batch per stream: the second cut seals on the next tick,
    // after the first batch completes and clears activeBatchId.
    await scheduler.tick();

    expect(
      executed.map((context) =>
        context.members.map((member) => member.revision),
      ),
    ).toEqual([["A1"], ["A2"]]);
    const receipts = await store.readStreamReceipts(
      executed[0]?.batch.streamId ?? "",
      0,
      Number.MAX_SAFE_INTEGER,
      8,
    );
    const view = await store.getReceipt(receipts[0]?.receiptId ?? "");
    expect(view?.memberCounts.skipped).toBe(1);
  });

  it("isolates a force-push rewrite event into its own batch", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    // Receipt 2's coverage claims base A2, but the rewritten head's first
    // parent is A0 — the link break marks the whole event as a rewrite.
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
      { sha: "A2", parents: ["A1"], ...alice },
      {
        sha: "R1",
        parents: ["A0"],
        authorName: "Bob",
        authorEmail: "bob@example.com",
      },
      { sha: "R2", parents: ["R1"], ...alice },
    ]);
    // Custom walk: R2's chain from head R2 → R1 → A0 (base A2 never visited).
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
    });

    await accept(store, policy, "d1", "A0", "A2", T0);
    await scheduler.tick();
    expect(executed).toHaveLength(1);

    await accept(store, policy, "d2", "A2", "R2", T0);
    await scheduler.tick();
    expect(executed).toHaveLength(2);
    const rewriteBatch = executed[1];
    expect(rewriteBatch?.members.map((member) => member.revision)).toEqual([
      "R1",
      "R2",
    ]);
    expect(rewriteBatch?.batch.sourceKey).not.toBe(
      executed[0]?.batch.sourceKey,
    );
  });

  it("defers sealing outside the execution window to the next allowed instant", async () => {
    const store = createMemoryAutoCommitStore();
    // Allowed only on Mondays 00:00-24:00 UTC; T0 is a Tuesday.
    const tuesday = Date.UTC(2023, 10, 14, 12, 0, 0); // 2023-11-14 was a Tuesday
    const policy = makePolicy({
      delay_seconds: 0,
      schedule: {
        timezone: "UTC",
        rules: [{ days: ["mon"], windows: [{ start: "00:00", end: "24:00" }] }],
      },
    });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    let now = tuesday;
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => now,
    });

    await accept(store, policy, "d1", "A0", "A1", now);
    await scheduler.tick();
    expect(executed).toHaveLength(0);

    now = Date.UTC(2023, 10, 20, 1, 0, 0); // next Monday
    await scheduler.tick();
    expect(executed).toHaveLength(1);
  });

  it("retries a failed batch inside the window and recovers instead of dying", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
      { sha: "A2", parents: ["A1"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    let now = T0;
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => now,
      failExecutions: 2,
    });

    await accept(store, policy, "d1", "A0", "A1", now);
    await scheduler.tick();
    const streamId = (await store.readStreamHeads("ws1", 8))[0]?.streamId ?? "";
    let batch = await store.readBatch(
      (await store.readStreamHead(streamId))?.activeBatchId ?? "",
    );
    expect(batch?.status).toBe("retry_wait");
    expect(batch?.attempt).toBe(1);
    expect(batch?.recoveryAttempt).toBe(0);
    expect(batch?.retryNotBefore).not.toBeNull();
    expect(executed).toHaveLength(0);

    // Second failure exhausts the budget -> the single automatic recovery
    // re-arms the batch (attempt reset) instead of persisting a dead row
    // that jams the stream; the recovery outbox entry is due immediately, so
    // the same tick re-dispatches it and the recovery attempt succeeds.
    now = (batch?.retryNotBefore ?? now) + 1;
    await scheduler.tick();
    batch = await store.readBatch(batch?.batchId ?? "");
    expect(batch?.status).toBe("completed");
    expect(batch?.recoveryAttempt).toBe(1);
    expect(executed).toHaveLength(1);

    // A later webhook assembles into a fresh batch once the stream freed; it
    // seals, executes, and completes inside the same tick (the terminal batch
    // releases the stream, so the head's activeBatchId is null again).
    await accept(store, policy, "d2", "A1", "A2", now + 1);
    now += 1;
    await scheduler.tick();
    const batches = await store.readBatchesByStatus(
      ["completed", "skipped", "dead", "retry_wait", "running", "queued", "dispatch_pending"],
      10,
    );
    expect(batches).toHaveLength(2);
    const successor = batches.find((entry) => entry.batchId !== batch?.batchId);
    expect(successor?.status).toBe("completed");
    expect(successor?.head).toBe("A2");
    expect(executed).toHaveLength(2);
  });

  it("notifies onBatchTerminal once when the recovery is spent and the batch skips", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    const terminal: { runId: string; error: string }[] = [];
    let now = T0;
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => now,
      // Every execution fails: retries exhaust the attempt budget, the single
      // automatic recovery re-arms once, and its exhausted budget terminally
      // skips the batch — only that final skip may notify.
      failExecutions: 99,
      tuning: {
        onBatchTerminal: async (context, error) => {
          terminal.push({ runId: context.batch.runId, error });
        },
      },
    });

    await accept(store, policy, "d1", "A0", "A1", now);
    await scheduler.tick();
    let batch = (await store.readBatchesByStatus(["retry_wait", "skipped", "completed", "dead"], 10))[0]!;
    for (let round = 0; round < 6 && batch.status !== "skipped"; round += 1) {
      // Retry/recovery re-arms schedule at or after the current tick; advance
      // past the recorded bound so the next tick dispatches again.
      now = Math.max(now + 1, (batch.retryNotBefore ?? now) + 1);
      await scheduler.tick();
      batch = (await store.readBatch(batch.batchId))!;
      // Retries and the automatic recovery are not terminal decisions; only
      // the round that flips to skipped may have notified.
      if (batch.status !== "skipped") expect(terminal).toEqual([]);
    }
    expect(batch.status).toBe("skipped");
    expect(batch.recoveryAttempt).toBe(1);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.runId).toBe(batch.runId);
    expect(terminal[0]!.error).toContain("scripted execution failure");
  });

  it("fails receipt coverage explicitly after bounded metadata retries", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
    ]);
    adapter.unavailable = true;
    const executed: BatchExecutionContext[] = [];
    let now = T0;
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => now,
      tuning: { maxExpansionAttempts: 3, dispatchRetryBaseMs: 1_000 },
    });

    await accept(store, policy, "d1", "A0", "A1", now);
    await scheduler.tick();
    now += 1_000;
    await scheduler.tick();
    now += 2_000;
    await scheduler.tick();

    const heads = await store.readStreamHeads("ws1", 8);
    expect(heads[0]?.coverageCursor).toBe(1); // consumed after exhaustion
    expect(executed).toHaveLength(0);
  });

  it("reclaims a crashed consumer's lease on restart without losing or duplicating members", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aicr-auto-commit-"));
    let store1: AutoCommitStore | undefined;
    let store2: AutoCommitStore | undefined;
    try {
      const dbPath = join(dir, "auto-commit.sqlite");
      const policy = makePolicy({ delay_seconds: 0 });
      const adapter = new ScriptedAdapter([
        { sha: "A1", parents: ["A0"], ...alice },
      ]);
      const leaseMs = 1_000;
      let now = T0;

      // Process 1: accepts, seals, starts executing, then dies mid-flight —
      // the executeBatch promise never settles and no failBatch is called.
      store1 = await createSqliteAutoCommitStore({ path: dbPath });
      const crashGate = Promise.withResolvers<BatchExecutionContext>();
      const scheduler1 = new AutoCommitScheduler({
        store: store1,
        getPolicy: () => policy,
        getAdapter: () => adapter as never,
        executeBatch: async (context) => {
          crashGate.resolve(context);
          await Promise.withResolvers<void>().promise;
        },
        now: () => now,
        batchMaxAttempts: 2,
        leaseMs,
        leaseRenewMs: leaseMs * 100,
        dispatchRetryBaseMs: 1_000,
      });
      await accept(store1, policy, "d1", "A0", "A1", now);
      const inFlight = scheduler1.tick();
      void inFlight.catch(() => {});
      // Await the signal the code itself exposes: executeBatch only runs
      // after the batch lease is taken, so the crash window is now open.
      const crashed = await crashGate.promise;
      expect(crashed.members.map((member) => member.revision)).toEqual(["A1"]);
      // Closest in-process model of a dead consumer: the loop stops, the
      // lease stays dangling, and the store file keeps every record.
      scheduler1.stop();

      // Process 2: a fresh connection to the same file with a later clock.
      now += leaseMs + 60_000;
      store2 = await createSqliteAutoCommitStore({ path: dbPath });
      const executed: BatchExecutionContext[] = [];
      const scheduler2 = makeScheduler({
        store: store2,
        adapter,
        policy,
        executed,
        now: () => now,
      });
      await scheduler2.tick();
      scheduler2.stop();

      expect(executed).toHaveLength(1);
      expect(executed[0]?.batch.batchId).toBe(crashed.batch.batchId);
      expect(executed[0]?.members.map((member) => member.revision)).toEqual([
        "A1",
      ]);
      const stored = await store2.readBatch(crashed.batch.batchId);
      expect(stored?.status).toBe("completed");
    } finally {
      store1?.close?.();
      store2?.close?.();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("seals a 17-notification contiguous run as one batch across expansion page bounds", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const commits = Array.from({ length: 17 }, (_, i) => ({
      sha: `A${i + 1}`,
      parents: [`A${i}`],
      ...alice,
    }));
    const adapter = new ScriptedAdapter(commits);
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
    });

    // Each commit arrives as its own notification — the N05 shape, one run.
    for (let i = 0; i < 17; i += 1) {
      await accept(store, policy, `d${i}`, `A${i}`, `A${i + 1}`, T0);
    }
    // The first tick expands only the first receipt page (16) and must not
    // treat that read bound as a batch boundary; the next tick catches up.
    for (let i = 0; i < 5 && executed.length === 0; i += 1) {
      await scheduler.tick();
    }

    expect(executed).toHaveLength(1);
    expect(executed[0]?.members.map((member) => member.revision)).toEqual(
      commits.map((commit) => commit.sha),
    );
    expect(executed[0]?.batch.base).toBe("A0");
    expect(executed[0]?.batch.head).toBe("A17");
  });

  it("expands a stream whose receipt seqs are interleaved with another stream", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
      { sha: "A2", parents: ["A1"], ...alice },
      { sha: "B1", parents: ["B0"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
    });

    await accept(store, policy, "w1-d1", "A0", "A1", T0);
    // A busy second stream consumes the global receipt sequence, leaving
    // ws1's second receipt far beyond any dense per-stream window.
    for (let i = 0; i < 20; i += 1) {
      await accept(store, policy, `w2-d${i}`, "B0", "B1", T0, 0, "ws2");
    }
    await accept(store, policy, "w1-d2", "A1", "A2", T0);
    for (let i = 0; i < 6 && executed.length < 2; i += 1) {
      await scheduler.tick();
    }

    const runs = executed
      .map((context) => context.members.map((member) => member.revision))
      .sort();
    expect(runs).toEqual([["A1", "A2"], ["B1"]]);
  });

  it("resumes a metadata-paged range across ticks without losing the tail", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
    const adapter = new ScriptedAdapter([
      { sha: "A1", parents: ["A0"], ...alice },
      { sha: "A2", parents: ["A1"], ...alice },
      { sha: "A3", parents: ["A2"], ...alice },
      { sha: "A4", parents: ["A3"], ...alice },
      { sha: "A5", parents: ["A4"], ...alice },
    ]);
    const executed: BatchExecutionContext[] = [];
    const scheduler = makeScheduler({
      store,
      adapter,
      policy,
      executed,
      now: () => T0,
      tuning: { metadataPageSize: 2, maxMetadataPagesPerReceipt: 1 },
    });

    await accept(store, policy, "d1", "A0", "A5", T0);
    // One page per tick: [A1,A2], resume [A3,A4], resume [A5], then seal.
    for (let i = 0; i < 6 && executed.length === 0; i += 1) {
      await scheduler.tick();
    }

    expect(executed).toHaveLength(1);
    expect(executed[0]?.members.map((member) => member.revision)).toEqual([
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
    ]);
    expect(adapter.calls.some((call) => call.cursor === "A3")).toBe(true);
  });
});
