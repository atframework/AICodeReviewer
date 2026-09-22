import { randomUUID } from "node:crypto";

import { DEFAULT_CHANNEL_DIRECTORY_CACHE_TTL_SECONDS } from "./channel-identity.js";
import type { FetchLike } from "./index.js";
import type { FeishuMember } from "./feishu-members.js";

export interface FeishuAppOptions {
	readonly appId: string;
	readonly appSecret: string;
	readonly baseUrl?: string | undefined;
	readonly fetch?: FetchLike | undefined;
	readonly onDirectoryWarning?: ((code: string) => void) | undefined;
}

export class FeishuApiError extends Error {
	readonly status: number | undefined;
	constructor(readonly operation: string, status: number, readonly code?: number) {
		// Upstream messages/bodies can include credentials, recipients or profiles.
		super(`Feishu ${operation} failed (HTTP ${status}${code === undefined ? "" : `, code ${code}`}).`);
		this.name = "FeishuApiError";
		this.status = status > 0 ? status : undefined;
	}
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** One instance per config generation/channel: no process-wide credential or PII cache. */
export class FeishuAppClient {
	private readonly baseUrl: string;
	private readonly fetch: FetchLike;
	private token: { value: string; expiresAt: number } | undefined;
	private tokenPending: Promise<string> | undefined;
	private directory: { chatId: string; members: readonly FeishuMember[]; loadedAt: number } | undefined;
	private directoryPending: { chatId: string; ttl: number; promise: Promise<readonly FeishuMember[]> } | undefined;

	constructor(private readonly options: FeishuAppOptions) {
		this.baseUrl = (options.baseUrl ?? "https://open.feishu.cn").replace(/\/+$/u, "");
		if (!["https://open.feishu.cn", "https://open.larksuite.com"].includes(this.baseUrl)) {
			throw new Error("Feishu base_url must be https://open.feishu.cn or https://open.larksuite.com.");
		}
		this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, {
			...init, redirect: "error", signal: AbortSignal.timeout(15_000),
		}));
	}

	private async request(path: string, operation: string, body?: unknown, token?: string): Promise<Record<string, unknown>> {
		let response;
		try {
			response = await this.fetch(`${this.baseUrl}/open-apis${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new FeishuApiError(operation, 0);
		}
		let result: Record<string, unknown>;
		try { result = object(await response.json()); } catch {
			throw new FeishuApiError(operation, response.ok && operation === "send message" ? 0 : response.status);
		}
		if (!response.ok || result.code !== 0) {
			const code = typeof result.code === "number" ? result.code : undefined;
			throw new FeishuApiError(operation, response.ok && operation === "send message" && code === undefined ? 0 : response.status, code);
		}
		return result;
	}

	private async accessToken(): Promise<string> {
		if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
		if (this.tokenPending) return this.tokenPending;
		this.tokenPending = (async () => {
			const result = await this.request("/auth/v3/tenant_access_token/internal", "authentication", {
				app_id: this.options.appId, app_secret: this.options.appSecret,
			});
			const value = text(result.tenant_access_token);
			if (!value || typeof result.expire !== "number" || !Number.isFinite(result.expire) || result.expire <= 0) {
				throw new FeishuApiError("authentication response", 200);
			}
			this.token = { value, expiresAt: Date.now() + Math.max(0, result.expire - 60) * 1000 };
			return value;
		})();
		try { return await this.tokenPending; } finally { this.tokenPending = undefined; }
	}

	private async authorized(path: string, operation: string, body?: unknown): Promise<Record<string, unknown>> {
		const token = await this.accessToken();
		try { return await this.request(path, operation, body, token); } catch (error) {
			// An explicit expired/invalid tenant token rejection is safe to retry once.
			// Transport failures on POST remain unknown outcomes; never blindly resend.
			if (!(error instanceof FeishuApiError) || ![99991663, 99991671].includes(error.code ?? 0)) throw error;
			if (this.token?.value === token) this.token = undefined;
			return this.request(path, operation, body, await this.accessToken());
		}
	}

	async sendCard(receiveId: string, receiveIdType: string, card: unknown): Promise<string> {
		const result = await this.authorized(`/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`, "send message", {
			receive_id: receiveId, msg_type: "interactive", content: JSON.stringify(card), uuid: randomUUID(),
		});
		const id = text(object(result.data).message_id);
		if (!id) throw new FeishuApiError("message response", 0);
		return id;
	}

	async members(chatId: string, cacheTtlSeconds = DEFAULT_CHANNEL_DIRECTORY_CACHE_TTL_SECONDS): Promise<readonly FeishuMember[]> {
		if (cacheTtlSeconds === 0) this.directory = undefined;
		if (this.directory?.chatId === chatId && this.directory.loadedAt + cacheTtlSeconds * 1000 > Date.now()) return this.directory.members;
		if (this.directoryPending?.chatId === chatId && this.directoryPending.ttl === cacheTtlSeconds) return this.directoryPending.promise;
		const promise = this.loadMembers(chatId).then(members => {
			if (cacheTtlSeconds > 0 && this.directoryPending?.promise === promise) {
				this.directory = { chatId, members, loadedAt: Date.now() };
			}
			return members;
		}, error => {
			// Only temporary upstream failures may reuse an expired snapshot.
			// Denied or incomplete membership invalidates it; zero TTL never reuses it.
			const stale = this.directory;
			const transient = error instanceof FeishuApiError && error.code === undefined
				&& ((error.status === undefined && error.operation === "group members")
					|| error.status === 429 || (error.status !== undefined && error.status >= 500));
			if (cacheTtlSeconds > 0 && stale?.chatId === chatId && transient) {
				this.options.onDirectoryWarning?.("stale_directory_used");
				return stale.members;
			}
			if (stale?.chatId === chatId) this.directory = undefined;
			throw error;
		});
		this.directoryPending = { chatId, ttl: cacheTtlSeconds, promise };
		try { return await promise; } finally {
			if (this.directoryPending?.promise === promise) this.directoryPending = undefined;
		}
	}

	private async loadMembers(chatId: string): Promise<readonly FeishuMember[]> {
		const members = new Map<string, FeishuMember>();
		const tokens = new Set<string>();
		let pageToken = "";
		const deadline = Date.now() + 60_000;
		for (let page = 0; ; page++) {
			if (page >= 100 || Date.now() >= deadline) throw new FeishuApiError("directory limit", 0);
			const query = new URLSearchParams({ member_id_type: "open_id", page_size: "100", ...(pageToken ? { page_token: pageToken } : {}) });
			const result = await this.authorized(`/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`, "group members");
			const data = object(result.data);
			if (!Array.isArray(data.items) || typeof data.has_more !== "boolean" || data.trigger_security_conf_limit === true) {
				throw new FeishuApiError("incomplete group members", 200);
			}
			for (const item of data.items) {
				const member = object(item);
				const id = text(member.member_id);
				if (!id || !/^ou_[A-Za-z0-9_-]+$/u.test(id) || member.member_id_type !== "open_id") {
					throw new FeishuApiError("group member identity", 200);
				}
				members.set(id, { open_id: id, ...(text(member.name) ? { name: text(member.name)! } : {}) });
			}
			if (!data.has_more) break;
			pageToken = text(data.page_token) ?? "";
			if (!pageToken || tokens.has(pageToken)) throw new FeishuApiError("group pagination", 200);
			tokens.add(pageToken);
		}
		const records = [...members.values()];
		let next = 0;
		let unavailable = 0;
		await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
			while (next < records.length) {
				const index = next++;
				const member = records[index]!;
				if (Date.now() >= deadline) { unavailable++; continue; }
				try {
					const result = await this.authorized(`/contact/v3/users/${encodeURIComponent(member.open_id)}?user_id_type=open_id`, "member profile");
					const profile = object(object(result.data).user);
					if (profile.open_id !== member.open_id) throw new FeishuApiError("profile identity", 200);
					const fields: Record<string, string> = {};
					for (const key of ["user_id", "union_id", "name", "en_name", "nickname", "email", "enterprise_email", "mobile"] as const) {
						const value = text(profile[key]);
						if (value) fields[key] = value;
					}
					records[index] = { ...member, ...fields };
				} catch { unavailable++; }
			}
		}));
		if (unavailable) this.options.onDirectoryWarning?.("profiles_unavailable");
		return records;
	}
}
