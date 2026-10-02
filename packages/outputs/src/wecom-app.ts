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

/** Directory snapshot facts (authorization scope sources; read-only). */
export interface WeComDirectoryDepartment {
	readonly id: number;
	readonly name: string;
	readonly parentId: number | undefined;
}

export interface WeComDirectoryUser {
	readonly userid: string;
	/** Direct department ids. */
	readonly departments: readonly number[];
	readonly position: string | undefined;
	/** Custom-field name → first text value. */
	readonly extattr: ReadonlyMap<string, string>;
}

export interface WeComDirectoryTag {
	readonly id: number;
	readonly name: string;
}

export type WeComAppMessage =
	| { readonly msgtype: "text"; readonly text: { readonly content: string } }
	| { readonly msgtype: "markdown"; readonly markdown: { readonly content: string } }
	| { readonly msgtype: "template_card"; readonly template_card: WeComButtonCardMessage };

/**
 * button_interaction template card (W13/W15): a single callback button. Only
 * apps with a configured callback URL may send callback cards; appchat/send
 * has no template_card type at all (W14), so this rides message/send only.
 */
export interface WeComButtonCardMessage {
	readonly card_type: "button_interaction";
	readonly main_title: { readonly title: string; readonly desc?: string | undefined };
	readonly sub_title_text?: string | undefined;
	/** Required for button cards: `[0-9A-Za-z_\-@]`, ≤128 bytes, unique per application task. */
	readonly task_id: string;
	readonly button_list: readonly [{
		readonly text: string;
		/** 0 = callback click event (the key returns as the callback EventKey). */
		readonly type: 0;
		readonly key: string;
		readonly style?: 1 | 2 | 3 | 4;
	}];
}

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

	// ---------------------------------------------------------------------------
	// Directory queries (authorization scopes; read-only, never journaled)
	// ---------------------------------------------------------------------------

	/** department/list: the corporate department tree. */
	async directoryDepartments(): Promise<readonly WeComDirectoryDepartment[]> {
		const result = await this.authorizedGet("/cgi-bin/department/list", new URLSearchParams({ id: "1" }), "department list");
		const departments: WeComDirectoryDepartment[] = [];
		for (const item of Array.isArray(result.department) ? result.department : []) {
			const record = object(item);
			const id = typeof record.id === "number" ? record.id : undefined;
			const name = text(record.name);
			if (id === undefined || !name) throw new WeComAppError("department identity", 200);
			departments.push({ id, name, parentId: typeof record.parentid === "number" ? record.parentid : undefined });
		}
		return departments;
	}

	/**
	 * user/list (department member details): plaintext userid with direct
	 * departments, position and text-type extattr values, aggregated over
	 * offset pages.
	 */
	async directoryUserDetails(departmentId: number, fetchChild: boolean): Promise<readonly WeComDirectoryUser[]> {
		const users = new Map<string, WeComDirectoryUser>();
		for (let page = 0; page < 200; page += 1) {
			const query = new URLSearchParams({
				department_id: String(departmentId),
				fetch_child: fetchChild ? "1" : "0",
				offset: String(page * 100),
				size: "100",
			});
			const result = await this.authorizedGet("/cgi-bin/user/list", query, "department users");
			const items = Array.isArray(result.userlist) ? result.userlist : [];
			for (const item of items) {
				const record = object(item);
				const userid = text(record.userid);
				if (!userid) throw new WeComAppError("department user identity", 200);
				const departments = Array.isArray(record.department)
					? record.department.filter((id: unknown): id is number => typeof id === "number")
					: [];
				const extattr = new Map<string, string>();
				const attrs = record.extattr;
				if (Array.isArray(attrs)) {
					for (const attr of attrs) {
						const entry = object(attr);
						const name = text(entry.name);
						const value = text(object(entry.text).value);
						if (name && value && !extattr.has(name)) extattr.set(name, value);
					}
				}
				users.set(userid, {
					userid,
					departments,
					position: text(record.position),
					extattr,
				});
			}
			if (items.length < 100) break;
		}
		return [...users.values()];
	}

	/** tag/list: the app-visible tags (the "role/user group" carrier). */
	async directoryTags(): Promise<readonly WeComDirectoryTag[]> {
		const result = await this.authorizedGet("/cgi-bin/tag/list", new URLSearchParams(), "tag list");
		const tags: WeComDirectoryTag[] = [];
		for (const item of Array.isArray(result.taglist) ? result.taglist : []) {
			const record = object(item);
			const id = typeof record.tagid === "number" ? record.tagid : undefined;
			const name = text(record.tagname);
			if (id === undefined || !name) throw new WeComAppError("tag identity", 200);
			tags.push({ id, name });
		}
		return tags;
	}

	/** tag/get: member userids of one tag. */
	async directoryTagMembers(tagId: number): Promise<readonly string[]> {
		const result = await this.authorizedGet("/cgi-bin/tag/get", new URLSearchParams({ tagid: String(tagId) }), "tag members");
		const members: string[] = [];
		for (const item of Array.isArray(result.userlist) ? result.userlist : []) {
			const userid = text(object(item).userid);
			if (userid) members.push(userid);
		}
		return members;
	}

	/**
	 * batch/openuserid_to_userid (自建应用与智能机器人的对接, path/101521):
	 * convert the smart robot's encrypted open_userid values into plaintext
	 * userids. Already-plaintext ids come back in `invalid`.
	 */
	async convertOpenUserIds(openUserIds: readonly string[]): Promise<{ readonly converted: ReadonlyMap<string, string>; readonly invalid: readonly string[] }> {
		const result = await this.authorizedPost("/cgi-bin/batch/openuserid_to_userid", { open_userid_list: openUserIds.slice(0, 1000) }, "open userid conversion");
		const converted = new Map<string, string>();
		for (const item of Array.isArray(result.userid_list) ? result.userid_list : []) {
			const record = object(item);
			const open = text(record.open_userid);
			const userid = text(record.userid);
			if (open && userid) converted.set(open, userid);
		}
		const invalid: string[] = [];
		for (const item of Array.isArray(result.invalid_open_userid_list) ? result.invalid_open_userid_list : []) {
			if (typeof item === "string") invalid.push(item);
		}
		return { converted, invalid };
	}

	private async accessToken(): Promise<string> {
		if (this.token && this.token.expiresAt > this.now()) return this.token.value;
		if (this.tokenPending) return this.tokenPending;
		this.tokenPending = (async () => {
			const url = `${WECOM_API_ORIGIN}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.options.corpId)}&corpsecret=${encodeURIComponent(this.options.appSecret)}`;
			let response;
			try {
				response = await this.fetch(url.toString(), { method: "GET" });
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

	/** Token-authenticated read-only GET with one invalid-token retry; directory queries never journal. */
	private async authorizedGet(path: string, query: URLSearchParams, operation: string): Promise<Record<string, unknown>> {
		const token = await this.accessToken();
		try {
			return await this.request("GET", path, query, token, operation);
		} catch (error) {
			if (!(error instanceof WeComAppError) || !TOKEN_INVALID_CODES.has(error.errcode ?? 0)) throw error;
			if (this.token?.value === token) this.token = undefined;
			return this.request("GET", path, query, await this.accessToken(), operation);
		}
	}

	/** Token-authenticated POST with one invalid-token retry; directory queries never journal. */
	private async authorizedPost(path: string, body: Record<string, unknown>, operation: string): Promise<Record<string, unknown>> {
		const token = await this.accessToken();
		try {
			return await this.request("POST", path, new URLSearchParams(), token, operation, body);
		} catch (error) {
			if (!(error instanceof WeComAppError) || !TOKEN_INVALID_CODES.has(error.errcode ?? 0)) throw error;
			if (this.token?.value === token) this.token = undefined;
			return this.request("POST", path, new URLSearchParams(), await this.accessToken(), operation, body);
		}
	}

	private async request(
		method: "GET" | "POST",
		path: string,
		query: URLSearchParams,
		token: string,
		operation: string,
		body?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const url = new URL(`${WECOM_API_ORIGIN}${path}`);
		url.searchParams.set("access_token", token);
		for (const [key, value] of query) if (key !== "access_token") url.searchParams.set(key, value);
		let response;
		try {
			response = await this.fetch(url.toString(), {
				method,
				...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
			});
		} catch {
			throw new WeComAppError(operation, 0);
		}
		let result: Record<string, unknown>;
		try {
			result = object(await response.json());
		} catch {
			throw new WeComAppError(`${operation} response`, response.status);
		}
		const errcode = typeof result.errcode === "number" ? result.errcode : undefined;
		if (!response.ok || (errcode !== undefined && errcode !== 0)) {
			throw new WeComAppError(operation, response.ok ? 200 : response.status, errcode);
		}
		return result;
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
	if (message.msgtype === "template_card") {
		const card = message.template_card;
		const taskId = card.task_id;
		if (!/^[0-9A-Za-z_\-@]{1,128}$/u.test(taskId)) {
			throw new TypeError("WeCom template_card task_id must match [0-9A-Za-z_\\-@] within 128 bytes.");
		}
		if (card.button_list.some(button => Buffer.byteLength(button.key, "utf8") > 1024)) {
			throw new TypeError("WeCom template_card button keys are capped at 1024 bytes.");
		}
		return message as Record<string, unknown>;
	}
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
