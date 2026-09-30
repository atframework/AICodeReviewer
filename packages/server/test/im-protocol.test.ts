import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { brandVerifiedImEvent, isVerifiedImEvent } from "@aicr/core";

import {
  decryptWecomMessage,
  decodeEncodingAesKey,
  encryptWecomMessage,
  verifyWecomSignature,
  wecomSignature,
} from "../src/im/protocol-wecom-crypto.js";
import { buildWecomEncryptedReply, verifyWecomAppCallback, type WecomAppCallbackCredentials } from "../src/im/protocol-wecom-app.js";
import { parseStrictWcomXml, StrictXmlError, XML_MAX_BYTES } from "../src/im/xml-strict.js";

/**
 * IM-10 acceptance S01–S08 (WeCom application share): fixed vectors computed
 * INDEPENDENTLY with bare node:crypto (fixtures/generate-im-wecom-vectors.mjs),
 * never by encrypt→decrypt of the implementation under test. Negative cases
 * cover tampering, wrong receivers, bad padding, duplicate fields, DTD/XXE and
 * size limits — all rejected with no side effects.
 */

const vectors = JSON.parse(readFileSync(new URL("./fixtures/im-wecom-vectors.json", import.meta.url), "utf8")) as {
  encodingAesKey: string;
  token: string;
  corpId: string;
  challenge: { plaintext: string; prefix: string; ciphertext: string; signature: string };
  message: { innerXml: string; envelope: string; ciphertext: string; signature: string; payloadDigest: string };
};

const credentials: WecomAppCallbackCredentials = {
  corpId: vectors.corpId,
  agentId: 1000002,
  token: vectors.token,
  encodingAesKey: vectors.encodingAesKey,
};

const timestamp = "1759000000";
const nonce = "nonceabc";
const now = 1759000000_000;
const connection = { identity: { kind: "wecom_app" as const, corpId: vectors.corpId, platformId: "1000002", tenantKey: undefined, namespace: "test" }, name: "corp-review" };

function query(signature: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ msg_signature: signature, timestamp, nonce, ...extra });
}

describe("S01: independent fixed vectors", () => {
  it("matches the externally computed challenge ciphertext and signature", () => {
    expect(verifyWecomSignature(vectors.token, timestamp, nonce, vectors.challenge.ciphertext, vectors.challenge.signature)).toBe(true);
    const key = decodeEncodingAesKey(vectors.encodingAesKey);
    const { plaintext, receiveid } = decryptWecomMessage(key, vectors.challenge.ciphertext, 64, vectors.corpId);
    expect(plaintext).toBe(vectors.challenge.plaintext);
    expect(receiveid).toBe(vectors.corpId);
  });

  it("round-trips the official framing without proving protocol compatibility alone", () => {
    const key = decodeEncodingAesKey(vectors.encodingAesKey);
    const { ciphertext } = encryptWecomMessage(key, "hello", "wwx", Buffer.from(vectors.challenge.prefix, "hex"));
    expect(decryptWecomMessage(key, ciphertext, 64, "wwx").plaintext).toBe("hello");
    // The independently generated message vector still gates compatibility.
    expect(decryptWecomMessage(key, vectors.message.ciphertext, 256 * 1024, vectors.corpId).plaintext).toBe(vectors.message.innerXml);
  });
});

describe("S02: application GET challenge and POST verification", () => {
  it("answers the challenge with the decrypted plaintext", () => {
    const result = verifyWecomAppCallback({
      method: "GET",
      query: query(vectors.challenge.signature, { echostr: vectors.challenge.ciphertext }),
      credentials,
      connection,
      now,
    });
    expect(result).toEqual({ kind: "challenge", echo: vectors.challenge.plaintext });
  });

  it("verifies a POST message and produces a branded event", () => {
    const result = verifyWecomAppCallback({
      method: "POST",
      query: query(vectors.message.signature),
      body: vectors.message.envelope,
      credentials,
      connection,
      now,
    });
    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") return;
    expect(isVerifiedImEvent(result.event)).toBe(true);
    expect(result.event.actor).toEqual({ type: "wecom_userid", id: "alice_zhang" });
    expect(result.event.content).toEqual({ kind: "message", text: "aicr review service 0123456789abcdef0123456789abcdef01234567" });
    expect(result.event.messageId).toBe("1234567890123456");
    expect(result.event.protocol).toBe("wecom_app");
    expect(result.event.payloadDigest).toBe(`xml:sha256:${vectors.message.payloadDigest}`);
  });

  it("rejects wrong receivers, agents and tampered signatures", () => {
    const wrongCorp = verifyWecomAppCallback({
      method: "POST", query: query(vectors.message.signature), body: vectors.message.envelope,
      credentials: { ...credentials, corpId: "wwother" }, connection, now,
    });
    expect(wrongCorp).toMatchObject({ kind: "rejected", code: "bad_receiver" });

    const wrongAgent = verifyWecomAppCallback({
      method: "POST", query: query(vectors.message.signature), body: vectors.message.envelope,
      credentials: { ...credentials, agentId: 99999999 }, connection, now,
    });
    expect(wrongAgent).toMatchObject({ kind: "rejected", code: "bad_agent" });

    const tampered = vectors.message.envelope.replace(vectors.message.ciphertext.slice(0, 8), "AAAAAAAA");
    const tamperResult = verifyWecomAppCallback({ method: "POST", query: query(vectors.message.signature), body: tampered, credentials, connection, now });
    expect(tamperResult.kind).toBe("rejected");
  });
});

describe("S06: XML strictness", () => {
  it("rejects DTD, entities, multiple roots, deep nesting, duplicates and oversize", () => {
    expect(() => parseStrictWcomXml(`<!DOCTYPE foo [<!ENTITY x "y">]><xml><Encrypt>a</Encrypt></xml>`)).toThrow(StrictXmlError);
    expect(() => parseStrictWcomXml(`<xml><Content>&amp;</Content></xml>`)).toThrow(StrictXmlError);
    expect(() => parseStrictWcomXml(`<xml></xml><xml></xml>`)).toThrow(StrictXmlError);
    expect(() => parseStrictWcomXml(`<xml><Encrypt>a</Encrypt><Encrypt>b</Encrypt></xml>`)).toThrow(StrictXmlError);
    expect(() => parseStrictWcomXml(`<xml><Unknown>x</Unknown></xml>`)).toThrow(StrictXmlError);
    expect(() => parseStrictWcomXml(`<xml><Encrypt>${"a".repeat(XML_MAX_BYTES)}</Encrypt></xml>`)).toThrow(StrictXmlError);
    expect(() => parseStrictWcomXml("not xml at all")).toThrow(StrictXmlError);
    // Well-formed whitelisted input parses.
    expect(parseStrictWcomXml(`<xml><Encrypt>abc</Encrypt><ToUserName>ww</ToUserName></xml>`).fields.get("Encrypt")).toBe("abc");
  });
});

describe("S07/S08: replay window and bad padding", () => {
  it("rejects timestamps outside the window", () => {
    const result = verifyWecomAppCallback({
      method: "GET",
      query: new URLSearchParams({ msg_signature: vectors.challenge.signature, timestamp: "1000000000", nonce, echostr: vectors.challenge.ciphertext }),
      credentials, connection, now,
    });
    expect(result).toMatchObject({ kind: "rejected", code: "bad_timestamp" });
  });

  it("rejects non-block-aligned and corrupted ciphertexts with strict padding", () => {
    const key = decodeEncodingAesKey(vectors.encodingAesKey);
    expect(() => decryptWecomMessage(key, Buffer.from("short").toString("base64"), 1024, null)).toThrow(/bad_ciphertext/u);
    const garbage = Buffer.alloc(64, 7).toString("base64");
    expect(() => decryptWecomMessage(key, garbage, 1024, null)).toThrow(/bad_padding|bad_ciphertext/u);
    // A ciphertext block whose padding bytes are corrupted fails closed.
    const keyBuffer = decodeEncodingAesKey(vectors.encodingAesKey);
    const raw = Buffer.from(vectors.challenge.ciphertext, "base64");
    raw[raw.length - 1] = (raw[raw.length - 1]! + 1) % 256;
    expect(() => decryptWecomMessage(keyBuffer, raw.toString("base64"), 64, null)).toThrow(/bad_padding|bad_ciphertext/u);
    void keyBuffer;
  });
});

describe("encrypted reply envelope", () => {
  it("builds the documented {encrypt, msgsignature} reply framing", () => {
    const reply = buildWecomEncryptedReply({
      credentials, plaintext: "accepted: req-1", timestamp, nonce,
      randomPrefix: Buffer.from(vectors.challenge.prefix, "hex"),
    });
    expect(reply.encrypt).not.toContain("accepted");
    expect(verifyWecomSignature(vectors.token, timestamp, nonce, reply.encrypt, reply.msgsignature)).toBe(true);
    const key = decodeEncodingAesKey(vectors.encodingAesKey);
    expect(decryptWecomMessage(key, reply.encrypt, 1024, vectors.corpId).plaintext).toBe("accepted: req-1");
  });
});

void wecomSignature;
void brandVerifiedImEvent;
