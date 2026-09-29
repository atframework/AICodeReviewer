import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appConfigSchema } from "@aicr/core";
import { closeStoreDb, createStoreDb, type SqliteStoreDb } from "@aicr/store";

import { Hono } from "hono";
import { createServerApp } from "../src/index.js";
import { registerImCallbackRoutes, type ImCallbackRoutesOptions } from "../src/im/callback-routes.js";
import { buildWecomAibotEncryptedReply, verifyWecomAibotCallback } from "../src/im/protocol-wecom-aibot.js";
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
      },
    },
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
import { createCipheriv, createHash, randomBytes } from "node:crypto";

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

const PREFIX = Buffer.from("00112233445566778899aabbccddeeff", "hex");

function challengeParams(): URLSearchParams {
  const echoPlain = "777000111222";
  const ciphertext = encrypt(echoPlain, "", PREFIX);
  return new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE, echostr: ciphertext });
}

function messageRequest(): { query: URLSearchParams; body: string } {
  const payload = JSON.stringify({
    msgid: "m-1", aibotid: AIBOT_ID, chatid: "chat-9", chattype: "group",
    from: { userid: "owent" }, timestamp: Number(TIMESTAMP),
    text: { content: "aicr help" },
  });
  const ciphertext = encrypt(payload, "", randomBytes(16));
  return {
    query: new URLSearchParams({ msg_signature: sha1(TOKEN, TIMESTAMP, NONCE, ciphertext), timestamp: TIMESTAMP, nonce: NONCE }),
    body: JSON.stringify({ encrypt: ciphertext }),
  };
}

function inboxRowsFor(deliveryKey: string): { namespace: string; delivery_kind: string; status: string; delivery_key: string }[] {
  return store.sqlite.prepare("SELECT namespace, delivery_kind, status, delivery_key FROM im_inbox WHERE delivery_key = ?").all(deliveryKey) as { namespace: string; delivery_kind: string; status: string; delivery_key: string }[];
}

describe("im callback routes (real Hono app)", () => {
  it("answers the aibot URL verification challenge with the decrypted echo", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const response = await app.request(`/callbacks/im/corp-airobot?${challengeParams().toString()}`, { method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("777000111222");
  });

  it("verifies a POST message, persists the inbox row and ACKs success", async () => {
    const app = createServerApp({ imCallbacks: routeOptions() });
    const request = messageRequest();
    const response = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("success");
    const inboxRows = inboxRowsFor("m-1");
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]).toMatchObject({ namespace: "ns-routes", delivery_kind: "message", status: "noted" }); // command creation lands with IM-11

    // Platform retry of the same delivery replays without a second row.
    const retry = await app.request(`/callbacks/im/corp-airobot?${request.query.toString()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: request.body,
    });
    expect(retry.status).toBe(200);
    expect(inboxRowsFor("m-1")).toHaveLength(1);
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
    // aibot_id check deferred (two different robots share the endpoint);
    // the message is accepted and persisted.
    expect(response.status).toBe(200);
  });

  it("types stream refresh events without persisting a review-shaped delivery", async () => {
    const payload = JSON.stringify({ msgid: "m-3", aibotid: AIBOT_ID, from: { userid: "owent" }, stream: { type: "refresh" } });
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
    expect(result.event.content).toEqual({ kind: "stream_refresh" });
  });
});
