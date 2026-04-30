import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	clearTemplateCache,
	createTemplateResolver,
	getBuiltinTemplate,
	renderBuiltinTemplate,
	renderTemplate,
	toTemplateFinding,
	type TemplateContext,
} from "../src/template-engine.js";

const sampleFinding = {
	file: "src/app.ts",
	line: 42,
	severity: "high",
	category: "correctness",
	message: "Bug found.",
	suggestion: "Fix it.",
	fingerprint: "fp-1",
};

const sampleContext: TemplateContext = {
	event: {
		author: "dev",
		url: "https://gitea.example/owent/example/pulls/1",
		title: "Add feature",
	},
	repo: {
		name: "example",
		fullName: "owent/example",
	},
	run: { id: "run-abc" },
	atMentions: "@dev @reviewer",
	findings: [toTemplateFinding(sampleFinding)],
	summary: "Overall the PR looks good with one finding.",
};

describe("toTemplateFinding", () => {
	it("converts a finding with all fields", () => {
		const result = toTemplateFinding(sampleFinding);

		expect(result.severity).toBe("HIGH");
		expect(result.location).toBe("src/app.ts:42");
		expect(result.fingerprint).toBe("fp-1");
		expect(result.suggestion).toBe("Fix it.");
	});

	it("renders range location when endLine is present", () => {
		const result = toTemplateFinding({ ...sampleFinding, endLine: 50 });

		expect(result.location).toBe("src/app.ts:42-50");
	});

	it("omits optional fields when not present", () => {
		const result = toTemplateFinding({
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

describe("getBuiltinTemplate", () => {
	it("returns a non-empty string for gitea_pr_review summary", () => {
		expect(getBuiltinTemplate("gitea_pr_review", "summary").length).toBeGreaterThan(0);
	});

	it("returns a non-empty string for gitea_pr_review finding", () => {
		expect(getBuiltinTemplate("gitea_pr_review", "finding").length).toBeGreaterThan(0);
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
			expect(getBuiltinTemplate(kind, "finding").length).toBeGreaterThan(0);
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
		expect(result).toContain("Add feature");
		expect(result).toContain("@dev @reviewer");
		expect(result).toContain("Bug found.");
		expect(result).toContain("run-abc");
		expect(result).toContain("1");
	});

	it("renders gitea_pr_review finding with suggestion and fingerprint", () => {
		const ctx: TemplateContext = {
			finding: toTemplateFinding(sampleFinding),
		};
		const result = renderBuiltinTemplate("gitea_pr_review", "finding", ctx);

		expect(result).toContain("HIGH");
		expect(result).toContain("correctness");
		expect(result).toContain("Bug found.");
		expect(result).toContain("Suggested fix:");
		expect(result).toContain("Fix it.");
		expect(result).toContain("aicr:fingerprint=fp-1");
	});

	it("renders gitea_issue summary with numbered findings", () => {
		const result = renderBuiltinTemplate("gitea_issue", "summary", sampleContext);

		expect(result).toContain("AI Code Review Report");
		expect(result).toContain("[HIGH]");
		expect(result).toContain("correctness");
		expect(result).toContain("`src/app.ts:42`");
	});

	it("renders feishu_bot summary", () => {
		const result = renderBuiltinTemplate("feishu_bot", "summary", sampleContext);

		expect(result).toContain("Add feature");
		expect(result).toContain("1");
		expect(result).toContain("https://gitea.example/owent/example/pulls/1");
	});

	it("renders wecom_bot summary", () => {
		const result = renderBuiltinTemplate("wecom_bot", "summary", sampleContext);

		expect(result).toContain("Add feature");
		expect(result).toContain("1");
		expect(result).toContain("https://gitea.example/owent/example/pulls/1");
	});

	it("renders without optional fields when not provided", () => {
		const minimal: TemplateContext = {};
		const result = renderBuiltinTemplate("gitea_pr_review", "summary", minimal);

		expect(result).toContain("AI Code Review Summary");
		expect(result).toContain("No summary provided.");
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
			expect(resolver.render("summary", sampleContext)).toBe("Custom Overall the PR looks good with one finding. for run-abc");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("uses channel-kind workspace templates when channel-name templates are absent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "aicr-template-kind-"));
		try {
			await writeFile(join(dir, "github_pr_review.finding.md.hbs"), "GH {{finding.location}}", "utf8");
			const resolver = createTemplateResolver({
				channelKind: "github_pr_review",
				channelName: "github-main",
				workspaceTemplatesDir: dir,
			});

			expect(resolver.render("finding", { finding: toTemplateFinding(sampleFinding) })).toBe("GH src/app.ts:42");
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
