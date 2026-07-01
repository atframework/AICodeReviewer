---
name: output-channel-contracts
description: "Use when: changing or auditing output channel configuration, no-problems behavior, output templates, target links, author mentions, or dispatch contracts; do not use for agent runtime or VCS fetch internals."
user-invocable: false
---

# Output Channel Contracts

Use this skill when work touches how AICR decides whether, where, and how review results are rendered to PR/MR comments, issues, bots, or other notification channels.

## Scope

- Output channel config schema and merge behavior.
- `no_problems` / LGTM / empty-summary publishing policy.
- Built-in and workspace override templates.
- Review target labels and links for PR, MR, commit, P4 changelist, SVN revision, scheduled, and manual runs.
- PR/MR review summary update modes, managed comment markers, and channel-scope filtering.
- Author mention rendering and safe channel-specific formatting.

Do not use this skill for LLM prompt layering, agent runtime materialization, or VCS scoped-fetch implementation unless those changes directly affect output rendering.

## Procedure

1. **Read the authoritative surfaces**
   - `../../../docs/ai/architecture.md` §3.9 and §3.10.
   - `../../../Plan.md` when roadmap status or remaining milestone scope matters.
   - `../../../docs/output-channels.md`.
   - `../../../packages/core/src/config.ts` and `../../../packages/core/test/config.test.ts` for schema coverage.
   - `../../../packages/server/src/bootstrap.ts` and `../../../packages/server/src/review-orchestrator.ts` for publisher routing and empty-summary behavior.
   - `../../../packages/outputs/src/template-engine.ts` and related tests for template variables.

2. **Preserve per-channel policy semantics**
   - Resolve `no_problems.action` in this order: built-in defaults → `outputs.no_problems` → `outputs.channels[].no_problems` → `workspaces.defaults.outputs.*` → `workspaces.instances.<id>.outputs.*`.
   - Use positive values (`publish` or `suppress`); avoid negative booleans such as `skip_no_problems`.
   - Apply the policy per output channel, not once for the whole composite publisher.
   - Do not suppress error reports, security alerts, or managed-problem lifecycle reconciliation under the normal no-problems policy.
   - Managed problem issue lifecycle listing must honor `review.problem_issue.max_recent_issues` (default 20, global → workspace override, range 1..100) before closing or deleting stale issues.

3. **Render target links accurately**
   - Do not label every `event.url` as `View PR`.
   - Use a normalized target context for PR/MR, commit, push, P4 changelist, SVN revision, scheduled, and manual runs.
   - If a commit/revision URL cannot be safely derived, render a plain commit/revision label instead of an empty or misleading link.
   - For configurable URL templates, validate allowed variables and scrub untrusted data before rendering.

4. **Keep docs, examples, and tests aligned**
   - If config shape changes, update the relevant `Plan.md` roadmap summary, `../../../docs/ai/architecture.md`, `docs/output-channels.md`, `example/config.yaml`, and config schema tests together.
   - If PR/MR review summary update behavior changes, test `update_existing` marker parsing (`aicr:managed`, `aicr:scope`, `aicr:problems`), same-scope PATCH behavior, cross-scope non-overwrite behavior, and whitespace-tolerant fingerprint parsing.
   - If PR/MR review problem dispatching changes, test consolidated review buffering (`publishProblem` buffers, `publishSummary` flushes), one-body Markdown aggregation, line-comments-only route flushing, fallback to one issue comment on 403/422, and non-inline problem inclusion in the same body.
   - If resolved issue rendering changes, test the `<!-- aicr:problem-meta=BASE64_JSON -->` marker roundtrip, readable title rendering (`[SEVERITY] category — file:line`), legacy no-metadata fallback without raw fingerprints, and anchor ID generation for both open and resolved items.
   - Add template tests for PR/MR and non-PR targets whenever built-in templates change.
   - Add routing tests for mixed channels where one suppresses no-problems output and another publishes it.

## Label contracts

- `review.labels.ignore` causes the webhook handler to return `ignored_by_label` before scheduling a review. This is checked per-event, not per-channel.
- `review.labels.auto_tag` and `review.labels.reviewed_tag` are applied by PR/MR and issue dispatchers during `publishSummary` or `publishAggregatedProblems`. They are resolved/created via the platform Labels API and attached alongside any `severity_label_prefix` labels.
- `gitea_problem_issue` applies both tags at issue creation time via `body.labels`.
- All label fields support global → workspace-level override through `workspaces.defaults.review.labels` and `workspaces.instances.<id>.review.labels`.

## IM bot message contracts

All IM bot channels (`feishu_bot`, `wecom_bot`, and future channels such as `dingtalk_bot` or `slack_bot`) share a unified contract. Platform-specific differences (card vs markdown payload, mention dialect, signature algorithm) are absorbed by the dispatcher and `im-markdown.ts` transformer layers; the contracts below apply uniformly.

- `publishAggregatedProblems` must include the full `problem.message` and `problem.suggestion` (when present) under each problem line.
- IM reports stay sectioned as **Review target → Summary → Problems**; problem locations must come from structured `aicr.report_problem` data, not prose-only summaries.
- Agent CLI free-form stdout is not a publishable final report; repair to structured JSON/XML tool calls before summary-channel dispatch.
- If the repair result is still prose but explicitly says there are no actionable problems or no reviewable code, normalize it to `aicr.skip` (`lgtm` / `no_reviewable_code`) instead of publishing the generic format-repair fallback to IM.
- Summary text that says issues were found is not a problem record. If `problemCount` is zero, repair or suppress the summary instead of letting `no_problems` policy hide actionable prose without locations. Do the same when skip/summary prose asks a human to provide diff/source context or attribution context; agents must request concrete files via `aicr.fetch_more_context` or verified line attribution via `aicr.try_blame`.
- Built-in IM summaries must include the event username when present, rendering `@username (Display Name)` when both normalized username and display name are available. Platform-native mention tags (`<at>`, `<@user>`, etc.) are handled by the author-resolution layer via `MentionChannelKind`; templates render only the human-readable form.
- `vcs.workspace` is submitter metadata captured from the event payload; do not substitute analysis/client workspaces from adapter configuration into user-visible IM output.
- Long messages are truncated to 500 chars and suggestions to 300 chars with a `...` suffix to stay within platform card/message size limits.
- The truncation helper is internal; do not expose truncation length as user-configurable fields without updating tests and docs.
- Each IM platform uses a dedicated `toXxxMarkdown()` transformer in `packages/outputs/src/im-markdown.ts` to adapt generic Markdown to the platform's supported subset (e.g., Feishu cards flatten headings/tables, WeCom preserves headings, DingTalk converts tables to lists). When adding a new IM channel, implement a matching transformer before wiring the dispatcher.

## Managed problem issue lifecycle

- `gitea_problem_issue` and `github_problem_issue` channels support `issue_mode` to control creation strategy:
  - `consolidated` (default): all problems from one review run are merged into a single issue, scope-fingerprint-based reconciliation. The scope fingerprint is derived from `channel + owner + repo`.
  - `per_problem`: one issue per problem, fingerprint-based reconciliation.
- In consolidated mode:
  - Title stays concise: single problem uses `per_problem` format; multiple problems append a representative summary from the highest-severity issue (e.g., `[AICR] [CRITICAL] 3 problems · SQL query uses unsanitized input`).
  - Body groups problems by severity (critical → info).
  - Labels use highest severity. Assignees are aggregated across all problems.
  - On re-analysis: existing consolidated issue is updated (PATCH). If no problems: closed/deleted per `resolved_action`.
  - Per-fingerprint resolution tracking: body includes `<!-- aicr:commit={headSha} -->`, `<!-- aicr:open_problems=... -->`, and per-problem `<!-- aicr:fp={fp} -->` markers. On update, the VCS compare API verifies commit ordering; resolved problems are shown in a collapsible "Resolved" section. Same-commit updates merge without resolving; older-commit updates are skipped; compare API failures degrade gracefully to a full replacement.
- **File-scope resolution guard**: a managed problem is only marked "resolved" (and its issue closed) when the current review actually re-analyzed the file containing that problem. `reconcileProblems` receives `reviewedFiles` (the current review's `changedPaths`) via `ReviewSummaryPublishOptions.reviewedFiles` → `bootstrap.ts` `publishSummary` → 3rd argument. Per-problem issue bodies embed `<!-- aicr:file=<path> -->` (legacy bodies fall back to parsing `Location: \`path:line\``). When `reviewedFiles` is provided and the file is NOT in scope (or cannot be determined), the problem stays open. Consolidated partial-scope updates must retain out-of-scope fingerprints in `open_problems` and the body; if the old body cannot map a retained fingerprint to a file, skip the rewrite instead of dropping it. When `reviewedFiles` is absent/empty, the original behavior is preserved.
- `aicr.publish_summary.title` affects the rendered summary section in the issue body, not the managed issue title itself.
- `gitea_problem_issue` applies auto_tag and reviewed_tag at issue creation time via `body.labels`.

## Pitfalls

- Do not conflate `review.skip_lgtm` with output routing; the former guides review behavior, the latter decides dispatch per channel.
- Do not use a single composite `publishEmptySummary` boolean when different channels have different policies.
- Do not expose provider-specific URL assumptions in generic templates; derive target links before rendering.
- Do not publish empty IM/email notifications unless the effective channel policy explicitly allows it.
- When switching between `per_problem` and `consolidated` modes, stale issues from the previous mode will be cleaned up during the next reconciliation cycle.
