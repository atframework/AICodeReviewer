---
name: output-channel-contracts
description: "Maintain channel policy, templates, target links, mentions, and managed-issue publication; skip agent configuration or VCS fetching."
user-invocable: false
---

# Output Channel Contracts

Trace changes through `packages/core/src/config.ts`, server bootstrap/orchestrator,
`packages/outputs/src/index.ts`, `template-engine.ts`, and relevant tests.
Read only the corresponding section of `docs/output-channels.md` or architecture
§3.9–3.10 when its design is needed.

## Shared invariants

- Resolve empty-result policy per channel: built-in → `outputs.no_problems` →
  channel → workspace defaults → instance. `review.skip_lgtm` is review guidance,
  not output routing. Errors and managed lifecycle checks have separate rules.
- Derive target context before rendering. Use PR/MR, commit, P4/SVN revision,
  scheduled/manual labels accurately; when no safe URL exists use a plain label.
  Validate allowed template variables and untrusted values.
- Ignore labels gate reception per event. Auto/reviewed tags belong to publishing,
  with global/workspace overrides and platform label resolution. Gitea managed
  issues include creation labels in `body.labels`.
- Test mixed-channel suppression/publication and relevant PR/non-PR templates.
  Sync affected config/examples, output docs, public locales and roadmap entries;
  run applicable final gates from the repository baseline.

## Conditional references

- PR buffering, update markers, duplicate collection, error summaries, or Markdown
  repair: [output pitfalls](../../../docs/ai/pitfalls/AGENTS.outputs.md).
- IM card/Markdown payloads, mentions, truncation, or structured repair:
  [IM contracts](references/im-bot-message-contracts.md).
- Managed issue scopes, `resolved_action`, file coverage, commit ancestry,
  diagnostic retention or resolution analysis:
  [managed issues](references/managed-problem-issues.md). Check `max_recent_issues`
  pagination, including a short Gitea page with a `Link: rel="next"` header.
- Automatic batch publication recovery:
  [scheduling](../../../docs/ai/pitfalls/AGENTS.scheduling.md). Check actual raw
  publisher calls; a completed checkpoint replays local accounting only.
