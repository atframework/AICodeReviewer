import { describe, expect, it, vi } from "vitest";
import { channelIdentityCapability, resolveChannelAuthor, resolveChannelDirectoryCacheTtlSeconds,
	DEFAULT_CHANNEL_DIRECTORY_CACHE_TTL_SECONDS, type ChannelUser } from "../src/channel-identity.js";
import { feishuDirectoryUsers, resolveFeishuMention } from "../src/feishu-members.js";

const users = feishuDirectoryUsers([
	{ open_id: "ou_owent", name: "张三", en_name: "Owent", nickname: "owent", enterprise_email: "admin@owent.net", user_id: "user1", mobile: "13800138000" },
	{ open_id: "ou_other", nickname: "other", email: "other@example.net" },
]);
const directory = { listUsers: async () => users };
const input = { provider: "p4", author: { username: "shared" }, submitterWorkspace: "owent_myrion-pc_6689" };
const p4Users: readonly ChannelUser[] = [...users, {
	id: "ou_ultramanhu", names: ["Ultramanhu"], aliases: ["ultramanhu"], emails: [], identifiers: [],
}];
const p4Input = { provider: "p4", author: { username: "admin" }, submitterWorkspace: "ultramanhu_PrxMain_WorkPC" };
const p4Directory = { listUsers: async () => p4Users };

describe("channel identity capability and conservative association", () => {
	it.each([
		{ username: "admin" },
		{ username: "admin", email: "admin@owent.net" },
		{ username: "owent" },
	])("prefers the P4 submitter workspace over account evidence %j without a model call", async author => {
		const guesser = vi.fn();
		expect(await resolveChannelAuthor({ channelKind: "feishu_app", input: { ...p4Input, author }, directory: p4Directory, guesser }))
			.toEqual({ status: "matched", userId: "ou_ultramanhu" });
		expect(guesser).not.toHaveBeenCalled();
	});
	it("blocks ambiguous P4 workspaces instead of falling back to the shared account or model", async () => {
		const guesser = vi.fn(async () => "ou_owent");
		expect(await resolveChannelAuthor({ channelKind: "feishu_app", input: { ...p4Input, submitterWorkspace: "ultramanhu_owent_PC" }, directory: p4Directory, guesser }))
			.toEqual({ status: "blocked" });
		expect(guesser).not.toHaveBeenCalled();
	});
	it("keeps explicit mappings, blacklists, disabled guesses and non-P4 account precedence", async () => {
		const resolve = (input: typeof p4Input, policy = {}) => resolveChannelAuthor({ channelKind: "feishu_app", input, directory: p4Directory, policy });
		expect(await resolve(p4Input, { mappings: { admin: "ou_owent" } })).toEqual({ status: "matched", userId: "ou_owent" });
		expect(await resolveChannelAuthor({ channelKind: "feishu_app", input: { ...p4Input, author: { username: "admin", email: "blocked@example.net" } }, directory: p4Directory, policy: { emailBlacklist: ["blocked@example.net"] } }))
			.toEqual({ status: "blocked" });
		expect(await resolve(p4Input, { guessAuthor: false })).toEqual({ status: "matched", userId: "ou_owent" });
		expect(await resolve({ ...p4Input, provider: "github" })).toEqual({ status: "matched", userId: "ou_owent" });
		expect(await resolve({ ...p4Input, submitterWorkspace: "unrecognized_PC" })).toEqual({ status: "matched", userId: "ou_owent" });
	});
	it.each(["github_pr_review", "github_issue", "github_problem_issue", "gitea_pr_review", "gitea_issue", "gitea_problem_issue", "gitlab_mr_review"])("keeps %s native and never reads a directory or calls a model", async kind => {
		const listUsers = vi.fn(directory.listUsers);
		const guesser = vi.fn();
		expect(channelIdentityCapability(kind)).toBe("native");
		expect(await resolveChannelAuthor({ channelKind: kind, input, directory: { listUsers }, guesser })).toEqual({ status: "unavailable" });
		expect(listUsers).not.toHaveBeenCalled(); expect(guesser).not.toHaveBeenCalled();
	});
	it.each(["feishu_bot", "wecom_bot"])("does not guess for %s without directory capability", async kind => {
		const listUsers = vi.fn(directory.listUsers); const guesser = vi.fn();
		await resolveChannelAuthor({ channelKind: kind, input, directory: { listUsers }, guesser });
		expect(listUsers).not.toHaveBeenCalled(); expect(guesser).not.toHaveBeenCalled();
	});
	it.each([
		input,
		{ provider: "p4", author: { username: "owent" } },
		{ provider: "github", author: { username: "owent", email: "admin@owent.net" } },
		{ provider: "gitea", author: { username: "owent", email: "admin@owent.net" } },
	])("resolves the user's identities before calling a model: %j", async author => {
		const guesser = vi.fn();
		expect(await resolveChannelAuthor({ channelKind: "feishu_app", input: author, directory, guesser })).toEqual({ status: "matched", userId: "ou_owent" });
		expect(guesser).not.toHaveBeenCalled();
	});
	it("calls the model only for unmatched evidence and checks membership", async () => {
		const unknown = { provider: "p4", author: { username: "shared" }, submitterWorkspace: "zhangsan_desktop" };
		const guesser = vi.fn(async () => "ou_owent");
		expect(await resolveChannelAuthor({ channelKind: "feishu_app", input: unknown, directory, guesser })).toEqual({ status: "matched", userId: "ou_owent" });
		expect(guesser).toHaveBeenCalledWith(unknown, users);
		for (const id of [undefined, "ou_outsider", "all", '<at id="ou_owent"></at>']) {
			expect(await resolveChannelAuthor({ channelKind: "feishu_app", input: unknown, directory, guesser: async () => id })).toEqual({ status: "blocked" });
		}
	});
	it("disabling guesses keeps exact email and explicit mapping but skips workspace heuristics and the model", async () => {
		const guesser = vi.fn();
		expect(await resolveChannelAuthor({ channelKind: "feishu_app", input, directory, policy: { guessAuthor: false }, guesser })).toEqual({ status: "unmatched" });
		expect(guesser).not.toHaveBeenCalled();
		expect(resolveFeishuMention({ author: { email: "admin@owent.net" } }, [{ open_id: "ou_owent", email: "admin@owent.net" }], { guessAuthor: false })).toContain("ou_owent");
		expect(await resolveChannelAuthor({ channelKind: "feishu_app", input, policy: { guessAuthor: false, mappings: { shared: "ou_owent" } }, guesser })).toEqual({ status: "matched", userId: "ou_owent" });
	});
	it("blocks ambiguous exact identities, blacklisted emails and delivery-actor-only data without model override", async () => {
		const guesser = vi.fn();
		const duplicate: ChannelUser = { ...users[0]!, id: "ou_duplicate" };
		expect(await resolveChannelAuthor({ channelKind: "feishu_app", input: { author: { email: "admin@owent.net" } }, directory: { listUsers: async () => [...users, duplicate] }, guesser })).toEqual({ status: "blocked" });
		const listUsers = vi.fn(directory.listUsers);
		await resolveChannelAuthor({ channelKind: "feishu_app", input: { author: { email: "admin@owent.net" } }, directory: { listUsers }, policy: { emailBlacklist: ["ADMIN@OWENT.NET"] }, guesser });
		await resolveChannelAuthor({ channelKind: "feishu_app", input: { author: { fallbackUsername: "owent" } }, directory: { listUsers }, guesser });
		expect(listUsers).not.toHaveBeenCalled(); expect(guesser).not.toHaveBeenCalled();
	});
	it("never calls the model without a directory or with an empty directory", async () => {
		const guesser = vi.fn();
		await resolveChannelAuthor({ channelKind: "feishu_app", input, guesser });
		await resolveChannelAuthor({ channelKind: "feishu_app", input, directory: { listUsers: async () => [] }, guesser });
		expect(guesser).not.toHaveBeenCalled();
	});
});

describe("channel directory cache TTL resolution", () => {
	it("prefers the channel value over the global value over the 12h default, keeping 0 as a real value", () => {
		expect(DEFAULT_CHANNEL_DIRECTORY_CACHE_TTL_SECONDS).toBe(43_200);
		expect(resolveChannelDirectoryCacheTtlSeconds({})).toBe(43_200);
		expect(resolveChannelDirectoryCacheTtlSeconds({ global: 86_400 })).toBe(86_400);
		expect(resolveChannelDirectoryCacheTtlSeconds({ global: 0 })).toBe(0);
		expect(resolveChannelDirectoryCacheTtlSeconds({ channel: 300, global: 86_400 })).toBe(300);
		expect(resolveChannelDirectoryCacheTtlSeconds({ channel: 0, global: 604_800 })).toBe(0);
	});
});
