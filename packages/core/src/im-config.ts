import { z } from "zod";

import { addSecretMutexIssues, isPrototypeKey } from "./config-format.js";
import {
  imConversationSchema,
  imPlatformIdSchema,
  imPrincipalTypeSchema,
  IM_COMMAND_NAMES,
  type ImConnectionKind,
  type ImConversation,
} from "./im-contracts.js";

/**
 * Strict configuration schemas for the IM parent node and its output-channel
 * extensions (design §2, member-directory design §1, execution contracts §2).
 * Everything here is `.strict()`: unlike the historical passthrough channel
 * objects, unknown IM keys are configuration errors, not preserved
 * extensions. Runtime defaults are deliberately NOT zod defaults so parsed
 * documents keep the operator-written shape (snapshot-hash stability); each
 * comment records the runtime default the consumer applies.
 */

/** Connection protocol kinds, in schema order; feeds the UI kind selector. */
export const IM_CONNECTION_KINDS = ["wecom_app", "wecom_aibot", "feishu_app"] as const;

/** Named-map keys for connections and command bindings (execution contracts §2). */
export const imEntityNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u, {
    message: "im entity names must match [A-Za-z0-9][A-Za-z0-9_-]* (1..64 chars)",
  })
  .refine((value) => !isPrototypeKey(value), {
    message: "im entity names must not be prototype-chain keys",
  });

/** Callback credential pair: literal and `*_env` are mutually exclusive. */
function requireCredential(
  ctx: z.RefinementCtx,
  record: Record<string, unknown>,
  literal: string,
  envRef: string,
  enabled: boolean,
): void {
  addSecretMutexIssues(ctx, record, [[literal, envRef]]);
  if (enabled && record[literal] === undefined && record[envRef] === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `enabled callbacks require ${literal} or ${envRef}.`,
      path: [literal],
    });
  }
}

/** WeCom callback credentials (app and API bot share the token/AES scheme, W3/W7). */
const wecomCallbackSchema = z
  .object({
    /** Runtime default: disabled. */
    enabled: z.boolean().optional(),
    token: z.string().min(1).optional(),
    token_env: z.string().min(1).optional(),
    encoding_aes_key: z.string().min(1).optional(),
    encoding_aes_key_env: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((callback, ctx) => {
    requireCredential(ctx, callback, "token", "token_env", callback.enabled === true);
    requireCredential(ctx, callback, "encoding_aes_key", "encoding_aes_key_env", callback.enabled === true);
  });

/** Feishu callback credentials (F5/F6). */
const feishuCallbackSchema = z
  .object({
    /** Runtime default: disabled. */
    enabled: z.boolean().optional(),
    verification_token: z.string().min(1).optional(),
    verification_token_env: z.string().min(1).optional(),
    encrypt_key: z.string().min(1).optional(),
    encrypt_key_env: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((callback, ctx) => {
    requireCredential(ctx, callback, "verification_token", "verification_token_env", callback.enabled === true);
    requireCredential(ctx, callback, "encrypt_key", "encrypt_key_env", callback.enabled === true);
  });

const wecomAppConnectionSchema = z
  .object({
    kind: z.literal("wecom_app"),
    /** Runtime default: enabled. */
    enabled: z.boolean().optional(),
    corp_id: z.string().min(1),
    agent_id: z.number().int().positive(),
    app_secret: z.string().min(1).optional(),
    app_secret_env: z.string().min(1).optional(),
    callback: wecomCallbackSchema.optional(),
  })
  .strict();

const wecomAibotConnectionSchema = z
  .object({
    kind: z.literal("wecom_aibot"),
    /** Runtime default: enabled. */
    enabled: z.boolean().optional(),
    /** Local binding identity domain; not claimed to ride inside the encrypted payload. */
    corp_id: z.string().min(1),
    /** Optional: the event-callback protocol does not require it; the long-connection robot does. */
    aibot_id: z.string().min(1).optional(),
    /** Long-connection credential; mutually exclusive with secret_env. */
    secret: z.string().min(1).optional(),
    secret_env: z.string().min(1).optional(),
    callback: wecomCallbackSchema.optional(),
  })
  .strict();

const FEISHU_APP_BASE_URLS = ["https://open.feishu.cn", "https://open.larksuite.com"] as const;

const feishuAppConnectionSchema = z
  .object({
    kind: z.literal("feishu_app"),
    /** Runtime default: enabled. */
    enabled: z.boolean().optional(),
    app_id: z.string().min(1),
    app_secret: z.string().min(1).optional(),
    app_secret_env: z.string().min(1).optional(),
    base_url: z.string().min(1).optional(),
    tenant_key: z.string().min(1).optional(),
    callback: feishuCallbackSchema.optional(),
  })
  .strict();

export const imConnectionSchema = z
  .discriminatedUnion("kind", [wecomAppConnectionSchema, wecomAibotConnectionSchema, feishuAppConnectionSchema])
  .superRefine((connection, ctx) => {
    if (connection.kind === "wecom_app" || connection.kind === "feishu_app") {
      addSecretMutexIssues(ctx, connection, [["app_secret", "app_secret_env"]]);
      if (connection.app_secret === undefined && connection.app_secret_env === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${connection.kind} connections require app_secret or app_secret_env.`,
          path: ["app_secret"],
        });
      }
    }
    if (connection.kind === "feishu_app") {
      if (connection.base_url !== undefined && !(FEISHU_APP_BASE_URLS as readonly string[]).includes(connection.base_url.replace(/\/+$/u, ""))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `feishu_app base_url must be ${FEISHU_APP_BASE_URLS.join(" or ")}.`,
          path: ["base_url"],
        });
      }
      if (connection.callback?.enabled === true && connection.tenant_key === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "feishu_app callbacks require tenant_key.",
          path: ["tenant_key"],
        });
      }
    }
  });
export type ImConnectionConfig = z.infer<typeof imConnectionSchema>;

export const imCommandNameSchema = z.enum(IM_COMMAND_NAMES);

/**
 * Optional per-matcher expiry (RFC 3339 with offset). Expired matchers stop
 * matching without config edits — the "temporary authorization" mechanism
 * for principals and scope matchers alike.
 */
const imBindingExpiresAtSchema = z.string().datetime({ offset: true, precision: 3 }).or(z.string().datetime({ offset: true }));

/** Exact typed principal (the original shape; `kind` stays implicit). */
const imBindingPrincipalActorSchema = z
  .object({
    type: imPrincipalTypeSchema,
    id: imPlatformIdSchema,
    expires_at: imBindingExpiresAtSchema.optional(),
  })
  .strict();

/**
 * Scope matchers (A02 relaxation, explicit opt-in): authorize by corporate
 * directory facts instead of exact ids. The aibot's `from.userid` may be an
 * encrypted open_userid; the server converts it via
 * batch/openuserid_to_userid (path/101521) against the directory app before
 * matching. WeCom "roles" are carried by tags; Feishu chat groups carry
 * membership-based authorization.
 */
const imBindingScopeActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("any"),
    expires_at: imBindingExpiresAtSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("wecom_department"),
    id: z.string().min(1),
    /** Runtime default: true — include child departments. */
    recursive: z.boolean().optional(),
    expires_at: imBindingExpiresAtSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("wecom_tag"),
    id: z.string().min(1),
    expires_at: imBindingExpiresAtSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("wecom_position"),
    value: z.string().min(1),
    expires_at: imBindingExpiresAtSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("wecom_extattr"),
    name: z.string().min(1),
    value: z.string().min(1),
    expires_at: imBindingExpiresAtSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("feishu_chat"),
    chat_id: z.string().min(1),
    expires_at: imBindingExpiresAtSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("feishu_department"),
    id: z.string().min(1),
    expires_at: imBindingExpiresAtSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("feishu_job_title"),
    value: z.string().min(1),
    expires_at: imBindingExpiresAtSchema.optional(),
  }).strict(),
]);

const imBindingActorSchema = z.union([imBindingPrincipalActorSchema, imBindingScopeActorSchema]);
export type ImBindingActor = z.infer<typeof imBindingActorSchema>;

const imBindingRepositorySchema = z
  .object({
    workspace: z.string().min(1),
    source_trigger: z.string().min(1),
    repo_ref: z.string().min(1),
  })
  .strict();

export const imCommandBindingSchema = z
  .object({
    /** Runtime default: disabled; disabled drafts always stay savable. */
    enabled: z.boolean().optional(),
    connection: z.string().min(1),
    actors: z.array(imBindingActorSchema).min(1),
    conversations: z.array(imConversationSchema).min(1),
    commands: z
      .array(imCommandNameSchema)
      .min(1)
      .refine((commands) => new Set(commands).size === commands.length, {
        message: "binding commands must be unique",
      }),
    repositories: z.record(imEntityNameSchema, imBindingRepositorySchema).optional(),
    /**
     * Runtime default false. When true, repo aliases resolve beyond the
     * pre-registered `repositories` map against the observed projects table
     * (exact workspace id or repo ref match) — the operator's explicit
     * "open all repositories" opt-in for query and review commands (A15d).
     */
    allow_all_repositories: z.boolean().optional(),
    /** Runtime default: workspace_routes; the only first-phase policy. */
    report_policy: z.enum(["workspace_routes"]).optional(),
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (binding.commands.includes("review") && binding.allow_all_repositories !== true
      && (binding.repositories === undefined || Object.keys(binding.repositories).length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bindings that allow the review command must map at least one repository alias.",
        path: ["repositories"],
      });
    }
  });
export type ImCommandBindingConfig = z.infer<typeof imCommandBindingSchema>;

/** Conversation shapes each connection protocol can carry (design §1.1/§6). */
const CONVERSATIONS_BY_CONNECTION_KIND: Readonly<Record<ImConnectionKind, readonly ImConversation["kind"][]>> = {
  wecom_app: ["app_direct"],
  wecom_aibot: ["bot_direct", "group"],
  feishu_app: ["app_direct", "group"],
};

/** Actor identity types each connection protocol can authenticate (execution contracts §2). */
const ACTOR_TYPES_BY_CONNECTION_KIND: Readonly<Record<ImConnectionKind, readonly z.infer<typeof imPrincipalTypeSchema>[]>> = {
  wecom_app: ["wecom_userid"],
  wecom_aibot: ["wecom_userid", "wecom_encrypted_userid"],
  feishu_app: ["feishu_open_id"],
};

const actorKey = (actor: ImBindingActor): string => {
  if (!("kind" in actor)) return `${actor.type}:${actor.id}`;
  switch (actor.kind) {
    case "any": return "any:*";
    case "wecom_department": return `wecom_department:${actor.id}${actor.recursive === false ? "!" : ""}`;
    case "wecom_tag": return `wecom_tag:${actor.id}`;
    case "wecom_position": return `wecom_position:${actor.value}`;
    case "wecom_extattr": return `wecom_extattr:${actor.name}=${actor.value}`;
    case "feishu_chat": return `feishu_chat:${actor.chat_id}`;
    case "feishu_department": return `feishu_department:${actor.id}`;
    case "feishu_job_title": return `feishu_job_title:${actor.value}`;
  }
};

/** `any` overlaps every other matcher on the same connection. */
const actorsOverlap = (a: ImBindingActor, b: ImBindingActor): boolean =>
  ("kind" in a && a.kind === "any") || ("kind" in b && b.kind === "any") || actorKey(a) === actorKey(b);

/** Scope matchers only resolve against their own platform's directory. */
const SCOPE_ACTOR_KINDS_BY_CONNECTION_KIND: Readonly<Record<ImConnectionKind, readonly string[]>> = {
  wecom_app: ["wecom_department", "wecom_tag", "wecom_position", "wecom_extattr"],
  wecom_aibot: ["wecom_department", "wecom_tag", "wecom_position", "wecom_extattr"],
  feishu_app: ["feishu_chat", "feishu_department", "feishu_job_title"],
};

const conversationsOverlap = (a: ImConversation, b: ImConversation): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "group" || b.kind !== "group") return true;
  return a.id === b.id;
};

export const imConfigSchema = z
  .object({
    connections: z.record(imEntityNameSchema, imConnectionSchema).optional(),
    command_bindings: z.record(imEntityNameSchema, imCommandBindingSchema).optional(),
  })
  .strict()
  .superRefine((im, ctx) => {
    const connections = im.connections ?? {};
    const bindings = Object.entries(im.command_bindings ?? {});

    for (const [name, binding] of bindings) {
      if (binding.enabled !== true) {
        continue;
      }
      const connection = connections[binding.connection];
      const basePath: [string, string] = ["command_bindings", name];
      if (connection === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `enabled binding must reference an existing im.connections entry; "${binding.connection}" is not defined.`,
          path: [...basePath, "connection"],
        });
        continue;
      }
      if (connection.enabled === false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `enabled binding cannot use disabled connection "${binding.connection}".`,
          path: [...basePath, "connection"],
        });
      }
      const allowedConversations = CONVERSATIONS_BY_CONNECTION_KIND[connection.kind];
      binding.conversations.forEach((conversation, index) => {
        if (!allowedConversations.includes(conversation.kind)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `conversation kind "${conversation.kind}" is not carried by connection kind "${connection.kind}".`,
            path: [...basePath, "conversations", index, "kind"],
          });
        }
      });
      const allowedActorTypes = ACTOR_TYPES_BY_CONNECTION_KIND[connection.kind];
      const allowedScopeKinds = SCOPE_ACTOR_KINDS_BY_CONNECTION_KIND[connection.kind];
      binding.actors.forEach((actor, index) => {
        if ("kind" in actor) {
          if (actor.kind !== "any" && !allowedScopeKinds.includes(actor.kind)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `actor scope kind "${actor.kind}" is not resolved by connection kind "${connection.kind}".`,
              path: [...basePath, "actors", index, "kind"],
            });
          }
          return;
        }
        if (!allowedActorTypes.includes(actor.type)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `actor type "${actor.type}" is not authenticated by connection kind "${connection.kind}".`,
            path: [...basePath, "actors", index, "type"],
          });
        }
      });
    }

    // Overlapping enabled bindings would force runtime order or union
    // semantics on the allowlists; the first phase rejects them at parse time
    // (execution contracts §2), which every publish path re-runs.
    const enabled = bindings.filter(([, binding]) => binding.enabled === true);
    for (let i = 0; i < enabled.length; i += 1) {
      for (let j = i + 1; j < enabled.length; j += 1) {
        const [nameA, bindingA] = enabled[i]!;
        const [nameB, bindingB] = enabled[j]!;
        if (bindingA.connection !== bindingB.connection) continue;
        const commandsOverlap = bindingA.commands.some((command) => bindingB.commands.includes(command));
        const actorListsOverlap = bindingA.actors.some((actorA) => bindingB.actors.some((actorB) => actorsOverlap(actorA, actorB)));
        const conversationOverlap = bindingA.conversations.some((convA) => bindingB.conversations.some((convB) => conversationsOverlap(convA, convB)));
        if (commandsOverlap && actorListsOverlap && conversationOverlap) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `enabled bindings "${nameA}" and "${nameB}" overlap on connection "${bindingA.connection}" (same actor, conversation, and command); merge them or narrow the allowlists.`,
            path: ["command_bindings", nameB, "connection"],
          });
        }
      }
    }
  });
export type ImConfig = z.infer<typeof imConfigSchema>;

// ---------------------------------------------------------------------------
// Output-channel extensions
// ---------------------------------------------------------------------------

export const memberDirectoryIdentityScopeSchema = z
  .object({
    kind: z.enum(["wecom_corp", "feishu_app", "feishu_tenant"]),
    id: z.string().min(1),
  })
  .strict();

const feishuApiMemberDirectoryFields = {
  chat_id: z.string().min(1),
  cache_ttl_seconds: z.number().int().min(0).max(604800).optional(),
};

/** Historical shape: `member_directory: {chat_id, cache_ttl_seconds}` stays bit-compatible. */
const legacyFeishuApiMemberDirectorySchema = z
  .object(feishuApiMemberDirectoryFields)
  .strict();

const explicitFeishuApiMemberDirectorySchema = z
  .object({ source: z.literal("feishu_api"), ...feishuApiMemberDirectoryFields })
  .strict();

const fileMemberDirectorySchema = z
  .object({
    source: z.literal("file"),
    /** Resolved against the main config baseDir, never cwd or run dirs. */
    path: z.string().min(1),
    directory_id: imEntityNameSchema,
    identity_scope: memberDirectoryIdentityScopeSchema,
    /** Runtime default: true (watch disabled still keeps periodic reload). */
    watch: z.boolean().optional(),
    /** Runtime default: 300 ms; bounded 50–2000 ms. */
    debounce_ms: z.number().int().min(50).max(2000).optional(),
    /** Runtime default: 30 s; bounded 5–300 s. */
    poll_interval_seconds: z.number().int().min(5).max(300).optional(),
    /** Defaults to the main config baseDir; real-path boundary comparison. */
    allowed_root: z.string().min(1).optional(),
  })
  .strict();

export const channelMemberDirectorySchema = z.union([
  legacyFeishuApiMemberDirectorySchema,
  explicitFeishuApiMemberDirectorySchema,
  fileMemberDirectorySchema,
]);
export type ChannelMemberDirectoryConfig = z.infer<typeof channelMemberDirectorySchema>;

/** WeCom application send target (W2/W6); recipients and appchat are exclusive. */
export const wecomAppTargetSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("recipients"),
        users: z.array(imPlatformIdSchema).max(1000).optional(),
        parties: z.array(z.string().min(1)).max(100).optional(),
        tags: z.array(z.string().min(1)).max(100).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("appchat"),
        chat_id: z.string().min(1),
      })
      .strict(),
  ])
  .superRefine((target, ctx) => {
    if (target.kind === "recipients" && (target.users?.length ?? 0) === 0 && (target.parties?.length ?? 0) === 0 && (target.tags?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "recipients targets need at least one non-empty users/parties/tags list.",
        path: ["users"],
      });
    }
  });
export type WecomAppTargetConfig = z.infer<typeof wecomAppTargetSchema>;
