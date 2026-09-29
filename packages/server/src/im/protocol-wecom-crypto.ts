import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * WeCom callback cryptography (W3/W10, implementation spec §6): SHA-1 over the
 * sorted [token, timestamp, nonce, ciphertext] and AES-256-CBC with the
 * Base64-decoded 43-char EncodingAESKey, 32-byte PKCS#7-style block padding,
 * random 16-byte prefix, 4-byte network-order length and receiveid suffix.
 * Shared by the application (XML) and API-bot (JSON) protocols; the aibot
 * verifies with an EMPTY receiveid, never the CorpID.
 */

const BLOCK = 32;

export class WecomCryptoError extends Error {
  constructor(readonly code: "bad_signature" | "bad_key" | "bad_ciphertext" | "bad_padding" | "bad_receiver" | "oversized") {
    super(`WeCom callback crypto failed: ${code}.`);
    this.name = "WecomCryptoError";
  }
}

export function decodeEncodingAesKey(encodingAesKey: string): Buffer {
  if (!/^[A-Za-z0-9]{43}$/u.test(encodingAesKey)) throw new WecomCryptoError("bad_key");
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new WecomCryptoError("bad_key");
  return key;
}

/** sha1(sort(token, timestamp, nonce, ciphertext)) — official framing, no HMAC substitution. */
export function wecomSignature(token: string, timestamp: string, nonce: string, ciphertext: string): string {
  return createHash("sha1").update([token, timestamp, nonce, ciphertext].sort().join("")).digest("hex");
}

export function verifyWecomSignature(token: string, timestamp: string, nonce: string, ciphertext: string, signature: string): boolean {
  const expected = wecomSignature(token, timestamp, nonce, ciphertext);
  // Constant-time compare.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return diff === 0;
}

export interface WecomEncryptedMessage {
  readonly ciphertext: string;
  readonly randomPrefix: Buffer;
  readonly plaintext: string;
}

export function encryptWecomMessage(key: Buffer, plaintext: string, receiveid: string, randomPrefix?: Uint8Array): WecomEncryptedMessage {
  const prefix = randomPrefix !== undefined ? Buffer.from(randomPrefix) : randomBytes(16);
  const body = Buffer.concat([
    prefix,
    lengthPrefix(Buffer.byteLength(plaintext, "utf8")),
    Buffer.from(plaintext, "utf8"),
    Buffer.from(receiveid, "utf8"),
  ]);
  const padded = pkcs7Pad(body, BLOCK);
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
  return { ciphertext, randomPrefix: prefix, plaintext };
}

export function decryptWecomMessage(key: Buffer, ciphertext: string, maxPlainBytes: number, expectedReceiveid: string | null): { plaintext: string; receiveid: string } {
  let encrypted: Buffer;
  try {
    encrypted = Buffer.from(ciphertext, "base64");
  } catch {
    throw new WecomCryptoError("bad_ciphertext");
  }
  if (encrypted.length === 0 || encrypted.length % BLOCK !== 0) throw new WecomCryptoError("bad_ciphertext");
  let decrypted: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, Buffer.alloc(16));
    decipher.setAutoPadding(false);
    decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new WecomCryptoError("bad_ciphertext");
  }
  const unpadded = pkcs7Unpad(decrypted, BLOCK);
  // random(16) + msg_len(4, network order) + msg + receiveid
  if (unpadded.length < 16 + 4) throw new WecomCryptoError("bad_ciphertext");
  const length = unpadded.readUInt32BE(16);
  if (length > maxPlainBytes) throw new WecomCryptoError("oversized");
  const messageEnd = 16 + 4 + length;
  if (messageEnd > unpadded.length) throw new WecomCryptoError("bad_ciphertext");
  const plaintext = unpadded.subarray(16 + 4, messageEnd).toString("utf8");
  const receiveid = unpadded.subarray(messageEnd).toString("utf8");
  if (expectedReceiveid !== null && receiveid !== expectedReceiveid) throw new WecomCryptoError("bad_receiver");
  return { plaintext, receiveid };
}

function lengthPrefix(byteLength: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(byteLength, 0);
  return buffer;
}

function pkcs7Pad(buffer: Buffer, block: number): Buffer {
  const amount = block - (buffer.length % block);
  return Buffer.concat([buffer, Buffer.alloc(amount, amount)]);
}

function pkcs7Unpad(buffer: Buffer, block: number): Buffer {
  const amount = buffer[buffer.length - 1]!;
  if (amount === 0 || amount > block || amount > buffer.length) throw new WecomCryptoError("bad_padding");
  const padded = buffer.subarray(buffer.length - amount);
  if (!padded.every(byte => byte === amount)) throw new WecomCryptoError("bad_padding");
  return buffer.subarray(0, buffer.length - amount);
}
