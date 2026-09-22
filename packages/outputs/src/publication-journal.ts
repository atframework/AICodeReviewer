import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import type { RemotePublicationOperation } from "@aicr/core";
import type { FetchLike, ResponseLike } from "./index.js";

type Provider = "github" | "gitea" | "gitlab" | "feishu" | "webhook";
type Operation = RemotePublicationOperation;
type Request = NonNullable<Parameters<FetchLike>[1]>;

export class PublicationReconciliationError extends Error {
  constructor(readonly reason: string) {
    super(`Remote publication reconciliation: ${reason}`);
    this.name = "PublicationReconciliationError";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function marker(id: string): string { return `<!-- aicr:publication=${id} -->`; }

function compactResponse(raw: unknown): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const key of ["id", "number", "iid", "index", "html_url", "url", "state", "message_id", "code"]) {
    const value = object(raw)[key];
    if ((typeof value === "string" && value.length <= 2048) || (typeof value === "number" && Number.isFinite(value))) result[key] = value;
  }
  const messageId = object(object(raw).data).message_id;
  if (typeof messageId === "string" && messageId.length <= 2048) result.message_id = messageId;
  return result;
}

function response(value: NonNullable<Operation["response"]>, feishu = false): ResponseLike {
  const raw = feishu ? { code: 0, data: { message_id: value.data.message_id } } : value.data;
  return { ok: true, status: value.status, statusText: "Reconciled", json: async () => raw, text: async () => JSON.stringify(raw) };
}

function withBody(sent: ResponseLike, raw: unknown): ResponseLike {
  return { ok: sent.ok, status: sent.status, statusText: sent.statusText, ...(sent.headers ? { headers: sent.headers } : {}), json: async () => raw, text: async () => JSON.stringify(raw) };
}

function gitScope(url: URL, provider: Provider): string | undefined {
  const pattern = provider === "gitlab" ? /^(.*\/api\/v4\/projects\/[^/]+)(?:\/|$)/u
    : provider === "gitea" ? /^(.*\/api\/v1\/repos\/[^/]+\/[^/]+)(?:\/|$)/u
    : provider === "github" ? /^(.*\/repos\/[^/]+\/[^/]+)(?:\/|$)/u : undefined;
  const path = pattern?.exec(url.pathname)?.[1];
  return path && !url.username && !url.password ? `${url.origin}${path}` : undefined;
}

const current = new AsyncLocalStorage<{ journal: PublicationJournal; channel: string; call: string }>();

export function hasPublicationJournal(): boolean { return current.getStore() !== undefined; }

/** Explicitly scoped by the composite publisher; unrelated HTTP/LLM traffic is untouched. */
export function publicationFetch(fetch: FetchLike, provider: Provider, identity?: string): FetchLike {
  return (url, init) => {
    const context = current.getStore();
    return context ? context.journal.fetch(context.channel, context.call, provider, fetch, url, init ?? {}, identity) : fetch(url, init);
  };
}

export function validateRemotePublicationOperations(value: unknown): value is readonly Operation[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every(raw => {
    const op = object(raw);
    if (typeof op.id !== "string" || !/^[a-f0-9]{64}$/u.test(op.id) || ids.has(op.id)) return false;
    ids.add(op.id);
    if (![op.channel, op.call].every(v => typeof v === "string" && v.length > 0)
      || !["marker", "state", "delete", "feishu_uuid", "unqueryable"].includes(String(op.strategy))
      || !["unknown", "confirmed", "rejected"].includes(String(op.status))
      || ![op.attempts, op.reconciliations].every(v => Number.isSafeInteger(v) && Number(v) >= 0)
      || ![op.firstAttemptAt, op.updatedAt].every(v => typeof v === "number" && Number.isFinite(v))) return false;
    if (["marker", "state", "delete"].includes(String(op.strategy))) {
      if (typeof op.target !== "string" || typeof op.scope !== "string") return false;
      try {
        const target = new URL(op.target);
        if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash
          || !op.target.startsWith(`${op.scope}/`)) return false;
      } catch { return false; }
    } else if (op.target !== undefined || op.scope !== undefined) return false;
    if (op.collection !== undefined && typeof op.collection !== "boolean") return false;
    if (op.strategy === "state" && !["open", "closed"].includes(String(op.expectedState))) return false;
    if (op.response !== undefined) {
      const saved = object(op.response);
      if (!Number.isInteger(saved.status) || Number(saved.status) < 200 || Number(saved.status) >= 300
        || !saved.data || typeof saved.data !== "object" || Array.isArray(saved.data)
        || Object.values(saved.data).some(v => typeof v !== "string" && typeof v !== "number")) return false;
    }
    return op.status !== "confirmed" || op.response !== undefined;
  });
}

export class PublicationJournal {
  private readonly operations: Map<string, Operation>;
  private readonly checked = new Set<string>();
  private failure: unknown;

  constructor(private readonly options: {
    readonly batchId: string;
    readonly operations?: readonly Operation[];
    readonly save: (operations: readonly Operation[]) => Promise<void>;
    readonly signal?: AbortSignal;
    readonly now?: () => number;
  }) {
    this.operations = new Map(options.operations?.map(op => [op.id, op]));
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  publishedUrl(channel: string, call: string): string | undefined {
    const value = [...this.operations.values()].find(op => op.channel === channel && op.call === call && op.status === "confirmed" && typeof op.response?.data.html_url === "string")?.response?.data.html_url;
    return typeof value === "string" ? value : undefined;
  }
  private guard(): void {
    this.options.signal?.throwIfAborted();
    if (this.failure) throw this.failure;
  }
  private async save(op: Operation): Promise<void> {
    this.guard();
    this.operations.set(op.id, op);
    try { await this.options.save([...this.operations.values()]); } catch (error) {
      this.failure = error;
      throw error;
    }
    this.guard();
  }

  async run<T>(channel: string, call: string, work: () => Promise<T>): Promise<T> {
    this.guard();
    return current.run({ journal: this, channel, call }, async () => {
      const result = await work();
      this.guard();
      if ([...this.operations.values()].some(op => op.channel === channel && op.call === call && op.status === "unknown")) {
        throw new PublicationReconciliationError("unconfirmed_write");
      }
      return result;
    });
  }

  private async reconcile(op: Operation, provider: Provider, fetch: FetchLike, headers: Request["headers"]): Promise<void> {
    const checking = { ...op, reconciliations: op.reconciliations + 1, updatedAt: this.now() };
    await this.save(checking);
    const target = new URL(op.target!);
    const deadline = this.now() + 30_000;
    const timeout = AbortSignal.timeout(30_000);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
    const matches: unknown[] = [];
    for (let page = 1; page <= (op.collection ? 20 : 1); page++) {
      this.guard();
      if (this.now() > deadline) throw new PublicationReconciliationError("query_limit");
      const url = new URL(target);
      if (op.collection) {
        url.searchParams.set(provider === "gitea" ? "limit" : "per_page", "100");
        url.searchParams.set("page", String(page));
        if (/\/issues$/u.test(url.pathname)) url.searchParams.set("state", "all");
      }
      const found = await fetch(url.href, { method: "GET", signal, redirect: "error", ...(headers ? { headers } : {}) });
      this.guard();
      if (op.strategy === "delete" && found.status === 404) {
        await this.save({ ...checking, status: "confirmed", response: { status: 204, data: {} } });
        return;
      }
      if (!found.ok) throw new PublicationReconciliationError(`query_http_${found.status}`);
      const raw = await found.json();
      if (op.collection && !Array.isArray(raw)) throw new PublicationReconciliationError("invalid_query_response");
      for (const item of op.collection ? raw as unknown[] : [raw]) {
        const data = object(item);
        const bodies = [data.body, ...(Array.isArray(data.notes) ? data.notes.map(n => object(n).body) : [])];
        if (op.strategy === "marker" ? bodies.some(body => typeof body === "string" && body.includes(marker(op.id)))
          : op.strategy === "state" && data.state === op.expectedState) matches.push(item);
      }
      const next = found.headers?.get("x-next-page");
      const link = found.headers?.get("link") ?? "";
      const hasNext = /rel=["']?next\b/u.test(link) || Boolean(next?.trim());
      // Never follow a server-supplied URL with credentials. Numeric pages stay on this resource.
      if (!op.collection || (!hasNext && (raw as unknown[]).length < 100)) break;
      if (page === 20) throw new PublicationReconciliationError("query_limit");
    }
    if (matches.length !== 1) throw new PublicationReconciliationError(matches.length ? "ambiguous_marker" : "remote_write_not_found");
    const data = compactResponse(matches[0]);
    if (op.strategy === "marker" && data.id === undefined) throw new PublicationReconciliationError("invalid_remote_identity");
    await this.save({ ...checking, status: "confirmed", response: { status: 200, data } });
  }

  async fetch(channel: string, call: string, provider: Provider, fetch: FetchLike, input: string, init: Request, identity?: string): Promise<ResponseLike> {
    this.guard();
    const url = new URL(input);
    const scope = gitScope(url, provider);
    // Query pending writes before a live list changes the dispatcher's create/update branch.
    for (const op of this.operations.values()) {
      if (op.channel === channel && op.call === call && op.status === "unknown" && op.scope === scope && scope && !this.checked.has(op.id)) {
        this.checked.add(op.id);
        await this.reconcile(op, provider, fetch, init.headers);
      }
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") return fetch(input, init);
    const body = init.body === undefined ? {} : object(JSON.parse(init.body));
    // Labels are optional, set-like metadata; they do not publish report messages.
    if (scope && /\/labels(?:\/[^/]+)?$/u.test(url.pathname)) return fetch(input, init);
    let strategy: Operation["strategy"] = "unqueryable";
    let collection = false;
    if (scope && !url.search && !url.hash) {
      if ((method === "POST" || method === "PATCH") && typeof body.body === "string") {
        strategy = "marker";
        collection = method === "POST";
      } else if (method === "PATCH" && ["open", "closed"].includes(String(body.state))) strategy = "state";
      else if (method === "DELETE") strategy = "delete";
      // GitLab add_labels is a set-like update, not a report publication.
    } else if (scope && method === "PUT" && url.searchParams.has("add_labels")) return fetch(input, init);
    if (provider === "feishu") strategy = "feishu_uuid";
    const { uuid: _uuid, timestamp: _timestamp, sign: _sign, ...stableBody } = body;
    const id = hash([this.options.batchId, channel, call, method, input, stableBody, identity ?? null]);
    const existing = this.operations.get(id);
    if (existing?.status === "confirmed") return response(existing.response!, provider === "feishu");
    if ((provider === "feishu" || provider === "webhook") && [...this.operations.values()].some(op => op.channel === channel && op.call === call && op.status === "confirmed")) {
      throw new PublicationReconciliationError("request_changed_after_confirmed_write");
    }
    // A changed renderer/recipient must never turn an uncertain IM send into a new message.
    if ([...this.operations.values()].some(op => op.channel === channel && op.call === call && op.status === "unknown" && op.id !== id)) {
      throw new PublicationReconciliationError("request_changed_after_unknown_write");
    }
    if (existing?.status === "unknown") {
      if (strategy !== "feishu_uuid") throw new PublicationReconciliationError("publisher_cannot_reconcile");
      // Official UUID validity is one hour. Leave a minute for transport/clock margins.
      if (this.now() < existing.firstAttemptAt || this.now() - existing.firstAttemptAt >= 59 * 60_000) {
        throw new PublicationReconciliationError("idempotency_window_expired");
      }
    }
    const op: Operation = {
      id, channel, call, strategy, status: "unknown",
      ...(scope && strategy !== "unqueryable" ? { scope, target: `${url.origin}${url.pathname}`, collection } : {}),
      ...(strategy === "state" ? { expectedState: String(body.state) } : {}),
      attempts: (existing?.attempts ?? 0) + 1,
      reconciliations: (existing?.reconciliations ?? 0) + (existing?.status === "unknown" ? 1 : 0),
      firstAttemptAt: existing?.firstAttemptAt ?? this.now(), updatedAt: this.now(),
    };
    let outgoing = init;
    if (strategy === "marker") outgoing = { ...init, body: JSON.stringify({ ...body, body: `${body.body}\n\n${marker(id)}` }) };
    if (strategy === "feishu_uuid") outgoing = { ...init, body: JSON.stringify({ ...body, uuid: id.slice(0, 48) }) };
    await this.save(op); // Write-ahead intent, fenced by the batch lease.
    this.checked.add(id);
    const sent = await fetch(input, { ...outgoing, redirect: "error", ...(this.options.signal ? { signal: this.options.signal } : {}) });
    this.guard();
    if (!sent.ok) {
      if (sent.status >= 400 && sent.status < 500 && sent.status !== 408) await this.save({ ...op, status: "rejected", updatedAt: this.now() });
      return sent;
    }
    const raw = sent.status === 204 ? {} : await sent.json();
    this.guard();
    if (strategy === "marker" && compactResponse(raw).id === undefined) throw new PublicationReconciliationError("invalid_write_response");
    if (provider === "feishu" && (object(raw).code !== 0 || typeof object(object(raw).data).message_id !== "string")) {
      // Only explicit token rejections authorize the client's token-refresh retry.
      if ([99991663, 99991671].includes(Number(object(raw).code))) await this.save({ ...op, status: "rejected", updatedAt: this.now() });
      return withBody(sent, raw);
    }
    if (strategy === "unqueryable") {
      const data = object(raw);
      if ((data.code !== undefined && data.code !== 0) || (data.errcode !== undefined && data.errcode !== 0)) {
        return withBody(sent, raw);
      }
    }
    await this.save({ ...op, status: "confirmed", updatedAt: this.now(), response: { status: sent.status, data: compactResponse(raw) } });
    return withBody(sent, raw);
  }
}
