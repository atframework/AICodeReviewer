import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appConfigSchema, createReviewEvent } from "@aicr/core";
import { acceptImDelivery, closeStoreDb, createStoreDb, listImActiveConfigSnapshotIds, type SqliteStoreDb } from "@aicr/store";

import { Hono } from "hono";
import { createServerApp } from "../src/index.js";
import { createOutputPublisherFromConfig } from "../src/bootstrap.js";
import { registerImCallbackRoutes, type ImCallbackRoutesOptions } from "../src/im/callback-routes.js";
import { buildWecomAibotEncryptedReply, verifyWecomAibotCallback } from "../src/im/protocol-wecom-aibot.js";
import { encryptFeishuPayload } from "../src/im/protocol-feishu.js";
/**
 * IM-12 acceptance S09–S12 (receive-path share): real Hono app over the real
 * SQLite store — platform auth without admin session, raw-body verification,
 * challenge echo, inbox persistence before ACK, bounded bodies and unknown /
 * disabled connections.
 */

const ENCODING_AES_KEY = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const TOKEN = "routetoken";
const CORP_ID = "wwtestcorp";
const AIBOT_ID = "bot-1";
const TIMESTAMP = "1759000000";
const NONCE = "routenonce";

let dir: string;
let store: SqliteStoreDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicr-im-routes-"));
  store = createStoreDb(join(dir, "routes.db"));
});

afterEach(async () => {
  await closeStoreDb(store);
  rmSync(dir, { recursive: true, force: true });
});

function baseConfig(): ReturnType<typeof appConfigSchema.parse> {
  return appConfigSchema.parse({
    im: {
      connections: {
        "corp-airobot": {
          kind: "wecom_aibot",
          corp_id: CORP_ID,
          aibot_id: AIBOT_ID,
          callback: { enabled: true, token: TOKEN, encoding_aes_key: ENCODING_AES_KEY },
        },
        "corp-disabled": {
          kind: "wecom_aibot",
          corp_id: CORP_ID,
          aibot_id: AIBOT_ID,
          callback: { enabled: false, token: TOKEN, encoding_aes_key: ENCODING_AES_KEY },
        },
        "corp-env": {
          kind: "wecom_aibot",
          corp_id: CORP_ID,
          aibot_id: AIBOT_ID,
          callback: { enabled: true, token_env: "AICR_ROUTE_TOKEN", encoding_aes_key: ENCODING_AES_KEY },
        },
        "corp-app": {
          kind: "wecom_app",
          corp_id: CORP_ID,
          agent_id: 1,
          app_secret_env: "AICR_WECOM_APP_SECRET",
          callback: { enabled: true, token: TOKEN, encoding_aes_key: ENCODING_AES_KEY },
        },
        "feishu-app": {
          kind: "feishu_app",
          app_id: "cli_test",
          tenant_key: "tk-1",
          app_secret_env: "AICR_FEISHU_APP_SECRET",
          callback: { enabled: true, verification_token: "vtoken", encrypt_key: "ekey" },
        },
      },
      command_bindings: {
        reviewers: {
          enabled: true,
          connection: "corp-airobot",
          conversations: [{ kind: "group", id: "chat-9" }],
          actors: [{ type: "wecom_userid", id: "owent" }],
          commands: ["review"],
          repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
        },
      },
    },
    triggers: [{ name: "github-main", kind: "github" }],
    workspaces: { instances: { "ws-main": {} } },
    outputs: { channels: [] },
  });
}

function routeOptions(overrides: Partial<ImCallbackRoutesOptions> = {}): ImCallbackRoutesOptions {
  return {
    store,
    namespace: "ns-routes",
    getConfig: baseConfig,
    env: (name) => (name === "AICR_ROUTE_TOKEN" ? "envtoken" : undefined),
    now: () => 1759000000_000,
    ...overrides,
  };
}

// Independently computed crypto (same framing as the vector generator).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function pad(buf: Buffer, block = 32): Buffer {
  const amount = block - (buf.length % block);
  return Buffer.concat([buf, Buffer.alloc(amount, amount)]);
}

function encrypt(plaintext: string, receiveid: string, prefix: Buffer): string {
  const key = Buffer.from(`${ENCODING_AES_KEY}=`, "base64");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(Buffer.byteLength(plaintext, "utf8"));
  const body = Buffer.concat([prefix, len, Buffer.from(plaintext, "utf8"), Buffer.from(receiveid, "utf8")]);
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pad(body)), cipher.final()]).toString("base64");
}

function sha1(...parts: string[]): string {
  return createHash("sha1").update([...parts].sort().join("")).digest("hex");
}

function decrypt(ciphertext: string): string {
  const key = Buffer.from(`${ENCODING_AES_KEY}=`, "base64");
  const decipher = createDecipheriv("aes-256-cbc", key, Buffer.alloc(16));
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  const padLen = raw[raw.length - 1]!;
  const content = raw.subarray(0, raw.length - padLen);
  const messageLength = content.readUInt32BE(16);
  return content.subarray(20, 20 + messageLength).toString("utf8");
}

const PREFIX = Buffer.from("00112233445566778899aabbccddeeff", "hex");

function challengeParams(): URLSearchParams {
  const echoPlain = "777000111222";
  const ciphertext = encrypt(echoPlain, "", PREFIX);
  return new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE, echostr: ciphertext });
}

function messageRequest(msgid = "m-1", text = "aicr help"): { query: URLSearchParams; body: string; plaintext: string } {
  const payload = JSON.stringify({
    msgid, aibotid: AIBOT_ID, chatid: "chat-9", chattype: "group",
    from: { userid: "owent" }, timestamp: Number(TIMESTAMP),
    text: { content: text },
  });
  const ciphertext = encrypt(payload, "", randomBytes(16));
  return {
    query: new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE }),
    body: JSON.stringify({ encrypt: ciphertext }),
    plaintext: payload,
  };
}

function inboxRowsFor(deliveryKey: string): { namespace: string; delivery_kind: string; status: string; delivery_key: string }[] {
  return store.sqlite.prepare("SELECT namespace, delivery_kind, status, delivery_key FROM im_inbox WHERE delivery_key = ?").all(deliveryKey) as { namespace: string; delivery_kind: string; status: string; delivery_key: string }[];
}

/** WeCom self-built application envelope: XML outside, XML inside, CorpID receiver. */
function wecomAppRequest(innerXml: string): { query: URLSearchParams; body: string } {
  const ciphertext = encrypt(innerXml, CORP_ID, randomBytes(16));
  return {
    query: new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE }),
    body: `<xml><ToUserName>${CORP_ID}</ToUserName><Encrypt>${ciphertext}</Encrypt></xml>`,
  };
}

function wecomAppInnerXml(fields: Record<string, string>): string {
  return `<xml>${Object.entries(fields).map(([key, value]) => `<${key}>${value}</${key}>`).join("")}</xml>`;
}

/** Feishu event callback: signature over the exact raw body bytes (S04). */
function feishuCallback(rawBody: string, options: { tamperSignature?: boolean } = {}): { url: string; init: RequestInit } {
  const timestamp = TIMESTAMP;
  const nonce = "feishunonce";
  const signature = createHash("sha256").update(`${timestamp}${nonce}ekey${rawBody}`).digest("hex");
  return {
    url: "/callbacks/im/feishu-app",
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": options.tamperSignature === true ? `${"0".repeat(64)}` : signature,
      },
      body: rawBody,
    },
  };
}

function feishuMessageBody(input: { messageId: string; senderType?: string; text: string }): string {
  const sender = input.senderType === "app"
    ? `"sender": { "sender_type": "app",   "sender_id": {} }`
    : `"sender": { "sender_type": "user",   "sender_id": { "open_id": "ou-owent" } }`;
  return `{ "schema": "2.0",   "header": { "event_id": "ev-${input.messageId}", "event_type": "im.message.receive_v1", "create_time": "1759000000000", "token": "vtoken", "app_id": "cli_test", "tenant_key": "tk-1" },
  "event": { ${sender},
    "message": { "message_id": "${input.messageId}", "chat_id": "oc-1", "chat_type": "group", "message_type": "text", "content": ${JSON.stringify(JSON.stringify({ text: input.text }))} } } }`;
}

function feishuCardActionBody(actionId: string, messageId = "om-card-1"): string {
  return `{ "schema": "2.0", "header": { "event_id": "ev-card-${messageId}", "event_type": "card.action.trigger", "create_time": "1759000000000", "token": "vtoken" },
  "event": { "operator": { "operator_id": { "open_id": "ou-owent" } },
    "context": { "open_chat_id": "oc-1", "open_message_id": "${messageId}" },
    "action": { "value": { "aicr_action_id": "${actionId}" } } } }`;
}

/** Decrypts an aibot passive stream reply into its text content. */
async function streamReplyText(response: Response): Promise<string> {
  const envelope = JSON.parse(await response.text()) as { encrypt: string };
  const reply = JSON.parse(decrypt(envelope.encrypt)) as { stream: { content: string } };
  return reply.stream.content;
}

function countRows(table: string, where = ""): number {
  return (store.sqlite.prepare(`SELECT count(*) AS count FROM ${table} ${where}`).get() as { count: number }).count;
}

describe("im callback routes (real Hono app)", () => {
  it("answers the aibot URL verification challenge with the decrypted echo", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const response = await app.request(`/callbacks/im/corp-airobot?${challengeParams().toString()}`, { method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("777000111222");
  });

  it("verifies a POST command message, persists the inbox row and answers with the encrypted reply envelope", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const request = messageRequest();
    const response = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
    });
    expect(response.status).toBe(200);
    // A command message ACKs with the encrypted inline reply, never before
    // the inbox row is durable (S11: persist, then answer). The passive
    // reply is a finished stream message; markdown bodies are ignored by
    // the platform (被动回复消息 path/101031).
    const envelope = JSON.parse(await response.text()) as { encrypt: string; msgsignature: string; timestamp: string; nonce: string };
    expect(envelope).toMatchObject({ timestamp: TIMESTAMP, nonce: NONCE });
    expect(envelope.encrypt).not.toBe("");
    expect(envelope.msgsignature).toBe(sha1(TOKEN, TIMESTAMP, NONCE, envelope.encrypt));
    const reply = JSON.parse(decrypt(envelope.encrypt)) as { msgtype: string; stream: { id: string; finish: boolean; content: string } };
    expect(reply.msgtype).toBe("stream");
    expect(reply.stream.finish).toBe(true);
    expect(reply.stream.content).toContain("aicr help");
    const inboxRows = inboxRowsFor("m-1");
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]).toMatchObject({ namespace: "ns-routes", delivery_kind: "message", status: "noted" }); // command creation lands with IM-11
    const digest = store.sqlite.prepare("SELECT payload_digest FROM im_inbox WHERE delivery_key = ?").get("m-1") as { payload_digest: string };
    expect(digest.payload_digest).toBe(`json:sha256:${createHash("sha256").update(request.plaintext, "utf8").digest("hex")}`);

    // Platform retry of the same delivery replays without a second row.
    const retry = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: request.body,
    });
    expect(retry.status).toBe(200);
    expect(inboxRowsFor("m-1")).toHaveLength(1);
  });

  it("verifies a POST non-command message and ACKs plain success", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const request = messageRequest("m-plain", "看看这个提交就行");
    const response = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("success");
    expect(inboxRowsFor("m-plain")).toHaveLength(1);
  });

  it("promotes a verified callback inbox row into exactly one review request", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const request = messageRequest("m-review", "aicr review service 0123456789abcdef0123456789abcdef01234567");
    const url = `/callbacks/im/corp-airobot?${request.query.toString()}`;
    const send = () => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: request.body });
    const first = await send();
    expect(first.status).toBe(200);
    const firstReply = JSON.parse(decrypt((JSON.parse(await first.text()) as { encrypt: string }).encrypt)) as { stream: { content: string } };
    expect(firstReply.stream.content).toContain("已收到评审请求");
    expect(inboxRowsFor("m-review")).toMatchObject([{ status: "request_created" }]);
    const requests = store.sqlite.prepare("SELECT request_id FROM im_review_requests").all() as { request_id: string }[];
    expect(requests).toHaveLength(1);
    expect((await send()).status).toBe(200);
    expect(store.sqlite.prepare("SELECT request_id FROM im_review_requests").all()).toHaveLength(1);
  });

  it("runs a cancel command exactly once across a platform redelivery", async () => {
    const config = baseConfig();
    const bindings = config.im!.command_bindings as Record<string, { commands: string[] }>;
    bindings.reviewers!.commands = ["cancel"];
    let executed = 0;
    const app = createServerApp({ imCallbacks: routeOptions({
      getConfig: () => config,
      cancellation: { cancel: async () => { executed += 1; return "已取消 1 个任务"; } },
    }) });
    const request = messageRequest("m-cancel", "aicr cancel service 0123456789ab");
    const url = `/callbacks/im/corp-airobot?${request.query.toString()}`;
    const send = () => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: request.body });
    const replyOf = async (response: Response): Promise<string> =>
      (JSON.parse(decrypt((JSON.parse(await response.text()) as { encrypt: string }).encrypt)) as { stream: { content: string } }).stream.content;

    const first = await send();
    expect(first.status).toBe(200);
    expect(await replyOf(first)).toBe("已取消 1 个任务");
    expect(executed).toBe(1);

    // Same delivery retried by the platform: acknowledged with the dedup
    // answer, never a second cancellation.
    const retry = await send();
    expect(retry.status).toBe(200);
    expect(await replyOf(retry)).toContain("请勿重复发送");
    expect(executed).toBe(1);
  });

  it("replies to a command message carrying the group @mention prefix", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const request = messageRequest("m-mention", "@AICR机器人(事件回调) aicr help");
    const response = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
    });
    expect(response.status).toBe(200);
    const envelope = JSON.parse(await response.text()) as { encrypt: string };
    expect(envelope.encrypt).not.toBe("");
    expect(inboxRowsFor("m-mention")).toHaveLength(1);
  });

  it("rejects unsigned requests, unknown connections and disabled callbacks without admin auth", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const unsigned = await app.request(`/callbacks/im/corp-airobot`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(unsigned.status).toBe(401);

    const unknown = await app.request(`/callbacks/im/ghost?${challengeParams().toString()}`, { method: "GET" });
    expect(unknown.status).toBe(404);

    const disabled = await app.request(`/callbacks/im/corp-disabled?${challengeParams().toString()}`, { method: "GET" });
    expect(disabled.status).toBe(503);

    const envConnection = await app.request(`/callbacks/im/corp-env?${challengeParams().toString()}`, { method: "GET" });
    expect(envConnection.status).toBe(401); // env token differs from literal → signature failure, not 500
  });

  it("enforces the body limit while reading", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const request = messageRequest();
    const huge = `${request.body.substring(0, request.body.length - 2)}${"x".repeat(300 * 1024)}}`;
    const response = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: huge,
    });
    expect(response.status).toBe(413);
  });

  it("stops a chunked callback body at the byte limit without reading the tail", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(200 * 1024));
        else if (pulls === 2) controller.enqueue(new Uint8Array(100 * 1024));
        else throw new Error("callback tail must not be read");
      },
    }, { highWaterMark: 0 });
    const request = new Request("http://localhost/callbacks/im/corp-airobot", {
      method: "POST", headers: { "content-type": "application/json" }, body,
      duplex: "half",
    } as RequestInit);
    const response = await app.request(request);
    expect(response.status).toBe(413);
    expect(pulls).toBe(2);
  });

  it("returns 503 when the store fails (no success ACK without persistence)", async () => {
    const broken: ImCallbackRoutesOptions = { ...routeOptions(), store: { ...store, kind: "sqlite", db: undefined as never, sqlite: undefined as never } };
    const app = new Hono();
    registerImCallbackRoutes(app, { ...broken });
    const request = messageRequest();
    const response = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: request.body,
    });
    expect(response.status).toBe(503);
  });

  it("mounts under the server path prefix", async () => {
    const app = createServerApp({ pathPrefix: "/aicr", imCallbacks: routeOptions() });
    const response = await app.request(`/aicr/callbacks/im/corp-airobot?${challengeParams().toString()}`, { method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("777000111222");
  });

  it("builds the aibot encrypted reply envelope for passive responses", () => {
    const reply = buildWecomAibotEncryptedReply({
      credentials: { aibotId: AIBOT_ID, token: TOKEN, encodingAesKey: ENCODING_AES_KEY },
      plaintext: "accepted", timestamp: TIMESTAMP, nonce: NONCE, randomPrefix: PREFIX,
    });
    expect(Object.keys(reply).sort()).toEqual(["encrypt", "msgsignature", "nonce", "timestamp"]);
    expect(reply.encrypt).not.toContain("accepted");
  });

  it("rejects a payload whose aibotid does not match the connection (S03)", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const payload = JSON.stringify({ msgid: "m-2", aibotid: "other-bot", from: { userid: "owent" }, text: { content: "x" } });
    const ciphertext = encrypt(payload, "", randomBytes(16));
    const query = new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE });
    const response = await app.request(`/callbacks/im/corp-airobot?${query.toString()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ encrypt: ciphertext }),
    });
    expect(response.status).toBe(401);
    expect(inboxRowsFor("m-2")).toHaveLength(0);
  });

  it("types stream refresh events with the stream id (msgtype stream, path/100719)", async () => {
    const payload = JSON.stringify({ msgid: "m-3", aibotid: AIBOT_ID, from: { userid: "owent" }, msgtype: "stream", stream: { id: "stream-abc" } });
    const ciphertext = encrypt(payload, "", randomBytes(16));
    const query = new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE });
    const result = verifyWecomAibotCallback({
      method: "POST", query, body: JSON.stringify({ encrypt: ciphertext }),
      credentials: { aibotId: AIBOT_ID, token: TOKEN, encodingAesKey: ENCODING_AES_KEY },
      connection: { identity: { kind: "wecom_aibot", corpId: CORP_ID, platformId: AIBOT_ID, tenantKey: undefined, namespace: "ns" }, name: "corp-airobot" },
      now: 1759000000_000,
    });
    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") return;
    expect(result.event.content).toEqual({ kind: "stream_refresh", streamId: "stream-abc" });
  });

  it("answers a stream refresh callback with an encrypted finished stream", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const payload = JSON.stringify({ msgid: "m-refresh", aibotid: AIBOT_ID, chatid: "chat-9", chattype: "group", from: { userid: "owent" }, msgtype: "stream", stream: { id: "stream-xyz" } });
    const ciphertext = encrypt(payload, "", randomBytes(16));
    const query = new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE });
    const response = await app.request(`/callbacks/im/corp-airobot?${query.toString()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ encrypt: ciphertext }),
    });
    expect(response.status).toBe(200);
    // The passive reply terminates the polled stream with its own id.
    const envelope = JSON.parse(await response.text()) as { encrypt: string; msgsignature: string };
    const raw = decrypt(envelope.encrypt);
    const reply = JSON.parse(raw) as { msgtype: string; stream: { id: string; finish: boolean; content: string } };
    expect(reply.msgtype).toBe("stream");
    expect(reply.stream).toMatchObject({ id: "stream-xyz", finish: true });
  });
});

describe("S09: admin surface around public platform callbacks", () => {
  it("keeps admin-protected routes closed and never accepts admin credentials as callback auth", async () => {
    const app = createServerApp({
      auth: { enabled: true, globalApiKey: "admin-key", workspaceApiKeys: new Map() },
      imCallbacks: routeOptions(),
    });

    // Other admin-protected endpoints stay closed after callback registration.
    const trigger = await app.request("/triggers/p4", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(trigger.status).toBe(401);

    // An admin API key is not a platform credential: the callback still
    // demands its own signature (S09: 管理员会话不是回调凭据).
    const unsigned = await app.request("/callbacks/im/corp-airobot", {
      method: "POST", body: "{}",
      headers: { "content-type": "application/json", "x-api-key": "admin-key", authorization: "Bearer admin-key" },
    });
    expect(unsigned.status).toBe(401);

    // The platform challenge needs no admin session and works without it.
    const challenge = await app.request(`/callbacks/im/corp-airobot?${challengeParams().toString()}`, { method: "GET" });
    expect(challenge.status).toBe(200);
  });

  it("answers the wecom application URL challenge through the route (CorpID receiver)", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const ciphertext = encrypt("9900111222334", CORP_ID, PREFIX);
    const query = new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE, echostr: ciphertext });
    const response = await app.request(`/callbacks/im/corp-app?${query.toString()}`, { method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("9900111222334");
  });
});

describe("S10: ACK deadline and slow-remote isolation", () => {
  it("answers the challenge and review admission within the 1s ACK target without remote work", async () => {
    let directoryCalls = 0;
    let cancellationCalls = 0;
    const app = createServerApp({ imCallbacks: routeOptions({
      directory: { resolve: async () => { directoryCalls += 1; throw new Error("directory must not be called"); } },
      cancellation: { cancel: async () => { cancellationCalls += 1; return "must not be called"; } },
    }) });

    const challengeStart = Date.now();
    const challenge = await app.request(`/callbacks/im/corp-airobot?${challengeParams().toString()}`, { method: "GET" });
    expect(challenge.status).toBe(200);
    expect(Date.now() - challengeStart).toBeLessThan(1000);

    const request = messageRequest("m-s10", "aicr review service 0123456789abcdef0123456789abcdef01234567");
    const messageStart = Date.now();
    const response = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: request.body,
    });
    expect(response.status).toBe(200);
    expect(Date.now() - messageStart).toBeLessThan(1000);

    // The request stays admitted — no VCS validation, LLM analysis, run row
    // or notification ran inside the platform's request path.
    const row = store.sqlite.prepare("SELECT state FROM im_review_requests WHERE request_id IS NOT NULL").get() as { state: string };
    expect(row.state).toBe("accepted");
    expect(countRows("review_runs")).toBe(0);
    expect(countRows("im_reply_outbox")).toBe(0);
    expect(directoryCalls).toBe(0);
    expect(cancellationCalls).toBe(0);
  });
});

describe("S12: unknown types, bot self messages and lifecycle events", () => {
  it("acks unknown aibot payload types without creating any work", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const payload = JSON.stringify({ msgid: "m-unk", aibotid: AIBOT_ID, chatid: "chat-9", chattype: "group", from: { userid: "owent" }, msgtype: "markdown", markdown: { content: "# hello" } });
    const ciphertext = encrypt(payload, "", randomBytes(16));
    const query = new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE });
    const response = await app.request(`/callbacks/im/corp-airobot?${query.toString()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ encrypt: ciphertext }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("success");
    expect(inboxRowsFor("m-unk")).toMatchObject([{ status: "noted" }]);
    expect(countRows("im_review_requests")).toBe(0);
    expect(countRows("im_conversations")).toBe(0);
    expect(countRows("im_reply_outbox")).toBe(0);
  });

  it("acks authenticated wecom app lifecycle events without touching bindings or conversations", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    for (const eventName of ["enter_chat", "subscribe"]) {
      const request = wecomAppRequest(wecomAppInnerXml({
        ToUserName: CORP_ID, FromUserName: "owent", CreateTime: TIMESTAMP,
        MsgType: "event", Event: eventName, AgentID: "1",
      }));
      const response = await app.request(`/callbacks/im/corp-app?${request.query.toString()}`, {
        method: "POST", headers: { "content-type": "text/xml" }, body: request.body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("success");
    }
    // Lifecycle arrivals (发现/退出) never become commands, conversations,
    // bindings or config edits — the receive path only notes them (S12).
    expect(countRows("im_inbox", "WHERE delivery_kind = 'event'")).toBe(2);
    expect(countRows("im_review_requests")).toBe(0);
    expect(countRows("im_conversations")).toBe(0);
    expect(countRows("im_rate_limits")).toBe(0);
  });

  it("acks unknown wecom app message types as noted deliveries", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const request = wecomAppRequest(wecomAppInnerXml({
      ToUserName: CORP_ID, FromUserName: "owent", CreateTime: TIMESTAMP,
      MsgType: "image",
    }));
    const response = await app.request(`/callbacks/im/corp-app?${request.query.toString()}`, {
      method: "POST", headers: { "content-type": "text/xml" }, body: request.body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("success");
    // No MsgId on this payload: the delivery key degrades to the content
    // digest while the message stays a noted, unprocessed delivery.
    expect(countRows("im_inbox", "WHERE delivery_kind = 'message' AND delivery_key LIKE 'sha256:%'")).toBe(1);
    expect(countRows("im_review_requests")).toBe(0);
  });
});

describe("feishu callback routes (S04/S05)", () => {
  it("answers the plaintext and encrypted URL verification challenges", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const plain = feishuCallback(`{ "type": "url_verification", "token": "vtoken", "challenge": "fi-challenge-1" }`);
    const first = await app.request(plain.url, plain.init);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(`{"challenge":"fi-challenge-1"}`);

    // Encrypted challenge: decrypt first, then echo (F5).
    const encrypted = JSON.stringify({ encrypt: encryptFeishuPayload("ekey", JSON.stringify({ type: "url_verification", token: "vtoken", challenge: "fi-challenge-2" })) });
    const second = await app.request(feishuCallback(encrypted).url, feishuCallback(encrypted).init);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(`{"challenge":"fi-challenge-2"}`);
  });

  it("verifies the signature over the exact raw body bytes (S04)", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    // Irregular whitespace and key order: a JSON re-serialization would break
    // the signature, only raw-byte verification accepts it.
    const raw = feishuMessageBody({ messageId: "om-raw-1", text: "看看这个提交就行" });
    const valid = await app.request(feishuCallback(raw).url, feishuCallback(raw).init);
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("");
    expect(inboxRowsFor("om-raw-1")).toMatchObject([{ delivery_kind: "message", status: "noted" }]);

    const tampered = await app.request(feishuCallback(raw, { tamperSignature: true }).url, feishuCallback(raw, { tamperSignature: true }).init);
    expect(tampered.status).toBe(401);
  });

  it("never executes commands from the app's own messages (no review loop)", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const raw = feishuMessageBody({ messageId: "om-self-1", senderType: "app", text: "aicr review service 0123456789abcdef0123456789abcdef01234567" });
    const response = await app.request(feishuCallback(raw).url, feishuCallback(raw).init);
    expect(response.status).toBe(200);
    expect(inboxRowsFor("om-self-1")).toMatchObject([{ status: "noted" }]);
    expect(countRows("im_review_requests")).toBe(0);
    expect(countRows("im_reply_outbox")).toBe(0);
  });

  it("answers an unknown card action without creating work and stays deduplicated (S11)", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const raw = feishuCardActionBody("ima-nonexistent");
    const call = feishuCallback(raw);
    const first = await app.request(call.url, call.init);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("");
    expect(countRows("im_inbox", "WHERE delivery_kind = 'card_action'")).toBe(1);
    expect(countRows("im_review_requests")).toBe(0);

    // Platform redelivery of the same card action: no second consumption.
    const retry = await app.request(call.url, call.init);
    expect(retry.status).toBe(200);
    expect(countRows("im_inbox", "WHERE delivery_kind = 'card_action'")).toBe(1);
  });

  it("surfaces card-callback storage failures as 5xx without claiming success (S11)", async () => {
    const broken: ImCallbackRoutesOptions = { ...routeOptions(), store: { ...store, kind: "sqlite", db: undefined as never, sqlite: undefined as never } };
    const brokenApp = new Hono();
    registerImCallbackRoutes(brokenApp, { ...broken });
    const raw = feishuCardActionBody("ima-any", "om-card-broken");
    const response = await brokenApp.request(feishuCallback(raw).url, feishuCallback(raw).init);
    expect(response.status).toBe(503);

    // A consume-stage storage failure (inbox already durable) must also
    // surface as a platform failure, never as an accepted answer.
    store.sqlite.exec("DROP TABLE im_actions");
    const app = createServerApp({ imCallbacks: routeOptions() });
    const raw2 = feishuCardActionBody("ima-consume-fail", "om-card-fail");
    const response2 = await app.request(feishuCallback(raw2).url, feishuCallback(raw2).init);
    expect(response2.status).toBeGreaterThanOrEqual(500);
    expect(await response2.text()).not.toContain("已受理");
    // The delivery was durable before the failure (card deliveries key on the
    // event id); a retry reconciles by that delivery key instead of executing
    // the action a second time.
    expect(inboxRowsFor("ev-card-om-card-fail")).toMatchObject([{ status: "noted" }]);
    expect(countRows("im_review_requests")).toBe(0);
  });
});

describe("R07–R09: crash and redelivery boundaries (fresh store restart)", () => {
  const REVIEW_TEXT = "aicr review service 0123456789abcdef0123456789abcdef01234567";

  it("recovers a crash between inbox persistence and request creation without ghost requests (R07)", async () => {
    const dbPath = join(dir, "r07.db");
    const seeded = createStoreDb(dbPath);
    const request = messageRequest("m-r07", REVIEW_TEXT);
    const connectionIdentity = JSON.stringify(["ns-routes", "wecom_aibot", "wwtestcorp", "bot-1", null]);
    // Post-crash state: the delivery was persisted, the process died before
    // the command transaction could create the request.
    await acceptImDelivery(seeded, {
      delivery: {
        namespace: "ns-routes", connectionIdentity, deliveryKind: "message", deliveryKey: "m-r07",
        payloadDigest: `json:sha256:${createHash("sha256").update(request.plaintext, "utf8").digest("hex")}`,
      },
      now: new Date(1759000000_000),
    });
    await closeStoreDb(seeded);

    // Restart: fresh store over the same file, fresh app, same snapshot pin.
    const fresh = createStoreDb(dbPath);
    try {
      const app = createServerApp({ imCallbacks: routeOptions({
        store: fresh,
        getConfigGeneration: () => ({ config: baseConfig(), snapshotId: "snap-r07", fileDigest: "digest-r07" }),
      }) });
      const response = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: request.body,
      });
      expect(response.status).toBe(200);
      expect(await streamReplyText(response)).toContain("已收到评审请求");

      // Exactly one request (no ghosts), the pin points at the captured
      // snapshot, and the noted row was promoted in place.
      const rows = fresh.sqlite.prepare("SELECT request_id, state, config_snapshot_id FROM im_review_requests").all() as { request_id: string; state: string; config_snapshot_id: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "accepted", config_snapshot_id: "snap-r07" });
      expect((fresh.sqlite.prepare("SELECT status FROM im_inbox WHERE delivery_key = ?").get("m-r07") as { status: string }).status).toBe("request_created");
      expect(await listImActiveConfigSnapshotIds(fresh, "ns-routes")).toContain("snap-r07");
    } finally {
      await closeStoreDb(fresh);
    }
  });

  it("reconciles a lost ACK through the original request without re-charging quota (R08)", async () => {
    const dbPath = join(dir, "r08.db");
    const first = createStoreDb(dbPath);
    const app = createServerApp({ imCallbacks: routeOptions({ store: first }) });
    const request = messageRequest("m-r08", REVIEW_TEXT);
    const url = `/callbacks/im/corp-airobot?${request.query.toString()}`;
    const send = (instance: ReturnType<typeof createServerApp>) => instance.request(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: request.body,
    });
    const response = await send(app);
    expect(response.status).toBe(200); // committed; the ACK never reached the platform
    const requestId = ((first.sqlite.prepare("SELECT request_id FROM im_review_requests").get()) as { request_id: string }).request_id;
    await closeStoreDb(first);

    // Restart and redeliver: the platform must learn the original request,
    // never a second quota charge, action consumption or enqueue attempt.
    const fresh = createStoreDb(dbPath);
    try {
      const app2 = createServerApp({ imCallbacks: routeOptions({ store: fresh }) });
      const retry = await send(app2);
      expect(retry.status).toBe(200);
      expect(await streamReplyText(retry)).toContain("请勿重复发送");
      expect((fresh.sqlite.prepare("SELECT count(*) AS count FROM im_review_requests").get() as { count: number }).count).toBe(1);
      expect((fresh.sqlite.prepare("SELECT count(*) AS count FROM im_inbox WHERE delivery_key = 'm-r08'").get() as { count: number }).count).toBe(1);
      expect((fresh.sqlite.prepare("SELECT count(*) AS count FROM im_rate_limits").get() as { count: number }).count).toBe(1);
      expect((fresh.sqlite.prepare("SELECT count(*) AS count FROM review_runs").get() as { count: number }).count).toBe(0);

      // The status query still resolves the original request after the restart.
      const config = baseConfig();
      (config.im!.command_bindings as Record<string, { commands: string[] }>).reviewers!.commands = ["review", "status"];
      const app3 = createServerApp({ imCallbacks: routeOptions({ store: fresh, getConfig: () => config }) });
      const status = messageRequest("m-r08-status", `aicr status ${requestId}`);
      const statusResponse = await app3.request(`/callbacks/im/corp-airobot?${status.query.toString()}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: status.body,
      });
      expect(statusResponse.status).toBe(200);
      const statusText = await streamReplyText(statusResponse);
      expect(statusText).toContain(requestId);
      expect(statusText).toContain("已收到请求");
    } finally {
      await closeStoreDb(fresh);
    }
  });

  it("consumes a card action issued and bound by the real output publisher (A09/A11 joint)", async () => {
    // One config where the feishu_app output channel, the im connection and
    // the review binding all agree on app `cli_test` and group `oc-1`.
    const config = baseConfig();
    const im = config.im!;
    (im.connections as Record<string, unknown>)["feishu-app"] = {
      kind: "feishu_app", app_id: "cli_test", app_secret: "s",
      callback: { enabled: true, verification_token: "vtoken", encrypt_key: "ekey" },
    };
    im.command_bindings!.cardHosts = {
      enabled: true, connection: "feishu-app",
      conversations: [{ kind: "group", id: "oc-1" }],
      actors: [{ type: "feishu_open_id", id: "ou-owent" }],
      commands: ["review"],
      repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
    };
    (config.outputs as { channels: unknown[] }).channels = [{
      kind: "feishu_app", name: "fi", app_id: "cli_test", app_secret: "s", receive_id: "oc-1",
    }];

    // 1. The real publisher path issues the opaque action pre-send and binds
    //    the platform-acknowledged message id after the card send.
    const responseOf = (data: unknown) => ({ ok: true, status: 200, statusText: "test",
      json: async () => data, text: async () => JSON.stringify(data) });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("tenant_access_token")) return responseOf({ code: 0, tenant_access_token: "t", expire: 7200 });
      return responseOf({ code: 0, data: { message_id: "om_joint_1" } });
    }));
    try {
      const publisher = createOutputPublisherFromConfig(config, "fi", undefined, "ws-main",
        createReviewEvent({ triggerName: "github-main", provider: "github", workspaceId: "ws-main",
          targetKind: "push", repoRef: "org/service", headSha: "0123456789abcdef0123456789abcdef01234567",
          author: {}, reason: "github:push" }),
        dir, undefined, undefined, undefined, { store, namespace: "ns-routes", currentSnapshotId: () => "snap-fi" });
      expect(await publisher!.publishSummary("Summary", [], {})).toMatchObject({ status: "published", externalId: "om_joint_1" });
    } finally {
      vi.unstubAllGlobals();
    }
    let actionId = "";
    for (let attempt = 0; attempt < 50 && actionId === ""; attempt += 1) {
      const row = store.sqlite.prepare("SELECT action_id, source_message_id FROM im_actions").get() as { action_id: string; source_message_id: string | null } | undefined;
      if (row?.source_message_id === "om_joint_1") actionId = row.action_id;
      else await new Promise(resolve => setImmediate(resolve));
    }
    expect(actionId).toMatch(/^ima-/u);

    // 2. The platform card callback for THAT message consumes the action into
    //    a review request pinned to the current click-time snapshot.
    const app = createServerApp({ imCallbacks: routeOptions({ getConfig: () => config,
      getConfigGeneration: () => ({ config, snapshotId: "snap-click-fi", fileDigest: "f".repeat(64) }) }) });
    const raw = feishuCardActionBody(actionId, "om_joint_1");
    const call = feishuCallback(raw);
    const response = await app.request(call.url, call.init);
    expect(response.status).toBe(200);
    const request = store.sqlite.prepare("SELECT request_id, config_snapshot_id, requested_revision FROM im_review_requests").get() as { request_id: string; config_snapshot_id: string; requested_revision: string };
    expect(request).toMatchObject({ config_snapshot_id: "snap-click-fi", requested_revision: "0123456789abcdef0123456789abcdef01234567" });
    // The retry of the same card click returns the original request (A10).
    const retry = await app.request(call.url, call.init);
    expect(retry.status).toBe(200);
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM im_review_requests").get()).toMatchObject({ count: 1 });
    // A click on a DIFFERENT message (forwarded card) is rejected (A11).
    const forwarded = feishuCallback(feishuCardActionBody(actionId, "om_forwarded"));
    expect((await app.request(forwarded.url, forwarded.init)).status).toBe(200);
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM im_review_requests").get()).toMatchObject({ count: 1 });
  });

  it("consumes a WeCom template-card click issued and bound by the real output publisher (A09/A11 joint)", async () => {
    // One config where the wecom_app output channel, the callback-enabled im
    // connection and the review binding all agree on agent 7.
    const config = baseConfig();
    const im = config.im!;
    (im.connections as Record<string, unknown>)["corp-card"] = {
      kind: "wecom_app", corp_id: CORP_ID, agent_id: 7, app_secret: "s",
      callback: { enabled: true, token: TOKEN, encoding_aes_key: ENCODING_AES_KEY },
    };
    im.command_bindings!.cardHosts = {
      enabled: true, connection: "corp-card",
      conversations: [{ kind: "app_direct" }],
      actors: [{ type: "wecom_userid", id: "owent" }],
      commands: ["review"],
      repositories: { service: { workspace: "ws-main", source_trigger: "github-main", repo_ref: "org/service" } },
    };
    (config.outputs as { channels: unknown[] }).channels = [{
      kind: "wecom_app", name: "wcx", connection: "corp-card",
      target: { kind: "recipients", users: ["owent"] },
    }];

    // 1. The real publisher path sends the markdown report plus one button
    //    card; the send acknowledgement binds the card's TaskId.
    const responseOf = (data: unknown) => ({ ok: true, status: 200, statusText: "test",
      json: async () => data, text: async () => JSON.stringify(data) });
    let cardBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes("gettoken")) return responseOf({ errcode: 0, access_token: "t", expires_in: 7200 });
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      if (body.msgtype === "template_card") cardBody = body;
      return responseOf({ errcode: 0, msgid: "m1" });
    }));
    try {
      const publisher = createOutputPublisherFromConfig(config, "wcx", undefined, "ws-main",
        createReviewEvent({ triggerName: "github-main", provider: "github", workspaceId: "ws-main",
          targetKind: "push", repoRef: "org/service", headSha: "0123456789abcdef0123456789abcdef01234567",
          author: {}, reason: "github:push" }),
        dir, undefined, undefined, undefined, { store, namespace: "ns-routes", currentSnapshotId: () => "snap-wx" });
      expect(await publisher!.publishSummary("Summary", [], {})).toMatchObject({ status: "published" });
    } finally {
      vi.unstubAllGlobals();
    }
    const card = cardBody as { template_card: { task_id: string } } | undefined;
    expect(card).toBeDefined();
    const actionId = card!.template_card.task_id;
    expect(actionId).toMatch(/^ima-/u);

    // 2. The platform card click (MsgType=event, Event=template_card_event)
    //    consumes the action into a review request pinned at click time.
    const app = createServerApp({ imCallbacks: routeOptions({ getConfig: () => config,
      getConfigGeneration: () => ({ config, snapshotId: "snap-click-wx", fileDigest: "e".repeat(64) }) }) });
    const clickFor = (taskId: string): { query: URLSearchParams; body: string } => wecomAppRequest(wecomAppInnerXml({
      ToUserName: CORP_ID, FromUserName: "owent", CreateTime: TIMESTAMP,
      MsgType: "event", Event: "template_card_event", EventKey: actionId, TaskId: taskId,
      CardType: "button_interaction", ResponseCode: "rc-1", AgentID: "7",
    }));
    const send = async (request: { query: URLSearchParams; body: string }): Promise<Response> =>
      app.request(`/callbacks/im/corp-card?${request.query.toString()}`, {
        method: "POST", headers: { "content-type": "text/xml" }, body: request.body,
      });
    const response = await send(clickFor(actionId));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("success");
    const request = store.sqlite.prepare("SELECT request_id, config_snapshot_id FROM im_review_requests").get() as { request_id: string; config_snapshot_id: string };
    expect(request).toMatchObject({ config_snapshot_id: "snap-click-wx" });

    // A repeated click on the same card returns the original request.
    const retry = await send(clickFor(actionId));
    expect(retry.status).toBe(200);
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM im_review_requests").get()).toMatchObject({ count: 1 });

    // A forged TaskId (wrong card identity) is rejected without a new request.
    const forged = await send(clickFor("ima-other-task"));
    expect(forged.status).toBe(200); // acknowledged; the action was not consumed
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM im_review_requests").get()).toMatchObject({ count: 1 });
  });

  it("reports an uncertain commit as a platform failure and reconciles by delivery key (R09)", async () => {
    const dbPath = join(dir, "r09.db");
    const base = createStoreDb(dbPath);
    // Storage timeout AFTER the command transaction committed: the caller
    // observes an error although the write is durable (uncertain commit).
    let transactions = 0;
    const uncertain = {
      kind: "sqlite" as const,
      sqlite: base.sqlite,
      db: new Proxy(base.db, {
        get(target, prop, receiver) {
          if (prop !== "transaction") return Reflect.get(target, prop, receiver);
          const real = Reflect.get(target, prop).bind(target);
          return (callback: unknown) => {
            transactions += 1;
            const result = real(callback);
            if (transactions === 2) throw new Error("storage timeout after commit");
            return result;
          };
        },
      }),
    } as unknown as SqliteStoreDb;
    const app = createServerApp({ imCallbacks: routeOptions({ store: uncertain }) });
    const request = messageRequest("m-r09", REVIEW_TEXT);
    const url = `/callbacks/im/corp-airobot?${request.query.toString()}`;
    const send = (instance: ReturnType<typeof createServerApp>) => instance.request(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: request.body,
    });
    const response = await send(app);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).not.toContain("已收到评审请求");

    // The commit WAS durable — a retry must reconcile to the same delivery
    // key, not create a new request or claim a different outcome.
    try {
      const committed = base.sqlite.prepare("SELECT request_id FROM im_review_requests").all() as { request_id: string }[];
      expect(committed).toHaveLength(1);
      const healthy = createServerApp({ imCallbacks: routeOptions({ store: base }) });
      const retry = await send(healthy);
      expect(retry.status).toBe(200);
      expect(await streamReplyText(retry)).toContain("请勿重复发送");
      expect((base.sqlite.prepare("SELECT count(*) AS count FROM im_review_requests").get() as { count: number }).count).toBe(1);
      expect((base.sqlite.prepare("SELECT count(*) AS count FROM im_rate_limits").get() as { count: number }).count).toBe(1);
    } finally {
      await closeStoreDb(base);
    }
  });
});
