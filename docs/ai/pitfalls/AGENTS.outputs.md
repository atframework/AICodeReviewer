# Output and Markdown Contracts

Read for publication, templates, Markdown repair, or lifecycle changes. Follow
only the matching references in the
[output skill](../../../.agents/skills/output-channel-contracts/SKILL.md).

Sources: `packages/outputs/src/index.ts`, `template-engine.ts`, `im-markdown.ts`,
`packages/core/src/markdown-fixer.ts`, server bootstrap/orchestrator, and tests.

- Apply `no_problems` per channel with workspace overrides. Errors bypass normal
  empty-result suppression. `dryRun: false` must not become `dry_run` just because
  no publisher exists; bootstrap must not force dry-run when outputs are configured.
- PR dispatch buffers `publishProblem`, then flushes once in `publishSummary`.
  Keep line-comments-only flushing and summary-only `allProblems` fallback.
  Multiple summaries cannot republish the same buffered set. Configured review
  mode/event must flow through bootstrap; preserve review API → issue-comment
  fallback for supported 403/422 cases.
- Managed PR updates use issue-comment list/PATCH/POST APIs with managed/scope/
  fingerprint markers. Regenerate current fingerprints, preserve resolved IDs,
  and round-trip diagnostic metadata (`aicr:problem-meta`) with line ranges.
  Render readable legacy labels, not raw hashes.
- Collector, orchestration, publisher input, and bootstrap once-per-review guards
  each prevent a different duplicate path. Keep all four; do not remove one on
  the assumption another layer handles it.
- Failure notices are not successful empty reviews: `skipReconcile: true` must
  bypass managed lifecycle updates without consuming the reconciled flag. Missing
  fingerprints need reviewed-file/ancestry guards and model confirmation, not
  automatic closure. Full rules: [managed issues](../../../.agents/skills/output-channel-contracts/references/managed-problem-issues.md).
- `renderMarkdownCodeFence(content, language?)` takes source first. Markdown list
  repair must preserve bold/bold-italic markers and thematic breaks; use horizontal
  whitespace rather than `\s` across lines. MD022 heading repair skips fenced code.
- Reused table regexes with `.test()` must not have the stateful `g` flag. IM
  dispatchers apply their platform transformer. Feishu JSON 2.0 preserves headings,
  tables, blockquotes and code: use `card.body.elements`, including appended mentions.
  Details: [IM contracts](../../../.agents/skills/output-channel-contracts/references/im-bot-message-contracts.md).
