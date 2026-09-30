import type { AppConfig, ImConversation, ImEventContent, ImPrincipal } from "@aicr/core";

import { FeishuAppLongConnection } from "./feishu-long-connection.js";
import { WecomAibotLongConnection } from "./wecom-long-connection.js";

/**
 * IM long-connection service manager: reads the effective config for
 * long-connection IM connections — `wecom_aibot` without an enabled
 * callback (bot_id + secret) and `feishu_app` without an enabled callback
 * (app_id + app_secret) — creates the platform clients, and routes messages
 * through the command admission pipeline. Supports hot-reload on config
 * changes via dispose + reconnect.
 */

/** One platform-agnostic inbound long-connection message. */
export interface LongConnectionMessage {
  readonly connectionName: string;
  readonly platform: "wecom_aibot" | "feishu_app";
  readonly text: string;
  readonly actor: ImPrincipal;
  readonly conversation: ImConversation;
  readonly reply: (text: string) => Promise<void>;
}

interface ManagedConnection {
  connect(): Promise<void>;
  dispose(): void;
}

export interface LongConnectionServiceOptions {
  readonly getConfig: () => Promise<AppConfig> | AppConfig;
  readonly env: (name: string) => string | undefined;
  readonly namespace: string;
  readonly onAdmitMessage: (message: LongConnectionMessage) => Promise<void>;
}

const RECONCILE_INTERVAL_MS = 30_000;

export class ImLongConnectionService {
  private connections = new Map<string, ManagedConnection>();
  private readonly options: LongConnectionServiceOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reconciling = false;

  constructor(options: LongConnectionServiceOptions) {
    this.options = options;
  }

  /**
   * Periodic reconciliation (IM-17): config changes — added, removed or
   * disabled long-connection entries — apply within one interval without a
   * restart; in-flight scans are skipped rather than queued.
   */
  startPeriodicReconcile(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      if (this.reconciling) return;
      this.reconciling = true;
      void this.reconcile().catch((error: unknown) => {
        console.warn(JSON.stringify({ msg: "im_long_connection_reconcile_failed", error: String(error) }));
      }).finally(() => {
        this.reconciling = false;
      });
    }, RECONCILE_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Scans config and connects/reconnects as needed. Call on startup and config change. */
  async reconcile(): Promise<void> {
    const config = await this.options.getConfig();
    const desired = new Map<string, ManagedConnection>();

    for (const [name, connection] of Object.entries(config.im?.connections ?? {})) {
      if (connection.enabled === false) continue;
      // Long-connection mode: no callback configured, or callback disabled.
      if (connection.callback?.enabled === true) continue;

      if (connection.kind === "wecom_aibot") {
        const secret = connection.secret ?? (connection.secret_env !== undefined ? this.options.env(connection.secret_env) : undefined) ?? "";
        const botId = connection.aibot_id ?? "";
        if (!secret || !botId) continue;
        desired.set(name, new WecomAibotLongConnection({
          botId,
          secret,
          connectionName: name,
          namespace: this.options.namespace,
          onMessage: (event, reply) => this.admit(name, "wecom_aibot", event, reply),
          onStatusChange: (status) => {
            console.log(JSON.stringify({ msg: "im_long_connection_status", connection: name, platform: "wecom_aibot", status }));
          },
        }));
        continue;
      }
      if (connection.kind === "feishu_app") {
        const appSecret = connection.app_secret
          ?? (connection.app_secret_env !== undefined ? this.options.env(connection.app_secret_env) : undefined)
          ?? "";
        if (!connection.app_id || !appSecret) continue;
        desired.set(name, new FeishuAppLongConnection({
          appId: connection.app_id,
          appSecret,
          connectionName: name,
          namespace: this.options.namespace,
          onMessage: (event, reply) => this.admit(name, "feishu_app", event, reply),
          onStatusChange: (status) => {
            console.log(JSON.stringify({ msg: "im_long_connection_status", connection: name, platform: "feishu_app", status }));
          },
        }));
      }
    }

    // Stop removed or reconfigured connections.
    for (const [name, conn] of this.connections) {
      if (desired.get(name) !== conn) {
        conn.dispose();
        this.connections.delete(name);
      }
    }

    // Start new connections.
    for (const [name, conn] of desired) {
      if (this.connections.has(name)) continue;
      this.connections.set(name, conn);
      void conn.connect().catch((error) => {
        console.warn(JSON.stringify({ msg: "im_long_connection_failed", connection: name, error: String(error) }));
      });
    }
  }

  private async admit(
    connectionName: string,
    platform: "wecom_aibot" | "feishu_app",
    event: { content: ImEventContent; actor: ImPrincipal | undefined; conversation: ImConversation | undefined },
    reply: (text: string) => Promise<void>,
  ): Promise<void> {
    if (event.content.kind !== "message") return;
    const text = event.content.text;
    await this.options.onAdmitMessage({
      connectionName,
      platform,
      text,
      actor: event.actor ?? { type: platform === "feishu_app" ? "feishu_open_id" : "wecom_userid", id: "" },
      conversation: event.conversation ?? (platform === "feishu_app" ? { kind: "app_direct" } : { kind: "bot_direct" }),
      reply,
    });
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const conn of this.connections.values()) {
      conn.dispose();
    }
    this.connections.clear();
  }
}
