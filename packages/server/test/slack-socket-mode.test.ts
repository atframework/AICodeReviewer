import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeStoreDb,
  createStoreDb,
  imReviewRequests,
  type SqliteStoreDb,
} from "@aicr/store";
import { appConfigSchema } from "@aicr/core";
import { SocialImClient } from "@aicr/outputs";
import {
  SlackSocketModeService,
  createSlackSocketTransport,
  type SlackSocketTransportOptions,
} from "../src/im/slack-socket-mode.js";
import {
  parseSlackSocketCommand,
  verifySlackCommand,
} from "../src/im/protocol-social.js";
import { fixture, readyClient, NOW, SHA } from "./social-im-fixtures.js";
import { currentImRequestAuthorized } from "../src/im/social-command-service.js";

let dir: string;
let store: SqliteStoreDb;
const services: SlackSocketModeService[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-socket-"));
  store = createStoreDb(join(dir, "store.db"));
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});
const body = (text = "help") => ({
  team_id: "T123",
  user_id: "U234",
  channel_id: "C123",
  command: "/aicr",
  text,
  trigger_id: "123.456.hash",
});
async function setup(cold = false, failStarts = false) {
  const f = fixture("slack");
  let config = appConfigSchema.parse({
    ...f.config,
    im: {
      ...f.config.im,
      connections: {
        bot: {
          ...f.connection,
          callback: { enabled: false },
          socket_mode: { enabled: true, app_token: "xapp-test" },
        },
      },
    },
  });
  const client = cold
    ? new SocialImClient(f.connection, "test-token", {
        fetch: vi.fn(() => {
          throw new Error("network forbidden");
        }),
      })
    : await readyClient("slack");
  const transports: {
    options: SlackSocketTransportOptions;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const status = vi.fn();
  const options = {
    store,
    namespace: "socket",
    getConfig: () => config,
    getConfigGeneration: () => ({
      config,
      snapshotId: "snapshot",
      fileDigest: "digest",
    }),
    socialClient: () => client,
    reviewReady: () => true,
    env: () => undefined,
    now: () => NOW,
    onStatus: status,
    createTransport: (options: SlackSocketTransportOptions) => {
      const transport = {
        options,
        start: vi.fn(async () => {
          if (failStarts)
            throw new Error("xapp-private-url-must-not-be-logged");
          options.onStatus("connected");
        }),
        stop: vi.fn(async () => {}),
      };
      transports.push(transport);
      return transport;
    },
  };
  const service = new SlackSocketModeService(options);
  services.push(service);
  await service.reconcile();
  await Promise.resolve();
  const send = (
    payload: unknown = body(),
    id = "envelope-1",
    type = "slash_commands",
    accepts = true,
  ) => {
    const ack = vi.fn(async () => {});
    transports.at(-1)!.options.onEnvelope({
      type,
      envelope_id: id,
      body: payload,
      accepts_response_payload: accepts,
      ack,
    });
    return ack;
  };
  return {
    service,
    transports,
    status,
    send,
    options,
    setConfig: (next: typeof config) => {
      config = next;
    },
    config,
  };
}
it("authenticates optional-app-id envelopes, durably admits and replays a review", async () => {
  const f = await setup();
  const first = f.send(body("review demo " + SHA));
  await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
  const replay = f.send(body("review demo " + SHA), "envelope-retry");
  await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
  const rows = store.db.select().from(imReviewRequests).all();
  expect(rows).toHaveLength(1);
  expect(first).toHaveBeenCalledWith(
    expect.objectContaining({
      text: expect.stringContaining(rows[0]!.requestId),
    }),
  );
  expect(replay).toHaveBeenCalledWith(
    expect.objectContaining({
      text: expect.stringContaining(rows[0]!.requestId),
    }),
  );
  expect(await currentImRequestAuthorized(f.config, rows[0]!)).toBe(true);
  const revoked = appConfigSchema.parse({
    ...f.config,
    im: {
      ...f.config.im,
      connections: {
        bot: {
          ...f.config.im!.connections.bot,
          socket_mode: { enabled: false },
        },
      },
    },
  });
  expect(await currentImRequestAuthorized(revoked, rows[0]!)).toBe(false);
});
it("returns chat identities and enforces channel/user authorization", async () => {
  const f = await setup();
  const chat = f.send(body("chat-id"));
  await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
  expect(chat.mock.calls[0]).toEqual([
    expect.objectContaining({
      response_type: "ephemeral",
      text: expect.stringContaining("slack_user_id:U234"),
    }),
  ]);
  for (const extra of [
    { user_id: "U999" },
    { team_id: "T999" },
    { api_app_id: "A999" },
  ]) {
    const ack = f.send({
      ...body("review demo " + SHA),
      trigger_id: "unauthorized",
      ...extra,
    });
    await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
    expect(ack.mock.calls[0]).not.toEqual([
      expect.objectContaining({ text: expect.stringContaining("accepted") }),
    ]);
  }
  const channel = f.send({ ...body("review demo " + SHA), channel_id: "C999" });
  await vi.waitFor(() =>
    expect(f.status).toHaveBeenCalledWith("bot", "admission_unavailable"),
  );
  expect(channel).not.toHaveBeenCalled();
  expect(store.db.select().from(imReviewRequests).all()).toHaveLength(0);
});
it("ACKs unsupported events without admitting work and requires inline reply support", async () => {
  const f = await setup();
  const event = f.send({}, "event-1", "events_api");
  await vi.waitFor(() => expect(event).toHaveBeenCalledWith());
  const noReply = f.send(
    body("review demo " + SHA),
    "command-2",
    "slash_commands",
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(noReply).not.toHaveBeenCalled();
  expect(store.db.select().from(imReviewRequests).all()).toHaveLength(0);
});
it("refuses admission while metadata is cold", async () => {
  const f = await setup(true);
  const ack = f.send(body("review demo " + SHA));
  await vi.waitFor(() =>
    expect(f.status).toHaveBeenCalledWith("bot", "admission_unavailable"),
  );
  expect(ack).not.toHaveBeenCalled();
  expect(store.db.select().from(imReviewRequests).all()).toHaveLength(0);
});
it("blocks stale connections immediately, rotates credentials and stops on disable", async () => {
  const f = await setup();
  const old = f.transports[0]!;
  const next = appConfigSchema.parse({
    ...f.config,
    im: {
      ...f.config.im,
      connections: {
        bot: {
          ...f.config.im!.connections.bot,
          socket_mode: { enabled: true, app_token: "xapp-rotated" },
        },
      },
    },
  });
  f.setConfig(next);
  const stale = f.send(body("review demo " + SHA));
  await vi.waitFor(() =>
    expect(f.status).toHaveBeenCalledWith("bot", "admission_unavailable"),
  );
  expect(stale).not.toHaveBeenCalled();
  await f.service.reconcile();
  expect(old.stop).toHaveBeenCalledOnce();
  expect(old.options.signal.aborted).toBe(true);
  expect(f.transports).toHaveLength(2);
  f.setConfig(
    appConfigSchema.parse({
      ...next,
      im: {
        ...next.im,
        connections: {
          bot: { ...next.im!.connections.bot, socket_mode: { enabled: false } },
        },
      },
    }),
  );
  await f.service.reconcile();
  expect(f.transports[1]!.stop).toHaveBeenCalledOnce();
});
it("reconnects after disconnect and cancels scheduled retries on drain", async () => {
  const f = await setup();
  vi.useFakeTimers();
  f.transports[0]!.options.onStatus("disconnected");
  await vi.advanceTimersByTimeAsync(999);
  expect(f.transports).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.transports).toHaveLength(2);
  expect(f.transports[0]!.stop).toHaveBeenCalledOnce();
  f.transports[1]!.options.onStatus("disconnected");
  await f.service.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.transports).toHaveLength(2);
});
it("bounds repeated start failures at a 30-second retry and cancels retries on stop", async () => {
  vi.useFakeTimers();
  const f = await setup(false, true);
  await vi.advanceTimersByTimeAsync(0);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = f.transports.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.transports).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.transports).toHaveLength(before + 1);
    expect(f.transports[before - 1]!.stop).toHaveBeenCalledOnce();
  }
  expect(
    f.status.mock.calls.every((call) => call[1] === "connect_failed"),
  ).toBe(true);
  expect(JSON.stringify(f.status.mock.calls)).not.toContain("xapp-private");
  await f.service.stop();
  const stoppedCount = f.transports.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.transports).toHaveLength(stoppedCount);
});
it("bounds blocked config capture and refuses late admission after timeout", async () => {
  const f = await setup();
  let release!: (
    value: ReturnType<typeof f.options.getConfigGeneration>,
  ) => void;
  f.options.getConfigGeneration = () =>
    new Promise((resolve) => {
      release = resolve;
    }) as never;
  vi.useFakeTimers();
  const ack = f.send(body("review demo " + SHA));
  await vi.advanceTimersByTimeAsync(1001);
  expect(f.status).toHaveBeenCalledWith("bot", "admission_unavailable");
  release({ config: f.config, snapshotId: "snapshot", fileDigest: "digest" });
  await vi.advanceTimersByTimeAsync(0);
  expect(ack).not.toHaveBeenCalled();
  expect(store.db.select().from(imReviewRequests).all()).toHaveLength(0);
});
it("uses the same trigger delivery identity across HTTP and Socket Mode", () => {
  const connection = fixture("slack").connection;
  if (connection.kind !== "slack_app") throw new Error("fixture");
  const raw = Buffer.from(
    new URLSearchParams({ ...body(), api_app_id: "A123" }).toString(),
  );
  const timestamp = String(NOW / 1000);
  const headers = new Headers({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature":
      "v0=" +
      createHmac("sha256", "signing-secret")
        .update("v0:" + timestamp + ":")
        .update(raw)
        .digest("hex"),
  });
  const http = verifySlackCommand({
    raw,
    headers,
    connection,
    signingSecret: "signing-secret",
    now: NOW,
  });
  const socket = parseSlackSocketCommand({
    body: body(),
    envelopeId: "env-1",
    connection,
  });
  expect(http.kind).toBe("command");
  expect(socket).toEqual(http);
  for (const extra of [{ trigger_id: "" }, { user_id: 123 }, { text: null }])
    expect(
      parseSlackSocketCommand({
        body: { ...body(), ...extra },
        envelopeId: "env-1",
        connection,
      }).kind,
    ).toBe("rejected");
});
it("runs the pinned SDK handshake and emits the correct wire ACK without raw SDK logging", async () => {
  vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
  vi.stubEnv("no_proxy", "127.0.0.1,localhost");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("loopback");
  const envelopes: string[] = [];
  const statuses: string[] = [];
  let wire!: Promise<[unknown]>;
  server.on("connection", (socket) => {
    wire = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "slash_commands",
        envelope_id: "before-hello",
        payload: body(),
        accepts_response_payload: true,
      }),
    );
    socket.send(
      JSON.stringify({ type: "hello", connection_info: { app_id: "A123" } }),
    );
    socket.send('{"type":"events_api","payload":{}}');
    socket.send(
      '{"type":"slash_commands","envelope_id":"duplicate","payload":{"text":"help","text":"review"}}',
    );
    socket.send(
      JSON.stringify({
        type: "slash_commands",
        envelope_id: "sdk-1",
        payload: body(),
        accepts_response_payload: true,
      }),
    );
  });
  const transport = createSlackSocketTransport({
    appId: "A123",
    appToken: "xapp-test",
    signal: new AbortController().signal,
    apiFetch: async () =>
      new Response(
        JSON.stringify({ ok: true, url: `ws://127.0.0.1:${address.port}` }),
      ),
    onStatus: (status) => statuses.push(status),
    onEnvelope: (envelope) => {
      envelopes.push(envelope.envelope_id);
      void envelope.ack({ text: "ready", response_type: "ephemeral" });
    },
  });
  try {
    await transport.start();
    const [data] = await wire;
    expect(JSON.parse(String(data))).toEqual({
      envelope_id: "sdk-1",
      payload: { text: "ready", response_type: "ephemeral" },
    });
    expect(envelopes).toEqual(["sdk-1"]);
    expect(statuses).toContain("connected");
  } finally {
    await transport.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("rejects a real SDK hello for another application", async () => {
  vi.stubEnv("NO_PROXY", "127.0.0.1");
  vi.stubEnv("no_proxy", "127.0.0.1");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("loopback");
  server.on("connection", (socket) =>
    socket.send(
      JSON.stringify({ type: "hello", connection_info: { app_id: "A999" } }),
    ),
  );
  const status = vi.fn();
  const envelope = vi.fn();
  const transport = createSlackSocketTransport({
    appId: "A123",
    appToken: "xapp-test",
    signal: new AbortController().signal,
    apiFetch: async () =>
      new Response(
        JSON.stringify({ ok: true, url: `ws://127.0.0.1:${address.port}` }),
      ),
    onStatus: status,
    onEnvelope: envelope,
  });
  try {
    await expect(transport.start()).rejects.toThrow();
    expect(status).toHaveBeenCalledWith("identity_mismatch");
    expect(envelope).not.toHaveBeenCalled();
  } finally {
    await transport.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("cancels pending SDK connection API reads on stop without opening a late socket", async () => {
  const fetchStarted = vi.fn();
  const transport = createSlackSocketTransport({
    appId: "A123",
    appToken: "xapp-test",
    signal: new AbortController().signal,
    onStatus: vi.fn(),
    onEnvelope: vi.fn(),
    apiFetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        fetchStarted();
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        );
      }),
  });
  const started = expect(transport.start()).rejects.toThrow();
  await vi.waitFor(() => expect(fetchStarted).toHaveBeenCalledOnce());
  await transport.stop();
  await started;
});
