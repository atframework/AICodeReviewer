import type { Hono } from "hono";

import type { AppConfig } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { acceptImDelivery, type AcceptImDeliveryOutcome } from "@aicr/store";

import { verifyWecomAibotCallback, type WecomAibotCallbackCredentials } from "./protocol-wecom-aibot.js";
import { verifyWecomAppCallback, type WecomAppCallbackCredentials } from "./protocol-wecom-app.js";
import { verifyFeishuCallback, buildFeishuChallengeResponse } from "./protocol-feishu.js";
import { buildWecomStreamTextReply, processInlineCommand, sendFeishuReply } from "./inline-reply.js";
import { buildWecomAibotEncryptedReply } from "./protocol-wecom-aibot.js";
import { invalidImCommandReply, parseImCommand, processImCommand, stripImMentionPrefix, type ImCancellationServiceLike, type ImCommandDirectoryLike, type ImQueryServiceLike } from "./command-service.js";
import { consumeCardAction } from "./action-service.js";
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
  /** Effective generation captured with its config at callback admission. */
  readonly getConfigGeneration?: () => Promise<{ readonly config: AppConfig; readonly snapshotId: string | null; readonly fileDigest: string }> | { readonly config: AppConfig; readonly snapshotId: string | null; readonly fileDigest: string };
  readonly env: (name: string) => string | undefined;
  /** Directory-fact resolution for scope matchers; absent = fail closed. */
  readonly directory?: ImCommandDirectoryLike | undefined;
  /** Read-only query surface for the status commands; absent = fail closed. */
  readonly query?: ImQueryServiceLike | undefined;
  /** Cancellation surface for `aicr cancel`; absent = fail closed. */
  readonly cancellation?: ImCancellationServiceLike | undefined;
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
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_CALLBACK_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

/** Registers the platform routes directly on the host app (root mounting). */
export function registerImCallbackRoutes(app: Hono, options: ImCallbackRoutesOptions): void {
  const now = options.now ?? (() => Date.now());

  const handler = async (context: { req: { method: "GET" | "POST"; param: (name: string) => string; query: () => URLSearchParams; raw: () => Request } }, response: (body: string, status: number, headers?: Record<string, string>) => Response) => {

    const name = context.req.param("connection");
    const generation = options.getConfigGeneration !== undefined ? await options.getConfigGeneration() : undefined;
    const config = generation?.config ?? await options.getConfig();
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
      let feishuDeliveryDuplicate: boolean;
      try {
        const feishuOutcome = await acceptImDelivery(options.store, feishuDelivery);
        if (feishuOutcome.kind === "conflict") {
          return response(JSON.stringify({ error: "delivery_conflict" }), 409, { "content-type": "application/json" });
        }
        feishuDeliveryDuplicate = feishuOutcome.kind === "duplicate";
      } catch {
        return response(JSON.stringify({ error: "storage_unavailable" }), 503, { "content-type": "application/json" });
      }
      // Inline command reply: Feishu has no synchronous response body, so the
      // reply goes out through the message API after the inbox ACK is durable.
      // help answers without authorization; other commands run the full
      // admission pipeline (scope matchers included).
      // Card action callbacks (IM-15): consume the opaque action id and
      // answer with the bound request outcome.
      if (feishuResult.event.content.kind === "card_action" && feishuResult.event.actor !== undefined && feishuResult.event.conversation !== undefined) {
        const feishuCreds = resolved.credentials as FeishuCallbackCredentials & { appSecret: string };
        const chatId = feishuResult.event.conversation?.kind === "group" ? feishuResult.event.conversation.id : undefined;
        const receiveId = chatId ?? feishuResult.event.actor.id;
        const receiveIdType = chatId !== undefined ? "chat_id" : "open_id";
        const outcome = await consumeCardAction(options.store, {
          actionId: feishuResult.event.content.actionId,
          namespace: options.namespace,
          connectionName: name,
          connectionIdentity: feishuDelivery.delivery.connectionIdentity,
          sourceMessageId: feishuResult.event.messageId,
          configSnapshotId: generation?.snapshotId ?? undefined,
          configFileDigest: generation?.fileDigest,
          config, actor: feishuResult.event.actor, conversation: feishuResult.event.conversation,
          ...(options.directory !== undefined ? { directory: options.directory } : {}),
        });
        const text = outcome.kind === "accepted" || outcome.kind === "duplicate"
          ? `已受理重评请求（${outcome.requestId}）。`
          : outcome.kind === "expired" ? "该操作已过期（24 小时有效）。"
            : outcome.kind === "not_found" ? "未知操作。"
            : outcome.kind === "rejected" ? `操作被拒绝：${outcome.reason}` : "操作不可用。";
        if (receiveId !== "" && feishuCreds.appSecret !== "") {
          void sendFeishuReply(feishuCreds.appId, feishuCreds.appSecret, receiveId, receiveIdType, text);
        }
        return response("", 200, { "content-type": "text/plain; charset=utf-8" });
      }
      const feishuText = feishuResult.event.content.kind === "message" ? feishuResult.event.content.text : undefined;
      const parsed = parseImCommand(stripImMentionPrefix(feishuText ?? ""));
      if (parsed.kind === "command" || parsed.kind === "invalid") {
        const feishuCreds = resolved.credentials as FeishuCallbackCredentials & { appSecret: string };
        const chatId = feishuResult.event.conversation?.kind === "group" ? feishuResult.event.conversation.id : undefined;
        const actorId = feishuResult.event.actor?.id;
        const receiveId = chatId ?? actorId ?? "";
        const receiveIdType = chatId !== undefined ? "chat_id" : "open_id";
        let replyText: string | undefined;
        if (parsed.kind === "invalid") {
          replyText = invalidImCommandReply(parsed.reason);
        } else if (parsed.command.kind === "help") {
          replyText = processInlineCommand(feishuText, "feishu_app", {}, String(Math.floor(now() / 1000)), "0")?.text;
        } else if (feishuResult.event.actor !== undefined && feishuResult.event.conversation !== undefined) {
          const result = await processImCommand({
            store: options.store,
            config,
            namespace: options.namespace,
            connectionName: name,
            connectionIdentity: JSON.stringify([resolved.identity.namespace, resolved.identity.kind, null, resolved.identity.platformId ?? null, resolved.identity.tenantKey ?? null]),
            deliveryKey: feishuResult.event.deliveryKey,
            payloadDigest: feishuResult.event.payloadDigest,
            actor: feishuResult.event.actor,
            conversation: feishuResult.event.conversation,
            command: parsed.command,
            now: new Date(now()),
            configSnapshotId: generation?.snapshotId ?? "file-only",
            configFileDigest: generation?.fileDigest ?? "unknown",
            deliveryDuplicate: feishuDeliveryDuplicate,
            ...(options.directory !== undefined ? { directory: options.directory } : {}),
            ...(options.query !== undefined ? { query: options.query } : {}),
            ...(options.cancellation !== undefined ? { cancellation: options.cancellation } : {}),
          });
          replyText = result.replyText ?? undefined;
        }
        if (replyText !== undefined && receiveId !== "" && feishuCreds.appSecret !== "") {
          console.log(JSON.stringify({ msg: "im_command_reply", connection: name, command: parsed.kind === "invalid" ? "invalid" : parsed.command.kind }));
          void sendFeishuReply(feishuCreds.appId, feishuCreds.appSecret, receiveId, receiveIdType, replyText);
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
    // A redelivered callback must not re-execute write commands (cancel).
    const deliveryDuplicate = outcome.kind === "duplicate";
    // WeCom template-card button click (IM-15): consume the opaque action id
    // against this card's send-side TaskId. Storage failures surface as 5xx
    // so the platform retries — never a fake success answer.
    if (resolved.kind === "wecom_app" && result.event.content.kind === "card_action" && result.event.actor !== undefined && result.event.conversation !== undefined) {
      const cardOutcome = await consumeCardAction(options.store, {
        actionId: result.event.content.actionId,
        namespace: options.namespace,
        connectionName: name,
        connectionIdentity: delivery.delivery.connectionIdentity,
        sourceTaskId: result.event.taskId,
        configSnapshotId: generation?.snapshotId ?? undefined,
        configFileDigest: generation?.fileDigest,
        config, actor: result.event.actor, conversation: result.event.conversation,
        ...(options.directory !== undefined ? { directory: options.directory } : {}),
        now: new Date(now()),
      });
      console.log(JSON.stringify({ msg: "im_card_action", connection: name, actionId: result.event.content.actionId, outcome: cardOutcome.kind }));
      return response("success", 200, { "content-type": "text/plain; charset=utf-8" });
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
    // Inline command reply (aibot callback only): the platform renders the
    // encrypted response body as the bot's answer; persistence stays first.
    // help answers without authorization; other commands run the full
    // admission pipeline (scope matchers included) and answer the outcome.
    if (resolved.kind === "wecom_aibot" && result.event.content.kind === "message") {
      const messageText = result.event.content.text;
      const parsed = parseImCommand(stripImMentionPrefix(messageText));
      const queryTs = query.get("timestamp") ?? String(Math.floor(now() / 1000));
      const queryNonce = query.get("nonce") ?? "0";
      const aibotCreds = resolved.credentials as WecomAibotCallbackCredentials;
      if (parsed.kind === "command") {
        let replyText: string | undefined;
        if (parsed.command.kind === "help") {
          replyText = processInlineCommand(messageText, "wecom_aibot", {
            token: aibotCreds.token, encodingAesKey: aibotCreds.encodingAesKey,
          }, queryTs, queryNonce)?.text;
        } else if (result.event.actor !== undefined && result.event.conversation !== undefined) {
          const outcome = await processImCommand({
            store: options.store,
            config,
            namespace: options.namespace,
            connectionName: name,
            connectionIdentity: JSON.stringify([resolved.identity.namespace, resolved.identity.kind, resolved.identity.corpId ?? null, resolved.identity.platformId ?? null, null]),
            deliveryKey: result.event.deliveryKey,
            payloadDigest: result.event.payloadDigest,
            actor: result.event.actor,
            conversation: result.event.conversation,
            command: parsed.command,
            now: new Date(now()),
            configSnapshotId: generation?.snapshotId ?? "file-only",
            configFileDigest: generation?.fileDigest ?? "unknown",
            deliveryDuplicate,
            ...(options.directory !== undefined ? { directory: options.directory } : {}),
            ...(options.query !== undefined ? { query: options.query } : {}),
            ...(options.cancellation !== undefined ? { cancellation: options.cancellation } : {}),
          });
          replyText = outcome.replyText ?? undefined;
        }
        if (replyText !== undefined) {
          console.log(JSON.stringify({ msg: "im_command_reply", connection: name, command: parsed.command.kind }));
          return response(JSON.stringify(buildWecomStreamTextReply(replyText, aibotCreds, queryTs, queryNonce)), 200, { "content-type": "application/json; charset=utf-8" });
        }
      } else if (parsed.kind === "invalid") {
        return response(JSON.stringify(buildWecomStreamTextReply(invalidImCommandReply(parsed.reason), aibotCreds, queryTs, queryNonce)), 200, { "content-type": "application/json; charset=utf-8" });
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
