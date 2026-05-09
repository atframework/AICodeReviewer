import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import Handlebars from "handlebars";

export type TemplateKind = "problem" | "summary";

export type TemplateTargetKind = "pull_request" | "push" | "commit" | "issue" | "manual" | "scheduled";

export interface TemplateTarget {
	readonly kind: TemplateTargetKind;
	readonly label: string;
	readonly id?: string;
	readonly url?: string;
	readonly baseRevision?: string;
	readonly headRevision?: string;
	readonly displayText: string;
	readonly markdownLink?: string;
}

export interface BuildTemplateTargetOptions {
	readonly kind?: TemplateTargetKind;
	readonly provider?: string;
	readonly repoRef?: string;
	readonly title?: string;
	readonly url?: string;
	readonly baseRevision?: string;
	readonly headRevision?: string;
	readonly triggerName?: string;
	readonly workspaceId?: string;
	readonly baseUrl?: string;
	readonly commitUrlTemplate?: string;
	readonly revisionUrlTemplate?: string;
	readonly changeUrlTemplate?: string;
}

export interface TemplateContext {
	readonly event?: {
		readonly author?: string;
		readonly url?: string;
		readonly title?: string;
	};
	readonly target?: TemplateTarget;
	readonly repo?: {
		readonly name?: string;
		readonly fullName?: string;
	};
	readonly run?: {
		readonly id?: string;
	};
	readonly atMentions?: string;
	readonly problems?: readonly TemplateProblem[];
	readonly problem?: TemplateProblem;
	readonly summary?: string;
}

export interface TemplateProblem {
	readonly file: string;
	readonly line: number;
	readonly endLine?: number;
	readonly severity: string;
	readonly category: string;
	readonly message: string;
	readonly suggestion?: string;
	readonly fingerprint?: string;
	readonly location: string;
}

function shortRevision(value: string | undefined): string | undefined {
	return value && value.length > 12 ? value.slice(0, 12) : value;
}

function isHttpUrl(value: string | undefined): value is string {
	if (!value) {
		return false;
	}

	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function escapeMarkdownLinkLabel(value: string): string {
	return value.replace(/[\\[\]()]/gu, "\\$&");
}

function markdownLink(displayText: string, url: string | undefined): string | undefined {
	return isHttpUrl(url) ? `[${escapeMarkdownLinkLabel(displayText)}](${url})` : undefined;
}

function encodeRepoRef(repoRef: string): string {
	return repoRef
		.split("/")
		.filter((part) => part.length > 0)
		.map((part) => encodeURIComponent(part))
		.join("/");
}

function extractTargetId(kind: TemplateTargetKind, url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}

	try {
		const pathname = new URL(url).pathname;
		const patterns = kind === "issue"
			? [/\/issues\/(\d+)(?:\/|$)/u]
			: [/\/pulls\/(\d+)(?:\/|$)/u, /\/pull\/(\d+)(?:\/|$)/u, /\/merge_requests\/(\d+)(?:\/|$)/u];
		for (const pattern of patterns) {
			const match = pattern.exec(pathname);
			if (match?.[1]) {
				return match[1];
			}
		}
	} catch {
		return undefined;
	}

	return undefined;
}

function renderUrlTemplate(
	template: string | undefined,
	variables: Readonly<Record<string, string | undefined>>,
): string | undefined {
	if (!template) {
		return undefined;
	}

	let unknownVariable = false;
	const rendered = template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu, (_match, key: string) => {
		const value = variables[key];
		if (value === undefined) {
			unknownVariable = true;
			return "";
		}
		return encodeURIComponent(value);
	});

	return unknownVariable || /\{\{/u.test(rendered) || !isHttpUrl(rendered) ? undefined : rendered;
}

function deriveCommitUrl(options: BuildTemplateTargetOptions, revision: string | undefined): string | undefined {
	if (!revision || !options.baseUrl || !options.repoRef) {
		return undefined;
	}

	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	const repoRef = encodeRepoRef(options.repoRef);
	if (!baseUrl || !repoRef) {
		return undefined;
	}

	const encodedRevision = encodeURIComponent(revision);
	if (options.provider === "gitlab") {
		return `${baseUrl}/${repoRef}/-/commit/${encodedRevision}`;
	}

	if (options.provider === "gitea" || options.provider === "forgejo" || options.provider === "github") {
		return `${baseUrl}/${repoRef}/commit/${encodedRevision}`;
	}

	return undefined;
}

function targetDisplayText(options: BuildTemplateTargetOptions, kind: TemplateTargetKind, id: string | undefined): { label: string; displayText: string } {
	const revision = options.headRevision;
	if (kind === "pull_request") {
		const label = options.provider === "gitlab" ? "MR" : "PR";
		return {
			label,
			displayText: options.title ?? (id ? `${label} ${label === "MR" ? "!" : "#"}${id}` : `${label} review target`),
		};
	}

	if (kind === "issue") {
		return {
			label: "Issue",
			displayText: options.title ?? (id ? `Issue #${id}` : "Issue"),
		};
	}

	if (kind === "commit" || kind === "push") {
		if (options.provider === "p4") {
			return { label: "P4 CL", displayText: revision ? `P4 CL ${revision}` : "P4 changelist" };
		}
		if (options.provider === "svn") {
			return { label: "SVN revision", displayText: revision ? `SVN r${revision}` : "SVN revision" };
		}
		const short = shortRevision(revision);
		return { label: kind === "push" ? "Push" : "Commit", displayText: short ? `Commit ${short}` : kind === "push" ? "Push event" : "Commit" };
	}

	if (kind === "scheduled") {
		return { label: "Scheduled review", displayText: "Scheduled review" };
	}

	return { label: "Manual review", displayText: "Manual review" };
}

export function buildTemplateTargetContext(options: BuildTemplateTargetOptions): TemplateTarget {
	const kind = options.kind ?? "manual";
	const id = extractTargetId(kind, options.url);
	const { label, displayText } = targetDisplayText(options, kind, id);
	const revision = options.headRevision;
	const variables = {
		revision,
		commit: revision,
		commit_id: revision,
		headSha: options.headRevision,
		head_sha: options.headRevision,
		baseSha: options.baseRevision,
		base_sha: options.baseRevision,
		repo: options.repoRef,
		repo_ref: options.repoRef,
		provider: options.provider,
		trigger: options.triggerName,
		workspace_id: options.workspaceId,
	};
	const templatedUrl = renderUrlTemplate(options.changeUrlTemplate, variables) ??
		renderUrlTemplate(options.revisionUrlTemplate, variables) ??
		renderUrlTemplate(options.commitUrlTemplate, variables);
	const derivedUrl = kind === "commit" || kind === "push" ? deriveCommitUrl(options, revision) : undefined;
	const url = templatedUrl ?? (isHttpUrl(options.url) ? options.url : undefined) ?? derivedUrl;
	const targetMarkdownLink = markdownLink(displayText, url);

	return {
		kind,
		label,
		...(id ? { id } : {}),
		...(url ? { url } : {}),
		...(options.baseRevision ? { baseRevision: options.baseRevision } : {}),
		...(options.headRevision ? { headRevision: options.headRevision } : {}),
		displayText,
		...(targetMarkdownLink ? { markdownLink: targetMarkdownLink } : {}),
	};
}

const BUILTIN_SUMMARY_TEMPLATE = `## AI Code Review Summary

{{#if target.markdownLink}}
**Target**: {{{target.markdownLink}}}
{{else}}
{{#if target.displayText}}
**Target**: {{target.displayText}}
{{else}}
{{#if event.url}}
**Target**: [{{#if event.title}}{{event.title}}{{else}}Review target{{/if}}]({{event.url}})
{{/if}}
{{/if}}
{{/if}}
{{#if event.author}}
**Author**: @{{event.author}}
{{/if}}
{{#if atMentions}}
**Reviewers**: {{atMentions}}
{{/if}}

---

{{#if summary}}
{{{summary}}}
{{else}}
No summary provided.
{{/if}}

{{#if problems}}
### Problems ({{problems.length}})

| # | Severity | Category | Location | Message |
|---|----------|----------|----------|---------|
{{#each problems}}
| {{@index}} | {{severity}} | {{category}} | \`{{location}}\` | {{message}} |
{{/each}}
{{/if}}

---
*Powered by AICodeReviewer*{{#if run.id}} | Run: {{run.id}}{{/if}}
`;

const BUILTIN_PROBLEM_TEMPLATE = `**{{problem.severity}} · {{problem.category}}**

{{problem.message}}

Location: \`{{problem.location}}\`
{{#if problem.suggestion}}

**Suggested fix:**

{{problem.suggestion}}
{{/if}}
{{#if problem.fingerprint}}

<!-- aicr:fingerprint={{problem.fingerprint}} -->
{{/if}}
`;

const BUILTIN_GITEA_ISSUE_SUMMARY_TEMPLATE = `## AI Code Review Report

{{#if target.markdownLink}}
**Reviewed**: {{{target.markdownLink}}}
{{else}}
{{#if target.displayText}}
**Reviewed**: {{target.displayText}}
{{else}}
{{#if event.url}}
**Reviewed**: [{{#if event.title}}{{event.title}}{{else}}Review target{{/if}}]({{event.url}})
{{/if}}
{{/if}}
{{/if}}
{{#if event.author}}
**Author**: @{{event.author}}
{{/if}}

---

{{#if summary}}
{{{summary}}}
{{else}}
No summary provided.
{{/if}}

{{#if problems}}
### All Problems ({{problems.length}})

{{#each problems}}
#### {{@index}}. [{{severity}}] {{category}} — \`{{location}}\`

{{message}}
{{#if suggestion}}

> **Suggested fix**: {{suggestion}}
{{/if}}

{{/each}}
{{/if}}

---
*Generated by AICodeReviewer*{{#if run.id}} | Run: {{run.id}}{{/if}}
`;

const BUILTIN_FEISHU_SUMMARY_TEMPLATE = `{{#if event.title}}**{{event.title}}**{{else}}{{#if target.displayText}}**{{target.displayText}}**{{/if}}{{/if}}

{{#if problems}}Problems: {{problems.length}}{{/if}}
{{#if target.markdownLink}}
{{{target.markdownLink}}}
{{else}}
{{#if target.displayText}}
{{target.displayText}}
{{else}}
{{#if event.url}}
[Review target]({{event.url}})
{{/if}}
{{/if}}
{{/if}}
{{#if summary}}

{{{summary}}}
{{/if}}
`;

const BUILTIN_WECOM_SUMMARY_TEMPLATE = `{{#if event.title}}{{event.title}}{{else}}{{#if target.displayText}}{{target.displayText}}{{/if}}{{/if}}
{{#if problems}}Problems: {{problems.length}}{{/if}}
{{#if target.url}}
{{target.url}}
{{else}}
{{#if target.displayText}}
{{target.displayText}}
{{else}}
{{#if event.url}}
{{event.url}}
{{/if}}
{{/if}}
{{/if}}
{{#if summary}}

{{{summary}}}
{{/if}}
`;

const builtinTemplates: Readonly<Record<string, Record<TemplateKind, string>>> = {
	gitea_pr_review: {
		summary: BUILTIN_SUMMARY_TEMPLATE,
		problem: BUILTIN_PROBLEM_TEMPLATE,
	},
	gitea_issue: {
		summary: BUILTIN_GITEA_ISSUE_SUMMARY_TEMPLATE,
		problem: BUILTIN_PROBLEM_TEMPLATE,
	},
	gitea_problem_issue: {
		summary: BUILTIN_GITEA_ISSUE_SUMMARY_TEMPLATE,
		problem: BUILTIN_PROBLEM_TEMPLATE,
	},
	github_pr_review: {
		summary: BUILTIN_SUMMARY_TEMPLATE,
		problem: BUILTIN_PROBLEM_TEMPLATE,
	},
	gitlab_mr_review: {
		summary: BUILTIN_SUMMARY_TEMPLATE,
		problem: BUILTIN_PROBLEM_TEMPLATE,
	},
	feishu_bot: {
		summary: BUILTIN_FEISHU_SUMMARY_TEMPLATE,
		problem: BUILTIN_PROBLEM_TEMPLATE,
	},
	wecom_bot: {
		summary: BUILTIN_WECOM_SUMMARY_TEMPLATE,
		problem: BUILTIN_PROBLEM_TEMPLATE,
	},
};

const compiledCache = new Map<string, Handlebars.TemplateDelegate<TemplateContext>>();

function compileTemplate(source: string, cacheKey: string): Handlebars.TemplateDelegate<TemplateContext> {
	const cached = compiledCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const compiled = Handlebars.compile<TemplateContext>(source, { noEscape: true });
	compiledCache.set(cacheKey, compiled);
	return compiled;
}

export function getBuiltinTemplate(channelKind: string, kind: TemplateKind): string {
	const channelTemplates = builtinTemplates[channelKind];
	if (channelTemplates) {
		return channelTemplates[kind];
	}

	return builtinTemplates["gitea_pr_review"]![kind];
}

export function clearTemplateCache(): void {
	compiledCache.clear();
}

export function renderTemplate(
	source: string,
	context: TemplateContext,
	cacheKey?: string,
): string {
	const key = cacheKey ?? source;
	const compiled = compileTemplate(source, key);
	return compiled(context);
}

export function renderBuiltinTemplate(
	channelKind: string,
	kind: TemplateKind,
	context: TemplateContext,
): string {
	const source = getBuiltinTemplate(channelKind, kind);
	return renderTemplate(source, context, `builtin:${channelKind}:${kind}`);
}

export function toTemplateProblem(problem: {
	readonly file: string;
	readonly line: number;
	readonly endLine?: number;
	readonly severity: string;
	readonly category: string;
	readonly message: string;
	readonly suggestion?: string;
	readonly fingerprint?: string;
}): TemplateProblem {
	return {
		file: problem.file,
		line: problem.line,
		...(problem.endLine !== undefined ? { endLine: problem.endLine } : {}),
		severity: problem.severity.toUpperCase(),
		category: problem.category,
		message: problem.message,
		...(problem.suggestion ? { suggestion: problem.suggestion } : {}),
		...(problem.fingerprint ? { fingerprint: problem.fingerprint } : {}),
		location: problem.endLine
			? `${problem.file}:${problem.line}-${problem.endLine}`
			: `${problem.file}:${problem.line}`,
	};
}

export interface TemplateResolverOptions {
	readonly channelKind: string;
	readonly channelName?: string;
	readonly workspaceTemplatesDir?: string;
}

export interface TemplateResolver {
	readonly resolveTemplate: (kind: TemplateKind) => string;
	readonly render: (kind: TemplateKind, context: TemplateContext) => string;
}

interface ResolvedTemplateSource {
	readonly source: string;
	readonly cacheKey: string;
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as { readonly code?: unknown }).code === "ENOENT" ||
			(error as { readonly code?: unknown }).code === "ENOTDIR");
}

function workspaceTemplateCandidates(options: TemplateResolverOptions, kind: TemplateKind): string[] {
	const candidates: string[] = [];
	if (options.channelName) {
		candidates.push(`${options.channelName}.${kind}.md.hbs`, `${options.channelName}.${kind}.hbs`);
	}

	candidates.push(
		`${options.channelKind}.${kind}.md.hbs`,
		`${options.channelKind}.${kind}.hbs`,
		`${kind}.md.hbs`,
		`${kind}.hbs`,
	);

	return candidates;
}

function resolveWorkspaceTemplate(
	options: TemplateResolverOptions,
	kind: TemplateKind,
): ResolvedTemplateSource | undefined {
	if (!options.workspaceTemplatesDir) {
		return undefined;
	}

	for (const candidate of workspaceTemplateCandidates(options, kind)) {
		const templatePath = join(options.workspaceTemplatesDir, candidate);
		try {
			const stat = statSync(templatePath);
			if (!stat.isFile()) {
				continue;
			}

			return {
				source: readFileSync(templatePath, "utf8"),
				cacheKey: `workspace:${templatePath}:${stat.mtimeMs}`,
			};
		} catch (error) {
			if (isMissingFileError(error)) {
				continue;
			}

			throw error;
		}
	}

	return undefined;
}

function resolveTemplateSource(options: TemplateResolverOptions, kind: TemplateKind): ResolvedTemplateSource {
	const workspaceTemplate = resolveWorkspaceTemplate(options, kind);
	if (workspaceTemplate) {
		return workspaceTemplate;
	}

	return {
		source: getBuiltinTemplate(options.channelKind, kind),
		cacheKey: `builtin:${options.channelKind}:${kind}`,
	};
}

export function createTemplateResolver(options: TemplateResolverOptions): TemplateResolver {
	return {
		resolveTemplate(kind: TemplateKind): string {
			return resolveTemplateSource(options, kind).source;
		},

		render(kind: TemplateKind, context: TemplateContext): string {
			const resolved = resolveTemplateSource(options, kind);
			return renderTemplate(resolved.source, context, resolved.cacheKey);
		},
	};
}
