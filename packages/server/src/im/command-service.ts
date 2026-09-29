import type { AppConfig, ImCommandBindingConfig } from "@aicr/core";
import type { ImCommand, ImConversation, ImPrincipal } from "@aicr/core";
import type { AcceptImDeliveryOutcome, StoreDb } from "@aicr/store";
import { acceptImDelivery } from "@aicr/store";

/**
 * IM command admission (IM-11, design §6–7): fixed grammar tokenizer, exact
 * typed-identity authorization against enabled bindings, and durable request
 * creation through the store's atomic acceptDelivery. Natural language never
 * reaches an LLM; repo aliases resolve only through pre-registered trusted
 * targets. The service performs no VCS/LLM/network work — revision validation
 * runs in the worker (IM-13/14).
 */

export type ImCommandParseResult =
  | { readonly kind: "command"; readonly command: ImCommand }
  | { readonly kind: "not_command" }
  | { readonly kind: "invalid"; readonly reason: string };

const COMMAND_PREFIX = "aicr";
const MAX_COMMAND_BYTES = 2048;

/**
 * Fixed-grammar tokenizer (A01): `aicr help`, `aicr chat-id`,
 * `aicr review <repo-alias> <revision>`, `aicr status <request-id>`.
 * Rejects extra arguments, multi-line text, shell metacharacters and
 * non-command text without invoking any external parser.
 */
export function parseImCommand(text: string): ImCommandParseResult {
  if (Buffer.byteLength(text, "utf8") > MAX_COMMAND_BYTES) {
    return { kind: "invalid", reason: "command_too_long" };
  }
  // Single line only; a newline is never part of the grammar.
  if (text.includes("\n") || text.includes("\r")) {
    return { kind: "invalid", reason: "multiline" };
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return { kind: "not_command" };
  }
  // Shell metacharacters in a command are rejected outright (A01).
  if (/[;&|`$><]/u.test(trimmed)) {
    return { kind: "invalid", reason: "shell_metacharacters" };
  }
  const tokens = trimmed.split(/\s+/u);
  const subcommand = tokens[1];
  switch (subcommand) {
    case "help":
      if (tokens.length !== 2) return { kind: "invalid", reason: "unexpected_arguments" };
      return { kind: "command", command: { kind: "help" } };
    case "chat-id":
      if (tokens.length !== 2) return { kind: "invalid", reason: "unexpected_arguments" };
      return { kind: "command", command: { kind: "chat-id" } };
    case "review":
      if (tokens.length !== 4) return { kind: "invalid", reason: "wrong_argument_count" };
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(tokens[2]!)) return { kind: "invalid", reason: "invalid_repo_alias" };
      if (!/^[A-Za-z0-9]+$/u.test(tokens[3]!)) return { kind: "invalid", reason: "invalid_revision" };
      return { kind: "command", command: { kind: "review", repoAlias: tokens[2]!, revision: tokens[3]! } };
    case "status":
      if (tokens.length !== 3) return { kind: "invalid", reason: "wrong_argument_count" };
      if (!/^[A-Za-z0-9_-]+$/u.test(tokens[2]!)) return { kind: "invalid", reason: "invalid_request_id" };
      return { kind: "command", command: { kind: "status", requestId: tokens[2]! } };
    default:
      return { kind: "invalid", reason: "unknown_command" };
  }
}

export interface ImCommandAuthorizeResult {
  readonly kind: "authorized" | "rejected";
  readonly binding?: ImCommandBindingConfig;
  readonly repository?: { readonly workspaceId: string; readonly sourceTrigger: string; readonly repoRef: string };
  readonly reason?: string;
}

function conversationsMatch(
  binding: ImCommandBindingConfig,
  conversation: ImConversation,
): boolean {
  return binding.conversations.some(allowed => {
    if (allowed.kind !== conversation.kind) return false;
    if (allowed.kind === "group" && conversation.kind === "group") return allowed.id === conversation.id;
    return true; // direct kinds
  });
}

function actorsMatch(binding: ImCommandBindingConfig, actor: ImPrincipal): boolean {
  return binding.actors.some(allowed => allowed.type === actor.type && allowed.id === actor.id);
}

/**
 * Exact-identity authorization (A02–A04): the actor must be a typed principal
 * in the binding's allowlist, the conversation must be listed, the connection
 * must be the binding's exact connection, and the repo alias must map to a
 * pre-registered trusted target. Directory members, name matches, and
 * same-name accounts on other triggers never authorize.
 */
export function authorizeImCommand(options: {
  readonly config: AppConfig;
  readonly connectionName: string;
  readonly actor: ImPrincipal;
  readonly conversation: ImConversation;
  readonly command: ImCommand;
}): ImCommandAuthorizeResult {
  const connection = options.config.im?.connections?.[options.connectionName];
  if (connection === undefined || connection.enabled === false) {
    return { kind: "rejected", reason: "connection_unavailable" };
  }
  const bindings = Object.entries(options.config.im?.command_bindings ?? {});
  for (const [bindingName, binding] of bindings) {
    if (binding.connection !== options.connectionName) continue;
    if (binding.enabled !== true) continue;
    const bindingConnection = options.config.im?.connections?.[binding.connection];
    if (bindingConnection === undefined || bindingConnection.kind !== connection.kind) continue;
    if (!actorsMatch(binding, options.actor)) continue;
    if (!conversationsMatch(binding, options.conversation)) continue;
    const commandName = options.command.kind === "chat-id" ? "chat-id" : options.command.kind;
    if (!binding.commands.includes(commandName as "help" | "chat-id" | "review" | "status")) continue;
    void bindingName;

    if (options.command.kind === "review") {
      const target = binding.repositories?.[options.command.repoAlias];
      if (target === undefined) {
        return { kind: "rejected", reason: "repository_not_authorized" };
      }
      // The trigger and workspace must actually exist in the config.
      const trigger = options.config.triggers.find(t => t.name === target.source_trigger);
      const workspace = options.config.workspaces.instances[target.workspace];
      if (trigger === undefined || workspace === undefined) {
        return { kind: "rejected", reason: "repository_target_invalid" };
      }
      return {
        kind: "authorized",
        binding,
        repository: { workspaceId: target.workspace, sourceTrigger: target.source_trigger, repoRef: target.repo_ref },
      };
    }
    return { kind: "authorized", binding };
  }
  return { kind: "rejected", reason: "no_matching_binding" };
}

export interface ImCommandAdmitInput {
  readonly config: AppConfig;
  readonly namespace: string;
  readonly connectionName: string;
  readonly connectionIdentity: string;
  readonly deliveryKey: string;
  readonly payloadDigest: string;
  readonly actor: ImPrincipal;
  readonly conversation: ImConversation;
  readonly command: ImCommand;
  readonly now: Date;
  readonly configSnapshotId: string;
  readonly configFileDigest: string;
}

export type ImCommandAdmitOutcome =
  | { readonly kind: "accepted"; readonly requestId: string }
  | { readonly kind: "active_merged"; readonly requestId: string }
  | { readonly kind: "duplicate"; readonly requestId: string | null }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "rate_limited" };

/**
 * The full admission pipeline: authorize then atomically persist via
 * acceptImDelivery. The `review` command creates a durable request bound to
 * the trusted repository target; help/chat-id/status create inbox rows only
 * (their replies are produced by IM-16's outbox). No VCS or LLM runs here.
 */
export async function admitImCommand(store: StoreDb, input: ImCommandAdmitInput): Promise<ImCommandAdmitOutcome> {
  const authorized = authorizeImCommand({
    config: input.config,
    connectionName: input.connectionName,
    actor: input.actor,
    conversation: input.conversation,
    command: input.command,
  });
  if (authorized.kind === "rejected") {
    return { kind: "rejected", reason: authorized.reason ?? "unauthorized" };
  }

  if (input.command.kind !== "review") {
    // Non-review commands are recorded without creating a request; their
    // replies come from the notification outbox (IM-16).
    const outcome = await acceptImDelivery(store, {
      delivery: {
        namespace: input.namespace,
        connectionIdentity: input.connectionIdentity,
        deliveryKind: "message",
        deliveryKey: input.deliveryKey,
        payloadDigest: input.payloadDigest,
      },
      now: input.now,
    });
    if (outcome.kind === "conflict") return { kind: "duplicate", requestId: null };
    return { kind: "accepted", requestId: "" };
  }

  const repository = authorized.repository!;
  const requestId = `imr-${crypto.randomUUID()}`;
  const runId = `imrun-${crypto.randomUUID()}`;

  const outcome: AcceptImDeliveryOutcome = await acceptImDelivery(store, {
    delivery: {
      namespace: input.namespace,
      connectionIdentity: input.connectionIdentity,
      deliveryKind: "message",
      deliveryKey: input.deliveryKey,
      payloadDigest: input.payloadDigest,
    },
    now: input.now,
    command: {
      request: {
        requestId,
        runId,
        bindingId: Object.entries(input.config.im?.command_bindings ?? {})
          .find(([, binding]) => binding === authorized.binding)?.[0] ?? "unknown",
        requestedBy: input.actor,
        conversation: JSON.stringify(input.conversation),
        workspaceId: repository.workspaceId,
        sourceTrigger: repository.sourceTrigger,
        repoRef: repository.repoRef,
        requestedRevision: input.command.revision,
        configSnapshotId: input.configSnapshotId,
        configFileDigest: input.configFileDigest,
        configVersionJson: JSON.stringify({
          configSnapshotId: input.configSnapshotId,
          fileDigest: input.configFileDigest,
        }),
      },
      activeTarget: {
        workspaceInstance: repository.workspaceId,
        sourceIdentity: `trigger:${repository.sourceTrigger}:${repository.repoRef}`,
      },
      rateLimit: {
        bucketKey: `actor:${input.actor.type}:${input.actor.id}`,
        windowStart: new Date(Math.floor(input.now.getTime() / 60_000) * 60_000),
        limit: 5,
      },
    },
  });

  switch (outcome.kind) {
    case "created":
      return { kind: "accepted", requestId };
    case "active_merged":
      return { kind: "active_merged", requestId: outcome.requestId };
    case "duplicate":
      return { kind: "duplicate", requestId: outcome.requestId };
    case "rate_limited":
      return { kind: "rate_limited" };
    case "conflict":
      return { kind: "duplicate", requestId: null };
    default:
      return { kind: "rejected", reason: "internal_error" };
  }
}

/** The help text shown to authorized users (design §7.1). */
export const IM_HELP_TEXT = [
  "AICR 评审命令：",
  "  aicr help — 显示本帮助",
  "  aicr chat-id — 显示当前会话标识",
  "  aicr review <repo-alias> <revision> — 对指定提交重新评审",
  "  aicr status <request-id> — 查询请求状态",
].join("\n");

