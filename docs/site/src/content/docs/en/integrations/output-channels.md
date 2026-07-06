---
title: Output channels
description: How AICR's MCP report tools turn agent findings into PR comments, issues, and IM cards.
---

AICR separates the agent's job (code reasoning) from its own job (the report
contract, validation, routing, and rendering). Every formal review result flows
through AICR's tools, never through free-form agent stdout. The same reported
problem renders cleanly as a VCS line comment, an issue entry, or an IM summary
card.

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
| `gitea_problem_issue` / `github_problem_issue` | Collected for reconciliation | Creates / updates / resolves managed problem issues | Fingerprint stability matters most here; `github_problem_issue` uses string label names and `resolved_action` supports only `close` and `none` (GitHub has no issue delete API) |
| `gitea_issue` / `github_issue` | Collected, rendered into an issue comment | Aggregated issue comment | Useful for push events or issue-based triage |
| `feishu_bot` | Collected for aggregation | Interactive card (JSON 2.0 schema) | See [IM bots](/en/integrations/im-bots/) |
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

`gitea_problem_issue` and `github_problem_issue` reconcile stale managed
issues across reviews. Key behaviors:

- **Fingerprint stability.** Each problem carries a `fingerprint`. AICR tracks
  open fingerprints in a hidden `aicr:problems` marker inside each managed
  issue. When a previously-open fingerprint disappears, the issue is moved to
  a Resolved section (and optionally closed).
- **File-scope resolution guard.** A problem is only marked "resolved" when
  the current review actually re-analyzed the file containing it. A review
  triggered by a commit that touches unrelated files — or that finds nothing
  — will **not** mark every previously-reported problem as resolved. Each
  managed-issue body embeds `aicr:file=<path>` so the file is recoverable.
- **Recent-issue cap.** Reconciliation lists only the most recent open issues,
  capped by `review.problem_issue.max_recent_issues` (default 20, range 1–100,
  overridable per workspace). Fingerprints outside the recent window are not
  deduplicated or closed in that run.
- **GitHub `resolved_action`.** Supports `close` and `none` only (GitHub has
  no issue-delete API). Gitea additionally supports `delete`.

See [Output channels config](/en/configuration/outputs/) for the
`issue_mode`, `resolved_action`, `assign_committer`, `owners_file`, and
severity-label fields.

## Routing

`outputs.routes` decides which channels receive `line_comments` and `summary`
for a given review. A `default` block plus optional `rules` (matched on
`trigger` and `target_kind`) route reviews per provider/event type. Workspaces
can also pin channels via `workspaces.instances.<id>.outputs`.

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
`skipReason="no_problems_suppressed"`.

## Where to next

- Full per-channel options and the IM Markdown transforms: see
  [Output channels config](/en/configuration/outputs/).
- Full MCP tool input schemas and the `.aicr-output-state.json` flow: see
  [MCP tools](/en/integrations/mcp-tools/).
- Template variables for summary/problem rendering: see
  [Template variables](/en/reference/template-variables/).
- Setting up Feishu or WeCom group bots: see
  [IM bots](/en/integrations/im-bots/).
