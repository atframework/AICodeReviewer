---
name: docs-writing-style
description: "Verify facts and edit clear bilingual repository Markdown, including concise milestone records; skip code comments and commit messages."
---

# Docs Writing Style

## Fact verification

1. List the fields, defaults, commands, paths and behavior claims being changed.
2. Check schema (`packages/core/src/config.ts`), wiring (server bootstrap), then
   the consuming module/tests. Examples are supporting evidence, not substitutes
   for code. Mark schema-only or unwired features explicitly.
3. Edit only affected prose/specifications. Keep frontmatter, code blocks, and useful
   table structure. Sync both public locales in the same change; identifiers,
   defaults, paths and commands must match.
   For Chinese technical prose, follow the terminology choices in the writing
   guidance: specification, interface convention, rule, protocol, or acceptance
   criterion according to the behavior being described.
   For terminology-only localization, inspect the parallel locale and leave its
   wording intact when it already conveys the same behavior.
4. Compare the revision with the original for negation, conditions, quantities,
   technical identifiers, author judgment and validation status. Apply the
   linked guidance to headings, entry labels and screenshots as well as prose;
   inspect affected nearby text rather than rewriting the whole document.
5. Run the repository Markdown gate. For site edits run its applicable checks
   from [the baseline](../../../docs/ai/AGENTS.repository-baseline.md).

## Wording

Apply [writing guidance](../ai-agent-maintenance/references/writing-guidance.md):
current behavior, noun-phrase headings, semantic preservation, author voice,
contextual wording review and visual examples. Keep one owner for these rules;
do not copy the full guide into runtime prompts or client bridges.

The existing project-style subset is enforced by
`docs/site/scripts/validate-bilingual-consistency.mjs`; context-dependent wording
still needs review. Milestones briefly state the problem and solution; preserve
material validation failures, skips, and scope limits. Remove reviewed-project
details and operation logs, and link stable specifications instead of copying them.
