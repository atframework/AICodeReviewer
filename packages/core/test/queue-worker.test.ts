import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryQueue, type ReviewQueue } from "../src/queue.js";
import { createQueueWorker, type QueueJobHandler, type QueueWorker } from "../src/queue-worker.js";
import { createMultiProviderRateLimiter } from "../src/rate-limiter.js";
import { ExecutionConcurrency } from "../src/execution-concurrency.js";

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

  it("H17: lowering live limits preserves active jobs and gates the next claim", async () => {
    let limit = 2;
    const releases: (() => void)[] = [];
    const started: string[] = [];
    const worker = createTestWorker(async job => {
      started.push(job.id);
      await new Promise<void>(resolve => releases.push(resolve));
    }, { concurrency: () => limit, perWorkspaceConcurrency: () => limit });
    for (let i = 0; i < 3; i++) await queue.enqueue({}, { id: String(i), workspaceId: "ws", triggerName: "trigger" });
    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toHaveLength(2);
    limit = 1;
    releases[0]!();
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toHaveLength(2);
    expect((await queue.getStats()).running).toBe(1);
    releases[1]!();
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toHaveLength(3);
    releases[2]!();
    await vi.advanceTimersByTimeAsync(100);
    await worker.stop();
    expect((await queue.getStats()).completed).toBe(3);
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

  it("shares permits with other schedulers and dequeues past their busy workspace", async () => {
    const pool = new ExecutionConcurrency(() => ({ global: 2, workspace: 1 }));
    const releaseP4 = pool.tryAcquire("p4-main")!;
    const releaseGithub = Promise.withResolvers<void>();
    const started: string[] = [];
    const worker = createTestWorker(async job => {
      started.push(job.workspaceId);
      if (job.workspaceId === "github-atsf4g-co") await releaseGithub.promise;
    }, { executionConcurrency: pool, concurrency: 4 });
    for (const workspaceId of ["p4-main", "github-atsf4g-co", "svn"]) await queue.enqueue({}, { workspaceId, triggerName: "t" });
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(started).toEqual(["github-atsf4g-co"]);
      expect((await queue.getStats()).queued).toBe(2);
      releaseGithub.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(started).toEqual(["github-atsf4g-co", "svn"]);
      releaseP4();
      await vi.advanceTimersByTimeAsync(100);
      expect(started).toEqual(["github-atsf4g-co", "svn", "p4-main"]);
    } finally {
      releaseP4(); releaseGithub.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await worker.stop();
    }
  });

  it("does not finish drain while an asynchronous claim is still in flight", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const dequeue = queue.dequeue.bind(queue);
    queue.dequeue = async (...args) => { await blocked; return dequeue(...args); };
    const processed = vi.fn(async () => {});
    const worker = createTestWorker(processed);
    await queue.enqueue({}, { workspaceId: "ws", triggerName: "t" });
    worker.start();
    await vi.advanceTimersByTimeAsync(1);
    let drained = false;
    const draining = worker.stop().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(drained).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(100);
    await draining;
    expect(processed).toHaveBeenCalledTimes(1);
    expect((await queue.getStats()).completed).toBe(1);
  });

  it("reports an incomplete drain instead of silently closing under a running job", async () => {
    let release!: () => void;
    const worker = createTestWorker(() => new Promise<void>(resolve => { release = resolve; }));
    await queue.enqueue({}, { workspaceId: "ws", triggerName: "t" });
    worker.start();
    await vi.advanceTimersByTimeAsync(1);
    const stopped = expect(worker.stop()).rejects.toThrow("not drained");
    await vi.advanceTimersByTimeAsync(30_000);
    await stopped;
    expect((await queue.getStats()).running).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    await worker.stop();
    expect((await queue.getStats()).completed).toBe(1);
  });
});
