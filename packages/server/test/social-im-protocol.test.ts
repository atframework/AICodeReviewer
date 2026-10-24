import { expect, it } from "vitest";
import { parseImCommand } from "../src/im/command-service.js";
import {
  verifySlackCommand,
  verifyDiscordCommand,
  verifyTelegramCommand,
  parseUniqueJson,
} from "../src/im/protocol-social.js";
import {
  fixture,
  callbackRequest,
  NOW,
  PUBLIC_KEY,
} from "./social-im-fixtures.js";
it("verifies a frozen Slack byte vector and keeps + decoding separate from authentication", () => {
  const raw = Buffer.from(
    "api_app_id=A123&team_id=T123&user_id=U234&channel_id=C123&command=%2Faicr&text=help+%2B+%E4%B8%AD",
  );
  const connection = fixture("slack").connection;
  if (connection.kind !== "slack_app") throw new Error("fixture");
  const headers = new Headers({
    "x-slack-request-timestamp": "1759000000",
    "x-slack-signature":
      "v0=4ec8e665b368b9153009aa12c5a9f62fa04c62c9c4160d8874dffa1d6926e0f7",
  });
  const input = {
    raw,
    headers,
    connection,
    signingSecret: "signing-secret",
    now: NOW,
  };
  expect(verifySlackCommand(input)).toMatchObject({
    kind: "command",
    text: "aicr help + 中",
  });
  expect(
    verifySlackCommand({
      ...input,
      raw: Buffer.from(raw.toString().replace("+", "%20")),
    }).kind,
  ).toBe("rejected");
  expect(verifySlackCommand({ ...input, now: NOW + 300_000 }).kind).toBe(
    "command",
  );
  expect(verifySlackCommand({ ...input, now: NOW + 300_001 }).kind).toBe(
    "rejected",
  );
  expect(
    verifySlackCommand({
      ...input,
      connection: { ...connection, team_id: "T999" },
    }).kind,
  ).toBe("rejected");
});
it("verifies a frozen Ed25519 Discord PING vector and rejects tampering before parsing", () => {
  const connection = fixture("discord").connection;
  if (connection.kind !== "discord_bot") throw new Error("fixture");
  const headers = new Headers({
    "x-signature-timestamp": "1759000000",
    "x-signature-ed25519":
      "75dbc9e1f5be5be448cf0250a260ad97f6b3daa981bb2d087ad8be3332352711f23ab62757d6520fd83737541d7c20f3644a2ee6d0f540e46d7485b568eec801",
  });
  const input = {
    raw: Buffer.from('{"application_id":"123456789012345678","type":1}'),
    connection,
    headers,
    publicKey: PUBLIC_KEY,
    now: NOW,
  };
  expect(verifyDiscordCommand(input)).toEqual({ kind: "ping" });
  expect(
    verifyDiscordCommand({
      ...input,
      raw: Buffer.from(input.raw.toString() + " "),
    }).kind,
  ).toBe("rejected");
  expect(
    verifyDiscordCommand({
      ...input,
      connection: { ...connection, application_id: "123" },
    }).kind,
  ).toBe("rejected");
  expect(verifyDiscordCommand({ ...input, now: NOW - 300_001 }).kind).toBe(
    "rejected",
  );
});
it("rejects duplicate JSON keys at every depth, including escaped spellings", () => {
  for (const raw of [
    '{"type":1,"type":2}',
    '{"member":{"user":{"id":"1","\\u0069d":"2"}}}',
    '{"data":[{"a":1,"a":2}]}',
  ])
    expect(() => parseUniqueJson(raw)).toThrow();
  expect(parseUniqueJson('{"nested":[{"id":1},{"id":2}],"a":"a,b:c"}')).toEqual(
    { nested: [{ id: 1 }, { id: 2 }], a: "a,b:c" },
  );
});
it("preserves Discord snowflakes and authenticated member identity", async () => {
  const request = callbackRequest("discord", "help", 900);
  const connection = fixture("discord").connection;
  if (connection.kind !== "discord_bot") throw new Error("fixture");
  expect(
    verifyDiscordCommand({
      raw: Buffer.from(await request.text()),
      headers: request.headers,
      connection,
      publicKey: PUBLIC_KEY,
      now: NOW,
    }),
  ).toMatchObject({
    kind: "command",
    actor: { type: "discord_user_id", id: "123456789012345681" },
  });
});
it("accepts Telegram directed group commands and ignores anonymous, topics and wrong bots", async () => {
  const request = callbackRequest("telegram", "help");
  const raw = JSON.parse(await request.text());
  const verify = (value: unknown, headers = request.headers) =>
    verifyTelegramCommand({
      raw: Buffer.from(JSON.stringify(value)),
      headers,
      secretToken: "webhook-secret",
      username: "TestBot",
    });
  expect(verify(raw)).toMatchObject({
    kind: "command",
    conversation: { kind: "group", id: "-1001234567890" },
  });
  for (const extra of [
    { sender_chat: { id: 1 } },
    { message_thread_id: 1 },
    { is_topic_message: true },
    { business_connection_id: "x" },
    { from: { id: 2, is_bot: true } },
    { text: "/aicr@OtherBot help" },
  ])
    expect(verify({ ...raw, message: { ...raw.message, ...extra } }).kind).toBe(
      "ignored",
    );
  for (const suffix of ["\nhelp", " help\n"]) {
    const result = verify({ ...raw, message: { ...raw.message, text: `/aicr@TestBot${suffix}` } });
    expect(result).toMatchObject({
      kind: "command",
      text: `aicr ${suffix}`,
    });
    if (result.kind !== "command") throw new Error("fixture");
    expect(parseImCommand(result.text)).toEqual({ kind: "invalid", reason: "multiline" });
  }
  expect(verify({ ...raw, update_id: Number.MAX_SAFE_INTEGER + 1 }).kind).toBe(
    "rejected",
  );
  expect(verify(raw, new Headers()).kind).toBe("rejected");
  expect(
    verifyTelegramCommand({
      raw: new Uint8Array([0xff]),
      headers: request.headers,
      secretToken: "webhook-secret",
      username: "TestBot",
    }).kind,
  ).toBe("rejected");
});
