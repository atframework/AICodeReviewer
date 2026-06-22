import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSqliteQueue, type ReviewQueue, type QueueBackoffConfig } from "../src/index.js";

function makeTmpPath(): string {
  return join(tmpdir(), `aicr-queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

const noBackoff: QueueBackoffConfig = { kind: "constant", baseMs: 0, maxMs: 0, jitter: false };

describe("createSqliteQueue", () => {
  let queue: ReviewQueue;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpPath();
  });

  afterEach(() => {
    queue?.close?.();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });

  async function setup(): Promise<ReviewQueue> {
    queue = await createSqliteQueue({ path: dbPath });
    return queue;
  }

  describe("kind", () => {
    it("returns sqlite", async () => {
      queue = await setup();
      expect(queue.kind).toBe("sqlite");
    });
  });

  describe("enqueue", () => {
    it("enqueues a job and assigns an id", async () => {
      queue = await setup();
      const job = await queue.enqueue({ pr: 42 }, { workspaceId: "ws1", triggerName: "gitea" });
      expect(job.id).toBeTruthy();
      expect(job.status).toBe("queued");
      expect(job.workspaceId).toBe("ws1");
      expect(job.triggerName).toBe("gitea");
      expect(job.attempt).toBe(0);
      expect(job.data).toEqual({ pr: 42 });
    });

    it("uses default maxAttempts of 3", async () => {
      queue = await setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "test" });
      expect(job.maxAttempts).toBe(3);
    });

    it("respects custom maxAttempts", async () => {
      queue = await setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "test", maxAttempts: 5 });
      expect(job.maxAttempts).toBe(5);
    });

    it("assigns unique ids to multiple jobs", async () => {
      queue = await setup();
      const j1 = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      const j2 = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      expect(j1.id).not.toBe(j2.id);
    });

    it("persists across queue instances", async () => {
      queue = await setup();
      const job = await queue.enqueue({ test: true }, { workspaceId: "ws1", triggerName: "t1" });
      queue.close?.();
      const queue2 = await createSqliteQueue({ path: dbPath });
      const found = await queue2.getJob(job.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(job.id);
      expect(found!.data).toEqual({ test: true });
      queue2.close?.();
    });
  });

  describe("dequeue", () => {
    it("returns undefined when queue is empty", async () => {
      queue = await setup();
      const job = await queue.dequeue("worker-1");
      expect(job).toBeUndefined();
    });

    it("returns the first enqueued job and marks it running", async () => {
      queue = await setup();
      const enqueued = await queue.enqueue({ pr: 1 }, { workspaceId: "ws1", triggerName: "t1" });
      const dequeued = await queue.dequeue("worker-1");
      expect(dequeued).toBeTruthy();
      expect(dequeued!.id).toBe(enqueued.id);
      expect(dequeued!.status).toBe("running");
      expect(dequeued!.attempt).toBe(1);
      expect(dequeued!.startedAt).toBeGreaterThan(0);
    });

    it("returns jobs in FIFO order", async () => {
      queue = await setup();
      const j1 = await queue.enqueue({ n: 1 }, { workspaceId: "ws1", triggerName: "t1" });
      const j2 = await queue.enqueue({ n: 2 }, { workspaceId: "ws1", triggerName: "t1" });
      const d1 = await queue.dequeue("w1");
      const d2 = await queue.dequeue("w1");
      expect(d1!.id).toBe(j1.id);
      expect(d2!.id).toBe(j2.id);
    });

    it("skips excluded workspaces without dropping their jobs", async () => {
      queue = await setup();
      const ws1 = await queue.enqueue({ n: 1 }, { workspaceId: "ws1", triggerName: "t1" });
      const ws2 = await queue.enqueue({ n: 2 }, { workspaceId: "ws2", triggerName: "t2" });

      const first = await queue.dequeue("w1", undefined, { excludedWorkspaceIds: ["ws1"] });
      expect(first?.id).toBe(ws2.id);
      await queue.complete(ws2.id);

      const second = await queue.dequeue("w1");
      expect(second?.id).toBe(ws1.id);
    });

    it("does not hand the same job to two workers (atomic claim)", async () => {
      queue = await setup();
      await queue.enqueue({ n: 1 }, { workspaceId: "ws1", triggerName: "t1" });

      const d1 = await queue.dequeue("w1");
      const d2 = await queue.dequeue("w2");
      expect(d1).toBeDefined();
      expect(d2).toBeUndefined();
    });

    it("reclaims a stale running job after lock TTL expires", async () => {
      const ttlQueue = await createSqliteQueue({ path: dbPath, lockTtlSeconds: 1 });
      queue = ttlQueue;
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 3 });
      const d1 = await queue.dequeue("w1");
      expect(d1).toBeDefined();

      await new Promise((r) => setTimeout(r, 1100));

      const d2 = await queue.dequeue("w2");
      expect(d2).toBeDefined();
      expect(d2!.id).toBe(job.id);
      expect(d2!.attempt).toBe(2);
    });
  });

  describe("complete", () => {
    it("marks a running job as completed", async () => {
      queue = await setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      await queue.dequeue("w1");
      await queue.complete(job.id);
      const stats = await queue.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.queued).toBe(0);
      expect(stats.running).toBe(0);
    });
  });

  describe("fail", () => {
    it("requeues a job if attempts remain", async () => {
      queue = await setup();
      const job = await queue.enqueue(
        {},
        { workspaceId: "ws1", triggerName: "t1", maxAttempts: 3, backoff: noBackoff },
      );
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("transient error"));
      const queued = await queue.getJob(job.id);
      expect(queued!.status).toBe("queued");
      expect(queued!.startedAt).toBeUndefined();

      const requeued = await queue.dequeue("w2");
      expect(requeued).toBeTruthy();
      expect(requeued!.id).toBe(job.id);
      expect(requeued!.attempt).toBe(2);
    });

    it("sends job to dead letter when maxAttempts exhausted", async () => {
      queue = await setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("fatal error"));
      const updated = await queue.getJob(job.id);
      expect(updated!.status).toBe("dead");
      expect(updated!.lastError).toBe("fatal error");
    });

    it("requeues until maxAttempts then dead-letters", async () => {
      queue = await setup();
      const job = await queue.enqueue(
        {},
        { workspaceId: "ws1", triggerName: "t1", maxAttempts: 2, backoff: noBackoff },
      );
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("e1"));
      const r2 = await queue.dequeue("w2");
      expect(r2!.attempt).toBe(2);
      await queue.fail(job.id, new Error("e2"));
      const dead = await queue.getJob(job.id);
      expect(dead!.status).toBe("dead");
    });

    it("schedules retry availability without blocking fail", async () => {
      vi.useFakeTimers();
      try {
        queue = await setup();
        const job = await queue.enqueue(
          {},
          {
            workspaceId: "ws1",
            triggerName: "t1",
            maxAttempts: 3,
            backoff: { kind: "constant", baseMs: 1000, maxMs: 1000, jitter: false },
          },
        );
        await queue.dequeue("w1");

        await queue.fail(job.id, new Error("transient"));

        expect(await queue.dequeue("w2")).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1000);
        const retried = await queue.dequeue("w2");
        expect(retried?.id).toBe(job.id);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resurrect a completed job when fail is called late", async () => {
      queue = await setup();
      const job = await queue.enqueue(
        {},
        { workspaceId: "ws1", triggerName: "t1", maxAttempts: 3, backoff: noBackoff },
      );
      await queue.dequeue("w1");
      await queue.complete(job.id);

      await queue.fail(job.id, new Error("late worker"));

      const updated = await queue.getJob(job.id);
      expect(updated!.status).toBe("completed");

      const stats = await queue.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.queued).toBe(0);
    });
  });

  describe("getStats", () => {
    it("returns correct counts for each status", async () => {
      queue = await setup();
      await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      await queue.enqueue({}, { workspaceId: "ws2", triggerName: "t2" });
      const stats = await queue.getStats();
      expect(stats.queued).toBe(2);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.dead).toBe(0);
    });
  });

  describe("getJob", () => {
    it("returns undefined for unknown id", async () => {
      queue = await setup();
      const job = await queue.getJob("nonexistent");
      expect(job).toBeUndefined();
    });

    it("returns the job for a known id", async () => {
      queue = await setup();
      const enqueued = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      const found = await queue.getJob(enqueued.id);
      expect(found!.id).toBe(enqueued.id);
    });
  });

  describe("getDeadJobs", () => {
    it("returns empty array when no dead jobs", async () => {
      queue = await setup();
      const dead = await queue.getDeadJobs();
      expect(dead).toEqual([]);
    });

    it("returns all dead jobs", async () => {
      queue = await setup();
      const j1 = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      const j2 = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      await queue.dequeue("w1");
      await queue.dequeue("w2");
      await queue.fail(j1.id, new Error("e1"));
      await queue.fail(j2.id, new Error("e2"));

      const dead = await queue.getDeadJobs();
      expect(dead).toHaveLength(2);
      expect(dead.map((j) => j.id).sort()).toEqual([j1.id, j2.id].sort());
    });

    it("does not include non-dead failed jobs", async () => {
      queue = await setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 3 });
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("retryable"));

      const dead = await queue.getDeadJobs();
      expect(dead).toHaveLength(0);
    });
  });

  describe("requeueDead", () => {
    it("requeues a dead job back to queued state", async () => {
      queue = await setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("fatal"));

      const requeued = await queue.requeueDead(job.id);
      expect(requeued).toBeDefined();
      expect(requeued!.status).toBe("queued");
      expect(requeued!.attempt).toBe(0);
      expect(requeued!.lastError).toBeUndefined();
      expect(requeued!.startedAt).toBeUndefined();
    });

    it("makes requeued job available for dequeue", async () => {
      queue = await setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("fatal"));
      await queue.requeueDead(job.id);

      const dequeued = await queue.dequeue("w1");
      expect(dequeued).toBeDefined();
      expect(dequeued!.id).toBe(job.id);
    });

    it("returns undefined for non-dead job", async () => {
      queue = await setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      const result = await queue.requeueDead(job.id);
      expect(result).toBeUndefined();
    });

    it("returns undefined for unknown job", async () => {
      queue = await setup();
      const result = await queue.requeueDead("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("purgeDead", () => {
    it("purges all dead jobs when no maxAge specified", async () => {
      queue = await setup();
      const j1 = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      const j2 = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      await queue.dequeue("w1");
      await queue.dequeue("w2");
      await queue.fail(j1.id, new Error("e1"));
      await queue.fail(j2.id, new Error("e2"));

      const purged = await queue.purgeDead();
      expect(purged).toBe(2);

      const stats = await queue.getStats();
      expect(stats.dead).toBe(0);
    });

    it("returns 0 when no dead jobs to purge", async () => {
      queue = await setup();
      await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      const purged = await queue.purgeDead();
      expect(purged).toBe(0);
    });

    it("respects maxAge parameter", async () => {
      vi.useFakeTimers();
      try {
        queue = await setup();
        const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
        await queue.dequeue("w1");
        await queue.fail(job.id, new Error("e1"));

        const purged = await queue.purgeDead(999999);
        expect(purged).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("concurrent claim (multiple workers)", () => {
    it("distributes distinct jobs to multiple dequeuers", async () => {
      queue = await setup();
      const jobs = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          queue.enqueue({ n: i }, { workspaceId: "ws1", triggerName: "t1" }),
        ),
      );

      const claimed: string[] = [];
      for (let i = 0; i < 5; i++) {
        const d = await queue.dequeue(`w${i}`);
        if (d) claimed.push(d.id);
      }

      expect(claimed).toHaveLength(5);
      expect(new Set(claimed).size).toBe(5);
      expect(claimed.sort()).toEqual(jobs.map((j) => j.id).sort());
    });
  });
});

