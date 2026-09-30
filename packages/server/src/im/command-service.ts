import type { AppConfig, ImActorScopes, ImBindingActor, ImCommandBindingConfig } from "@aicr/core";
import type { ImCommand, ImConversation, ImPrincipal } from "@aicr/core";
import type { AcceptImDeliveryOutcome, StoreDb } from "@aicr/store";
import { acceptImDelivery, findImReviewRequest } from "@aicr/store";

/**
 * IM command admission (IM-11, design §6–7): fixed grammar tokenizer, exact
 * typed-identity authorization against enabled bindings, and durable request
 * creation through the store's atomic acceptDelivery. Natural language never
 * reaches an LLM; repo aliases resolve only through pre-registered trusted
 * targets. The service performs no VCS/LLM/network work — revision validation
 * runs in the worker (IM-13/14).
 *
 * Scope matchers (departments/tags/positions/custom fields/chat membership/
 * time-boxed `any`) authorize against directory facts resolved by the
 * caller-supplied authorization directory; a missing scope section fails
 * closed, never open (A05).
 */

export type ImCommandParseResult =
  | { readonly kind: "command"; readonly command: ImCommand }
  | { readonly kind: "not_command" }
  | { readonly kind: "invalid"; readonly reason: string };

const COMMAND_PREFIX = "aicr";
const MAX_COMMAND_BYTES = 2048;

/**
 * Fixed-grammar tokenizer (A01): `aicr help`, `aicr chat-id`,
 * `aicr review <repo-alias> <revision>`, `aicr status <request-id>`, plus
 * the read-only query set — `aicr projects`, `aicr reviews [alias]`,
 * `aicr commits <alias> [branch]`, `aicr prs <alias> [branch]`,
 * `aicr detail <alias> <revision>`, `aicr prdetail <alias> <pr-id>`,
 * `aicr queue`, `aicr running`. Rejects extra arguments, multi-line text,
 * shell metacharacters and non-command text without invoking any external
 * parser.
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
  const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
  const revisionPattern = /^[A-Za-z0-9]+$/u;
  const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
  switch (subcommand) {
    case "help":
      if (tokens.length !== 2) return { kind: "invalid", reason: "unexpected_arguments" };
      return { kind: "command", command: { kind: "help" } };
    case "chat-id":
      if (tokens.length !== 2) return { kind: "invalid", reason: "unexpected_arguments" };
      return { kind: "command", command: { kind: "chat-id" } };
    case "review":
      if (tokens.length !== 4) return { kind: "invalid", reason: "wrong_argument_count" };
      if (!aliasPattern.test(tokens[2]!)) return { kind: "invalid", reason: "invalid_repo_alias" };
      if (!revisionPattern.test(tokens[3]!)) return { kind: "invalid", reason: "invalid_revision" };
      return { kind: "command", command: { kind: "review", repoAlias: tokens[2]!, revision: tokens[3]! } };
    case "status":
      if (tokens.length !== 3) return { kind: "invalid", reason: "wrong_argument_count" };
      if (!/^[A-Za-z0-9_-]+$/u.test(tokens[2]!)) return { kind: "invalid", reason: "invalid_request_id" };
      return { kind: "command", command: { kind: "status", requestId: tokens[2]! } };
    case "projects":
      if (tokens.length !== 2) return { kind: "invalid", reason: "unexpected_arguments" };
      return { kind: "command", command: { kind: "projects" } };
    case "reviews":
      if (tokens.length < 2 || tokens.length > 3) return { kind: "invalid", reason: "wrong_argument_count" };
      if (tokens.length === 3 && !aliasPattern.test(tokens[2]!)) return { kind: "invalid", reason: "invalid_repo_alias" };
      return { kind: "command", command: { kind: "reviews", ...(tokens.length === 3 ? { repoAlias: tokens[2]! } : { repoAlias: undefined }) } };
    case "commits":
    case "prs": {
      if (tokens.length < 3 || tokens.length > 4) return { kind: "invalid", reason: "wrong_argument_count" };
      if (!aliasPattern.test(tokens[2]!)) return { kind: "invalid", reason: "invalid_repo_alias" };
      if (tokens.length === 4 && !branchPattern.test(tokens[3]!)) return { kind: "invalid", reason: "invalid_branch" };
      return {
        kind: "command",
        command: {
          kind: subcommand,
          repoAlias: tokens[2]!,
          ...(tokens.length === 4 ? { branch: tokens[3]! } : { branch: undefined }),
        },
      };
    }
    case "detail":
      if (tokens.length !== 4) return { kind: "invalid", reason: "wrong_argument_count" };
      if (!aliasPattern.test(tokens[2]!)) return { kind: "invalid", reason: "invalid_repo_alias" };
      if (!revisionPattern.test(tokens[3]!)) return { kind: "invalid", reason: "invalid_revision" };
      return { kind: "command", command: { kind: "detail", repoAlias: tokens[2]!, revision: tokens[3]! } };
    case "prdetail":
      if (tokens.length !== 4) return { kind: "invalid", reason: "wrong_argument_count" };
      if (!aliasPattern.test(tokens[2]!)) return { kind: "invalid", reason: "invalid_repo_alias" };
      if (!/^[A-Za-z0-9_-]+$/u.test(tokens[3]!)) return { kind: "invalid", reason: "invalid_pr_id" };
      return { kind: "command", command: { kind: "prdetail", repoAlias: tokens[2]!, prId: tokens[3]! } };
    case "queue":
    case "running":
      if (tokens.length !== 2) return { kind: "invalid", reason: "unexpected_arguments" };
      return { kind: "command", command: { kind: subcommand } };
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

/** Expired matchers stop matching without config edits (temporary authorization). */
function matcherActive(matcher: ImBindingActor, now: Date): boolean {
  if (!("expires_at" in matcher) || matcher.expires_at === undefined) return true;
  const expiresAt = Date.parse(matcher.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

/**
 * One matcher against one actor. Exact principals match the typed identity;
 * scope matchers match resolved directory facts and never match when the
 * section is missing (fail closed). Directory members, aliases and name
 * guesses still never authorize (A02) — only configured matchers do.
 */
function actorMatches(matcher: ImBindingActor, actor: ImPrincipal, scopes: ImActorScopes | undefined): boolean {
  if (!("kind" in matcher)) return matcher.type === actor.type && matcher.id === actor.id;
  switch (matcher.kind) {
    case "any":
      return true;
    case "wecom_department": {
      const wecom = scopes?.wecom;
      if (wecom === undefined) return false;
      const ids = matcher.recursive === false ? wecom.departments : wecom.departmentsClosure;
      return ids.includes(matcher.id);
    }
    case "wecom_tag":
      return scopes?.wecom?.tagIds.includes(matcher.id) ?? false;
    case "wecom_position":
      return scopes?.wecom?.position === matcher.value;
    case "wecom_extattr":
      return scopes?.wecom?.extattr.get(matcher.name) === matcher.value;
    case "feishu_chat":
      return scopes?.feishu?.chats.has(matcher.chat_id) ?? false;
    case "feishu_department":
      return scopes?.feishu?.departments.includes(matcher.id) ?? false;
    case "feishu_job_title":
      return scopes?.feishu?.jobTitle === matcher.value;
  }
}

function actorsMatch(binding: ImCommandBindingConfig, actor: ImPrincipal, scopes: ImActorScopes | undefined, now: Date): boolean {
  return binding.actors.some(allowed => matcherActive(allowed, now) && actorMatches(allowed, actor, scopes));
}

/**
 * Typed authorization (A02–A05): the actor must match an allowlist entry —
 * an exact typed principal or a configured scope matcher over resolved
 * directory facts — the conversation must be listed, the connection must be
 * the binding's exact connection, and the repo alias must map to a
 * pre-registered trusted target. Directory members, name matches, and
 * same-name accounts on other triggers never authorize.
 */
export function authorizeImCommand(options: {
  readonly config: AppConfig;
  readonly connectionName: string;
  readonly actor: ImPrincipal;
  readonly conversation: ImConversation;
  readonly command: ImCommand;
  /** Directory facts for scope matchers; missing sections fail closed. */
  readonly actorScopes?: ImActorScopes | undefined;
  readonly now?: Date;
}): ImCommandAuthorizeResult {
  const connection = options.config.im?.connections?.[options.connectionName];
  if (connection === undefined || connection.enabled === false) {
    return { kind: "rejected", reason: "connection_unavailable" };
  }
  const now = options.now ?? new Date();
  const bindings = Object.entries(options.config.im?.command_bindings ?? {});
  for (const [bindingName, binding] of bindings) {
    if (binding.connection !== options.connectionName) continue;
    if (binding.enabled !== true) continue;
    const bindingConnection = options.config.im?.connections?.[binding.connection];
    if (bindingConnection === undefined || bindingConnection.kind !== connection.kind) continue;
    if (!actorsMatch(binding, options.actor, options.actorScopes, now)) continue;
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
  /** Resolved directory facts; scope matchers fail closed without them. */
  readonly actorScopes?: ImActorScopes | undefined;
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
    actorScopes: input.actorScopes,
    now: input.now,
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

/**
 * Group messages carry an @mention prefix before the command ("@机器人
 * aicr help" on WeCom, "@_user_1 aicr help" on Feishu); the command grammar
 * starts at the `aicr` prefix, so strip one leading mention token first.
 */
export function stripImMentionPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("@")) return trimmed;
  const firstSpace = trimmed.search(/\s/u);
  return firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();
}

/** The help text shown to authorized users (design §7.1). */
export const IM_HELP_TEXT = [
  "AICR 评审命令：",
  "  aicr help — 显示本帮助",
  "  aicr chat-id — 显示当前会话标识",
  "  aicr review <repo-alias> <revision> — 对指定提交重新评审",
  "  aicr status <request-id> — 查询请求状态",
  "查询命令：",
  "  aicr projects — 接入的项目列表",
  "  aicr reviews [repo-alias] — 近期评审记录",
  "  aicr commits <repo-alias> [branch] — 近期会触发评审的提交",
  "  aicr prs <repo-alias> [branch] — 近期会触发评审的 PR/MR",
  "  aicr detail <repo-alias> <revision> — 提交的评审详情（含用量）",
  "  aicr prdetail <repo-alias> <pr-id> — PR/MR 的评审详情（含用量）",
  "  aicr queue — 排队中的任务",
  "  aicr running — 进行中的评审",
].join("\n");

// ---------------------------------------------------------------------------
// Receive-path orchestration (shared by callbacks and long connections)
// ---------------------------------------------------------------------------

/** Directory-fact resolution surface used by scope matchers. */
export interface ImCommandDirectoryLike {
  resolve(input: {
    readonly connectionName: string;
    readonly actor: ImPrincipal;
    readonly matchers: readonly ImBindingActor[];
  }): Promise<ImActorScopes | undefined>;
}

export interface ProcessImCommandInput extends ImCommandAdmitInput {
  readonly store: StoreDb;
  readonly directory?: ImCommandDirectoryLike | undefined;
  /** Read-only query surface for the status commands; absent = fail closed. */
  readonly query?: ImQueryServiceLike | undefined;
}

/** Query surface injected by bootstrap (avoids a concrete-class dependency). */
export interface ImQueryServiceLike {
  answer(input: { readonly command: ImCommand; readonly connectionName: string }): Promise<string>;
  /** Wildcard alias resolution against observed projects (A15d). */
  resolveProjectAlias(repoAlias: string): Promise<{ readonly workspaceId: string; readonly sourceTrigger: string; readonly repoRef: string } | undefined>;
}

export interface ProcessImCommandResult {
  readonly kind: "replied" | "accepted" | "duplicate" | "active_merged" | "rejected" | "rate_limited";
  readonly replyText: string | undefined;
  readonly requestId: string | null;
}

/** Reply for grammar-invalid commands (A01): the reason plus a usage hint. */
export function invalidImCommandReply(reason: string): string {
  return [`命令格式无效：${reason}`, "发送 aicr help 查看命令用法。"].join("\n");
}

/** Query commands answer read-only views after the same authorization. */
const QUERY_COMMAND_KINDS = new Set(["projects", "reviews", "commits", "prs", "detail", "prdetail", "queue", "running"]);

/** Collects scope matchers from the connection's enabled bindings. */
function scopeMatchersFor(config: AppConfig, connectionName: string): ImBindingActor[] {
  const matchers: ImBindingActor[] = [];
  for (const binding of Object.values(config.im?.command_bindings ?? {})) {
    if (binding.connection !== connectionName || binding.enabled !== true) continue;
    for (const actor of binding.actors) {
      if ("kind" in actor && actor.kind !== "any") matchers.push(actor);
    }
  }
  return matchers;
}

function chatIdReplyText(input: ProcessImCommandInput): string {
  const conversation = input.conversation;
  const conversationId = conversation.kind === "group" ? conversation.id : "-";
  return [
    "当前会话标识：",
    `- 连接: ${input.connectionName}`,
    `- 操作人: ${input.actor.type} ${input.actor.id}`,
    `- 会话: ${conversation.kind} ${conversationId}`,
    "- 机器人可见范围内的成员才可发起命令。",
  ].join("\n");
}

/**
 * Rejections echo the conversation identity back to the sender (A14): the
 * recipient is already inside that conversation, and the echo closes the
 * bootstrap loop for group whitelisting — aibot group ids have no query API.
 */
function rejectionReplyText(reason: string, input: ProcessImCommandInput): string {
  const conversationId = input.conversation.kind === "group" ? input.conversation.id : "-";
  return [
    `请求被拒绝: ${reason}`,
    `- 操作人: ${input.actor.type} ${input.actor.id}`,
    `- 会话: ${input.conversation.kind} ${conversationId}`,
    "将以上标识加入 im.command_bindings 白名单后重试。",
  ].join("\n");
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  queued: "排队中，等待评审工作线程认领。",
  validating: "正在校验修订版本。",
  queued_for_dispatch: "已入派发队列。",
  dispatching: "正在准备派发。",
  running: "评审执行中。",
  succeeded: "评审已完成（全部通过）。",
  partial: "评审已完成（部分目标未决，见发布渠道）。",
  publication_unknown: "评审已完成（发布结果未知，见恢复日志）。",
  failed: "评审失败，见服务端日志。",
  rejected: "请求被拒绝（修订或配置无效）。",
};

async function statusReplyText(store: StoreDb, namespace: string, requestId: string): Promise<string> {
  const request = await findImReviewRequest(store, namespace, requestId);
  if (request === undefined) return `未找到请求 ${requestId}（请确认请求 ID，或该请求不属于当前部署命名空间）。`;
  const state = STATUS_TEXT[request.state] ?? `状态: ${request.state}`;
  return `请求 ${requestId}：${state}`;
}

/**
 * Wildcard alias augmentation (A15d): for bindings that opted into
 * `allow_all_repositories`, an unregistered alias resolves against the
 * observed projects table and is virtually registered on a cloned config,
 * so the pure config-only authorization path stays unchanged.
 */
async function augmentWildcardAlias(
  config: AppConfig,
  connectionName: string,
  repoAlias: string,
  query: ImQueryServiceLike,
): Promise<AppConfig> {
  for (const [name, binding] of Object.entries(config.im?.command_bindings ?? {})) {
    if (binding.connection !== connectionName || binding.enabled !== true) continue;
    if (binding.repositories?.[repoAlias] !== undefined) return config;
    if (binding.allow_all_repositories !== true) continue;
    const target = await query.resolveProjectAlias(repoAlias);
    if (target === undefined) return config;
    const bindings = { ...(config.im?.command_bindings ?? {}) };
    bindings[name] = {
      ...binding,
      repositories: {
        ...(binding.repositories ?? {}),
        [repoAlias]: { workspace: target.workspaceId, source_trigger: target.sourceTrigger, repo_ref: target.repoRef },
      },
    };
    return { ...config, im: { ...(config.im ?? {}), command_bindings: bindings } };
  }
  return config;
}

/**
 * The receive-path pipeline for parsed non-help commands: resolve directory
 * scopes, authorize, then either answer inline (chat-id identity, status
 * lookup) or atomically admit (review creates the durable request). `help`
 * never reaches this — callers short-circuit it without authorization.
 */
export async function processImCommand(input: ProcessImCommandInput): Promise<ProcessImCommandResult> {
  let config = input.config;
  if (input.query !== undefined && "repoAlias" in input.command && input.command.repoAlias !== undefined) {
    config = await augmentWildcardAlias(config, input.connectionName, input.command.repoAlias, input.query);
  }
  const matchers = scopeMatchersFor(config, input.connectionName);
  const actorScopes = matchers.length > 0 && input.directory !== undefined
    ? await input.directory.resolve({ connectionName: input.connectionName, actor: input.actor, matchers })
    : undefined;

  const authorized = authorizeImCommand({
    config,
    connectionName: input.connectionName,
    actor: input.actor,
    conversation: input.conversation,
    command: input.command,
    actorScopes,
    now: input.now,
  });
  if (authorized.kind === "rejected") {
    return { kind: "rejected", replyText: rejectionReplyText(authorized.reason ?? "unauthorized", input), requestId: null };
  }

  if (QUERY_COMMAND_KINDS.has(input.command.kind)) {
    if (input.query === undefined) {
      return { kind: "rejected", replyText: "查询服务不可用（本部署未启用查询命令）。", requestId: null };
    }
    try {
      const replyText = await input.query.answer({ command: input.command, connectionName: input.connectionName });
      const outcome = await admitImCommand(input.store, { ...input, config, actorScopes });
      if (outcome.kind === "rate_limited") {
        return { kind: "rate_limited", replyText: "请求过于频繁，请稍后再试。", requestId: null };
      }
      return { kind: "replied", replyText, requestId: null };
    } catch (error) {
      console.warn(JSON.stringify({ msg: "im_query_failed", command: input.command.kind, error: String(error) }));
      return { kind: "rejected", replyText: "查询失败，请稍后再试。", requestId: null };
    }
  }

  if (input.command.kind === "chat-id") {
    const outcome = await admitImCommand(input.store, { ...input, config, actorScopes });
    if (outcome.kind === "rejected" || outcome.kind === "rate_limited") {
      const replyText = outcome.kind === "rate_limited" ? "请求过于频繁，请稍后再试。" : rejectionReplyText(outcome.reason ?? "unauthorized", input);
      return { kind: outcome.kind === "rejected" ? "rejected" : "rate_limited", replyText, requestId: null };
    }
    return { kind: "replied", replyText: chatIdReplyText(input), requestId: null };
  }

  if (input.command.kind === "status") {
    const outcome = await admitImCommand(input.store, { ...input, config, actorScopes });
    if (outcome.kind === "rejected" || outcome.kind === "rate_limited") {
      const replyText = outcome.kind === "rate_limited" ? "请求过于频繁，请稍后再试。" : rejectionReplyText(outcome.reason ?? "unauthorized", input);
      return { kind: outcome.kind === "rejected" ? "rejected" : "rate_limited", replyText, requestId: null };
    }
    return { kind: "replied", replyText: await statusReplyText(input.store, input.namespace, input.command.requestId), requestId: null };
  }

  const outcome = await admitImCommand(input.store, { ...input, config, actorScopes });
  switch (outcome.kind) {
    case "accepted":
      return { kind: "accepted", replyText: `已收到评审请求（${outcome.requestId}），完成后按绑定渠道通知。`, requestId: outcome.requestId };
    case "active_merged":
      return { kind: "active_merged", replyText: `同仓库已有进行中的评审请求（${outcome.requestId}），已合并。`, requestId: outcome.requestId };
    case "duplicate":
      return { kind: "duplicate", replyText: "该命令已受理，请勿重复发送。", requestId: outcome.requestId };
    case "rate_limited":
      return { kind: "rate_limited", replyText: "请求过于频繁，请稍后再试。", requestId: null };
    default:
      return { kind: "rejected", replyText: `请求被拒绝: ${outcome.kind === "rejected" ? outcome.reason : "internal_error"}`, requestId: null };
  }
}

