import { createCipheriv, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

// Independent fixed WeCom AES-CBC/SHA-1 vector generator. Keep this separate
// from the protocol implementation so the fixture checks its wire framing.
const key = Buffer.alloc(32, 0x11);
const prefix = Buffer.alloc(16, 0x22);
const encodingAesKey = key.toString("base64").slice(0, -1);
const token = "imTestToken123";
const corpId = "wwtestcorp";
const timestamp = "1759000000";
const nonce = "nonceabc";

function encrypt(plaintext) {
  const message = Buffer.from(plaintext, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const framed = Buffer.concat([prefix, length, message, Buffer.from(corpId, "utf8")]);
  const paddingLength = 32 - (framed.length % 32);
  const padded = Buffer.concat([framed, Buffer.alloc(paddingLength, paddingLength)]);
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function signature(ciphertext) {
  return createHash("sha1").update([token, timestamp, nonce, ciphertext].sort().join("")).digest("hex");
}

const challengePlaintext = "777000111222";
const challengeCiphertext = encrypt(challengePlaintext);
const innerXml = "<xml><ToUserName>wwtestcorp</ToUserName><FromUserName>alice_zhang</FromUserName><CreateTime>1759000000</CreateTime><MsgType>text</MsgType><Content>aicr review service 0123456789abcdef0123456789abcdef01234567</Content><MsgId>1234567890123456</MsgId><AgentID>1000002</AgentID></xml>";
const messageCiphertext = encrypt(innerXml);
const vectors = {
  encodingAesKey,
  token,
  corpId,
  challenge: {
    plaintext: challengePlaintext,
    prefix: prefix.toString("hex"),
    ciphertext: challengeCiphertext,
    signature: signature(challengeCiphertext),
  },
  message: {
    innerXml,
    envelope: `<xml><ToUserName>${corpId}</ToUserName><Encrypt><![CDATA[${messageCiphertext}]]></Encrypt></xml>`,
    ciphertext: messageCiphertext,
    signature: signature(messageCiphertext),
    payloadDigest: createHash("sha256").update(innerXml, "utf8").digest("hex"),
  },
};

writeFileSync(new URL("./im-wecom-vectors.json", import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
