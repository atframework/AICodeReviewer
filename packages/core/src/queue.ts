export type QueueJobStatus = "queued" | "running" | "completed" | "failed" | "dead";

export interface QueueJob<T = unknown> {
  readonly id: string;
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly data: T;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly status: QueueJobStatus;
  readonly enqueuedAt: number;
  readonly startedAt?: number;
  readonly lastError?: string;
}

export interface QueueEnqueueOptions {
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly maxAttempts?: number;
  readonly backoff?: {
    readonly kind: "exponential" | "linear" | "constant";
    readonly baseMs: number;
    readonly maxMs: number;
    readonly jitter?: boolean;
  };
}

export interface QueueStats {
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly dead: number;
}

export interface ReviewQueue {
  readonly kind: string;
  enqueue<T>(data: T, options: QueueEnqueueOptions): Promise<QueueJob<T>>;
  dequeue(workerId: string, concurrencyLimit?: number): Promise<QueueJob | undefined>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, error: Error): Promise<void>;
  getStats(): Promise<QueueStats>;
  getJob(jobId: string): Promise<QueueJob | undefined>;
}

function computeBackoffDelay(
  attempt: number,
  backoff?: QueueEnqueueOptions["backoff"],
): number {
  if (!backoff) return 0;
  const baseMs = backoff.baseMs;
  const maxMs = backoff.maxMs;
  const jitter = backoff.jitter ?? true;

  let delay: number;
  if (backoff.kind === "exponential") {
    delay = baseMs * 2 ** attempt;
  } else if (backoff.kind === "linear") {
    delay = baseMs * (attempt + 1);
  } else {
    delay = baseMs;
  }

  if (jitter) {
    delay = delay * (0.5 + Math.random() * 0.5);
  }

  return Math.min(delay, maxMs);
}

export function createInMemoryQueue(): ReviewQueue {
  const jobs = new Map<string, QueueJob>();
  const pending: string[] = [];
  let jobCounter = 0;

  function nextId(): string {
    jobCounter += 1;
    return `mem-${Date.now().toString(36)}-${jobCounter.toString(36)}`;
  }

  return {
    kind: "memory",

    async enqueue<T>(data: T, options: QueueEnqueueOptions): Promise<QueueJob<T>> {
      const id = nextId();
      const job: QueueJob<T> = {
        id,
        workspaceId: options.workspaceId,
        triggerName: options.triggerName,
        data,
        attempt: 0,
        maxAttempts: options.maxAttempts ?? 3,
        status: "queued",
        enqueuedAt: Date.now(),
      };
      jobs.set(id, job as QueueJob);
      pending.push(id);
      return job;
    },

    async dequeue(_workerId: string, _concurrencyLimit?: number): Promise<QueueJob | undefined> {
      if (pending.length === 0) {
        return undefined;
      }

      const targetId = pending.shift();
      if (!targetId) {
        return undefined;
      }

      const job = jobs.get(targetId);
      if (!job) {
        return undefined;
      }

      const updated: QueueJob = {
        ...job,
        status: "running",
        attempt: job.attempt + 1,
        startedAt: Date.now(),
        ...(job.startedAt ? {} : { startedAt: Date.now() }),
      };
      jobs.set(targetId, updated);
      return updated;
    },

    async complete(jobId: string): Promise<void> {
      const job = jobs.get(jobId);
      if (job) {
        jobs.set(jobId, { ...job, status: "completed" });
      }
    },

    async fail(jobId: string, error: Error): Promise<void> {
      const job = jobs.get(jobId);
      if (!job) return;

      if (job.attempt < job.maxAttempts) {
        const delay = computeBackoffDelay(job.attempt, {
          kind: "exponential",
          baseMs: 2000,
          maxMs: 60000,
          jitter: true,
        });
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const updated: QueueJob = { ...job, status: "queued", lastError: error.message };
        jobs.set(jobId, updated);
        pending.push(jobId);
      } else {
        jobs.set(jobId, { ...job, status: "dead", lastError: error.message });
      }
    },

    async getStats(): Promise<QueueStats> {
      let queued = 0;
      let running = 0;
      let completed = 0;
      let failed = 0;
      let dead = 0;
      for (const job of jobs.values()) {
        switch (job.status) {
          case "queued": queued++; break;
          case "running": running++; break;
          case "completed": completed++; break;
          case "failed": failed++; break;
          case "dead": dead++; break;
        }
      }
      return { queued, running, completed, failed, dead };
    },

    async getJob(jobId: string): Promise<QueueJob | undefined> {
      return jobs.get(jobId);
    },
  };
}
