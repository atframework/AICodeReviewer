---
title: Output channels
description: How AICR's MCP report tools turn agent findings into PR comments, issues, and IM cards.
---

AICR separates the agent's job (code reasoning) from its own job (the report
contract, validation, routing, and rendering). Every formal review result flows
through AICR's tools, never through free-form agent stdout. The same reported
problem renders cleanly as a VCS line comment, an issue entry, or an IM summary
card.

## Automatic batch recovery

Automatic commit batches persist analysis results and per-channel receipts.
Recovery skips the analysis and confirmed sends. Each remote report write has a
stable operation ID, persisted before sending. GitHub/Gitea issue and review
publishers and GitLab MR publishers query a hidden body marker to recover lost
responses. Managed issue state changes and deletes query the original resource.

Feishu applications reuse a stable UUID for at most 59 minutes after the first
attempt. Feishu/WeCom webhooks cannot query an uncertain send and do not resend
it automatically. Missing or ambiguous markers, denied queries and expired UUIDs
retain an unknown outcome. Queries are limited to 20 pages of 100 items and a
30-second deadline. Report publication and local persistence are separate
transactions; exactly-once delivery is not guaranteed.

The existing retry budget and one terminal-failure recovery still apply.
The admin batches API exposes `publications` and `publicationOperations`, with
write and reconciliation counts. Manual Retry retains the remote journal;
changing configuration cannot erase an uncertain send. A journal exceeding the
1 MiB checkpoint cap stops publication while retaining its last saved state.
Use SQLite or Redis for restart persistence. Legacy checkpoints cannot recover
operation IDs they never saved; stop older writers before upgrading.

## The report tools

The in-process tool registry exposes these AICR tools to the review executor:

| Tool | Purpose | Required fields |
| --- | --- | --- |
| `aicr.report_problem` | Report one actionable problem anchored to a changed line | `file`, `line`, `severity`, `category`, `message` |
| `aicr.publish_summary` | Publish a structured Markdown review summary | `markdown` |
| `aicr.skip` | Mark the review as intentionally skipped | `reason` |
| `aicr.fetch_more_context` | Request source context for a changed or narrowly related file | `path`, `reason` |
| `aicr.try_blame` | Request VCS-verified, best-effort line attribution without file content | `path`, `reason` |

`aicr.fetch_more_context` and `aicr.try_blame` are read-only context tools. The
orchestrator replays them through the configured VCS adapter and runs a final
follow-up pass with the fetched content/attribution.

:::important[Free-form stdout is not a report]
Agent-adapter runs must not publish natural-language stdout as an IM summary.
If the agent cannot produce structured output, AICR triggers a structured
repair pass and, if that still fails, falls back to a direct LLM call.
Prose that says "no actionable problems" or "no reviewable code" is normalized
to `aicr.skip`, not published as a fallback message.
:::

## Problem schema

`aicr.report_problem` accepts a minimal, channel-neutral shape:

| Field | Required | Meaning |
| --- | --- | --- |
| `file` | Yes | Repository-relative path to the affected file |
| `line` | Yes | New-file line number for the primary anchor (must be a changed or diff-commentable line) |
| `end_line` | No | End line for a range problem (rendered as `file:start-end`) |
| `severity` | Yes | `info`, `low`, `medium`, `high`, or `critical` |
| `category` | Yes | Short problem family, e.g. `correctness`, `security`, `api-contract` |
| `message` | Yes | Problem analysis: what is wrong, trigger scenario, impact |
| `suggestion` | No | Smallest plausible fix direction; may include a fenced `diff` patch |
| `fingerprint` | No | Stable dedupe key (preserved in hidden comments where supported) |

`aicr.report_problem` does not accept agent-supplied attribution. When author
or revision context is needed, the agent calls `aicr.try_blame`; AICR validates
the request and feeds attribution back into a follow-up pass.

## Channel kinds

Channel `kind` is a free-form string constrained by the output implementation
registry (Zod validates the shape; the dispatcher resolves the kind).

| Kind | Problem output | Summary output | Notes |
| --- | --- | --- | --- |
| `gitea_pr_review` | One consolidated PR review/comment body | PR review / configured summary publisher | Problems are buffered and flushed as one Markdown body; falls back to one issue comment on 403/422 |
| `github_pr_review` | One consolidated PR review/comment body | PR review / configured summary publisher | Same buffer-and-flush as `gitea_pr_review`; falls back to issue comment on 403/422 |
| `gitlab_mr_review` | MR discussion when `baseSha`/`headSha` available | MR note / configured summary publisher | Falls back to a general MR note when line anchoring is unavailable |
| `gitea_problem_issue` / `github_problem_issue` / `gitlab_problem_issue` | Collected for reconciliation | Creates / updates / resolves managed problem issues | Fingerprint stability matters most here; `github_problem_issue` uses string label names and `resolved_action` supports `none`, `close`, and `mark_resolved` (GitHub has no issue delete API); on GitLab assignees must be project members and CE effectively supports one assignee |
| `gitea_issue` / `github_issue` | Collected, rendered into an issue comment | Aggregated issue comment | Useful for push events or issue-based triage |
| `feishu_bot` | Collected for aggregation | Interactive card (JSON 2.0 schema) | See [IM bots](/en/integrations/im-bots/) |
| `feishu_app` | Collected for aggregation | Shared Feishu card via application message API | Optional source-group directory for author mentions; see [IM bots](/en/integrations/im-bots/#feishu-custom-application) |
| `wecom_bot` | Collected for aggregation | Markdown message | See [IM bots](/en/integrations/im-bots/) |

:::note[Feishu cards use schema 2.0]
Feishu card payloads set `card.schema = "2.0"` and place markdown under
`card.body.elements`. The legacy 1.0 schema does not render inline code or
language-based code highlighting. AICR applies `toFeishuMarkdown()` before
dispatch.
:::

:::note[PR-review problems are buffered]
`gitea_pr_review` and `github_pr_review` buffer `publishProblem` calls and
flush them as **one** consolidated Markdown reply when `publishSummary` is
called. Do not expect one HTTP POST per problem or per-problem inline
comments. If you configure a PR-review channel only under `line_comments`,
the composite publisher must still call the summary flush, or buffered
problems will be dropped.
:::

## Managed problem-issue lifecycle

`gitea_problem_issue`, `github_problem_issue`, and `gitlab_problem_issue`
reconcile stale managed
issues across reviews. Key behaviors:

- **Fingerprint stability.** Each problem carries a `fingerprint`. AICR tracks
  open fingerprints in a hidden `aicr:problems` marker inside each managed
  issue. When a previously-open fingerprint disappears, the issue is moved to
  a Resolved section (and optionally closed).
- **File-scope resolution guard.** A problem is only marked "resolved" after
  the lifecycle model verifies the fix against current source. That normally
  requires the current review to re-analyze the file containing it, but a
  genuine empty review (for example an `lgtm` run) with lifecycle analysis
  active verifies every still-open stored fingerprint instead. Without model
  verification, a review that touches unrelated files or finds nothing will
  **not** mark previously-reported problems as resolved. Each managed-issue
  body embeds `aicr:file=<path>` so the file is recoverable.
- **Recent-issue cap.** Reconciliation lists only open issues (`state=open`),
  capped by `review.problem_issue.max_recent_issues` (default 30, range 1–200,
  overridable per workspace). Fingerprints outside the recent window are not
  deduplicated or closed in that run.
- **GitHub `resolved_action`.** Supports `none`, `close`, and `mark_resolved`
  (GitHub has no issue-delete API). Gitea and GitLab additionally support
  `delete` (on GitLab the token user must be a project owner or admin).
- **GitLab assignees.** Assignees who are not project members are silently
  dropped, and CE ignores the plural `assignee_ids` field, so AICR sends a
  single assignee via `assignee_id`. Newly added members become assignable
  only after GitLab's asynchronous member-authorization propagation.

See [Output channels config](/en/configuration/outputs/) for the
`issue_mode`, `resolved_action`, `assign_committer`, `owners_file`, and
severity-label fields.

## Routing

Channels without an explicit `trigger` use the compatible profile that accepted
the event. An explicit channel trigger takes precedence. GitHub App installation
tokens are resolved for the output channel's trigger and target repository.

GitLab MR channels preserve the full project path, including subgroups, and use
the merge request's project-local `iid`. Note Hooks read that identifier from
the top-level `merge_request`; a note ID or global MR ID cannot replace it.
See the [GitLab discussion API](https://docs.gitlab.com/api/discussions/).

Which channels receive `line_comments` and `summary` for a given review is
resolved per event. Which routing generation applies depends on the config:

- **v2 `routing.rules[]`** (when the config carries routing rules): rules
  match on `triggers`, `target_kinds`, and `source.repo_ref` with an explicit
  `priority`. Channel selection resolves per event as the matched rule's
  `outputs`, then `workspaces.instances.<id>.outputs`, then
  `workspaces.defaults.outputs`, then `outputs.routes.default`. An explicit
  `[]` closes that output kind; only an unset field inherits. A trigger must
  not be steered by both generations at once.
- **Legacy `outputs.routes`** (no routing rules configured): a `default`
  block plus optional `rules` matched on `trigger` and `target_kind`. The
  first matching rule with a non-empty list wins; empty lists fall through to
  the workspace instance, then the default, then — for `line_comments` only —
  the first `*_pr_review` channel.

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      - match: { trigger: p4-main, target_kind: commit }
        summary: [feishu-code-review]
```

## Zero-problem policy

`no_problems.action` decides whether a successful review with no actionable
problems should notify each channel (`publish`, `suppress`, or
`publish_if_summary`). Channels can override the global policy per-channel or
per-workspace. If every selected summary channel suppresses a zero-problem
result, the run is recorded as skipped with
`skipReason="no_problems_suppressed"`. The policy only controls visible
summaries: managed problem-issue channels still reconcile stored findings on
every genuine zero-problem review so confirmed fixes can close
(`resolved_action: none` opts out).

## Where to next

- Full per-channel options and the IM Markdown transforms: see
  [Output channels config](/en/configuration/outputs/).
- Full MCP tool input schemas and the `.aicr-output-state.json` flow: see
  [MCP tools](/en/integrations/mcp-tools/).
- Template variables for summary/problem rendering: see
  [Template variables](/en/reference/template-variables/).
- Setting up Feishu or WeCom group bots: see
  [IM bots](/en/integrations/im-bots/).
