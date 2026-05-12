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
- Author mention rendering and safe channel-specific formatting.

Do not use this skill for LLM prompt layering, agent runtime materialization, or VCS scoped-fetch implementation unless those changes directly affect output rendering.

## Procedure

1. **Read the authoritative surfaces**
   - `../../../Plan.md` §3.9 and §3.10.
   - `../../../docs/output-channels.md`.
   - `../../../packages/core/src/config.ts` and `../../../packages/core/test/config.test.ts` for schema coverage.
   - `../../../packages/server/src/bootstrap.ts` and `../../../packages/server/src/review-orchestrator.ts` for publisher routing and empty-summary behavior.
   - `../../../packages/outputs/src/template-engine.ts` and related tests for template variables.

2. **Preserve per-channel policy semantics**
   - Resolve `no_problems.action` in this order: built-in defaults → `outputs.no_problems` → `outputs.channels[].no_problems` → `workspaces.defaults.outputs.*` → `workspaces.instances.<id>.outputs.*`.
   - Use positive values (`publish` or `suppress`); avoid negative booleans such as `skip_no_problems`.
   - Apply the policy per output channel, not once for the whole composite publisher.
   - Do not suppress error reports, security alerts, or managed-problem lifecycle reconciliation under the normal no-problems policy.

3. **Render target links accurately**
   - Do not label every `event.url` as `View PR`.
   - Use a normalized target context for PR/MR, commit, push, P4 changelist, SVN revision, scheduled, and manual runs.
   - If a commit/revision URL cannot be safely derived, render a plain commit/revision label instead of an empty or misleading link.
   - For configurable URL templates, validate allowed variables and scrub untrusted data before rendering.

4. **Keep docs, examples, and tests aligned**
   - If config shape changes, update `Plan.md`, `docs/output-channels.md`, `example/config.yaml`, and config schema tests together.
   - Add template tests for PR/MR and non-PR targets whenever built-in templates change.
   - Add routing tests for mixed channels where one suppresses no-problems output and another publishes it.

## Label contracts

- `review.labels.ignore` causes the webhook handler to return `ignored_by_label` before scheduling a review. This is checked per-event, not per-channel.
- `review.labels.auto_tag` and `review.labels.reviewed_tag` are applied by PR/MR and issue dispatchers during `publishSummary` or `publishAggregatedProblems`. They are resolved/created via the platform Labels API and attached alongside any `severity_label_prefix` labels.
- `gitea_problem_issue` applies both tags at issue creation time via `body.labels`.
- All label fields support global → workspace-level override through `workspaces.defaults.review.labels` and `workspaces.instances.<id>.review.labels`.

## IM bot message contracts

- Feishu and WeCom `publishAggregatedProblems` include the full `problem.message` and `problem.suggestion` (when present) under each problem line.
- Long messages are truncated to 500 chars and suggestions to 300 chars with a `...` suffix to stay within platform card/message size limits.
- The truncation helper is internal; do not expose truncation length as user-configurable fields without updating tests and docs.

## Pitfalls

- Do not conflate `review.skip_lgtm` with output routing; the former guides review behavior, the latter decides dispatch per channel.
- Do not use a single composite `publishEmptySummary` boolean when different channels have different policies.
- Do not expose provider-specific URL assumptions in generic templates; derive target links before rendering.
- Do not publish empty Feishu/WeCom/email notifications unless the effective channel policy explicitly allows it.
