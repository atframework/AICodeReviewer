# Output channels and MCP report contract

This document is the user-facing module for AICodeReviewer report output. Keep it aligned with `packages/mcp-output/src/index.ts`, `packages/outputs/src/index.ts`, `packages/outputs/src/template-engine.ts`, and `example/config.yaml`.

## Design goals

- Agent CLIs do the code reasoning; AICR owns the report contract, validation, routing, and rendering.
- Every formal review result must flow through AICR tools, never through free-form stdout.
- The same reported problem must render cleanly as a VCS line comment, an issue entry, or an IM summary card.
- The contract stays small and stable so Kilo Code, Roo Code, OpenCode, Claude Code, and other adapters can all emit the same shape.

## Implemented MCP-style tools

The current in-process tool registry exposes these AICR tools to the review executor:

| Tool | Purpose | Required fields |
| --- | --- | --- |
| `aicr.report_problem` | Report one actionable code-review problem anchored to a changed line | `file`, `line`, `severity`, `category`, `message` |
| `aicr.publish_summary` | Publish a structured Markdown review summary | `markdown` |
| `aicr.skip` | Mark the review as intentionally skipped | `reason` |
| `aicr.fetch_more_context` | Request bounded extra source context | `path`, `reason` |

Planned attribution, memory, and skill recall tools are documented in `Plan.md`; do not describe them as implemented until they exist in `packages/mcp-output` and tests.

The external stdio / Streamable HTTP MCP server and per-agent MCP config materialization are tracked as remaining M5/M8 work. Until that lands, Kilo and other agent adapters use the compatible JSON/XML tool-call stdout path that AICR validates with the same schemas below.

## Problem schema

`aicr.report_problem` accepts a minimal, channel-neutral shape:

| Field | Required | Meaning | Rendering notes |
| --- | --- | --- | --- |
| `file` | Yes | Repository-relative path to the affected file | Used as PR/MR line-comment path and issue location |
| `line` | Yes | New-file line number for the primary anchor | Must be a changed or diff-commentable line when possible |
| `end_line` | No | End line for a range problem | Rendered as `file:start-end`; line-comment APIs may fall back to a single-line anchor |
| `severity` | Yes | `info`, `low`, `medium`, `high`, or `critical` | Use conservative severity calibration from the system prompt |
| `category` | Yes | Short problem family such as `correctness`, `security`, or `api-contract` | Kept stable for grouping and dedupe |
| `message` | Yes | Problem analysis: what is wrong, trigger scenario, and impact | This is the primary review comment body |
| `suggestion` | No | Smallest plausible fix direction; may include a fenced `diff` patch | Rendered under “Suggested fix” in VCS and issue channels |
| `fingerprint` | No | Stable dedupe key | Preserved in hidden comments where supported |

Planned optional fields will stay additive. In particular, `attribution` may be added later so `aicr.report_problem` can carry AICR-verified author / committer / revision context when available. Agent-supplied attribution must be treated as advisory until the server revalidates it through event metadata, provider APIs, or a read-only attribution tool such as planned `aicr.try_blame`.

Use `message` for analysis and `suggestion` for the fix. If patch code is useful, place a small fenced diff inside `suggestion` instead of adding a separate field:

```json
{
  "toolCalls": [
    {
      "name": "aicr.report_problem",
      "input": {
        "file": "src/service.ts",
        "line": 42,
        "severity": "high",
        "category": "correctness",
        "message": "The new retry path can return before persisting the failed job. A transient database error would drop the job instead of retrying it.",
        "suggestion": "Persist the failed state before returning from the retry branch. If the change is local, include a small diff fenced as `diff`."
      }
    }
  ]
}
```

Keep patches concise. Large rewrites belong in a summary or a linked follow-up, not in a line comment.

## Summary schema

`aicr.publish_summary` takes Markdown in `markdown` and is used for:

- PR/MR summary comments when a channel supports summary publishing.
- Gitea managed problem issues.
- Feishu and WeCom aggregated reports.
- Push, commit, and P4 changelist events where there may be no line-comment target.

For push/commit/P4 events, publish a non-empty summary when configured channels need an audit trail. The `no_problems` policy decides per channel whether a zero-problem result is published or suppressed.

## Channel mapping

| Channel kind | Problem output | Summary output | Notes |
| --- | --- | --- | --- |
| `gitea_pr_review` | PR review line comment when line is commentable | PR review / configured summary publisher | Falls back to a general review comment when the line is outside the diff |
| `github_pr_review` | Pull request review comment | Pull request review / configured summary publisher | Uses GitHub line anchors where possible |
| `gitlab_mr_review` | Merge request discussion when `baseSha` and `headSha` are available | Merge request note / configured summary publisher | Falls back to a general MR note when line anchoring is unavailable |
| `gitea_issue` | Collected, then rendered into an issue comment | Aggregated issue comment | Useful for push events or issue-based triage |
| `gitea_problem_issue` | Collected for reconciliation | Creates, updates, or resolves managed problem issues | Fingerprint stability matters most here |
| `github_issue` | Collected, then rendered into an issue comment | Aggregated issue comment | Same as `gitea_issue` but for GitHub repositories |
| `github_problem_issue` | Collected for reconciliation | Creates or resolves managed GitHub issues | Like `gitea_problem_issue` but uses string label names; `resolved_action` supports `close` and `none` only (GitHub has no issue delete API) |
| `feishu_bot` | Collected for aggregation | Interactive card Markdown | Includes summary, problem count, severity/category/file/line, and truncated message/suggestion per problem |
| `wecom_bot` | Collected for aggregation | Markdown message | Same content as Feishu; messages truncated to 500 chars and suggestions to 300 chars to stay within size limits |

## Managed Gitea problem issues

The `gitea_problem_issue` channel reconciles one managed Gitea issue per problem fingerprint. On every summary publish it creates issues for new fingerprints and applies `resolved_action` to open managed issues whose fingerprints disappeared from the latest analysis.

Channel fields:

| Field | Meaning |
| --- | --- |
| `marker_prefix` | Title prefix used to identify managed issues; defaults to `[AICR]` |
| `marker_label` | Hidden body marker used to scope managed issues; defaults to `aicr-managed` |
| `label_ids` | Existing Gitea label IDs to attach to every created issue |
| `resolved_action` | `none`, `close`, or `delete`; defaults to `close` |
| `assign_committer` | Add the resolved review author as an assignee; defaults to `true` |
| `owners_file` | Repository file to read for path owners; defaults to `OWNERS` |
| `add_owners_as_assignees` | Set to `true` to add matched OWNERS entries as assignees |
| `severity_label_prefix` | When set, auto-create and attach one severity label such as `aicr:problem:high` |
| `severity_label_colors` | Optional severity-to-color map for auto-created labels |
| `notify_feishu` | Optional issue-created notification webhook config |

The OWNERS file uses a small YAML shape:

```yaml
reviewers:
  - admin1
paths:
  "src/auth/":
    - alice
    - bob
```

Path owners use longest-prefix matching. If no path matches, `reviewers` are used as a fallback. Missing or unreadable OWNERS files do not block issue creation.

Example:

```yaml
outputs:
  channels:
    - name: gitea-problem-issues
      kind: gitea_problem_issue
      trigger: gitea
      resolved_action: close
      assign_committer: true
      owners_file: OWNERS
      add_owners_as_assignees: true
      severity_label_prefix: "aicr:problem:"
      notify_feishu:
        webhook_url_env: FEISHU_ISSUE_NOTIFY_WEBHOOK
        secret_env: FEISHU_ISSUE_NOTIFY_SECRET
```

## Managed GitHub problem issues

The `github_problem_issue` channel works identically to `gitea_problem_issue` but targets the GitHub REST API. It reconciles one managed GitHub issue per problem fingerprint using string label names (not numeric IDs). On every summary publish it creates issues for new fingerprints and applies `resolved_action` to open managed issues whose fingerprints disappeared.

Key differences from `gitea_problem_issue`:

- **Labels**: GitHub uses string names directly (`labels: ["bug", "aicr:problem:high"]`); Gitea uses numeric IDs.
- **Resolved action**: GitHub does not support deleting issues; `resolved_action` can only be `close` (default) or `none`. The `delete` option is not available.
- **API headers**: `accept: application/vnd.github+json`, `x-github-api-version: 2022-11-28`, `authorization: Bearer <token>`.
- **Base URL**: Defaults to `https://api.github.com`; for GitHub Enterprise, set to `https://ghe.example.com/api/v3`.

Channel fields:

| Field | Meaning |
| --- | --- |
| `marker_prefix` | Title prefix used to identify managed issues; defaults to `[AICR]` |
| `marker_label` | Hidden body marker used to scope managed issues; defaults to `aicr-managed` |
| `labels` | GitHub label names to attach to every created issue |
| `resolved_action` | `none` or `close`; defaults to `close` |
| `assign_committer` | Add the resolved review author as an assignee; defaults to `true` |
| `owners_file` | Repository file to read for path owners; defaults to `OWNERS` |
| `add_owners_as_assignees` | Set to `true` to add matched OWNERS entries as assignees |
| `severity_label_prefix` | When set, auto-create and attach one severity label such as `aicr:problem:high` |
| `severity_label_colors` | Optional severity-to-color map for auto-created labels |
| `notify_feishu` | Optional issue-created notification webhook config |

Example:

```yaml
outputs:
  channels:
    - name: github-problem-issues
      kind: github_problem_issue
      trigger: github
      resolved_action: close
      assign_committer: true
      owners_file: OWNERS
      add_owners_as_assignees: true
      severity_label_prefix: "aicr:problem:"
```

## No-problems policy

The implemented `no_problems` policy controls whether a successful review with zero actionable problems should publish a summary to each output channel.

Effective policy is resolved in this order, from low to high precedence:

1. Built-in channel defaults.
2. Global `outputs.no_problems`.
3. Per-channel `outputs.channels[].no_problems`.
4. Workspace defaults: `workspaces.defaults.outputs.no_problems` and `workspaces.defaults.outputs.channel_overrides.<channel>.no_problems`.
5. Per-project overrides: `workspaces.instances.<workspace_id>.outputs.no_problems` and `workspaces.instances.<workspace_id>.outputs.channel_overrides.<channel>.no_problems`.

Use positive wording: `no_problems.action: publish|suppress`. Notification channels such as Feishu, WeCom, and email usually set `suppress`; lifecycle channels that need to close resolved managed issues may set `publish`. The removed `no_findings` spelling is rejected by config validation.

This is an output-layer policy. It does not replace `review.skip_lgtm`, and it must not suppress error reports or problem lifecycle reconciliation.

Example:

```yaml
outputs:
  no_problems: { action: suppress }
  channels:
    - name: feishu-code-review
      kind: feishu_bot
      webhook_url_env: AICR_FEISHU_WEBHOOK
      no_problems: { action: suppress }
    - name: audit-archive
      kind: gitea_issue
      trigger: gitea
      no_problems: { action: publish }

workspaces:
  defaults:
    outputs:
      no_problems: { action: suppress }
  instances:
    critical-service:
      source_repo: { trigger: gitea, repo: "org/critical-service" }
      outputs:
        channel_overrides:
          feishu-code-review:
            no_problems: { action: publish }
```

If every configured summary channel suppresses a zero-problem result, the run is marked skipped with `skipReason="no_problems_suppressed"` in the run summary.

## Template rendering

Built-in templates are packaged in `packages/outputs/src/template-engine.ts`. They are intentionally small and cover problem-comment and summary variants for every built-in channel kind.

Override templates per workspace by placing files under:

```text
workspaces/<workspace_id>/templates/
```

Candidate filenames are resolved in this order:

1. `<channel-name>.<kind>.md.hbs`
2. `<channel-name>.<kind>.hbs`
3. `<channel-kind>.<kind>.md.hbs`
4. `<channel-kind>.<kind>.hbs`

Common template variables:

| Variable | Meaning |
| --- | --- |
| `{{event.author}}` | Normalized event author when available |
| `{{event.email}}` | Author's email when available |
| `{{event.displayName}}` | Author's display name when available |
| `{{event.url}}` | Raw event URL when available; templates should not assume this is always a PR/MR URL |
| `{{target.displayText}}`, `{{target.markdownLink}}` | Safe target label/link for PR, MR, commit, P4 changelist, SVN revision, manual, or scheduled events |
| `{{repo.fullName}}` | Repository reference |
| `{{run.id}}` | Review run id when available |
| `{{atMentions}}` | Pre-rendered channel-specific mention string |
| `{{vcs.branch}}` | Git branch name (when available) |
| `{{vcs.depot}}` | Perforce depot path (when available) |
| `{{vcs.workspace}}` | Perforce client workspace name (when available) |
| `{{vcs.repositoryPath}}` | Repository/depot reference path |
| `{{summary}}` | Summary Markdown |
| `{{problems}}` | Template problem list |
| `{{problem.file}}`, `{{problem.line}}`, `{{problem.location}}` | Location fields for one reported problem |
| `{{problem.severity}}`, `{{problem.category}}`, `{{problem.message}}`, `{{problem.suggestion}}` | Problem content fields |

Templates must use `{{problems}}` and `{{problem.*}}`; the removed `{{findings}}` and `{{finding.*}}` variables are not provided.

After rendering, AICR fixes and validates Markdown before dispatch. If a template cannot be made safe and valid, prefer a plain-text fallback over dropping the report.

Built-in templates must not render `[View PR]` for non-PR/MR events. For push, commit, P4, SVN, scheduled, or manual reviews, render `target.markdownLink` when available, otherwise render `target.displayText`, and omit the target line when neither exists. Commit/revision URLs may be derived from supported SCM providers or explicit URL templates such as a P4 Swarm changelist URL template.

Supported URL-template fields on triggers and channels are `commit_url_template`, `revision_url_template`, and `change_url_template`. Supported variables are `{{revision}}`, `{{commit}}`, `{{commit_id}}`, `{{headSha}}`, `{{head_sha}}`, `{{baseSha}}`, `{{base_sha}}`, `{{repo}}`, `{{repo_ref}}`, `{{provider}}`, `{{trigger}}`, and `{{workspace_id}}`; values are URL-encoded before substitution.

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

## Agent prompt requirement

The base system prompt in `prompts/system/code-reviewer.system.md` must keep the output protocol explicit:

- Report actionable issues through `aicr.report_problem`.
- Publish final summaries through `aicr.publish_summary`.
- Use `aicr.skip` only when no actionable result should be dispatched.
- Use `aicr.fetch_more_context` only for bounded, justified gaps.
- Do not treat stdout as the final review channel.

When changing the tool contract, update the prompt, this document, `Plan.md`, examples, and unit tests together.
