import type { AuthorMentionContext } from "./author-resolution.js";

/** Directory data stays outside review prompts and durable review records. */
export interface ChannelUser {
	readonly id: string;
	readonly names: readonly string[];
	readonly aliases: readonly string[];
	readonly emails: readonly string[];
	readonly identifiers: readonly string[];
}

export interface ChannelAuthorInput extends AuthorMentionContext {
	readonly provider?: string | undefined;
	readonly submitterWorkspace?: string | undefined;
	/** Accepting trigger name; scopes directory vcs_accounts (D11). */
	readonly sourceTrigger?: string | undefined;
}

export interface ChannelAuthorOptions {
	readonly mappings?: Readonly<Record<string, string>> | undefined;
	readonly emailBlacklist?: readonly string[] | undefined;
	readonly guessAuthor?: boolean | undefined;
}

export type ChannelAuthorMatch =
	| { readonly status: "matched"; readonly userId: string }
	| { readonly status: "unmatched" | "blocked" | "unavailable" };

export type ChannelAuthorGuesser = (
	input: ChannelAuthorInput, users: readonly ChannelUser[],
) => Promise<string | undefined>;

export interface ChannelUserDirectory {
	listUsers(): Promise<readonly ChannelUser[]>;
}

/** Default member-directory snapshot TTL: 12 hours. `0` disables reuse. */
export const DEFAULT_CHANNEL_DIRECTORY_CACHE_TTL_SECONDS = 43_200;

/**
 * Shared TTL resolution for directory-capable channels: the channel-level
 * `member_directory.cache_ttl_seconds` wins over the global
 * `outputs.author_resolution.directory_cache_ttl_seconds`, which wins over
 * the 12h runtime default. Validated ranges (0..604800) come from the config
 * schema; values arrive here only after schema parsing.
 */
export function resolveChannelDirectoryCacheTtlSeconds(options: {
	readonly channel?: number | undefined;
	readonly global?: number | undefined;
}): number {
	return options.channel ?? options.global ?? DEFAULT_CHANNEL_DIRECTORY_CACHE_TTL_SECONDS;
}

/**
 * Identity capability is decided by the CONFIGURED SOURCE, not the bare kind
 * (member-directory design §1.2): IM channels gain directory matching once a
 * member_directory (API or file) is configured; feishu_app keeps its built-in
 * API directory; git channels stay native.
 */
export function channelIdentityCapability(kind: string, options?: { readonly directoryConfigured?: boolean | undefined }): "native" | "directory" | "unavailable" {
	if (kind === "feishu_app") return "directory";
	if (options?.directoryConfigured === true && ["wecom_bot", "wecom_app", "feishu_bot"].includes(kind)) return "directory";
	if (["github_issue", "github_problem_issue", "github_pr_review", "gitlab_mr_review", "gitlab_problem_issue", "gitea_issue", "gitea_problem_issue", "gitea_pr_review"].includes(kind)) return "native";
	return "unavailable";
}

const normalized = (value: string): string => value.normalize("NFKC").trim().toLowerCase();

/**
 * File-directory members as channel users: the local member key is the opaque
 * candidate id (safe for prompts and logs); typed platform mention ids and
 * scoped vcs accounts ride along for rendering and exact matching (D11/D14).
 */
export interface MemberDirectoryChannelUser extends ChannelUser {
	readonly mentionType: "wecom_userid" | "wecom_mobile" | "feishu_open_id" | "feishu_user_id";
	readonly mentionId: string;
	readonly vcsAccounts: readonly { sourceTrigger: string; username: string }[];
}

export function memberDirectoryChannelUsers(
	members: readonly { key: string; displayName?: string | undefined; aliases: readonly string[]; emails: readonly string[];
		vcsAccounts: readonly { sourceTrigger: string; username: string }[]; mention: { type: MemberDirectoryChannelUser["mentionType"]; id: string } }[],
): MemberDirectoryChannelUser[] {
	return members.map(member => ({
		id: member.key,
		names: member.displayName !== undefined ? [member.displayName] : [],
		aliases: [...member.aliases],
		emails: [...member.emails],
		identifiers: [member.mention.id, ...member.vcsAccounts.map(account => `${account.sourceTrigger}:${account.username}`)],
		mentionType: member.mention.type,
		mentionId: member.mention.id,
		vcsAccounts: member.vcsAccounts.map(account => ({ sourceTrigger: account.sourceTrigger, username: account.username })),
	}));
}

/** Typed platform mention markup for a resolved directory member (D14). */
export function renderMemberDirectoryMention(
	channelKind: string,
	member: { mentionType: MemberDirectoryChannelUser["mentionType"]; mentionId: string },
): { kind: "inline"; markup: string } | { kind: "text_reminder"; mobile: string } | { kind: "unsupported" } {
	if (member.mentionType === "wecom_mobile") return { kind: "text_reminder", mobile: member.mentionId };
	if (channelKind === "wecom_bot" || channelKind === "wecom_app") {
		return member.mentionType === "wecom_userid" ? { kind: "inline", markup: `<@${member.mentionId}>` } : { kind: "unsupported" };
	}
	if (channelKind === "feishu_bot" || channelKind === "feishu_app") {
		return member.mentionType === "feishu_open_id" || member.mentionType === "feishu_user_id"
			? { kind: "inline", markup: `<at id="${member.mentionId}"></at>` }
			: { kind: "unsupported" };
	}
	return { kind: "unsupported" };
}
const words = (value: string): string => normalized(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const identifiers = (user: ChannelUser): readonly string[] => [
	user.id, ...user.identifiers, ...user.names, ...user.aliases, ...user.emails,
	...user.emails.map(email => email.split("@")[0]!),
];

/** Ambiguous tiers block weaker guesses, including the model fallback. */
export function matchChannelAuthor(
	input: ChannelAuthorInput, users: readonly ChannelUser[] | undefined, options: ChannelAuthorOptions = {},
): ChannelAuthorMatch {
	const author = input.author;
	if (author?.email && options.emailBlacklist?.some(email => normalized(email) === normalized(author.email!))) return { status: "blocked" };
	const candidates = [author?.email, author?.username, author?.displayName, input.submitterWorkspace]
		.filter((value): value is string => !!value?.trim());
	if (!candidates.length) return { status: "blocked" };
	const choose = (ids: readonly string[]): ChannelAuthorMatch => {
		const unique = [...new Set(ids)];
		return unique.length === 1 ? { status: "matched", userId: unique[0]! } : { status: "blocked" };
	};
	const mapped = Object.entries(options.mappings ?? {}).filter(([key]) => candidates.some(c => normalized(c) === normalized(key)));
	if (mapped.length) {
		const ids = mapped.map(([, id]) => id);
		if (users && ids.some(id => !users.some(user => user.id === id))) return { status: "blocked" };
		return choose(ids);
	}
	if (!users) return { status: "unmatched" };
	const accountTiers = [
		// Exact scoped VCS account wins over every fuzzy tier (D11): the
		// accepting trigger isolates same-named users across Git servers.
		users.filter(user => "vcsAccounts" in user && input.sourceTrigger !== undefined && author?.username
			&& (user as MemberDirectoryChannelUser).vcsAccounts.some(account =>
				account.sourceTrigger === input.sourceTrigger && normalized(account.username) === normalized(author.username!))),
		users.filter(user => author?.email && user.emails.some(email => normalized(email) === normalized(author.email!))),
		users.filter(user => [author?.username, author?.displayName].some(value => value && identifiers(user)
			.some(id => normalized(id) === normalized(value)))),
	];
	const workspaceTier = users.filter(user => {
		if (options.guessAuthor === false || !input.submitterWorkspace) return false;
		const workspace = ` ${words(input.submitterWorkspace)} `;
		return identifiers(user).some(id => {
			const token = words(id);
			const enough = token.replace(/ /gu, "").length >= 3 || /^[\p{Script=Han}]{2,}$/u.test(token);
			return enough && workspace.includes(` ${token} `);
		});
	});
	// P4 accounts can be shared; an account/email-prefix match must not hide
	// the submitting client's owner or resolve an ambiguous workspace tier.
	const tiers = input.provider === "p4"
		? [workspaceTier, ...accountTiers]
		: [...accountTiers, workspaceTier];
	for (const tier of tiers) if (tier.length) return choose(tier.map(user => user.id));
	return { status: "unmatched" };
}

export async function resolveChannelAuthor(options: {
	readonly channelKind: string;
	readonly input: ChannelAuthorInput;
	readonly directory?: ChannelUserDirectory | undefined;
	readonly policy?: ChannelAuthorOptions | undefined;
	readonly guesser?: ChannelAuthorGuesser | undefined;
}): Promise<ChannelAuthorMatch> {
	if (channelIdentityCapability(options.channelKind, { directoryConfigured: options.directory !== undefined }) !== "directory") return { status: "unavailable" };
	const initial = matchChannelAuthor(options.input, undefined, options.policy);
	if (initial.status === "blocked") return initial;
	const users = await options.directory?.listUsers();
	const known = matchChannelAuthor(options.input, users, options.policy);
	if (known.status !== "unmatched" || options.policy?.guessAuthor === false || !users?.length || !options.guesser) return known;
	try {
		const id = await options.guesser(options.input, users);
		return id && users.some(user => user.id === id) ? { status: "matched", userId: id } : { status: "blocked" };
	} catch {
		return { status: "blocked" };
	}
}
