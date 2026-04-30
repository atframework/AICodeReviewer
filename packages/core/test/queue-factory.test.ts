import { describe, expect, it } from "vitest";

import { mergeConfigLayers, type AppConfig } from "../src/config.js";
import { createQueueFromConfig, toRedisQueueOptions } from "../src/queue-factory.js";

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

	it("falls back to in-memory for sqlite kind", async () => {
		const config = makeConfig({ kind: "sqlite" });
		const queue = await createQueueFromConfig(config);

		expect(queue.kind).toBe("memory");
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
