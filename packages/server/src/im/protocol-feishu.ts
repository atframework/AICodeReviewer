import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { brandVerifiedImEvent, type ImConnectionIdentity, type VerifiedImEventData } from "@aicr/core";

/**
 * Feishu event callback protocol (F5/F6): SHA-256 signature over
 * `timestamp + nonce + encrypt_key + raw_body`, AES-256-CBC with
 * key = sha256(encrypt_key), challenge verification, event normalization.
 */

export interface FeishuCallbackCredentials {
  readonly appId: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
}

export type FeishuVerifyResult =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "verified"; readonly event: ReturnType<typeof brandVerifiedImEvent> }
  | { readonly kind: "rejected"; readonly code: "bad_signature" | "bad_timestamp" | "bad_payload" | "bad_token" | "decrypt_failed" | "missing_fields" };

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PLAIN_BYTES = 256 * 1024;

/** sha256(timestamp + nonce + encrypt_key + body) — official framing. */
export function feishuSignature(timestamp: string, nonce: string, encryptKey: string, body: string): string {
  return createHash("sha256").update(timestamp + nonce + encryptKey + body).digest("hex");
}

export function verifyFeishuSignature(timestamp: string, nonce: string, encryptKey: string, body: string, signature: string): boolean {
  const expected = feishuSignature(timestamp, nonce, encryptKey, body);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return diff === 0;
}

function aesKey(encryptKey: string): Buffer {
  return createHash("sha256").update(encryptKey, "utf8").digest();
}

export function decryptFeishuEvent(encryptKey: string, encryptedData: string): { plaintext: string } {
  const key = aesKey(encryptKey);
  const encrypted = Buffer.from(encryptedData, "base64");
  if (encrypted.length === 0 || encrypted.length % 16 !== 0) {
    throw new Error("invalid ciphertext length");
  }
  const iv = encrypted.subarray(0, 16);
  const body = encrypted.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(body), decipher.final()]);
  const plaintext = decrypted.toString("utf8");
  if (Buffer.byteLength(plaintext, "utf8") > MAX_PLAIN_BYTES) {
    throw new Error("decrypted payload exceeds limit");
  }
  return { plaintext };
}

export function verifyFeishuCallback(input: {
  readonly query: URLSearchParams;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly credentials: FeishuCallbackCredentials;
  readonly connection: { identity: ImConnectionIdentity; name: string };
  readonly now: number;
}): FeishuVerifyResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input.body) as Record<string, unknown>;
  } catch {
    return { kind: "rejected", code: "bad_payload" };
  }

  // Step 1: URL verification challenge — no signature required (F5).
  // The body carries {challenge, token, type: "url_verification"}.
  // If encrypted, decrypt first to reach the challenge.
  const encrypt = typeof parsed.encrypt === "string" ? parsed.encrypt : undefined;
  if (encrypt !== undefined) {
    let decrypted: { plaintext: string };
    try {
      decrypted = decryptFeishuEvent(input.credentials.encryptKey, encrypt);
    } catch {
      return { kind: "rejected", code: "decrypt_failed" };
    }
    try {
      parsed = JSON.parse(decrypted.plaintext) as Record<string, unknown>;
    } catch {
      return { kind: "rejected", code: "bad_payload" };
    }
  }

  const challenge = typeof parsed.challenge === "string" ? parsed.challenge : undefined;
  const type = typeof parsed.type === "string" ? parsed.type : undefined;
  if (challenge !== undefined && type === "url_verification") {
    const token = typeof parsed.token === "string" ? parsed.token : undefined;
    if (token !== input.credentials.verificationToken) {
      return { kind: "rejected", code: "bad_token" };
    }
    return { kind: "challenge", challenge };
  }

  // Step 2: Event callback — signature in request HEADERS (not query params).
  // X-Lark-Request-Timestamp, X-Lark-Request-Nonce, X-Lark-Signature
  const timestamp = input.headers["x-lark-request-timestamp"];
  const nonce = input.headers["x-lark-request-nonce"];
  const signature = input.headers["x-lark-signature"];
  if (timestamp === undefined || nonce === undefined || signature === undefined) {
    return { kind: "rejected", code: "missing_fields" };
  }
  const timestampValue = Number(timestamp);
  if (!Number.isSafeInteger(timestampValue) || Math.abs(input.now - timestampValue * 1000) > SIGNATURE_WINDOW_MS) {
    return { kind: "rejected", code: "bad_timestamp" };
  }
  // Signature is computed over the RAW request body bytes
  if (!verifyFeishuSignature(timestamp, nonce, input.credentials.encryptKey, input.body, signature)) {
    return { kind: "rejected", code: "bad_signature" };
  }

  // Verify token in the event
  const token = typeof parsed.token === "string" ? parsed.token : undefined;
  if (token !== undefined && token !== input.credentials.verificationToken) {
    return { kind: "rejected", code: "bad_token" };
  }

  return { kind: "verified", event: buildFeishuEvent(parsed, input.connection) };
}

/** Normalizes a decrypted Feishu event v2 payload ({schema, header, event}) into the verified IM event shape. */
export function buildFeishuEvent(payload: Record<string, unknown>, connection: { identity: ImConnectionIdentity; name: string }): ReturnType<typeof brandVerifiedImEvent> {
  const header = payload.header as Record<string, unknown> | undefined;
  const event = payload.event as Record<string, unknown> | undefined;
  const message = event?.message as Record<string, unknown> | undefined;
  const eventType = typeof header?.event_type === "string" ? header.event_type : "unknown";
  const messageId = typeof message?.message_id === "string" ? message.message_id
    : typeof header?.message_id === "string" ? header.message_id : undefined;
  const eventId = typeof header?.event_id === "string" ? header.event_id : undefined;
  const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const createTime = Number(header?.create_time ?? 0);
  const isCardAction = eventType === "card.action.trigger";
  const operator = event?.operator as Record<string, unknown> | undefined;
  const operatorId = operator?.operator_id as Record<string, unknown> | undefined;
  const context = event?.context as Record<string, unknown> | undefined;
  const cardAction = event?.action as Record<string, unknown> | undefined;
  const cardValue = cardAction?.value;
  const actionId = typeof cardValue === "string" ? cardValue
    : typeof cardValue === "object" && cardValue !== null && typeof (cardValue as Record<string, unknown>).aicr_action_id === "string"
      ? String((cardValue as Record<string, unknown>).aicr_action_id) : "";
  const cardChatId = typeof context?.open_chat_id === "string" ? context.open_chat_id : undefined;
  const cardMessageId = typeof context?.open_message_id === "string" ? context.open_message_id : undefined;
  const cardOperatorId = typeof operatorId?.open_id === "string" ? operatorId.open_id : undefined;

  // im.message.receive_v1
  const sender = event?.sender as Record<string, unknown> | undefined;
  const senderId = sender?.sender_id as Record<string, unknown> | undefined;
  const openId = typeof senderId?.open_id === "string" ? senderId.open_id : undefined;
  const chatId = typeof message?.chat_id === "string" ? message.chat_id : undefined;
  const chatType = typeof message?.chat_type === "string" ? message.chat_type : undefined;
  const contentRaw = typeof message?.content === "string" ? message.content : undefined;
  let text: string | undefined;
  if (contentRaw !== undefined) {
    try {
      const content = JSON.parse(contentRaw) as Record<string, unknown>;
      text = typeof content.text === "string" ? content.text : undefined;
    } catch {
      text = undefined;
    }
  }

  const data: VerifiedImEventData = {
    connectionIdentity: connection.identity,
    connectionName: connection.name,
    protocol: "feishu_app",
    deliveryKind: isCardAction ? "card_action" : eventType.startsWith("im.message") ? "message" : "event",
    deliveryKey: messageId ?? eventId ?? `payload:${payloadHash}`,
    payloadDigest: `feishu:${payloadHash}`,
    actor: (isCardAction ? cardOperatorId : openId) !== undefined ? { type: "feishu_open_id", id: (isCardAction ? cardOperatorId : openId)! } : undefined,
    conversation: isCardAction
      ? (cardChatId !== undefined ? { kind: "group", id: cardChatId } : undefined)
      : chatId !== undefined
      ? (chatType === "p2p" ? { kind: "app_direct" } : { kind: "group", id: chatId })
      : { kind: "app_direct" },
    occurredAt: createTime > 0 ? createTime : Date.now(),
    messageId: isCardAction ? cardMessageId : messageId,
    eventId,
    actionId: isCardAction ? actionId : undefined,
    taskId: undefined,
    content: text !== undefined
      ? { kind: "message", text }
      : isCardAction
        ? { kind: "card_action", actionId }
        : eventType.startsWith("im.message")
          ? { kind: "message", text: "" }
          : { kind: "unknown_type", type: eventType },
  };
  return brandVerifiedImEvent(data);
}

/** Build the challenge response body. */
export function buildFeishuChallengeResponse(challenge: string): string {
  return JSON.stringify({ challenge });
}

/** Encrypt a reply (for optional encrypted responses). */
export function encryptFeishuPayload(encryptKey: string, plaintext: string): string {
  const key = aesKey(encryptKey);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}
