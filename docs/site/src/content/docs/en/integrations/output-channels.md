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
registry (Zod validates the shape; the dispatcher resolves the kind). The
kinds exercised in `example/config.yaml`:

| Kind | Renders to |
| --- | --- |
| `gitea_pr_review` / `github_pr_review` / `gitlab_mr_review` | PR/MR line comments + one managed summary comment |
| `gitea_problem_issue` / `github_problem_issue` | Managed issues, one per problem (or consolidated), with lifecycle reconciliation |
| `gitea_issue` / `github_issue` | Generic issue comments for non-PR targets |
| `feishu_bot` | Feishu group bot card |
| `wecom_bot` | WeCom group bot Markdown message |

:::note[Feishu cards use schema 2.0]
Feishu card payloads set `card.schema = "2.0"` and place markdown under
`card.body.elements`. The legacy 1.0 schema does not render inline code or
language-based code highlighting. AICR applies `toFeishuMarkdown()` before
dispatch.
:::

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
  [Output channels config](/en/configuration/outputs/) (planned).
- Full MCP tool input schemas and the `.aicr-output-state.json` flow: see
  [MCP tools](/en/integrations/mcp-tools/) (planned).
- Template variables for summary/problem rendering: see
  [Template variables](/en/reference/template-variables/) (planned).
