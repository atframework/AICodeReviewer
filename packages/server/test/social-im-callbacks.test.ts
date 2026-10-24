import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SocialImClient } from "@aicr/outputs";
import {
  closeStoreDb,
  createStoreDb,
  findImReviewRequest,
  claimDueImReplyNotifications,
  imReviewRequests,
  type SqliteStoreDb,
} from "@aicr/store";
import { registerImCallbackRoutes } from "../src/im/callback-routes.js";
import { ImReplyService } from "../src/im/reply-service.js";
import {
  platforms,
  fixture,
  readyClient,
  callbackRequest,
  NOW,
  SHA,
} from "./social-im-fixtures.js";
let dir: string;
let store: SqliteStoreDb;
it.each(platforms)(
  "refuses authenticated %s commands while metadata is cold without any callback network call",
  async (platform) => {
    const { config, connection } = fixture(platform);
    const fetch = vi.fn(() => {
      throw new Error("callback must remain offline");
    });
    const client = new SocialImClient(connection, connection.token!, { fetch });
    const app = new Hono();
    registerImCallbackRoutes(app, {
      store,
      namespace: "social",
      getConfig: () => config,
      getConfigGeneration: () => ({
        config,
        snapshotId: "snapshot",
        fileDigest: "d",
      }),
      socialClient: () => client,
      reviewReady: () => true,
      env: () => undefined,
      now: () => NOW,
    });
    expect(
      (await app.fetch(callbackRequest(platform, "review demo " + SHA))).status,
    ).toBe(503);
    expect(store.db.select().from(imReviewRequests).all()).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  },
);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-social-callback-"));
  store = createStoreDb(join(dir, "store.db"));
});
afterEach(async () => {
  vi.useRealTimers();
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});
it.each(
  platforms.flatMap((platform) => [
    [platform, "generation"] as const,
    [platform, "config"] as const,
  ]),
)(
  "includes blocked %s %s capture in the HTTP admission deadline",
  async (platform, source) => {
    const { config } = fixture(platform);
    const client = await readyClient(platform);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captured = vi.fn();
    const app = new Hono();
    registerImCallbackRoutes(app, {
      store,
      namespace: "social",
      env: () => undefined,
      now: () => NOW,
      getConfig: async () => {
        captured();
        await gate;
        return config;
      },
      ...(source === "generation"
        ? {
            getConfigGeneration: async () => {
              captured();
              await gate;
              return { config, snapshotId: "snapshot", fileDigest: "digest" };
            },
          }
        : {}),
      socialClient: () => client,
      reviewReady: () => true,
    });
    vi.useFakeTimers();
    let received: Response | undefined;
    const pending = app
      .fetch(
        callbackRequest(
          platform,
          source === "generation" ? "review demo " + SHA : "help",
        ),
      )
      .then((value) => {
        received = value;
        return value;
      });
    try {
      await vi.advanceTimersByTimeAsync(1001);
      expect(captured).toHaveBeenCalledOnce();
      expect(received?.status).toBe(503);
    } finally {
      release();
      await pending;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(store.db.select().from(imReviewRequests).all()).toHaveLength(0);
    expect(
      store.sqlite.prepare("SELECT COUNT(*) AS count FROM im_inbox").get(),
    ).toEqual({ count: 0 });
  },
);

it.each(platforms)(
  "returns a sanitized 503 when %s config capture rejects",
  async (platform) => {
    const { config } = fixture(platform);
    const app = new Hono();
    registerImCallbackRoutes(app, {
      store,
      namespace: "social",
      env: () => undefined,
      getConfig: () => config,
      getConfigGeneration: async () => {
        throw new Error("private connection details");
      },
    });
    const response = await app.fetch(callbackRequest(platform, "help"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "admission_unavailable" });
    expect(
      store.sqlite.prepare("SELECT COUNT(*) AS count FROM im_inbox").get(),
    ).toEqual({ count: 0 });
  },
);

it("does not reset the HTTP deadline after a slow generation capture", async () => {
  const { config } = fixture("telegram");
  const app = new Hono();
  const client = await readyClient("telegram");
  const cancel = vi.fn();
  registerImCallbackRoutes(app, {
    store,
    namespace: "social",
    env: () => undefined,
    now: () => NOW,
    getConfig: () => config,
    getConfigGeneration: async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return { config, snapshotId: "snapshot", fileDigest: "digest" };
    },
    socialClient: () => client,
  });
  vi.useFakeTimers();
  let received: Response | undefined;
  const pending = app
    .fetch(
      new Request("http://localhost/callbacks/im/bot", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({ cancel }),
        duplex: "half",
      } as RequestInit),
    )
    .then((value) => {
      received = value;
      return value;
    });
  try {
    await vi.advanceTimersByTimeAsync(1001);
    expect(received?.status).toBe(503);
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
  }
});
it.each(platforms)(
  "authenticates, persists and deduplicates %s without waiting for outbound work",
  async (platform) => {
    const { config } = fixture(platform);
    const client = await readyClient(platform);
    const app = new Hono();
    const socialClient = vi.fn(() => client);
    registerImCallbackRoutes(app, {
      store,
      namespace: "social",
      getConfig: () => config,
      getConfigGeneration: () => ({
        config,
        snapshotId: "snapshot",
        fileDigest: "digest",
      }),
      socialClient,
      reviewReady: () => true,
      env: () => undefined,
      now: () => NOW,
    });
    const first = callbackRequest(platform, "review demo " + SHA);
    const second = first.clone();
    const response = await app.fetch(first);
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    const replay = await app.fetch(second);
    expect(replay.status).toBe(200);
    const rows = store.db.select().from(imReviewRequests).all();
    expect(rows).toHaveLength(1);
    const request = await findImReviewRequest(
      store,
      "social",
      rows[0]!.requestId,
    );
    expect(request).toMatchObject({
      state: "accepted",
      configSnapshotId: "snapshot",
      requestedRevision: SHA,
      bindingId: "reviewers",
    });
    expect(request!.configVersionJson).toContain("reviewers");
    if (platform !== "telegram") {
      expect(body).toContain(request!.requestId);
      expect(body).not.toContain("org/demo");
      expect(body).not.toContain(SHA);
    }
    const replies = await claimDueImReplyNotifications(store, {
      owner: "test",
      limit: 10,
      now: new Date(NOW),
    });
    expect(replies).toHaveLength(platform === "telegram" ? 1 : 0);
    if (platform === "telegram") {
      expect(replies[0]!.payloadJson).toContain(request!.requestId);
      expect(replies[0]!.payloadJson).not.toContain(SHA);
    }
  },
);
it.each(platforms)(
  "returns 409 for a %s delivery-key conflict without admitting new work",
  async (platform) => {
    const { config } = fixture(platform);
    const client = await readyClient(platform);
    const app = new Hono();
    registerImCallbackRoutes(app, {
      store,
      namespace: "social",
      getConfig: () => config,
      getConfigGeneration: () => ({ config, snapshotId: "snapshot", fileDigest: "digest" }),
      socialClient: () => client,
      reviewReady: () => true,
      env: () => undefined,
      now: () => NOW,
    });
    const first = await app.fetch(callbackRequest(platform, "review demo " + SHA, 900, undefined, "trigger-900"));
    expect(first.status).toBe(200);
    const conflict = await app.fetch(callbackRequest(platform, "help", 900, undefined, "trigger-900"));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "delivery_conflict" });
    expect(store.db.select().from(imReviewRequests).all()).toHaveLength(1);
    const replies = await claimDueImReplyNotifications(store, { owner: "test", limit: 10, now: new Date(NOW) });
    expect(replies).toHaveLength(platform === "telegram" ? 1 : 0);
  },
);
it("delivers Telegram private-chat replies to the actor chat ID", async () => {
  const { config, connection, actor } = fixture("telegram");
  config.im!.command_bindings!.reviewers!.conversations = [{ kind: "bot_direct" }];
  const sends: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("getMe")) {
      return Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: "TestBot" } });
    }
    if (url.endsWith("getChat")) {
      return Response.json({ ok: true, result: { id: Number(actor.id), type: "private" } });
    }
    if (url.endsWith("sendMessage")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sends.push(body);
      return Response.json({ ok: true, result: { message_id: 1, chat: { id: Number(actor.id) } } });
    }
    throw new Error(`Unexpected ${url}`);
  };
  const client = new SocialImClient(connection, connection.token!, { fetch, now: () => NOW });
  expect(await client.refreshReadiness(actor.id)).toBe(true);
  const app = new Hono();
  registerImCallbackRoutes(app, {
    store,
    namespace: "social",
    getConfig: () => config,
    getConfigGeneration: () => ({ config, snapshotId: "snapshot", fileDigest: "digest" }),
    socialClient: () => client,
    reviewReady: () => true,
    env: () => undefined,
    now: () => NOW,
  });
  const template = callbackRequest("telegram", "review demo " + SHA, 901);
  const raw = JSON.parse(await template.text());
  raw.message.chat = { id: Number(actor.id), type: "private" };
  raw.message.text = `/aicr review demo ${SHA}`;
  raw.message.entities = [{ type: "bot_command", offset: 0, length: 5 }];
  const response = await app.fetch(new Request(template.url, {
    method: "POST", headers: template.headers, body: JSON.stringify(raw),
  }));
  expect(response.status).toBe(200);
  const service = new ImReplyService({ store, getConfig: () => config, env: () => undefined, fetch, now: () => new Date(NOW) });
  await service.scan();
  await service.stop();
  expect(store.db.select().from(imReviewRequests).all()).toHaveLength(1);
  expect(sends).toHaveLength(1);
  expect(sends[0]?.chat_id).toBe(actor.id);
  const outbox = store.sqlite.prepare("SELECT state, payload_json FROM im_reply_outbox").get() as { state: string; payload_json: string };
  expect(outbox.state).toBe("delivered");
  expect(JSON.parse(outbox.payload_json)).toMatchObject({
    conversation: { kind: "bot_direct" }, actor: { id: actor.id },
  });
});
it.each(platforms)(
  "refuses %s review in file-only mode and readiness failure",
  async (platform) => {
    const { config } = fixture(platform);
    const client = await readyClient(platform);
    const app = new Hono();
    registerImCallbackRoutes(app, {
      store,
      namespace: "social",
      getConfig: () => config,
      getConfigGeneration: () => ({
        config,
        snapshotId: null,
        fileDigest: "digest",
      }),
      socialClient: () => client,
      reviewReady: () => false,
      env: () => undefined,
      now: () => NOW,
    });
    expect(
      (await app.fetch(callbackRequest(platform, "review demo " + SHA))).status,
    ).toBe(503);
    expect(store.db.select().from(imReviewRequests).all()).toHaveLength(0);
    expect((await app.fetch(callbackRequest(platform, "help"))).status).toBe(
      200,
    );
  },
);
it.each(platforms)(
  "admits two authenticated %s users under the shared conversation policy", async platform => {
    const { config } = fixture(platform);
    config.im!.command_bindings!.reviewers!.actors = [{ kind: "conversation_users" }];
    const client = await readyClient(platform);
    const app = new Hono();
    registerImCallbackRoutes(app, { store, namespace: "social", getConfig: () => config, getConfigGeneration: () => ({ config, snapshotId: "snapshot", fileDigest: "digest" }), socialClient: () => client, reviewReady: () => true, env: () => undefined, now: () => NOW });
    for (const [index, actor] of [platform === "slack" ? "U234" : platform === "discord" ? "123456789012345681" : "234567891", platform === "slack" ? "U999" : "999"].entries()) {
      const response = await app.fetch(callbackRequest(platform, "review demo " + (index === 0 ? SHA : "1".repeat(40)), 900 + index, actor));
      expect(response.status).toBe(200);
    }
    expect(store.db.select().from(imReviewRequests).all()).toHaveLength(2);
  },
);
it.each(platforms)(
  "rejects forged %s requests before admission",
  async (platform) => {
    const { config } = fixture(platform);
    config.im!.command_bindings!.reviewers!.actors = [{ kind: "conversation_users" }];
    const client = await readyClient(platform);
    const app = new Hono();
    registerImCallbackRoutes(app, {
      store,
      namespace: "social",
      getConfig: () => config,
      socialClient: () => client,
      env: () => undefined,
      now: () => NOW,
    });
    const request = callbackRequest(platform, "help");
    request.headers.set(
      platform === "slack"
        ? "x-slack-signature"
        : platform === "discord"
          ? "x-signature-ed25519"
          : "x-telegram-bot-api-secret-token",
      "bad",
    );
    expect((await app.fetch(request)).status).toBe(401);
    expect(
      await claimDueImReplyNotifications(store, {
        owner: "test",
        limit: 10,
        now: new Date(NOW),
      }),
    ).toHaveLength(0);
  },
);
it("bounds SQLite writer contention before the local ACK deadline and rolls back admission", async () => {
  const { config } = fixture("telegram");
  const client = await readyClient("telegram");
  const app = new Hono();
  registerImCallbackRoutes(app, {
    store,
    namespace: "social",
    getConfig: () => config,
    getConfigGeneration: () => ({
      config,
      snapshotId: "snapshot",
      fileDigest: "d",
    }),
    socialClient: () => client,
    reviewReady: () => true,
    env: () => undefined,
    now: () => NOW,
  });
  const lock = createStoreDb(join(dir, "store.db"));
  lock.sqlite.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  try {
    expect(
      (await app.fetch(callbackRequest("telegram", "review demo " + SHA)))
        .status,
    ).toBe(503);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(store.db.select().from(imReviewRequests).all()).toHaveLength(0);
  } finally {
    lock.sqlite.exec("ROLLBACK");
    await closeStoreDb(lock);
  }
});
it("rejects oversized bodies and cancels a stalled chunked body without admission", async () => {
  const { config } = fixture("telegram");
  const client = await readyClient("telegram");
  const app = new Hono();
  registerImCallbackRoutes(app, {
    store,
    namespace: "social",
    getConfig: () => config,
    socialClient: () => client,
    env: () => undefined,
    now: () => NOW,
  });
  expect(
    (
      await app.fetch(
        new Request("http://localhost/callbacks/im/bot", {
          method: "POST",
          body: "x".repeat(256 * 1024 + 1),
        }),
      )
    ).status,
  ).toBe(413);
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const request = new Request("http://localhost/callbacks/im/bot", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  const started = performance.now();
  expect((await app.fetch(request)).status).toBe(503);
  expect(performance.now() - started).toBeLessThan(1500);
  expect(cancel).toHaveBeenCalled();
  expect(store.db.select().from(imReviewRequests).all()).toHaveLength(0);
});
