import { EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";

import type { brandVerifiedImEvent, ImConnectionIdentity } from "@aicr/core";

import { sendFeishuReply } from "./inline-reply.js";
import { buildFeishuEvent } from "./protocol-feishu.js";

/**
 * Feishu application long-connection client: the platform's raw WebSocket
 * protocol is not public, so this mode uses the official SDK's WSClient
 * (事件订阅「使用长连接接收事件」). Messages arrive as decrypted event v2
 * payloads; replies go out through the message API like the callback mode.
 * The SDK owns heartbeat and auto-reconnect.
 */

export interface FeishuLongConnectionOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly connectionName: string;
  readonly namespace: string;
  readonly onMessage: (event: ReturnType<typeof brandVerifiedImEvent>, reply: (text: string) => Promise<void>) => Promise<void>;
  readonly onStatusChange?: ((status: "connecting" | "connected" | "disconnected") => void) | undefined;
}

export class FeishuAppLongConnection {
  private client: WSClient | undefined;
  private disposed = false;
  private readonly options: FeishuLongConnectionOptions;

  constructor(options: FeishuLongConnectionOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    this.options.onStatusChange?.("connecting");

    const identity: ImConnectionIdentity = {
      kind: "feishu_app",
      corpId: undefined,
      platformId: this.options.appId,
      tenantKey: undefined,
      namespace: this.options.namespace,
    };
    const connection = { identity, name: this.options.connectionName };

    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data: Record<string, unknown>) => {
        try {
          // The SDK flattens v2 events: {event_type, event_id, create_time,
          // app_id, tenant_key, sender, message, ...}. Reassemble the nested
          // view the shared normalizer expects.
          const message = typeof data.message === "object" && data.message !== null ? data.message as Record<string, unknown> : undefined;
          const sender = typeof data.sender === "object" && data.sender !== null ? data.sender as Record<string, unknown> : undefined;
          const event = buildFeishuEvent({
            header: {
              event_type: typeof data.event_type === "string" ? data.event_type : "unknown",
              event_id: typeof data.event_id === "string" ? data.event_id : undefined,
              message_id: typeof message?.message_id === "string" ? message.message_id : undefined,
              create_time: Number(data.create_time ?? 0),
            },
            event: { sender, message },
          }, connection);
          if (event.content.kind !== "message") return;
          const chatId = event.conversation?.kind === "group" ? event.conversation.id : undefined;
          const actorId = event.actor?.id;
          const receiveId = chatId ?? actorId ?? "";
          const receiveIdType = chatId !== undefined ? "chat_id" : "open_id";
          await this.options.onMessage(event, async (text: string) => {
            if (receiveId !== "") {
              await sendFeishuReply(this.options.appId, this.options.appSecret, receiveId, receiveIdType, text);
            }
          });
        } catch (error) {
          console.warn(JSON.stringify({ msg: "im_long_connection_message_error", connection: this.options.connectionName, error: String(error) }));
        }
      },
    });

    const client = new WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      loggerLevel: LoggerLevel.warn,
      onError: (error) => {
        console.warn(JSON.stringify({ msg: "im_long_connection_failed", connection: this.options.connectionName, error: String(error) }));
      },
      onReady: () => {
        this.options.onStatusChange?.("connected");
      },
      onReconnecting: () => {
        this.options.onStatusChange?.("connecting");
      },
      onReconnected: () => {
        this.options.onStatusChange?.("connected");
      },
    });
    this.client = client;
    await client.start({ eventDispatcher: dispatcher });
  }

  dispose(): void {
    this.disposed = true;
    this.client?.close();
    this.client = undefined;
    this.options.onStatusChange?.("disconnected");
  }
}
