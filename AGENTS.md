# AICodeReviewer Agent Guidelines

## Scope

- `AGENTS.md` is the only always-on instruction source for this repository.
- Keep repository-wide stable rules here. Put repeatable workflows in `.agents/skills/`.
- Keep this file short, specific, and verifiable. If removing a line would not cause future agents to make mistakes, remove it.
- If `AGENTS.md` references AI-facing prompt or context files, those files must use the `AGENTS.` prefix and functional names.
- When updating AI-facing assets, read the existing `AGENTS.md`, referenced `AGENTS.*.md` files, and related skills first, then merge instead of appending near-duplicate content.
- Keep milestone detail in `docs/ai/milestones/*.md`; do not duplicate large milestone summaries into prompts or skills, and do not use milestone IDs in prompt or skill names.
- Treat `Plan.md` as the forward-looking roadmap only. When a task needs stable design details or completed-stage history, read `docs/ai/index.md` and follow its links on demand instead of expanding `Plan.md` again.
- Do not maintain duplicate global prompt bodies in `.github/copilot-instructions.md`, `CLAUDE.md`, Zoo Code `.roo/`, `.kilo/`, `opencode.json`, or other tool-private files. Tool-specific files may only bridge to `AGENTS.md` or add narrowly scoped behavior the shared file cannot express.

## Agent compatibility

- Treat `AGENTS.md` plus `.agents/skills/*/SKILL.md` as the canonical, tool-neutral layer for VS Code Copilot, Copilot CLI, Codex, Claude Code, Kilo Code, Zoo Code, Kilo CLI, opencode, and similar agents.
- Prefer one canonical rule over parallel copies. If a client needs a private format, make it a small pointer to the canonical source or a path-scoped delta.
- Use path-specific instructions only when a rule should not load for the whole repository. Keep Copilot `.github/instructions/*.instructions.md`, Claude `.claude/rules/`, Zoo Code `.roo/rules/`, Kilo rules, and opencode `instructions` entries aligned by intent if they are added later.
- Skills must follow the Agent Skills shape: directory name equals frontmatter `name`, `description` states what the skill does and when not to use it, and detailed references/scripts/assets load only on demand.
- Do not rely on one agent's proprietary frontmatter for correctness. Extra fields may improve a client, but the Markdown body must remain usable by agents that only understand `name` and `description`.

## Guardrails

- Prefer minimal edits; do not weaken lint, typecheck, test, or markdown gates just to get a change through.
- For non-trivial work, make assumptions, tradeoffs, and success criteria explicit before editing; ask when ambiguity changes the implementation.
- Keep solutions simple and surgical: no speculative features, broad refactors, or style churn outside the user-requested scope; clean up only code made unused by your changes.
- After the final edit, run every repository gate applicable to the changed files. Targeted checks are iteration evidence, not a substitute for the complete applicable gate; do not claim completion while a required check is unrun, failing, blocked, or did not actually discover the expected files/tests.
- When adding or removing a workspace package, update the package manifest, local `tsconfig.json`, and root `tsconfig.json` references together.
- When code changes affect config shape, agent adapters, MCP tool contracts, output rendering, deployment behavior, or public workflow, update the matching `Plan.md` roadmap summary, relevant `docs/` modules, `example/config.yaml`, and `example/README.md` entries in the same change, or explicitly state why no doc/example update is needed.
- **All temporary task artifacts must go under `build/`**: scratch scripts, debug logs, one-off reports, intermediate data, benchmark outputs, and any file produced during an agent session that is not a permanent part of the codebase must be written under `build/`. Never leave temporary files in the repository root, `eval/`, or any package directory. Use purposeful subdirectories: `build/tmp/` for ad-hoc data, `build/logs/` for captured output, and existing `build/deploy/` for deployment staging. Ensure the subdirectory exists before writing (`node -e "require('fs').mkdirSync('build/tmp',{recursive:true})"`). The `eval/` directory is reserved for permanent eval CLI test fixtures only; do not store task scratch files there.
- Use `.github/instructions/*.instructions.md` only for path-specific rules; keep workspace-wide rules in this file.
- Keep AI-facing assets concise: stable rules here, detailed shared context in `AGENTS.*.md`, and repeatable procedures in skills.
- When an agent hits an error but succeeds by retrying or changing approach, capture the generalizable cause and fix in the most appropriate existing `AGENTS.md` or skill file after researching current prompt/skill best practices; merge the lesson concisely instead of adding incident logs or duplicates.

## Environment notes

- **Windows PowerShell execution policy**: `pnpm`, `npx`, and other `.ps1` scripts are blocked by default. Run Node-based CLI tools directly via `node`:
  - Tests: `node node_modules/vitest/vitest.mjs run --coverage`
  - Lint: `node node_modules/eslint/bin/eslint.js . --max-warnings=0`
  - Typecheck: `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false`
  - Markdownlint: `node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs`
  - Build: Use `cmd /c "pnpm build"` or invoke the package build scripts directly.
  - Eval fixture validation after build: `node packages/cli/dist/index.js eval --validate-only`
- PowerShell treats backticks as escapes/line continuations; avoid inline `node -e` snippets that contain JavaScript template literals or complex quote nesting. Prefer native PowerShell, a short script under `build/tmp/`, or quote-free Node snippets.
- If `pnpm` is available in the environment (e.g., CI Linux runner), prefer `pnpm` over the `node` workaround; for eval fixture validation use `pnpm eval:validate` after `pnpm build`.
- **Linux review/runtime shell baseline**: The deployed review image ships
  `git`, `git-lfs`, `subversion`, `p4`, `rg`, `fd`, `bat`, `jq`, `tree`,
  `yq`, `kubectl`, `helm`, `podman`, `buildah`, `skopeo`, `python3`/`pip`/`venv`,
  `build-essential`, `cmake`, `ninja`, `clang`, `clang-format`, `clang-tidy`,
  `cppcheck`, `gdb`, `valgrind`, `shellcheck`, `strace`, `lsof`, `sqlite3`,
  `rsync`, and `universal-ctags`. Prefer `rg` over `grep`, `fd` over recursive
  `find`, `bat --paging=never --style=plain` over raw `cat` for human
  inspection, `jq` for JSON, and `yq` for YAML. Use POSIX fallbacks only when
  exact flags or host portability are required.

## Known codebase pitfalls

The full fixed-issue checklist lives in `docs/ai/AGENTS.known-pitfalls.md` and is loaded on demand instead of every agent turn.

Read it before non-trivial coding, review, roadmap/implementation audits, or AI-facing asset maintenance. It is especially relevant for:

- config/store schemas and migrations;
- prompt manager, agent runtime bundle, adapter, MCP, and VCS context contracts;
- output channels, managed problem issues, IM rendering, no-problems routing, and problem lifecycle reconciliation;
- deployment/Docker/Podman/runtime-image behavior;
- docs-site workspace boundaries, markdown tooling, and repository baseline changes.

If a new recurring issue is found and fixed, add a concise entry to `docs/ai/AGENTS.known-pitfalls.md` rather than expanding this root prompt again.

## Default verification order

For code, config, script, CI, or shared-tooling changes, `pnpm ci` is the final CI-equivalent gate on Linux; on Windows run the commands below in order after the final edit. Use individual or targeted commands during diagnosis, but do not treat them as a replacement for the applicable final gate.

1. `node node_modules/eslint/bin/eslint.js . --max-warnings=0` (or `pnpm lint` on Linux)
2. `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` (or `pnpm typecheck`)
3. `node node_modules/vitest/vitest.mjs run --coverage` (or `pnpm test`)
4. `node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs` (or `pnpm markdownlint`)
5. `cmd /c "pnpm build"` (or `pnpm build`)
6. `node packages/cli/dist/index.js eval --validate-only` after build (or `pnpm eval:validate`)
7. When docs/site content changes: `pnpm docs:build` (or `pnpm docs:check`) to validate public-content boundaries and the Starlight site

## Referenced prompt files

- `docs/ai/AGENTS.repository-baseline.md`
- `docs/ai/AGENTS.known-pitfalls.md`

## Relevant skills

- `.agents/skills/agent-behavior-guardrails/SKILL.md`
- `.agents/skills/repository-baseline-validation/SKILL.md`
- `.agents/skills/workspace-scaffold-maintenance/SKILL.md`
- `.agents/skills/ai-agent-maintenance/SKILL.md`
- `.agents/skills/plan-implementation-audit/SKILL.md`
- `.agents/skills/agent-runtime-integration/SKILL.md`
- `.agents/skills/output-channel-contracts/SKILL.md`
- `.agents/skills/remote-deployment/SKILL.md`
