import { createHash } from "node:crypto";
import {
  imConversationSchema,
  imPrincipalSchema,
  isSocialImKind,
  type AppConfig,
  type ImCommand,
  type ImCommandBindingConfig,
} from "@aicr/core";
import {
  findImReviewRequest,
  type ImReviewRequestRow,
  type ImNotificationInput,
  type StoreDb,
} from "@aicr/store";
import {
  authorizeImCommand,
  admitImCommand,
  type ImCommandAdmitInput,
  type ImCommandDirectoryLike,
} from "./command-service.js";
import {
  storedConnectionIdentity,
  type SocialReplyPayload,
} from "./social-identity.js";

export async function currentImRequestAuthorized(
  config: AppConfig,
  request: ImReviewRequestRow,
  directory?: ImCommandDirectoryLike,
): Promise<boolean> {
  try {
    const version: unknown = JSON.parse(request.configVersionJson);
    const connectionName =
      typeof version === "object" &&
      version !== null &&
      "connectionName" in version &&
      typeof version.connectionName === "string"
        ? version.connectionName
        : undefined;
    if (!connectionName) return false;
    const connection = config.im?.connections?.[connectionName];
    const binding = config.im?.command_bindings?.[request.bindingId];
    if (
      !connection ||
      storedConnectionIdentity(connection, request.namespace) !==
        request.connectionIdentity ||
      binding?.connection !== connectionName ||
      binding.enabled !== true ||
      config.workspaces.instances[request.workspaceId]?.enabled === false
    )
      return false;
    if (
      isSocialImKind(connection.kind) &&
      connection.callback?.enabled !== true &&
      !(connection.kind === "slack_app" && connection.socket_mode?.enabled === true)
    )
      return false;
    const explicitAlias = Object.entries(binding.repositories ?? {}).find(
      ([, target]) =>
        target.workspace === request.workspaceId &&
        target.source_trigger === request.sourceTrigger &&
        target.repo_ref === request.repoRef,
    )?.[0];
    const alias =
      explicitAlias ??
      (binding.allow_all_repositories === true ? "request" : undefined);
    if (!alias) return false;
    const effectiveBinding = explicitAlias
      ? binding
      : {
          ...binding,
          repositories: {
            ...binding.repositories,
            request: {
              workspace: request.workspaceId,
              source_trigger: request.sourceTrigger,
              repo_ref: request.repoRef,
            },
          },
        };
    const actor = imPrincipalSchema.parse({
      type: request.requestedByType,
      id: request.requestedById,
    });
    const conversation = imConversationSchema.parse(
      JSON.parse(request.conversationJson),
    );
    const matchers = binding.actors.filter(
      (actor) => "kind" in actor && actor.kind !== "any" && actor.kind !== "conversation_users",
    );
    const scopes =
      matchers.length && directory
        ? await directory.resolve({ connectionName, actor, matchers })
        : undefined;
    return (
      authorizeImCommand({
        config: {
          ...config,
          im: {
            ...config.im,
            command_bindings: { [request.bindingId]: effectiveBinding },
          },
        },
        connectionName,
        actor,
        conversation,
        command: {
          kind: "review",
          repoAlias: alias,
          revision: request.requestedRevision,
        },
        actorScopes: scopes,
      }).kind === "authorized"
    );
  } catch {
    return false;
  }
}

function ownsRequest(
  input: Pick<
    ImCommandAdmitInput,
    "connectionIdentity" | "actor" | "conversation"
  >,
  binding: ImCommandBindingConfig,
  request: ImReviewRequestRow,
): boolean {
  return (
    request.connectionIdentity === input.connectionIdentity &&
    request.requestedByType === input.actor.type &&
    request.requestedById === input.actor.id &&
    request.conversationJson === JSON.stringify(input.conversation) &&
    Object.values(binding.repositories ?? {}).some(
      (target) =>
        target.workspace === request.workspaceId &&
        target.source_trigger === request.sourceTrigger &&
        target.repo_ref === request.repoRef,
    )
  );
}

export function socialReplyNotification(
  payload: SocialReplyPayload,
  operationId: string,
  now: Date,
): ImNotificationInput {
  return {
    operationId,
    destinationIdentity: payload.connectionIdentity,
    operationKind: "social_command_reply",
    payloadDigest: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
    payloadJson: JSON.stringify(payload),
    expiry: new Date(now.getTime() + 86_400_000),
    nextAttemptAt: now,
  };
}

/** Shared grammar and admission; the Telegram reply is committed with its inbox/request. */
export async function processSocialCommand(
  store: StoreDb,
  input: ImCommandAdmitInput & { readonly replyOutbox: boolean },
): Promise<{ readonly text: string; readonly requestId: string | null }> {
  const authorized = authorizeImCommand(input);
  if (
    authorized.kind !== "authorized" ||
    !["help", "chat-id", "review", "status"].includes(input.command.kind)
  )
    return { text: "Command not authorized.", requestId: null };
  const bindingId = Object.entries(
    input.config.im?.command_bindings ?? {},
  ).find(([, binding]) => binding === authorized.binding)?.[0];
  if (!bindingId) return { text: "Command not authorized.", requestId: null };
  let text = "";
  let statusId: string | null = null;
  if (input.command.kind === "help")
    text =
      "/aicr help | chat-id | review <alias> <revision> | status <request-id>";
  if (input.command.kind === "chat-id")
    text = `Actor: ${input.actor.type}:${input.actor.id}\nConversation: ${"id" in input.conversation ? input.conversation.id : input.actor.id}`;
  if (input.command.kind === "status") {
    statusId = input.command.requestId;
    const request = await findImReviewRequest(store, input.namespace, statusId);
    text =
      request && ownsRequest(input, authorized.binding, request)
        ? `Request ${request.requestId}: ${request.state}`
        : "Request not found.";
  }
  const notify = input.replyOutbox
    ? (outcome: {
        readonly kind: "created" | "active_merged";
        readonly requestId: string;
      }) => {
        const requestId = outcome.requestId || statusId;
        const returned =
          input.command.kind === "review"
            ? `Request ${requestId}: accepted. Use /aicr status ${requestId}.`
            : text;
        const payload: SocialReplyPayload = {
          version: 1,
          connectionName: input.connectionName,
          connectionIdentity: input.connectionIdentity,
          bindingId,
          actor: input.actor,
          conversation: input.conversation,
          commandKind: input.command.kind as SocialReplyPayload["commandKind"],
          requestId,
          text: returned,
        };
        const key = createHash("sha256")
          .update(
            JSON.stringify([
              input.namespace,
              input.connectionIdentity,
              "message",
              input.deliveryKey,
              0,
            ]),
          )
          .digest("hex");
        return socialReplyNotification(payload, `imn-${key}`, input.now);
      }
    : undefined;
  const outcome = await admitImCommand(store, {
    ...input,
    ...(notify ? { notification: notify } : {}),
  });
  if (outcome.kind === "accepted" || outcome.kind === "active_merged")
    return {
      text:
        input.command.kind === "review"
          ? `Request ${outcome.requestId}: accepted. Use /aicr status ${outcome.requestId}.`
          : text,
      requestId: outcome.requestId || statusId,
    };
  if (outcome.kind === "duplicate")
    return {
      text: outcome.requestId
        ? `Request ${outcome.requestId}: already accepted.`
        : "Command already received.",
      requestId: outcome.requestId,
    };
  return {
    text:
      outcome.kind === "rate_limited"
        ? "Rate limited. Try again later."
        : "Review service unavailable.",
    requestId: null,
  };
}

export function parseSocialReplyPayload(
  value: string,
): SocialReplyPayload | undefined {
  try {
    if (Buffer.byteLength(value) > 16 * 1024) return undefined;
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (
      raw.version !== 1 ||
      !["help", "chat-id", "review", "status"].includes(
        String(raw.commandKind),
      ) ||
      ![
        raw.connectionName,
        raw.connectionIdentity,
        raw.bindingId,
        raw.text,
      ].every((value) => typeof value === "string" && value.length > 0) ||
      (raw.requestId !== null && typeof raw.requestId !== "string") ||
      String(raw.text).length > 3900
    )
      return undefined;
    const actor = imPrincipalSchema.parse(raw.actor);
    const conversation = imConversationSchema.parse(raw.conversation);
    return {
      version: 1,
      connectionName: String(raw.connectionName),
      connectionIdentity: String(raw.connectionIdentity),
      bindingId: String(raw.bindingId),
      actor,
      conversation,
      commandKind: raw.commandKind as SocialReplyPayload["commandKind"],
      requestId: raw.requestId as string | null,
      text: String(raw.text),
    };
  } catch {
    return undefined;
  }
}

export async function socialReplyAuthorized(
  config: AppConfig,
  namespace: string,
  payload: SocialReplyPayload,
  store: StoreDb,
): Promise<boolean> {
  const connection = config.im?.connections?.[payload.connectionName];
  const binding = config.im?.command_bindings?.[payload.bindingId];
  if (
    !connection ||
    (connection.callback?.enabled !== true &&
      !(connection.kind === "slack_app" && connection.socket_mode?.enabled === true)) ||
    storedConnectionIdentity(connection, namespace) !==
      payload.connectionIdentity ||
    !binding ||
    binding.connection !== payload.connectionName ||
    binding.enabled !== true ||
    !binding.commands.includes(payload.commandKind)
  )
    return false;
  let command: ImCommand =
    payload.commandKind === "review"
      ? { kind: "help" }
      : payload.commandKind === "status"
        ? { kind: "status", requestId: payload.requestId ?? "" }
        : { kind: payload.commandKind };
  if (payload.commandKind === "review" && payload.requestId) {
    const request = await findImReviewRequest(
      store,
      namespace,
      payload.requestId,
    );
    if (!request || !(await currentImRequestAuthorized(config, request)))
      return false;
    const alias = Object.entries(binding.repositories ?? {}).find(
      ([, target]) =>
        target.workspace === request.workspaceId &&
        target.source_trigger === request.sourceTrigger &&
        target.repo_ref === request.repoRef,
    )?.[0];
    if (!alias) return false;
    command = {
      kind: "review",
      repoAlias: alias,
      revision: request.requestedRevision,
    };
  }
  if (payload.commandKind === "status" && payload.requestId) {
    const request = await findImReviewRequest(
      store,
      namespace,
      payload.requestId,
    );
    if (request && !ownsRequest(payload, binding, request)) return false;
  }
  return (
    authorizeImCommand({
      config: {
        ...config,
        im: {
          ...config.im,
          command_bindings: { [payload.bindingId]: binding },
        },
      },
      connectionName: payload.connectionName,
      actor: payload.actor,
      conversation: payload.conversation,
      command,
    }).kind === "authorized"
  );
}
