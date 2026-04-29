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

export interface QueueBackoffConfig {
  readonly kind: "exponential" | "linear" | "constant";
  readonly baseMs: number;
  readonly maxMs: number;
  readonly jitter?: boolean;
}

export interface QueueEnqueueOptions {
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly maxAttempts?: number;
  readonly backoff?: QueueBackoffConfig;
}

export interface QueueDequeueOptions {
  readonly excludedWorkspaceIds?: readonly string[];
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
  dequeue(
    workerId: string,
    concurrencyLimit?: number,
    options?: QueueDequeueOptions,
  ): Promise<QueueJob | undefined>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, error: Error): Promise<void>;
  getStats(): Promise<QueueStats>;
  getJob(jobId: string): Promise<QueueJob | undefined>;
  getDeadJobs(): Promise<readonly QueueJob[]>;
  requeueDead(jobId: string): Promise<QueueJob | undefined>;
  purgeDead(maxAgeMs?: number): Promise<number>;
}

export function computeBackoffDelay(
  attempt: number,
  backoff?: QueueBackoffConfig,
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

const DEFAULT_BACKOFF: QueueBackoffConfig = {
  kind: "exponential",
  baseMs: 2000,
  maxMs: 60000,
  jitter: true,
};

interface InternalQueueJob extends QueueJob {
  readonly backoff: QueueBackoffConfig;
  readonly availableAt?: number;
}

export function createInMemoryQueue(): ReviewQueue {
  const jobs = new Map<string, InternalQueueJob>();
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
      const job: InternalQueueJob = {
        id,
        workspaceId: options.workspaceId,
        triggerName: options.triggerName,
        data,
        attempt: 0,
        maxAttempts: options.maxAttempts ?? 3,
        status: "queued",
        enqueuedAt: Date.now(),
        backoff: options.backoff ?? DEFAULT_BACKOFF,
      };
      jobs.set(id, job);
      pending.push(id);
      return job as QueueJob<T>;
    },

    async dequeue(
      _workerId: string,
      _concurrencyLimit?: number,
      options?: QueueDequeueOptions,
    ): Promise<QueueJob | undefined> {
      if (pending.length === 0) {
        return undefined;
      }

      const excluded = new Set(options?.excludedWorkspaceIds ?? []);
      const now = Date.now();
      const targetIndex = pending.findIndex((id) => {
        const candidate = jobs.get(id);
        return Boolean(
          candidate &&
          candidate.status === "queued" &&
          !excluded.has(candidate.workspaceId) &&
          (candidate.availableAt === undefined || candidate.availableAt <= now),
        );
      });

      if (targetIndex < 0) {
        return undefined;
      }

      const targetId = pending.splice(targetIndex, 1)[0];
      if (!targetId) {
        return undefined;
      }

      const job = jobs.get(targetId);
      if (!job) {
        return undefined;
      }

      const { availableAt: _availableAt, ...rest } = job;
      const updated: InternalQueueJob = {
        ...rest,
        status: "running",
        attempt: job.attempt + 1,
        startedAt: Date.now(),
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
        const delay = computeBackoffDelay(job.attempt, job.backoff);
        const { availableAt: _availableAt, ...retryableJob } = job;
        const updated: InternalQueueJob = {
          ...retryableJob,
          status: "queued",
          lastError: error.message,
          ...(delay > 0 ? { availableAt: Date.now() + delay } : {}),
        };
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

    async getDeadJobs(): Promise<readonly QueueJob[]> {
      const deadJobs: QueueJob[] = [];
      for (const job of jobs.values()) {
        if (job.status === "dead") {
          deadJobs.push(job);
        }
      }
      return deadJobs;
    },

    async requeueDead(jobId: string): Promise<QueueJob | undefined> {
      const job = jobs.get(jobId);
      if (!job || job.status !== "dead") {
        return undefined;
      }

      const { lastError: _ignored, availableAt: _availableAt, ...rest } = job;
      const requeued: InternalQueueJob = {
        ...rest,
        status: "queued",
        attempt: 0,
      };
      jobs.set(jobId, requeued);
      pending.push(jobId);
      return requeued;
    },

    async purgeDead(maxAgeMs?: number): Promise<number> {
      let purged = 0;
      const now = Date.now();
      for (const [id, job] of jobs.entries()) {
        if (job.status === "dead") {
          if (maxAgeMs === undefined || (now - job.enqueuedAt) > maxAgeMs) {
            jobs.delete(id);
            purged++;
          }
        }
      }
      return purged;
    },
  };
}
