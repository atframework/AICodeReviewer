import type { AppConfig } from "./config.js";
import { createInMemoryQueue, type ReviewQueue } from "./queue.js";
import { createRedisQueue, type RedisQueueOptions } from "./redis-queue.js";

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

export async function createQueueFromConfig(config: AppConfig): Promise<ReviewQueue> {
	switch (config.queue.kind) {
		case "redis": {
			return createRedisQueue(toRedisQueueOptions(config));
		}
		case "sqlite": {
			console.warn("SQLite queue backend is not yet implemented; falling back to in-memory queue.");
			return createInMemoryQueue();
		}
		case "rabbitmq": {
			console.warn("RabbitMQ queue backend is not yet implemented; falling back to in-memory queue.");
			return createInMemoryQueue();
		}
		default:
			return createInMemoryQueue();
	}
}

export { toRedisQueueOptions };
