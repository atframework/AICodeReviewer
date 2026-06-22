import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { mergeConfigLayers, type AppConfig } from "../src/config.js";
import { createQueueFromConfig, toRedisQueueOptions, toSqliteQueueOptions } from "../src/queue-factory.js";
import { createRedisQueue } from "../src/redis-queue.js";

vi.mock("../src/redis-queue.js", () => ({
	createRedisQueue: vi.fn(async () => ({
		kind: "redis",
		enqueue: vi.fn(),
		dequeue: vi.fn(),
		complete: vi.fn(),
		fail: vi.fn(),
		getStats: vi.fn(),
		getJob: vi.fn(),
		getDeadJobs: vi.fn(),
		requeueDead: vi.fn(),
		purgeDead: vi.fn(),
		close: vi.fn(),
	})),
}));

function makeConfig(queueOverrides: Record<string, unknown> = {}): AppConfig {
	return mergeConfigLayers({
		queue: queueOverrides,
	});
}

describe("createQueueFromConfig", () => {
	it("creates an in-memory queue by default", async () => {
		const config = makeConfig();
		const queue = await createQueueFromConfig(config);

		expect(queue.kind).toBe("memory");
	});

	it("creates an in-memory queue for kind=memory", async () => {
		const config = makeConfig({ kind: "memory" });
		const queue = await createQueueFromConfig(config);

		expect(queue.kind).toBe("memory");
	});

	it("creates a sqlite queue for kind=sqlite", async () => {
		const dbPath = `${tmpdir()}/aicr-factory-test-${Date.now()}.sqlite`;
		const config = makeConfig({
			kind: "sqlite",
			sqlite: { path: dbPath },
		});
		const queue = await createQueueFromConfig(config);

		try {
			expect(queue.kind).toBe("sqlite");
		} finally {
			queue.close?.();
			rmSync(dbPath, { force: true });
			rmSync(`${dbPath}-wal`, { force: true });
			rmSync(`${dbPath}-shm`, { force: true });
		}
	});

	it("falls back to in-memory for rabbitmq kind", async () => {
		const config = makeConfig({ kind: "rabbitmq" });
		const queue = await createQueueFromConfig(config);

		expect(queue.kind).toBe("memory");
	});

	it("creates a redis queue when kind=redis", async () => {
		const config = makeConfig({
			kind: "redis",
			redis: { url: "redis://localhost:6379" },
		});
		const queue = await createQueueFromConfig(config);

		expect(queue.kind).toBe("redis");
		expect(createRedisQueue).toHaveBeenCalledWith({
			connection: { url: "redis://localhost:6379" },
			keyPrefix: "aicr:",
		});
	});
});

describe("toSqliteQueueOptions", () => {
	it("uses configured path", () => {
		const config = makeConfig({
			kind: "sqlite",
			sqlite: { path: "/custom/queue.sqlite" },
		});
		const options = toSqliteQueueOptions(config);
		expect(options.path).toBe("/custom/queue.sqlite");
	});

	it("defaults path when not set", () => {
		const config = makeConfig({ kind: "sqlite" });
		const options = toSqliteQueueOptions(config);
		expect(options.path).toBe("data/queue.sqlite");
	});

	it("passes through lock_ttl_seconds", () => {
		const config = makeConfig({
			kind: "sqlite",
			sqlite: { lock_ttl_seconds: 120 },
		});
		const options = toSqliteQueueOptions(config);
		expect(options.lockTtlSeconds).toBe(120);
	});
});

describe("toRedisQueueOptions", () => {
	it("extracts url from env when url_env is set", () => {
		process.env.TEST_REDIS_URL = "redis://user:pass@redis-host:6380/2";

		const config = makeConfig({
			kind: "redis",
			redis: { url_env: "TEST_REDIS_URL" },
		});
		const options = toRedisQueueOptions(config);

		expect(options.connection.url).toBe("redis://user:pass@redis-host:6380/2");

		delete process.env.TEST_REDIS_URL;
	});

	it("uses direct url when url_env is not set", () => {
		const config = makeConfig({
			kind: "redis",
			redis: { url: "redis://localhost:6379" },
		});
		const options = toRedisQueueOptions(config);

		expect(options.connection.url).toBe("redis://localhost:6379");
	});

	it("applies custom key_prefix", () => {
		const config = makeConfig({
			kind: "redis",
			redis: { url: "redis://localhost:6379", key_prefix: "custom:" },
		});
		const options = toRedisQueueOptions(config);

		expect(options.keyPrefix).toBe("custom:");
	});

	it("defaults key_prefix to aicr:", () => {
		const config = makeConfig({
			kind: "redis",
			redis: { url: "redis://localhost:6379" },
		});
		const options = toRedisQueueOptions(config);

		expect(options.keyPrefix).toBe("aicr:");
	});

	it("enables tls when redis.tls is true", () => {
		const config = makeConfig({
			kind: "redis",
			redis: { url: "redis://localhost:6379", tls: true },
		});
		const options = toRedisQueueOptions(config);

		expect(options.connection.tls).toBe(true);
	});

	it("does not set tls by default", () => {
		const config = makeConfig({
			kind: "redis",
			redis: { url: "redis://localhost:6379" },
		});
		const options = toRedisQueueOptions(config);

		expect(options.connection.tls).toBeUndefined();
	});
});
