import { createHash } from "node:crypto";

import { WeComAppClient, type FetchLike } from "@aicr/outputs";

/**
 * IM connection runtime (execution spec §3): resolves credentials per
 * connection config and caches protocol clients by credential identity, so
 * token caches never leak across applications or secret rotations. The
 * generation-scoped lifecycle (acquire/dispose wiring) lands with IM-17;
 * instances created through this registry stay per-generation by ownership.
 */

export interface ImConnectionRuntimeOptions {
	/** Environment resolver for `*_env` references; defaults to no access. */
	readonly env?: ((name: string) => string | undefined) | undefined;
	readonly fetch?: FetchLike | undefined;
	readonly now?: (() => number) | undefined;
}

export interface ResolvedWeComAppCredentials {
	readonly corpId: string;
	readonly agentId: number;
	readonly appSecret: string;
}

function resolveSecret(record: Record<string, unknown>, literalField: string, envField: string, env: (name: string) => string | undefined): string | undefined {
	const literal = record[literalField];
	if (typeof literal === "string" && literal.length > 0) return literal;
	const envName = record[envField];
	return typeof envName === "string" && envName.length > 0 ? env(envName) : undefined;
}

/** Literal wins, then the `*_env` reference; missing credentials fail loudly. */
export function resolveWeComAppCredentials(
	connection: { corp_id: string; agent_id: number; app_secret?: string | undefined; app_secret_env?: string | undefined },
	env: (name: string) => string | undefined,
): ResolvedWeComAppCredentials {
	const appSecret = resolveSecret(connection as Record<string, unknown>, "app_secret", "app_secret_env", env);
	if (!appSecret) {
		throw new Error(`WeCom application connection ${connection.corp_id}/${connection.agent_id} requires app_secret or a resolvable app_secret_env.`);
	}
	return { corpId: connection.corp_id, agentId: connection.agent_id, appSecret };
}

/** Cache key carries a secret fingerprint, never the secret itself. */
function wecomAppCacheKey(credentials: ResolvedWeComAppCredentials): string {
	const fingerprint = createHash("sha256").update(credentials.appSecret, "utf8").digest("hex").slice(0, 16);
	return `${credentials.corpId}:${credentials.agentId}:${fingerprint}`;
}

export class ImConnectionRegistry {
	private readonly clients = new Map<string, WeComAppClient>();

	constructor(private readonly options: ImConnectionRuntimeOptions = {}) {}

	/** Returns the cached client for this credential version, creating it once. */
	wecomApp(connection: {
		corp_id: string;
		agent_id: number;
		app_secret?: string | undefined;
		app_secret_env?: string | undefined;
	}): WeComAppClient {
		const credentials = resolveWeComAppCredentials(connection, this.options.env ?? (() => undefined));
		const key = wecomAppCacheKey(credentials);
		let client = this.clients.get(key);
		if (client === undefined) {
			client = new WeComAppClient({
				corpId: credentials.corpId,
				agentId: credentials.agentId,
				appSecret: credentials.appSecret,
				...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
				...(this.options.now !== undefined ? { now: this.options.now } : {}),
			});
			this.clients.set(key, client);
		}
		return client;
	}

	/** Drops every cached client; in-flight sends finish on their own handles. */
	dispose(): void {
		this.clients.clear();
	}
}
