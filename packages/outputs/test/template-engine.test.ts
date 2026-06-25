import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	buildTemplateTargetContext,
	clearTemplateCache,
	createTemplateResolver,
	getBuiltinTemplate,
	renderBuiltinTemplate,
	renderTemplate,
	toTemplateProblem,
	type TemplateContext,
} from "../src/template-engine.js";

const sampleProblem = {
	file: "src/app.ts",
	line: 42,
	severity: "high",
	category: "correctness",
	message: "Bug found.",
	suggestion: "Fix it.",
	codeSnippet: "if (!ready) {\n\treturn;\n}",
	codeLanguage: "ts",
	fingerprint: "fp-1",
};

const sampleContext: TemplateContext = {
	event: {
		author: "dev",
		displayName: "Developer",
		url: "https://gitea.example/owent/example/pulls/1",
		title: "Add feature",
	},
	target: buildTemplateTargetContext({
		kind: "pull_request",
		provider: "gitea",
		repoRef: "owent/example",
		title: "Add feature",
		url: "https://gitea.example/owent/example/pulls/1",
	}),
	repo: {
		name: "example",
		fullName: "owent/example",
	},
	run: { id: "run-abc" },
	atMentions: "@dev (Developer)",
	problems: [toTemplateProblem(sampleProblem)],
	summary: "Overall the PR looks good with one problem.",
	summaryTitle: "Focused review summary",
};

describe("toTemplateProblem", () => {
	it("converts a problem with all fields", () => {
		const result = toTemplateProblem(sampleProblem);

		expect(result.severity).toBe("HIGH");
		expect(result.location).toBe("src/app.ts:42");
		expect(result.fingerprint).toBe("fp-1");
		expect(result.suggestion).toBe("Fix it.");
		expect(result.codeLanguage).toBe("ts");
		expect(result.codeFence).toContain("```ts");
		expect(result.codeFence).toContain("if (!ready)");
	});

	it("renders range location when endLine is present", () => {
		const result = toTemplateProblem({ ...sampleProblem, endLine: 50 });

		expect(result.location).toBe("src/app.ts:42-50");
	});

	it("omits optional fields when not present", () => {
		const result = toTemplateProblem({
			file: "a.ts",
			line: 1,
			severity: "low",
			category: "style",
			message: "naming",
		});

		expect(result.suggestion).toBeUndefined();
		expect(result.fingerprint).toBeUndefined();
		expect(result.endLine).toBeUndefined();
	});
});

describe("buildTemplateTargetContext", () => {
	it("builds a PR target link without a generic View PR label", () => {
		const target = buildTemplateTargetContext({
			kind: "pull_request",
			provider: "gitea",
			title: "Fix parser",
			url: "https://gitea.example/owent/example/pulls/42",
		});

		expect(target.displayText).toBe("Fix parser");
		expect(target.id).toBe("42");
		expect(target.markdownLink).toBe("[Fix parser](https://gitea.example/owent/example/pulls/42)");
	});

	it("derives a GitLab commit URL for push events", () => {
		const target = buildTemplateTargetContext({
			kind: "push",
			provider: "gitlab",
			repoRef: "group/project",
			headRevision: "abcdef1234567890",
			baseUrl: "https://gitlab.example",
		});

		expect(target.displayText).toBe("Commit abcdef123456");
		expect(target.url).toBe("https://gitlab.example/group/project/-/commit/abcdef1234567890");
		expect(target.markdownLink).toContain("Commit abcdef123456");
	});

	it("uses configured P4 changelist URL templates", () => {
		const target = buildTemplateTargetContext({
			kind: "commit",
			provider: "p4",
			headRevision: "6251",
			changeUrlTemplate: "https://swarm.example.com/changes/{{revision}}",
		});

		expect(target.displayText).toBe("P4 CL 6251");
		expect(target.markdownLink).toBe("[P4 CL 6251](https://swarm.example.com/changes/6251)");
	});

	it("keeps scheduled targets as plain text when no URL exists", () => {
		const target = buildTemplateTargetContext({ kind: "scheduled" });

		expect(target.displayText).toBe("Scheduled review");
		expect(target.markdownLink).toBeUndefined();
	});

	it("builds a GitHub PR target link", () => {
		const target = buildTemplateTargetContext({
			kind: "pull_request",
			provider: "github",
			title: "Fix parser",
			url: "https://github.com/owner/repo/pull/42",
		});

		expect(target.label).toBe("PR");
		expect(target.id).toBe("42");
		expect(target.displayText).toBe("Fix parser");
		expect(target.markdownLink).toBe("[Fix parser](https://github.com/owner/repo/pull/42)");
	});

	it("renders a GitLab MR with the !id fallback when no title is set", () => {
		const target = buildTemplateTargetContext({
			kind: "pull_request",
			provider: "gitlab",
			url: "https://gitlab.example/group/project/-/merge_requests/9",
		});

		expect(target.label).toBe("MR");
		expect(target.id).toBe("9");
		expect(target.displayText).toBe("MR !9");
		expect(target.markdownLink).toBe("[MR !9](https://gitlab.example/group/project/-/merge_requests/9)");
	});

	it("renders a Gitea PR with the #id fallback when no title is set", () => {
		const target = buildTemplateTargetContext({
			kind: "pull_request",
			provider: "gitea",
			url: "https://gitea.example/owent/example/pulls/7",
		});

		expect(target.label).toBe("PR");
		expect(target.id).toBe("7");
		expect(target.displayText).toBe("PR #7");
	});

	it("falls back to a plain PR review target label when no id or title is available", () => {
		const target = buildTemplateTargetContext({ kind: "pull_request", provider: "github" });

		expect(target.displayText).toBe("PR review target");
		expect(target.id).toBeUndefined();
		expect(target.markdownLink).toBeUndefined();
	});

	it("renders an issue target with an Issue #id label", () => {
		const target = buildTemplateTargetContext({
			kind: "issue",
			provider: "gitea",
			url: "https://gitea.example/owent/example/issues/5",
		});

		expect(target.label).toBe("Issue");
		expect(target.id).toBe("5");
		expect(target.displayText).toBe("Issue #5");
		expect(target.markdownLink).toBe("[Issue #5](https://gitea.example/owent/example/issues/5)");
	});

	it("renders an SVN revision as plain text without a derived URL", () => {
		const target = buildTemplateTargetContext({
			kind: "commit",
			provider: "svn",
			headRevision: "12345",
		});

		expect(target.label).toBe("SVN revision");
		expect(target.displayText).toBe("SVN r12345");
		expect(target.url).toBeUndefined();
		expect(target.markdownLink).toBeUndefined();
	});

	it("derives a GitHub push commit URL from base URL and repo ref", () => {
		const target = buildTemplateTargetContext({
			kind: "push",
			provider: "github",
			repoRef: "owner/repo",
			headRevision: "abcdef1234567890",
			baseUrl: "https://github.example",
		});

		expect(target.displayText).toBe("Commit abcdef123456");
		expect(target.url).toBe("https://github.example/owner/repo/commit/abcdef1234567890");
		expect(target.markdownLink).toBe("[Commit abcdef123456](https://github.example/owner/repo/commit/abcdef1234567890)");
	});

	it("derives a Gitea push commit URL from base URL and repo ref", () => {
		const target = buildTemplateTargetContext({
			kind: "push",
			provider: "gitea",
			repoRef: "owent/example",
			headRevision: "0123456789abcdef",
			baseUrl: "https://gitea.example",
		});

		expect(target.displayText).toBe("Commit 0123456789ab");
		expect(target.url).toBe("https://gitea.example/owent/example/commit/0123456789abcdef");
	});

	it("defaults an omitted kind to a plain manual review target", () => {
		const target = buildTemplateTargetContext({ provider: "github" });

		expect(target.kind).toBe("manual");
		expect(target.label).toBe("Manual review");
		expect(target.displayText).toBe("Manual review");
		expect(target.markdownLink).toBeUndefined();
	});

	it("prefers an explicit commit URL template over the derived commit URL", () => {
		const target = buildTemplateTargetContext({
			kind: "commit",
			provider: "github",
			repoRef: "owner/repo",
			headRevision: "abc123",
			baseUrl: "https://github.example",
			commitUrlTemplate: "https://custom.example/c/{{revision}}",
		});

		expect(target.url).toBe("https://custom.example/c/abc123");
		expect(target.markdownLink).toBe("[Commit abc123](https://custom.example/c/abc123)");
	});
});

describe("getBuiltinTemplate", () => {
	it("returns a non-empty string for gitea_pr_review summary", () => {
		expect(getBuiltinTemplate("gitea_pr_review", "summary").length).toBeGreaterThan(0);
	});

	it("returns a non-empty string for gitea_pr_review problem", () => {
		expect(getBuiltinTemplate("gitea_pr_review", "problem").length).toBeGreaterThan(0);
	});

	it("returns gitea_pr_review as fallback for unknown channel kind", () => {
		const fallback = getBuiltinTemplate("unknown_channel", "summary");
		const expected = getBuiltinTemplate("gitea_pr_review", "summary");
		expect(fallback).toBe(expected);
	});

	it("has templates for all channel kinds in Plan.md §3.9.1", () => {
		const channelKinds = [
			"gitea_pr_review",
			"gitea_issue",
			"github_pr_review",
			"gitlab_mr_review",
			"feishu_bot",
			"wecom_bot",
		];

		for (const kind of channelKinds) {
			expect(getBuiltinTemplate(kind, "summary").length).toBeGreaterThan(0);
			expect(getBuiltinTemplate(kind, "problem").length).toBeGreaterThan(0);
		}
	});
});

describe("renderTemplate", () => {
	it("renders a simple Handlebars template", () => {
		const result = renderTemplate("Hello {{event.author}}!", { event: { author: "dev" } });
		expect(result).toBe("Hello dev!");
	});

	it("handles missing context gracefully", () => {
		const result = renderTemplate("Hello {{event.author}}!", {});
		expect(result).toBe("Hello !");
	});

	it("caches compiled template by cacheKey to avoid recompilation", () => {
		clearTemplateCache();
		const source = "Value: {{run.id}}";
		const result1 = renderTemplate(source, { run: { id: "r1" } }, "test-key-dedupe");
		expect(result1).toBe("Value: r1");

		const result2 = renderTemplate(source, { run: { id: "r2" } }, "test-key-dedupe");
		expect(result2).toBe("Value: r2");
	});
});

describe("renderBuiltinTemplate", () => {
	it("renders gitea_pr_review summary with full context", () => {
		const result = renderBuiltinTemplate("gitea_pr_review", "summary", sampleContext);

		expect(result).toContain("AI Code Review Summary");
		expect(result).toContain("Focused review summary");
		expect(result).toContain("Add feature");
		expect(result).toContain("**Target**: [Add feature](https://gitea.example/owent/example/pulls/1)");
		expect(result).toContain("**Author**: @dev (Developer)");
		expect(result).toContain("**Reviewers**: @dev (Developer)");
		expect(result).toContain("Bug found.");
		expect(result).toContain("run-abc");
		expect(result).toContain("1");
	});

	it("renders gitea_pr_review problem with suggestion and fingerprint", () => {
		const ctx: TemplateContext = {
			problem: toTemplateProblem(sampleProblem),
		};
		const result = renderBuiltinTemplate("gitea_pr_review", "problem", ctx);

		expect(result).toContain("HIGH");
		expect(result).toContain("correctness");
		expect(result).toContain("Bug found.");
		expect(result).toContain("Suggested fix:");
		expect(result).toContain("Fix it.");
		expect(result).toContain("Referenced code");
		expect(result).toContain("```ts");
		expect(result).toContain("aicr:fingerprint=fp-1");
	});

	it("renders gitea_issue summary with numbered problems", () => {
		const result = renderBuiltinTemplate("gitea_issue", "summary", sampleContext);

		expect(result).toContain("AI Code Review Report");
		expect(result).toContain("Focused review summary");
		expect(result).toContain("**Author**: @dev (Developer)");
		expect(result).toContain("[HIGH]");
		expect(result).toContain("correctness");
		expect(result).toContain("`src/app.ts:42`");
		expect(result).toContain("Referenced code");
		expect(result).toContain("if (!ready)");
	});

	it("renders feishu_bot summary", () => {
		const result = renderBuiltinTemplate("feishu_bot", "summary", sampleContext);

		expect(result).toContain("Focused review summary");
		expect(result).toContain("Add feature");
		expect(result).toContain("## Review target");
		expect(result).toContain("## Summary");
		expect(result).toContain("- Author: @dev (Developer)");
		expect(result).toContain("https://gitea.example/owent/example/pulls/1");
		expect(result).toContain("Overall the PR looks good with one problem.");
	});

	it("renders feishu_bot auto-summary when summary is empty", () => {
		const result = renderBuiltinTemplate("feishu_bot", "summary", {
			...sampleContext,
			summary: "",
		});

		expect(result).toContain("Add feature");
		expect(result).toContain("Review completed:");
		expect(result).toContain("1 issue(s) found");
		expect(result).toContain("[HIGH]");
	});

	it("renders feishu_bot without Problems count duplication", () => {
		const result = renderBuiltinTemplate("feishu_bot", "summary", sampleContext);
		const count = (result.match(/Problems:/gu) ?? []).length;
		expect(count).toBe(0);
	});

	it("renders commit targets without View PR wording", () => {
		const result = renderBuiltinTemplate("feishu_bot", "summary", {
			target: buildTemplateTargetContext({
				kind: "commit",
				provider: "p4",
				headRevision: "6285",
				changeUrlTemplate: "https://swarm.example.com/changes/{{revision}}",
			}),
			problems: [],
			summary: "No actionable problems.",
		});

		expect(result).toContain("P4 CL 6285");
		expect(result).toContain("https://swarm.example.com/changes/6285");
		expect(result).not.toContain("View PR");
		expect(result).not.toContain("View changes");
	});

	it("renders wecom_bot summary", () => {
		const result = renderBuiltinTemplate("wecom_bot", "summary", sampleContext);

		expect(result).toContain("Focused review summary");
		expect(result).toContain("## Review target");
		expect(result).toContain("## Summary");
		expect(result).toContain("Author: @dev (Developer)");
		expect(result).toContain("https://gitea.example/owent/example/pulls/1");
		expect(result).toContain("Overall the PR looks good with one problem.");
	});

	it("renders without optional fields when not provided", () => {
		const minimal: TemplateContext = {};
		const result = renderBuiltinTemplate("gitea_pr_review", "summary", minimal);

		expect(result).toContain("AI Code Review Summary");
		expect(result).toContain("No summary provided.");
	});

	it("renders author email when provided", () => {
		const ctx: TemplateContext = {
			event: { author: "dev", email: "dev@example.com" },
		};
		const result = renderBuiltinTemplate("gitea_pr_review", "summary", ctx);

		expect(result).toContain("@dev");
		expect(result).toContain("dev@example.com");
	});

	it("renders displayName and email when provided", () => {
		const ctx: TemplateContext = {
			event: { displayName: "Developer", email: "dev@example.com" },
		};
		const result = renderBuiltinTemplate("feishu_bot", "summary", ctx);

		expect(result).toContain("Developer");
		expect(result).toContain("dev@example.com");
	});

	it("renders VCS context fields", () => {
		const ctx: TemplateContext = {
			vcs: { branch: "feature/x", sourcePath: "//depot/main", workspace: "ws-client-1" },
		};
		const result = renderBuiltinTemplate("gitea_pr_review", "summary", ctx);

		expect(result).toContain("feature/x");
		expect(result).toContain("//depot/main");
		expect(result).toContain("ws-client-1");
	});

	it("renders VCS context in IM templates", () => {
		const ctx: TemplateContext = {
			vcs: { branch: "main", sourcePath: "//Prx/Prx_Main" },
			problems: [toTemplateProblem(sampleProblem)],
		};
		const feishuResult = renderBuiltinTemplate("feishu_bot", "summary", ctx);

		expect(feishuResult).toContain("main");
		expect(feishuResult).toContain("//Prx/Prx_Main");
	});

	it("omits VCS fields when not provided", () => {
		const ctx: TemplateContext = {
			problems: [toTemplateProblem(sampleProblem)],
		};
		const result = renderBuiltinTemplate("feishu_bot", "summary", ctx);

		expect(result).not.toContain("Branch:");
		expect(result).not.toContain("Source:");
		expect(result).not.toContain("Workspace:");
	});
});

describe("createTemplateResolver", () => {
	it("returns a resolver that renders the builtin template", () => {
		const resolver = createTemplateResolver({
			channelKind: "gitea_pr_review",
		});

		const result = resolver.render("summary", sampleContext);
		expect(result).toContain("AI Code Review Summary");
	});

	it("resolveTemplate returns the builtin template source", () => {
		const resolver = createTemplateResolver({ channelKind: "gitea_issue" });
		const source = resolver.resolveTemplate("summary");

		expect(source).toContain("AI Code Review Report");
	});

	it("prefers channel-name workspace templates over builtins", async () => {
		const dir = await mkdtemp(join(tmpdir(), "aicr-template-channel-"));
		try {
			await writeFile(join(dir, "gitea-pr.summary.md.hbs"), "Custom {{summary}} for {{run.id}}", "utf8");
			const resolver = createTemplateResolver({
				channelKind: "gitea_pr_review",
				channelName: "gitea-pr",
				workspaceTemplatesDir: dir,
			});

			expect(resolver.resolveTemplate("summary")).toContain("Custom");
			expect(resolver.render("summary", sampleContext)).toBe("Custom Overall the PR looks good with one problem. for run-abc");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("uses channel-kind workspace templates when channel-name templates are absent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "aicr-template-kind-"));
		try {
			await writeFile(join(dir, "github_pr_review.problem.md.hbs"), "GH {{problem.location}}", "utf8");
			const resolver = createTemplateResolver({
				channelKind: "github_pr_review",
				channelName: "github-main",
				workspaceTemplatesDir: dir,
			});

			expect(resolver.render("problem", { problem: toTemplateProblem(sampleProblem) })).toBe("GH src/app.ts:42");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not use removed finding workspace templates as fallback", async () => {
		const dir = await mkdtemp(join(tmpdir(), "aicr-template-removed-kind-"));
		try {
			await writeFile(join(dir, "github_pr_review.finding.md.hbs"), "GH {{finding.location}}", "utf8");
			const resolver = createTemplateResolver({
				channelKind: "github_pr_review",
				channelName: "github-main",
				workspaceTemplatesDir: dir,
			});

			expect(resolver.render("problem", { problem: toTemplateProblem(sampleProblem) })).toContain("Location: `src/app.ts:42`");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back to builtin templates when workspace override files are missing", () => {
		const resolver = createTemplateResolver({
			channelKind: "gitea_pr_review",
			workspaceTemplatesDir: join(tmpdir(), "aicr-template-missing"),
		});

		expect(resolver.render("summary", sampleContext)).toContain("AI Code Review Summary");
	});

	it("prefers builtin file templates over inline constants", async () => {
		const dir = await mkdtemp(join(tmpdir(), "aicr-template-builtin-"));
		try {
			await writeFile(join(dir, "feishu-summary.hbs"), "FILE: {{#if vcs.branch}}{{vcs.branch}}{{/if}}", "utf8");
			const resolver = createTemplateResolver({
				channelKind: "feishu_bot",
				builtinTemplatesBaseDir: dir,
			});

			const result = resolver.render("summary", { vcs: { branch: "test-branch" } });
			expect(result).toContain("FILE: test-branch");
			expect(result).not.toContain("P4 CL");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back to inline when builtin file dir is missing", () => {
		const resolver = createTemplateResolver({
			channelKind: "feishu_bot",
			builtinTemplatesBaseDir: join(tmpdir(), "aicr-template-nonexistent"),
		});

		expect(resolver.render("summary", { problems: [] })).toContain("");
	});
});

describe("clearTemplateCache", () => {
	it("clears the cache so next render picks up new source", () => {
		const ctx: TemplateContext = { run: { id: "x" } };
		const r1 = renderTemplate("{{run.id}}", ctx, "cache-test");
		expect(r1).toBe("x");

		clearTemplateCache();

		const r2 = renderTemplate("updated-{{run.id}}", ctx, "cache-test");
		expect(r2).toBe("updated-x");
	});
});

describe("markdownlint compliance of rendered templates", () => {
	it("renders gitea_pr_review summary that collapses to valid output after fixMarkdown", () => {
		const raw = renderBuiltinTemplate("gitea_pr_review", "summary", sampleContext);
		expect(raw).toContain("## AI Code Review Summary");
		expect(raw).toContain("### Focused review summary");
		const collapsed = raw.replace(/\n{3,}/gu, "\n\n");
		expect(collapsed).not.toMatch(/\n{3,}/u);
	});

	it("renders gitea_issue summary that collapses to valid output after fixMarkdown", () => {
		const raw = renderBuiltinTemplate("gitea_issue", "summary", sampleContext);
		expect(raw).toContain("## AI Code Review Report");
		const collapsed = raw.replace(/\n{3,}/gu, "\n\n");
		expect(collapsed).not.toMatch(/\n{3,}/u);
	});

	it("renders gitea_pr_review problem with all fields", () => {
		const raw = renderBuiltinTemplate("gitea_pr_review", "problem", {
			problem: toTemplateProblem(sampleProblem),
		});
		expect(raw).toContain("HIGH");
		expect(raw).toContain("Bug found.");
		expect(raw).toContain("Suggested fix:");
		expect(raw).toContain("```ts");
	});
});
