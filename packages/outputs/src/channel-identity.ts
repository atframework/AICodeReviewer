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

export function channelIdentityCapability(kind: string): "native" | "directory" | "unavailable" {
	if (kind === "feishu_app") return "directory";
	if (["github_issue", "github_problem_issue", "github_pr_review", "gitlab_mr_review", "gitlab_problem_issue", "gitea_issue", "gitea_problem_issue", "gitea_pr_review"].includes(kind)) return "native";
	return "unavailable";
}

const normalized = (value: string): string => value.normalize("NFKC").trim().toLowerCase();
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
	if (channelIdentityCapability(options.channelKind) !== "directory") return { status: "unavailable" };
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
