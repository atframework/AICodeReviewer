---
name: ai-agent-maintenance
description: "Use when: auditing, creating, or optimizing AI agent prompts, bridge files, skills, SKILL.md metadata, and cross-tool compatibility; do not use for ordinary feature edits that leave AI-facing assets unchanged."
user-invocable: false
---

# AI Agent Maintenance

Use this skill when updating AI-agent guidance, prompt assets, bridge files, or skills for this repository.

## Required Outcomes

- Research the current prompt and skill layout before editing.
- Keep always-on guidance compact, actionable, and non-redundant.
- Preserve compatibility across AGENTS-aware tools, VS Code Copilot, Copilot CLI, Codex, Claude Code, Kilo Code/CLI, Roo Code, opencode, and similar agents when the repository intentionally supports them.
- Keep AI-facing guidance aligned with user-facing docs and examples; if a change affects agent config materialization, MCP tools, output templates, or deployment behavior, sync `Plan.md`, the relevant `docs/` module, `example/config.yaml`, and `example/README.md` or note why they are unchanged.
- When a change affects agent runtime setup, verify LLM config translation, MCP tool mapping, three-layer prompt/instruction layering (system built-in → user common → project/repo-local), and skill materialization together; use `../agent-runtime-integration/SKILL.md` for the detailed workflow.
- Merge improvements into existing prompt and skill content; do not leave old versions, migration notes, changelog notes, or historical comparison sections.

## Compatibility Model

- Prefer `AGENTS.md` as the canonical repository guide; nested `AGENTS.md` files should be specific to the subtree they govern.
- Keep `CLAUDE.md` as a thin Claude Code bridge that imports `AGENTS.md` and points to the skills listed there.
- Keep repeatable workflows in `.agents/skills/<name>/SKILL.md`; bridge files should not duplicate full skill bodies.
- Add `.github/copilot-instructions.md`, `.roo`, `.kilo`, `.kilocode`, or `opencode.json` rules only when the repository already uses them or the task explicitly asks for tool-specific config.
- Tool-private files may bridge to `AGENTS.md` or add narrowly scoped deltas, but must not copy the canonical prompt body.

## Procedure

1. **Research first**
   - Read the nearest `AGENTS.md`, referenced `AGENTS.*.md` files, present bridge files such as `CLAUDE.md`, and relevant `SKILL.md` files before editing.
   - If compatibility behavior may change, check current official docs or maintained references for the affected tools.
   - Respect dirty workspaces: preserve unrelated user or formatter edits and avoid broad reformatting.

2. **Choose the right surface**
   - Put facts that apply to nearly every task in `AGENTS.md`.
   - Put path-specific or tool-specific rules in their native file only when that scope is needed.
   - Put multi-step, task-specific, or rarely used guidance in skills.
   - Prefer links or references to existing docs or skills over copying long material into always-on prompts.
   - For agent CLI runtime changes, keep the repository source of truth in `.agents/skills/` and generate adapter-native copies or shims at materialization time; do not commit duplicate Kilo/Roo/OpenCode/Claude skill bodies.

3. **Write compact, discoverable skills**
   - Keep skill folder names and frontmatter `name` values identical; use lowercase hyphenated names.
   - Quote descriptions that contain colons and start them with `Use when:` plus concrete trigger words.
   - Front-load the most important trigger phrases because some tools truncate skill descriptions in listings.
   - Keep each `SKILL.md` focused. Move bulky examples, scripts, or reference material into sibling files when needed.
   - Ensure the Markdown body remains useful even if a client ignores nonstandard frontmatter.

4. **Validate before finishing**
   - Check markdown and frontmatter diagnostics for changed prompt and skill files.
   - Run a scoped whitespace/status check for changed prompt and skill files when practical.
   - Re-read representative files to ensure bridge files stay thin and skill routing points to the current skill.
   - For nested Git repositories, run status and whitespace checks from each affected repository root.

5. **Summarize clearly**
   - Report the files changed, compatibility surfaces preserved, and validations run.
   - Call out skipped build/test work when only documentation changed.
