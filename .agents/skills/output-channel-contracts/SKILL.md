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

## Detailed references

Load these sibling files only when the task touches the named surface:

- `references/im-bot-message-contracts.md`: IM bot Markdown/card rendering, mentions, truncation, and structured-output repair rules.
- `references/managed-problem-issues.md`: `gitea_problem_issue` / `github_problem_issue` lifecycle, issue modes, scope fingerprints, file-scope resolution guard, deduplication, and cleanup behavior.

## Pitfalls

- Do not conflate `review.skip_lgtm` with output routing; the former guides review behavior, the latter decides dispatch per channel.
- Do not use a single composite `publishEmptySummary` boolean when different channels have different policies.
- Do not expose provider-specific URL assumptions in generic templates; derive target links before rendering.
- Do not publish empty IM/email notifications unless the effective channel policy explicitly allows it.
- When switching between `per_problem` and `consolidated` modes, stale issues from the previous mode will be cleaned up during the next reconciliation cycle.
- Problems are deduplicated by fingerprint at every layer: `AicrOutputCollector.reportProblem` deduplicates by `fingerprint` or `sha256(file:line:category:message)[:16]` at collection time; `collectCompletionOutputs` in the orchestrator skips text re-parsing when MCP state or stream tool-call events already produced review output; `reconcileProblems` in `github_problem_issue` / `gitea_problem_issue` dispatchers calls `dedupProblemsByFingerprint` before building issue bodies; and the bootstrap `publishSummary` wrappers for those channels guard `reconcileProblems` with a per-publisher `reconciled` flag so it runs at most once per review.
