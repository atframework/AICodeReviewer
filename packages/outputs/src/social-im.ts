import type { ImConnectionConfig } from "@aicr/core";
import type { FetchLike, ResponseLike } from "./index.js";
import {
  publicationFetch,
  PublicationReconciliationError,
} from "./publication-journal.js";

export type SocialImConnection = Extract<
  ImConnectionConfig,
  { kind: "slack_app" | "discord_bot" | "telegram_bot" }
>;
export type SocialImReceipt = {
  readonly messageId: string;
  readonly destination: string;
};
export type SocialImSendResult =
  | { readonly kind: "delivered"; readonly receipt: SocialImReceipt }
  | {
      readonly kind: "rejected";
      readonly code: string;
      readonly retryAt?: number;
    }
  | { readonly kind: "unknown"; readonly code: string };
export interface TelegramMessageEntity {
  readonly type: "bold" | "italic" | "code" | "pre" | "text_link";
  readonly offset: number;
  readonly length: number;
  readonly url?: string;
  readonly language?: string;
}
export interface SocialImMessage {
  readonly text: string;
  readonly entities?: readonly TelegramMessageEntity[];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const numericId = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : undefined;
const snowflake = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]{0,31}$/u.test(value);
const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** No remote write is retried here. Only an explicit rate limit authorizes a caller's later retry. */
export class SocialImClient {
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly ready = new Map<string, number>();
  private readonly readinessReads = new Map<string, Promise<boolean>>();
  private readonly rateLimits = new Map<string, number>();
  private botUsername: string | undefined;
  private readonly origin: string;
  constructor(
    readonly connection: SocialImConnection,
    private readonly token: string,
    options: {
      readonly fetch?: FetchLike | undefined;
      readonly now?: (() => number) | undefined;
    } = {},
  ) {
    if (
      !token ||
      /[\s/\\?#]/u.test(token) ||
      (connection.kind === "telegram_bot" &&
        !/^[1-9][0-9]*:[A-Za-z0-9_-]+$/u.test(token))
    )
      throw new Error("Invalid social IM credential.");
    this.fetch = options.fetch ?? defaultFetch;
    this.now = options.now ?? Date.now;
    this.origin =
      connection.kind === "slack_app"
        ? "https://slack.com/api"
        : connection.kind === "discord_bot"
          ? "https://discord.com/api/v10"
          : "https://api.telegram.org";
  }
  /** Check the remaining validity without extending the cached verification. */
  isReady(destination: string, minimumValidityMs = 0): boolean {
    return (this.ready.get(destination) ?? 0) > this.now() + minimumValidityMs;
  }
  telegramUsername(): string | undefined {
    return this.botUsername;
  }
  private url(path: string): string {
    return `${this.origin}${this.connection.kind === "telegram_bot" ? `/bot${this.token}` : ""}/${path}`;
  }
  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.connection.kind === "telegram_bot"
        ? {}
        : {
            Authorization: `${this.connection.kind === "discord_bot" ? "Bot" : "Bearer"} ${this.token}`,
          }),
    };
  }
  private async read(
    path: string,
    body?: object,
  ): Promise<Record<string, unknown>> {
    const sent = await this.fetch(this.url(path), {
      method: body === undefined ? "GET" : "POST",
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!sent.ok) throw new Error("Social IM readiness failed.");
    const raw = record(await sent.json());
    if (this.connection.kind !== "discord_bot" && raw.ok !== true)
      throw new Error("Social IM readiness failed.");
    return raw;
  }
  /** Called by background prewarming or an output worker, never by the callback handler. */
  refreshReadiness(destination: string): Promise<boolean> {
    const active = this.readinessReads.get(destination);
    if (active) return active;
    // Background refresh and concurrent output workers share one metadata result per target.
    const pending = this.checkReadiness(destination).finally(() => {
      this.readinessReads.delete(destination);
    });
    this.readinessReads.set(destination, pending);
    return pending;
  }
  private async checkReadiness(destination: string): Promise<boolean> {
    let refreshed = false;
    try {
      const connection = this.connection;
      if (connection.kind === "slack_app") {
        const identity = await this.read("auth.test", {});
        if (
          identity.team_id !== connection.team_id ||
          identity.user_id !== connection.bot_user_id ||
          typeof identity.bot_id !== "string"
        )
          return false;
        const channel = record(
          (
            await this.read(
              `conversations.info?channel=${encodeURIComponent(destination)}`,
            )
          ).channel,
        );
        if (
          channel.id !== destination ||
          channel.context_team_id !== connection.team_id ||
          channel.is_im !== false ||
          channel.is_mpim !== false ||
          channel.is_archived !== false ||
          channel.is_member !== true ||
          channel.is_read_only === true ||
          channel.is_frozen === true ||
          channel.is_thread_only === true ||
          (channel.is_channel !== true && channel.is_group !== true)
        )
          return false;
      } else if (connection.kind === "discord_bot") {
        const identity = await this.read("oauth2/applications/@me");
        if (identity.id !== connection.application_id) return false;
        const channel = await this.read(
          `channels/${encodeURIComponent(destination)}`,
        );
        if (
          channel.id !== destination ||
          channel.guild_id !== connection.guild_id ||
          channel.type !== 0
        )
          return false;
      } else {
        const identity = record((await this.read("getMe")).result);
        if (
          numericId(identity.id) !== connection.bot_id ||
          identity.is_bot !== true ||
          typeof identity.username !== "string" ||
          !/^[A-Za-z0-9_]+$/u.test(identity.username)
        )
          return false;
        const chat = record(
          (await this.read("getChat", { chat_id: destination })).result,
        );
        if (
          numericId(chat.id) !== destination ||
          !["private", "group", "supergroup"].includes(String(chat.type)) ||
          chat.is_forum === true
        )
          return false;
        this.botUsername = identity.username;
      }
      this.ready.set(destination, this.now() + 300_000);
      refreshed = true;
      return true;
    } catch {
      return false;
    } finally {
      // Pending metadata reads keep only the old, bounded verification; any failure revokes it.
      if (!refreshed) this.ready.delete(destination);
    }
  }
  async sendMessage(
    destination: string,
    message: SocialImMessage,
    signal?: AbortSignal,
  ): Promise<SocialImSendResult> {
    if (signal?.aborted)
      return { kind: "rejected", code: "cancelled_before_send" };
    const limit = this.connection.kind === "discord_bot" ? 1900 : 3900;
    if (
      !message.text ||
      message.text.length > limit ||
      message.entities?.some(
        (entity) =>
          !["bold", "italic", "code", "pre", "text_link"].includes(
            entity.type,
          ) ||
          !Number.isSafeInteger(entity.offset) ||
          !Number.isSafeInteger(entity.length) ||
          entity.offset < 0 ||
          entity.length <= 0 ||
          entity.offset + entity.length > message.text.length ||
          (entity.type === "text_link" &&
            !/^https?:\/\//u.test(entity.url ?? "")),
      )
    )
      return { kind: "rejected", code: "invalid_message" };
    if (!this.isReady(destination))
      return { kind: "rejected", code: "destination_not_ready" };
    const due = Math.max(
      this.rateLimits.get(destination) ?? 0,
      this.rateLimits.get("*") ?? 0,
    );
    if (due > this.now())
      return { kind: "rejected", code: "rate_limited", retryAt: due };
    const kind = this.connection.kind;
    const path =
      kind === "slack_app"
        ? "chat.postMessage"
        : kind === "discord_bot"
          ? `channels/${encodeURIComponent(destination)}/messages`
          : "sendMessage";
    const body =
      kind === "slack_app"
        ? {
            channel: destination,
            text: message.text,
            parse: "none",
            unfurl_links: false,
            unfurl_media: false,
          }
        : kind === "discord_bot"
          ? {
              content: message.text,
              allowed_mentions: { parse: [], replied_user: false },
            }
          : {
              chat_id: destination,
              text: message.text,
              entities: message.entities ?? [],
              link_preview_options: { is_disabled: true },
            };
    let sent: ResponseLike;
    try {
      const timeout = AbortSignal.timeout(10_000);
      sent = await publicationFetch(
        this.fetch,
        kind,
        this.identity(),
      )(this.url(path), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      return error instanceof PublicationReconciliationError &&
        error.reason === "publisher_previously_rejected"
        ? { kind: "rejected", code: "previously_rejected" }
        : { kind: "unknown", code: "transport_or_receipt_unknown" };
    }
    let raw: Record<string, unknown> = {};
    try {
      raw = record(await sent.json());
    } catch {
      /* A missing response cannot prove that no message was posted. */
    }
    if (
      sent.status === 429 ||
      (kind === "telegram_bot" && raw.ok === false && raw.error_code === 429)
    ) {
      const header = sent.headers?.get("Retry-After");
      const seconds =
        kind === "telegram_bot"
          ? record(raw.parameters).retry_after
          : kind === "discord_bot"
            ? raw.retry_after
            : header === null || header === undefined
              ? undefined
              : Number(header);
      if (
        typeof seconds === "number" &&
        Number.isFinite(seconds) &&
        seconds > 0 &&
        seconds <= 86_400
      ) {
        const retryAt = this.now() + Math.ceil(seconds * 1000);
        this.rateLimits.set(raw.global === true ? "*" : destination, retryAt);
        return { kind: "rejected", code: "rate_limited", retryAt };
      }
      return { kind: "rejected", code: "rate_limit_without_due" };
    }
    if (!sent.ok)
      return sent.status >= 400 && sent.status < 500 && sent.status !== 408
        ? { kind: "rejected", code: `http_${sent.status}` }
        : { kind: "unknown", code: "http_result_unknown" };
    if (kind === "slack_app") {
      if (raw.ok === false)
        return [
          "internal_error",
          "fatal_error",
          "service_unavailable",
        ].includes(String(raw.error))
          ? { kind: "unknown", code: "slack_result_unknown" }
          : { kind: "rejected", code: "slack_business_rejected" };
      if (
        raw.ok === true &&
        raw.channel === destination &&
        typeof raw.ts === "string" &&
        /^\d+\.\d+$/u.test(raw.ts)
      )
        return {
          kind: "delivered",
          receipt: { destination, messageId: raw.ts },
        };
    } else if (kind === "discord_bot") {
      if (snowflake(raw.id) && raw.channel_id === destination)
        return {
          kind: "delivered",
          receipt: { destination, messageId: raw.id },
        };
    } else {
      if (raw.ok === false)
        return Number(raw.error_code) >= 500
          ? { kind: "unknown", code: "telegram_result_unknown" }
          : { kind: "rejected", code: "telegram_business_rejected" };
      const result = record(raw.result);
      if (
        raw.ok === true &&
        numericId(record(result.chat).id) === destination &&
        Number.isSafeInteger(result.message_id) &&
        Number(result.message_id) > 0
      )
        return {
          kind: "delivered",
          receipt: { destination, messageId: String(result.message_id) },
        };
    }
    return { kind: "unknown", code: "invalid_message_receipt" };
  }
  identity(): string {
    const c = this.connection;
    return JSON.stringify(
      c.kind === "slack_app"
        ? [c.kind, c.app_id, c.team_id, c.bot_user_id]
        : c.kind === "discord_bot"
          ? [c.kind, c.application_id, c.guild_id]
          : [c.kind, c.bot_id],
    );
  }
}
