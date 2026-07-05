# Repository Baseline Context

## Current repository baseline

- Workspace layout: pnpm monorepo with packages under `packages/*`; root TypeScript project references are declared in `tsconfig.json`.
- Toolchain: runtime packages support Node `>=20`; `docs/site` uses Astro 7 and requires Node `>=22.12.0` (CI docs job uses Node 24). The shared tooling baseline is pnpm `10.20.0`, TypeScript `NodeNext` with `strict` and `noUncheckedIndexedAccess`, ESLint 9, Vitest 3, Prettier 3, and `markdownlint-cli2`.
- Tests live in `packages/*/test/**/*.test.ts`; coverage targets `packages/*/src/**/*.ts` and excludes `packages/*/src/index.ts`.
- Shared root baseline files are `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `.markdownlint.json`, `.github/workflows/ci.yml`, and `deploy/Dockerfile`.
- AI agent guidance uses `AGENTS.md` plus `.agents/skills/*/SKILL.md` as the canonical tool-neutral layer; `CLAUDE.md` is only a bridge that imports `AGENTS.md` for Claude Code.
- Prompt baseline assets currently live in `docs/prompt-research.md`, `docs/ai/milestones/M0.5.md`, and `prompts/system/code-reviewer.system.md`; keep them aligned and validate them with markdownlint when changed.
- `Plan.md` is now roadmap-only. Use `docs/ai/index.md` to find detailed architecture, milestone history, and decision records on demand.
- Temporary repository artifacts such as scratch scripts, debug logs, ad hoc reports, and captured command output belong under `build/` subdirectories (`build/tmp/`, `build/logs/`, `build/deploy/`), not in the repository root. Ensure the subdirectory exists before writing.
- Docker baseline now uses `ubuntu:24.04` as the distro base, copies the Node 22 userspace from `node:22-bookworm-slim`, installs `p4-cli` from Perforce's Ubuntu APT repo, includes Python pip/venv, Kubernetes/Helm/YAML tooling (`kubectl`, `helm`, Mike Farah `yq`), Podman/container clients (`podman`, `buildah`, `skopeo`), plus common build/debug/static-analysis tools, and normalizes Debian/Ubuntu command names so prompts can consistently refer to `fd` and `bat`.

## Change heuristics

- If a change touches shared tooling, CI, Docker, root docs, or workspace topology, run the repository validation flow.
- When adding or removing packages, update package manifests, local `tsconfig.json` files, and root `tsconfig.json` references together.
- When behavior changes touch config shape, agent adapters, MCP tool contracts, output rendering, deployment, or public workflows, update `Plan.md` roadmap summaries, the relevant `docs/` module, and `example/config.yaml` / `example/README.md` together.
- If a task needs temporary helpers or captured output during repository maintenance, place them under `build/` subdirectories (`build/tmp/`, `build/logs/`) instead of creating root-level scratch files.
- Keep AI-facing assets concise: stable repository rules belong in `AGENTS.md`, repeatable workflows belong in `.agents/skills/`, and historical stage detail belongs in `docs/ai/milestones/`.
- When updating AI-facing assets, merge with existing guidance instead of appending near-duplicate sections.
- Keep tool-private AI files as tiny bridges or scoped deltas; do not copy the full `AGENTS.md` body into Copilot, Claude, Kilo, Zoo, opencode, or similar client-specific locations.
- When updating the default review prompt, keep `docs/prompt-research.md`, `docs/ai/milestones/M0.5.md`, `prompts/system/code-reviewer.system.md`, and the relevant `Plan.md` roadmap summary in sync so future agents see both rationale and current contract.
- When changing runtime shell-tool guidance or the deployment image baseline,
  sync `AGENTS.md`, `prompts/system/code-reviewer.system.md`,
  `docs/output-channels.md`, `development/README.md`, and `example/README.md`
  together so agents only prefer tools that the shipped image guarantees.

## Known pitfalls (fixed, do not reintroduce)

These issues were discovered and fixed in prior sessions. Before making changes, verify you are not reintroducing them:

1. **Config schema gaps**: `packages/core/src/config.ts` Zod schemas must include all fields from Plan.md §3.10 / `docs/ai/architecture.md` §3.10 — `compression`, `llm.fallback_chain`, `llm.retry`, `llm.budget`, `llm.per_provider_overrides`, `queue.workers`, `queue.rate_limit`, `queue.retry`, `queue.dead_letter`, `review.problem_issue.max_recent_issues`, `review.reflection.memory`, `workspaces.defaults.agent`, `agent.context_compaction`, `outputs.channels[].mention_fallback`, `outputs.routes`, top-level `storage` (database/cache/object/retention), and `admin` (username/password/password-hash env names and session TTL).
2. **Store schema columns**: `packages/store/src/schema.ts` must include `triggerName`, `provider`, `providerModel`, and the observability tables `projects` (with `deleted_at`), `reviewRuns` (project FK, skip/compression/token/target/duration/count fields), `codeMetrics`, `llmUsage`, `outputEvents`, and `dailyRollups` per Plan.md §3.11 / `docs/ai/architecture.md` §3.11.
3. **`isPlainObject` strictness**: Must reject `Date`, `RegExp`, and other built-in class instances. Only `Object.prototype` or `null` prototype.
4. **`normalizePath` slash compression**: Must compress `//` → `/` in addition to backslash and `./` handling.
5. **CJK token estimation**: `estimateTokens` must count CJK characters as ~2 tokens, not 0.25.
6. **Conflict detection**: `discoverRepoPromptAssets` must detect duplicate skills, overlapping path-instructions, and alias vs copilot-instruction overlaps.
7. **Orchestrator status**: When `dryRun` is false, status must not fall back to `"dry_run"`.
8. **Unused imports**: Verify every import is used. CLI `app.ts` previously had unused `ReviewEvent`.
9. **DRY utilities**: `normalizePath`, `normalizeChangedPath`, `isPlainObject` live in `packages/core/src/utils.ts`. Do not duplicate.
10. **All packages need tests**: Even packages that only export a constant need `test/index.test.ts`.
11. **Public module naming boundaries**: Generic/public modules must import provider/channel contracts from canonical schemas instead of duplicating platform literal lists, and public event/template fields should use provider-neutral names such as `sourcePath` and `submitterWorkspace`.
12. **Markdown list marker fixer boundaries**: `LIST_MARKER_WITHOUT_SPACE_RE` must use `[ \t]*` indentation and must preserve both bold markers and thematic breaks.
13. **Markdown MD022 blanks-around-headings**: `fixBlanksAroundHeadings` in `packages/core/src/markdown-fixer.ts` must insert blank lines before and after ATX headings while skipping fenced code block content, ensuring LLM-generated summaries pass markdownlint MD022.
14. **Runtime shell-tool guidance must match the image**: If prompts or skills
    tell agents to prefer `rg` / `fd` / `bat` / `jq` / `yq` or local
    `helm` / `kubectl` checks, `deploy/Dockerfile` must install them and
    normalize distro-specific command names (`fd-find` → `fd`, `batcat` →
    `bat`). The P4-enabled runtime image also
    depends on Ubuntu/glibc unless the `p4` install path is revalidated. Keep
    `PIP_INDEX_URL` / `/etc/pip.conf`, `KUBERNETES_APT_REPO_BASE`,
    Helm apt repo, and `YQ_DOWNLOAD_BASE` support aligned with deployment
    mirror docs when runtime tooling changes.

## Default verification order

1. `node node_modules/eslint/bin/eslint.js .` (or `pnpm lint` on Linux)
2. `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` (or `pnpm typecheck`)
3. `node node_modules/vitest/vitest.mjs run` (or `pnpm test`)
4. `node node_modules/markdownlint-cli2/markdownlint-cli2.mjs "**/*.md" "!**/node_modules/**" "!**/dist/**" "!**/coverage/**"` (or `pnpm markdownlint`)
5. Build step (if applicable)
6. Eval fixture validation after build: `node packages/cli/dist/index.js eval --validate-only` (or `pnpm eval:validate` on Linux/CI)
