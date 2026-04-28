# AICodeReviewer Agent Guidelines

## Scope

- `AGENTS.md` is the only always-on instruction source for this repository.
- Keep repository-wide stable rules here. Put repeatable workflows in `.agents/skills/`.
- If `AGENTS.md` references AI-facing prompt or context files, those files must use the `AGENTS.` prefix and functional names.
- When updating AI-facing assets, read the existing `AGENTS.md`, referenced `AGENTS.*.md` files, and related skills first, then merge instead of appending near-duplicate content.
- Keep milestone detail in `docs/ai/milestones/*.md`; do not duplicate large milestone summaries into prompts or skills, and do not use milestone IDs in prompt or skill names.
- Do not maintain duplicate global prompt bodies in `.github/copilot-instructions.md`, `CLAUDE.md`, or tool-private prompt files.

## Guardrails

- Prefer minimal edits; do not weaken lint, typecheck, test, or markdown gates just to get a change through.
- When adding or removing a workspace package, update the package manifest, local `tsconfig.json`, and root `tsconfig.json` references together.
- Keep temporary repository artifacts such as scratch scripts, debug logs, and one-off reports under `build/`; do not leave them in the repository root.
- Use `.github/instructions/*.instructions.md` only for path-specific rules; keep workspace-wide rules in this file.
- Keep AI-facing assets concise: stable rules here, detailed shared context in `AGENTS.*.md`, and repeatable procedures in skills.

## Default verification order

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm markdownlint`
5. `pnpm build`

## Referenced prompt files

- `docs/ai/AGENTS.repository-baseline.md`

## Relevant skills

- `.agents/skills/repository-baseline-validation/SKILL.md`
- `.agents/skills/workspace-scaffold-maintenance/SKILL.md`
- `.agents/skills/agent-asset-sync/SKILL.md`
