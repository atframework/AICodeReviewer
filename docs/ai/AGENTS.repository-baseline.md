# Repository Baseline Context

## Current repository baseline

- Workspace layout: pnpm monorepo with packages under `packages/*`; root TypeScript project references are declared in `tsconfig.json`.
- Toolchain: runtime packages support Node `>=20`; `docs/site` uses Astro 7 and requires Node `>=22.12.0` (CI docs job uses Node 24). The shared tooling baseline is pnpm `10.20.0`, TypeScript `NodeNext` with `strict` and `noUncheckedIndexedAccess`, ESLint 9, Vitest 3, Prettier 3, and `markdownlint-cli2`.
- Tests live in `packages/*/test/**/*.test.ts`; coverage targets `packages/*/src/**/*.ts` and excludes `packages/*/src/index.ts`.
- Shared root baseline files are `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `.markdownlint.json`, `.github/workflows/ci.yml`, `.github/workflows/docs.yml`, `.github/workflows/publish-image.yml`, `.github/workflows/stale.yml`, and `deploy/Dockerfile`.
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
- Keep AI-facing assets concise: stable repository rules belong in `AGENTS.md`, repeatable workflows belong in `.agents/skills/`, historical stage detail belongs in `docs/ai/milestones/`, and fixed regression checklists belong in `docs/ai/AGENTS.known-pitfalls.md`.
- When updating AI-facing assets, merge with existing guidance instead of appending near-duplicate sections.
- Keep tool-private AI files as tiny bridges or scoped deltas; do not copy the full `AGENTS.md` body into Copilot, Claude, Kilo, Zoo, opencode, or similar client-specific locations.
- When updating the default review prompt, keep `docs/prompt-research.md`, `docs/ai/milestones/M0.5.md`, `prompts/system/code-reviewer.system.md`, and the relevant `Plan.md` roadmap summary in sync so future agents see both rationale and current contract.
- When changing runtime shell-tool guidance or the deployment image baseline,
  sync `AGENTS.md`, `prompts/system/code-reviewer.system.md`,
  `docs/output-channels.md`, `development/README.md`, and `example/README.md`
  together so agents only prefer tools that the shipped image guarantees.

## Known pitfalls (fixed, do not reintroduce)

The complete fixed-issue checklist lives in `docs/ai/AGENTS.known-pitfalls.md`. Read it before non-trivial implementation, review, or AI-asset maintenance work so there is a single source of truth and no duplicate lists to keep in sync.

## Default verification order

Run targeted checks while iterating, then restart every applicable gate after the final edit. `pnpm ci` is the final runtime gate on Linux/CI; on Windows use the commands below in order. Confirm the tools report discovered files/tests—a silent or no-op exit code 0 is not a pass.

1. `node node_modules/eslint/bin/eslint.js . --max-warnings=0` (or `pnpm lint` on Linux)
2. `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` (or `pnpm typecheck`)
3. `node node_modules/vitest/vitest.mjs run --coverage` (or `pnpm test`)
4. `node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs` (or `pnpm markdownlint`)
5. `cmd /c "pnpm build"` (or `pnpm build`)
6. Eval fixture validation after build: `node packages/cli/dist/index.js eval --validate-only` (or `pnpm eval:validate` on Linux/CI)
