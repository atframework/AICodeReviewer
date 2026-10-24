import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
} from "node:crypto";
import type { ImConversation, ImPrincipal } from "@aicr/core";
import type { SocialImConnection } from "@aicr/outputs";

export type SocialProtocolResult =
  | {
      readonly kind: "command";
      readonly actor: ImPrincipal;
      readonly conversation: ImConversation;
      readonly deliveryKey: string;
      readonly text: string;
    }
  | { readonly kind: "ping" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected" };
const reject: SocialProtocolResult = { kind: "rejected" };
const ignore: SocialProtocolResult = { kind: "ignored" };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const id = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : undefined;
const decimal = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]{0,31}$/u.test(value);
const slackId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z][A-Z0-9]{1,63}$/u.test(value);
const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const utf8 = (raw: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(raw);

/** Reject duplicate keys including escaped spellings, without changing signed bytes. JSON.parse validates syntax. */
export function parseUniqueJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const tokens =
    text.match(
      /"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu,
    ) ?? [];
  const stack: (
    { object: true; keys: Set<string>; key: boolean } | { object: false }
  )[] = [];
  for (const token of tokens) {
    const parent = stack.at(-1);
    if (token === "{") {
      stack.push({ object: true, keys: new Set(), key: true });
      continue;
    }
    if (token === "[") {
      stack.push({ object: false });
      continue;
    }
    if (token === "}" || token === "]") {
      stack.pop();
      continue;
    }
    if (parent?.object === true) {
      if (token === ",") {
        parent.key = true;
        continue;
      }
      if (token === ":") {
        parent.key = false;
        continue;
      }
      if (parent.key && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (parent.keys.has(key)) throw new Error("Duplicate JSON field.");
        parent.keys.add(key);
        parent.key = false;
      }
    }
  }
  return value;
}

export function verifySlackCommand(input: {
  readonly raw: Uint8Array;
  readonly headers: Headers;
  readonly connection: Extract<SocialImConnection, { kind: "slack_app" }>;
  readonly signingSecret: string;
  readonly now: number;
}): SocialProtocolResult {
  try {
    const timestamp = input.headers.get("x-slack-request-timestamp") ?? "";
    const signature = input.headers.get("x-slack-signature") ?? "";
    if (
      !input.signingSecret ||
      !/^\d{10}$/u.test(timestamp) ||
      Math.abs(input.now - Number(timestamp) * 1000) > 300_000 ||
      !/^v0=[a-f0-9]{64}$/u.test(signature)
    )
      return reject;
    const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${timestamp}:`).update(input.raw).digest("hex")}`;
    if (!equal(expected, signature)) return reject;
    const form = utf8(input.raw);
    for (const field of form.split("&"))
      for (const component of field.split("="))
        decodeURIComponent(component.replaceAll("+", " "));
    const params = new URLSearchParams(form);
    for (const field of [
      "api_app_id",
      "team_id",
      "user_id",
      "channel_id",
      "command",
      "text",
    ])
      if (params.getAll(field).length !== 1) return reject;
    if (
      params.get("api_app_id") !== input.connection.app_id ||
      params.get("team_id") !== input.connection.team_id
    )
      return reject;
    if (params.get("command") !== "/aicr") return ignore;
    if (
      params.getAll("trigger_id").length > 1 ||
      (params.has("trigger_id") &&
        !/^[A-Za-z0-9._-]{1,256}$/u.test(params.get("trigger_id")!))
    )
      return reject;
    const user = params.get("user_id");
    const channel = params.get("channel_id");
    if (!slackId(user) || !slackId(channel)) return reject;
    return {
      kind: "command",
      actor: { type: "slack_user_id", id: user },
      conversation: { kind: "channel", id: channel },
      deliveryKey:
        params.getAll("trigger_id").length === 1 && params.get("trigger_id")
          ? createHash("sha256")
              .update("slack-trigger:")
              .update(params.get("trigger_id")!)
              .digest("hex")
          : createHash("sha256")
              .update(timestamp)
              .update(":")
              .update(input.raw)
              .digest("hex"),
      text: `aicr ${params.get("text")}`,
    };
  } catch {
    return reject;
  }
}

/** Only call for envelopes received on the app-authenticated Socket Mode connection. */
export function parseSlackSocketCommand(input: {
  readonly body: unknown;
  readonly envelopeId: string;
  readonly connection: Extract<SocialImConnection, { kind: "slack_app" }>;
}): SocialProtocolResult {
  const body = object(input.body);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(input.envelopeId) ||
    body.team_id !== input.connection.team_id ||
    (body.api_app_id !== undefined &&
      body.api_app_id !== input.connection.app_id) ||
    !slackId(body.user_id) ||
    !slackId(body.channel_id) ||
    typeof body.text !== "string"
  )
    return reject;
  if (body.command !== "/aicr") return ignore;
  if (
    body.trigger_id !== undefined &&
    (typeof body.trigger_id !== "string" ||
      !/^[A-Za-z0-9._-]{1,256}$/u.test(body.trigger_id))
  )
    return reject;
  return {
    kind: "command",
    actor: { type: "slack_user_id", id: body.user_id },
    conversation: { kind: "channel", id: body.channel_id },
    text: `aicr ${body.text}`,
    deliveryKey: createHash("sha256")
      .update(body.trigger_id ? "slack-trigger:" : "slack-envelope:")
      .update(
        typeof body.trigger_id === "string"
          ? body.trigger_id
          : input.envelopeId,
      )
      .digest("hex"),
  };
}

export function verifyDiscordCommand(input: {
  readonly raw: Uint8Array;
  readonly headers: Headers;
  readonly connection: Extract<SocialImConnection, { kind: "discord_bot" }>;
  readonly publicKey: string;
  readonly now: number;
}): SocialProtocolResult {
  try {
    const timestamp = input.headers.get("x-signature-timestamp") ?? "";
    const signature = input.headers.get("x-signature-ed25519") ?? "";
    if (
      !/^[a-fA-F0-9]{64}$/u.test(input.publicKey) ||
      !/^[a-fA-F0-9]{128}$/u.test(signature) ||
      !/^\d{10}$/u.test(timestamp) ||
      Math.abs(input.now - Number(timestamp) * 1000) > 300_000
    )
      return reject;
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(input.publicKey, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    if (
      !verify(
        null,
        Buffer.concat([Buffer.from(timestamp), Buffer.from(input.raw)]),
        key,
        Buffer.from(signature, "hex"),
      )
    )
      return reject;
    const raw = object(parseUniqueJson(utf8(input.raw)));
    if (raw.application_id !== input.connection.application_id) return reject;
    if (raw.type === 1) return { kind: "ping" };
    if (raw.type !== 2) return ignore;
    if (
      raw.guild_id !== input.connection.guild_id ||
      !decimal(raw.id) ||
      !decimal(raw.channel_id)
    )
      return reject;
    const data = object(raw.data);
    if (
      data.name !== "aicr" ||
      data.type !== 1 ||
      !Array.isArray(data.options) ||
      data.options.length !== 1
    )
      return ignore;
    const option = object(data.options[0]);
    const actor = object(object(raw.member).user);
    if (
      !decimal(actor.id) ||
      actor.bot === true ||
      option.name !== "command" ||
      option.type !== 3 ||
      typeof option.value !== "string"
    )
      return reject;
    return {
      kind: "command",
      actor: { type: "discord_user_id", id: actor.id },
      conversation: { kind: "channel", id: raw.channel_id },
      deliveryKey: raw.id,
      text: `aicr ${option.value}`,
    };
  } catch {
    return reject;
  }
}

export function verifyTelegramCommand(input: {
  readonly raw: Uint8Array;
  readonly headers: Headers;
  readonly secretToken: string;
  readonly username: string | undefined;
}): SocialProtocolResult {
  try {
    if (
      !/^[A-Za-z0-9_-]{1,256}$/u.test(input.secretToken) ||
      !equal(
        input.headers.get("x-telegram-bot-api-secret-token") ?? "",
        input.secretToken,
      )
    )
      return reject;
    const raw = object(parseUniqueJson(utf8(input.raw)));
    if (!Number.isSafeInteger(raw.update_id) || Number(raw.update_id) < 0)
      return reject;
    const message = object(raw.message);
    const chat = object(message.chat);
    const actor = object(message.from);
    if (
      typeof message.text !== "string" ||
      !Array.isArray(message.entities) ||
      actor.is_bot !== false ||
      message.sender_chat !== undefined ||
      message.message_thread_id !== undefined ||
      message.is_topic_message === true ||
      message.business_connection_id !== undefined
    )
      return ignore;
    const actorId = id(actor.id);
    const chatId = id(chat.id);
    if (
      !actorId ||
      !chatId ||
      Number(actorId) <= 0 ||
      !["private", "group", "supergroup"].includes(String(chat.type))
    )
      return ignore;
    if (chat.type === "private" && actorId !== chatId) return reject;
    const entity = object(message.entities[0]);
    if (
      entity.type !== "bot_command" ||
      entity.offset !== 0 ||
      !Number.isSafeInteger(entity.length) ||
      Number(entity.length) <= 0 ||
      Number(entity.length) > message.text.length
    )
      return ignore;
    const command = message.text.slice(0, Number(entity.length));
    const rest = message.text.slice(Number(entity.length));
    if (rest !== "" && !/^\s/u.test(rest)) return ignore;
    // Authentication succeeded, but a cold identity cache cannot decide which Bot owns this command.
    if (!input.username && /^\/aicr(?:@[A-Za-z0-9_]+)?$/iu.test(command))
      return { kind: "unavailable" };
    const expected = input.username ? `/aicr@${input.username}` : undefined;
    if (
      chat.type === "private"
        ? command !== "/aicr" &&
          command.toLowerCase() !== expected?.toLowerCase()
        : command.toLowerCase() !== expected?.toLowerCase()
    )
      return ignore;
    return {
      kind: "command",
      actor: { type: "telegram_user_id", id: actorId },
      conversation:
        chat.type === "private"
          ? { kind: "bot_direct" }
          : { kind: "group", id: chatId },
      deliveryKey: String(raw.update_id),
      text: `aicr ${rest}`,
    };
  } catch {
    return reject;
  }
}
