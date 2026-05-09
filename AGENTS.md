# AICodeReviewer Agent Guidelines

## Scope

- `AGENTS.md` is the only always-on instruction source for this repository.
- Keep repository-wide stable rules here. Put repeatable workflows in `.agents/skills/`.
- Keep this file short, specific, and verifiable. If removing a line would not cause future agents to make mistakes, remove it.
- If `AGENTS.md` references AI-facing prompt or context files, those files must use the `AGENTS.` prefix and functional names.
- When updating AI-facing assets, read the existing `AGENTS.md`, referenced `AGENTS.*.md` files, and related skills first, then merge instead of appending near-duplicate content.
- Keep milestone detail in `docs/ai/milestones/*.md`; do not duplicate large milestone summaries into prompts or skills, and do not use milestone IDs in prompt or skill names.
- Do not maintain duplicate global prompt bodies in `.github/copilot-instructions.md`, `CLAUDE.md`, `.roo/`, `.kilo/`, `opencode.json`, or other tool-private files. Tool-specific files may only bridge to `AGENTS.md` or add narrowly scoped behavior the shared file cannot express.

## Agent compatibility

- Treat `AGENTS.md` plus `.agents/skills/*/SKILL.md` as the canonical, tool-neutral layer for VS Code Copilot, Copilot CLI, Codex, Claude Code, Kilo Code, Roo Code, Kilo CLI, opencode, and similar agents.
- Prefer one canonical rule over parallel copies. If a client needs a private format, make it a small pointer to the canonical source or a path-scoped delta.
- Use path-specific instructions only when a rule should not load for the whole repository. Keep Copilot `.github/instructions/*.instructions.md`, Claude `.claude/rules/`, Roo `.roo/rules/`, Kilo rules, and opencode `instructions` entries aligned by intent if they are added later.
- Skills must follow the Agent Skills shape: directory name equals frontmatter `name`, `description` states what the skill does and when not to use it, and detailed references/scripts/assets load only on demand.
- Do not rely on one agent's proprietary frontmatter for correctness. Extra fields may improve a client, but the Markdown body must remain usable by agents that only understand `name` and `description`.

## Guardrails

- Prefer minimal edits; do not weaken lint, typecheck, test, or markdown gates just to get a change through.
- When adding or removing a workspace package, update the package manifest, local `tsconfig.json`, and root `tsconfig.json` references together.
- When code changes affect config shape, agent adapters, MCP tool contracts, output rendering, deployment behavior, or public workflow, update the matching `Plan.md`, `docs/`, `example/config.yaml`, and `example/README.md` entries in the same change, or explicitly state why no doc/example update is needed.
- Keep temporary repository artifacts such as scratch scripts, debug logs, and one-off reports under `build/`; do not leave them in the repository root.
- Use `.github/instructions/*.instructions.md` only for path-specific rules; keep workspace-wide rules in this file.
- Keep AI-facing assets concise: stable rules here, detailed shared context in `AGENTS.*.md`, and repeatable procedures in skills.

## Environment notes

- **Windows PowerShell execution policy**: `pnpm`, `npx`, and other `.ps1` scripts are blocked by default. Run Node-based CLI tools directly via `node`:
  - Tests: `node node_modules/vitest/vitest.mjs run`
  - Lint: `node node_modules/eslint/bin/eslint.js .`
  - Typecheck: `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false`
  - Build: Use `cmd /c "pnpm build"` or invoke the package build scripts directly.
- If `pnpm` is available in the environment (e.g., CI Linux runner), prefer `pnpm` over the `node` workaround.

## Known codebase pitfalls

These issues have been found and fixed in prior sessions. Before making changes, check that you are not reintroducing any of them:

1. **Config schema must track Plan.md §3.10**: `packages/core/src/config.ts` Zod schemas must include `compression`, `llm.fallback_chain`, `llm.retry`, `llm.budget`, `llm.per_provider_overrides`, `queue.workers`, `queue.rate_limit`, `queue.retry`, `queue.dead_letter`, `review.reflection.memory`, `workspaces.defaults.agent`, `outputs.channels[].mention_fallback`, and `outputs.routes`. If you add config fields, add corresponding tests in `packages/core/test/config.test.ts`.
2. **Store schema must track Plan.md §3.11**: `packages/store/src/schema.ts` must include `triggerName`, `provider`, and `providerModel` columns. If you change the schema, update `packages/store/test/schema.test.ts`.
3. **`isPlainObject` must reject built-in class instances**: `Date`, `RegExp`, and other non-plain prototypes must return `false`. Only `Object.prototype` or `null` prototype are plain.
4. **`normalizePath` must compress consecutive slashes**: `//` → `/` in addition to backslash replacement and leading `./` stripping.
5. **`estimateTokens` must handle CJK characters**: Characters in CJK Unicode ranges count as ~2 tokens, not 0.25.
6. **Prompt manager must detect conflicts**: `discoverRepoPromptAssets` must detect duplicate skill names, overlapping path-instructions, and alias vs copilot-instruction overlaps.
7. **Review orchestrator status logic**: When `dryRun` is false, status must not fall back to `"dry_run"` regardless of whether an output publisher exists.
8. **No unused imports**: Always verify that every import is used before committing. The CLI `app.ts` previously had an unused `ReviewEvent` import.
9. **DRY utility functions**: `normalizePath`, `normalizeChangedPath`, and `isPlainObject` live in `packages/core/src/utils.ts`. Import from `@aicr/core` or the local `./utils.js` — do not duplicate these functions in other files.
10. **Sandbox and agents packages must have tests**: Even if they only export a constant, create `test/index.test.ts` to verify the export.
11. **Sandbox `exactOptionalPropertyTypes`**: When passing optional fields from config to sandbox/agent constructors, use conditional spread (`options.image ? { image: options.image } : {}`) instead of direct assignment to avoid `undefined` type mismatches.
12. **Agent adapter factory must guard optional fields**: `createAgentAdapter` must not pass `undefined` binary to `createKiloAdapter`; use conditional construction instead.
13. **`execFile` does not support `input` on Node 20**: For passing stdin to child processes in sandbox/docker, use `spawn` directly rather than `execFile` with `input` option.
14. **Serve bootstrap must publish when configured**: `bootstrapServerApp` must not force `dryRun: true`; use a per-event `outputPublisherResolver` so Gitea webhook payloads can resolve PR numbers and publish line comments.
15. **Container sandbox engine and allowlist must be enforced**: Docker-compatible sandbox code must invoke the resolved `docker`/`podman` CLI and validate commands against `ALLOWED_COMMANDS` before spawning containers.
16. **Container env files must stay outside mounted workspaces**: `--env-file` paths for docker/podman must be temporary host files outside `agent/`, `tmp/`, and `source/` mounts, then deleted after the run.

## Default verification order

1. `node node_modules/eslint/bin/eslint.js .` (or `pnpm lint` on Linux)
2. `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` (or `pnpm typecheck`)
3. `node node_modules/vitest/vitest.mjs run` (or `pnpm test`)
4. `node node_modules/markdownlint-cli2/markdownlint-cli2.mjs "**/*.md" "!**/node_modules/**" "!**/dist/**" "!**/coverage/**"` (or `pnpm markdownlint`)
5. Build step (if applicable)

## Referenced prompt files

- `docs/ai/AGENTS.repository-baseline.md`

## Relevant skills

- `.agents/skills/repository-baseline-validation/SKILL.md`
- `.agents/skills/workspace-scaffold-maintenance/SKILL.md`
- `.agents/skills/ai-agent-maintenance/SKILL.md`
- `.agents/skills/plan-implementation-audit/SKILL.md`
- `.agents/skills/agent-runtime-integration/SKILL.md`
- `.agents/skills/output-channel-contracts/SKILL.md`
