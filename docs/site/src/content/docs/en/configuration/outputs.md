---
title: Output Channels and Routing
description: Configure output channels, routing rules, the zero-problem policy, label management, and the managed-problem-issue lifecycle.
---

After a review finishes, AICodeReviewer dispatches the result to one or more
**output channels** — PR line comments, IM bots, managed issues — based on
**routing rules**. The `outputs` namespace defines the channels, the routes,
the template engine, and the zero-problem policy that decides whether a
clean review should notify anyone.

```yaml
outputs:
  template_engine: handlebars
  no_problems: { action: suppress }
  channels:
    - name: gitea-pr-review
      kind: gitea_pr_review
      trigger: gitea
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
```

## `outputs.template_engine`

| Value | Description |
| --- | --- |
| `handlebars` (default) | Handlebars templates (`*.hbs`). Built-ins live in `templates/builtin/*.hbs`. |
| `eta` | ETA templates. |

Override templates per workspace by placing files under
`workspaces/<workspace_id>/templates/`. Candidate file names are checked in
order: `<channel_name>.<kind>.md.hbs` → `<channel_name>.<kind>.hbs` →
`<channel_kind>.<kind>.md.hbs` → `<channel_kind>.<kind>.hbs` →
`<kind>.md.hbs` → `<kind>.hbs`.

## `outputs.no_problems` — zero-problem policy

Decides whether a successful review with **no actionable problems** should
notify each channel. Notification channels are quiet by default; lifecycle or
audit channels can opt in to publish.

| `action` | Behavior |
| --- | --- |
| `suppress` (default in the sample) | Do not notify when there are no problems. |
| `publish` | Always notify, even with zero problems. |
| `publish_if_summary` | Notify only if a non-empty summary was produced. |

The policy is set at three levels, each more specific:

1. `outputs.no_problems` (global default for all channels)
2. per-channel `no_problems` inside `outputs.channels[]`
3. per-workspace + per-channel via
   `workspaces.instances.<id>.outputs.channel_overrides.<channel>.no_problems`

```yaml
outputs:
  no_problems: { action: suppress }
  channels:
    - name: feishu-code-review
      kind: feishu_bot
      no_problems: { action: suppress }

workspaces:
  instances:
    critical-service:
      outputs:
        channel_overrides:
          feishu-code-review:
            no_problems: { action: publish }   # this repo wants an audit trail
```

If all selected summary channels suppress a zero-problem result, the run is
recorded as skipped with `skipReason="no_problems_suppressed"`.

## `outputs.channels[]` — output targets

Every channel has a `name` (referenced by routes and workspace output lists)
and a `kind`. The common fields below apply to most kinds; kind-specific
fields are listed under each kind.

### Common fields

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Unique channel id. |
| `kind` | string | Channel kind (see list below). `gitea_finding_issue` is removed — use `gitea_problem_issue`. |
| `trigger` | string | Trigger name this channel binds to (for VCS-backed kinds). |
| `mention_author` | bool | @-mention the commit author in the message. |
| `mention_fallback` | enum | `all` (mention everyone) or `skip` (no mention if author not found). |
| `no_problems` | object | Per-channel zero-problem policy (see above). |
| `commit_url_template` | string | Override commit link for push/commit targets. |
| `revision_url_template` | string | Override revision link (P4/SVN). |
| `change_url_template` | string | Override change link. |
| `marker_prefix` | string | Title prefix for managed issues (e.g. `[AICR]`). |
| `marker_label` | string | Hidden label identifying managed issues (e.g. `aicr-managed`). |
| `labels` | string[] | Labels to attach. |
| `label_ids` | int[] | Numeric label ids (some VCS APIs). |
| `issue_mode` | enum | `per_problem`, `consolidated` (default), or `per_commit`. |
| `resolved_action` | enum | `none`, `close`, `mark_resolved`, or `delete`. Action when a problem is fixed. |
| `assign_committer` | bool | Add the commit author as assignee (default `true`). |
| `owners_file` | string | Path to OWNERS file (default `OWNERS`). |
| `add_owners_as_assignees` | bool | Add matched OWNERS as assignees. |
| `severity_label_prefix` | string | Auto-created label prefix (e.g. `aicr:problem:`). |
| `severity_label_colors` | map | Custom label colors (hex without `#`). |
| `review_mode` | enum | `auto` (default), `review`, or `comment`. |
| `review_event` | enum | `COMMENT` (default) or `REQUEST_CHANGES`. |
| `review_update_strategy` | enum | `always_new` or `update_existing` (default). |
| `notify_feishu` | object | Optional Feishu notify-on-issue-creation (`webhook_url_env`, `secret_env`). |

### Channel kinds

| Kind | Description |
| --- | --- |
| `gitea_pr_review` | Inline line comments on Gitea/Forgejo pull requests. |
| `github_pr_review` | Inline line comments on GitHub pull requests. |
| `gitlab_mr_review` | Inline line comments on GitLab merge requests. |
| `gitea_problem_issue` | Managed Gitea issues created/closed per problem fingerprint. |
| `github_problem_issue` | Managed GitHub issues per problem fingerprint (no delete — GitHub does not support it). |
| `gitea_issue` | Post the aggregated review as a comment on an existing Gitea issue. |
| `github_issue` | Post the aggregated review as a comment on an existing GitHub issue. |
| `feishu_bot` | Push aggregated problems to a Feishu (飞书) group via custom bot. |
| `wecom_bot` | Push aggregated problems to a WeCom (企业微信) group via webhook. |

### `review_mode` — PR review API strategy

For `*_pr_review` / `*_mr_review` kinds:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Try the PR review API first; fall back to issue comment on 403/422. |
| `review` | Always use the PR review API, no fallback. |
| `review_event` `COMMENT` (default) / `REQUEST_CHANGES` | Controls the review event type when using the review API. |

### PR review summary update strategy

`review_update_strategy` controls how the PR summary behaves across pushes:

| Value | Behavior |
| --- | --- |
| `always_new` | Create a new review/comment on every push (original behavior). |
| `update_existing` (default) | Find and update the previous AICR summary comment on the PR. Open issues are kept; resolved issues are marked with ✅; new issues are tagged with the introducing commit. |

AICR identifies its own managed comments via stable **managed comment markers**
derived from `marker_prefix`/`marker_label`, so only AICR-owned summary
comments are updated and other comments are left untouched.

## `outputs.routes` — send results to the right channels

Routes map review outputs (`line_comments` and `summary`) to channel lists.
A `default` route applies to every event; `rules[]` override for specific
triggers or target kinds.

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      - match:
          trigger: p4-main
          target_kind: commit
        summary: [feishu-code-review]
      - match:
          trigger: github
          target_kind: push
        summary: [feishu-code-review, github-problem-issues]
```

| Field | Type | Description |
| --- | --- | --- |
| `default.line_comments` | string[] | Channels for inline line comments. |
| `default.summary` | string[] | Channels for the aggregated summary. |
| `rules[].match.trigger` | string | Match events from this trigger name. |
| `rules[].match.target_kind` | string | Match a target kind (e.g. `commit`, `push`, `pull_request`). `pr` is normalized to `pull_request`. |
| `rules[].line_comments` | string[] | Override line-comment channels for matched events. |
| `rules[].summary` | string[] | Override summary channels for matched events. |

Per-workspace output lists (`workspaces.instances.<id>.outputs.line_comments`
and `.summary`) take precedence over the global routes for that workspace.

## Label management (`review.labels`)

AICodeReviewer can skip reviews based on labels and auto-tag PRs/MRs/issues.
This lives under `review` (not `outputs`) but is closely related to output
dispatch.

```yaml
review:
  labels:
    ignore: ["aicr:ignore", "aicr-ignore"]   # skip review if any label matches
    auto_tag: "aicr"                         # tag added when AICR starts
    reviewed_tag: "aicr:reviewed"            # tag added when review completes
```

| Field | Behavior |
| --- | --- |
| `ignore` | Checked at the webhook layer. If a PR/MR/issue carries any listed label, AICR returns immediately without scheduling a review. |
| `auto_tag` | Fixed tag applied by output dispatchers (`gitea_pr_review`, `github_pr_review`, `gitlab_mr_review`, `gitea_issue`, `gitea_problem_issue`) when publishing. Created automatically if missing. |
| `reviewed_tag` | Tag applied when a review completes. |

All fields support the global → workspace-level override layering.

## Managed problem-issue lifecycle limit

`gitea_problem_issue` and `github_problem_issue` reconcile stale managed
issues by listing only the most recent open issues. The cap lives under
`review.problem_issue` and can be tightened per workspace.

```yaml
review:
  problem_issue:
    max_recent_issues: 20   # default; valid range is 1..100

workspaces:
  instances:
    latency-sensitive-service:
      review:
        problem_issue:
          max_recent_issues: 10
```

If a repository has more open managed issues than the limit, fingerprints
outside the recent window are not deduplicated or closed in that run. Later
runs — or a temporarily raised cap — handle large cleanup runs.

If one configured output channel cannot publish, AICR logs the channel failure
and continues trying the remaining routed channels. A run where every dispatch
attempt fails is reported as `skipped` with
`skipReason: output_dispatch_failed` (instead of
`review_orchestration_failed`), so the review result and failure cause stay
visible without poisoning the trigger queue.

## Non-PR target links

Built-in templates render `target.markdownLink` / `target.displayText` instead
of assuming every review is a PR. Gitea, Forgejo, GitHub, and GitLab commit
links are derived from trigger `base_url`, repo, and revision. P4/SVN/internal
systems provide explicit URL templates via the trigger's `change_url_template`
or `revision_url_template` (variables are URL-encoded before substitution):

```yaml
triggers:
  - name: p4-main
    kind: p4
    change_url_template: "https://swarm.example.com/changes/{{revision}}"
  - name: svn-main
    kind: svn
    revision_url_template: "https://svn.example.com/viewvc/project?view=revision&revision={{revision}}"
```

## Where to go next

- The full per-channel field contract, including the MCP tool contract that
  agents use to fetch more context, is in
  [Output channels](/en/integrations/output-channels/).
- For trigger-side URL templates and file filters, see
  [VCS providers](/en/integrations/vcs-providers/).
