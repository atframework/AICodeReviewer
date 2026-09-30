import { randomUUID } from "node:crypto";

import type { AppConfig } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { claimDueImReplyNotifications, finishImReplyNotification } from "@aicr/store";

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
  private readonly senders = new Map<string, WecomAibotLongConnection>();
  private scanning = false;

  constructor(options: ImReplyServiceOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.scan();
    this.timer = setInterval(() => {
      void this.scan();
    }, this.options.intervalMs ?? SCAN_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const sender of this.senders.values()) sender.dispose();
    this.senders.clear();
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const claimed = await claimDueImReplyNotifications(this.options.store, {
        owner: this.owner,
        limit: 10,
        now: new Date(),
      });
      for (const row of claimed) {
        await this.deliver(row);
      }
    } catch (error) {
      console.warn(JSON.stringify({ msg: "im_reply_scan_failed", error: String(error) }));
    } finally {
      this.scanning = false;
    }
  }

  private async deliver(row: { readonly operationId: string; readonly fence: number; readonly attempts: number; readonly destinationIdentity: string; readonly compactReceipt: string | null }): Promise<void> {
    const now = new Date();
    let receipt: CompactReceipt;
    try {
      receipt = JSON.parse(row.compactReceipt ?? "{}") as CompactReceipt;
    } catch {
      await finishImReplyNotification(this.options.store, { operationId: row.operationId, fence: row.fence, state: "failed", now });
      return;
    }
    try {
      const text = [
        `评审${STATE_TEXT[receipt.state] ?? receipt.state}：${receipt.requestId}`,
        `- 仓库: ${receipt.repoRef}`,
        `- 修订: ${receipt.revision.length > 12 ? receipt.revision.slice(0, 12) : receipt.revision}`,
        ...(receipt.errorCode !== undefined ? [`- 错误: ${receipt.errorCode}`] : []),
        "- 可用 aicr status <request-id> 查询，aicr detail <别名> <修订> 查看详情。",
      ].join("\n");
      const delivered = await this.send(receipt, text);
      const state = delivered ? "delivered" : row.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      await finishImReplyNotification(this.options.store, {
        operationId: row.operationId,
        fence: row.fence,
        state,
        ...(state === "pending" ? { retryAt: new Date(now.getTime() + BACKOFF_BASE_MS * 2 ** row.attempts) } : {}),
        now,
      });
      console.log(JSON.stringify({ msg: "im_reply_delivered", operationId: row.operationId, connection: receipt.connectionName, state }));
    } catch (error) {
      console.warn(JSON.stringify({ msg: "im_reply_send_failed", operationId: row.operationId, error: String(error) }));
      try {
        finishImReplyNotification(this.options.store, {
          operationId: row.operationId,
          fence: row.fence,
          state: row.attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          ...(row.attempts < MAX_ATTEMPTS ? { retryAt: new Date(now.getTime() + BACKOFF_BASE_MS * 2 ** row.attempts) } : {}),
          now,
        });
      } catch { /* the row stays leased; the next cycle re-claims after expiry */ }
    }
  }

  private async send(receipt: CompactReceipt, text: string): Promise<boolean> {
    const config = await this.options.getConfig();
    const connection = config.im?.connections?.[receipt.connectionName];
    if (connection === undefined || connection.enabled === false) return false;
    let conversation: { kind: string; id?: string } = { kind: "app_direct" };
    try {
      conversation = JSON.parse(receipt.conversation) as { kind: string; id?: string };
    } catch { /* direct default */ }

    if (connection.kind === "feishu_app") {
      const appSecret = connection.app_secret
        ?? (connection.app_secret_env !== undefined ? this.options.env(connection.app_secret_env) : undefined)
        ?? "";
      if (!appSecret) return false;
      const isGroup = conversation.kind === "group";
      const receiveId = isGroup ? conversation.id ?? "" : receipt.actor.id;
      if (receiveId === "") return false;
      try {
        return await sendFeishuReply(connection.app_id, appSecret, receiveId, isGroup ? "chat_id" : "open_id", text, this.options.fetch);
      } catch {
        return false;
      }
    }
    if (connection.kind === "wecom_aibot") {
      const secret = connection.secret
        ?? (connection.secret_env !== undefined ? this.options.env(connection.secret_env) : undefined)
        ?? "";
      const botId = connection.aibot_id ?? "";
      if (!secret || !botId) return false;
      let sender = this.senders.get(receipt.connectionName);
      if (sender === undefined) {
        sender = new WecomAibotLongConnection({
          botId, secret, connectionName: receipt.connectionName, namespace: "im-reply",
          onMessage: async () => undefined,
          onStatusChange: (status) => {
            console.log(JSON.stringify({ msg: "im_reply_sender_status", connection: receipt.connectionName, status }));
          },
        });
        this.senders.set(receipt.connectionName, sender);
        // The reply channel needs its own subscribed connection; aibot_send_msg
        // rides the same long connection, so connect (and resubscribe) once.
        await sender.connect().catch((error: unknown) => {
          console.warn(JSON.stringify({ msg: "im_reply_sender_connect_failed", connection: receipt.connectionName, error: String(error) }));
        });
      }
      const chatId = conversation.kind === "group" ? conversation.id ?? "" : receipt.actor.id;
      if (chatId === "") return false;
      await sender.sendProactive(chatId, text, conversation.kind === "group");
      return true;
    }
    return false;
  }
}
