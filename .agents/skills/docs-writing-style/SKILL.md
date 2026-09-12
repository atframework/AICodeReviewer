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

## 中文

- 先说结论，一段一事；用具体值、路径和动词，保留必要的限制条件。
- 删除空洞开头、章节预告、每节总结、机械的“首先/其次/最后”、营销比喻、
  表情和没有信息的加粗。不要为了自然感引入口语梗。
- 将“不是 A，而是 B”“不仅……还……”“既……又……”改为直接陈述；
  指令性的“要 X，不要 Y”可以保留。
- 删除“通过 X，你可以”“让……变得更加”及多余的“进行/非常/十分/特别”。
- 不用形容词代替证据：强大、高效、灵活、便捷、丰富、完善、智能、优雅、
  无缝、轻松、极大、显著、至关重要、核心、赋能、助力、打造、落地、抓手。

## English

- Use active prose or imperatives, concrete defaults and limitations. Vary sentence
  length; avoid filler introductions, closing recaps, and adjective stacks.
- Remove metaphorical or promotional language: delve, leverage, seamless, robust,
  streamline, unlock, elevate, empower, cutting-edge, game-changer, landscape,
  realm, journey, navigate; filler crucial/vital/essential; overused ensure;
  utilize, facilitate, effortlessly, patronizing simply.
- Avoid “not X, but Y”, “not just X”, “Whether you're…”, “In today's…”,
  “Let's dive in/explore”, and paragraph-opening moreover/furthermore/additionally.

The unambiguous subset is enforced by
`docs/site/scripts/validate-bilingual-consistency.mjs`; context-dependent wording
still needs review. Historical milestones retain their original prose; verify
current claims instead of restyling archives.
