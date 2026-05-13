import { describe, expect, it } from "vitest";

import {
	buildAtMentions,
	renderMentions,
	resolveAuthorUsername,
	type AuthorMentionContext,
	type AuthorResolutionOptions,
} from "../src/author-resolution.js";

describe("resolveAuthorUsername", () => {
	it("returns username when present", () => {
		const ctx: AuthorMentionContext = { author: { username: "owent" } };
		expect(resolveAuthorUsername(ctx)).toBe("owent");
	});

	it("returns undefined when no author", () => {
		expect(resolveAuthorUsername({})).toBeUndefined();
	});

	it("resolves email via mapping when username is absent", () => {
		const ctx: AuthorMentionContext = { author: { email: "owent@example.com" } };
		const opts: AuthorResolutionOptions = {
			emailMappings: { "owent@example.com": "owent" },
		};
		expect(resolveAuthorUsername(ctx, opts)).toBe("owent");
	});

	it("returns undefined for blacklisted email", () => {
		const ctx: AuthorMentionContext = { author: { email: "blocked@example.com", username: "blocked" } };
		const opts: AuthorResolutionOptions = {
			emailBlacklist: new Set(["blocked@example.com"]),
		};
		expect(resolveAuthorUsername(ctx, opts)).toBeUndefined();
	});

	it("matches email mappings and blacklist entries case-insensitively", () => {
		const ctx: AuthorMentionContext = { author: { email: "Owent@Example.com" } };
		const opts: AuthorResolutionOptions = {
			emailMappings: { "owent@example.com": "ou_dev" },
		};
		expect(resolveAuthorUsername(ctx, opts)).toBe("ou_dev");
		expect(resolveAuthorUsername(ctx, { emailBlacklist: new Set(["owent@example.com"]) })).toBeUndefined();
	});

	it("prefers username over email mapping", () => {
		const ctx: AuthorMentionContext = { author: { username: "real", email: "other@example.com" } };
		const opts: AuthorResolutionOptions = {
			emailMappings: { "other@example.com": "mapped" },
		};
		expect(resolveAuthorUsername(ctx, opts)).toBe("real");
	});

	it("returns undefined when no resolution is possible", () => {
		const ctx: AuthorMentionContext = { author: { email: "unknown@example.com" } };
		expect(resolveAuthorUsername(ctx)).toBeUndefined();
	});
});

describe("renderMentions", () => {
	it("renders GitHub-style mentions by default", () => {
		expect(renderMentions(["alice", "bob"], "github_pr_review")).toBe("@alice @bob");
	});

	it("renders GitHub issue mentions", () => {
		expect(renderMentions(["alice"], "github_issue")).toBe("@alice");
		expect(renderMentions(["alice"], "github_problem_issue")).toBe("@alice");
	});

	it("renders Gitea-style mentions", () => {
		expect(renderMentions(["alice"], "gitea_pr_review")).toBe("@alice");
	});

	it("renders GitLab-style mentions", () => {
		expect(renderMentions(["alice"], "gitlab_mr_review")).toBe("@alice");
	});

	it("renders Feishu at-tags", () => {
		expect(renderMentions(["ou_xxx"], "feishu_bot")).toBe('<at user_id="ou_xxx"></at>');
	});

	it("renders WeCom at-tags", () => {
		expect(renderMentions(["alice"], "wecom_bot")).toBe("<@alice>");
	});

	it("returns empty string for empty usernames", () => {
		expect(renderMentions([], "github_pr_review")).toBe("");
	});
});

describe("buildAtMentions", () => {
	it("builds mention string for resolved author", () => {
		const ctx: AuthorMentionContext = { author: { username: "owent" } };
		expect(buildAtMentions(ctx, "github_pr_review")).toBe("@owent");
	});

	it("includes the display name for Git-based mentions when available", () => {
		const ctx: AuthorMentionContext = { author: { username: "owent", displayName: "OwEnt" } };
		expect(buildAtMentions(ctx, "github_pr_review")).toBe("@owent (OwEnt)");
		expect(buildAtMentions(ctx, "gitea_issue")).toBe("@owent (OwEnt)");
	});

	it("does not repeat the display name when it matches the username", () => {
		const ctx: AuthorMentionContext = { author: { username: "owent", displayName: "owent" } };
		expect(buildAtMentions(ctx, "github_pr_review")).toBe("@owent");
	});

	it("returns empty string when author cannot be resolved", () => {
		const ctx: AuthorMentionContext = { author: { email: "unknown@example.com" } };
		expect(buildAtMentions(ctx, "github_pr_review")).toBe("");
	});

	it("renders Feishu all fallback when configured and author cannot be resolved", () => {
		const ctx: AuthorMentionContext = { author: { email: "unknown@example.com" } };
		expect(buildAtMentions(ctx, "feishu_bot", { mentionFallback: "all" })).toBe(
			'<at user_id="all"></at>',
		);
	});

	it("renders WeCom all fallback when configured and author cannot be resolved", () => {
		const ctx: AuthorMentionContext = { author: { email: "unknown@example.com" } };
		expect(buildAtMentions(ctx, "wecom_bot", { mentionFallback: "all" })).toBe("<@all>");
	});

	it("does not render all fallback for Git-based review channels", () => {
		const ctx: AuthorMentionContext = { author: { email: "unknown@example.com" } };
		expect(buildAtMentions(ctx, "github_pr_review", { mentionFallback: "all" })).toBe("");
		expect(buildAtMentions(ctx, "github_issue", { mentionFallback: "all" })).toBe("");
		expect(buildAtMentions(ctx, "github_problem_issue", { mentionFallback: "all" })).toBe("");
	});

	it("does not fallback when author email is blacklisted", () => {
		const ctx: AuthorMentionContext = { author: { email: "blocked@example.com" } };
		expect(buildAtMentions(ctx, "feishu_bot", {
			emailBlacklist: new Set(["blocked@example.com"]),
			mentionFallback: "all",
		})).toBe("");
	});

	it("returns empty string when no author", () => {
		expect(buildAtMentions({}, "feishu_bot")).toBe("");
	});
});
