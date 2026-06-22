import type { AppConfig } from "./config.js";
import { createInMemoryQueue, type ReviewQueue } from "./queue.js";
import { createRedisQueue, type RedisQueueOptions } from "./redis-queue.js";
import { createSqliteQueue, type SqliteQueueOptions } from "./sqlite-queue.js";

function resolveEnv(name: string | undefined): string | undefined {
	return name ? process.env[name] : undefined;
}

function toRedisQueueOptions(config: AppConfig): RedisQueueOptions {
	const queueConfig = config.queue;
	const raw = queueConfig as Record<string, unknown>;
	const redisConfig = raw.redis as Record<string, unknown> | undefined;
	const urlEnv = redisConfig?.url_env as string | undefined;
	const url = resolveEnv(urlEnv) ?? (redisConfig?.url as string | undefined);
	const tls = redisConfig?.tls === true;

	return {
		connection: {
			...(url ? { url } : {}),
			...(redisConfig?.host ? { host: redisConfig.host as string } : {}),
			...(redisConfig?.port ? { port: redisConfig.port as number } : {}),
			...(redisConfig?.password_env
				? resolveEnv(redisConfig.password_env as string)
					? { password: resolveEnv(redisConfig.password_env as string)! }
					: {}
				: redisConfig?.password
					? { password: redisConfig.password as string }
					: {}),
			...(redisConfig?.db !== undefined ? { db: redisConfig.db as number } : {}),
			...(tls ? { tls } : {}),
		},
		keyPrefix: (redisConfig?.key_prefix as string | undefined) ?? "aicr:",
	};
}

function toSqliteQueueOptions(config: AppConfig): SqliteQueueOptions {
	const raw = config.queue as Record<string, unknown>;
	const sqliteConfig = (raw.sqlite as Record<string, unknown> | undefined) ?? {};
	const path = (sqliteConfig.path as string | undefined) ?? "data/queue.sqlite";
	const lockTtlSeconds = sqliteConfig.lock_ttl_seconds as number | undefined;
	return {
		path,
		...(lockTtlSeconds ? { lockTtlSeconds } : {}),
	};
}

export async function createQueueFromConfig(config: AppConfig): Promise<ReviewQueue> {
	switch (config.queue.kind) {
		case "redis": {
			return createRedisQueue(toRedisQueueOptions(config));
		}
		case "sqlite": {
			return createSqliteQueue(toSqliteQueueOptions(config));
		}
		case "rabbitmq": {
			console.warn("RabbitMQ queue backend is not yet implemented; falling back to in-memory queue.");
			return createInMemoryQueue();
		}
		default:
			return createInMemoryQueue();
	}
}

export { toRedisQueueOptions, toSqliteQueueOptions };
