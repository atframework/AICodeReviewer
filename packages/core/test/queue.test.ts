import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryQueue, computeBackoffDelay, type ReviewQueue, type QueueBackoffConfig } from "../src/queue.js";

describe("computeBackoffDelay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 when no backoff config", () => {
    expect(computeBackoffDelay(0)).toBe(0);
    expect(computeBackoffDelay(5)).toBe(0);
  });

  it("computes exponential backoff", () => {
    const backoff: QueueBackoffConfig = { kind: "exponential", baseMs: 1000, maxMs: 60000, jitter: false };
    expect(computeBackoffDelay(0, backoff)).toBe(1000);
    expect(computeBackoffDelay(1, backoff)).toBe(2000);
    expect(computeBackoffDelay(2, backoff)).toBe(4000);
    expect(computeBackoffDelay(3, backoff)).toBe(8000);
  });

  it("computes linear backoff", () => {
    const backoff: QueueBackoffConfig = { kind: "linear", baseMs: 1000, maxMs: 60000, jitter: false };
    expect(computeBackoffDelay(0, backoff)).toBe(1000);
    expect(computeBackoffDelay(1, backoff)).toBe(2000);
    expect(computeBackoffDelay(2, backoff)).toBe(3000);
  });

  it("computes constant backoff", () => {
    const backoff: QueueBackoffConfig = { kind: "constant", baseMs: 5000, maxMs: 60000, jitter: false };
    expect(computeBackoffDelay(0, backoff)).toBe(5000);
    expect(computeBackoffDelay(5, backoff)).toBe(5000);
  });

  it("caps delay at maxMs", () => {
    const backoff: QueueBackoffConfig = { kind: "exponential", baseMs: 10000, maxMs: 30000, jitter: false };
    expect(computeBackoffDelay(5, backoff)).toBe(30000);
  });

  it("applies jitter when enabled", () => {
    const backoff: QueueBackoffConfig = { kind: "exponential", baseMs: 1000, maxMs: 60000, jitter: true };
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) {
      delays.add(computeBackoffDelay(1, backoff));
    }
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe("createInMemoryQueue", () => {
  let queue: ReviewQueue;

  const noBackoff: QueueBackoffConfig = { kind: "constant", baseMs: 0, maxMs: 0, jitter: false };

  function setup(): ReviewQueue {
    return createInMemoryQueue();
  }

  describe("enqueue", () => {
    it("enqueues a job and assigns an id", async () => {
      queue = setup();
      const job = await queue.enqueue({ pr: 42 }, { workspaceId: "ws1", triggerName: "gitea" });
      expect(job.id).toBeTruthy();
      expect(job.status).toBe("queued");
      expect(job.workspaceId).toBe("ws1");
      expect(job.triggerName).toBe("gitea");
      expect(job.attempt).toBe(0);
      expect(job.data).toEqual({ pr: 42 });
    });

    it("uses default maxAttempts of 3", async () => {
      queue = setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "test" });
      expect(job.maxAttempts).toBe(3);
    });

    it("respects custom maxAttempts", async () => {
      queue = setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "test", maxAttempts: 5 });
      expect(job.maxAttempts).toBe(5);
    });

    it("assigns unique ids to multiple jobs", async () => {
      queue = setup();
      const j1 = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      const j2 = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      expect(j1.id).not.toBe(j2.id);
    });
  });

  describe("dequeue", () => {
    it("returns undefined when queue is empty", async () => {
      queue = setup();
      const job = await queue.dequeue("worker-1");
      expect(job).toBeUndefined();
    });

    it("returns the first enqueued job and marks it running", async () => {
      queue = setup();
      const enqueued = await queue.enqueue({ pr: 1 }, { workspaceId: "ws1", triggerName: "t1" });
      const dequeued = await queue.dequeue("worker-1");
      expect(dequeued).toBeTruthy();
      expect(dequeued!.id).toBe(enqueued.id);
      expect(dequeued!.status).toBe("running");
      expect(dequeued!.attempt).toBe(1);
      expect(dequeued!.startedAt).toBeGreaterThan(0);
    });

    it("returns jobs in FIFO order", async () => {
      queue = setup();
      const j1 = await queue.enqueue({ n: 1 }, { workspaceId: "ws1", triggerName: "t1" });
      const j2 = await queue.enqueue({ n: 2 }, { workspaceId: "ws1", triggerName: "t1" });
      const d1 = await queue.dequeue("w1");
      const d2 = await queue.dequeue("w1");
      expect(d1!.id).toBe(j1.id);
      expect(d2!.id).toBe(j2.id);
    });

    it("skips excluded workspaces without dropping their jobs", async () => {
      queue = setup();
      const ws1 = await queue.enqueue({ n: 1 }, { workspaceId: "ws1", triggerName: "t1" });
      const ws2 = await queue.enqueue({ n: 2 }, { workspaceId: "ws2", triggerName: "t2" });

      const first = await queue.dequeue("w1", undefined, { excludedWorkspaceIds: ["ws1"] });
      expect(first?.id).toBe(ws2.id);
      await queue.complete(ws2.id);

      const second = await queue.dequeue("w1");
      expect(second?.id).toBe(ws1.id);
    });
  });

  describe("complete", () => {
    it("marks a running job as completed", async () => {
      queue = setup();
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
      queue = setup();
      const job = await queue.enqueue(
        {},
        { workspaceId: "ws1", triggerName: "t1", maxAttempts: 3, backoff: noBackoff },
      );
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("transient error"));
      const requeued = await queue.dequeue("w2");
      expect(requeued).toBeTruthy();
      expect(requeued!.id).toBe(job.id);
      expect(requeued!.attempt).toBe(2);
    });

    it("sends job to dead letter when maxAttempts exhausted", async () => {
      queue = setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("fatal error"));
      const updated = await queue.getJob(job.id);
      expect(updated!.status).toBe("dead");
      expect(updated!.lastError).toBe("fatal error");
    });

    it("requeues until maxAttempts then dead-letters", async () => {
      queue = setup();
      const job = await queue.enqueue(
        {},
        { workspaceId: "ws1", triggerName: "t1", maxAttempts: 2, backoff: noBackoff },
      );
      // Attempt 1
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("e1"));
      // Attempt 2
      const r2 = await queue.dequeue("w2");
      expect(r2!.attempt).toBe(2);
      await queue.fail(job.id, new Error("e2"));
      // Should be dead
      const dead = await queue.getJob(job.id);
      expect(dead!.status).toBe("dead");
    });

    it("schedules retry availability without blocking fail", async () => {
      vi.useFakeTimers();
      try {
        queue = setup();
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
  });

  describe("getStats", () => {
    it("returns correct counts for each status", async () => {
      queue = setup();
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
      queue = setup();
      const job = await queue.getJob("nonexistent");
      expect(job).toBeUndefined();
    });

    it("returns the job for a known id", async () => {
      queue = setup();
      const enqueued = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      const found = await queue.getJob(enqueued.id);
      expect(found!.id).toBe(enqueued.id);
    });
  });

  describe("kind", () => {
    it("returns memory", () => {
      queue = setup();
      expect(queue.kind).toBe("memory");
    });
  });

  describe("getDeadJobs", () => {
    it("returns empty array when no dead jobs", async () => {
      queue = setup();
      const dead = await queue.getDeadJobs();
      expect(dead).toEqual([]);
    });

    it("returns all dead jobs", async () => {
      queue = setup();
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
      queue = setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 3 });
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("retryable"));

      const dead = await queue.getDeadJobs();
      expect(dead).toHaveLength(0);
    });
  });

  describe("requeueDead", () => {
    it("requeues a dead job back to queued state", async () => {
      queue = setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("fatal"));

      const requeued = await queue.requeueDead(job.id);
      expect(requeued).toBeDefined();
      expect(requeued!.status).toBe("queued");
      expect(requeued!.attempt).toBe(0);
      expect(requeued!.lastError).toBeUndefined();
    });

    it("makes requeued job available for dequeue", async () => {
      queue = setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("fatal"));
      await queue.requeueDead(job.id);

      const dequeued = await queue.dequeue("w1");
      expect(dequeued).toBeDefined();
      expect(dequeued!.id).toBe(job.id);
    });

    it("returns undefined for non-dead job", async () => {
      queue = setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      const result = await queue.requeueDead(job.id);
      expect(result).toBeUndefined();
    });

    it("returns undefined for unknown job", async () => {
      queue = setup();
      const result = await queue.requeueDead("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("purgeDead", () => {
    it("purges all dead jobs when no maxAge specified", async () => {
      queue = setup();
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
      queue = setup();
      await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
      const purged = await queue.purgeDead();
      expect(purged).toBe(0);
    });

    it("respects maxAge parameter", async () => {
      queue = setup();
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });
      await queue.dequeue("w1");
      await queue.fail(job.id, new Error("e1"));

      const purged = await queue.purgeDead(999999);
      expect(purged).toBe(0);
    });
  });
});
