import type { MultiProviderRateLimiter } from "./rate-limiter.js";
import type { QueueJob, ReviewQueue } from "./queue.js";

export type QueueJobHandler<T = unknown> = (job: QueueJob<T>) => Promise<void>;

export interface QueueWorkerOptions {
  readonly queue: ReviewQueue;
  readonly concurrency: number;
  readonly perWorkspaceConcurrency?: number;
  readonly pollIntervalMs?: number;
  readonly lockTtlSeconds?: number;
  readonly rateLimiter?: MultiProviderRateLimiter;
  readonly workerId?: string;
}

export interface QueueWorker {
  readonly id: string;
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export function createQueueWorker(
  handler: QueueJobHandler,
  options: QueueWorkerOptions,
): QueueWorker {
  const workerId = options.workerId ?? `worker-${Date.now().toString(36)}`;
  const concurrency = options.concurrency;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const perWorkspaceConcurrency = options.perWorkspaceConcurrency ?? 1;

  let running = false;
  let activeJobs = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const workspaceActive = new Map<string, number>();

  function getWorkspaceActive(workspaceId: string): number {
    return workspaceActive.get(workspaceId) ?? 0;
  }

  function setWorkspaceActive(workspaceId: string, count: number): void {
    if (count <= 0) {
      workspaceActive.delete(workspaceId);
    } else {
      workspaceActive.set(workspaceId, count);
    }
  }

  function getBlockedWorkspaceIds(): string[] {
    if (perWorkspaceConcurrency <= 0) {
      return [];
    }

    const blocked: string[] = [];
    for (const [workspaceId, count] of workspaceActive.entries()) {
      if (count >= perWorkspaceConcurrency) {
        blocked.push(workspaceId);
      }
    }
    return blocked;
  }

  async function processJob(job: QueueJob): Promise<void> {
    const workspaceId = job.workspaceId;
    setWorkspaceActive(workspaceId, getWorkspaceActive(workspaceId) + 1);
    activeJobs++;

    try {
      if (options.rateLimiter) {
        await options.rateLimiter.acquireAsync(job.triggerName);
      }

      await handler(job);
      await options.queue.complete(job.id);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await options.queue.fail(job.id, err);
    } finally {
      activeJobs--;
      setWorkspaceActive(workspaceId, getWorkspaceActive(workspaceId) - 1);
    }
  }

  async function poll(): Promise<void> {
    if (!running) return;

    try {
      while (activeJobs < concurrency && running) {
        const job = await options.queue.dequeue(workerId, concurrency, {
          excludedWorkspaceIds: getBlockedWorkspaceIds(),
        });
        if (!job) break;

        processJob(job).catch(() => {});
      }
    } catch {
      // Poll errors are non-fatal; retry on next tick
    }

    if (running) {
      pollTimer = setTimeout(poll, pollIntervalMs);
    }
  }

  return {
    id: workerId,

    start(): void {
      if (running) return;
      running = true;
      poll();
    },

    async stop(): Promise<void> {
      running = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }

      const maxWaitMs = 30_000;
      const start = Date.now();
      while (activeJobs > 0 && (Date.now() - start) < maxWaitMs) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      }
    },

    isRunning(): boolean {
      return running;
    },
  };
}
