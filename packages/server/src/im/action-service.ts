import { randomUUID } from "node:crypto";

import type { AppConfig, ImConversation, ImPrincipal } from "@aicr/core";
import type { StoreDb } from "@aicr/store";
import { acceptImDelivery, consumeImActionForRequest, getImAction, insertImAction } from "@aicr/store";

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
  readonly config: AppConfig;
  readonly actor: ImPrincipal;
  readonly conversation: ImConversation;
  readonly now?: Date;
}): Promise<CardActionResult> {
  const now = input.now ?? new Date();
  const action = await getImAction(store, input.actionId);
  if (action === undefined) return { kind: "not_found" };
  if (action.status === "consumed" && action.consumedRequestId !== null) {
    return { kind: "duplicate", requestId: action.consumedRequestId };
  }
  const requestId = `imr-${randomUUID()}`;
  const runId = `imrun-${randomUUID()}`;
  // Atomic consume-for-request: exactly one transition issues the request.
  const consumed = await consumeImActionForRequest(store, { actionId: input.actionId, requestId, now });
  if (consumed.kind === "expired") return { kind: "expired" };
  if (consumed.kind === "not_found") return { kind: "not_found" };
  if (consumed.kind === "duplicate") return { kind: "duplicate", requestId: consumed.requestId || requestId };
  const action2 = (await getImAction(store, input.actionId))!;
  if (action2.consumedRequestId !== requestId) {
    return { kind: "duplicate", requestId: action2.consumedRequestId ?? requestId };
  }
  const outcome = await acceptImDelivery(store, {
    delivery: {
      namespace: action2.namespace,
      connectionIdentity: action2.connectionIdentity,
      deliveryKind: "card_action",
      deliveryKey: `action:${input.actionId}`,
      payloadDigest: `action:${action2.repoRef}:${action2.revision}`,
    },
    command: {
      request: {
        requestId,
        runId,
        bindingId: action2.bindingId,
        requestedBy: input.actor,
        conversation: JSON.stringify(input.conversation),
        workspaceId: action2.workspaceId,
        sourceTrigger: action2.sourceTrigger,
        repoRef: action2.repoRef,
        requestedRevision: action2.revision,
        configSnapshotId: "card-action",
        configFileDigest: action2.issuedConfigVersion,
        configVersionJson: action2.issuedConfigVersion,
      },
      activeTarget: {
        workspaceInstance: action2.workspaceId,
        sourceIdentity: `trigger:${action2.sourceTrigger}:${action2.repoRef}`,
      },
      rateLimit: {
        bucketKey: `actor:${input.actor.type}:${input.actor.id}`,
        windowStart: new Date(Math.floor(now.getTime() / 60_000) * 60_000),
        limit: 5,
      },
    },
    now,
  });
  void input.config;
  if (outcome.kind === "created") return { kind: "accepted", requestId };
  if (outcome.kind === "active_merged") return { kind: "duplicate", requestId: outcome.requestId };
  if (outcome.kind === "duplicate") return { kind: "duplicate", requestId: outcome.requestId ?? requestId };
  return { kind: "rejected", reason: outcome.kind };
}
