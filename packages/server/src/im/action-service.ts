import { randomUUID } from "node:crypto";

import type { AppConfig, ImBindingActor, ImConversation, ImPrincipal } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { acceptImDelivery, getImAction, insertImAction } from "@aicr/store";
import { currentPublicationActionId } from "@aicr/outputs";

import { authorizeImCommand, type ImCommandDirectoryLike } from "./command-service.js";

/**
 * Card actions (IM-15, A09–A13): outbound cards carry an opaque action id
 * bound to a pre-registered trusted target; a platform card callback consumes
 * the action atomically and creates the review request. Buttons never carry
 * commands or URLs — only the opaque id. Consumption is exactly-once: a
 * replayed callback returns the original request id, expired cards answer
 * expired, and unverified sources never bind pending actions.
 */

const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface CardActionTarget {
  readonly namespace: string;
  readonly connectionIdentity: string;
  readonly connectionName: string;
  readonly bindingId: string;
  readonly workspaceId: string;
  readonly sourceTrigger: string;
  readonly repoRef: string;
  readonly revision: string;
  readonly configVersion: string;
  readonly conversationJson: string;
  readonly recipientId: string | null;
}

/** Issues one opaque action id bound to a trusted target (pre-send). */
export async function issueCardAction(store: StoreDb, target: CardActionTarget, now = new Date()): Promise<string> {
  const savedId = currentPublicationActionId();
  if (savedId !== undefined) {
    const saved = await getImAction(store, savedId);
    if (saved === undefined || saved.namespace !== target.namespace || saved.connectionIdentity !== target.connectionIdentity
      || saved.bindingId !== target.bindingId || saved.workspaceId !== target.workspaceId || saved.sourceTrigger !== target.sourceTrigger
      || saved.repoRef !== target.repoRef || saved.revision !== target.revision || saved.issuedConfigVersion !== target.configVersion
      || saved.conversationJson !== target.conversationJson || saved.recipientId !== target.recipientId) {
      throw new Error("IM card action recovery target is unavailable or changed");
    }
    return savedId;
  }
  const actionId = `ima-${randomUUID()}`;
  await insertImAction(store, {
    actionId,
    namespace: target.namespace,
    connectionIdentity: target.connectionIdentity,
    issuedConfigVersion: target.configVersion,
    sourceMessageId: null,
    sourceTaskId: null,
    conversationJson: target.conversationJson,
    recipientId: target.recipientId,
    bindingId: target.bindingId,
    workspaceId: target.workspaceId,
    sourceTrigger: target.sourceTrigger,
    repoRef: target.repoRef,
    revision: target.revision,
    expiresAt: new Date(now.getTime() + ACTION_TTL_MS),
    status: "issued",
    createdAt: now,
    updatedAt: now,
  });
  return actionId;
}

/**
 * Resolves the issuance target for a wecom_app report card button (IM-15):
 * the channel's connection must have callbacks enabled (only callback-
 * configured apps may send callback cards, W15), the target must be explicit
 * recipients (appchat has no template_card, W14), and a `review`-command
 * binding on the connection must register the reviewed repository. WeCom app
 * messages are direct conversations; click authorization rides the binding's
 * actor matchers.
 */
export function resolveWecomCardActionTarget(input: {
  readonly config: AppConfig;
  readonly connectionName: string;
  readonly connection: { readonly corp_id: string; readonly agent_id: number; readonly enabled?: boolean | undefined; readonly callback?: { readonly enabled?: boolean | undefined } | undefined };
  readonly reviewEvent: { readonly headSha?: string | undefined; readonly workspaceId: string; readonly triggerName?: string | undefined; readonly repoRef?: string | undefined };
  readonly namespace: string;
  readonly configSnapshotId: string;
}): CardActionTarget | undefined {
  const { config, connection, reviewEvent } = input;
  if (reviewEvent.headSha === undefined || connection.enabled === false || connection.callback?.enabled !== true) return undefined;
  for (const [bindingId, binding] of Object.entries(config.im?.command_bindings ?? {})) {
    if (binding.connection !== input.connectionName || binding.enabled !== true || !binding.commands.includes("review")) continue;
    if (!binding.conversations.some(allowed => allowed.kind === "app_direct")) continue;
    const registered = Object.entries(binding.repositories ?? {}).find(([, target]) =>
      reviewEvent.triggerName !== undefined && target.workspace === reviewEvent.workspaceId
      && target.source_trigger === reviewEvent.triggerName && target.repo_ref === reviewEvent.repoRef);
    if (registered === undefined) continue;
    return {
      namespace: input.namespace,
      connectionIdentity: JSON.stringify([input.namespace, "wecom_app", connection.corp_id, String(connection.agent_id), null]),
      connectionName: input.connectionName,
      bindingId,
      workspaceId: registered[1].workspace,
      sourceTrigger: registered[1].source_trigger,
      repoRef: registered[1].repo_ref,
      revision: reviewEvent.headSha,
      configVersion: input.configSnapshotId,
      conversationJson: JSON.stringify({ kind: "app_direct" }),
      recipientId: null,
    };
  }
  return undefined;
}

/**
 * Resolves the issuance target for a feishu_app report card (IM-15 A09):
 * the channel's app must be a feishu_app IM connection with callbacks
 * enabled, a `review`-command binding must whitelist the destination group,
 * and that binding must register the reviewed repository. Absent any of
 * these the card carries no button — an unsupported surface never shows a
 * clickable but dead operation (A13).
 */
export function resolveFeishuCardActionTarget(input: {
  readonly config: AppConfig;
  readonly channel: { readonly app_id?: string | undefined; readonly receive_id?: string | undefined; readonly receive_id_type?: string | undefined };
  readonly reviewEvent: { readonly headSha?: string | undefined; readonly workspaceId: string; readonly triggerName?: string | undefined; readonly repoRef?: string | undefined };
  readonly namespace: string;
  /** Run-pinned generation snapshot id; "file-only" when no snapshot exists. */
  readonly configSnapshotId: string;
}): CardActionTarget | undefined {
  const { config, channel, reviewEvent } = input;
  if (reviewEvent.headSha === undefined || channel.receive_id === undefined || channel.app_id === undefined) return undefined;
  // Card action callbacks only carry a chat context; a direct (open_id)
  // destination has no callback surface, so its cards stay button-free.
  if ((channel.receive_id_type ?? "chat_id") !== "chat_id") return undefined;
  const im = config.im;
  if (im === undefined) return undefined;
  for (const [connectionName, connection] of Object.entries(im.connections ?? {})) {
    if (connection.enabled === false || connection.kind !== "feishu_app" || connection.app_id !== channel.app_id) continue;
    const callback = (connection as { callback?: { enabled?: boolean } }).callback;
    if (callback?.enabled !== true) continue;
    for (const [bindingId, binding] of Object.entries(im.command_bindings ?? {})) {
      if (binding.connection !== connectionName || binding.enabled !== true || !binding.commands.includes("review")) continue;
      if (!binding.conversations.some(allowed => allowed.kind === "group" && allowed.id === channel.receive_id)) continue;
      const registered = Object.entries(binding.repositories ?? {}).find(([, target]) =>
        reviewEvent.triggerName !== undefined && target.workspace === reviewEvent.workspaceId
        && target.source_trigger === reviewEvent.triggerName && target.repo_ref === reviewEvent.repoRef);
      if (registered === undefined) continue;
      const [, target] = registered;
      return {
        namespace: input.namespace,
        connectionIdentity: JSON.stringify([input.namespace, "feishu_app", null, channel.app_id, connection.tenant_key ?? null]),
        connectionName,
        bindingId,
        workspaceId: target.workspace,
        sourceTrigger: target.source_trigger,
        repoRef: target.repo_ref,
        revision: reviewEvent.headSha,
        configVersion: input.configSnapshotId,
        conversationJson: JSON.stringify({ kind: "group", id: channel.receive_id }),
        recipientId: null,
      };
    }
  }
  return undefined;
}

export type CardActionResult =
  | { readonly kind: "accepted"; readonly requestId: string }
  | { readonly kind: "duplicate"; readonly requestId: string }
  | { readonly kind: "expired" }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_issued" }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Consumes one card action and creates the bound review request. The
 * action's saved target — never callback-provided data — defines the review;
 * the operator identity comes from the authenticated callback only.
 */
export async function consumeCardAction(store: StoreDb, input: {
  readonly actionId: string;
  readonly namespace: string;
  readonly connectionName: string;
  readonly connectionIdentity: string;
  readonly sourceMessageId?: string | undefined;
  /** WeCom template-card TaskId; required to consume a task-bound action. */
  readonly sourceTaskId?: string | undefined;
  readonly config: AppConfig;
  /** Admission generation at the click; issuance version is audit/GC only. */
  readonly configSnapshotId?: string | undefined;
  readonly configFileDigest?: string | undefined;
  readonly actor: ImPrincipal;
  readonly conversation: ImConversation;
  readonly directory?: ImCommandDirectoryLike | undefined;
  readonly now?: Date;
}): Promise<CardActionResult> {
  const now = input.now ?? new Date();
  const action = await getImAction(store, input.actionId);
  if (action === undefined) return { kind: "not_found" };
  if (action.namespace !== input.namespace || action.connectionIdentity !== input.connectionIdentity) return { kind: "rejected", reason: "source_mismatch" };
  // A13: an action whose send acknowledgement never became durable (lost
  // response or failed bind) stays pending and never executes — a callback's
  // self-reported source must not complete the binding either. Feishu cards
  // bind the platform message id; WeCom cards bind the send-side TaskId.
  if (action.sourceMessageId === null && action.sourceTaskId === null) return { kind: "rejected", reason: "unbound" };
  if (action.sourceMessageId !== null && action.sourceMessageId !== input.sourceMessageId) return { kind: "rejected", reason: "source_mismatch" };
  if (action.sourceTaskId !== null && action.sourceTaskId !== input.sourceTaskId) return { kind: "rejected", reason: "source_mismatch" };
  if (action.recipientId !== null && action.recipientId !== input.actor.id) return { kind: "rejected", reason: "recipient_mismatch" };
  try {
    const savedConversation = JSON.parse(action.conversationJson ?? "null") as ImConversation | null;
    if (savedConversation === null || JSON.stringify(savedConversation) !== JSON.stringify(input.conversation)) {
      return { kind: "rejected", reason: "conversation_mismatch" };
    }
  } catch {
    return { kind: "rejected", reason: "conversation_mismatch" };
  }
  const binding = input.config.im?.command_bindings?.[action.bindingId];
  if (binding === undefined || binding.enabled !== true || binding.connection !== input.connectionName || !binding.commands.includes("review")) {
    return { kind: "rejected", reason: "binding_revoked" };
  }
  const alias = Object.entries(binding.repositories ?? {}).find(([, target]) =>
    target.workspace === action.workspaceId && target.source_trigger === action.sourceTrigger && target.repo_ref === action.repoRef)?.[0];
  if (alias === undefined) return { kind: "rejected", reason: "repository_revoked" };
  const matchers = binding.actors.filter((actor): actor is ImBindingActor => "kind" in actor && actor.kind !== "any");
  const scopes = matchers.length > 0 ? await input.directory?.resolve({ connectionName: input.connectionName, actor: input.actor, matchers }) : undefined;
  const authorization = authorizeImCommand({
    config: { ...input.config, im: { ...input.config.im, command_bindings: { [action.bindingId]: binding } } },
    connectionName: input.connectionName,
    actor: input.actor,
    conversation: input.conversation,
    command: { kind: "review", repoAlias: alias, revision: action.revision },
    actorScopes: scopes,
    now,
  });
  if (authorization.kind !== "authorized") return { kind: "rejected", reason: "unauthorized" };
  if (action.status === "consumed" && action.consumedRequestId !== null) {
    return { kind: "duplicate", requestId: action.consumedRequestId };
  }
  if (action.expiresAt.getTime() <= now.getTime()) return { kind: "expired" };
  if (!input.configSnapshotId || input.configSnapshotId === "file-only" || !input.configFileDigest) {
    return { kind: "rejected", reason: "execution_unavailable" };
  }
  const requestId = `imr-${randomUUID()}`;
  const runId = `imrun-${randomUUID()}`;
  // The request and action transition share acceptImDelivery's transaction.
  const outcome = await acceptImDelivery(store, {
    delivery: {
      namespace: action.namespace,
      connectionIdentity: action.connectionIdentity,
      deliveryKind: "card_action",
      deliveryKey: `action:${input.actionId}`,
      payloadDigest: `action:${action.repoRef}:${action.revision}`,
    },
    command: {
      request: {
        requestId,
        runId,
        bindingId: action.bindingId,
        requestedBy: input.actor,
        conversation: JSON.stringify(input.conversation),
        workspaceId: action.workspaceId,
        sourceTrigger: action.sourceTrigger,
        repoRef: action.repoRef,
        requestedRevision: action.revision,
        configSnapshotId: input.configSnapshotId,
        configFileDigest: input.configFileDigest,
        configVersionJson: JSON.stringify({ configSnapshotId: input.configSnapshotId, fileDigest: input.configFileDigest,
          issuedConfigVersion: action.issuedConfigVersion, connectionName: input.connectionName }),
      },
      activeTarget: {
        workspaceInstance: action.workspaceId,
        sourceIdentity: `trigger:${action.sourceTrigger}:${action.repoRef}`,
      },
      consumeActionId: action.actionId,
      rateLimit: {
        bucketKey: `actor:${input.actor.type}:${input.actor.id}`,
        windowStart: new Date(Math.floor(now.getTime() / 60_000) * 60_000),
        limit: 5,
      },
    },
    now,
  });
  if (outcome.kind === "created") return { kind: "accepted", requestId };
  if (outcome.kind === "active_merged") return { kind: "duplicate", requestId: outcome.requestId };
  if (outcome.kind === "duplicate") return { kind: "duplicate", requestId: outcome.requestId ?? requestId };
  if (outcome.kind === "action_rejected") return outcome.reason === "expired" ? { kind: "expired" } : { kind: "rejected", reason: outcome.reason };
  return { kind: "rejected", reason: outcome.kind };
}
