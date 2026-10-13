import { createHash } from "node:crypto";
import {
  LogLevel,
  SocketModeClient,
  type SocketModeOptions,
} from "@slack/socket-mode";
import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";
import type { AppConfig } from "@aicr/core";
import type { SocialImConnection } from "@aicr/outputs";
import type { ImCallbackRoutesOptions } from "./callback-routes.js";
import { parseSlackSocketCommand, parseUniqueJson } from "./protocol-social.js";
import { processVerifiedSocialCommand } from "./social-callback.js";

type SlackConnection = Extract<SocialImConnection, { kind: "slack_app" }>;
export interface SlackSocketEnvelope {
  readonly type: string;
  readonly envelope_id: string;
  readonly body: unknown;
  readonly accepts_response_payload?: boolean;
  readonly ack: (body?: Record<string, unknown>) => Promise<void>;
}
export interface SlackSocketTransportOptions {
  readonly appToken: string;
  readonly appId: string;
  readonly signal: AbortSignal;
  readonly onEnvelope: (envelope: SlackSocketEnvelope) => void;
  readonly onStatus: (status: string) => void;
  readonly apiFetch?: NonNullable<SocketModeOptions["clientOptions"]>["fetch"];
}
export interface SlackSocketTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Bind the authenticated socket's hello to the configured app before dispatch. */
class AppBoundSocketClient extends SocketModeClient {
  private verified = false;
  constructor(
    options: SocketModeOptions,
    private readonly appId: string,
    private readonly ownerSignal: AbortSignal,
  ) {
    super(options);
    this.on("connecting", () => {
      this.verified = false;
    });
    this.on("disconnected", () => {
      this.verified = false;
    });
  }
  protected override async onWebSocketMessage(
    data: string | ArrayBuffer,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary || this.ownerSignal.aborted) return;
    let text: string;
    let record: Record<string, unknown>;
    try {
      text =
        typeof data === "string"
          ? data
          : new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (Buffer.byteLength(text, "utf8") > 256 * 1024) return;
      const raw = parseUniqueJson(text);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      record = raw as Record<string, unknown>;
    } catch {
      return;
    }
    if (record.type === "hello") {
      const info = record.connection_info as { app_id?: unknown } | undefined;
      if (info?.app_id !== this.appId) {
        this.emit("identity_mismatch");
        await this.disconnect();
        return;
      }
      this.verified = true;
    } else if (!this.verified) return;
    if (record.type === "events_api") {
      const payload = record.payload as { event?: unknown } | undefined;
      if (!payload?.event || typeof payload.event !== "object") return;
    }
    try {
      await super.onWebSocketMessage(text, false);
    } catch {
      this.emit("protocol_error");
    }
  }
}

export function createSlackSocketTransport(
  options: SlackSocketTransportOptions,
): SlackSocketTransport {
  const controller = new AbortController();
  const ownerSignal = AbortSignal.any([options.signal, controller.signal]);
  const dispatcher = new EnvHttpProxyAgent();
  // SDK logging arguments can contain raw envelopes and credential-bearing URLs.
  const ignore = () => {};
  const client = new AppBoundSocketClient(
    {
      appToken: options.appToken,
      dispatcher,
      autoReconnectEnabled: false,
      logger: {
        debug: ignore,
        info: ignore,
        warn: ignore,
        error: ignore,
        setLevel: ignore,
        setName: ignore,
        getLevel: () => LogLevel.ERROR,
      },
      clientOptions: {
        retryConfig: { retries: 0 },
        timeout: 10_000,
        fetch: (url, init) => {
          const request = {
            ...init,
            signal: AbortSignal.any([
              ownerSignal,
              AbortSignal.timeout(10_000),
              ...(init?.signal ? [init.signal] : []),
            ]),
          };
          return options.apiFetch
            ? options.apiFetch(url, request)
            : proxyFetch(url, { ...request, dispatcher });
        },
      },
    },
    options.appId,
    ownerSignal,
  );
  client.on("slack_event", options.onEnvelope);
  for (const status of [
    "connected",
    "disconnected",
    "identity_mismatch",
    "protocol_error",
    "error",
  ])
    client.on(status, () => options.onStatus(status));
  let stopped: Promise<void> | undefined;
  return {
    start: async () => {
      await client.start();
    },
    stop: () =>
      (stopped ??= (async () => {
        controller.abort();
        const disconnect = client.disconnect();
        await dispatcher.destroy();
        await disconnect;
        client.removeAllListeners();
      })()),
  };
}

interface Entry {
  readonly key: string;
  readonly controller: AbortController;
  transport: SlackSocketTransport | undefined;
  starting: boolean;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  failures: number;
}
export interface SlackSocketModeServiceOptions extends ImCallbackRoutesOptions {
  readonly createTransport?: (
    options: SlackSocketTransportOptions,
  ) => SlackSocketTransport;
  readonly onStatus?: (connection: string, status: string) => void;
}

export class SlackSocketModeService {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private reconciling = false;
  constructor(private readonly options: SlackSocketModeServiceOptions) {}
  private status(name: string, status: string): void {
    if (this.options.onStatus) this.options.onStatus(name, status);
    else
      console.log(
        JSON.stringify({
          msg: "slack_socket_mode_status",
          connection: name,
          status,
        }),
      );
  }
  private definition(
    connection: SlackConnection,
  ): { key: string; appToken: string } | undefined {
    if (
      connection.enabled === false ||
      connection.socket_mode?.enabled !== true ||
      connection.callback?.enabled === true
    )
      return undefined;
    const socket = connection.socket_mode;
    const appToken =
      socket.app_token ??
      (socket.app_token_env
        ? this.options.env(socket.app_token_env)
        : undefined);
    const botToken =
      connection.token ??
      (connection.token_env
        ? this.options.env(connection.token_env)
        : undefined);
    if (!appToken?.startsWith("xapp-") || !botToken) return undefined;
    const digest = createHash("sha256")
      .update(JSON.stringify([appToken, botToken]))
      .digest("hex");
    return {
      key: JSON.stringify([
        connection.app_id,
        connection.team_id,
        connection.bot_user_id,
        this.options.namespace,
        digest,
      ]),
      appToken,
    };
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => {
      void this.reconcile().catch(() =>
        this.status("service", "reconcile_failed"),
      );
    };
    tick();
    this.timer = setInterval(tick, 30_000);
    this.timer.unref?.();
  }
  async reconcile(): Promise<void> {
    if (this.stopped || this.reconciling) return;
    this.reconciling = true;
    try {
      const config = await this.options.getConfig();
      if (this.stopped) return;
      const desired = new Map<
        string,
        { connection: SlackConnection; key: string; appToken: string }
      >();
      for (const [name, connection] of Object.entries(
        config.im?.connections ?? {},
      )) {
        if (connection.kind !== "slack_app") continue;
        const definition = this.definition(connection);
        if (definition) desired.set(name, { connection, ...definition });
        else if (
          connection.socket_mode?.enabled &&
          connection.enabled !== false
        )
          this.status(name, "credential_unavailable");
      }
      for (const [name, entry] of this.entries) {
        if (desired.get(name)?.key === entry.key) continue;
        this.entries.delete(name);
        await this.stopEntry(entry);
      }
      for (const [name, definition] of desired) {
        if (this.stopped) return;
        if (this.entries.has(name)) continue;
        const entry: Entry = {
          key: definition.key,
          controller: new AbortController(),
          transport: undefined,
          starting: false,
          retryTimer: undefined,
          failures: 0,
        };
        this.entries.set(name, entry);
        this.connect(name, entry, definition.connection, definition.appToken);
      }
    } finally {
      this.reconciling = false;
    }
  }
  private connect(
    name: string,
    entry: Entry,
    connection: SlackConnection,
    appToken: string,
  ): void {
    if (entry.controller.signal.aborted || entry.starting) return;
    entry.starting = true;
    const retry = () => {
      if (entry.controller.signal.aborted || entry.retryTimer) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(entry.failures++, 5));
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined;
        void (async () => {
          const prior = entry.transport;
          entry.transport = undefined;
          await prior?.stop();
          this.connect(name, entry, connection, appToken);
        })().catch(() => {
          entry.starting = false;
          retry();
        });
      }, delay);
      entry.retryTimer.unref?.();
    };
    try {
      const transport = (
        this.options.createTransport ?? createSlackSocketTransport
      )({
        appToken,
        appId: connection.app_id,
        signal: entry.controller.signal,
        onEnvelope: (envelope) => {
          void this.receive(name, entry, envelope).catch(() =>
            this.status(name, "handler_failed"),
          );
        },
        onStatus: (status) => {
          // Constructors may emit status synchronously, before assignment completes.
          if (
            !entry.transport ||
            entry.controller.signal.aborted ||
            entry.transport !== transport
          )
            return;
          this.status(name, status);
          if (status === "connected") {
            entry.failures = 0;
            if (entry.retryTimer) clearTimeout(entry.retryTimer);
            entry.retryTimer = undefined;
          }
          if (status === "disconnected") retry();
        },
      });
      entry.transport = transport;
      void transport
        .start()
        .catch(() => {
          this.status(name, "connect_failed");
          retry();
        })
        .finally(() => {
          entry.starting = false;
        });
    } catch {
      entry.starting = false;
      this.status(name, "connect_failed");
      retry();
    }
  }
  private async receive(
    name: string,
    entry: Entry,
    envelope: SlackSocketEnvelope,
  ): Promise<void> {
    if (
      entry.controller.signal.aborted ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(envelope.envelope_id)
    )
      return;
    if (envelope.type !== "slash_commands") {
      await envelope.ack();
      return;
    }
    if (envelope.accepts_response_payload !== true) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    const signal = AbortSignal.any([
      controller.signal,
      entry.controller.signal,
    ]);
    const deadlineAt = Date.now() + 1000;
    const timeout = new Promise<undefined>((resolve) =>
      signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      }),
    );
    try {
      const admission = (async () => {
        const generation = await this.options.getConfigGeneration?.();
        const config: AppConfig =
          generation?.config ?? (await this.options.getConfig());
        const connection = config.im?.connections?.[name];
        if (
          signal.aborted ||
          connection?.kind !== "slack_app" ||
          this.definition(connection)?.key !== entry.key
        )
          return;
        const verified = parseSlackSocketCommand({
          body: envelope.body,
          envelopeId: envelope.envelope_id,
          connection,
        });
        if (verified.kind !== "command")
          return Response.json({
            response_type: "ephemeral",
            text: "Command rejected.",
            mrkdwn: false,
          });
        return processVerifiedSocialCommand(
          verified,
          name,
          config,
          connection,
          generation,
          this.options,
          signal,
          deadlineAt,
        );
      })();
      const response = await Promise.race([admission, timeout]);
      if (!response || !response.ok || signal.aborted) {
        this.status(name, "admission_unavailable");
        return;
      }
      await envelope.ack((await response.json()) as Record<string, unknown>);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  private async stopEntry(entry: Entry): Promise<void> {
    entry.controller.abort();
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    await entry.transport?.stop();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => this.stopEntry(entry)));
  }
}
