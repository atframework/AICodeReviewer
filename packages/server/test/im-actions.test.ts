import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appConfigSchema, type AppConfig } from "@aicr/core";
import { closeStoreDb, createStoreDb, type SqliteStoreDb } from "@aicr/store";

import { consumeCardAction, issueCardAction } from "../src/im/action-service.js";

/**
 * IM-15 acceptance A09–A12: opaque action ids, exactly-once atomic
 * consumption, expiry, and replay returning the original request id.
 */

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-im-act-"));
  store = createStoreDb(join(dir, "act.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

const config: AppConfig = appConfigSchema.parse({ outputs: { channels: [] } });
const actor = { type: "feishu_open_id", id: "ou_1" } as const;
const conversation = { kind: "app_direct" } as const;

describe("IM-15: card actions", () => {
  it("issues an opaque id and consumes it exactly once into a request (A09/A10)", async () => {
    const actionId = await issueCardAction(store, {
      namespace: "ns", connectionIdentity: "feishu-lc:feishu-app", connectionName: "feishu-app",
      bindingId: "b", workspaceId: "ws", sourceTrigger: "t", repoRef: "org/service",
      revision: "0123456789abcdef0123456789abcdef01234567", configVersion: "v1",
      conversationJson: JSON.stringify(conversation), recipientId: null,
    });
    expect(actionId).toMatch(/^ima-/u);
    const first = await consumeCardAction(store, { actionId, config, actor, conversation });
    expect(first.kind).toBe("accepted");
    if (first.kind === "accepted") expect(first.requestId).toMatch(/^imr-/u);
    // Replay returns the original request id, never a second request (A10).
    const second = await consumeCardAction(store, { actionId, config, actor, conversation });
    expect(second.kind).toBe("duplicate");
    if (second.kind === "duplicate" && first.kind === "accepted") {
      expect(second.requestId).toBe(first.requestId);
    }
  });

  it("expired actions answer expired and create nothing (A12)", async () => {
    const actionId = await issueCardAction(store, {
      namespace: "ns", connectionIdentity: "c", connectionName: "c", bindingId: "b",
      workspaceId: "ws", sourceTrigger: "t", repoRef: "r", revision: "rev",
      configVersion: "v1", conversationJson: "{}", recipientId: null,
    }, new Date(Date.now() - 25 * 60 * 60 * 1000));
    const result = await consumeCardAction(store, { actionId, config, actor, conversation });
    expect(result.kind).toBe("expired");
  });

  it("unknown ids answer not_found (A09)", async () => {
    const result = await consumeCardAction(store, { actionId: "ima-missing", config, actor, conversation });
    expect(result.kind).toBe("not_found");
  });
});
