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

Linux/CI: `pnpm run ci` (the repository script; `pnpm ci` names a reserved pnpm
command). Windows: use PowerShell 7+ and execute these in order;
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

## Browser gate (dashboard config UI, P6)

`tests/browser/` holds the Playwright suite for the dashboard management pages.
It drives the real CLI server against a throwaway SQLite store; no external
service or LLM is contacted. One-time setup: `pnpm exec playwright install
chromium` (browser download is intentionally not part of `pnpm install`).
Run after `pnpm build`:

| Order | Windows command | Linux command |
| --- | --- | --- |
| 7 | `cmd /c "pnpm test:browser"` | `pnpm test:browser` |

The suite is applicable when the diff touches `packages/server/src/dashboard/`,
the config admin API, the core `config-ui-*` paradigm modules, or
`tests/browser/` itself. CI runs it as the dedicated `browser` job.

## Real-service test endpoints

Redis/PostgreSQL contract tests skip unless the endpoint env vars are set.
For backend/migration work run the sequence with both exported so skips do
not masquerade as passes. `vitest.config.ts` sets `testTimeout: 15000`:
live-service suites exceed the 5s vitest default under full-suite worker
load on many-core hosts. A standalone pass alone does not establish a load flake:
retain the failure log, investigate service/resource state, then rerun the unchanged
applicable gate. Do not dismiss assertion failures or weaken checks. The endpoint
variables:

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
- `AICR_SVN_TEST_EXECUTABLE`：本机 SVN CLI，旁边需有 `svnadmin`、
  `svnserve`；真实 hook 用例创建独立仓库与回环服务。
- `AICR_P4D_TEST_EXECUTABLE`：本机 p4d，`p4` 客户端需在 PATH 中；
  用例创建独立测试服务。先检查已有可执行文件，再把缺少工具记录为跳过。
- `AICR_GITEA_TEST_URL` / `AICR_GITEA_TEST_TOKEN`：仅用于独立回环 Gitea；
  真实发布后检查 assignees，测试会创建/删除合成用户与私有仓库。
  两者都不设才跳过；[临时服务脚本](../testing-services.md)负责限额、启动与清理。
- `AICR_SVN_TEST_URL`：`with-svn.sh` 的只读网络仓库；本机需有 `svn` 客户端。
  核验辅助仓库的固定 revision、HEAD、diff 和失败清理。
- `AICR_FEISHU_TEST_*`、`AICR_ZHIPU_TEST_*`、`AICR_KIMI_TEST_*`：真实账户验收，
  完整变量及调用上限见[服务指南](../testing-services.md)。默认跳过，部分配置失败。
  普通门禁不读取本地 secret YAML；手动验收与全量覆盖率分开运行，避免重复通知/付费。

本机快速搭建（Windows 示例，一次性实例，不入库）：
`scoop install postgresql redis`；PG 用
`initdb -D <build/tmp 目录> -U aicr --pwfile=<file> -A scram-sha-256 -E UTF8`
起一次性 cluster 后 `postgres -D <目录> -p <port>` 前台运行，建库
`createdb aicr_test`；Redis 直接 `redis-server --port <port> --bind 127.0.0.1`。
Windows 的 Hyper-V/WSL 会动态保留 TCP 端口段，落在段内的端口 bind 报
EACCES（`netsh interface ipv4 show excludedportrange protocol=tcp` 查看）；
选段外端口（如 PG 55432、Redis 6380/6381）。msys2 版 redis-server 对通配
地址 bind 也可能报 Permission denied，显式 `--bind 127.0.0.1` 规避。

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
