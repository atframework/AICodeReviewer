import { createHash, randomUUID } from "node:crypto";

import WebSocket from "ws";

import { brandVerifiedImEvent, type ImConnectionIdentity, type VerifiedImEventData } from "@aicr/core";

/**
 * WeCom aibot long-connection client (W8, path/101463): standard WebSocket
 * to `wss://openws.work.weixin.qq.com`, subscribe with bot_id+secret,
 * receive `aibot_msg_callback` / `aibot_event_callback`, reply via
 * `aibot_respond_msg`. No message encryption in this mode (unlike HTTP
 * callback). Only one live connection per bot; heartbeat every 30s.
 *
 * Transport uses the `ws` package like the official SDK: WeCom's endpoint
 * rejects Node's built-in undici WebSocket upgrade (close 1006).
 */

const WECOM_WS_URL = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const MARKDOWN_MAX_BYTES = 20_480;
const MAX_MISSED_PING = 3;
const SEND_ACK_TIMEOUT_MS = 15_000;

/** Subscribe/ping acks carry no `cmd`; correlate them by req_id prefix. */
const SUBSCRIBE_PREFIX = "aibot_subscribe";
const PING_PREFIX = "ping";

export interface WecomLongConnectionOptions {
  readonly botId: string;
  readonly secret: string;
  readonly connectionName: string;
  readonly namespace: string;
  readonly onMessage: (event: ReturnType<typeof brandVerifiedImEvent>, reply: (text: string) => Promise<void>) => Promise<void>;
  readonly onEvent?: ((event: { readonly eventtype: string; readonly body: Readonly<Record<string, unknown>> }) => void) | undefined;
  readonly onStatusChange?: ((status: "connecting" | "connected" | "disconnected") => void) | undefined;
}

export class WecomAibotLongConnection {
  private ws: WebSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay = RECONNECT_BASE_DELAY_MS;
  private missedPing = 0;
  private disposed = false;
  private readonly options: WecomLongConnectionOptions;
  private readonly pendingSends = new Map<string, { readonly resolve: () => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>();

  constructor(options: WecomLongConnectionOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    this.options.onStatusChange?.("connecting");

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WECOM_WS_URL);
      this.ws = ws;

      ws.on("open", () => {
        this.subscribe();
      });

      ws.on("message", (data: WebSocket.RawData) => {
        this.handleMessage(data.toString());
        // First frame (the subscribe ack) resolves the connect promise.
        resolve();
      });

      ws.on("error", (error: Error) => {
        if (!this.disposed) {
          reject(error);
          this.scheduleReconnect();
        }
      });

      ws.on("close", () => {
        this.stopHeartbeat();
        this.rejectPendingSends(new Error("WeCom long connection closed before send acknowledgement"));
        if (!this.disposed) {
          this.options.onStatusChange?.("disconnected");
          this.scheduleReconnect();
        }
      });
    });
  }

  private subscribe(): void {
    this.send({
      cmd: "aibot_subscribe",
      headers: { req_id: this.newReqId(SUBSCRIBE_PREFIX) },
      body: { bot_id: this.options.botId, secret: this.options.secret },
    });
  }

  private newReqId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const cmd = typeof message.cmd === "string" ? message.cmd : "";
    const reqId = typeof (message.headers as Record<string, unknown> | undefined)?.req_id === "string"
      ? String((message.headers as Record<string, unknown>).req_id)
      : "";
    const errcode = Number(message.errcode);

    // Frames without cmd: acks correlated by req_id prefix (SDK contract).
    if (cmd === "" && reqId.startsWith(SUBSCRIBE_PREFIX)) {
      if (errcode === 0) {
        this.reconnectDelay = RECONNECT_BASE_DELAY_MS;
        this.options.onStatusChange?.("connected");
        this.startHeartbeat();
      } else {
        // Auth rejected: close so the reconnect path backs off; repeated
        // failures surface through the status log line.
        console.warn(JSON.stringify({ msg: "im_long_connection_auth_failed", connection: this.options.connectionName, errcode, errmsg: String(message.errmsg ?? "") }));
        this.ws?.close();
      }
      return;
    }
    if (cmd === "" && reqId.startsWith(PING_PREFIX)) {
      if (errcode === 0) this.missedPing = 0;
      return;
    }
    if (cmd === "" && this.pendingSends.has(reqId)) {
      const pending = this.pendingSends.get(reqId)!;
      this.pendingSends.delete(reqId);
      clearTimeout(pending.timer);
      if (errcode === 0) pending.resolve();
      else pending.reject(new Error(`WeCom send rejected: ${errcode}`));
      return;
    }
    if (cmd === "" ) return;

    const body = message.body as Record<string, unknown> | undefined;
    if (body === undefined) return;
    const callbackReqId = reqId !== "" ? reqId : this.newReqId("callback");

    if (cmd === "aibot_msg_callback") {
      if (body.aibotid !== this.options.botId) return;
      const event = this.buildVerifiedEvent(body);
      void this.options.onMessage(event, async (text: string) => {
        await this.respondMessage(callbackReqId, text);
      });
      return;
    }

    if (cmd === "aibot_event_callback") {
      const eventType = String((body.event as Record<string, unknown> | undefined)?.eventtype ?? "");
      if (eventType === "disconnected_event") {
        // A new connection kicked us; server will close this one.
        return;
      }
      this.options.onEvent?.({ eventtype: eventType, body });
      return;
    }
  }

  private buildVerifiedEvent(body: Record<string, unknown>): ReturnType<typeof brandVerifiedImEvent> {
    const bodyDigest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const msgid = typeof body.msgid === "string" ? body.msgid : `body:${bodyDigest}`;
    const chatid = typeof body.chatid === "string" ? body.chatid : undefined;
    const chatType = typeof body.chattype === "string" ? body.chattype : "single";
    const from = body.from as Record<string, unknown> | undefined;
    const fromUserId = typeof from?.userid === "string" ? from.userid : undefined;
    const fromEncrypted = typeof from?.userid_encrypted === "string" ? from.userid_encrypted : undefined;
    const senderId = fromEncrypted ?? fromUserId;
    const senderType = fromEncrypted !== undefined ? "wecom_encrypted_userid" : "wecom_userid";
    const text = typeof (body.text as Record<string, unknown> | undefined)?.content === "string"
      ? String((body.text as Record<string, unknown>).content)
      : undefined;
    const msgType = typeof body.msgtype === "string" ? body.msgtype : "unknown";

    const identity: ImConnectionIdentity = {
      kind: "wecom_aibot",
      corpId: undefined,
      platformId: this.options.botId,
      tenantKey: undefined,
      namespace: this.options.namespace,
    };

    const data: VerifiedImEventData = {
      connectionIdentity: identity,
      connectionName: this.options.connectionName,
      protocol: "wecom_aibot",
      deliveryKind: "message",
      deliveryKey: msgid,
      payloadDigest: `ws:${bodyDigest}`,
      actor: senderId !== undefined ? { type: senderType, id: senderId } : undefined,
      conversation: chatid !== undefined && chatType === "group"
        ? { kind: "group", id: chatid }
        : { kind: "bot_direct" },
      occurredAt: Date.now(),
      messageId: msgid,
      eventId: undefined,
      actionId: undefined,
      taskId: undefined,
      content: text !== undefined ? { kind: "message", text } : { kind: "unknown_type", type: msgType },
    };
    return brandVerifiedImEvent(data);
  }

  /** Sends a markdown text reply to the current message callback (24h window). */
  private async respondMessage(requestId: string, text: string): Promise<void> {
    const content = Buffer.byteLength(text, "utf8") > MARKDOWN_MAX_BYTES
      ? `${text.slice(0, 1000)}…(truncated)`.slice(0, MARKDOWN_MAX_BYTES)
      : text;
    this.send({
      cmd: "aibot_respond_msg",
      headers: { req_id: requestId },
      body: { msgtype: "markdown", markdown: { content } },
    });
  }

  /** Proactive push to a specific conversation (no prior callback required). */
  async sendProactive(chatId: string, text: string, isGroup: boolean): Promise<void> {
    void isGroup;
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("WeCom long connection is not connected");
    const reqId = this.newReqId("send");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSends.delete(reqId);
        reject(new Error("WeCom send acknowledgement timed out"));
      }, SEND_ACK_TIMEOUT_MS);
      timer.unref();
      this.pendingSends.set(reqId, { resolve, reject, timer });
      try {
        if (!this.send({
          cmd: "aibot_send_msg",
          headers: { req_id: reqId },
          body: { chatid: chatId, msgtype: "markdown", markdown: { content: text.slice(0, MARKDOWN_MAX_BYTES) } },
        })) throw new Error("WeCom long connection is not connected");
      } catch (error) {
        this.pendingSends.delete(reqId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectPendingSends(error: Error): void {
    for (const pending of this.pendingSends.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingSends.clear();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedPing = 0;
    this.heartbeatTimer = setInterval(() => {
      // A half-open TCP connection never fires close; treat repeated
      // silent pings as dead and force the reconnect path.
      if (this.missedPing >= MAX_MISSED_PING) {
        this.ws?.terminate();
        return;
      }
      this.missedPing++;
      this.send({ cmd: "ping", headers: { req_id: this.newReqId(PING_PREFIX) } });
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {
        // connect() already schedules reconnect on failure
      });
    }, this.reconnectDelay);
    if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
  }

  private send(payload: Record<string, unknown>): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.rejectPendingSends(new Error("WeCom long connection disposed"));
    this.stopHeartbeat();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = undefined;
    this.options.onStatusChange?.("disconnected");
  }
}
