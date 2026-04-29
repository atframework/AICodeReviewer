import type {
  QueueBackoffConfig,
  QueueDequeueOptions,
  QueueEnqueueOptions,
  QueueJob,
  QueueJobStatus,
  QueueStats,
  ReviewQueue,
} from "./queue.js";

export interface RedisQueueOptions {
  readonly connection: {
    readonly url?: string;
    readonly host?: string;
    readonly port?: number;
    readonly password?: string;
    readonly db?: number;
    readonly tls?: boolean;
  };
  readonly keyPrefix?: string;
}

interface BullMqJobData {
  readonly workspaceId: string;
  readonly triggerName: string;
  readonly data: unknown;
  readonly maxAttempts: number;
  readonly backoff: QueueBackoffConfig;
  readonly enqueuedAt: number;
}

interface ActiveBullMqJob {
  readonly job: {
    readonly id: string | number;
    moveToCompleted(returnValue: unknown, token: string, fetchNext?: boolean): Promise<unknown>;
    moveToFailed(error: Error, token: string, fetchNext?: boolean): Promise<unknown>;
    moveToWait(token?: string): Promise<unknown>;
  };
  readonly token: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BullMqModule = any;

async function loadBullMq(): Promise<BullMqModule> {
  try {
    return await import("bullmq");
  } catch {
    throw new Error(
      "bullmq is not installed. Install it with: pnpm add bullmq ioredis\n" +
      "Redis queue requires both bullmq and ioredis packages.",
    );
  }
}

function parseRedisUrl(url: string): { host: string; port: number; password?: string; db?: number } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: Number(parsed.port) || 6379,
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(parsed.pathname && parsed.pathname !== "/" ? { db: Number(parsed.pathname.slice(1)) } : {}),
  };
}

function buildRedisConnection(options: RedisQueueOptions["connection"]): Record<string, unknown> {
  if (options.url) {
    return parseRedisUrl(options.url);
  }
  return {
    host: options.host ?? "localhost",
    port: options.port ?? 6379,
    ...(options.password ? { password: options.password } : {}),
    ...(options.db !== undefined ? { db: options.db } : {}),
    ...(options.tls ? { tls: {} } : {}),
  };
}

function convertBullMqStatus(status: string): QueueJobStatus {
  switch (status) {
    case "waiting":
    case "delayed":
      return "queued";
    case "active":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "dead";
    default:
      return "queued";
  }
}

function createWorkerToken(workerId: string): string {
  return `${workerId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function createRedisQueue(options: RedisQueueOptions): Promise<ReviewQueue> {
  const bullMq = await loadBullMq();
  const connection = buildRedisConnection(options.connection);
  const keyPrefix = options.keyPrefix ?? "aicr:";

  const queue = new bullMq.Queue("review-jobs", {
    connection,
    prefix: keyPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
  const worker = new bullMq.Worker("review-jobs", undefined, {
    connection,
    prefix: keyPrefix,
    autorun: false,
  });
  const activeJobs = new Map<string, ActiveBullMqJob>();

  return {
    kind: "redis",

    async enqueue<T>(data: T, opts: QueueEnqueueOptions): Promise<QueueJob<T>> {
      const backoffConfig = opts.backoff ?? { kind: "exponential", baseMs: 2000, maxMs: 60000, jitter: true };
      const jobData: BullMqJobData = {
        workspaceId: opts.workspaceId,
        triggerName: opts.triggerName,
        data,
        maxAttempts: opts.maxAttempts ?? 3,
        backoff: backoffConfig,
        enqueuedAt: Date.now(),
      };

      const bullJob = await queue.add("review", jobData, {
        attempts: opts.maxAttempts ?? 3,
        backoff: {
          type: backoffConfig.kind === "constant" ? "fixed" : backoffConfig.kind,
          delay: backoffConfig.baseMs,
        },
      });

      return {
        id: bullJob.id as string,
        workspaceId: opts.workspaceId,
        triggerName: opts.triggerName,
        data,
        attempt: 0,
        maxAttempts: opts.maxAttempts ?? 3,
        status: "queued",
        enqueuedAt: jobData.enqueuedAt,
      };
    },

    async dequeue(
      workerId: string,
      _concurrencyLimit?: number,
      options?: QueueDequeueOptions,
    ): Promise<QueueJob | undefined> {
      const token = createWorkerToken(workerId);
      const bullJob = await worker.getNextJob(token, { block: false });
      if (!bullJob) return undefined;

      const jobData = bullJob.data as BullMqJobData;
      if (options?.excludedWorkspaceIds?.includes(jobData.workspaceId)) {
        await bullJob.moveToWait(token);
        return undefined;
      }

      activeJobs.set(String(bullJob.id), { job: bullJob, token });
      return {
        id: String(bullJob.id),
        workspaceId: jobData.workspaceId,
        triggerName: jobData.triggerName,
        data: jobData.data,
        attempt: bullJob.attemptsMade + 1,
        maxAttempts: jobData.maxAttempts,
        status: "running",
        enqueuedAt: jobData.enqueuedAt,
        startedAt: Date.now(),
      };
    },

    async complete(jobId: string): Promise<void> {
      const active = activeJobs.get(jobId);
      if (active) {
        await active.job.moveToCompleted(undefined, active.token, false);
        activeJobs.delete(jobId);
      }
    },

    async fail(jobId: string, error: Error): Promise<void> {
      const active = activeJobs.get(jobId);
      if (active) {
        await active.job.moveToFailed(error, active.token, false);
        activeJobs.delete(jobId);
      }
    },

    async getStats(): Promise<QueueStats> {
      const counts = await queue.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed",
      );

      return {
        queued: (counts.waiting ?? 0) + (counts.delayed ?? 0),
        running: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: 0,
        dead: counts.failed ?? 0,
      };
    },

    async getJob(jobId: string): Promise<QueueJob | undefined> {
      const bullJob = await queue.getJob(jobId);
      if (!bullJob) return undefined;

      const jobData = bullJob.data as BullMqJobData;
      return {
        id: String(bullJob.id),
        workspaceId: jobData.workspaceId,
        triggerName: jobData.triggerName,
        data: jobData.data,
        attempt: bullJob.attemptsMade,
        maxAttempts: jobData.maxAttempts,
        status: convertBullMqStatus(await bullJob.getState()),
        enqueuedAt: jobData.enqueuedAt,
        ...(bullJob.timestamp ? { startedAt: bullJob.timestamp } : {}),
        ...(bullJob.failedReason ? { lastError: bullJob.failedReason } : {}),
      };
    },

    async getDeadJobs(): Promise<readonly QueueJob[]> {
      const failed = await queue.getFailed(0, -1);
      return failed
        .filter((j: { attemptsMade: number; opts: { attempts?: number } }) =>
          j.attemptsMade >= (j.opts.attempts ?? 3),
        )
        .map((bullJob: { id: string | number; data: BullMqJobData; attemptsMade: number; failedReason?: string }) => {
          const jobData = bullJob.data;
          return {
            id: String(bullJob.id),
            workspaceId: jobData.workspaceId,
            triggerName: jobData.triggerName,
            data: jobData.data,
            attempt: bullJob.attemptsMade,
            maxAttempts: jobData.maxAttempts,
            status: "dead" as QueueJobStatus,
            enqueuedAt: jobData.enqueuedAt,
            ...(bullJob.failedReason ? { lastError: bullJob.failedReason } : {}),
          };
        });
    },

    async requeueDead(jobId: string): Promise<QueueJob | undefined> {
      const bullJob = await queue.getJob(jobId);
      if (!bullJob) return undefined;

      const state = await bullJob.getState();
      if (state !== "failed") return undefined;

      await bullJob.retry();

      const jobData = bullJob.data as BullMqJobData;
      return {
        id: String(bullJob.id),
        workspaceId: jobData.workspaceId,
        triggerName: jobData.triggerName,
        data: jobData.data,
        attempt: 0,
        maxAttempts: jobData.maxAttempts,
        status: "queued",
        enqueuedAt: jobData.enqueuedAt,
      };
    },

    async purgeDead(maxAgeMs?: number): Promise<number> {
      const failed = await queue.getFailed(0, -1);
      let purged = 0;
      const now = Date.now();

      for (const bullJob of failed) {
        if (bullJob.attemptsMade < (bullJob.opts.attempts ?? 3)) continue;

        const jobData = bullJob.data as BullMqJobData;
        if (maxAgeMs !== undefined && (now - jobData.enqueuedAt) <= maxAgeMs) continue;

        await bullJob.remove();
        purged++;
      }

      return purged;
    },
  };
}
