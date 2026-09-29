import type { Hono } from "hono";

import type { AppConfig } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { acceptImDelivery, type AcceptImDeliveryOutcome } from "@aicr/store";

import { verifyWecomAibotCallback, type WecomAibotCallbackCredentials } from "./protocol-wecom-aibot.js";
import { verifyWecomAppCallback, type WecomAppCallbackCredentials } from "./protocol-wecom-app.js";
import { verifyFeishuCallback, buildFeishuChallengeResponse } from "./protocol-feishu.js";
import { processInlineCommand, sendFeishuReply } from "./inline-reply.js";
import { buildWecomAibotEncryptedReply } from "./protocol-wecom-aibot.js";
import type { FeishuCallbackCredentials } from "./protocol-feishu.js";

/**
 * IM callback routes (design §5, IM-12): `GET/POST /callbacks/im/:connection`
 * select protocol credentials from the server-side connection table — never
 * from the unverified payload. Platform authentication only: admin sessions
 * are not required and must not be. The raw request body is read exactly once
 * with a bounded length counter; challenges answer within the platform window;
 * verified deliveries persist to the inbox before the platform ACK. No VCS,
 * LLM or outbound send happens inside the request path.
 */

export interface ImCallbackRoutesOptions {
  readonly store: StoreDb;
  readonly namespace: string;
  /** Resolves the live effective config for the connection table. */
  readonly getConfig: () => Promise<AppConfig> | AppConfig;
  readonly env: (name: string) => string | undefined;
  readonly now?: () => number;
}

const MAX_CALLBACK_BODY_BYTES = 256 * 1024;

interface ResolvedConnection {
  readonly kind: "wecom_app" | "wecom_aibot" | "feishu_app";
  readonly name: string;
  readonly identity: { kind: "wecom_app" | "wecom_aibot" | "feishu_app"; corpId: string | undefined; platformId: string | undefined; tenantKey: string | undefined; namespace: string };
  readonly credentials:
    | (WecomAppCallbackCredentials & { type: "wecom_app" })
    | ({ aibotId: string; token: string; encodingAesKey: string; type: "wecom_aibot" })
    | (FeishuCallbackCredentials & { type: "feishu_app"; appSecret: string });
}

function resolveConnection(config: AppConfig, options: ImCallbackRoutesOptions, name: string): ResolvedConnection | "unknown" | "disabled" | "no-callback" {
  const connection = config.im?.connections?.[name];
  if (connection === undefined) return "unknown";
  if (connection.enabled === false) return "disabled";
  const callback = connection.callback;
  if (callback === undefined || callback.enabled !== true) return "no-callback";

  if (connection.kind === "wecom_app") {
    return {
      kind: "wecom_app",
      name,
      identity: { kind: "wecom_app", corpId: connection.corp_id, platformId: String(connection.agent_id), tenantKey: undefined, namespace: options.namespace },
      credentials: {
        type: "wecom_app",
        corpId: connection.corp_id,
        agentId: connection.agent_id,
        token: resolveSecret(callback, options, "token", "token_env"),
        encodingAesKey: resolveSecret(callback, options, "encoding_aes_key", "encoding_aes_key_env"),
      },
    };
  }
  if (connection.kind === "wecom_aibot") {
    return {
      kind: "wecom_aibot",
      name,
      identity: { kind: "wecom_aibot", corpId: connection.corp_id, platformId: connection.aibot_id, tenantKey: undefined, namespace: options.namespace },
      credentials: {
        type: "wecom_aibot",
        aibotId: connection.aibot_id ?? "",
        token: resolveSecret(callback, options, "token", "token_env"),
        encodingAesKey: resolveSecret(callback, options, "encoding_aes_key", "encoding_aes_key_env"),
      },
    };
  }
  // Feishu application callback
  const feishuConnection = connection as unknown as { app_id?: string; app_secret?: string; app_secret_env?: string; tenant_key?: string; callback?: Record<string, unknown> };
  if (connection.kind === ("feishu_app" as string)) {
    const cb = feishuConnection.callback;
    if (cb === undefined || cb.enabled !== true) return "no-callback";
    const verificationToken = typeof cb.verification_token === "string" ? cb.verification_token
      : typeof cb.verification_token_env === "string" ? (options.env(cb.verification_token_env) ?? "") : "";
    const encryptKey = typeof cb.encrypt_key === "string" ? cb.encrypt_key
      : typeof cb.encrypt_key_env === "string" ? (options.env(cb.encrypt_key_env) ?? "") : "";
    return {
      kind: "feishu_app",
      name,
      identity: { kind: "feishu_app", corpId: undefined, platformId: feishuConnection.app_id, tenantKey: feishuConnection.tenant_key, namespace: options.namespace },
      credentials: {
        type: "feishu_app",
        appId: feishuConnection.app_id ?? "",
        verificationToken,
        encryptKey,
        appSecret: typeof feishuConnection.app_secret === "string" ? feishuConnection.app_secret
          : typeof feishuConnection.app_secret_env === "string" ? (options.env(feishuConnection.app_secret_env) ?? "") : "",
      },
    };
  }
  return "unknown";
}

function resolveSecret(callback: Record<string, unknown>, options: ImCallbackRoutesOptions, literal: string, envRef: string): string {
  const literalValue = callback[literal];
  if (typeof literalValue === "string" && literalValue.length > 0) return literalValue;
  const envName = callback[envRef];
  if (typeof envName === "string" && envName.length > 0) return options.env(envName) ?? "";
  return "";
}

function statusFor(reason: "unknown" | "disabled" | "no-callback"): number {
  return reason === "unknown" ? 404 : 503;
}

async function readBoundedBody(request: Request): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isSafeInteger(declared) && declared > MAX_CALLBACK_BODY_BYTES) return undefined;
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_CALLBACK_BODY_BYTES) return undefined;
  return text;
}

/** Registers the platform routes directly on the host app (root mounting). */
export function registerImCallbackRoutes(app: Hono, options: ImCallbackRoutesOptions): void {
  const now = options.now ?? (() => Date.now());

  const handler = async (context: { req: { method: "GET" | "POST"; param: (name: string) => string; query: () => URLSearchParams; raw: () => Request } }, response: (body: string, status: number, headers?: Record<string, string>) => Response) => {

    const name = context.req.param("connection");
    const config = await options.getConfig();
    const resolved = resolveConnection(config, options, name);
    if (typeof resolved === "string") {
      return response(JSON.stringify({ error: "callback_unavailable" }), statusFor(resolved), { "content-type": "application/json" });
    }
    if (resolved.kind !== "feishu_app" && ((resolved.credentials as { token: string }).token === "" || (resolved.credentials as { encodingAesKey: string }).encodingAesKey === "")) {
      return response(JSON.stringify({ error: "callback_unavailable" }), 503, { "content-type": "application/json" });
    }
    if (resolved.kind === "feishu_app") {
      const fc = resolved.credentials as FeishuCallbackCredentials;
      if (fc.verificationToken === "" || fc.encryptKey === "") {
        return response(JSON.stringify({ error: "callback_unavailable" }), 503, { "content-type": "application/json" });
      }
    }

    const body = context.req.method === "POST" ? await readBoundedBody(context.req.raw()) : undefined;
    if (context.req.method === "POST" && body === undefined) {
      return response(JSON.stringify({ error: "body_too_large" }), 413, { "content-type": "application/json" });
    }

    const identity = { identity: resolved.identity, name: resolved.name };
    const method = context.req.method;
    const query = context.req.query();
    if (resolved.kind === "feishu_app") {
      if (method === "GET") {
        return response(JSON.stringify({ error: "method_not_allowed" }), 405, { "content-type": "application/json" });
      }
      const feishuBody = body ?? "";
      const headers: Record<string, string> = {};
      context.req.raw().headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      const feishuResult = verifyFeishuCallback({
        query, body: feishuBody, headers,
        credentials: resolved.credentials as FeishuCallbackCredentials,
        connection: identity, now: now(),
      });
      if (feishuResult.kind === "challenge") {
        return response(buildFeishuChallengeResponse(feishuResult.challenge), 200, { "content-type": "application/json; charset=utf-8" });
      }
      if (feishuResult.kind === "rejected") {
        console.warn(JSON.stringify({ msg: "im_callback_rejected", connection: name, code: feishuResult.code, method }));
        return response(JSON.stringify({ error: feishuResult.code }), 401, { "content-type": "application/json" });
      }
      // Feishu events: persist and ACK with 200 (empty body = success)
      const feishuDelivery = {
        delivery: {
          namespace: options.namespace,
          connectionIdentity: JSON.stringify([resolved.identity.namespace, resolved.identity.kind, null, resolved.identity.platformId ?? null, resolved.identity.tenantKey ?? null]),
          deliveryKind: feishuResult.event.deliveryKind,
          deliveryKey: feishuResult.event.deliveryKey,
          payloadDigest: feishuResult.event.payloadDigest,
        },
        now: new Date(now()),
      };
      try {
        const feishuOutcome = await acceptImDelivery(options.store, feishuDelivery);
        if (feishuOutcome.kind === "conflict") {
          return response(JSON.stringify({ error: "delivery_conflict" }), 409, { "content-type": "application/json" });
        }
      } catch {
        return response(JSON.stringify({ error: "storage_unavailable" }), 503, { "content-type": "application/json" });
      }
      // Inline command reply: Feishu has no synchronous response body, so the
      // reply goes out through the message API after the inbox ACK is durable.
      const feishuText = feishuResult.event.content.kind === "message" ? feishuResult.event.content.text : undefined;
      const feishuReply = processInlineCommand(feishuText, "feishu_app", {}, String(Math.floor(now() / 1000)), "0");
      if (feishuReply !== undefined) {
        const feishuCreds = resolved.credentials as FeishuCallbackCredentials & { appSecret: string };
        const chatId = feishuResult.event.conversation?.kind === "group" ? feishuResult.event.conversation.id : undefined;
        const actorId = feishuResult.event.actor?.id;
        const receiveId = chatId ?? actorId ?? "";
        const receiveIdType = chatId !== undefined ? "chat_id" : "open_id";
        if (receiveId !== "" && feishuCreds.appSecret !== "") {
          console.log(JSON.stringify({ msg: "im_command_reply", connection: name, format: feishuReply.format }));
          void sendFeishuReply(feishuCreds.appId, feishuCreds.appSecret, receiveId, receiveIdType, feishuReply.text);
        }
      }
      return response("", 200, { "content-type": "text/plain; charset=utf-8" });
    }
    const result = resolved.kind === "wecom_app"
      ? verifyWecomAppCallback({ method, query, body, credentials: resolved.credentials as WecomAppCallbackCredentials, connection: identity, now: now() })
      : verifyWecomAibotCallback({ method, query, body, credentials: resolved.credentials as WecomAibotCallbackCredentials, connection: identity, now: now() });

    if (result.kind === "challenge") {
      // URL verification: plaintext echo inside the platform's 1s window.
      return response(result.echo, 200, { "content-type": "text/plain; charset=utf-8" });
    }
    if (result.kind === "rejected") {
      console.warn(JSON.stringify({ msg: "im_callback_rejected", connection: name, code: result.code, method: context.req.method }));
      return response(JSON.stringify({ error: result.code }), 401, { "content-type": "application/json" });
    }

    // Verified delivery: persist to the inbox before acknowledging.
    const delivery = {
      delivery: {
        namespace: options.namespace,
        connectionIdentity: JSON.stringify([resolved.identity.namespace, resolved.identity.kind, resolved.identity.corpId ?? null, resolved.identity.platformId ?? null, null]),
        deliveryKind: result.event.deliveryKind,
        deliveryKey: result.event.deliveryKey,
        payloadDigest: result.event.payloadDigest,
      },
      now: new Date(now()),
    };
    let outcome: AcceptImDeliveryOutcome;
    try {
      outcome = await acceptImDelivery(options.store, delivery);
    } catch {
      // Storage unavailable: the platform failure protocol (5xx) so the
      // platform retries; never a success ACK without persistence (S11).
      return response(JSON.stringify({ error: "storage_unavailable" }), 503, { "content-type": "application/json" });
    }
    if (outcome.kind === "conflict") {
      return response(JSON.stringify({ error: "delivery_conflict" }), 409, { "content-type": "application/json" });
    }
    // Inline command reply (aibot callback only): the platform renders the
    // encrypted response body as the bot's answer; persistence stays first.
    if (resolved.kind === "wecom_aibot" && result.event.content.kind === "stream_refresh") {
      // Stream refresh poll: we never leave a stream open (command replies
      // finish immediately), so terminate any stray stream id.
      const queryTs = query.get("timestamp") ?? String(Math.floor(now() / 1000));
      const queryNonce = query.get("nonce") ?? "0";
      const aibotCreds = resolved.credentials as WecomAibotCallbackCredentials;
      const termination = buildWecomAibotEncryptedReply({
        credentials: aibotCreds,
        plaintext: JSON.stringify({
          msgtype: "stream",
          stream: { id: result.event.content.streamId, finish: true, content: "" },
        }),
        timestamp: queryTs,
        nonce: queryNonce,
      });
      return response(JSON.stringify(termination), 200, { "content-type": "application/json; charset=utf-8" });
    }
    if (resolved.kind === "wecom_aibot") {
      const messageText = result.event.content.kind === "message" ? result.event.content.text : undefined;
      const queryTs = query.get("timestamp") ?? String(Math.floor(now() / 1000));
      const queryNonce = query.get("nonce") ?? "0";
      const aibotCreds = resolved.credentials as WecomAibotCallbackCredentials;
      const inlineReply = processInlineCommand(messageText, "wecom_aibot", {
        token: aibotCreds.token, encodingAesKey: aibotCreds.encodingAesKey,
      }, queryTs, queryNonce);
      if (inlineReply !== undefined) {
        console.log(JSON.stringify({ msg: "im_command_reply", connection: name, format: inlineReply.format }));
        if (inlineReply.format === "wecom_encrypted" && inlineReply.encrypted !== undefined) {
          return response(JSON.stringify(inlineReply.encrypted), 200, { "content-type": "application/json; charset=utf-8" });
        }
      }
    }
    return response("success", 200, { "content-type": "text/plain; charset=utf-8" });
  };

  app.get("/callbacks/im/:connection", async (c) => {
    const query = new URLSearchParams(c.req.query());
    return handler(
      { req: { method: "GET", param: (name: string) => c.req.param(name) ?? "", query: () => query, raw: () => c.req.raw } },
      (body: string, status: number, headers?: Record<string, string>) => c.body(body ?? "", status as 200, headers),
    );
  });
  app.post("/callbacks/im/:connection", async (c) => {
    const query = new URLSearchParams(c.req.query());
    return handler(
      { req: { method: "POST", param: (name: string) => c.req.param(name) ?? "", query: () => query, raw: () => c.req.raw } },
      (body: string, status: number, headers?: Record<string, string>) => c.body(body ?? "", status as 200, headers),
    );
  });
}
