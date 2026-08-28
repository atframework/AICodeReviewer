---
name: docs-writing-style
description: "Use when: writing, revising, or reviewing repository Markdown documentation (docs/, docs/site/, README, example/) so the text matches code truth and reads like an engineer wrote it; do not use for code comments, commit messages, or docs/ai/milestones historical archives."
---

# Docs Writing Style

Target: documentation a reader understands at one glance, written like the
engineer who built the feature, with every claim verified against the code.

Rules below come from a 2026-08 survey of Chinese tech-community de-AI writing
practices and English AI-tell checklists, condensed for this repository.

## 1. Facts before prose

- Verify every field name, default value, command, path, and behavior claim
  against the code before writing. Never copy a claim from one doc to another
  without re-checking.
- Truth sources, in order:
  1. `packages/core/src/config.ts` (Zod schema and defaults)
  2. `packages/server/src/bootstrap.ts` (what is actually wired)
  3. The consuming module (orchestrator, queue-factory, adapters, outputs)
  4. `example/config.yaml` and `example/README.md` (user-facing examples)
- If the schema accepts a field but nothing consumes it, say so explicitly
  (examples: `queue.dead_letter`, workspace-level `agent.default`/`sandbox`).
  Do not document aspirational behavior as working behavior.
- Keep both locales in sync in the same edit: field names, commands, paths,
  and defaults must be identical between `en/` and `zh-cn/` pages.

## 2. Voice

- 先说结论，再给细节；一段只说一件事，主谓宾清楚。
- 给具体的值、路径、命令、默认值，不用形容词替代信息。
- 句子长短错落，允许短句；「默认是」「注意」「如果不…就…」这类写法可以用。
- 列表项不必字数对齐、结构对称。
- 修订时保留 frontmatter、代码块、表格结构，只改行文。
- 不要为了自然感引入口语梗、emoji 或主观感受——这是项目文档，不是博客。

## 3. 中文禁忌清单

句式：

- 「不是 A，而是 B」→ 直接说 B 是什么。指令性对比（「要 X，不要 Y」）不在此列。
- 「不仅……还……」「既……又……」排比 → 拆成两句或直接列举。
- 「通过 X，你可以 / 能够 Y」→ 「X 会 Y」或祈使句。
- 「让 …… 变得更加 ……」→ 删。
- 「首先 / 其次 / 再次 / 最后」机械过渡 → 直接分点或顺着写。
- 「总之 / 综上所述 / 由此可见」收尾段、「本节将介绍」预告句 → 整段删。

词汇（出现即替换或删除）：

- 强大、高效、灵活、便捷、丰富、完善、智能、优雅、无缝、轻松、极大（地）、
  显著、至关重要、核心、赋能、助力、打造、落地、抓手。
- 「非常 / 十分 / 特别」堆叠 → 删掉程度副词通常不影响意思。
- 「进行」滥用（进行配置、进行分析）→ 直接动宾（配置、分析）。

结构：

- 每节末尾的总结段 → 删。
- 空洞开头段（「随着……的发展」「本文档将带你……」）→ 删。
- 比喻、拟人、营销腔（「就像一位不知疲倦的审查员」）→ 删。
- 每段都加粗关键词 → 只保留真正需要强调的。
- 三连排比（「快速、可靠、安全」）→ 改成具体内容。

## 4. English banned list

Words to delete or replace:

- delve, leverage, seamless(ly), robust, streamline, unlock, elevate, empower,
  cutting-edge, game-changer, landscape, realm, journey, navigate
  (metaphorical), crucial, vital, essential (as filler), comprehensive, ensure
  (overuse), utilize, facilitate, effortlessly, simply (patronizing).
- moreover, furthermore, additionally as paragraph starters.

Constructions to avoid:

- "It's not X, it's Y" / "not just X, but Y".
- "Whether you're a X or a Y, ...".
- "In today's fast-paced world" / "In the ever-evolving ...".
- Rule-of-three adjective stacks ("fast, reliable, and secure").
- "Let's dive in" / "Let's explore".
- Summary paragraph at the end of every section ("In summary", "By following
  these steps").
- Bold on every key term.

Prefer imperative instructions and concrete defaults, paths, and commands over
adjectives; mix short sentences with occasional longer ones.

A machine-checkable subset of the §3/§4 word bans is enforced by
`docs/site/scripts/validate-bilingual-consistency.mjs` on every
`pnpm docs:build`; the unambiguous words fail the build, context-dependent
bans stay human-reviewed. This skill remains the rationale source and the
full contract.

## 5. Revision workflow

1. List the claims the page makes: fields, defaults, behaviors, commands.
2. Check each claim against the truth sources in section 1; fix the mismatch
   or annotate the feature as unimplemented/schema-only.
3. Apply sections 2-4 surgically: change wording, not structure; keep the
   diff reviewable.
4. Sync both locales in the same edit.
5. Run `node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs`.
   For `docs/site/` changes also run `pnpm docs:check` and `pnpm docs:build`.

## 6. Out of scope

- `docs/ai/milestones/*.md` and research archives such as
  `docs/prompt-research.md` are historical records; do not rewrite them for
  style.
- Code comments, commit messages, and chat replies.
