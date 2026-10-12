import {
  imConnectionIdentityKey,
  type ImConnectionConfig,
  type ImConnectionIdentity,
  type ImConversation,
  type ImPrincipal,
} from "@aicr/core";

export function connectionIdentity(
  connection: ImConnectionConfig,
  namespace: string,
): ImConnectionIdentity {
  return {
    namespace,
    kind: connection.kind,
    corpId: "corp_id" in connection ? connection.corp_id : undefined,
    platformId:
      connection.kind === "wecom_app"
        ? String(connection.agent_id)
        : connection.kind === "wecom_aibot"
          ? connection.aibot_id
          : connection.kind === "discord_bot"
            ? connection.application_id
            : connection.kind === "telegram_bot"
              ? connection.bot_id
              : connection.app_id,
    tenantKey:
      connection.kind === "feishu_app"
        ? connection.tenant_key
        : connection.kind === "slack_app"
          ? connection.team_id
          : connection.kind === "discord_bot"
            ? connection.guild_id
            : undefined,
  };
}
export function storedConnectionIdentity(
  connection: ImConnectionConfig,
  namespace: string,
): string {
  const identity = connectionIdentity(connection, namespace);
  if (["slack_app", "discord_bot", "telegram_bot"].includes(connection.kind))
    return imConnectionIdentityKey(identity);
  return JSON.stringify([
    namespace,
    identity.kind,
    identity.corpId ?? null,
    identity.platformId ?? null,
    identity.tenantKey ?? null,
  ]);
}

export interface SocialReplyPayload {
  readonly version: 1;
  readonly connectionName: string;
  readonly connectionIdentity: string;
  readonly bindingId: string;
  readonly conversation: ImConversation;
  readonly actor: ImPrincipal;
  readonly commandKind: "help" | "chat-id" | "review" | "status";
  readonly requestId: string | null;
  readonly text: string;
}
