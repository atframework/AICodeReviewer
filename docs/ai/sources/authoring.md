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
  - <https://www.anthropic.com/engineering/writing-tools-for-agents>
  - <https://developers.openai.com/blog/custom-code-review-rules-for-codex>
  - <https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/pr_reviewer_prompts.toml>
- Evidence: Prioritize concrete defects and precise tool contracts; injected diffs and targeted context reduce unnecessary retrieval. Empty findings are valid. See the current repository prompt rationale rather than copying a vendor prompt.
- `last_checked`: 2026-08-08
- `next_review`: 2026-11-08
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
