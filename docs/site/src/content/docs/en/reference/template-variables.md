---
title: Template variables
description: Variables available in summary and problem output templates, the filename resolution order, and a Handlebars example.
---

AICR renders every published problem and summary through a Handlebars template
before dispatch. Built-in templates live in `templates/builtin/*.hbs` in the
deployment directory and cover the problem-comment and summary variants for
every built-in channel kind. You can override them per workspace without
forking the built-ins.

See [Output channels](/en/integrations/output-channels/) for how rendered
templates are dispatched to each channel kind, and
[Configuration fields](/en/reference/config-fields/) for the channel-level
fields referenced below.

## Candidate template filename resolution

Override templates are loaded from the workspace template directory:

```text
workspaces/<workspace_id>/templates/
```

For a given channel and template `kind` (typically `summary` or `problem`),
AICR resolves the candidate file name in this order, using the first match:

1. `<channel_name>.<kind>.md.hbs` (for example `feishu-code-review.summary.md.hbs`)
2. `<channel_name>.<kind>.hbs`
3. `<channel_kind>.<kind>.md.hbs` (for example `feishu_bot.summary.md.hbs`)
4. `<channel_kind>.<kind>.hbs`
5. `<kind>.md.hbs` (for example `summary.md.hbs`)
6. `<kind>.hbs`

`<channel_name>` is the `name` you set on the channel in `outputs.channels[]`;
`<channel_kind>` is the channel `kind` (such as `feishu_bot` or
`gitea_pr_review`). A more specific channel-name override always wins over a
channel-kind fallback, which in turn wins over a generic kind-only fallback.

If no override is found, the built-in template for that channel kind and kind
is used.

## Variable tree

All variables are passed as a single context object. The most useful fields
are listed below. Fields marked *when available* are optional and depend on
the trigger kind and event payload (PR/MR, push, commit, P4 changelist, SVN
revision, scheduled, manual).

| Variable | Meaning |
| --- | --- |
| `{{event.author}}` | Normalized event author username, when available |
| `{{event.email}}` | Author email, when available |
| `{{event.displayName}}` | Author display name, when available |
| `{{event.url}}` | Raw event URL, when available; templates must not assume this is always a PR/MR URL |
| `{{event.title}}` | Event title (PR/MR title, commit message subject, changelist description), when available |
| `{{target.kind}}` | Target kind (`pull_request`, `push`, `commit`, `issue`, `manual`, `scheduled`) |
| `{{target.displayText}}` | Safe plain-text target label for any event kind |
| `{{target.markdownLink}}` | Safe Markdown target link; use this instead of hard-coding `[View PR]` |
| `{{target.url}}` | Target URL, when available |
| `{{repo.name}}` | Short repository name |
| `{{repo.fullName}}` | Full repository reference (`owner/repo`, depot path, or repository URL) |
| `{{vcs.branch}}` | Git branch name, when available |
| `{{vcs.sourcePath}}` | Provider-specific source namespace/path (depot or repository subpath), when available |
| `{{vcs.workspace}}` | Submitter client/workspace name captured from the event (P4 `%client%`/payload `client`), when available; this is the submitter's workspace, not AICR's analysis client |
| `{{vcs.repositoryPath}}` | Repository/depot reference path, when available |
| `{{run.id}}` | Review run ID, when available |
| `{{atMentions}}` | Pre-rendered, channel-specific mention string (already in the platform's native mention syntax) |
| `{{summaryTitle}}` | Optional short summary title supplied via `aicr.publish_summary.title` |
| `{{summary}}` | Summary Markdown body |
| `{{problems}}` | Problem list (used in summary templates); iterate with `{{#each problems}}` |
| `{{problem.file}}` | Repository-relative path of one reported problem (problem templates) |
| `{{problem.line}}` | Primary anchor line number |
| `{{problem.location}}` | Pre-rendered location label (`file:line`) |
| `{{problem.severity}}` | `info` / `low` / `medium` / `high` / `critical` |
| `{{problem.category}}` | Short problem family (for example `correctness`, `security`) |
| `{{problem.message}}` | Problem analysis: what is wrong, trigger scenario, impact |
| `{{problem.suggestion}}` | Optional fix direction; may include a fenced `diff` patch |
| `{{problem.codeSnippet}}` | Optional AICR-derived code reference snippet (Git-based channels) |
| `{{problem.codeLanguage}}` | Detected language for the snippet |
| `{{{problem.codeFence}}}` | Pre-built fenced code block (use triple braces — already-escaped HTML) |

### Author rendering

For Git-based channels (`gitea_*`, `github_*`, `gitlab_mr_review`), built-in
templates prefer `@username` when a provider username is available. If a
display name is also available, they render `@username (Display Name)` so the
platform can still resolve the mention while humans see the nickname. IM bot
summary templates (`feishu_bot`, `wecom_bot`) use the same human-readable
`@username (Display Name)` convention for event authors; native bot mentions
flow through the separate `{{atMentions}}` path when enabled.

### Removed variables

Templates must use `{{problems}}` and `{{problem.*}}`. The legacy
`{{findings}}` and `{{finding.*}}` variables are not provided. Likewise, do
not render `[View PR]` for non-PR/MR events — use `target.markdownLink` or
`target.displayText` instead.

## URL template variables

Triggers and channels accept URL templates (`commit_url_template`,
`revision_url_template`, `change_url_template`) for providers that do not
expose a derivable commit/revision URL (P4 Swarm, ViewVC, custom review UIs).
Values are **URL-encoded** before substitution. Supported variables:

`{{revision}}`, `{{commit}}`, `{{commit_id}}`, `{{headSha}}`,
`{{head_sha}}`, `{{baseSha}}`, `{{base_sha}}`, `{{repo}}`, `{{repo_ref}}`,
`{{provider}}`, `{{trigger}}`, `{{workspace_id}}`.

```yaml
triggers:
  - name: p4-main
    kind: p4
    change_url_template: "https://swarm.example.com/changes/{{revision}}"

outputs:
  channels:
    - name: feishu-code-review
      kind: feishu_bot
      revision_url_template: "https://review.example.com/revisions/{{revision}}"
```

## Handlebars example

A workspace-scoped Feishu summary override. Place it at
`workspaces/p4-main/templates/feishu_bot.summary.hbs`:

```handlebars
**{{target.displayText}}**{{#if event.author}}
**Author**: @{{event.author}}{{#if event.email}} <{{event.email}}>{{/if}}{{/if}}{{#if vcs.sourcePath}}
**Source**: {{vcs.sourcePath}}{{/if}}{{#if vcs.workspace}}
**Workspace**: {{vcs.workspace}}{{/if}}
{{{summary}}}
```

A problem-comment template iterating the problem list:

```handlebars
## {{summaryTitle}}

{{#if atMentions}}{{atMentions}} {{/if}}Reviewed {{target.displayText}}.

{{{summary}}}

{{#each problems}}
### [{{severity}}] {{category}} — {{location}}

{{message}}

{{#if suggestion}}
**Suggested fix**

{{suggestion}}
{{/if}}

{{#if codeFence}}
{{{codeFence}}}
{{/if}}
{{/each}}
```

Notes:

- Use triple braces (`{{{ }}}`) for fields that already contain rendered
  Markdown or HTML (`summary`, `codeFence`); use double braces (`{{ }}`) for
  plain-text fields so Handlebars escapes them.
- After rendering, AICR fixes and validates the Markdown before dispatch. If
  a template cannot be made safe and valid, AICR prefers a plain-text fallback
  over dropping the report.
- Lint a template before deploying it with the
  [`lint` CLI command](/en/reference/cli/#lint).
