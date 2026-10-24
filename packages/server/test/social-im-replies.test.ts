import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as storeApi from "@aicr/store";
import {
  createStoreDb,
  closeStoreDb,
  imReplyOutbox,
  type SqliteStoreDb,
  claimDueImReplyNotifications,
  finishImReplyNotification,
} from "@aicr/store";
import { ImReplyService } from "../src/im/reply-service.js";
import { processSocialCommand } from "../src/im/social-command-service.js";
import { storedConnectionIdentity } from "../src/im/social-identity.js";
import { platforms, fixture, apiFixture, NOW } from "./social-im-fixtures.js";
let dir: string;
let store: SqliteStoreDb;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-social-reply-"));
  store = createStoreDb(join(dir, "store.db"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});
it.each(platforms)(
  "bounds %s pre-send credential failures across worker restarts without leaking errors",
  async (platform) => {
    const f = await seed(platform);
    const connection = f.config.im!.connections!.bot!;
    delete connection.token;
    connection.token_env = "SOCIAL_REPLY_TEST_TOKEN";
    let now = NOW;
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let attempt = 1; attempt <= 5; attempt++) {
      const service = new ImReplyService({
        store,
        getConfig: () => f.config,
        env: () => {
          throw new Error("do-not-log-secret-token");
        },
        fetch: apiFixture(platform, calls),
        now: () => new Date(now),
      });
      await service.scan();
      await service.stop();
      const row = store.db.select().from(imReplyOutbox).get()!;
      expect(row.attempts).toBe(attempt);
      expect(row.state).toBe(attempt === 5 ? "failed" : "pending");
      if (attempt < 5) {
        expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(now);
        now = row.nextAttemptAt!.getTime();
      }
    }
    now += 86_400_000;
    const fresh = new ImReplyService({
      store,
      getConfig: () => f.config,
      env: () => undefined,
      fetch: apiFixture(platform, calls),
      now: () => new Date(now),
    });
    await fresh.scan();
    await fresh.stop();
    expect(store.db.select().from(imReplyOutbox).get()!).toMatchObject({
      state: "failed",
      attempts: 5,
    });
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "do-not-log-secret-token",
    );
  },
);

it.each([1, 2, 3])(
  "backs off a config read failure at pre-send stage %i and recovers without a duplicate",
  async (failAt) => {
    const f = await seed("telegram");
    let now = NOW;
    let reads = 0;
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new ImReplyService({
      store,
      getConfig: () => {
        if (++reads === failAt) throw new Error("do-not-log-config-secret");
        return f.config;
      },
      env: () => undefined,
      fetch: apiFixture("telegram", calls),
      now: () => new Date(now),
    });
    await service.scan();
    await service.stop();
    const row = store.db.select().from(imReplyOutbox).get()!;
    expect(row.state).toBe("pending");
    expect(calls.filter((c) => c.url.endsWith("sendMessage"))).toHaveLength(0);
    now = row.nextAttemptAt!.getTime();
    const fresh = new ImReplyService({
      store,
      getConfig: () => f.config,
      env: () => undefined,
      fetch: apiFixture("telegram", calls),
      now: () => new Date(now),
    });
    await fresh.scan();
    await fresh.stop();
    expect(store.db.select().from(imReplyOutbox).get()!.state).toBe(
      "delivered",
    );
    expect(calls.filter((c) => c.url.endsWith("sendMessage"))).toHaveLength(1);
  },
);

it("fences a delivered Telegram reply when receipt persistence throws", async () => {
  const f = await seed("telegram");
  let now = NOW;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const finish = storeApi.finishImReplyNotification;
  vi.spyOn(storeApi, "finishImReplyNotification").mockImplementation(
    async (db, input) => {
      if (input.state === "delivered")
        throw new Error("do-not-log-storage-secret");
      return finish(db, input);
    },
  );
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const opts = {
    store,
    getConfig: () => f.config,
    env: () => undefined,
    fetch: apiFixture("telegram", calls),
    now: () => new Date(now),
  };
  const service = new ImReplyService(opts);
  await service.scan();
  await service.stop();
  expect(store.db.select().from(imReplyOutbox).get()!.state).toBe("sending");
  now += 61_000;
  const fresh = new ImReplyService(opts);
  await fresh.scan();
  await fresh.stop();
  expect(store.db.select().from(imReplyOutbox).get()!.state).toBe("unknown");
  expect(calls.filter((c) => c.url.endsWith("sendMessage"))).toHaveLength(1);
  expect(log).toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain(
    "do-not-log-storage-secret",
  );
});
it("retries a local failure before the sending CAS without sending a message", async () => {
  const f = await seed("telegram");
  let now = NOW;
  let fail = true;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const finish = storeApi.finishImReplyNotification;
  vi.spyOn(storeApi, "finishImReplyNotification").mockImplementation(
    async (db, input) => {
      if (input.state === "sending" && fail) {
        fail = false;
        throw new Error("private storage error");
      }
      return finish(db, input);
    },
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const opts = {
    store,
    getConfig: () => f.config,
    env: () => undefined,
    fetch: apiFixture("telegram", calls),
    now: () => new Date(now),
  };
  const service = new ImReplyService(opts);
  await service.scan();
  await service.stop();
  const row = store.db.select().from(imReplyOutbox).get()!;
  expect(row.state).toBe("pending");
  expect(calls.filter((c) => c.url.endsWith("sendMessage"))).toHaveLength(0);
  now = row.nextAttemptAt!.getTime();
  const fresh = new ImReplyService(opts);
  await fresh.scan();
  await fresh.stop();
  expect(store.db.select().from(imReplyOutbox).get()!.state).toBe("delivered");
  expect(calls.filter((c) => c.url.endsWith("sendMessage"))).toHaveLength(1);
});
it.each(platforms)(
  "exhausts explicit %s rate-limit retries into failed after five attempts",
  async (platform) => {
    const f = await seed(platform);
    let now = NOW;
    let writes = 0;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const service = new ImReplyService({
        store,
        getConfig: () => f.config,
        env: () => undefined,
        now: () => new Date(now),
        fetch: apiFixture(platform, [], () => {
          writes++;
          return Response.json(
            {
              ok: false,
              error_code: 429,
              parameters: { retry_after: 1 },
              retry_after: 1,
            },
            { status: 429, headers: { "Retry-After": "1" } },
          );
        }),
      });
      await service.scan();
      await service.stop();
      const row = store.db.select().from(imReplyOutbox).get()!;
      expect(row.state).toBe(attempt === 5 ? "failed" : "pending");
      if (attempt < 5) now = row.nextAttemptAt!.getTime();
    }
    expect(writes).toBe(5);
  },
);
it("does not send an older outbox row whose attempt budget is already exhausted", async () => {
  const f = await seed("telegram");
  store.db.update(imReplyOutbox).set({ attempts: 5 }).run();
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const service = new ImReplyService({
    store,
    getConfig: () => f.config,
    env: () => undefined,
    fetch: apiFixture("telegram", calls),
    now: () => new Date(NOW),
  });
  await service.scan();
  await service.stop();
  expect(store.db.select().from(imReplyOutbox).get()!).toMatchObject({
    state: "failed",
    attempts: 6,
  });
  expect(calls).toHaveLength(0);
});
async function seed(platform: (typeof platforms)[number]) {
  const f = fixture(platform);
  await processSocialCommand(store, {
    ...f,
    namespace: "social",
    connectionName: "bot",
    connectionIdentity: storedConnectionIdentity(f.connection, "social"),
    deliveryKey: "help",
    payloadDigest: "d",
    command: { kind: "help" },
    now: new Date(NOW),
    configSnapshotId: "snapshot",
    configFileDigest: "d",
    replyOutbox: true,
  });
  return f;
}
it.each(platforms)(
  "sends the %s reply once and records only compact receipt",
  async (platform) => {
    const f = await seed(platform);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const service = new ImReplyService({
      store,
      getConfig: () => f.config,
      env: () => undefined,
      fetch: apiFixture(platform, calls),
      now: () => new Date(NOW),
    });
    await service.scan();
    await service.scan();
    await service.stop();
    const row = store.db.select().from(imReplyOutbox).get()!;
    expect(row.state).toBe("delivered");
    expect(row.compactReceipt).toContain("messageId");
    expect(row.compactReceipt).not.toContain("test-token");
    expect(
      calls.filter((c) =>
        /chat\.postMessage$|\/messages$|sendMessage$/u.test(c.url),
      ),
    ).toHaveLength(1);
  },
);
it.each(platforms)(
  "never resends %s after response loss, including a fresh worker",
  async (platform) => {
    const f = await seed(platform);
    let writes = 0;
    const api = apiFixture(platform, [], () => {
      writes++;
      throw new Error("response lost");
    });
    const opts = {
      store,
      getConfig: () => f.config,
      env: () => undefined,
      fetch: api,
      now: () => new Date(NOW),
    };
    const service = new ImReplyService(opts);
    await service.scan();
    await service.stop();
    const fresh = new ImReplyService(opts);
    await fresh.scan();
    await fresh.stop();
    expect(writes).toBe(1);
    expect(store.db.select().from(imReplyOutbox).get()!.state).toBe("unknown");
  },
);
it("preserves explicit Telegram 429 due time across restart, then delivers once", async () => {
  const f = await seed("telegram");
  let now = NOW;
  let writes = 0;
  const api = apiFixture("telegram", [], () => {
    writes++;
    return writes === 1
      ? new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 3 },
          }),
          { status: 429 },
        )
      : new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 1, chat: { id: -1001234567890 } },
          }),
        );
  });
  const opts = {
    store,
    getConfig: () => f.config,
    env: () => undefined,
    fetch: api,
    now: () => new Date(now),
  };
  const first = new ImReplyService(opts);
  await first.scan();
  await first.stop();
  expect(store.db.select().from(imReplyOutbox).get()!).toMatchObject({
    state: "pending",
    nextAttemptAt: new Date(NOW + 3000),
  });
  const fresh = new ImReplyService(opts);
  now += 2999;
  await fresh.scan();
  expect(writes).toBe(1);
  now++;
  await fresh.scan();
  await fresh.stop();
  expect(writes).toBe(2);
  expect(store.db.select().from(imReplyOutbox).get()!.state).toBe("delivered");
});
it.each(platforms)(
  "rejects a revoked %s binding before any platform call",
  async (platform) => {
    const f = await seed(platform);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    f.config.im!.command_bindings!.reviewers!.enabled = false;
    const service = new ImReplyService({
      store,
      getConfig: () => f.config,
      env: () => undefined,
      fetch: apiFixture(platform, calls),
      now: () => new Date(NOW),
    });
    await service.scan();
    await service.stop();
    expect(calls).toHaveLength(0);
    expect(store.db.select().from(imReplyOutbox).get()!.state).toBe("rejected");
  },
);
it("does not reclaim a persisted sending row after an exit before receipt persistence", async () => {
  await seed("telegram");
  const row = (
    await claimDueImReplyNotifications(store, {
      owner: "lost",
      limit: 10,
      now: new Date(NOW),
    })
  )[0]!;
  expect(
    await finishImReplyNotification(store, {
      operationId: row.operationId,
      fence: row.fence,
      owner: "lost",
      state: "sending",
      now: new Date(NOW),
    }),
  ).toBe(true);
  const f = fixture("telegram");
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const service = new ImReplyService({
    store,
    getConfig: () => f.config,
    env: () => undefined,
    fetch: apiFixture("telegram", calls),
    now: () => new Date(NOW + 61_000),
  });
  await service.scan();
  await service.stop();
  expect(calls).toHaveLength(0);
  expect(store.db.select().from(imReplyOutbox).get()!.state).toBe("unknown");
});

it.each([
  { advanceMs: 1000, expected: "expired" },
  { advanceMs: 61_000, expected: "unknown" },
])("does not POST after pre-send expiry advances by $advanceMs ms", async ({ advanceMs, expected }) => {
  const f = await seed("telegram");
  if (expected === "expired") store.db.update(imReplyOutbox).set({ expiry: new Date(NOW + 1000) }).run();
  let now = NOW;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const finish = storeApi.finishImReplyNotification;
  vi.spyOn(storeApi, "finishImReplyNotification").mockImplementation(async (db, input) => {
    const result = await finish(db, input);
    if (input.state === "sending" && result) now += advanceMs;
    return result;
  });
  const options = { store, getConfig: () => f.config, env: () => undefined,
    fetch: apiFixture("telegram", calls), now: () => new Date(now) };
  const service = new ImReplyService(options);
  await service.scan();
  await service.stop();
  expect(calls.filter(call => call.url.endsWith("sendMessage"))).toHaveLength(0);
  if (expected === "unknown") {
    const fresh = new ImReplyService(options);
    await fresh.scan();
    await fresh.stop();
  }
  expect(store.db.select().from(imReplyOutbox).get()!.state).toBe(expected);
  expect(calls.filter(call => call.url.endsWith("sendMessage"))).toHaveLength(0);
});

it("uses the rotated token from the final config generation for readiness and POST", async () => {
  const f = await seed("telegram");
  const rotated = structuredClone(f.config);
  rotated.im!.connections!.bot!.token = "123456789:rotated";
  let reads = 0;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const service = new ImReplyService({
    store,
    getConfig: () => ++reads === 1 ? f.config : rotated,
    env: () => undefined,
    fetch: apiFixture("telegram", calls),
    now: () => new Date(NOW),
  });
  await service.scan();
  await service.stop();
  const post = calls.find(call => call.url.endsWith("sendMessage"));
  expect(post?.url).toContain("/bot123456789:rotated/sendMessage");
  expect(store.db.select().from(imReplyOutbox).get()!.state).toBe("delivered");
});

it("backs off a temporary readiness failure and recovers without a duplicate", async () => {
  const f = await seed("telegram");
  let now = NOW;
  let unavailable = true;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const api = apiFixture("telegram", calls);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (unavailable && String(input).endsWith("getMe")) throw new Error("metadata unavailable");
    return api(input, init);
  };
  const options = { store, getConfig: () => f.config, env: () => undefined, fetch, now: () => new Date(now) };
  const service = new ImReplyService(options);
  await service.scan();
  await service.stop();
  const pending = store.db.select().from(imReplyOutbox).get()!;
  expect(pending.state).toBe("pending");
  expect(pending.nextAttemptAt!.getTime()).toBeGreaterThan(now);
  expect(calls.filter(call => call.url.endsWith("sendMessage"))).toHaveLength(0);
  unavailable = false;
  now = pending.nextAttemptAt!.getTime();
  const fresh = new ImReplyService(options);
  await fresh.scan();
  await fresh.stop();
  expect(store.db.select().from(imReplyOutbox).get()!.state).toBe("delivered");
  expect(calls.filter(call => call.url.endsWith("sendMessage"))).toHaveLength(1);
});

it("persists a retry when social delivery is stopped after CAS but before POST", async () => {
  const f = await seed("telegram");
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const finish = storeApi.finishImReplyNotification;
  const service = new ImReplyService({ store, getConfig: () => f.config, env: () => undefined,
    fetch: apiFixture("telegram", calls), now: () => new Date(NOW) });
  vi.spyOn(storeApi, "finishImReplyNotification").mockImplementation(async (db, input) => {
    const result = await finish(db, input);
    if (input.state === "sending" && result) service.dispose();
    return result;
  });
  await service.scan();
  await service.stop();
  expect(calls.filter(call => call.url.endsWith("sendMessage"))).toHaveLength(0);
  expect(store.db.select().from(imReplyOutbox).get()!).toMatchObject({ state: "pending" });
});
