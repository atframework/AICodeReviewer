import { createHash } from "node:crypto";

import { brandVerifiedImEvent, type ImConnectionIdentity, type VerifiedImEventData } from "@aicr/core";

import {
  decryptWecomMessage,
  decodeEncodingAesKey,
  encryptWecomMessage,
  verifyWecomSignature,
  wecomSignature,
  type WecomCryptoError,
} from "./protocol-wecom-crypto.js";

/**
 * WeCom API-bot (智能机器人) callback adapter (W7/W8/W10): independent JSON
 * envelope `{encrypt}` verified with the same SHA-1/AES framing but an EMPTY
 * receiveid — never the CorpID, which belongs to the application protocol.
 * The decrypted payload carries msgid/aibotid/chatid/chattype and a typed
 * sender; stream refresh events are typed, never review triggers (S03).
 */

export interface WecomAibotCallbackCredentials {
  readonly aibotId: string;
  readonly token: string;
  readonly encodingAesKey: string;
}

export type WecomAibotVerifyResult =
  | { readonly kind: "challenge"; readonly echo: string }
  | { readonly kind: "verified"; readonly event: ReturnType<typeof brandVerifiedImEvent> }
  | { readonly kind: "rejected"; readonly code: WecomCryptoError["code"] | "missing_fields" | "bad_timestamp" | "bad_bot" | "bad_payload" };

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PLAIN_BYTES = 256 * 1024;
const EMPTY_RECEIVEID = "";

function parseEnvelope(raw: string): { encrypt: string } | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const encrypt = parsed.encrypt;
    return typeof encrypt === "string" && encrypt.length > 0 ? { encrypt } : undefined;
  } catch {
    return undefined;
  }
}

export function verifyWecomAibotCallback(input: {
  readonly method: "GET" | "POST";
  readonly query: URLSearchParams;
  readonly body?: string | undefined;
  readonly credentials: WecomAibotCallbackCredentials;
  readonly connection: { identity: ImConnectionIdentity; name: string };
  readonly now: number;
}): WecomAibotVerifyResult {
  const signature = input.query.get("msg_signature");
  const timestamp = input.query.get("timestamp");
  const nonce = input.query.get("nonce");
  if (signature === null || timestamp === null || nonce === null || !signature || !timestamp || !nonce) {
    return { kind: "rejected", code: "missing_fields" };
  }
  const timestampValue = Number(timestamp);
  if (!Number.isSafeInteger(timestampValue) || Math.abs(input.now - timestampValue * 1000) > SIGNATURE_WINDOW_MS) {
    return { kind: "rejected", code: "bad_timestamp" };
  }
  let key: ReturnType<typeof decodeEncodingAesKey>;
  try {
    key = decodeEncodingAesKey(input.credentials.encodingAesKey);
  } catch (error) {
    return { kind: "rejected", code: (error as WecomCryptoError).code };
  }

  if (input.method === "GET") {
    const echostr = input.query.get("echostr");
    if (echostr === null || echostr.length === 0) return { kind: "rejected", code: "missing_fields" };
    if (!verifyWecomSignature(input.credentials.token, timestamp, nonce, echostr, signature)) {
      return { kind: "rejected", code: "bad_signature" };
    }
    try {
      const { plaintext } = decryptWecomMessage(key, echostr, 64, EMPTY_RECEIVEID);
      return { kind: "challenge", echo: plaintext };
    } catch (error) {
      return { kind: "rejected", code: (error as WecomCryptoError).code };
    }
  }

  if (input.body === undefined) return { kind: "rejected", code: "missing_fields" };
  const envelope = parseEnvelope(input.body);
  if (envelope === undefined) return { kind: "rejected", code: "bad_payload" };
  if (!verifyWecomSignature(input.credentials.token, timestamp, nonce, envelope.encrypt, signature)) {
    return { kind: "rejected", code: "bad_signature" };
  }
  try {
    const { plaintext } = decryptWecomMessage(key, envelope.encrypt, MAX_PLAIN_BYTES, EMPTY_RECEIVEID);
    const payload = JSON.parse(plaintext) as Record<string, unknown>;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { kind: "rejected", code: "bad_payload" };
    }
    const payloadAibotId = typeof payload.aibotid === "string" ? payload.aibotid : undefined;
    if (payloadAibotId !== undefined && input.credentials.aibotId !== "" && payloadAibotId !== input.credentials.aibotId) {
      return { kind: "rejected", code: "bad_bot" };
    }
    return { kind: "verified", event: buildEvent(payload, input.connection, plaintext) };
  } catch (error) {
    if ((error as WecomCryptoError).name === "WecomCryptoError") return { kind: "rejected", code: (error as WecomCryptoError).code };
    return { kind: "rejected", code: "bad_payload" };
  }
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildEvent(payload: Record<string, unknown>, connection: { identity: ImConnectionIdentity; name: string }, plaintext: string): ReturnType<typeof brandVerifiedImEvent> {
  const msgid = string(payload.msgid);
  const chatid = string(payload.chatid);
  const sender = typeof payload.from === "object" && payload.from !== null ? payload.from as Record<string, unknown> : {};
  const senderId = string(sender.userid) ?? string(sender.userid_encrypted) ?? string(sender.user_id);
  const senderType = string(sender.userid_encrypted) !== undefined ? "wecom_encrypted_userid" : "wecom_userid";
  const stream = payload.stream;
  // Stream refresh callback: msgtype "stream" carrying our stream.id
  // (接收消息 path/100719 流式消息刷新). There is no `type` field.
  const streamId = typeof stream === "object" && stream !== null
    ? string((stream as Record<string, unknown>).id)
    : undefined;
  const isStreamRefresh = string(payload.msgtype) === "stream";
  const text = typeof payload.text === "object" && payload.text !== null ? string((payload.text as Record<string, unknown>).content) : undefined;

  const data: VerifiedImEventData = {
    connectionIdentity: connection.identity,
    connectionName: connection.name,
    protocol: "wecom_aibot",
    deliveryKind: "message",
    deliveryKey: msgid ?? `sha256:${digest(plaintext)}`,
    payloadDigest: `json:sha256:${digest(plaintext)}`,
    actor: senderId !== undefined ? { type: senderType, id: senderId } : undefined,
    conversation: chatid !== undefined ? { kind: "group", id: chatid } : { kind: "bot_direct" },
    occurredAt: Number(payload.timestamp ?? 0) * 1000 || 0,
    messageId: msgid,
    eventId: undefined,
    actionId: undefined,
    content: isStreamRefresh
      ? { kind: "stream_refresh", streamId: streamId ?? "" }
      : text !== undefined
        ? { kind: "message", text }
        : { kind: "unknown_type", type: string(payload.msgtype) ?? "unknown" },
  };
  return brandVerifiedImEvent(data);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Encrypted ACK envelope for passive replies ({encrypt, msgsignature, timestamp, nonce}). */
export function buildWecomAibotEncryptedReply(input: {
  readonly credentials: WecomAibotCallbackCredentials;
  readonly plaintext: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly randomPrefix?: Uint8Array | undefined;
}): { readonly encrypt: string; readonly msgsignature: string; readonly timestamp: string; readonly nonce: string } {
  const key = decodeEncodingAesKey(input.credentials.encodingAesKey);
  const { ciphertext } = encryptWecomMessage(key, input.plaintext, EMPTY_RECEIVEID, input.randomPrefix);
  return {
    encrypt: ciphertext,
    msgsignature: wecomSignature(input.credentials.token, input.timestamp, input.nonce, ciphertext),
    timestamp: input.timestamp,
    nonce: input.nonce,
  };
}
