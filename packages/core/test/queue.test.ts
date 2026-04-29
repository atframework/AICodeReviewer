import { describe, expect, it } from "vitest";
import { createInMemoryQueue, type ReviewQueue } from "../src/queue.js";

describe("createInMemoryQueue", () => {
  let queue: ReviewQueue;

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
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 3 });
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
      const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 2 });
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
});
