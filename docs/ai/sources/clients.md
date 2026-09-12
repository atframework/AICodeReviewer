# Client Instruction and Skill Sources

Read only the record for the external contract being changed. Dates describe the
last evidence check, not guaranteed current behavior. Retained records were not
revalidated by the 2026-09-12 layout change unless explicitly marked below.

## VS Code Copilot customization

- Sources:
  - <https://code.visualstudio.com/docs/copilot/customization/custom-instructions>
  - <https://code.visualstudio.com/docs/copilot/customization/agent-skills>
  - <https://code.visualstudio.com/docs/copilot/customization/custom-agents>
  - <https://code.visualstudio.com/docs/copilot/customization/prompt-files>
- Evidence: VS Code distinguishes repository/path instructions, prompt files, custom agents and skills. Add a native surface only for a concrete need; concise, non-obvious instructions belong at the narrowest applicable scope.
- `last_checked`: 2026-05-18
- `next_review`: 2026-07-18
- `update_trigger`: Re-check when adding `.github/instructions/*.instructions.md`, `.prompt.md`, `.agent.md`, or VS Code-specific skill placement.

## Claude Code

- Sources:
  - <https://code.claude.com/docs/en/skills>
  - <https://code.claude.com/docs/en/memory>
  - <https://code.claude.com/docs/en/cli-reference>
  - <https://code.claude.com/docs/en/env-vars>
  - <https://code.claude.com/llms.txt>
  - <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
- Evidence: Claude uses CLAUDE.md imports and on-demand skills. For headless/config changes verify current print mode, JSON output, MCP isolation, web-tool permissions and documented environment names; do not infer names from API conventions.
- `last_checked`: 2026-08-27
- `next_review`: 2026-11-08
- `update_trigger`: Re-check when changing `CLAUDE.md`, adding `.claude/` assets, changing the claude-code adapter command line or env translation, or relying on Claude-specific frontmatter or plugin behavior.

## Windsurf

- Sources:
  - <https://docs.windsurf.com/windsurf/cascade/agents-md>
  - <https://docs.windsurf.com/windsurf/cascade/memories>
  - <https://docs.windsurf.com/windsurf/cascade/skills>
  - <https://docs.windsurf.com/llms.txt>
- Evidence: Windsurf distinguishes AGENTS, rules/memories and skills. Recheck its native scope/discovery before adding a client-specific file.
- `last_checked`: 2026-05-18
- `next_review`: 2026-07-18
- `update_trigger`: Re-check when adding Windsurf-specific rules, memories, workflows, or skill path assumptions.

## OpenClaw and ClawHub

- Sources:
  - <https://docs.openclaw.ai/llms.txt>
  - <https://docs.openclaw.ai/concepts/agent-workspace.md>
  - <https://docs.openclaw.ai/gateway/config-agents.md>
  - <https://docs.openclaw.ai/tools/skills>
  - <https://docs.openclaw.ai/plugins/skill-workshop.md>
  - <https://docs.openclaw.ai/clawhub/index.md>
  - <https://docs.openclaw.ai/clawhub/skill-format.md>
  - <https://docs.openclaw.ai/clawhub/http-api.md>
  - <https://docs.openclaw.ai/clawhub/cli.md>
  - <https://docs.openclaw.ai/clawhub/acceptable-usage.md>
- Evidence: Optional compatibility evidence: OpenClaw skills/bootstrap and ClawHub registry trust/install metadata are separate surfaces. Recheck before using them; no repository integration is implied.
- `last_checked`: 2026-05-18
- `next_review`: 2026-06-18
- `update_trigger`: Re-check when relying on OpenClaw workspace bootstrap, skill precedence, ClawHub security metadata, skill publishing, or OpenClaw runtime compatibility.

## Hermes Agent

- Sources:
  - <https://github.com/NousResearch/hermes-agent>
  - <https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files>
  - <https://hermes-agent.nousresearch.com/docs/user-guide/features/skills>
  - <https://hermes-agent.nousresearch.com/docs/user-guide/features/curator>
  - <https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>
- Evidence: Optional compatibility evidence: Hermes separates context, skills, memory and MCP configuration. Recheck skill discovery and credential handling before adding integration.
- `last_checked`: 2026-05-18
- `next_review`: 2026-06-18
- `update_trigger`: Re-check when adding Hermes-specific context assumptions, external skill directory guidance, MCP integration, or auto skill-management behavior.

## Google Antigravity

- Sources:
  - <https://antigravity.google/docs/home>
  - <https://antigravity.google/docs/rules-workflows>
  - <https://antigravity.google/docs/skills>
  - <https://antigravity.google/docs/mcp>
  - <https://antigravity.google/docs/knowledge>
- Evidence: Optional compatibility evidence: Antigravity separates rules, workflows, skills, MCP and knowledge. User-local credentials/memory are not committed prompt assets; recheck native discovery before use.
- `last_checked`: 2026-05-18
- `next_review`: 2026-06-18
- `update_trigger`: Re-check when adding Antigravity rules/workflows/skills, MCP setup guidance, or knowledge-memory assumptions.
