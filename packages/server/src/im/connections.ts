import { createHash } from "node:crypto";
import type { AppConfig } from "@aicr/core";

import { WeComAppClient, SocialImClient, type SocialImConnection, type FetchLike } from "@aicr/outputs";

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
  private readonly socialClients = new Map<string, SocialImClient>();

	constructor(private readonly options: ImConnectionRuntimeOptions = {}) {}

  social(connection: SocialImConnection): SocialImClient {
    const token = resolveSecret(connection, "token", "token_env", this.options.env ?? (() => undefined));
    if (!token) throw new Error("Social IM connection requires a resolvable token.");
    const fingerprint = createHash("sha256").update(token).digest("hex");
    const { token: _token, token_env: _env, callback: _callback, ...identity } = connection;
    const key = JSON.stringify([identity, fingerprint]);
    let client = this.socialClients.get(key);
    if (!client) {
      client = new SocialImClient(connection, token, this.options);
      this.socialClients.set(key, client);
    }
    return client;
  }

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
    this.socialClients.clear();
	}
}

const registries = new WeakMap<AppConfig, ImConnectionRegistry>();
export function imConnectionRegistryFor(config: AppConfig, options: ImConnectionRuntimeOptions): ImConnectionRegistry {
  let registry = registries.get(config);
  if (!registry) { registry = new ImConnectionRegistry(options); registries.set(config, registry); }
  return registry;
}

/** Prewarm only operator-configured destinations. This owns no platform registration side effects. */
export class SocialImReadinessService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;
  private stopped = false;
  constructor(private readonly options: ImConnectionRuntimeOptions & { readonly getConfig: () => AppConfig }) {}
  client(config: AppConfig, name: string): SocialImClient | undefined {
    const connection = config.im?.connections?.[name];
    if (!connection || connection.enabled === false || (connection.kind !== "slack_app" && connection.kind !== "discord_bot" && connection.kind !== "telegram_bot")) return undefined;
    try { return imConnectionRegistryFor(config, this.options).social(connection); } catch { return undefined; }
  }
  start(): void {
    this.stopped = false;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 30_000);
    this.timer.unref();
  }
  dispose(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const config = this.options.getConfig();
      const targets = new Map<string, Set<string>>();
      const add = (name: string, target: string) => { const values = targets.get(name) ?? new Set<string>(); values.add(target); targets.set(name, values); };
      for (const channel of config.outputs.channels) {
        if (channel.connection && ["slack_app", "discord_bot", "telegram_bot"].includes(channel.kind)) add(channel.connection, channel.chat_id ?? channel.channel_id!);
      }
      for (const binding of Object.values(config.im?.command_bindings ?? {})) {
        if (binding.enabled !== true) continue;
        for (const conversation of binding.conversations) {
          if ("id" in conversation) add(binding.connection, conversation.id);
          else if (conversation.kind === "bot_direct") for (const actor of binding.actors) if (!("kind" in actor) && actor.type === "telegram_user_id") add(binding.connection, actor.id);
        }
      }
      await Promise.allSettled([...targets].map(async ([name, destinations]) => {
        const client = this.client(config, name);
        if (!client) return;
        for (const destination of destinations) {
          if (this.stopped) return;
          if (!client.isReady(destination)) await client.refreshReadiness(destination);
        }
      }));
    } finally { this.refreshing = false; }
  }
}
