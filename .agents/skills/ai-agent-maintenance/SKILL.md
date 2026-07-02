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
- Keep `Plan.md` forward-looking; move durable detail into `docs/ai/index.md`-linked docs instead of re-expanding always-on assets.
- Maintain `../../../docs/ai/source-index.md` when external AI-tool compatibility claims, Agent Skills conventions, or MCP guidance change; include `last_checked`, `next_review`, and `update_trigger` instead of unsupported guesses.
- Preserve compatibility across AGENTS-aware tools, VS Code Copilot, Copilot CLI, Codex, Claude Code, Kilo Code/CLI, Zoo Code, opencode, and similar agents when the repository intentionally supports them.
- Keep AI-facing guidance aligned with user-facing docs and examples; if a change affects agent config materialization, MCP tools, output templates, or deployment behavior, sync the relevant `Plan.md` roadmap summary, the relevant `docs/` module, `example/config.yaml`, and `example/README.md` or note why they are unchanged.
- For non-trivial prompt or skill edits, apply `../agent-behavior-guardrails/SKILL.md`: surface assumptions, choose the simplest sufficient change, keep diffs surgical, and define validation before editing.
- When prompts or skills recommend shell tools, tie the recommendation to the
  guaranteed runtime baseline. Prefer `rg` / `fd` / `bat` / `jq` / `yq` and
  local `helm` / `kubectl` checks only when the deployment image or sandbox
  image ships them, and keep `grep` / `find` / `cat` as explicit portability
  fallbacks.
- When a change affects agent runtime setup, verify LLM config translation, MCP tool mapping, three-layer prompt/instruction layering (system built-in → user common → project/repo-local), and skill materialization together; use `../agent-runtime-integration/SKILL.md` for the detailed workflow.
- Merge improvements into existing prompt and skill content; do not leave old versions, migration notes, changelog notes, or historical comparison sections.
- If an agent task succeeds only after retrying or switching approach, preserve the reusable cause and fix in the right AI-facing asset so future agents avoid the same failure path.

## Compatibility Model

- Prefer `AGENTS.md` as the canonical repository guide; nested `AGENTS.md` files should be specific to the subtree they govern.
- Keep `CLAUDE.md` as a thin Claude Code bridge that imports `AGENTS.md` and points to the skills listed there.
- Keep repeatable workflows in `.agents/skills/<name>/SKILL.md`; bridge files should not duplicate full skill bodies.
- Add `.github/copilot-instructions.md`, Zoo Code `.roo`, `.kilo`, `.kilocode`, or `opencode.json` rules only when the repository already uses them or the task explicitly asks for tool-specific config.
- Tool-private files may bridge to `AGENTS.md` or add narrowly scoped deltas, but must not copy the canonical prompt body.

## Procedure

1. **Research first**
   - Read the nearest `AGENTS.md`, referenced `AGENTS.*.md` files, `../../../docs/ai/index.md` when doc routing matters, present bridge files such as `CLAUDE.md`, and relevant `SKILL.md` files before editing.
   - Read `../../../docs/ai/source-index.md` before adding or changing compatibility claims; refresh only the affected source records when external behavior changed.
   - Check current official or maintained community references for prompt/agent/skill authoring before planning any AI-facing edit; prioritize concise instructions, progressive disclosure, discoverable descriptions, and real-use validation.
   - If compatibility behavior may change, check current official docs or maintained references for the affected tools.
   - Respect dirty workspaces: preserve unrelated user or formatter edits and avoid broad reformatting.

2. **Choose the right surface**
   - Put facts that apply to nearly every task in `AGENTS.md`.
   - Keep `Plan.md` for active roadmap summaries only.
   - Put stable detailed architecture in `docs/ai/architecture.md`, stable decisions in `docs/ai/decisions.md`, and completed-stage history in `docs/ai/milestones/*.md`.
   - Put path-specific or tool-specific rules in their native file only when that scope is needed.
   - Put multi-step, task-specific, or rarely used guidance in skills.
   - Put cross-tool source freshness, URLs, and review triggers in `../../../docs/ai/source-index.md`; keep `.agents/skills/README.md` as a compact directory map rather than a second skill body.
   - For retry-derived lessons, record only durable patterns: the trigger, root cause, and preferred fix. Skip one-off environment glitches, stale data, and facts that are obvious from nearby code.
   - Prefer links or references to existing docs or skills over copying long material into always-on prompts.
   - For agent CLI runtime changes, keep the repository source of truth in `.agents/skills/` and generate adapter-native copies or shims at materialization time; do not commit duplicate Kilo/Zoo/OpenCode/Claude skill bodies.

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
   - When the edit records a retry-derived lesson, summarize the original error cause and the chosen fix without keeping a chronological incident log in the prompt asset.
   - Call out skipped build/test work when only documentation changed.
