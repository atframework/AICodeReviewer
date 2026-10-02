import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appConfigSchema, createReviewEvent, type AppConfig, type ReviewEvent } from "@aicr/core";
import { closeStoreDb, createStoreDb, getImAction, type SqliteStoreDb } from "@aicr/store";
import { PublicationJournal } from "@aicr/outputs";
import type { RemotePublicationOperation } from "@aicr/core";

import { createOutputPublisherFromConfig } from "../src/bootstrap.js";
import { consumeCardAction } from "../src/im/action-service.js";

/**
 * IM-15 acceptance A09/A13 (output-side share): a feishu_app report card
 * issues its opaque action pre-send, embeds only the opaque id in the button,
 * and binds the platform-acknowledged message id after the send. Cards
 * without a consumable callback surface (no matching im connection/binding,
 * direct open_id destinations) carry no button at all.
 */

const REVISION = "0123456789abcdef0123456789abcdef01234567";

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-im-card-"));
  store = createStoreDb(join(dir, "card.db"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

function baseConfig(overrides: {
  im?: AppConfig["im"];
  receiveIdType?: string;
} = {}): AppConfig {
  return appConfigSchema.parse({
    im: overrides.im ?? {
      connections: {
        "conn-fi": {
          kind: "feishu_app", app_id: "cli_1", app_secret: "s", tenant_key: "tk-1",
          callback: { enabled: true, verification_token: "vt", encrypt_key: "ek" },
        },
      },
      command_bindings: {
        reviewers: {
          enabled: true, connection: "conn-fi",
          conversations: [{ kind: "group", id: "oc_grp" }],
          actors: [{ type: "feishu_open_id", id: "ou_1" }],
          commands: ["review"],
          repositories: { svc: { workspace: "ws", source_trigger: "git-main", repo_ref: "org/s" } },
        },
      },
    },
    triggers: [{ name: "git-main", kind: "github" }],
    workspaces: { instances: { ws: {} } },
    outputs: { channels: [{
      kind: "feishu_app", name: "fi", app_id: "cli_1", app_secret: "s",
      receive_id: "oc_grp", ...(overrides.receiveIdType !== undefined ? { receive_id_type: overrides.receiveIdType } : {}),
    }] },
  });
}

const reviewEvent: ReviewEvent = createReviewEvent({
  triggerName: "git-main", provider: "github", workspaceId: "ws", targetKind: "push",
  repoRef: "org/s", headSha: REVISION, author: {}, reason: "github:push",
});

/** Fake platform: one token fetch + one card send returning the message id. */
function stubFeishuFetch(): { cardBodies: Record<string, unknown>[] } {
  const cardBodies: Record<string, unknown>[] = [];
  const response = (data: unknown, status = 200) => ({ ok: status === 200, status, statusText: "test",
    json: async () => data, text: async () => JSON.stringify(data) });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "t", expire: 7200 });
    cardBodies.push(JSON.parse((JSON.parse(init?.body ?? "{}") as { content?: string }).content ?? "{}"));
    return response({ code: 0, data: { message_id: "om_ack_1" } });
  }));
  return { cardBodies };
}

async function publishCard(config: AppConfig): Promise<{ cardBodies: Record<string, unknown>[] }> {
  const { cardBodies } = stubFeishuFetch();
  const publisher = createOutputPublisherFromConfig(config, "fi", undefined, "ws", reviewEvent, dir,
    undefined, undefined, undefined, { store, namespace: "ns-x", currentSnapshotId: () => "snap-1" });
  expect(publisher).toBeDefined();
  const results = await publisher!.publishSummary("Summary", [], {});
  expect(results).toMatchObject({ channel: "fi", status: "published", externalId: "om_ack_1" });
  return { cardBodies };
}

describe("IM-15: WeCom report card action issuance", () => {
  function wecomConfig(overrides: { callbackEnabled?: boolean; bindingRepo?: boolean } = {}): AppConfig {
    return appConfigSchema.parse({
      im: {
        connections: {
          "corp-review": {
            kind: "wecom_app", corp_id: "ww_example", agent_id: 1000002, app_secret: "s",
            callback: { enabled: overrides.callbackEnabled ?? true, token: "vt", encoding_aes_key: "ek" },
          },
        },
        command_bindings: {
          cardHosts: {
            enabled: true, connection: "corp-review",
            conversations: [{ kind: "app_direct" }],
            actors: [{ type: "wecom_userid", id: "owent" }],
            commands: ["review"],
            ...(overrides.bindingRepo === false
              ? { repositories: { other: { workspace: "ws", source_trigger: "git-main", repo_ref: "org/other" } } }
              : { repositories: { service: { workspace: "ws", source_trigger: "git-main", repo_ref: "org/s" } } }),
          },
        },
      },
      triggers: [{ name: "git-main", kind: "github" }],
      workspaces: { instances: { ws: {} } },
      outputs: { channels: [{
        kind: "wecom_app", name: "wcx", connection: "corp-review",
        target: { kind: "recipients", users: ["owent"] },
      }] },
    });
  }

  function stubWecomFetch(): { bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const response = (data: unknown) => ({ ok: true, status: 200, statusText: "test",
      json: async () => data, text: async () => JSON.stringify(data) });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes("gettoken")) return response({ errcode: 0, access_token: "t", expires_in: 7200 });
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return response({ errcode: 0, msgid: `m${bodies.length}` });
    }));
    return { bodies };
  }

  async function publishWecomCard(config: AppConfig): Promise<{ bodies: Record<string, unknown>[] }> {
    const { bodies } = stubWecomFetch();
    const publisher = createOutputPublisherFromConfig(config, "wcx", undefined, "ws-main", reviewEvent, dir,
      undefined, undefined, undefined, { store, namespace: "ns-x", currentSnapshotId: () => "snap-wx" });
    expect(await publisher!.publishSummary("Summary", [], {})).toMatchObject({ status: "published" });
    return { bodies };
  }

  it("sends one button card whose task_id and key carry the opaque id, then binds the TaskId (A09)", async () => {
    const { bodies } = await publishWecomCard(wecomConfig());
    const card = bodies.find(body => body.msgtype === "template_card") as { template_card: { task_id: string; button_list: { key: string; type: number }[] } } | undefined;
    expect(card).toBeDefined();
    const actionId = card!.template_card.task_id;
    expect(actionId).toMatch(/^ima-/u);
    // The button carries ONLY the opaque id as the callback key.
    expect(card!.template_card.button_list[0]).toMatchObject({ key: actionId, type: 0 });
    expect(JSON.stringify(card)).not.toContain("aicr review");
    expect(JSON.stringify(card)).not.toContain("org/service");

    // The send acknowledgement binds the TaskId (equal to the action id by
    // construction); message ids stay unused for WeCom cards.
    const bound = await getImAction(store, actionId);
    expect(bound).toMatchObject({ status: "issued", sourceTaskId: actionId, sourceMessageId: null,
      namespace: "ns-x", bindingId: "cardHosts", revision: REVISION, conversationJson: JSON.stringify({ kind: "app_direct" }) });
    expect(bound?.issuedConfigVersion).toBe("snap-wx");

    const connectionIdentity = JSON.stringify(["ns-x", "wecom_app", "ww_example", "1000002", null]);
    // A click with the matching TaskId uses its admission snapshot.
    const consumed = await consumeCardAction(store, {
      actionId, namespace: "ns-x", connectionName: "corp-review", connectionIdentity,
      sourceTaskId: actionId, config: wecomConfig(), configSnapshotId: "snap-click-wx", configFileDigest: "d".repeat(64),
      actor: { type: "wecom_userid", id: "owent" }, conversation: { kind: "app_direct" },
    });
    expect(consumed.kind).toBe("accepted");
    const request = store.sqlite.prepare("SELECT config_snapshot_id, requested_revision FROM im_review_requests").get() as { config_snapshot_id: string; requested_revision: string };
    expect(request).toMatchObject({ config_snapshot_id: "snap-click-wx", requested_revision: REVISION });
    expect(await consumeCardAction(store, {
      actionId: "ima-missing", namespace: "ns-x", connectionName: "corp-review", connectionIdentity,
      sourceTaskId: "ima-missing", config: wecomConfig(),
      actor: { type: "wecom_userid", id: "owent" }, conversation: { kind: "app_direct" },
    })).toMatchObject({ kind: "not_found" });
  });

  it("issues no card without a callback-enabled connection or a registered repository (A13)", async () => {
    const noCallback = await publishWecomCard(wecomConfig({ callbackEnabled: false }));
    expect(noCallback.bodies.some(body => body.msgtype === "template_card")).toBe(false);
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM im_actions").get()).toMatchObject({ count: 0 });

    const unmatchedRepo = await publishWecomCard(wecomConfig({ bindingRepo: false }));
    expect(unmatchedRepo.bodies.some(body => body.msgtype === "template_card")).toBe(false);
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM im_actions").get()).toMatchObject({ count: 0 });
  });

  it("reuses the issued card action after a fresh journal resumes a confirmed send", async () => {
    const { bodies } = stubWecomFetch();
    let operations: readonly RemotePublicationOperation[] = [];
    const options = { batchId: "wecom-card-run", save: async (saved: readonly RemotePublicationOperation[]) => { operations = structuredClone(saved); } };
    const makePublisher = () => createOutputPublisherFromConfig(wecomConfig(), "wcx", undefined, "ws", reviewEvent, dir,
      undefined, undefined, undefined, { store, namespace: "ns-x", currentSnapshotId: () => "snap-wx" })!;
    await new PublicationJournal(options).run("wcx", "summary-0", () => makePublisher().publishSummary("Summary", [], {}));
    const firstCount = bodies.length;
    const savedActions = store.sqlite.prepare("SELECT action_id FROM im_actions").all();
    await new PublicationJournal({ ...options, operations }).run("wcx", "summary-0", () => makePublisher().publishSummary("Summary", [], {}));
    expect(bodies).toHaveLength(firstCount);
    expect(store.sqlite.prepare("SELECT action_id FROM im_actions").all()).toEqual(savedActions);
  });
});

describe("IM-15: report card action issuance", () => {
  it("reuses the issued card action and acknowledged message on fresh-journal recovery", async () => {
    const { cardBodies } = stubFeishuFetch();
    let operations: readonly RemotePublicationOperation[] = [];
    const options = { batchId: "feishu-card-run", save: async (saved: readonly RemotePublicationOperation[]) => { operations = structuredClone(saved); } };
    const makePublisher = () => createOutputPublisherFromConfig(baseConfig(), "fi", undefined, "ws", reviewEvent, dir,
      undefined, undefined, undefined, { store, namespace: "ns-x", currentSnapshotId: () => "snap-1" })!;
    await new PublicationJournal(options).run("fi", "summary-0", () => makePublisher().publishSummary("Summary", [], {}));
    expect(cardBodies).toHaveLength(1);
    const firstActions = store.sqlite.prepare("SELECT action_id, source_message_id FROM im_actions").all();
    await new PublicationJournal({ ...options, operations }).run("fi", "summary-0", () => makePublisher().publishSummary("Summary", [], {}));
    expect(cardBodies).toHaveLength(1);
    expect(store.sqlite.prepare("SELECT action_id, source_message_id FROM im_actions").all()).toEqual(firstActions);
  });
  it("issues pre-send, embeds only the opaque id and binds the acknowledged message id (A09)", async () => {
    const { cardBodies } = await publishCard(baseConfig());
    const actions = store.sqlite.prepare("SELECT action_id FROM im_actions").all() as { action_id: string }[];
    expect(actions).toHaveLength(1);
    const actionId = actions[0]!.action_id;
    // The button carries ONLY the opaque id — no command, URL or target data.
    expect(cardBodies[0]).toMatchObject({ body: { elements: [expect.anything(), {
      tag: "action",
      actions: [expect.objectContaining({ value: { aicr_action_id: actionId } })],
    }] } });
    expect(JSON.stringify(cardBodies[0])).not.toContain("aicr review");
    expect(JSON.stringify(cardBodies[0])).not.toContain("org/s");
    // Returning from publication includes durable send-side binding.
    const bound = await getImAction(store, actionId);
    expect(bound).toMatchObject({ status: "issued", sourceMessageId: "om_ack_1", namespace: "ns-x", bindingId: "reviewers",
      workspaceId: "ws", sourceTrigger: "git-main", repoRef: "org/s", revision: REVISION });
    expect(bound?.conversationJson).toBe(JSON.stringify({ kind: "group", id: "oc_grp" }));
    expect(bound?.issuedConfigVersion).toBe("snap-1");
    // The bound action consumes into a request pinned at click time.
    const consumed = await consumeCardAction(store, {
      actionId, namespace: "ns-x", connectionName: "conn-fi",
      connectionIdentity: JSON.stringify(["ns-x", "feishu_app", null, "cli_1", "tk-1"]),
      sourceMessageId: "om_ack_1", config: baseConfig(), configSnapshotId: "snap-click-fi", configFileDigest: "e".repeat(64),
      actor: { type: "feishu_open_id", id: "ou_1" }, conversation: { kind: "group", id: "oc_grp" },
    });
    expect(consumed.kind).toBe("accepted");
    const request = store.sqlite.prepare("SELECT config_snapshot_id, requested_revision FROM im_review_requests").get() as { config_snapshot_id: string; requested_revision: string };
    expect(request).toMatchObject({ config_snapshot_id: "snap-click-fi", requested_revision: REVISION });
  });

  it("issues no button without a consumable callback surface (A13)", async () => {
    // No im configuration at all.
    const bare = await publishCard(appConfigSchema.parse({ ...JSON.parse(JSON.stringify(baseConfig())), im: undefined }));
    expect((bare.cardBodies[0]!.body as { elements: unknown[] }).elements).toHaveLength(1);
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM im_actions").get()).toMatchObject({ count: 0 });

    // Direct open_id destinations have no card callback context.
    const direct = await publishCard(baseConfig({ receiveIdType: "open_id" }));
    expect((direct.cardBodies[0]!.body as { elements: unknown[] }).elements).toHaveLength(1);
    expect(JSON.stringify(direct.cardBodies[0])).not.toContain("aicr_action_id");

    // The binding does not cover this repository.
    const otherRepo = baseConfig();
    (otherRepo.im!.command_bindings as Record<string, { repositories: Record<string, unknown> }>).reviewers.repositories = {
      other: { workspace: "ws", source_trigger: "git-main", repo_ref: "org/other" },
    };
    const unmatched = await publishCard(otherRepo);
    expect(JSON.stringify(unmatched.cardBodies[0])).not.toContain("aicr_action_id");
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM im_actions").get()).toMatchObject({ count: 0 });
  });
});
