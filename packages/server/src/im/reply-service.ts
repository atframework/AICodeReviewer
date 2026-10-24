import { randomUUID } from "node:crypto";

import type { AppConfig } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { claimDueImReplyNotifications, finishImReplyNotification, type ImReplyNotificationRow } from "@aicr/store";
import { toBoundedSlackMarkdown, toDiscordMarkdown, toTelegramMessage } from "@aicr/outputs";
import { imConnectionRegistryFor } from "./connections.js";
import { parseSocialReplyPayload, socialReplyAuthorized } from "./social-command-service.js";

import { sendFeishuReply } from "./inline-reply.js";
import { WecomAibotLongConnection } from "./wecom-long-connection.js";

/**
 * Reply outbox worker (IM-16, O09–O12): delivers terminal review
 * notifications to the requesting conversations. Delivery failures back off
 * (pending + retryAt), exhaust into `failed`, and NEVER re-run a review —
 * the request row was already terminal when the notification was enqueued.
 */

const SCAN_INTERVAL_MS = 10_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;

interface CompactReceipt {
  readonly connectionName: string;
  readonly conversation: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly requestId: string;
  readonly state: string;
  readonly errorCode?: string | undefined;
  readonly repoRef: string;
  readonly revision: string;
}

export interface ImReplyServiceOptions {
  readonly store: StoreDb;
  readonly getConfig: () => Promise<AppConfig> | AppConfig;
  readonly env: (name: string) => string | undefined;
  readonly intervalMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

const STATE_TEXT: Readonly<Record<string, string>> = {
  succeeded: "完成（全部通过）",
  partial: "完成（部分目标未决）",
  publication_unknown: "完成（发布结果未知）",
  failed: "失败",
  rejected: "被拒绝",
};

export class ImReplyService {
  private readonly options: ImReplyServiceOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly owner = `im-reply-${randomUUID().slice(0, 8)}`;
  private readonly senders = new Map<string, { readonly key: string; readonly sender: WecomAibotLongConnection }>();
  private scanning = false;
  private stopped = false;
  private activeScan: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private longConnectionSender: ((connectionName: string, chatId: string, text: string, isGroup: boolean) => Promise<boolean>) | undefined;

  constructor(options: ImReplyServiceOptions) {
    this.options = options;
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }

  setLongConnectionSender(sender: typeof this.longConnectionSender): void {
    this.longConnectionSender = sender;
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    void this.scan();
    this.timer = setInterval(() => {
      void this.scan();
    }, this.options.intervalMs ?? SCAN_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  dispose(): void {
    this.stopped = true;
    this.abort.abort();
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of this.senders.values()) entry.sender.dispose();
    this.senders.clear();
  }

  async stop(): Promise<void> {
    this.dispose();
    await this.activeScan;
  }

  async scan(): Promise<void> {
    if (this.scanning || this.stopped) return;
    const task = this.scanPass();
    this.activeScan = task;
    try { await task; } finally { if (this.activeScan === task) this.activeScan = undefined; }
  }

  private async scanPass(): Promise<void> {
    this.scanning = true;
    try {
      const claimed = await claimDueImReplyNotifications(this.options.store, {
        owner: this.owner,
        limit: 10,
        now: this.now(),
      });
      for (const row of claimed) {
        if (this.stopped) break;
        await this.deliver(row);
      }
    } catch (error) {
      console.warn(JSON.stringify({ msg: "im_reply_scan_failed", error: String(error) }));
    } finally {
      this.scanning = false;
    }
  }

  private async expire(row: ImReplyNotificationRow): Promise<boolean> {
    if (row.expiry === null || row.expiry.getTime() > this.now().getTime()) return false;
    await finishImReplyNotification(this.options.store, {
      operationId: row.operationId, fence: row.fence, owner: this.owner, state: "expired", now: this.now(),
    });
    return true;
  }

  private leaseExpired(row: ImReplyNotificationRow): boolean {
    return row.leaseUntil !== null && row.leaseUntil.getTime() <= this.now().getTime();
  }

  private async backoff(row: ImReplyNotificationRow): Promise<"pending" | "failed" | "expired"> {
    const now = this.now();
    const retryAt = new Date(now.getTime() + BACKOFF_BASE_MS * 2 ** Math.min(row.attempts, MAX_ATTEMPTS));
    const expired = row.expiry !== null && row.expiry.getTime() <= now.getTime();
    const canRetry = !expired && row.attempts < MAX_ATTEMPTS && (row.expiry === null || retryAt.getTime() < row.expiry.getTime());
    const state = expired ? "expired" : canRetry ? "pending" : "failed";
    await finishImReplyNotification(this.options.store, {
      operationId: row.operationId, fence: row.fence, owner: this.owner, state,
      ...(canRetry ? { retryAt } : {}), now,
    });
    return state;
  }

  private async deliver(row: ImReplyNotificationRow): Promise<void> {
    if (row.payloadJson !== null) { await this.deliverSocial(row); return; }
    let postStarted = false;
    let receipt: CompactReceipt;
    try {
      receipt = JSON.parse(row.compactReceipt ?? "{}") as CompactReceipt;
    } catch {
      await finishImReplyNotification(this.options.store, {
        operationId: row.operationId, fence: row.fence, owner: this.owner, state: "failed", now: this.now(),
      });
      return;
    }
    try {
      if (row.attempts > MAX_ATTEMPTS) {
        await finishImReplyNotification(this.options.store, {
          operationId: row.operationId, fence: row.fence, owner: this.owner, state: "failed", now: this.now(),
        });
        return;
      }
      if (await this.expire(row)) return;
      const text = [
        `评审${STATE_TEXT[receipt.state] ?? receipt.state}：${receipt.requestId}`,
        `- 仓库: ${receipt.repoRef}`,
        `- 修订: ${receipt.revision.length > 12 ? receipt.revision.slice(0, 12) : receipt.revision}`,
        ...(receipt.errorCode !== undefined ? [`- 错误: ${receipt.errorCode}`] : []),
        "- 可用 aicr status <request-id> 查询，aicr detail <别名> <修订> 查看详情。",
      ].join("\n");
      const send = await this.prepareLegacySend(receipt, text);
      if (send === undefined) { await this.backoff(row); return; }
      if (this.stopped) { await this.backoff(row); return; }
      if (!await finishImReplyNotification(this.options.store, {
        operationId: row.operationId, fence: row.fence, owner: this.owner, state: "sending", now: this.now(),
      })) return;
      if (this.stopped) { await this.backoff(row); return; }
      if (await this.expire(row) || this.leaseExpired(row)) return;
      const delivered = await send(() => { postStarted = true; });
      if (!delivered && postStarted) return;
      const state = delivered ? "delivered" : await this.backoff(row);
      if (delivered) {
        await finishImReplyNotification(this.options.store, {
          operationId: row.operationId, fence: row.fence, owner: this.owner, state, now: this.now(),
        });
      }
      console.log(JSON.stringify({ msg: "im_reply_delivered", operationId: row.operationId, connection: receipt.connectionName, state }));
    } catch {
      console.warn(JSON.stringify({ msg: "im_reply_send_failed", operationId: row.operationId,
        code: postStarted ? "post_send_unknown" : "pre_send_failed" }));
      if (postStarted) return;
      try { await this.backoff(row); } catch { /* The leased row expires without another POST. */ }
    }
  }

  private async deliverSocial(row: ImReplyNotificationRow): Promise<void> {
    let postStarted = false;
    let connectionName: string | undefined;
    try {
      if (row.attempts > MAX_ATTEMPTS) {
        await finishImReplyNotification(this.options.store, {
          operationId: row.operationId, fence: row.fence, owner: this.owner, state: "failed", now: this.now(),
        });
        return;
      }
      if (await this.expire(row)) return;
      const payload = parseSocialReplyPayload(row.payloadJson ?? "");
      connectionName = payload?.connectionName;
      if (!payload || row.destinationIdentity !== payload.connectionIdentity) {
        await finishImReplyNotification(this.options.store, {
          operationId: row.operationId, fence: row.fence, owner: this.owner, state: "rejected", now: this.now(),
        });
        return;
      }
      const destination = "id" in payload.conversation ? payload.conversation.id : payload.actor.id;
      const registryOptions = { env: this.options.env, ...(this.options.fetch ? { fetch: this.options.fetch } : {}), now: () => this.now().getTime() };
      const config = await this.options.getConfig();
      const connection = config.im?.connections?.[payload.connectionName];
      if (!connection || (connection.kind !== "slack_app" && connection.kind !== "discord_bot" && connection.kind !== "telegram_bot") ||
          !await socialReplyAuthorized(config, row.namespace, payload, this.options.store)) {
        await finishImReplyNotification(this.options.store, {
          operationId: row.operationId, fence: row.fence, owner: this.owner, state: "rejected", now: this.now(),
        });
        return;
      }
      const client = imConnectionRegistryFor(config, registryOptions).social(connection);
      if (!client.isReady(destination) && !await client.refreshReadiness(destination)) {
        await this.backoff(row);
        return;
      }
      const latest = await this.options.getConfig();
      if (!await socialReplyAuthorized(latest, row.namespace, payload, this.options.store)) {
        await finishImReplyNotification(this.options.store, {
          operationId: row.operationId, fence: row.fence, owner: this.owner, state: "rejected", now: this.now(),
        });
        return;
      }

      // The final config generation owns authorization, credentials, readiness,
      // and the rendered message. No configuration or authorization awaits remain after CAS.
      const finalConfig = await this.options.getConfig();
      const finalConnection = finalConfig.im?.connections?.[payload.connectionName];
      if (!finalConnection || (finalConnection.kind !== "slack_app" && finalConnection.kind !== "discord_bot" && finalConnection.kind !== "telegram_bot") ||
          row.destinationIdentity !== payload.connectionIdentity ||
          !await socialReplyAuthorized(finalConfig, row.namespace, payload, this.options.store)) {
        await finishImReplyNotification(this.options.store, {
          operationId: row.operationId, fence: row.fence, owner: this.owner, state: "rejected", now: this.now(),
        });
        return;
      }
      const finalClient = imConnectionRegistryFor(finalConfig, registryOptions).social(finalConnection);
      if (!finalClient.isReady(destination) && !await finalClient.refreshReadiness(destination)) {
        await this.backoff(row);
        return;
      }
      const message = finalConnection.kind === "telegram_bot" ? toTelegramMessage(payload.text)
        : { text: finalConnection.kind === "slack_app" ? toBoundedSlackMarkdown(payload.text) : toDiscordMarkdown(payload.text) };
      if (this.stopped) { await this.backoff(row); return; }
      if (await this.expire(row)) return;
      if (!await finishImReplyNotification(this.options.store, {
        operationId: row.operationId, fence: row.fence, owner: this.owner, state: "sending", now: this.now(),
      })) return;
      if (this.stopped) { await this.backoff(row); return; }
      if (await this.expire(row) || this.leaseExpired(row)) return;
      postStarted = true;
      const result = await finalClient.sendMessage(destination, message, this.abort.signal);
      if (result.kind === "rejected" && (result.code === "destination_not_ready" || result.code === "cancelled_before_send")) {
        await this.backoff(row);
        return;
      }
      const retryAt = result.kind === "rejected" ? result.retryAt : undefined;
      const canRetry = retryAt !== undefined && row.attempts < MAX_ATTEMPTS && (row.expiry === null || retryAt < row.expiry.getTime());
      await finishImReplyNotification(this.options.store, {
        operationId: row.operationId, fence: row.fence, owner: this.owner,
        state: result.kind === "delivered" ? "delivered" : result.kind === "unknown" ? "unknown" : canRetry ? "pending"
          : retryAt !== undefined && row.attempts >= MAX_ATTEMPTS ? "failed" : "rejected",
        ...(canRetry ? { retryAt: new Date(retryAt) } : {}),
        compactReceipt: JSON.stringify(result.kind === "delivered" ? result.receipt : { code: result.code }), now: this.now(),
      });
    } catch {
      // Raw transport/config errors can contain credentials or Telegram token URLs.
      console.warn(JSON.stringify({ msg: "im_reply_send_failed", operationId: row.operationId, connection: connectionName,
        code: postStarted ? "post_send_unknown" : "pre_send_failed" }));
      if (postStarted) return;
      try { await this.backoff(row); } catch {
        console.warn(JSON.stringify({ msg: "im_reply_state_update_failed", operationId: row.operationId, code: "store_unavailable" }));
      }
    }
  }

  private async prepareLegacySend(receipt: CompactReceipt, text: string): Promise<((onPost: () => void) => Promise<boolean>) | undefined> {
    const config = await this.options.getConfig();
    const connection = config.im?.connections?.[receipt.connectionName];
    if (connection === undefined || connection.enabled === false) return undefined;
    let conversation: { kind: string; id?: string } = { kind: "app_direct" };
    try {
      conversation = JSON.parse(receipt.conversation) as { kind: string; id?: string };
    } catch { /* direct default */ }

    if (connection.kind === "feishu_app") {
      const appSecret = connection.app_secret
        ?? (connection.app_secret_env !== undefined ? this.options.env(connection.app_secret_env) : undefined)
        ?? "";
      if (!appSecret) return undefined;
      const isGroup = conversation.kind === "group";
      const receiveId = isGroup ? conversation.id ?? "" : receipt.actor.id;
      if (receiveId === "") return undefined;
      return async onPost => {
        const fetchImpl = this.options.fetch ?? globalThis.fetch;
        const trackedFetch: typeof globalThis.fetch = (input, init) => {
          if (String(input).includes("/open-apis/im/v1/messages")) onPost();
          return fetchImpl(input, init);
        };
        return sendFeishuReply(connection.app_id, appSecret, receiveId, isGroup ? "chat_id" : "open_id", text, trackedFetch);
      };
    }
    if (connection.kind === "wecom_aibot") {
      const chatId = conversation.kind === "group" ? conversation.id ?? "" : receipt.actor.id;
      if (chatId === "") return undefined;
      if (this.longConnectionSender !== undefined && connection.callback?.enabled !== true) {
        const sender = this.longConnectionSender;
        return async onPost => {
          onPost();
          return sender(receipt.connectionName, chatId, text, conversation.kind === "group");
        };
      }
      const secret = connection.secret
        ?? (connection.secret_env !== undefined ? this.options.env(connection.secret_env) : undefined)
        ?? "";
      const botId = connection.aibot_id ?? "";
      if (!secret || !botId) return undefined;
      const senderKey = JSON.stringify([botId, secret]);
      let entry = this.senders.get(receipt.connectionName);
      if (entry !== undefined && entry.key !== senderKey) {
        entry.sender.dispose();
        this.senders.delete(receipt.connectionName);
        entry = undefined;
      }
      if (entry === undefined) {
        const sender = new WecomAibotLongConnection({
          botId, secret, connectionName: receipt.connectionName, namespace: "im-reply",
          onMessage: async () => undefined,
          onStatusChange: (status) => {
            console.log(JSON.stringify({ msg: "im_reply_sender_status", connection: receipt.connectionName, status }));
          },
        });
        entry = { key: senderKey, sender };
        this.senders.set(receipt.connectionName, entry);
        await sender.connect();
      }
      const activeEntry = entry;
      return async onPost => {
        onPost();
        await activeEntry.sender.sendProactive(chatId, text, conversation.kind === "group");
        return true;
      };
    }
    return undefined;
  }
}
