import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeBullMq = vi.hoisted(() => {
  type FakeJobState = "waiting" | "active" | "completed" | "failed";

  const api = {
    jobs: new Map<string, FakeJob>(),
    waiting: [] as FakeJob[],
    completedTokens: [] as string[],
    failedTokens: [] as string[],
    reset(): void {
      this.jobs.clear();
      this.waiting.length = 0;
      this.completedTokens.length = 0;
      this.failedTokens.length = 0;
    },
  };

  class FakeJob {
    readonly id: string;
    readonly data: unknown;
    readonly opts: { attempts?: number };
    readonly timestamp: number;
    attemptsMade = 0;
    failedReason?: string;
    state: FakeJobState = "waiting";
    token?: string;

    constructor(id: string, data: unknown, opts: { attempts?: number }) {
      this.id = id;
      this.data = data;
      this.opts = opts;
      this.timestamp = Date.now();
    }

    async getState(): Promise<FakeJobState> {
      return this.state;
    }

    async moveToCompleted(_returnValue: unknown, token: string): Promise<void> {
      if (token !== this.token) {
        throw new Error("invalid completion token");
      }
      this.state = "completed";
      api.completedTokens.push(token);
    }

    async moveToFailed(error: Error, token: string): Promise<void> {
      if (token !== this.token) {
        throw new Error("invalid failure token");
      }
      this.state = "failed";
      this.failedReason = error.message;
      api.failedTokens.push(token);
    }

    async moveToWait(token?: string): Promise<void> {
      if (token !== this.token) {
        throw new Error("invalid wait token");
      }
      this.state = "waiting";
      this.token = undefined;
      api.waiting.unshift(this);
    }

    async retry(): Promise<void> {
      this.state = "waiting";
      this.failedReason = undefined;
      this.attemptsMade = 0;
      api.waiting.push(this);
    }

    async remove(): Promise<void> {
      api.jobs.delete(this.id);
    }
  }

  class FakeQueue {
    async add(_name: string, data: unknown, opts: { attempts?: number }): Promise<FakeJob> {
      const job = new FakeJob(String(api.jobs.size + 1), data, opts);
      api.jobs.set(job.id, job);
      api.waiting.push(job);
      return job;
    }

    async getJob(jobId: string): Promise<FakeJob | undefined> {
      return api.jobs.get(jobId);
    }

    async getJobCounts(): Promise<Record<string, number>> {
      const counts: Record<string, number> = {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      };
      for (const job of api.jobs.values()) {
        counts[job.state] = (counts[job.state] ?? 0) + 1;
      }
      return counts;
    }

    async getFailed(): Promise<FakeJob[]> {
      return [...api.jobs.values()].filter((job) => job.state === "failed");
    }
  }

  class FakeWorker {
    async getNextJob(token: string): Promise<FakeJob | undefined> {
      const job = api.waiting.shift();
      if (!job) return undefined;
      job.state = "active";
      job.token = token;
      job.attemptsMade += 1;
      return job;
    }
  }

  return { ...api, Queue: FakeQueue, Worker: FakeWorker };
});

vi.mock("bullmq", () => ({
  Queue: fakeBullMq.Queue,
  Worker: fakeBullMq.Worker,
}));

import { createRedisQueue } from "../src/redis-queue.js";

describe("createRedisQueue", () => {
  beforeEach(() => {
    fakeBullMq.reset();
  });

  it("claims a job with a worker lock token and completes it with the same token", async () => {
    const queue = await createRedisQueue({ connection: { host: "localhost" } });
    const enqueued = await queue.enqueue({ pr: 42 }, { workspaceId: "ws1", triggerName: "gitea" });

    const job = await queue.dequeue("worker-a");
    expect(job?.id).toBe(enqueued.id);
    expect(job?.status).toBe("running");

    await queue.complete(enqueued.id);

    expect(fakeBullMq.completedTokens).toHaveLength(1);
    expect(fakeBullMq.completedTokens[0]).toContain("worker-a-");
    expect((await queue.getJob(enqueued.id))?.status).toBe("completed");
  });

  it("returns excluded workspace jobs to waiting instead of dropping them", async () => {
    const queue = await createRedisQueue({ connection: { host: "localhost" } });
    await queue.enqueue({ pr: 42 }, { workspaceId: "ws1", triggerName: "gitea" });

    const job = await queue.dequeue("worker-a", undefined, { excludedWorkspaceIds: ["ws1"] });

    expect(job).toBeUndefined();
    const stats = await queue.getStats();
    expect(stats.queued).toBe(1);
    expect(stats.running).toBe(0);
    expect(stats.completed).toBe(0);
  });

  it("fails claimed jobs into dead-letter stats and supports purge", async () => {
    const queue = await createRedisQueue({ connection: { host: "localhost" } });
    const enqueued = await queue.enqueue(
      { pr: 42 },
      { workspaceId: "ws1", triggerName: "gitea", maxAttempts: 1 },
    );
    await queue.dequeue("worker-a");

    await queue.fail(enqueued.id, new Error("fatal"));

    const dead = await queue.getDeadJobs();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.status).toBe("dead");
    expect(dead[0]?.lastError).toBe("fatal");
    const stats = await queue.getStats();
    expect(stats.dead).toBe(1);

    expect(await queue.purgeDead()).toBe(1);
    expect(await queue.getJob(enqueued.id)).toBeUndefined();
  });
});
