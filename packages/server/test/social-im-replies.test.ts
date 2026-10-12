import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
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
