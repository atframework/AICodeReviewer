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

## Real-service test endpoints

Redis/PostgreSQL contract tests skip unless the endpoint env vars are set.
For backend/migration work run the sequence with both exported so skips do
not masquerade as passes:

- `AICR_REDIS_TEST_URL`(如 `redis://127.0.0.1:6379`):redis config store、
  queue、auto-commit、catalog live 测试共用专用测试实例。重复全量验收用
  新建的临时实例或仅清理本轮拥有的前缀,禁止 `FLUSHDB`:残留键会让
  `scanCount` 极小的 live 扫描按全库键数放大往返并超时,见
  [config/state pitfalls](pitfalls/AGENTS.config-and-state.md)。
- `AICR_REDIS_OOM_TEST_URL`:只供 OOM 故障注入的独立 Redis 实例。
  `CONFIG SET maxmemory` 影响整个服务,不能仅换逻辑 DB 来隔离;
  用例恢复原始内存上限和淘汰策略。未设置时该用例明确跳过。
- `AICR_PG_TEST_URL`(如 `postgres://aicr@127.0.0.1:5432/aicr_test`):
  pg store / pg config store 测试;M08 低权限用例需要该角色具备
  `CREATE ROLE`(否则该用例失败而非 skip)。

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
