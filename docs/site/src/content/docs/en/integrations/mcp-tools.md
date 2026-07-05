---
title: MCP tools
description: Full reference for the five AICR MCP tools exposed to review agents, the output-state flow, and transport options.
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

`aicr.fetch_more_context` and `aicr.try_blame` are read-only context tools.
The orchestrator replays them through the configured VCS adapter and runs a
final follow-up pass with the fetched content/attribution.

## `aicr.report_problem`

Report one actionable code-review problem anchored to a changed line.

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `file` | yes | string | Repository-relative path to the affected file |
| `line` | yes | int | New-file line number for the primary anchor; must be a changed or diff-commentable line |
| `end_line` | no | int | End line for a range problem; rendered as `file:start-end` |
| `severity` | yes | enum | `info`, `low`, `medium`, `high`, `critical` |
| `category` | yes | string | Short problem family (`correctness`, `security`, `api-contract`, …); kept stable for grouping/dedupe |
| `message` | no | string | Problem analysis: what is wrong, the trigger scenario, and the impact. This is the primary comment body |
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
| `range` | no | object | Optional line range (`startLine`, `endLine`) |
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
| `range` | no | object | Optional line range (`startLine`, `endLine`) |
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
`contextRequests`, and recorded `attributionRequests`.

This state file is the structured contract between the agent and AICR. The
orchestrator:

1. Clears any stale `.aicr-output-state.json` before each agent run, so a
   previous repair pass cannot leak into the next output.
2. Reads the state after the run.
3. Executes recorded `aicr.fetch_more_context` requests through the VCS
   adapter's `fetchExtraContext`.
4. Executes recorded `aicr.try_blame` requests through the VCS adapter's
   `fetchAttribution` when supported.
5. Runs a final follow-up pass with the fetched content/attribution fed back
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
