import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as storeApi from "@aicr/store";
import {
  createStoreDb,
  closeStoreDb,
  findImReviewRequest,
  type SqliteStoreDb,
} from "@aicr/store";
import {
  processSocialCommand,
  currentImRequestAuthorized,
} from "../src/im/social-command-service.js";
import { storedConnectionIdentity } from "../src/im/social-identity.js";
import { ImConnectionRegistry } from "../src/im/connections.js";
import { authorizeImCommand } from "../src/im/command-service.js";
import {
  platforms,
  fixture,
  SHA,
  NOW,
  apiFixture,
} from "./social-im-fixtures.js";
let dir: string;
let store: SqliteStoreDb;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-social-auth-"));
  store = createStoreDb(join(dir, "store.db"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});
it.each(platforms)(
  "keeps %s request execution pinned but rechecks current identity and authorization",
  async (platform) => {
    const f = fixture(platform);
    const input = {
      ...f,
      namespace: "social",
      connectionName: "bot",
      connectionIdentity: storedConnectionIdentity(f.connection, "social"),
      deliveryKey: "review",
      payloadDigest: "d",
      now: new Date(NOW),
      configSnapshotId: "original-snapshot",
      configFileDigest: "d",
      replyOutbox: false,
    };
    const accepted = await processSocialCommand(store, {
      ...input,
      command: { kind: "review", repoAlias: "demo", revision: SHA },
    });
    const request = (await findImReviewRequest(
      store,
      "social",
      accepted.requestId!,
    ))!;
    expect(await currentImRequestAuthorized(f.config, request)).toBe(true);
    const rotated = structuredClone(f.config);
    rotated.im!.connections!.bot!.token =
      platform === "telegram" ? "123456789:rotated" : "rotated";
    expect(
      storedConnectionIdentity(rotated.im!.connections!.bot!, "social"),
    ).toBe(input.connectionIdentity);
    expect(await currentImRequestAuthorized(rotated, request)).toBe(true);
    const revoked = structuredClone(f.config);
    revoked.im!.command_bindings!.reviewers!.enabled = false;
    expect(await currentImRequestAuthorized(revoked, request)).toBe(false);
    const disabled = structuredClone(f.config);
    disabled.im!.connections!.bot!.callback!.enabled = false;
    expect(await currentImRequestAuthorized(disabled, request)).toBe(false);
    const remapped = structuredClone(f.config);
    remapped.im!.command_bindings!.reviewers!.repositories!.demo!.repo_ref =
      "other/repo";
    expect(await currentImRequestAuthorized(remapped, request)).toBe(false);
    expect(
      (await findImReviewRequest(store, "social", request.requestId))!
        .configSnapshotId,
    ).toBe("original-snapshot");
    const status = await processSocialCommand(store, {
      ...input,
      deliveryKey: "status",
      command: { kind: "status", requestId: request.requestId },
    });
    expect(status.text).toContain(request.requestId);
    const other = platform === "slack" ? "U999" : "999";
    const config = structuredClone(f.config);
    const actor = { ...f.actor, id: other };
    config.im!.command_bindings!.reviewers!.actors.push(actor);
    expect(
      (
        await processSocialCommand(store, {
          ...input,
          config,
          actor,
          deliveryKey: "other-status",
          command: { kind: "status", requestId: request.requestId },
        })
      ).text,
    ).toBe("Request not found.");
  },
);
it.each(platforms)(
  "authorizes new %s conversation users without a directory and keeps status ownership", async platform => {
    const f = fixture(platform);
    f.config.im!.command_bindings!.reviewers!.actors = [{ kind: "conversation_users" }];
    const directory = { resolve: vi.fn(async () => { throw new Error("no directory required"); }) };
    const input = { ...f, namespace: "social", connectionName: "bot", connectionIdentity: storedConnectionIdentity(f.connection, "social"), payloadDigest: "d", now: new Date(NOW), configSnapshotId: "snapshot", configFileDigest: "d", replyOutbox: false };
    const actors = [f.actor, { ...f.actor, id: platform === "slack" ? "U999" : "999" }];
    for (const [index, actor] of actors.entries()) {
      const accepted = await processSocialCommand(store, { ...input, actor, deliveryKey: "review-" + index, command: { kind: "review", repoAlias: "demo", revision: index === 0 ? SHA : "1".repeat(40) } });
      expect(accepted.requestId).toBeTruthy();
      const request = (await findImReviewRequest(store, "social", accepted.requestId!))!;
      expect(await currentImRequestAuthorized(f.config, request, directory)).toBe(true);
      const status = await processSocialCommand(store, { ...input, actor: actors[1 - index]!, deliveryKey: "status-" + index, command: { kind: "status", requestId: request.requestId } });
      expect(status.text).toBe("Request not found.");
      const narrowed = structuredClone(f.config);
      narrowed.im!.command_bindings!.reviewers!.actors = [{ ...actor, id: platform === "slack" ? "UOTHER" : "888" }];
      expect(await currentImRequestAuthorized(narrowed, request, directory)).toBe(false);
      const moved = structuredClone(f.config);
      moved.im!.command_bindings!.reviewers!.conversations = [{ ...f.conversation, id: platform === "slack" ? "COTHER" : "-999" }];
      expect(await currentImRequestAuthorized(moved, request, directory)).toBe(false);
    }
    expect(directory.resolve).not.toHaveBeenCalled();
    const base = { config: f.config, connectionName: "bot", actor: f.actor, conversation: f.conversation, command: { kind: "help" } as const, now: new Date(NOW) };
    expect(authorizeImCommand({ ...base, actor: { type: "wecom_userid", id: f.actor.id } }).kind).toBe("rejected");
    expect(authorizeImCommand({ ...base, conversation: { kind: "bot_direct" } }).kind).toBe("rejected");
    f.config.im!.command_bindings!.reviewers!.actors = [{ kind: "conversation_users", expires_at: new Date(NOW - 1).toISOString() }];
    expect(authorizeImCommand(base).kind).toBe("rejected");
  },
);
it.each(platforms)(
  "invalidates %s token caches without changing the durable identity",
  (platform) => {
    const f = fixture(platform);
    const registry = new ImConnectionRegistry({
      env: () => undefined,
      fetch: apiFixture(platform),
    });
    const original = registry.social(f.connection);
    const rotated = {
      ...f.connection,
      token: platform === "telegram" ? "123456789:rotated" : "rotated",
    };
    expect(registry.social(rotated)).not.toBe(original);
    expect(storedConnectionIdentity(rotated, "social")).toBe(
      storedConnectionIdentity(f.connection, "social"),
    );
    registry.dispose();
  },
);

it("passes the status admission budget to the store query", async () => {
  const f = fixture("telegram");
  const input = {
    ...f,
    namespace: "social",
    connectionName: "bot",
    connectionIdentity: storedConnectionIdentity(f.connection, "social"),
    payloadDigest: "d",
    now: new Date(NOW),
    configSnapshotId: "snapshot",
    configFileDigest: "d",
    replyOutbox: false,
  };
  const accepted = await processSocialCommand(store, {
    ...input,
    deliveryKey: "review-for-status",
    command: { kind: "review", repoAlias: "demo", revision: SHA },
  });
  const query = vi.spyOn(storeApi, "findImReviewRequest");
  const signal = new AbortController().signal;
  const deadlineAt = Date.now() + 500;
  await processSocialCommand(store, {
    ...input,
    deliveryKey: "bounded-status",
    command: { kind: "status", requestId: accepted.requestId! },
    signal,
    deadlineAt,
  });
  expect(query).toHaveBeenCalledWith(store, "social", accepted.requestId, { signal, deadlineAt });
});
