import { randomUUID } from "node:crypto";

import type { AppConfig, ImBindingActor, ImConversation, ImPrincipal } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { acceptImDelivery, getImAction, insertImAction } from "@aicr/store";

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
  readonly config: AppConfig;
  readonly actor: ImPrincipal;
  readonly conversation: ImConversation;
  readonly directory?: ImCommandDirectoryLike | undefined;
  readonly now?: Date;
}): Promise<CardActionResult> {
  const now = input.now ?? new Date();
  const action = await getImAction(store, input.actionId);
  if (action === undefined) return { kind: "not_found" };
  if (action.namespace !== input.namespace || action.connectionIdentity !== input.connectionIdentity) return { kind: "rejected", reason: "source_mismatch" };
  if (action.sourceMessageId !== null && action.sourceMessageId !== input.sourceMessageId) return { kind: "rejected", reason: "source_mismatch" };
  if (action.sourceTaskId !== null) return { kind: "rejected", reason: "source_mismatch" };
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
        configSnapshotId: "card-action",
        configFileDigest: action.issuedConfigVersion,
        configVersionJson: JSON.stringify({ issuedConfigVersion: action.issuedConfigVersion, connectionName: input.connectionName }),
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
