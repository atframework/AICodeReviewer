import type { Hono } from "hono";

import type { AppConfig } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { acceptImDelivery, type AcceptImDeliveryOutcome } from "@aicr/store";

import { verifyWecomAibotCallback, type WecomAibotCallbackCredentials } from "./protocol-wecom-aibot.js";
import { verifyWecomAppCallback, type WecomAppCallbackCredentials } from "./protocol-wecom-app.js";

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
  readonly kind: "wecom_app" | "wecom_aibot";
  readonly name: string;
  readonly identity: { kind: "wecom_app" | "wecom_aibot"; corpId: string | undefined; platformId: string | undefined; tenantKey: undefined; namespace: string };
  readonly credentials:
    | (WecomAppCallbackCredentials & { type: "wecom_app" })
    | ({ aibotId: string; token: string; encodingAesKey: string; type: "wecom_aibot" });
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
    if (resolved.credentials.token === "" || resolved.credentials.encodingAesKey === "") {
      return response(JSON.stringify({ error: "callback_unavailable" }), 503, { "content-type": "application/json" });
    }

    const body = context.req.method === "POST" ? await readBoundedBody(context.req.raw()) : undefined;
    if (context.req.method === "POST" && body === undefined) {
      return response(JSON.stringify({ error: "body_too_large" }), 413, { "content-type": "application/json" });
    }

    const identity = { identity: resolved.identity, name: resolved.name };
    const method = context.req.method;
    const query = context.req.query();
    const result = resolved.kind === "wecom_app"
      ? verifyWecomAppCallback({ method, query, body, credentials: resolved.credentials as WecomAppCallbackCredentials, connection: identity, now: now() })
      : verifyWecomAibotCallback({ method, query, body, credentials: resolved.credentials as WecomAibotCallbackCredentials, connection: identity, now: now() });

    if (result.kind === "challenge") {
      // URL verification: plaintext echo inside the platform's 1s window.
      return response(result.echo, 200, { "content-type": "text/plain; charset=utf-8" });
    }
    if (result.kind === "rejected") {
      // Debug: log the exact rejection reason (temporarily verbose)
      console.warn(JSON.stringify({ msg: "im_callback_rejected", connection: name, code: result.code, method: context.req.method }));
      return response(JSON.stringify({ error: result.code }), 401, { "content-type": "application/json" });
    }

    // Verified delivery: persist to the inbox before acknowledging. This is
    // the only side effect inside the request path; command handling runs in
    // background workers (IM-11/14).
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
