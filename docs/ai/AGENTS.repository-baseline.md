# Repository Baseline and Validation

Read when selecting final checks or changing build/CI/workspace tooling.
Current versions and scripts live in `package.json`, `pnpm-workspace.yaml`,
package manifests, and `.github/workflows/`; do not maintain a second version list.

## Applicable gates

| Changed surface | Final checks after the last edit |
| --- | --- |
| Maintenance Markdown, skills, bridge files, internal navigation | Repository Markdown gate; metadata/reference checks for AI assets; `git diff --check` |
| Runtime review prompt | Full runtime sequence below; prompt assembly and output-contract checks |
| Code, config, scripts, CI, Docker, shared tooling | Full runtime sequence below; additional checks for the changed contract |
| `docs/site` content/config/validators or dependencies affecting that site | Applicable checks above, plus `pnpm docs:build` (and `docs:check` when its types/components change) |
| Config schema documented by the site | Full runtime sequence plus `pnpm docs:check` to verify source-derived field/enum references |

## Runtime sequence

Linux/CI: `pnpm ci`. Windows: use PowerShell 7+ and execute these in order;
Node entrypoints avoid blocked `.ps1` shims. The build uses the package manager's
Windows shim through `cmd` as an explicit exception.

| Order | Windows command | Linux command |
| --- | --- | --- |
| 1 | `node node_modules/eslint/bin/eslint.js . --max-warnings=0` | `pnpm lint` |
| 2 | `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` | `pnpm typecheck` |
| 3 | `node node_modules/vitest/vitest.mjs run --coverage` | `pnpm test` |
| 4 | `node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs` | `pnpm markdownlint` |
| 5 | `cmd /c "pnpm build"` | `pnpm build` |
| 6 | `node packages/cli/dist/index.js eval --validate-only` | `pnpm eval:validate` |

For site commands on Windows use `cmd /c "pnpm docs:build"` / `docs:check`.
Run eval validation after build. Offline fixture validation does not exercise a
real LLM; do not describe it as a model-quality benchmark.

## Discovery and boundaries

- Tests: `packages/*/test/**/*.test.ts`; coverage: runtime package sources, with
  exclusions defined by `vitest.config.ts`.
- Markdown: `.markdownlint-cli2.yaml` includes hidden prompt/skill references and
  ignores generated output. Invoke the `-bin.mjs` entrypoint, not the library
  module, and confirm discovered file counts.
- Root build/clean select `./packages/*`; `docs/site` is a separate workspace
  application with its own public-content validators and CI job.
- Inspect native dependency engine/build constraints in the manifests and
  workspace YAML. Hydrate LFS assets before packaging. Detailed traps belong in
  [build/docs pitfalls](pitfalls/AGENTS.build-and-docs.md).
- A targeted pass does not replace this applicable final sequence. Preserve
  failure logs, inspect missing test workers, and distinguish environment
  restrictions from failed assertions.
