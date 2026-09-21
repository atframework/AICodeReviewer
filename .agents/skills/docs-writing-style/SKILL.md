---
name: docs-writing-style
description: "Verify facts and edit clear bilingual repository Markdown; skip code comments, commit messages, and historical milestone prose."
---

# Docs Writing Style

## Verify before writing

1. List the fields, defaults, commands, paths and behavior claims being changed.
2. Check schema (`packages/core/src/config.ts`), wiring (server bootstrap), then
   the consuming module/tests. Examples are supporting evidence, not substitutes
   for code. Mark schema-only or unwired features explicitly.
3. Edit only affected prose/contracts. Keep frontmatter, code blocks, and useful
   table structure. Sync both public locales in the same change; identifiers,
   defaults, paths and commands must match.
4. Run the repository Markdown gate. For site edits run its applicable checks
   from [the baseline](../../../docs/ai/AGENTS.repository-baseline.md).

## Wording

Apply [writing guidance](../ai-agent-maintenance/references/writing-guidance.md):
current-version-only statements, the banned word lists for both locales,
sentence patterns, structure rules, and the exceptions for technical
contracts and change records.

The unambiguous subset is enforced by
`docs/site/scripts/validate-bilingual-consistency.mjs`; context-dependent wording
still needs review. Historical milestones retain their original prose; verify
current claims instead of restyling archives.
