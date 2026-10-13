import { createHash } from "node:crypto";
import type { AppConfig } from "@aicr/core";
import type { SocialImClient, SocialImConnection } from "@aicr/outputs";
import type { ImCallbackRoutesOptions } from "./callback-routes.js";
import { parseImCommand } from "./command-service.js";
import { processSocialCommand } from "./social-command-service.js";
import { storedConnectionIdentity } from "./social-identity.js";
import {
  type SocialProtocolResult,
  verifySlackCommand,
  verifyDiscordCommand,
  verifyTelegramCommand,
} from "./protocol-social.js";

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const secret = (
  value: Record<string, unknown>,
  field: string,
  env: (name: string) => string | undefined,
): string =>
  typeof value[field] === "string"
    ? (value[field] as string)
    : typeof value[`${field}_env`] === "string"
      ? (env(value[`${field}_env`] as string) ?? "")
      : "";

async function readBody(
  request: Request,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const max = 256 * 1024;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isSafeInteger(declared) && declared > max) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > max) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function handleSocialCallback(
  request: Request,
  name: string,
  config: AppConfig,
  connection: SocialImConnection,
  generation:
    | { readonly snapshotId: string | null; readonly fileDigest: string }
    | undefined,
  options: ImCallbackRoutesOptions,
  deadlineAt = Date.now() + 1000,
): Promise<Response> {
  if (request.method !== "POST")
    return response({ error: "method_not_allowed" }, 405);
  if (connection.enabled === false || connection.callback?.enabled !== true)
    return response({ error: "callback_unavailable" }, 503);
  const abort = new AbortController();
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0)
    return response({ error: "admission_unavailable" }, 503);
  const timer = setTimeout(
    () => abort.abort(new Error("IM admission deadline.")),
    remainingMs,
  );
  const unavailable = new Promise<Response>((resolve) =>
    abort.signal.addEventListener(
      "abort",
      () => resolve(response({ error: "admission_unavailable" }, 503)),
      { once: true },
    ),
  );
  const work = async (): Promise<Response> => {
    const raw = await readBody(request, abort.signal);
    if (!raw) return response({ error: "body_too_large" }, 413);
    abort.signal.throwIfAborted();
    const client: SocialImClient | undefined = options.socialClient?.(
      config,
      name,
    );
    const callback = connection.callback as Record<string, unknown>;
    const now = options.now?.() ?? Date.now();
    const verified =
      connection.kind === "slack_app"
        ? verifySlackCommand({
            raw,
            headers: request.headers,
            connection,
            signingSecret: secret(callback, "signing_secret", options.env),
            now,
          })
        : connection.kind === "discord_bot"
          ? verifyDiscordCommand({
              raw,
              headers: request.headers,
              connection,
              publicKey: String(callback.public_key ?? ""),
              now,
            })
          : verifyTelegramCommand({
              raw,
              headers: request.headers,
              secretToken: secret(callback, "secret_token", options.env),
              username: client?.telegramUsername(),
            });
    if (verified.kind === "rejected")
      return response({ error: "invalid_authentication" }, 401);
    if (verified.kind === "ping") return response({ type: 1 });
    if (verified.kind === "unavailable")
      return response({ error: "destination_not_ready" }, 503);
    if (verified.kind === "ignored") return response({});
    return processVerifiedSocialCommand(
      verified,
      name,
      config,
      connection,
      generation,
      options,
      abort.signal,
      deadlineAt,
    );
  };
  try {
    return await Promise.race([
      work().catch(() => response({ error: "admission_unavailable" }, 503)),
      unavailable,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Shared admission after transport authentication; never expose as an unsigned HTTP route. */
export async function processVerifiedSocialCommand(
  verified: Extract<SocialProtocolResult, { kind: "command" }>,
  name: string,
  config: AppConfig,
  connection: SocialImConnection,
  generation:
    | { readonly snapshotId: string | null; readonly fileDigest: string }
    | undefined,
  options: ImCallbackRoutesOptions,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<Response> {
  const client = options.socialClient?.(config, name);
  const now = options.now?.() ?? Date.now();
  const destination =
    "id" in verified.conversation
      ? verified.conversation.id
      : verified.actor.id;
  if (!client?.isReady(destination))
    return response({ error: "destination_not_ready" }, 503);
  const parsed = parseImCommand(verified.text);
  let text = "Use /aicr help.";
  if (parsed.kind === "command") {
    if (
      parsed.command.kind === "review" &&
      (!generation?.snapshotId || options.reviewReady?.() !== true)
    )
      return response({ error: "review_runtime_not_ready" }, 503);
    const payloadDigest = createHash("sha256")
      .update(
        JSON.stringify([verified.actor, verified.conversation, parsed.command]),
      )
      .digest("hex");
    const result = await processSocialCommand(options.store, {
      config,
      namespace: options.namespace,
      connectionName: name,
      connectionIdentity: storedConnectionIdentity(
        connection,
        options.namespace,
      ),
      deliveryKey: verified.deliveryKey,
      payloadDigest,
      actor: verified.actor,
      conversation: verified.conversation,
      command: parsed.command,
      now: new Date(now),
      configSnapshotId: generation?.snapshotId ?? "file-only",
      configFileDigest: generation?.fileDigest ?? "",
      replyOutbox: connection.kind === "telegram_bot",
      signal: signal,
      deadlineAt,
    });
    text = result.text;
  }
  signal.throwIfAborted();
  return connection.kind === "slack_app"
    ? response({ response_type: "ephemeral", text, mrkdwn: false })
    : connection.kind === "discord_bot"
      ? response({
          type: 4,
          data: {
            content: text,
            flags: 64,
            allowed_mentions: { parse: [], replied_user: false },
          },
        })
      : response({});
}
