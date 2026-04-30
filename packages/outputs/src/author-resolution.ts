export interface AuthorMentionContext {
	readonly author?: {
		readonly username?: string | undefined;
		readonly email?: string | undefined;
		readonly displayName?: string | undefined;
	};
}

export interface AuthorResolutionOptions {
	readonly emailMappings?: Readonly<Record<string, string>>;
	readonly emailBlacklist?: ReadonlySet<string>;
	readonly mentionFallback?: "all" | "skip";
}

export type MentionChannelKind =
	| "gitea_pr_review"
	| "github_pr_review"
	| "gitlab_mr_review"
	| "gitea_issue"
	| "feishu_bot"
	| "wecom_bot";

function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

function isEmailBlacklisted(email: string, blacklist: ReadonlySet<string> | undefined): boolean {
	if (!blacklist) {
		return false;
	}

	return blacklist.has(email) || blacklist.has(normalizeEmail(email));
}

function resolveEmailMapping(email: string, mappings: Readonly<Record<string, string>> | undefined): string | undefined {
	if (!mappings) {
		return undefined;
	}

	return mappings[email] ?? mappings[normalizeEmail(email)];
}

export function resolveAuthorUsername(
	context: AuthorMentionContext,
	opts?: AuthorResolutionOptions,
): string | undefined {
	const { author } = context;
	if (!author) {
		return undefined;
	}

	if (author.email && isEmailBlacklisted(author.email, opts?.emailBlacklist)) {
		return undefined;
	}

	if (author.username) {
		return author.username;
	}

	if (author.email) {
		const mapped = resolveEmailMapping(author.email, opts?.emailMappings);
		if (mapped) {
			return mapped;
		}
	}

	return undefined;
}

function renderFallbackMention(channelKind: MentionChannelKind): string {
	switch (channelKind) {
		case "feishu_bot":
			return '<at user_id="all"></at>';
		case "wecom_bot":
			return "<@all>";
		case "gitea_pr_review":
		case "github_pr_review":
		case "gitlab_mr_review":
		case "gitea_issue":
		default:
			return "";
	}
}

export function renderMentions(
	usernames: readonly string[],
	channelKind: MentionChannelKind,
): string {
	if (usernames.length === 0) {
		return "";
	}

	switch (channelKind) {
		case "feishu_bot":
			return usernames.map((u) => `<at user_id="${u}"></at>`).join(" ");
		case "wecom_bot":
			return usernames.map((u) => `<@${u}>`).join(" ");
		case "gitea_pr_review":
		case "github_pr_review":
		case "gitlab_mr_review":
		case "gitea_issue":
		default:
			return usernames.map((u) => `@${u}`).join(" ");
	}
}

export function buildAtMentions(
	context: AuthorMentionContext,
	channelKind: MentionChannelKind,
	opts?: AuthorResolutionOptions,
): string {
	if (!context.author) {
		return "";
	}

	if (context.author.email && isEmailBlacklisted(context.author.email, opts?.emailBlacklist)) {
		return "";
	}

	const username = resolveAuthorUsername(context, opts);
	if (!username) {
		if (opts?.mentionFallback === "all") {
			return renderFallbackMention(channelKind);
		}

		return "";
	}

	return renderMentions([username], channelKind);
}
