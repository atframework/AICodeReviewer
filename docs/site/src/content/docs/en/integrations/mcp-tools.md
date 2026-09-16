---
title: MCP tools
description: AICR MCP tools for review output, source context, commit metadata, and review scope, including transport and follow-up behavior.
---

AICR exposes a small, stable set of MCP tools to the review agent. The agent
calls these tools to report findings; AICR owns validation, routing, and
rendering. Free-form agent stdout is never treated as the final report.

For how reported problems and summaries are rendered and dispatched per
channel, see [Output channels](/en/integrations/output-channels/). For the
agent runtimes that call these tools, see
[Agent adapters](/en/integrations/agent-adapters/).

## Tool overview

| Tool | Purpose |
| --- | --- |
| `aicr.report_problem` | Report one actionable problem anchored to a changed line |
| `aicr.publish_summary` | Publish a structured Markdown review summary |
| `aicr.skip` | Mark the review as intentionally skipped |
| `aicr.fetch_more_context` | Request source context for a changed or narrowly related file |
| `aicr.try_blame` | Request VCS-verified, best-effort line attribution without file content |
| `aicr.get_review_commits` | Query reviewed commits/revisions, files, patches and optional author/repository metadata |
| `aicr.get_review_context` | Recover the current review endpoints, repository/branch identities and effective file scope |

`aicr.fetch_more_context` and `aicr.try_blame` are read-only context tools.
The orchestrator replays them through the configured VCS adapter and runs a
final follow-up pass with the fetched content/attribution.

## `aicr.get_review_commits`

Read the current review's VCS range. The caller cannot select another repository
or revision. Git uses all commits reachable from head and not base, including
merged side branches; a query without base reads only head. SVN/P4 use
`(base, head]`, or the single revision/changelist when base is absent.
Automatic `head_only` review policy limits membership to head.

| Field | Default | Description |
| --- | --- | --- |
| `detail` | `ids` | `ids`: revision IDs only; `files`: files per commit; `diffs`: files and complete structured patches per commit; `summary`: union of files in this page |
| `include_authors` | `false` | Include recorded author/committer name and email, SVN username or P4 user/workspace when available |
| `include_repositories` | `false` | Include `repositories.source` and `repositories.target`, each with `repository` and `branch` |
| `limit` | `20` | Commits per page, from 1 to 100 |
| `cursor` | absent | Opaque `next_cursor` from a previous response in this review; keep the same detail/metadata options |
| `max_bytes` | `200000` | Response byte limit, from 1024 to 1048576; oversized responses fail without truncating a patch |

Results contain `status: complete | partial | unavailable`, `vcs`, and
`commits: [{ revision, ... }]`. `partial` includes `next_cursor`; follow it to
finish the range. Git orders commits topologically from head toward base;
SVN/P4 order revisions ascending. Cursors are signed for the active review
and cannot be reused after it ends. For `summary`, `files_scope: "page"`
means the caller unions `files` across all pages to obtain the full list.
Reverted files can appear here even when absent from the net review diff.

`diff` contains `files` with paths, status, raw headers and hunks; hunk lines
carry their kind, content and old/new line numbers. Patches use three context
lines and compare Git merges with their first parent. Binary contents are not
returned as text. SVN/P4 file paths respect the configured adapter scope.
An empty commit has an empty patch. Reduce `limit` or increase `max_bytes`
when a response is too large; `files` can be used when a patch exceeds the cap.

Author fields are VCS-recorded values: `username`, `display_name`, `email`,
`workspace`, `committer_name`, `committer_email`. Missing values are `null`.
Git display names are not platform usernames, so Git `username` remains
`null`; the tool does not infer linked accounts. Commit reviews use the same
repository and branch for source and target. PR/MR reviews preserve the
requester's source and the receiving target, including forks. Old events,
deleted forks or incomplete payloads can leave source identity unknown.

```json
{
  "toolCalls": [
    {
      "name": "aicr.get_review_commits",
      "input": {
        "detail": "diffs",
        "include_authors": true,
        "include_repositories": true,
        "limit": 5
      }
    }
  ]
}
```

## `aicr.get_review_context`

Pass `{}` to recover `provider`, `target_kind`, `base_revision`,
`head_revision`, `repositories`, `commit_strategy`, `reviewed_files` and
`reviewed_file_count`. These are the effective review files after filtering
and commit policy. At most 1000 paths are returned; `files_truncated` states
whether more exist. This tool helps restore scope after context compression
and distinguish historical commit files from the files actually reviewed.

Both review-data tools work through the in-process registry and native MCP.
Native stdio/HTTP calls record `reviewDataRequests` in the output state and
return `pending: true`. End that pass: the host queries its VCS adapter and
supplies the result in the next bounded follow-up pass. Credentials stay with
the host. Standalone MCP without review orchestration only records requests.
Unavailable history or missing metadata must not be treated as an empty review.
Verify historical findings against the final head before reporting them.

## `aicr.report_problem`

Report one actionable code-review problem anchored to a changed line.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `file` | yes | string | Repository-relative path to the affected file |
| `line` | yes | int | New-file line number for the primary anchor; must be a changed or diff-commentable line |
| `end_line` | no | int | End line for a range problem; rendered as `file:start-end` |
| `severity` | yes | enum | `info`, `low`, `medium`, `high`, `critical` |
| `category` | yes | string | Short problem family (`correctness`, `security`, `api-contract`, …); kept stable for grouping/dedupe |
| `message` | yes | string | Problem analysis: what is wrong, the trigger scenario, and the impact. This is the primary comment body |
| `suggestion` | no | string | Smallest plausible fix direction; may include a fenced `diff` patch |
| `fingerprint` | no | string | Stable dedupe key; preserved in hidden comments where supported |

Behavior notes:

- `aicr.report_problem` does **not** accept agent-supplied attribution. When
  author or revision context is needed for analysis, call `aicr.try_blame`;
  AICR validates attribution through event metadata, provider APIs, or the
  configured VCS adapter before feeding it back. Attribution stays advisory
  and never becomes part of the problem fingerprint.
- Use `message` for analysis and `suggestion` for the fix. If a patch is
  useful, place a small fenced `diff` inside `suggestion` rather than adding a
  separate field.
- Git-based channels may enrich a reported problem with an AICR-derived code
  reference snippet taken from the parsed diff. This does not add fields to
  the tool — agents should still report only the stable schema above.

Example:

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
        "suggestion": "Persist the failed state before returning from the retry branch."
      }
    }
  ]
}
```

## `aicr.publish_summary`

Publish a structured Markdown review summary.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `title` | no | string | Short, channel-friendly title; rendered as a secondary heading or top title when appropriate |
| `markdown` | yes | string | Full structured analysis body in Markdown |

Used for PR/MR summary comments, Gitea managed problem issues, IM bot
aggregated reports, and push/commit/P4 changelist/SVN revision events where
there may be no line-comment target. For push/commit/P4 events, publish a
non-empty summary when configured channels need an audit trail; the
`no_problems` policy decides per channel whether a zero-problem result is
published or suppressed.

Example:

```json
{
  "toolCalls": [
    {
      "name": "aicr.publish_summary",
      "input": {
        "title": "Found 1 high-severity issue",
        "markdown": "## Review Summary\n\nFound 1 high-severity issue; recommend fixing the transaction commit ordering first."
      }
    }
  ]
}
```

## `aicr.skip`

Mark the review as intentionally skipped.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `reason` | yes | string | Skip reason (for example `lgtm`, `no_reviewable_code`, `no_output_publisher`) |

Use `aicr.skip` when no actionable result should be dispatched, including
empty or no-reviewable-code changes. When an agent repair attempt only
returns prose equivalent to "no actionable problems" or "no reviewable code",
AICR normalizes it to `skipReason="lgtm"` or `skipReason="no_reviewable_code"`
so IM channels stay quiet.

## `aicr.fetch_more_context`

Request source context for a changed file or narrowly related repository file.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `path` | yes | string | Repository-relative path to fetch |
| `range` | no | object | Optional line range (`start_line`, `end_line`) |
| `reason` | yes | string | Why this context is needed for the review |

Use it to close source-context gaps during review:

- Request a changed file with no `range` when the diff is missing or too
  narrow.
- Request a related file outside the change **only** when it is needed to
  understand an API contract, call path, schema, generated interface, or
  configuration that directly affects a changed line.

Adapters keep the initial scoped fetch minimal (only changed files are
written to the workspace). When a related file was not already materialized,
AICR fetches it from VCS at the reviewed revision and persists it for
subsequent reads:

- git: `git show <revision>:<path>`
- P4: `p4 print <path>@<revision>` (within the configured depot)
- SVN: `svn cat -r <revision> <repository_url>/<path>`

A request for a path that does not exist at the revision (or is outside the
configured repository/depot) is rejected — that rejection is the signal to
stop retrying that path.

## `aicr.try_blame`

Request VCS-verified, best-effort line attribution without file content.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `path` | yes | string | Repository-relative path |
| `range` | no | object | Optional line range (`start_line`, `end_line`) |
| `reason` | yes | string | Why attribution is needed |

Use it only when ownership, recent-change authorship, or revision provenance
materially affects the review. Results carry `status: ok | partial | not_found`
plus line/revision/author metadata when available — never source text. If the
active VCS adapter has no attribution backend, AICR returns `not_found`
rather than asking the model to infer authorship.

## Output-state flow

After every tool call, the MCP output server writes `.aicr-output-state.json`
into the isolated `agent/` directory of the run. When the agent run finishes,
the orchestrator reads that state file and populates AICR's output collector
from it — validated problems, summaries, the skip reason, recorded
`contextRequests`, recorded `attributionRequests`, and `reviewDataRequests`.

This state file is the structured contract between the agent and AICR. The
orchestrator:

1. Clears any stale `.aicr-output-state.json` before each agent run, so a
   previous repair pass cannot leak into the next output.
2. Reads the state after the run.
3. Executes recorded `aicr.fetch_more_context` requests through the VCS
   adapter's `fetchExtraContext`.
4. Executes recorded `aicr.try_blame` requests through the VCS adapter's
   `fetchAttribution` when supported.
5. Executes review-data requests through the current review's host handler
   and Git/SVN/P4 adapter.
6. Runs a final follow-up pass with the fetched content/attribution/metadata fed back
   in, then publishes results.

:::caution[Container workdir must be `/workspace/agent`]
Docker/Podman sandbox runs must set the container workdir to the writable
agent mount. Otherwise agent-spawned MCP servers write
`.aicr-output-state.json` under the image workdir (for example `/app`) and
the orchestrator misses the structured results. See
[Troubleshooting](/en/troubleshooting/).
:::

## Transports

The `@aicr/mcp-output` package provides one in-process tool registry used by
the review executor, plus two server transports that share the same tool set
and `.aicr-output-state.json` contract:

- **stdio** (default for runtime bundles): each agent runtime bundle
  materializes a local stdio `aicr-output` MCP server config and the agent
  talks to it over its native MCP client.
- **Streamable HTTP** (testing / remote-MCP clients): start the same tools
  over a local HTTP endpoint:

  ```bash
  node packages/mcp-output/dist/server.js --transport http --host 127.0.0.1 --port 3000
  ```

  Use this for transport-level smoke tests outside an agent, or for clients
  that only speak HTTP MCP. Production agent runtime bundles still use stdio
  unless an adapter explicitly chooses HTTP.

## Kilo MCP tool-name normalization

Kilo Code (≥7.x) prefixes MCP tool names with the server name and converts
dots to underscores. A call to `aicr.report_problem` is emitted as
`aicr-output_aicr_report_problem`. AICR's `normalizeToolName` maps that
format back to the canonical `aicr.*` names before executing, so the agent
and AICR agree on tool identity.

As a compatibility fallback, Kilo JSON-stream `tool_call` / `tool_use`
events are also captured and executed when the MCP state file is missing, so
`aicr.fetch_more_context` and `aicr.try_blame` requests are never silently
dropped just because stdout lacked a final JSON payload.
