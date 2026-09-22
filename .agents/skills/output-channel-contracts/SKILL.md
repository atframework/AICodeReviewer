---
name: output-channel-contracts
description: "Maintain channel policy, templates, target links, mentions, and managed-issue publication; skip agent configuration or VCS fetching."
user-invocable: false
---

# Output Channel Contracts

Trace changes through `packages/core/src/config.ts`, server bootstrap/orchestrator,
`packages/outputs/src/index.ts`, `template-engine.ts`, and relevant tests.
Read only the corresponding section of `docs/output-channels.md` or architecture
§3.9–3.10 and §3.16 (v2 routing/runtime generation) when its design is needed.

## Shared invariants

- Resolve empty-result policy per channel: built-in → `outputs.no_problems` →
  channel → workspace defaults → instance. `review.skip_lgtm` is review guidance,
  not output routing. Errors and managed lifecycle checks have separate rules.
- Resolve template sources in order: channel `templates.{problem,summary}` named
  reference into `outputs.templates` → workspace `templates/` directory lookup →
  built-in template. Named documents are markdown with optional frontmatter;
  only the body is rendered, and template text is never secret-sealed or redacted.
  Verify document create/update/restore and preview/audit paths, including names
  such as `token`/`example_env` and credential-shaped example text. Keep the
  exemption scoped to document bodies; real credential fields still seal/mask.
- Derive target context before rendering. Use PR/MR, commit, P4/SVN revision,
  scheduled/manual labels accurately; when no safe URL exists use a plain label.
  Validate allowed template variables and untrusted values.
- Ignore labels gate reception per event. Auto/reviewed tags belong to publishing,
  with global/workspace overrides and platform label resolution. Gitea managed
  issues include creation labels in `body.labels`.
- Test mixed-channel suppression/publication and relevant PR/non-PR templates.
  Sync affected config/examples, output docs, public locales and roadmap entries;
  run applicable final gates from the repository baseline.
- For routing changes, compare preview with actual publisher calls in old/new
  generations. v2 route rules match on `target_kinds`, `triggers`, and
  `source.repo_ref` (`routingRuleMatchSchema` in `config.ts`, compiled by
  `config-compiler.ts`). Each event resolves publishers through the
  generation-scoped `outputPublisherResolver` (option declared at
  `review-orchestrator.ts:176`, invoked per event at ~3590 with
  `{ sourceRoot }`), falling back to an explicit `outputPublisher` when set.
  In v2 an explicit empty list closes that output kind; disabling
  the last rule must retain v2 semantics (runtime-generation/runtime-http tests).

## Conditional references

- PR buffering, update markers, duplicate collection, error summaries, or Markdown
  repair: [output pitfalls](../../../docs/ai/pitfalls/AGENTS.outputs.md).
- IM card/Markdown payloads, mentions, truncation, or structured repair:
  [IM contracts](references/im-bot-message-contracts.md).
  Directory identity guessing also changes the dedicated server prompt and
  model-group selection; check static/database publication and old/new runs.
  For Feishu application authentication, directory permissions or API payloads,
  also check the [Feishu source record](../../../docs/ai/sources/feishu.md).
- Managed issue scopes, `resolved_action`, file coverage, commit ancestry,
  diagnostic retention or resolution analysis:
  [managed issues](references/managed-problem-issues.md). Check `max_recent_issues`
  pagination, including a short Gitea page with a `Link: rel="next"` header.
- Automatic batch publication recovery:
  [scheduling](../../../docs/ai/pitfalls/AGENTS.scheduling.md) and
  [remote API contracts](../../../docs/ai/sources/publication-reconciliation.md). Check actual raw
  publisher calls, multiple summaries, lease/persistence interruption and
  buffered versus delivered output. A completed checkpoint replays local
  accounting only; publication-only recovery retains the original model usage.
  Exercise lost remote responses and local receipts with fresh journal/store
  instances; an unknown result cannot authorize a new non-idempotent write.
