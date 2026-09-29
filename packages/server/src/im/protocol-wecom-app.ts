import { randomBytes } from "node:crypto";

import { brandVerifiedImEvent, type ImConnectionIdentity, type VerifiedImEventData } from "@aicr/core";

import {
  decryptWecomMessage,
  decodeEncodingAesKey,
  encryptWecomMessage,
  verifyWecomSignature,
  wecomSignature,
  type WecomCryptoError,
} from "./protocol-wecom-crypto.js";
import { parseStrictWcomXml, StrictXmlError } from "./xml-strict.js";

/**
 * WeCom self-built application callback adapter (W3/W4): GET carries the URL
 * challenge (decrypt echostr, echo plaintext), POST carries an XML envelope
 * whose Encrypt field decrypts against the CorpID receiver. Produces branded
 * VerifiedImEvent values only after full verification; no store/VCS/LLM
 * access, and authentication failures leave no side effects.
 */

export interface WecomAppCallbackCredentials {
  readonly corpId: string;
  readonly agentId: number | undefined;
  readonly token: string;
  readonly encodingAesKey: string;
}

const newRandomPrefix = (): Uint8Array => randomBytes(16);

export type WecomAppVerifyResult =
  | { readonly kind: "challenge"; readonly echo: string }
  | { readonly kind: "verified"; readonly event: ReturnType<typeof brandVerifiedImEvent> }
  | { readonly kind: "rejected"; readonly code: WecomCryptoError["code"] | StrictXmlError["code"] | "missing_fields" | "bad_agent" | "bad_timestamp" };

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

interface CallbackQueryFields {
  readonly msg_signature: string;
  readonly timestamp: string;
  readonly nonce: string;
}

function requireFields(query: URLSearchParams): CallbackQueryFields | undefined {
  const signature = query.get("msg_signature");
  const timestamp = query.get("timestamp");
  const nonce = query.get("nonce");
  if (signature === null || timestamp === null || nonce === null || signature.length === 0 || timestamp.length === 0 || nonce.length === 0) {
    return undefined;
  }
  return { msg_signature: signature, timestamp, nonce };
}

export function verifyWecomAppCallback(input: {
  readonly method: "GET" | "POST";
  readonly query: URLSearchParams;
  readonly body?: string | undefined;
  readonly credentials: WecomAppCallbackCredentials;
  readonly connection: { identity: ImConnectionIdentity; name: string };
  readonly now: number;
}): WecomAppVerifyResult {
  const fields = requireFields(input.query);
  if (fields === undefined) return { kind: "rejected", code: "missing_fields" };
  const timestamp = Number(fields.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(input.now - timestamp * 1000) > SIGNATURE_WINDOW_MS) {
    return { kind: "rejected", code: "bad_timestamp" };
  }

  let key: ReturnType<typeof decodeEncodingAesKey> | undefined;
  try {
    key = decodeEncodingAesKey(input.credentials.encodingAesKey);
  } catch {
    return { kind: "rejected", code: "bad_key" };
  }

  if (input.method === "GET") {
    const echostr = input.query.get("echostr");
    if (echostr === null) return { kind: "rejected", code: "missing_fields" };
    if (!verifyWecomSignature(input.credentials.token, fields.timestamp, fields.nonce, echostr, fields.msg_signature)) {
      return { kind: "rejected", code: "bad_signature" };
    }
    try {
      const { plaintext } = decryptWecomMessage(key, echostr, 64, input.credentials.corpId);
      return { kind: "challenge", echo: plaintext };
    } catch (error) {
      return { kind: "rejected", code: (error as WecomCryptoError).code };
    }
  }

  if (input.body === undefined) return { kind: "rejected", code: "missing_fields" };
  let envelope;
  try {
    envelope = parseStrictWcomXml(input.body);
  } catch (error) {
    return { kind: "rejected", code: (error as StrictXmlError).code };
  }
  const encrypt = envelope.fields.get("Encrypt") ?? "";
  const toUserName = envelope.fields.get("ToUserName") ?? "";
  if (encrypt === "" || toUserName === "") return { kind: "rejected", code: "missing_fields" };
  if (toUserName !== input.credentials.corpId) return { kind: "rejected", code: "bad_receiver" };
  if (!verifyWecomSignature(input.credentials.token, fields.timestamp, fields.nonce, encrypt, fields.msg_signature)) {
    return { kind: "rejected", code: "bad_signature" };
  }
  try {
    const { plaintext } = decryptWecomMessage(key, encrypt, XML_MAX_PLAIN_BYTES, input.credentials.corpId);
    const inner = parseStrictWcomXml(plaintext);
    const agentId = inner.fields.get("AgentID");
    if (input.credentials.agentId !== undefined && agentId !== undefined && Number(agentId) !== input.credentials.agentId) {
      return { kind: "rejected", code: "bad_agent" };
    }
    return { kind: "verified", event: buildEvent(inner, input.connection, plaintext) };
  } catch (error) {
    if (error instanceof StrictXmlError) return { kind: "rejected", code: error.code };
    return { kind: "rejected", code: (error as WecomCryptoError).code };
  }
}

const XML_MAX_PLAIN_BYTES = 256 * 1024;

function buildEvent(envelope: { fields: ReadonlyMap<string, string> }, connection: { identity: ImConnectionIdentity; name: string }, plaintext: string): ReturnType<typeof brandVerifiedImEvent> {
  const fields = envelope.fields;
  const msgType = fields.get("MsgType") ?? "";
  const createTime = Number(fields.get("CreateTime") ?? 0);
  const from = fields.get("FromUserName") ?? "";
  const data: VerifiedImEventData = {
    connectionIdentity: connection.identity,
    connectionName: connection.name,
    protocol: "wecom_app",
    deliveryKind: msgType === "event" || msgType === "template_card_event" ? "event" : "message",
    deliveryKey: fields.get("MsgId") ?? digestKey(fields),
    payloadDigest: `xml:${simpleDigest(plaintext)}`,
    actor: from ? { type: "wecom_userid", id: from } : undefined,
    conversation: { kind: "app_direct" },
    occurredAt: createTime * 1000,
    messageId: fields.get("MsgId") ?? undefined,
    eventId: msgType === "event" || msgType === "template_card_event" ? `${fields.get("Event") ?? ""}:${fields.get("EventKey") ?? ""}:${createTime}` : undefined,
    actionId: msgType === "template_card_event" ? fields.get("EventKey") ?? undefined : undefined,
    content: contentFor(fields),
  };
  return brandVerifiedImEvent(data);
}

function contentFor(fields: ReadonlyMap<string, string>): VerifiedImEventData["content"] {
  const msgType = fields.get("MsgType") ?? "";
  if (msgType === "text") return { kind: "message", text: fields.get("Content") ?? "" };
  if (msgType === "template_card_event") {
    const key = fields.get("EventKey") ?? "";
    return { kind: "card_action", actionId: key };
  }
  if (msgType === "event") return { kind: "lifecycle", event: fields.get("Event") ?? "" };
  return { kind: "unknown_type", type: msgType };
}

function digestKey(fields: ReadonlyMap<string, string>): string {
  return simpleDigest(`${fields.get("FromUserName") ?? ""}|${fields.get("CreateTime") ?? ""}|${fields.get("MsgType") ?? ""}|${fields.get("Event") ?? ""}|${fields.get("EventKey") ?? ""}|${fields.get("TaskId") ?? ""}|${fields.get("Content") ?? ""}`);
}

function simpleDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Encrypted ACK envelope for application replies (used by IM-16's outbox). */
export function buildWecomEncryptedReply(input: {
  readonly credentials: WecomAppCallbackCredentials;
  readonly plaintext: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly randomPrefix?: Buffer | undefined;
}): { readonly encrypt: string; readonly msgsignature: string } {
  const key = decodeEncodingAesKey(input.credentials.encodingAesKey);
  const { ciphertext } = encryptWecomMessage(key, input.plaintext, input.credentials.corpId, input.randomPrefix ?? newRandomPrefix());
  return { encrypt: ciphertext, msgsignature: wecomSignature(input.credentials.token, input.timestamp, input.nonce, ciphertext) };
}
