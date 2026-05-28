# AICR Agent Skills Index

This directory is the repository's canonical Agent Skills surface. Agents should use this file as a compact map, then read only the specific `SKILL.md` file that matches the task.

## Usage rules

- Treat `.agents/skills/<name>/SKILL.md` as the source of truth for repeatable workflows.
- Keep `AGENTS.md` for stable always-on rules; keep detailed procedures in skills.
- Do not copy full skill bodies into `CLAUDE.md`, `.github/copilot-instructions.md`, `.roo/`, `.kilo/`, `opencode.json`, or other tool-private files.
- If a tool needs an adapter-native copy, generate or materialize it from this directory instead of committing a duplicate.
- Before changing skill metadata, verify the current Agent Skills conventions and update `docs/ai/source-index.md` when compatibility claims change.

## Skill index

| Skill | Use when | Do not use when |
| --- | --- | --- |
| `agent-behavior-guardrails` | Planning, coding, refactoring, reviewing, or editing prompts for non-trivial tasks where assumptions, scope control, simplicity, or verification matter. | Obvious one-line fixes. |
| `agent-runtime-integration` | Implementing or auditing agent CLI runtime materialization, LLM config translation, MCP tool mapping, prompt layering, or skill merging. | Ordinary review logic or output rendering changes. |
| `ai-agent-maintenance` | Auditing, creating, or optimizing AI agent prompts, bridge files, skills, `SKILL.md` metadata, or cross-tool compatibility. | Ordinary feature edits that leave AI-facing assets unchanged. |
| `output-channel-contracts` | Changing output channel config, no-problems behavior, templates, target links, author mentions, or dispatch contracts. | Agent runtime or VCS fetch internals. |
| `plan-implementation-audit` | Comparing roadmap/docs with implementation, finding gaps, fixing milestone issues, or adding missing tests. | Unrelated feature work. |
| `remote-deployment` | Deploying AICR to a remote server, syncing deployed source/config, or troubleshooting podman deployment. | Local development or CI-only changes. |
| `repository-baseline-validation` | Validating repository-wide build, lint, test, markdown, Docker, docs, CI, root tooling, or workspace topology changes. | Isolated package-only feature edits. |
| `workspace-scaffold-maintenance` | Adding, removing, or reshaping pnpm workspace packages, manifests, project references, or shared build wiring. | Package-local feature edits that leave the scaffold unchanged. |

## Maintenance checklist

- Folder name and frontmatter `name` must match.
- Frontmatter `description` should start with a clear trigger such as `Use when:` and include when not to use the skill.
- Keep each `SKILL.md` focused; move bulky references, scripts, templates, or examples into sibling files loaded on demand.
- Re-run markdown validation after changing any skill or this index.
