# Writing Guidance: De-AI Wording

Read before editing prose in docs, site pages, examples, prompts, or release
notes. Applies to both public locales and to AI-facing text. Verify facts
first; this file only covers wording.

## Current behavior only

- State what the code does now. What a behavior replaced, how older versions
  worked, and staged notes like "v1 supports X, v2 will add Y" belong to
  `CHANGELOG.md`, `docs/ai/milestones/`, or a migration guide.
- Delete superseded paragraphs instead of keeping them for context; git holds
  the history.
- Version identifiers that are contracts stay: API paths (`bot/v2/hook`),
  schema values (`legacy_v1`/`isolated_v2`, config document versions),
  dependency versions, console UI names (版本管理与发布).
- Unfinished capability goes to `Plan.md`; reference docs do not announce it.

## English wording

Banned on site pages, enforced by
`docs/site/scripts/validate-bilingual-consistency.mjs`: delve, leverage,
seamless, robust, streamline, unlock, elevate, empower, cutting-edge,
game-changer, realm, journey, crucial, vital, comprehensive, utilize,
facilitate, effortless(ly).

Banned in human review: tapestry, testament, pivotal, landscape (abstract),
navigate (figurative), underscore/highlight (verb), intricate, meticulous,
foster, garner, showcase, vibrant, bolster, align with, deep dive, valuable,
key (adjective), quietly (manner adverb), sentence-initial
Additionally/Moreover/Furthermore, overused ensure, patronizing simply.
Technical senses stay: gate a release, highlight a line, a robustness
property.

Sentence patterns:

- `not X but Y`, `not just X`: state the point directly.
- Forced triads: use as many items as the meaning has.
- False ranges: `from X to Y` only when both ends are real and the same kind.
- Rider clauses: cut trailing `highlighting` / `underscoring` / `ensuring`
  phrases that add no fact.
- Copula avoidance: prefer is/are/has over serves as, boasts, features.
- Synonym cycling: one thing, one name.
- Stacked hedges: keep one qualifier, and only with evidence.
- Vague attribution: name the source or cut the claim.
- Staged openers (`Let's dive in`, `Whether you're ...`, `In today's ...`)
  and one-line closers (`That is the real win.`): remove.
- Sales language (boasts, renowned, groundbreaking): state what the thing is.
- Dashes: prefer comma, colon, or period; keep a dash only for a real break.

Structure:

- No filler openings, section previews, or per-section summaries.
- Bold carries information (field names, UI labels); a decorative bold-label
  list is not a prose substitute.
- Sentence-case headings; no emoji or decorative arrows.

## 中文用词

机器强制（站点页面，脚本同上）：强大、高效、灵活、便捷、丰富、完善、智能、
优雅、无缝、轻松、极大地、显著、至关重要、赋能、助力、打造、抓手。

人工审：核心（作修饰语）、全方位、深层次、系统性（空用时）、彻底、完美、
极致、落地（隐喻义）、进行（冗余）、非常/十分/特别（冗余）、
首先/其次/再次/最后（机械排序）、综上（所述）、总而言之、总的来说、
值得注意的是、需要指出的是。

句式：

- “不是 A，而是 B”“不仅……还……”“既……又……” 改为直接陈述；指令性的
  “要 X，不要 Y” 保留。
- 删 “通过 X，你可以 Y”、“让/使……更加……”。
- 删每节总结、章节预告（“本节将……”、“如前所述”）和空洞开头。
- 不用形容词代替证据：写具体值、路径和行为。
- 避免英式中文：少用被动和长定语，按中文习惯用主动短句。
- 虚假范围：“从 X 到 Y” 仅在两端同类且真实覆盖时使用。

结构：

- 先说结论，一段一事。
- 列表和表格承载合同信息（字段、默认值、命令）；装饰性的
  “加粗标签：描述” 列表不作正文。
- 不为自然感引入口语梗、表情或营销比喻。

## Exceptions

- Quotes, error messages, and proper names keep their original wording.
- `CHANGELOG.md` and milestones describe change by nature; milestones keep
  their original prose, so verify facts there instead of restyling archives.
- A watched phrase inside a discussion of that phrase is exempt.

## Sources

Checked 2026-09-21:

- Wikipedia, "Signs of AI writing" (WikiProject AI Cleanup):
  <https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing>
- blader/humanizer SKILL.md, executable form of the pattern list:
  <https://github.com/blader/humanizer>
- Towards AI editing guide, structure before vocabulary:
  <https://www.louisbouchard.ai/ai-editing/>
- 科普中国《为什么AI写的文章，总有一股“AI味”？》:
  <https://news.sciencenet.cn/htmlnews/2025/10/553334.shtm>
- 36氪《消除“罪证”：给写作去除“AI味”的不完全手册（2026版）》:
  <https://www.36kr.com/p/3824601267196037>
