import type { FetchLike } from "./index.js";
import { PublicationReconciliationError, publicationFetch } from "./publication-journal.js";

/**
 * WeCom self-built application client (W2/W6/W11–W14, execution spec §3).
 * One instance per connection credential version: the token cache, the
 * single-flight promise and the fixed 40014/42001 retry scope never span
 * applications or credential rotations. Injected transport and clock only;
 * this module reads neither process.env nor the filesystem.
 */

const WECOM_API_ORIGIN = "https://qyapi.weixin.qq.com";
/** Refresh tokens before the server deadline to absorb clock skew. */
const TOKEN_EXPIRY_MARGIN_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 15_000;
/** Only these explicit rejections permit one token refresh and one retry (W11). */
const TOKEN_INVALID_CODES: ReadonlySet<number> = new Set([40014, 42001]);
/** text/markdown content caps at 2048 UTF-8 bytes on both send endpoints (W13/W14). */
const CONTENT_MAX_BYTES = 2048;

export interface WeComAppOptions {
	readonly corpId: string;
	readonly agentId: number;
	readonly appSecret: string;
	readonly fetch?: FetchLike | undefined;
	readonly now?: (() => number) | undefined;
}

export type WeComAppMessage =
	| { readonly msgtype: "text"; readonly text: { readonly content: string } }
	| { readonly msgtype: "markdown"; readonly markdown: { readonly content: string } };

export interface WeComRecipients {
	readonly users?: readonly string[] | undefined;
	readonly parties?: readonly string[] | undefined;
	readonly tags?: readonly string[] | undefined;
}

/**
 * Discriminated send outcome (execution spec §3): never a boolean. `partial`
 * keeps the delivered remainder — the whole recipient set is never resent.
 */
export type WeComSendResult =
	| { readonly kind: "delivered"; readonly msgid?: string }
	| {
		readonly kind: "partial";
		readonly invalidUsers: readonly string[];
		readonly invalidParties: readonly string[];
		readonly invalidTags: readonly string[];
		readonly unlicensedUsers: readonly string[];
	}
	| { readonly kind: "rejected"; readonly errcode: number; readonly reason: string }
	| { readonly kind: "unknown"; readonly reason: "network" | "http" | "malformed_response" };

/** Sanitized failure: never carries URLs, query tokens, or upstream bodies. */
export class WeComAppError extends Error {
	readonly status: number | undefined;
	readonly errcode: number | undefined;
	constructor(readonly operation: string, status: number, errcode?: number) {
		super(`WeCom ${operation} failed (HTTP ${status}${errcode === undefined ? "" : `, errcode ${errcode}`}).`);
		this.name = "WeComAppError";
		this.status = status > 0 ? status : undefined;
		this.errcode = errcode;
	}
}

const KNOWN_ERRCODE_REASONS: Readonly<Record<number, string>> = {
	81013: "all recipients are invalid or unlicensed",
	45009: "api call rate limit exceeded",
	45033: "api concurrent call limit exceeded",
	45036: "data access rate limit exceeded",
	60020: "calling ip is not a trusted ip of this application",
};

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function joinedList(value: unknown): readonly string[] {
	const raw = text(value);
	// WeCom pipes separate multiple ids; trailing separators occur in the wild.
	return raw === undefined ? [] : raw.split("|").map(entry => entry.trim()).filter(entry => entry.length > 0);
}

export class WeComAppClient {
	private readonly fetch: FetchLike;
	private readonly now: () => number;
	private token: { value: string; expiresAt: number } | undefined;
	private tokenPending: Promise<string> | undefined;

	constructor(private readonly options: WeComAppOptions) {
		this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, {
			...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		}));
		this.now = options.now ?? (() => Date.now());
	}

	/** message/send to explicit members, departments and tags (W2/W13). */
	async sendToRecipients(
		message: WeComAppMessage,
		recipients: WeComRecipients,
		options?: { readonly publicationIdentity?: string | undefined },
	): Promise<WeComSendResult> {
		const users = recipients.users ?? [];
		const parties = recipients.parties ?? [];
		const tags = recipients.tags ?? [];
		if (users.length === 0 && parties.length === 0 && tags.length === 0) {
			throw new TypeError("WeCom recipients require at least one non-empty users/parties/tags list.");
		}
		return this.send("/cgi-bin/message/send", {
			agentid: this.options.agentId,
			...(users.length ? { touser: users.join("|") } : {}),
			...(parties.length ? { toparty: parties.join("|") } : {}),
			...(tags.length ? { totag: tags.join("|") } : {}),
			...messageBody(message),
		}, options?.publicationIdentity ?? `wecom-app:${this.options.corpId}:${this.options.agentId}`);
	}

	/** appchat/send to a group created by this application (W14); no agentid, no recipient lists. */
	async sendToAppChat(
		message: WeComAppMessage,
		chatId: string,
		options?: { readonly publicationIdentity?: string | undefined },
	): Promise<WeComSendResult> {
		if (!chatId) throw new TypeError("WeCom appchat requires a chat_id.");
		return this.send("/cgi-bin/appchat/send", { chatid: chatId, ...messageBody(message) },
			// The chat discriminator is the output channel (journal scope);
			// persisted identities never carry conversation or recipient ids.
			options?.publicationIdentity ?? `wecom-appchat:${this.options.corpId}:${this.options.agentId}`);
	}

	private async accessToken(): Promise<string> {
		if (this.token && this.token.expiresAt > this.now()) return this.token.value;
		if (this.tokenPending) return this.tokenPending;
		this.tokenPending = (async () => {
			const url = `${WECOM_API_ORIGIN}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.options.corpId)}&corpsecret=${encodeURIComponent(this.options.appSecret)}`;
			let response;
			try {
				response = await this.fetch(url, { method: "GET" });
			} catch {
				throw new WeComAppError("authentication", 0);
			}
			let result: Record<string, unknown>;
			try {
				result = object(await response.json());
			} catch {
				throw new WeComAppError("authentication response", response.status);
			}
			const errcode = typeof result.errcode === "number" ? result.errcode : undefined;
			if (!response.ok || errcode !== 0 && errcode !== undefined) {
				throw new WeComAppError("authentication", response.status, errcode);
			}
			const value = text(result.access_token);
			const expiresIn = result.expires_in;
			if (!value || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
				throw new WeComAppError("authentication response", response.status);
			}
			this.token = { value, expiresAt: this.now() + Math.max(1, expiresIn - TOKEN_EXPIRY_MARGIN_SECONDS) * 1000 };
			return value;
		})();
		try {
			return await this.tokenPending;
		} finally {
			this.tokenPending = undefined;
		}
	}

	private async send(path: string, body: Record<string, unknown>, identity: string): Promise<WeComSendResult> {
		const token = await this.accessToken().catch((error: unknown) => error as WeComAppError);
		if (token instanceof WeComAppError) return tokenFailure(token);
		const first = await this.post(path, body, token, identity);
		// Only the explicit invalid/expired token codes refresh and retry once;
		// every other 4xx, timeout or unknown code leaves the POST un-repeated.
		if (first.kind !== "rejected" || !TOKEN_INVALID_CODES.has(first.errcode)) return first;
		if (this.token?.value === token) this.token = undefined;
		const refreshed = await this.accessToken().catch((error: unknown) => error as WeComAppError);
		if (refreshed instanceof WeComAppError) return tokenFailure(refreshed);
		return this.post(path, body, refreshed, identity);
	}

	private async post(path: string, body: Record<string, unknown>, token: string, identity: string): Promise<WeComSendResult> {
		// Report publications join the per-channel recovery journal; the
		// credential query never enters the operation identity (rotation must
		// not turn a confirmed send into a duplicate).
		const fetch = publicationFetch(this.fetch, "wecom_app", identity);
		let response;
		try {
			response = await fetch(`${WECOM_API_ORIGIN}${path}?access_token=${encodeURIComponent(token)}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch (error) {
			if (error instanceof PublicationReconciliationError) throw error;
			// A timed-out or broken POST has an unknown outcome; never resend.
			return { kind: "unknown", reason: "network" };
		}
		let result: Record<string, unknown>;
		try {
			result = object(await response.json());
		} catch {
			return { kind: "unknown", reason: response.ok ? "malformed_response" : "http" };
		}
		const errcode = typeof result.errcode === "number" ? result.errcode : undefined;
		if (errcode !== undefined && errcode !== 0) {
			return { kind: "rejected", errcode, reason: KNOWN_ERRCODE_REASONS[errcode] ?? "platform rejected the request" };
		}
		if (!response.ok) return { kind: "unknown", reason: "http" };
		const invalidUsers = joinedList(result.invaliduser);
		const invalidParties = joinedList(result.invalidparty);
		const invalidTags = joinedList(result.invalidtag);
		const unlicensedUsers = joinedList(result.unlicenseduser);
		if (invalidUsers.length || invalidParties.length || invalidTags.length || unlicensedUsers.length) {
			return { kind: "partial", invalidUsers, invalidParties, invalidTags, unlicensedUsers };
		}
		const msgid = text(result.msgid);
		return { kind: "delivered", ...(msgid !== undefined ? { msgid } : {}) };
	}
}

function messageBody(message: WeComAppMessage): Record<string, unknown> {
	const content = message.msgtype === "text" ? message.text.content : message.markdown.content;
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > CONTENT_MAX_BYTES) {
		// Caller-side splitting is the dispatcher's job (IM-05); refuse to let
		// the platform truncate silently.
		throw new TypeError(`WeCom ${message.msgtype} content is ${bytes} bytes; the platform caps at ${CONTENT_MAX_BYTES} and the caller must split.`);
	}
	return message as Record<string, unknown>;
}

function tokenFailure(error: WeComAppError): WeComSendResult {
	if (error.status === undefined) return { kind: "unknown", reason: "network" };
	if (error.errcode === undefined) return { kind: "unknown", reason: "malformed_response" };
	return { kind: "rejected", errcode: error.errcode, reason: KNOWN_ERRCODE_REASONS[error.errcode] ?? "authentication failed" };
}
