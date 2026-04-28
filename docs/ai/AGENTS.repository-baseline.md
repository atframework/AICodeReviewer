# Repository Baseline Context

## Current repository baseline

- Workspace layout: pnpm monorepo with packages under `packages/*`; root TypeScript project references are declared in `tsconfig.json`.
- Toolchain: Node `>=20`, pnpm `10.20.0`, TypeScript `NodeNext` with `strict` and `noUncheckedIndexedAccess`, ESLint 9, Vitest 3, Prettier 3, and `markdownlint-cli2`.
- Tests live in `packages/*/test/**/*.test.ts`; coverage targets `packages/*/src/**/*.ts` and excludes `packages/*/src/index.ts`.
- Shared root baseline files are `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `.markdownlint.json`, and `deploy/Dockerfile`.
- Temporary repository artifacts such as scratch scripts, debug logs, ad hoc reports, and captured command output belong under `build/`, not in the repository root.
- Docker baseline currently uses Chainguard Node, activates pnpm with `corepack prepare pnpm@10.20.0 --activate`, and does not use `pnpm setup`.

## Change heuristics

- If a change touches shared tooling, CI, Docker, root docs, or workspace topology, run the repository validation flow.
- When adding or removing packages, update package manifests, local `tsconfig.json` files, and root `tsconfig.json` references together.
- If a task needs temporary helpers or captured output during repository maintenance, place them under `build/` subdirectories instead of creating root-level scratch files.
- Keep AI-facing assets concise: stable repository rules belong in `AGENTS.md`, repeatable workflows belong in `.agents/skills/`, and historical stage detail belongs in `docs/ai/milestones/`.
- When updating AI-facing assets, merge with existing guidance instead of appending near-duplicate sections.

## Default verification order

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm markdownlint`
5. `pnpm build`
