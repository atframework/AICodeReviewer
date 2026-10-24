import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  appConfigSchema,
  type AppConfig,
  type ImPrincipal,
  type ImConversation,
} from "@aicr/core";
import { SocialImClient, type SocialImConnection } from "@aicr/outputs";
export const NOW = 1_759_000_000_000;
export const SHA = "0123456789abcdef0123456789abcdef01234567";
const key = createPrivateKey({
  key: Buffer.from("302e020100300506032b657004220420" + "11".repeat(32), "hex"),
  format: "der",
  type: "pkcs8",
});
export const PUBLIC_KEY = createPublicKey(key)
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
export const platforms = ["slack", "discord", "telegram"] as const;
export type Platform = (typeof platforms)[number];
export function fixture(platform: Platform): {
  config: AppConfig;
  connection: SocialImConnection;
  actor: ImPrincipal;
  conversation: ImConversation;
  destination: string;
} {
  const connection: SocialImConnection =
    platform === "slack"
      ? {
          kind: "slack_app",
          app_id: "A123",
          team_id: "T123",
          bot_user_id: "U123",
          token: "test-token",
          callback: { enabled: true, signing_secret: "signing-secret" },
        }
      : platform === "discord"
        ? {
            kind: "discord_bot",
            application_id: "123456789012345678",
            guild_id: "123456789012345679",
            token: "test-token",
            callback: { enabled: true, public_key: PUBLIC_KEY },
          }
        : {
            kind: "telegram_bot",
            bot_id: "123456789",
            token: "123456789:test-token",
            callback: { enabled: true, secret_token: "webhook-secret" },
          };
  const destination =
    platform === "slack"
      ? "C123"
      : platform === "discord"
        ? "123456789012345680"
        : "-1001234567890";
  const actor: ImPrincipal =
    platform === "slack"
      ? { type: "slack_user_id", id: "U234" }
      : platform === "discord"
        ? { type: "discord_user_id", id: "123456789012345681" }
        : { type: "telegram_user_id", id: "234567891" };
  const conversation: ImConversation = {
    kind: platform === "telegram" ? "group" : "channel",
    id: destination,
  };
  const config = appConfigSchema.parse({
    im: {
      connections: { bot: connection },
      command_bindings: {
        reviewers: {
          enabled: true,
          connection: "bot",
          actors: [actor],
          conversations: [conversation],
          commands: ["help", "chat-id", "review", "status"],
          repositories: {
            demo: {
              workspace: "ws",
              source_trigger: "git",
              repo_ref: "org/demo",
            },
          },
        },
      },
    },
    triggers: [{ name: "git", kind: "github" }],
    workspaces: { instances: { ws: {} } },
    outputs: {
      channels: [
        {
          name: "report",
          kind: connection.kind,
          connection: "bot",
          ...(platform === "telegram"
            ? { chat_id: destination }
            : { channel_id: destination }),
        },
      ],
    },
  });
  return { config, connection, actor, conversation, destination };
}
export function apiFixture(
  platform: Platform,
  calls: {
    url: string;
    body: Record<string, unknown>;
    init?: RequestInit;
  }[] = [],
  send?: () => Response,
): typeof fetch {
  const f = fixture(platform);
  return async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ url, body, ...(init ? { init } : {}) });
    const reply = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("auth.test"))
      return reply({
        ok: true,
        team_id: "T123",
        user_id: "U123",
        bot_id: "B123",
      });
    if (url.includes("conversations.info"))
      return reply({
        ok: true,
        channel: {
          id: f.destination,
          context_team_id: "T123",
          is_channel: true,
          is_im: false,
          is_mpim: false,
          is_archived: false,
          is_member: true,
        },
      });
    if (url.includes("applications/@me"))
      return reply({ id: "123456789012345678" });
    if (url.endsWith("getMe"))
      return reply({
        ok: true,
        result: { id: 123456789, is_bot: true, username: "TestBot" },
      });
    if (url.endsWith("getChat"))
      return reply({
        ok: true,
        result: { id: Number(f.destination), type: "supergroup" },
      });
    if (url.endsWith("chat.postMessage"))
      return (
        send?.() ??
        reply({ ok: true, channel: f.destination, ts: "1759000000.123" })
      );
    if (url.endsWith("/messages"))
      return (
        send?.() ??
        reply({ id: "123456789012345689", channel_id: f.destination })
      );
    if (url.endsWith("sendMessage"))
      return (
        send?.() ??
        reply({
          ok: true,
          result: { message_id: 123, chat: { id: Number(f.destination) } },
        })
      );
    return reply({
      id: f.destination,
      guild_id: "123456789012345679",
      type: 0,
    });
  };
}
export async function readyClient(platform: Platform): Promise<SocialImClient> {
  const f = fixture(platform);
  const client = new SocialImClient(f.connection, f.connection.token!, {
    fetch: apiFixture(platform),
    now: () => NOW,
  });
  if (!(await client.refreshReadiness(f.destination)))
    throw new Error("fixture readiness");
  return client;
}
export function callbackRequest(
  platform: Platform,
  command: string,
  delivery = 900,
  actorId?: string,
  slackTriggerId?: string,
): Request {
  let raw: string;
  const headers = new Headers();
  if (platform === "slack") {
    const form = new URLSearchParams({
      api_app_id: "A123",
      team_id: "T123",
      user_id: actorId ?? "U234",
      channel_id: "C123",
      command: "/aicr",
      text: command,
    });
    if (slackTriggerId !== undefined) form.set("trigger_id", slackTriggerId);
    raw = form.toString();
    const ts = String(NOW / 1000);
    headers.set("x-slack-request-timestamp", ts);
    headers.set(
      "x-slack-signature",
      "v0=" +
        createHmac("sha256", "signing-secret")
          .update("v0:" + ts + ":" + raw)
          .digest("hex"),
    );
    headers.set("content-type", "application/x-www-form-urlencoded");
  } else if (platform === "discord") {
    raw = JSON.stringify({
      id: String(delivery),
      application_id: "123456789012345678",
      guild_id: "123456789012345679",
      channel_id: "123456789012345680",
      type: 2,
      member: { user: { id: actorId ?? "123456789012345681" } },
      data: {
        name: "aicr",
        type: 1,
        options: [{ name: "command", type: 3, value: command }],
      },
    });
    const ts = String(NOW / 1000);
    headers.set("x-signature-timestamp", ts);
    headers.set(
      "x-signature-ed25519",
      sign(null, Buffer.from(ts + raw), key).toString("hex"),
    );
  } else {
    raw = JSON.stringify({
      update_id: delivery,
      message: {
        text: "/aicr@TestBot " + command,
        entities: [{ type: "bot_command", offset: 0, length: 13 }],
        from: { id: Number(actorId ?? "234567891"), is_bot: false },
        chat: { id: -1001234567890, type: "supergroup" },
      },
    });
    headers.set("x-telegram-bot-api-secret-token", "webhook-secret");
  }
  return new Request("http://localhost/callbacks/im/bot", {
    method: "POST",
    headers,
    body: raw,
  });
}
