# Output channels and MCP report contract

This document is the user-facing module for AICodeReviewer report output. Keep it aligned with `packages/mcp-output/src/index.ts`, `packages/outputs/src/index.ts`, `packages/outputs/src/template-engine.ts`, `docs/ai/architecture.md` §3.9-§3.10, and `example/config.yaml`.

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
| `aicr.fetch_more_context` | Request source context for a changed file or narrowly related repository file | `path`, `reason` |

Planned attribution, memory, and skill recall tools are tracked by the `Plan.md` roadmap and detailed in `docs/ai/architecture.md`; do not describe them as implemented until they exist in `packages/mcp-output` and tests.

`@aicr/mcp-output` provides the in-process registry used by direct LLM/stdout-compatible runs, the stdio MCP server materialized into Kilo runtime bundles, and an optional local Streamable HTTP endpoint started with `aicr-mcp-server --transport http`. Runtime bundles still use stdio by default. Both server transports write `.aicr-output-state.json` in the isolated `agent/` directory after tool calls; the orchestrator reads that state, validates review outputs, executes any recorded `aicr.fetch_more_context` requests through the configured VCS adapter, and reruns a final pass with fetched content when needed.

## Problem schema

`aicr.report_problem` accepts a minimal, channel-neutral shape:

| Field | Required | Meaning | Rendering notes |
| --- | --- | --- | --- |
| `file` | Yes | Repository-relative path to the affected file | Used as PR/MR line-comment path and issue location |
| `line` | Yes | New-file line number for the primary anchor | Must be a changed or diff-commentable line when possible; deleted `-N` diff lines are old-code lines and must not be used as current-code anchors |
| `end_line` | No | End line for a range problem | Rendered as `file:start-end`; line-comment APIs may fall back to a single-line anchor |
| `severity` | Yes | `info`, `low`, `medium`, `high`, or `critical` | Use conservative severity calibration from the system prompt |
| `category` | Yes | Short problem family such as `correctness`, `security`, or `api-contract` | Kept stable for grouping and dedupe |
| `message` | Yes | Problem analysis: what is wrong, trigger scenario, and impact | This is the primary review comment body |
| `suggestion` | No | Smallest plausible fix direction; may include a fenced `diff` patch | Rendered under “Suggested fix” in VCS and issue channels |
| `fingerprint` | No | Stable dedupe key | Preserved in hidden comments where supported |

Git-based output channels may enrich a reported problem with an AICR-derived code reference snippet during publishing. The snippet is taken from the parsed diff around `file:line`, scrubbed for secrets, and rendered by templates as a fenced Markdown code block. This does not add fields to `aicr.report_problem`; agents should still report only the stable problem schema above.

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

`aicr.publish_summary` takes Markdown in `markdown` and may also carry a short optional `title`. The title is intended to be concise and channel-friendly; built-in summary templates render it as a secondary heading or top title when appropriate.

`aicr.publish_summary` is used for:

- PR/MR summary comments when a channel supports summary publishing.
- Gitea managed problem issues.
- IM bot aggregated reports (Feishu, WeCom, etc.).
- Push, commit, P4 changelist, and SVN revision events where there may be no line-comment target.

For push/commit/P4 events, publish a non-empty summary when configured channels need an audit trail. The `no_problems` policy decides per channel whether a zero-problem result is published or suppressed.

For agent-CLI reviews, free-form stdout is not treated as the final report. If stdout does not contain a parseable AICR JSON/XML tool payload, the orchestrator asks the agent for a bounded structured repair pass. This prevents interim reasoning such as “let me fetch more context” from leaking into IM cards and ensures problem locations come from `aicr.report_problem` records rather than prose summaries. If the repair output is still prose but clearly says there are no actionable problems or no reviewable code, AICR records a skip (`lgtm` or `no_reviewable_code`) instead of publishing a fallback error summary; otherwise it falls back to direct LLM repair before generating the generic fallback summary.

Likewise, a summary that says issues were found is not a machine-readable finding. When a run has `problemCount=0` but the summary text claims actionable problems, AICR treats the summary as provisional and asks for a structured repair. If the repair still does not produce `aicr.report_problem` records, AICR replaces the claim with a fallback summary instead of publishing or suppressing misleading issue prose without locations. Skip reasons or summaries that ask a human to provide diff/source context, or say the full repository/source cannot be accessed or verified, are also repaired: AICR prompts the agent to inspect materialized source with read-only shell commands or request concrete files through `aicr.fetch_more_context`, then feeds the fetched content back for a final structured result.

`aicr.fetch_more_context` is the supported way to close context gaps during review. Agents should request a changed file with no `range` when the diff is missing or too narrow, and may request a related file outside the change only when it is needed to understand an API contract, call path, schema, generated interface, or configuration that directly affects a changed line. In agent sandboxes, already scoped files may also be inspected with read-only commands such as `rg`, `fd`, `bat --paging=never --style=plain`, `jq`, and `yq`; prefer them over `grep`, recursive `find`, raw `cat`, or ad-hoc YAML parsing when the runtime image guarantees them. Kubernetes and Helm checks should stay local/offline (`helm template`, `helm lint`, `kubectl kustomize`) unless the task explicitly requires live cluster access. Missing files must still be requested through `aicr.fetch_more_context` rather than reported as inaccessible. Adapters keep the initial scoped fetch minimal (only changed files are written to the workspace); when a related file was not already materialized, AICR fetches it from VCS at the reviewed revision and persists it for subsequent reads — git adapters use `git show <revision>:<path>`, P4 adapters use `p4 print <path>@<revision>`, and SVN adapters use `svn cat -r <revision> <repository_url>/<path>`. A request for a path that does not exist at the revision (or is outside the configured repository/depot) is rejected, which is the signal that the agent should stop retrying that path.

Recommended pattern:

- `title`: one short line, suitable for a summary heading.
- `markdown`: the full structured analysis body.

Example:

```json
{
  "toolCalls": [
    {
      "name": "aicr.publish_summary",
      "input": {
        "title": "发现 1 个高风险问题",
        "markdown": "## Review Summary\n\n发现 1 个高风险问题，建议优先修复事务提交时序。"
      }
    }
  ]
}
```

If a run has problems but records `skipReason="no_output_publisher"`, no summary route selected a publishable channel for that event. Add an `outputs.routes.rules[].summary` rule or a workspace-level `outputs.summary` entry for the trigger/target, for example to send GitHub push reviews to `feishu_bot` and/or `github_problem_issue`.

## Channel mapping

| Channel kind | Problem output | Summary output | Notes |
| --- | --- | --- | --- |
| `gitea_pr_review` | One consolidated PR review/comment body | PR review / configured summary publisher | Problems are buffered and flushed into one Markdown body; falls back to one issue comment on 403/422 |
| `github_pr_review` | One consolidated pull request review/comment body | Pull request review / configured summary publisher | Problems are buffered and flushed into one Markdown body; falls back to one issue comment on 403/422 |
| `gitlab_mr_review` | Merge request discussion when `baseSha` and `headSha` are available | Merge request note / configured summary publisher | Falls back to a general MR note when line anchoring is unavailable |
| `gitea_issue` | Collected, then rendered into an issue comment | Aggregated issue comment | Useful for push events or issue-based triage |
| `gitea_problem_issue` | Collected for reconciliation | Creates, updates, or resolves managed problem issues | Fingerprint stability matters most here |
| `github_issue` | Collected, then rendered into an issue comment | Aggregated issue comment | Same as `gitea_issue` but for GitHub repositories |
| `github_problem_issue` | Collected for reconciliation | Creates or resolves managed GitHub issues | Like `gitea_problem_issue` but uses string label names; `resolved_action` supports `close` and `none` only (GitHub has no issue delete API) |
| `feishu_bot` | Collected for aggregation | Interactive card Markdown (JSON 2.0 schema) | Renders sectioned `Review target` / `Summary` / `Problems` blocks. Cards are sent with `card.schema = "2.0"` so headings, tables, inline code (`code`), and fenced code blocks with language-based syntax highlighting render natively; each problem includes severity, category, `Location: file:line`, and truncated message/suggestion; built-in summaries render `@username (Display Name)` when both are available |
| `wecom_bot` | Collected for aggregation | Markdown message | Same sectioned content as Feishu; messages are truncated to 500 chars and suggestions to 300 chars to stay within size limits; built-in summaries render `@username (Display Name)` when both are available |

## PR/MR review summary update mode

PR/MR review channels (`gitea_pr_review` and `github_pr_review`) support
`review_update_strategy`:

- `update_existing` (default): AICR looks for an existing managed PR summary
  comment and updates it through the issue-comment API (`PATCH`). It creates a
  new managed comment only when no same-scope comment exists.
- `always_new`: AICR preserves the original behavior and creates a new
  review/comment for each summary publish.

Managed summary comments always include these hidden markers:

- `<!-- aicr:managed=pr-review -->` identifies comments owned by AICR.
- `<!-- aicr:scope=<channel-name> -->` prevents multiple PR review channels on
  the same PR from overwriting each other.
- `<!-- aicr:problems=fp1,fp2 -->` tracks the current problem fingerprints.
- `<!-- aicr:problem-meta=BASE64_JSON -->` stores per-problem metadata
  (severity, category, file, line) so resolved issues can be rendered with
  readable titles instead of raw fingerprint hashes.

When updating a managed comment, AICR renders current problems as open issues
with stable anchor IDs, keeps previously open fingerprints as still-open when
they remain, and lists missing fingerprints in a Resolved section. Each resolved
item shows its original title (`[SEVERITY] category — file:line`) when metadata
is available. Legacy comments without metadata render a readable
`Previously reported issue` placeholder instead of exposing the raw fingerprint.
The fingerprint parser tolerates legacy marker formatting with whitespace such
as `fp1, fp2`.

Problem dispatching for PR/MR review channels is batched: `publishProblem`
buffers each problem internally; `publishSummary` flushes all buffered problems
as one Markdown reply body. This also applies when the PR review channel is only
configured under `outputs.routes.*.line_comments`; the summary flush is still
called so buffered problems are not dropped. Code reference snippets are grouped
inside the same reply body instead of being split across per-problem comments.

Comment commands can trigger a manual re-review on PR/MR threads:

- `/aicr review`
- `/review`

In async mode, concurrent requests for the same target are deduplicated. If a
review is already running, the latest matching comment command becomes a single
pending re-review and runs after the current review completes.

## Managed problem issue fetch limit

Managed issue lifecycle reconciliation is intentionally bounded. Before closing or deleting stale managed issues, AICR lists only the most recent open issues up to the effective `review.problem_issue.max_recent_issues` value:

- Default: `20`.
- Supported range: `1` to `100`.
- Precedence: global `review.problem_issue.max_recent_issues`, then `workspaces.defaults.review.problem_issue.max_recent_issues`, then `workspaces.instances.<workspace_id>.review.problem_issue.max_recent_issues`.
- GitHub uses the repository issues API with `sort=updated`, `direction=desc`, `per_page=<limit>`, and `page=1`.
- Gitea/Forgejo uses the repository issues API with `type=issues`, `limit=<limit>`, and `page=1` for broad version compatibility.

When a repository has more open managed problem issues than the limit, fingerprints outside the recent window are not deduplicated or closed in that run. Temporarily raise the limit, or run repeated scheduled reviews, when doing a one-time cleanup of a large backlog.

```yaml
review:
  problem_issue:
    max_recent_issues: 20

workspaces:
  instances:
    latency-sensitive-service:
      review:
        problem_issue:
          max_recent_issues: 10
```

## Managed Gitea problem issues

The `gitea_problem_issue` channel reconciles managed Gitea issues based on problem fingerprints. On every summary publish it creates issues for new fingerprints and applies `resolved_action` to open managed issues whose fingerprints disappeared from the latest analysis.

By default, all problems from one review run are combined into a single issue (`issue_mode: consolidated`). When `issue_mode: per_problem` is set, each problem gets its own issue with fingerprint-based reconciliation. The consolidated issue is identified by a scope fingerprint (channel + owner + repo) and updated on subsequent reviews. When no problems are found, the consolidated issue is closed or deleted according to `resolved_action`.

When updating an existing consolidated issue, the dispatcher tracks per-fingerprint resolution and protects against webhook replay:

- The issue body includes hidden markers `<!-- aicr:commit={headSha} -->`, `<!-- aicr:open_problems=fp1,fp2 -->`, and `<!-- aicr:fp={fp} -->` after each problem heading.
- On update, the VCS compare API verifies commit ordering. If the current commit is ahead, the dispatcher categorizes problems into new, still-open, and resolved, rendering a collapsible "Resolved" section in the body. If the same commit is analyzed again, no problems are marked resolved (preventing LLM output variability from causing false resolutions). If the current commit is behind, the update is skipped entirely. If the compare API fails, the body is updated without categorization.
- Issues created before these markers are fully backward-compatible and are replaced in full.

Managed issue titles are generated by the output layer to stay concise in GitHub/Gitea list views. `aicr.publish_summary.title` only affects the rendered summary content in the issue body; it does not replace the managed issue title. Current title policy:

- `per_problem`: `marker_prefix + severity + shortened location + short first-sentence summary`
- `consolidated`:
  - Single problem: same format as `per_problem` (for example, `[AICR] [HIGH] src/app.ts:7 · Issue`)
  - Multiple problems: `marker_prefix + highest severity + problem count + representative summary` (for example, `[AICR] [CRITICAL] 3 problems · SQL query uses unsanitized input`)

Channel fields:

| Field | Meaning |
| --- | --- |
| `marker_prefix` | Title prefix used to identify managed issues; defaults to `[AICR]` |
| `marker_label` | Hidden body marker used to scope managed issues; defaults to `aicr-managed` |
| `label_ids` | Existing Gitea label IDs to attach to every created issue |
| `issue_mode` | `consolidated` (default) or `per_problem` |
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

Example (per-problem mode):

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

Example (consolidated mode — all problems in one issue):

```yaml
outputs:
  channels:
    - name: gitea-problem-issues
      kind: gitea_problem_issue
      trigger: gitea
      issue_mode: consolidated
      marker_prefix: "[AICR]"
      resolved_action: close
      severity_label_prefix: "aicr:problem:"
```

## Managed GitHub problem issues

The `github_problem_issue` channel works identically to `gitea_problem_issue` but targets the GitHub REST API. It reconciles managed GitHub issues based on problem fingerprints using string label names (not numeric IDs). On every summary publish it creates issues for new fingerprints and applies `resolved_action` to open managed issues whose fingerprints disappeared.

Like the Gitea variant, it supports `issue_mode: consolidated` to merge all problems from one review into a single issue.

As with Gitea, managed issue titles stay output-generated and concise; `aicr.publish_summary.title` is rendered inside the body summary section instead of replacing the GitHub issue title.

Key differences from `gitea_problem_issue`:

- **Labels**: GitHub uses string names directly (`labels: ["bug", "aicr:problem:high"]`); Gitea uses numeric IDs.
- **Resolved action**: GitHub does not support deleting issues; `resolved_action` can be `close` (default), `mark_resolved`, or `none`. The `delete` option is not available.
- **API headers**: `accept: application/vnd.github+json`, `x-github-api-version: 2022-11-28`, `authorization: Bearer <token>`.
- **Base URL**: Defaults to `https://api.github.com`; for GitHub Enterprise, set to `https://ghe.example.com/api/v3`.
- **Permissions**: the trigger or channel `token_env` must resolve to a token with repository Issues read/write access. GitHub webhook event checkboxes such as **Issues** or **Issue comments** only subscribe AICR to inbound events; they do not grant REST API permissions. For GitHub Apps, update repository permissions and reinstall/refresh the installation after changing them. For fine-grained PATs, grant at least Metadata read plus Issues read/write for the target repository; add Contents read if AICR should read `OWNERS`.
- **Failure handling**: a GitHub issue API 403/404/5xx is recorded as a failed dispatch result and logged with the channel name. In a routed multi-channel setup, later channels (for example Feishu/WeCom notifications) are still attempted. If every dispatch attempt fails, the review run ends as `skipped` with `skipReason: output_dispatch_failed` instead of failing trigger processing.

Channel fields:

| Field | Meaning |
| --- | --- |
| `marker_prefix` | Title prefix used to identify managed issues; defaults to `[AICR]` |
| `marker_label` | Hidden body marker used to scope managed issues; defaults to `aicr-managed` |
| `labels` | GitHub label names to attach to every created issue |
| `issue_mode` | `consolidated` (default), `per_problem`, or `per_commit` |
| `resolved_action` | `none`, `close`, or `mark_resolved`; defaults to `close` |
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

## GitHub and Gitea code references

GitHub and Gitea/Forgejo issue comments both support fenced Markdown code blocks, so AICR renders referenced code as portable Markdown rather than depending on one provider's proprietary review UI. For each problem whose `file:line` can be found in the parsed diff, AICR adds a small fenced code block with nearby context lines below the location in the problem body and, where templates list problems in a summary table, below the table as separate code reference sections.

GitHub also has first-class line anchors and rich selected-line references in its web UI. Gitea/Forgejo has file line anchors and standard Markdown fences, but not a GitHub Copilot-identical rich reference card API. The portable fenced-block rendering keeps GitHub, GitHub Enterprise, Gitea, and Forgejo behavior consistent.

Code reference snippets are bounded and safe by default:

- Source: parsed diff only; no extra repository read is performed for rendering.
- Size: at most 12 lines and 2000 characters per problem.
- Safety: snippets pass through the same output secret scrubber before dispatch.
- Fallback: if the line is outside the diff or unavailable, AICR keeps the normal location text/link and omits the code block.

## No-problems policy

The implemented `no_problems` policy controls whether a successful review with zero actionable problems should publish a summary to each output channel.

Effective policy is resolved in this order, from low to high precedence:

1. Built-in channel defaults.
2. Global `outputs.no_problems`.
3. Per-channel `outputs.channels[].no_problems`.
4. Workspace defaults: `workspaces.defaults.outputs.no_problems` and `workspaces.defaults.outputs.channel_overrides.<channel>.no_problems`.
5. Per-project overrides: `workspaces.instances.<workspace_id>.outputs.no_problems` and `workspaces.instances.<workspace_id>.outputs.channel_overrides.<channel>.no_problems`.

Use positive wording: `no_problems.action: publish|suppress`. Notification channels (IM bots, email) usually set `suppress`; lifecycle channels that need to close resolved managed issues may set `publish`. The removed `no_findings` spelling is rejected by config validation.

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

When an agent repair attempt only returns prose equivalent to “no actionable problems” or “no reviewable code”, AICR normalizes it to `skipReason="lgtm"` or `skipReason="no_reviewable_code"`. This keeps IM channels quiet even when their `no_problems` policy would publish a non-empty zero-problem summary.

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
| `{{vcs.sourcePath}}` | Provider-specific source namespace/path, such as a depot or repository subpath (when available) |
| `{{vcs.workspace}}` | Source-control client/workspace name captured from the submitter event (when available); for P4 this comes from trigger `%client%` / payload `client`, not from the analysis client configured for AICR |
| `{{vcs.repositoryPath}}` | Repository/depot reference path |
| `{{summaryTitle}}` | Optional short summary title supplied via `aicr.publish_summary.title` |
| `{{summary}}` | Summary Markdown |
| `{{problems}}` | Template problem list |
| `{{problem.file}}`, `{{problem.line}}`, `{{problem.location}}` | Location fields for one reported problem |
| `{{problem.severity}}`, `{{problem.category}}`, `{{problem.message}}`, `{{problem.suggestion}}` | Problem content fields |
| `{{problem.codeSnippet}}`, `{{problem.codeLanguage}}`, `{{{problem.codeFence}}}` | Optional AICR-derived code reference snippet, language, and pre-built fenced code block |

For Git-based channels (`gitea_*`, `github_*`, `gitlab_mr_review`), built-in templates prefer `@username` formatting when a provider username is available. If a display name is also available, they render it as `@username (Display Name)` so the platform can still resolve the mention while humans see the nickname. IM bot summary templates (`feishu_bot`, `wecom_bot`, and future IM channels) use the same human-readable `@username (Display Name)` convention for event authors; native bot mentions still flow through the separate `{{atMentions}}` / author-resolution path when enabled.

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
- Use `aicr.skip` when no actionable result should be dispatched, including empty/no-reviewable-code changes.
- Use `aicr.fetch_more_context` only for bounded, justified gaps.
- Do not treat stdout as the final review channel.

When changing the tool contract, update the prompt, this document, `docs/ai/architecture.md`, the relevant `Plan.md` roadmap summary, examples, and unit tests together.
