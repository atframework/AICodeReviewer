import { mkdtemp, rm } from "node:fs/promises";
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

  it("waits for the running batch when draining and starts no later batch", async () => {
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
    let drained = false;
    const drain = scheduler.stopAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await Promise.all([tick, drain]);
    expect(drained).toBe(true);
    expect(executed).toHaveLength(1);
    expect((await store.readBatch(executed[0]!.batch.batchId))?.status).toBe(
      "completed",
    );
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

  it("retries a failed batch inside the window and dies after max attempts", async () => {
    const store = createMemoryAutoCommitStore();
    const policy = makePolicy({ delay_seconds: 0 });
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
      failExecutions: 2,
    });

    await accept(store, policy, "d1", "A0", "A1", now);
    await scheduler.tick();
    const streamId = (await store.readStreamHeads("ws1", 8))[0]?.streamId ?? "";
    let batch = await store.readBatch(
      (await store.readStreamHead(streamId))?.activeBatchId ?? "",
    );
    expect(batch?.status).toBe("retry_wait");
    expect(batch?.retryNotBefore).not.toBeNull();

    // Second attempt fails -> dead; members die with the batch (no re-group).
    now = (batch?.retryNotBefore ?? now) + 1;
    await scheduler.tick();
    batch = await store.readBatch(batch?.batchId ?? "");
    expect(batch?.status).toBe("dead");
    expect(executed).toHaveLength(0);
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
