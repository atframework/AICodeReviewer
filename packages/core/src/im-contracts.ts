import { z } from "zod";

import { stableSerialize } from "./config-format.js";

/**
 * Pure shared contracts for IM integrations (design §5.2/§7, execution
 * contracts §3). No network, filesystem, clock, or database access lives
 * here; server adapters and services own construction and persistence.
 */

// ---------------------------------------------------------------------------
// Principals and conversations
// ---------------------------------------------------------------------------

/**
 * Typed actor identities (execution contracts §2). The namespace always comes
 * from the connection: a literal id only ever matches inside the connection
 * identity domain that produced it, so equal literals from different apps,
 * corps, or tenants never merge.
 */
export const imPrincipalTypeSchema = z.enum([
  "wecom_userid",
  "wecom_encrypted_userid",
  "feishu_open_id",
]);
export type ImPrincipalType = z.infer<typeof imPrincipalTypeSchema>;

/** Control characters never appear in valid platform ids. */
const hasControlCharacter = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.codePointAt(0)!;
    return code < 0x20 || code === 0x7f;
  });

export const imPlatformIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacter(value), {
    message: "platform ids must not contain control characters",
  });

export const imPrincipalSchema = z
  .object({
    type: imPrincipalTypeSchema,
    id: imPlatformIdSchema,
  })
  .strict();
export type ImPrincipal = z.infer<typeof imPrincipalSchema>;

export const imConversationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("app_direct") }).strict(),
  z.object({ kind: z.literal("bot_direct") }).strict(),
  z.object({ kind: z.literal("group"), id: imPlatformIdSchema }).strict(),
]);
export type ImConversation = z.infer<typeof imConversationSchema>;

// ---------------------------------------------------------------------------
// Connection identity
// ---------------------------------------------------------------------------

export type ImConnectionKind = "wecom_app" | "wecom_aibot" | "feishu_app";

/**
 * Deployment-scoped connection identity (execution contracts §3): secret
 * rotation must not change it, while app/bot/corp/tenant changes must. The
 * stable key is used for inbox dedup rows, conversation registries, and
 * ReviewEvent.requestOrigin persistence.
 */
export interface ImConnectionIdentity {
  readonly kind: ImConnectionKind;
  /** WeCom corp domain (`corp_id`) when the platform is WeCom. */
  readonly corpId: string | undefined;
  /** Feishu `app_id`, WeCom `agent_id` (as string), or WeCom `aibot_id`. */
  readonly platformId: string | undefined;
  /** Feishu tenant domain (`tenant_key`) when known. */
  readonly tenantKey: string | undefined;
  /** Deployment namespace from config_sources.database.namespace. */
  readonly namespace: string;
}

export function imConnectionIdentityKey(identity: ImConnectionIdentity): string {
  return stableSerialize({
    namespace: identity.namespace,
    kind: identity.kind,
    corpId: identity.corpId ?? null,
    platformId: identity.platformId ?? null,
    tenantKey: identity.tenantKey ?? null,
  });
}

// ---------------------------------------------------------------------------
// Verified inbound events
// ---------------------------------------------------------------------------

export type ImDeliveryKind = "message" | "event" | "card_action";

/**
 * Only the fields command handling needs. Raw chat bodies, attachments, and
 * full directory records never enter this union (design §5.2 privacy rules).
 */
export type ImEventContent =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "card_action"; readonly actionId: string }
  | { readonly kind: "lifecycle"; readonly event: string }
  /** WeCom API-bot stream refresh: acknowledged and typed, never a review trigger (S03). */
  | { readonly kind: "stream_refresh"; readonly streamId: string }
  /** Authenticated but unsupported legal type: confirmed, counted, ignored. */
  | { readonly kind: "unknown_type"; readonly type: string };

export interface VerifiedImEventData {
  readonly connectionIdentity: ImConnectionIdentity;
  /** Connection name for config lookup; not part of the identity domain. */
  readonly connectionName: string;
  readonly protocol: ImConnectionKind;
  readonly deliveryKind: ImDeliveryKind;
  /** Platform-native dedup key (MsgId, msgid, message_id, event+action identity…). */
  readonly deliveryKey: string;
  /** Versioned normalized-content digest, excluding transport retry noise. */
  readonly payloadDigest: string;
  readonly actor: ImPrincipal | undefined;
  readonly conversation: ImConversation | undefined;
  /** Epoch milliseconds as delivered by the platform envelope. */
  readonly occurredAt: number;
  readonly messageId: string | undefined;
  readonly eventId: string | undefined;
  readonly actionId: string | undefined;
  readonly content: ImEventContent;
}

const verifiedImEventBrand = Symbol("VerifiedImEvent");

export interface VerifiedImEvent extends VerifiedImEventData {
  readonly [verifiedImEventBrand]: true;
}

/**
 * Construction boundary for authenticated protocol adapters only (execution
 * contracts §3): routes and services receive branded values and cannot forge
 * one from an unauthenticated payload without an explicit cast.
 */
export function brandVerifiedImEvent(data: VerifiedImEventData): VerifiedImEvent {
  return Object.freeze({ ...data, [verifiedImEventBrand]: true }) as VerifiedImEvent;
}

export function isVerifiedImEvent(value: unknown): value is VerifiedImEvent {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[verifiedImEventBrand] === true;
}

// ---------------------------------------------------------------------------
// Authorization directory scopes (scope-matcher evaluation input)
// ---------------------------------------------------------------------------

/**
 * Directory facts for one authenticated actor, resolved by the server-side
 * authorization directory from cached platform snapshots. Scope matchers
 * only match against a present section; a missing section (directory
 * unavailable, identity unresolvable) fails closed (design §6 A05).
 */
export interface ImActorScopes {
  /** WeCom corporate directory facts; `userid` is the plaintext userid. */
  readonly wecom?: {
    readonly userid: string;
    /** Direct department ids. */
    readonly departments: readonly string[];
    /** Direct departments plus all their ancestors (for recursive matchers). */
    readonly departmentsClosure: readonly string[];
    readonly position: string | undefined;
    /** Custom-field name → first text value. */
    readonly extattr: ReadonlyMap<string, string>;
    readonly tagIds: readonly string[];
  } | undefined;
  /** Feishu directory facts for the application tenant. */
  readonly feishu?: {
    readonly openId: string;
    /** open_department_id values. */
    readonly departments: readonly string[];
    readonly jobTitle: string | undefined;
    /** Referenced chat ids the actor belongs to. */
    readonly chats: ReadonlySet<string>;
  } | undefined;
}

// ---------------------------------------------------------------------------
// Commands and manual review requests
// ---------------------------------------------------------------------------

export const IM_COMMAND_NAMES = [
  "help",
  "chat-id",
  "review",
  "status",
  "projects",
  "reviews",
  "commits",
  "prs",
  "detail",
  "prdetail",
  "queue",
  "running",
] as const;
export type ImCommandName = (typeof IM_COMMAND_NAMES)[number];

export type ImCommand =
  | { readonly kind: "help" }
  | { readonly kind: "chat-id" }
  | { readonly kind: "review"; readonly repoAlias: string; readonly revision: string }
  | { readonly kind: "status"; readonly requestId: string }
  | { readonly kind: "projects" }
  | { readonly kind: "reviews"; readonly repoAlias: string | undefined }
  | { readonly kind: "commits"; readonly repoAlias: string; readonly branch: string | undefined }
  | { readonly kind: "prs"; readonly repoAlias: string; readonly branch: string | undefined }
  | { readonly kind: "detail"; readonly repoAlias: string; readonly revision: string }
  | { readonly kind: "prdetail"; readonly repoAlias: string; readonly prId: string }
  | { readonly kind: "queue" }
  | { readonly kind: "running" };

export type ImReviewRequestState =
  | "accepted"
  | "validating"
  | "queued"
  | "running"
  | "publishing"
  | "retry_wait"
  | "succeeded"
  | "partial"
  | "publication_unknown"
  | "failed"
  | "rejected";

export const IM_REVIEW_TERMINAL_STATES: readonly ImReviewRequestState[] = [
  "succeeded",
  "partial",
  "publication_unknown",
  "failed",
  "rejected",
];

/** Durable resume point; recovery never guesses it from optional strings. */
export type ImReviewResumePhase = "validate" | "queue" | "analyze" | "publish" | "notify";

export interface ImReviewRepositoryTarget {
  readonly workspaceId: string;
  readonly sourceTrigger: string;
  readonly repoRef: string;
  readonly requestedRevision: string;
  readonly resolvedRevision: string | undefined;
  readonly baseRevision: string | undefined;
}

/** Core shared shape of `im_review_requests` rows (execution contracts §4). */
export interface ManualReviewRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly bindingId: string;
  readonly connectionIdentityKey: string;
  readonly requestedBy: ImPrincipal;
  readonly conversation: ImConversation;
  readonly repository: ImReviewRepositoryTarget;
  readonly state: ImReviewRequestState;
  readonly resumePhase: ImReviewResumePhase | undefined;
  readonly errorCode: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Error codes and admission results
// ---------------------------------------------------------------------------

export const IM_ERROR_CODES = [
  "im.unknown_command",
  "im.malformed_command",
  "im.unauthorized_actor",
  "im.unauthorized_conversation",
  "im.unauthorized_repository",
  "im.rate_limited",
  "im.capacity_exceeded",
  "im.storage_unavailable",
  "im.delivery_conflict",
  "im.invalid_revision",
  "im.action_expired",
  "im.action_consumed",
  "im.action_source_mismatch",
  "im.capability_unavailable",
  "im.config_unavailable",
  "im.request_not_found",
  "im.reply_expired",
] as const;
export type ImErrorCode = (typeof IM_ERROR_CODES)[number];

export interface ImError {
  readonly code: ImErrorCode;
  /** Operator-facing reason already free of secrets, ids, and repo existence. */
  readonly message: string;
}

/** Discriminated admission outcome; never a boolean (execution contracts §3). */
export type ImAdmissionResult =
  | { readonly kind: "accepted"; readonly requestId: string }
  | { readonly kind: "duplicate"; readonly requestId: string }
  | { readonly kind: "rejected"; readonly error: ImError };
