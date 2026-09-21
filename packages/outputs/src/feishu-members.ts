import { matchChannelAuthor, type ChannelAuthorInput, type ChannelAuthorMatch, type ChannelAuthorOptions, type ChannelUser } from "./channel-identity.js";

/** Only fields needed for attribution; never persist or log directory records. */
export interface FeishuMember {
	readonly open_id: string;
	readonly user_id?: string;
	readonly union_id?: string;
	readonly name?: string;
	readonly en_name?: string;
	readonly nickname?: string;
	readonly email?: string;
	readonly enterprise_email?: string;
	readonly mobile?: string;
}

export type FeishuMentionInput = ChannelAuthorInput;

export interface FeishuMentionOptions extends ChannelAuthorOptions {
	readonly mentionFallback?: "all" | "skip" | undefined;
}

export function feishuDirectoryUsers(members: readonly FeishuMember[]): ChannelUser[] {
	const present = (values: readonly (string | undefined)[]): string[] => values.filter((value): value is string => !!value);
	return members.map(member => ({
		id: member.open_id, names: present([member.name, member.en_name]), aliases: present([member.nickname]),
		emails: present([member.email, member.enterprise_email]), identifiers: present([member.user_id, member.union_id, member.mobile]),
	}));
}

export function renderFeishuAuthorMention(match: ChannelAuthorMatch, fallback?: "all" | "skip"): string {
	if (match.status === "matched") return /^ou_[A-Za-z0-9_-]+$/u.test(match.userId) ? `<at id="${match.userId}"></at>` : "";
	return match.status === "unmatched" && fallback === "all" ? '<at id="all"></at>' : "";
}

/** A tier with multiple candidates blocks weaker guesses. No edit-distance matching. */
export function resolveFeishuMention(
	input: FeishuMentionInput,
	members: readonly FeishuMember[] | undefined,
	options: FeishuMentionOptions = {},
): string {
	return renderFeishuAuthorMention(matchChannelAuthor(input, members ? feishuDirectoryUsers(members) : undefined, options), options.mentionFallback);
}
