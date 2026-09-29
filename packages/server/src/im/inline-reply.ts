import { randomUUID } from "node:crypto";

import { IM_HELP_TEXT, parseImCommand, stripImMentionPrefix } from "./command-service.js";
import { buildWecomAibotEncryptedReply } from "./protocol-wecom-aibot.js";

/**
 * Inline command processing and reply generation for IM callback routes.
 * When a message like "aicr help" arrives via HTTP callback, this module
 * parses the command, generates a response, and returns it in the protocol-
 * correct format for the originating platform.
 */

export interface InlineReplyResult {
  readonly kind: "reply";
  readonly text: string;
  readonly format: "wecom_encrypted" | "feishu_plain" | "plain";
  readonly encrypted?: { readonly encrypt: string; readonly msgsignature: string; readonly timestamp: string; readonly nonce: string };
}

/**
 * Parses the message text, and if it contains an `aicr` command, generates
 * an inline reply. Returns undefined for non-command messages.
 */
export function processInlineCommand(
  text: string | undefined,
  platform: "wecom_aibot" | "feishu_app",
  credentials: { token?: string; encodingAesKey?: string; aibotId?: string; appId?: string; appSecret?: string },
  timestamp: string,
  nonce: string,
): InlineReplyResult | undefined {
  if (text === undefined) return undefined;
  const parse = parseImCommand(stripImMentionPrefix(text));
  if (parse.kind !== "command") return undefined;

  // Strip the @mention prefix if present (group messages include it)
  let replyText: string;
  switch (parse.command.kind) {
    case "help":
      replyText = IM_HELP_TEXT;
      break;
    case "chat-id":
      replyText = "chat-id 命令需要配置命令绑定后才能返回会话标识。";
      break;
    case "review":
      replyText = `已收到评审请求（仓库: ${parse.command.repoAlias}，修订: ${parse.command.revision.slice(0, 12)}...）。需要配置命令绑定后才能执行。`;
      break;
    case "status":
      replyText = `status 命令需要配置命令绑定后才能查询。`;
      break;
    default:
      return undefined;
  }

  if (platform === "wecom_aibot" && credentials.token && credentials.encodingAesKey) {
    // Passive replies must be stream messages (or template cards); a
    // finished stream with the full content renders immediately and stops
    // platform polling (被动回复消息 path/101031).
    const encrypted = buildWecomAibotEncryptedReply({
      credentials: { aibotId: credentials.aibotId ?? "", token: credentials.token, encodingAesKey: credentials.encodingAesKey },
      plaintext: JSON.stringify({
        msgtype: "stream",
        stream: { id: `aicr-${randomUUID()}`, finish: true, content: replyText },
      }),
      timestamp,
      nonce,
    });
    return {
      kind: "reply",
      text: replyText,
      format: "wecom_encrypted",
      encrypted,
    };
  }

  // Feishu and others: plain text reply
  return { kind: "reply", text: replyText, format: platform === "feishu_app" ? "feishu_plain" : "plain" };
}

/**
 * Sends a reply message to a Feishu chat via the Feishu API.
 * Returns true on success.
 */
export async function sendFeishuReply(
  appId: string,
  appSecret: string,
  receiveId: string,
  receiveIdType: string,
  text: string,
): Promise<boolean> {
  try {
    // Get tenant_access_token
    const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const tokenData = await tokenRes.json() as { code?: number; tenant_access_token?: string };
    if (tokenData.code !== 0 || tokenData.tenant_access_token === undefined) return false;

    // Send message
    const msgRes = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenData.tenant_access_token}`,
        },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      },
    );
    const msgData = await msgRes.json() as { code?: number };
    return msgData.code === 0;
  } catch {
    return false;
  }
}
