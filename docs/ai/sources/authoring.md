# Instruction and Skill Authoring Sources

Read only the record for the external contract being changed. Dates describe the
last evidence check, not guaranteed current behavior. Retained records were not
revalidated by the 2026-09-12 layout change unless explicitly marked below.

## AGENTS.md standard

- Sources:
  - <https://agents.md/>
  - <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- Evidence: Keep repository guidance concise and scoped. AGENTS-aware clients discover repository instructions; Codex layers directory guidance. Check the client-specific source before assuming another client has identical discovery.
- `last_checked`: 2026-09-12
- `next_review`: 2026-12-12
- `update_trigger`: Re-check when changing repository-wide instruction loading, adding nested instruction files, or adding support for a new AGENTS-aware client.

## Agent Skills open standard

- Sources:
  - <https://agentskills.io/>
  - <https://agentskills.io/specification>
  - <https://agentskills.io/skill-creation/quickstart>
  - <https://agentskills.io/skill-creation/best-practices>
  - <https://agentskills.io/skill-creation/optimizing-descriptions>
  - <https://agentskills.io/skill-creation/evaluating-skills>
  - <https://agentskills.io/skill-creation/using-scripts>
  - <https://agentskills.io/llms.txt>
  - <https://learn.chatgpt.com/docs/build-skills>
  - <https://code.claude.com/docs/en/skills>
- Evidence: Use matching skill directory/name and concrete descriptions. Metadata, body, and supporting references load progressively. Keep required name/description portable; state when each reference is needed and validate realistic tasks.
- `last_checked`: 2026-09-12
- `next_review`: 2026-12-12
- `update_trigger`: Re-check before changing `SKILL.md` frontmatter shape, skill directory layout, script expectations, or skill activation descriptions.

## Code review agent design (Augment, Claude Code, OpenAI Codex, Qodo)

- Sources:
  - <https://www.augmentcode.com/blog/how-we-built-high-quality-ai-code-review-agent>
  - <https://code.claude.com/docs/en/best-practices>
  - <https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts>
  - <https://www.anthropic.com/engineering/writing-tools-for-agents>
  - <https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/review/rubric.md>
  - <https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/settings/pr_reviewer_prompts.toml>
- Evidence: Prioritize concrete defects, small line ranges, targeted context and precise tool contracts. Verify applicable repository rules and cite their source when they support a finding. Empty findings are valid.
- `last_checked`: 2026-11-09
- `next_review`: 2027-02-09
- `update_trigger`: Re-check before changing the default review system prompt, `buildJsonToolContract()`, MCP tool descriptions, or the review eval fixtures.

## Karpathy-inspired coding-agent behavior

- Sources:
  - <https://x.com/karpathy/status/2015883857489522876>
  - <https://github.com/multica-ai/andrej-karpathy-skills>
  - <https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md>
  - <https://github.com/multica-ai/andrej-karpathy-skills/blob/main/README.zh.md>
- Evidence: Historical community evidence for explicit assumptions, minimal scope and verifiable outcomes. Repository requirements are canonical; this record adds no independent mandatory workflow.
- `last_checked`: 2026-05-28
- `next_review`: 2026-08-28
- `update_trigger`: Re-check when changing broad agent behavior guardrails, adding tool-specific behavioral bridges, or adopting a new external behavioral-guidance source.

## Context routing and current authoring checks

- Sources:
  - <https://agentskills.io/skill-creation/best-practices>
  - <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
  - <https://learn.chatgpt.com/docs/build-skills>
  - <https://code.claude.com/docs/en/memory>
- Evidence: Keep a small stable entrypoint, concrete skill descriptions and conditional references. Retain project-specific gotchas; omit generic tutorials. Claude imports support the thin @AGENTS.md bridge. Static byte reductions require separate behavioral validation before claiming model-quality gains.
- `last_checked`: 2026-09-12
- `next_review`: 2026-12-12
- `update_trigger`: Instruction loading, skill metadata, reference routing or prompt-authoring changes.

## Editorial guidance

- Local input: the user-supplied *AI 写作规范：准确、自然，保留作者声音*,
  with source checks dated 2026-10-06. Reviewed its short rules, heading and
  entry-label guidance, technical safeguards, visual examples and update method.
  The portable repository rules do not require access to the user's notebook.
- Sources checked on 2026-11-13:
  - [Google: Voice and tone](https://developers.google.com/style/tone), page
    updated 2026-05-27: direct, useful technical prose; repeated openings,
    fragmented sentences and unsupported ease claims need review.
  - [Microsoft: Headings](https://learn.microsoft.com/en-us/style-guide/scannable-content/headings):
    short, specific, parallel headings and responsive line breaks. Its general
    guide permits task-oriented verbs; this repository's noun-phrase heading
    rule is the user's stricter editorial preference.
  - [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing):
    reviewed caveats and current/historical indicators. This changing community
    advice is descriptive, not policy or an authorship test; individual words,
    punctuation and templates are not sufficient evidence of provenance.
  - [Sourati et al.: The shrinking landscape of linguistic diversity](https://pubmed.ncbi.nlm.nih.gov/42637911/),
    Nature Human Behaviour, 2026: read the indexed author abstract. Its findings
    motivate preserving author differences during editing; the paywalled
    methods were not reviewed and its effect sizes are not repository targets.
  - [Shan et al.: AI Writers Have a Consistent Stylometric Footprint, but AI Editors Do Not](https://arxiv.org/abs/2608.27855v2),
    version 2, 2026-09-22: read the abstract distinguishing generation from
    editing. No blanket detector threshold or cross-language word list follows.
    Publication status was not independently verified beyond this arXiv version.
  - [Morgenstern et al.: Contextuality and Contradictions](https://arxiv.org/abs/2611.08704v1),
    preprint, 2026-11-05: read the abstract about contextual and contradictory
    AI identifications among Wikipedia editors and students. This is recent
    exploratory evidence, not a universal technical-writing specification.
- Decision: use task-aware revision, semantic comparison and author-voice
  preservation in the shared writing guide. Treat wording patterns as review
  cues; retain the existing site style checks without changing their gates.
  Noun headings and content-shaped screenshot previews are explicit project
  choices, not experimentally established guarantees.
- Validation limits: local source, link, metadata, rendering and repository
  checks do not establish a model-quality improvement. No controlled multi-model
  writing comparison, reader blind evaluation or detector benchmark was run.
- `last_checked`: 2026-11-13
- `next_review`: 2027-02-13
- `update_trigger`: Repeated loss of meaning or author voice, new language or
  genre, changed official editorial guidance, or materially different research.
