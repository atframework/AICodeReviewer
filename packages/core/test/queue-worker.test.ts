import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryQueue, type ReviewQueue } from "../src/queue.js";
import { createQueueWorker, type QueueJobHandler, type QueueWorker } from "../src/queue-worker.js";
import { createMultiProviderRateLimiter } from "../src/rate-limiter.js";

describe("createQueueWorker", () => {
  let queue: ReviewQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = createInMemoryQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTestWorker(
    handler: QueueJobHandler,
    overrides: Partial<Parameters<typeof createQueueWorker>[1]> = {},
  ): QueueWorker {
    return createQueueWorker(handler, {
      queue,
      concurrency: 2,
      pollIntervalMs: 100,
      ...overrides,
    });
  }

  it("creates a worker with a generated id", () => {
    const worker = createTestWorker(async () => {});
    expect(worker.id).toBeTruthy();
    expect(worker.isRunning()).toBe(false);
  });

  it("starts and stops the worker", () => {
    const worker = createTestWorker(async () => {});
    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.stop();
  });

  it("processes enqueued jobs", async () => {
    const processed: string[] = [];
    const worker = createTestWorker(async (job) => {
      processed.push((job.data as { id: string }).id);
    }, { concurrency: 2, perWorkspaceConcurrency: 2, pollIntervalMs: 50 });

    await queue.enqueue({ id: "job-1" }, { workspaceId: "ws1", triggerName: "t1" });
    await queue.enqueue({ id: "job-2" }, { workspaceId: "ws1", triggerName: "t1" });

    worker.start();
    await vi.advanceTimersByTimeAsync(500);
    await worker.stop();

    expect(processed).toContain("job-1");
    expect(processed).toContain("job-2");
  });

  it("marks jobs as completed after successful processing", async () => {
    const worker = createTestWorker(async () => {});
    const job = await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });

    worker.start();
    await vi.advanceTimersByTimeAsync(200);
    await worker.stop();

    const updated = await queue.getJob(job.id);
    expect(updated!.status).toBe("completed");
  });

  it("marks jobs as failed when handler throws", async () => {
    const worker = createTestWorker(async () => {
      throw new Error("handler error");
    });
    await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1", maxAttempts: 1 });

    worker.start();
    await vi.advanceTimersByTimeAsync(200);
    await worker.stop();

    const stats = await queue.getStats();
    expect(stats.dead).toBe(1);
  });

  it("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;

    const worker = createTestWorker(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
      active--;
    }, { concurrency: 2, perWorkspaceConcurrency: 2, pollIntervalMs: 50 });

    for (let i = 0; i < 5; i++) {
      await queue.enqueue({ i }, { workspaceId: "ws1", triggerName: "t1" });
    }

    worker.start();
    await vi.advanceTimersByTimeAsync(1000);
    await worker.stop();

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("respects per-workspace concurrency", async () => {
    const workspaceJobs: Record<string, number> = {};

    const worker = createTestWorker(async (job) => {
      const wsId = job.workspaceId;
      workspaceJobs[wsId] = (workspaceJobs[wsId] ?? 0) + 1;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
    }, { concurrency: 4, perWorkspaceConcurrency: 1, pollIntervalMs: 50 });

    await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
    await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
    await queue.enqueue({}, { workspaceId: "ws2", triggerName: "t2" });

    worker.start();
    await vi.advanceTimersByTimeAsync(700);
    await worker.stop();

    const stats = await queue.getStats();
    expect(workspaceJobs.ws1).toBe(2);
    expect(workspaceJobs.ws2).toBe(1);
    expect(stats.completed).toBe(3);
    expect(stats.queued).toBe(0);
    expect(stats.running).toBe(0);
  });

  it("applies rate limiting when configured", async () => {
    const rateLimiter = createMultiProviderRateLimiter({ "t1": 1 });
    let processed = 0;

    const worker = createTestWorker(async () => {
      processed++;
    }, { concurrency: 10, rateLimiter, pollIntervalMs: 50 });

    for (let i = 0; i < 3; i++) {
      await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
    }

    worker.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(processed).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(2000);
    await worker.stop();
  });

  it("stops gracefully waiting for active jobs", async () => {
    let completed = false;
    const worker = createTestWorker(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
      completed = true;
    });

    await queue.enqueue({}, { workspaceId: "ws1", triggerName: "t1" });
    worker.start();
    await vi.advanceTimersByTimeAsync(100);

    const stopPromise = worker.stop();
    await vi.advanceTimersByTimeAsync(600);
    await stopPromise;

    expect(completed).toBe(true);
  });
});
