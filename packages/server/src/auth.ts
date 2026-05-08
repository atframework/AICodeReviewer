import type { Context, Next } from "hono";

export interface AuthConfig {
	readonly globalApiKey?: string;
	readonly workspaceApiKeys: ReadonlyMap<string, string>;
	readonly enabled: boolean;
}

const BEARER_PREFIX = "bearer ";
const API_KEY_HEADER = "x-api-key";
const AUTHORIZATION_HEADER = "authorization";

function extractToken(c: Context): string | undefined {
	const apiKey = c.req.header(API_KEY_HEADER);
	if (apiKey) return apiKey;

	const authorization = c.req.header(AUTHORIZATION_HEADER);
	if (authorization && authorization.toLowerCase().startsWith(BEARER_PREFIX)) {
		return authorization.slice(BEARER_PREFIX.length);
	}

	return undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

export function createAuthMiddleware(config: AuthConfig) {
	if (!config.enabled || (!config.globalApiKey && config.workspaceApiKeys.size === 0)) {
		return async (_c: Context, next: Next): Promise<void> => {
			await next();
		};
	}

	return async (c: Context, next: Next): Promise<Response | void> => {
		const token = extractToken(c);
		if (!token) {
			return c.json({ error: "unauthorized", message: "Missing authentication token. Use X-API-Key header or Authorization: Bearer <token>." }, 401);
		}

		if (config.globalApiKey && timingSafeEqual(token, config.globalApiKey)) {
			await next();
			return;
		}

		for (const workspaceToken of config.workspaceApiKeys.values()) {
			if (timingSafeEqual(token, workspaceToken)) {
				await next();
				return;
			}
		}

		return c.json({ error: "forbidden", message: "Invalid API key." }, 403);
	};
}

export function resolveWorkspaceAuth(
	config: Record<string, unknown>,
	envLookup: (name: string) => string | undefined,
): { apiKey?: string; enabled: boolean } | undefined {
	const auth = config.auth as Record<string, unknown> | undefined;
	if (!auth || typeof auth !== "object") return undefined;

	const apiKeyEnv = auth.api_key_env as string | undefined;
	const enabled = auth.enabled as boolean | undefined;

	const apiKey = apiKeyEnv ? envLookup(apiKeyEnv) : undefined;

	return {
		...(apiKey ? { apiKey } : {}),
		enabled: enabled !== false,
	};
}
