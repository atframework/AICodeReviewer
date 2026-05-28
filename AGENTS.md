# AICodeReviewer Agent Guidelines

## Scope

- `AGENTS.md` is the only always-on instruction source for this repository.
- Keep repository-wide stable rules here. Put repeatable workflows in `.agents/skills/`.
- Keep this file short, specific, and verifiable. If removing a line would not cause future agents to make mistakes, remove it.
- If `AGENTS.md` references AI-facing prompt or context files, those files must use the `AGENTS.` prefix and functional names.
- When updating AI-facing assets, read the existing `AGENTS.md`, referenced `AGENTS.*.md` files, and related skills first, then merge instead of appending near-duplicate content.
- Keep milestone detail in `docs/ai/milestones/*.md`; do not duplicate large milestone summaries into prompts or skills, and do not use milestone IDs in prompt or skill names.
- Treat `Plan.md` as the forward-looking roadmap only. When a task needs stable design details or completed-stage history, read `docs/ai/index.md` and follow its links on demand instead of expanding `Plan.md` again.
- Do not maintain duplicate global prompt bodies in `.github/copilot-instructions.md`, `CLAUDE.md`, `.roo/`, `.kilo/`, `opencode.json`, or other tool-private files. Tool-specific files may only bridge to `AGENTS.md` or add narrowly scoped behavior the shared file cannot express.

## Agent compatibility

- Treat `AGENTS.md` plus `.agents/skills/*/SKILL.md` as the canonical, tool-neutral layer for VS Code Copilot, Copilot CLI, Codex, Claude Code, Kilo Code, Roo Code, Kilo CLI, opencode, and similar agents.
- Prefer one canonical rule over parallel copies. If a client needs a private format, make it a small pointer to the canonical source or a path-scoped delta.
- Use path-specific instructions only when a rule should not load for the whole repository. Keep Copilot `.github/instructions/*.instructions.md`, Claude `.claude/rules/`, Roo `.roo/rules/`, Kilo rules, and opencode `instructions` entries aligned by intent if they are added later.
- Skills must follow the Agent Skills shape: directory name equals frontmatter `name`, `description` states what the skill does and when not to use it, and detailed references/scripts/assets load only on demand.
- Do not rely on one agent's proprietary frontmatter for correctness. Extra fields may improve a client, but the Markdown body must remain usable by agents that only understand `name` and `description`.

## Guardrails

- Prefer minimal edits; do not weaken lint, typecheck, test, or markdown gates just to get a change through.
- For non-trivial work, make assumptions, tradeoffs, and success criteria explicit before editing; ask when ambiguity changes the implementation.
- Keep solutions simple and surgical: no speculative features, broad refactors, or style churn outside the user-requested scope; clean up only code made unused by your changes.
- When adding or removing a workspace package, update the package manifest, local `tsconfig.json`, and root `tsconfig.json` references together.
- When code changes affect config shape, agent adapters, MCP tool contracts, output rendering, deployment behavior, or public workflow, update the matching `Plan.md` roadmap summary, relevant `docs/` modules, `example/config.yaml`, and `example/README.md` entries in the same change, or explicitly state why no doc/example update is needed.
- **All temporary task artifacts must go under `build/`**: scratch scripts, debug logs, one-off reports, intermediate data, benchmark outputs, and any file produced during an agent session that is not a permanent part of the codebase must be written under `build/`. Never leave temporary files in the repository root, `eval/`, or any package directory. Use purposeful subdirectories: `build/tmp/` for ad-hoc data, `build/logs/` for captured output, and existing `build/deploy/` for deployment staging. Ensure the subdirectory exists before writing (`node -e "require('fs').mkdirSync('build/tmp',{recursive:true})"`). The `eval/` directory is reserved for permanent eval CLI test fixtures only; do not store task scratch files there.
- Use `.github/instructions/*.instructions.md` only for path-specific rules; keep workspace-wide rules in this file.
- Keep AI-facing assets concise: stable rules here, detailed shared context in `AGENTS.*.md`, and repeatable procedures in skills.
- When an agent hits an error but succeeds by retrying or changing approach, capture the generalizable cause and fix in the most appropriate existing `AGENTS.md` or skill file after researching current prompt/skill best practices; merge the lesson concisely instead of adding incident logs or duplicates.

## Environment notes

- **Windows PowerShell execution policy**: `pnpm`, `npx`, and other `.ps1` scripts are blocked by default. Run Node-based CLI tools directly via `node`:
  - Tests: `node node_modules/vitest/vitest.mjs run`
  - Lint: `node node_modules/eslint/bin/eslint.js .`
  - Typecheck: `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false`
  - Build: Use `cmd /c "pnpm build"` or invoke the package build scripts directly.
- PowerShell treats backticks as escapes/line continuations; avoid inline `node -e` snippets that contain JavaScript template literals or complex quote nesting. Prefer native PowerShell, a short script under `build/tmp/`, or quote-free Node snippets.
- If `pnpm` is available in the environment (e.g., CI Linux runner), prefer `pnpm` over the `node` workaround.
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

These issues have been found and fixed in prior sessions. Before making changes, check that you are not reintroducing any of them:

1. **Config schema must track Plan.md §3.10 / `docs/ai/architecture.md` §3.10**: `packages/core/src/config.ts` Zod schemas must include `compression`, `llm.fallback_chain`, `llm.retry`, `llm.budget`, `llm.per_provider_overrides`, `queue.workers`, `queue.rate_limit`, `queue.retry`, `queue.dead_letter`, `review.problem_issue.max_recent_issues`, `review.reflection.memory`, `workspaces.defaults.agent`, `outputs.channels[].mention_fallback`, `outputs.routes`, `storage` (database/cache/object/retention), and `admin` (username_env/password_env/password_hash_env/session_ttl). If you add config fields, add corresponding tests in `packages/core/test/config.test.ts`.
2. **Store schema must track Plan.md §3.11 / `docs/ai/architecture.md` §3.11**: `packages/store/src/schema.ts` must include `triggerName`, `provider`, `providerModel`, and the full observability schema: `projects` (with `deleted_at`), `reviewRuns` (with `projectId` FK, `skipReason`, `compressed`, token estimates, target metadata, duration, problem/summary/dispatch counts), `codeMetrics`, `llmUsage`, `outputEvents`, and `dailyRollups`. If you change the schema, update `packages/store/test/schema.test.ts`.
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
17. **`fixListMarkerSpacing` must not break `**bold**` or `***bold-italic***`**: The `LIST_MARKER_WITHOUT_SPACE_RE` regex in `packages/core/src/markdown-fixer.ts` must exclude `*` from the follow-character set for `*` markers so that `**Text**` at line start is never split into `* *Text**`.
18. **`fixListMarkerSpacing` must not break thematic breaks**: Its indentation groups must use `[ \t]*`, not `\s*`, so `---` stays a thematic break instead of becoming `- --`.
19. **Keep generic public modules platform-neutral**: Shared/public modules such as `packages/cli/src`, `ReviewEvent`, and `TemplateContext` must not duplicate provider/channel literal lists or expose platform-specific field names. Import canonical schemas/constants from `@aicr/core` and use generic fields such as `sourcePath` and `submitterWorkspace`; keep Gitea/GitHub/P4/etc. names inside config contracts, docs/examples, tests, and platform-specific adapters.
20. **`fixAndValidateMarkdown` must enforce MD022 blanks-around-headings**: `fixBlanksAroundHeadings` in `packages/core/src/markdown-fixer.ts` must insert blank lines before and after ATX headings (`#`-prefixed lines) while skipping fenced code block content. This ensures LLM-generated summaries pass markdownlint MD022.
21. **Runtime bundle must be materialized for every agent run**: `materializeRuntimeBundle` in `packages/agents/src/runtime-bundle.ts` must be used instead of calling `adapter.materializeConfig` directly. It writes instructions, skills, MCP tool metadata, and a `manifest.json` into the isolated `agent/` directory.
22. **`renderMarkdownCodeFence` argument order**: The signature is `(content, language?)` — code snippet first, language second. All call sites must pass `(codeSnippet, codeLanguage)`, not `(codeLanguage, codeSnippet)`. The consolidated issue body builder in `packages/outputs/src/index.ts` previously had these swapped, producing garbled language identifiers in place of fenced code.
23. **IM markdown table regex must not use `g` flag with `.test()`**: `TABLE_ROW_RE` and `TABLE_DIVIDER_RE` in `packages/outputs/src/im-markdown.ts` must NOT have the `g` (global) flag. With `g`, `.test()` advances `lastIndex` between calls, causing consecutive table rows to be misdetected. Use `mu` flags only.
24. **PR review dispatchers must use `toWeComMarkdown`/`toFeishuMarkdown` for IM channels**: IM bot dispatchers (`createWeComBotDispatcher`, `createFeishuBotDispatcher`) must pass content through their respective `toXxxMarkdown()` transformer before sending. Raw `sections.join("\n")` breaks tables and headings in IM-rendered cards.
25. **PR review `review_mode` and `review_event` must flow from config**: `packages/server/src/bootstrap.ts` must read `review_mode` and `review_event` from channel config and pass them to `createGiteaPullRequestReviewDispatcher` / `createGithubPullRequestReviewDispatcher`. Default is `review_mode: "auto"` (try review API, fallback to issue comment on 403/422) and `review_event: "COMMENT"`.
26. **Agent free-form stdout is not a final report**: Agent-adapter runs must not publish natural-language stdout as an IM summary. Disable natural-language fallback for agent stdout, trigger a structured repair pass, and require `aicr.report_problem` records for any issue locations shown in Feishu/WeCom reports.
27. **Summary-only issue claims and missing-context skips must be repaired**: If output text says issues were found but `problemCount` is still zero, or if skip/summary prose asks humans to provide diff/source context, do not rely on `no_problems` routing. Clear provisional outputs and require structured `aicr.report_problem` records or `aicr.fetch_more_context`; for P4 context gaps, the adapter can `p4 print` full changed or related files at the reviewed changelist.
28. **Agent repair must fall back to direct LLM when model cannot produce structured output**: Models like `glm-5` may output natural-language prose instead of structured JSON tool calls when run through agent adapters (Kilo). When the agent repair retry still produces no parseable output, the orchestrator must bypass the agent and call `options.llm.complete()` directly with the repair prompt and `allowNaturalLanguageSummary: true`; however, prose that explicitly says there are no actionable problems or no reviewable code must be normalized to `aicr.skip` instead of publishing the generic format-repair fallback summary. Additionally, `extractKiloJsonStreamContent` must capture `tool_call`/`tool_use` stream events so that MCP tool calls made by the agent inside the sandbox are not silently dropped.
29. **Kilo MCP tool name format and MCP state file**: Kilo (≥7.x) prefixes MCP tool names with the server name and converts dots to underscores (e.g., `aicr.report_problem` → `aicr-output_aicr_report_problem`). `normalizeToolName` must map this format back to the canonical `aicr.*` names. The MCP output server writes `.aicr-output-state.json` to the agent workspace after each tool call; the orchestrator must read this file after the agent run and populate the AICR output collector from it, rather than relying solely on text-based JSON parsing.
30. **PR review update mode must use issue comment API for PATCH**: When `review_update_strategy: "update_existing"` is set, the summary comment is managed via issue comment endpoints (`GET` to list, `PATCH` to update, `POST` to create). The `<!-- aicr:managed=pr-review -->` marker must be present in every managed comment body. The `<!-- aicr:problems=... -->` marker tracks current fingerprints and must be regenerated on each update. Resolved fingerprints must appear in the body's Resolved section with their original value, not silently dropped.
31. **Review deduplication key must isolate trigger/workspace and use stable targets**: `buildDedupKey` in `packages/server/src/review-deduplicator.ts` must include `triggerName` and `workspaceId`, then prioritize `reviewEvent.branch` over `url`, `headSha`, or `baseSha` so that repeated `/aicr review` commands on the same PR/MR are deduplicated across new commits without collapsing unrelated comment-triggered reviews into one `unknown` target.
32. **Config/workflow/public changes must sync docs in the same change**: When code changes affect config shape, agent adapters, MCP tool contracts, output rendering, deployment behavior, public workflow, or review orchestration semantics, update the matching `Plan.md` roadmap summary, relevant `docs/` modules, `example/config.yaml`, and `example/README.md` entries in the same change, or explicitly state why no doc/example update is needed. This rule exists because prior sessions repeatedly missed doc sync, leading to stale contracts.
33. **Rootless Podman deploy scripts must specify `--storage-driver=overlay`**: When the server uses a custom `rootless_storage_path` in `/etc/containers/storage.conf`, Podman 5.x rootless auto-detection can fail after reboot or OOM, producing the misleading error `"invalid internal status ... could not find any running process"`. The real cause is storage-layer initialization failure, not a missing pause process. `podman system migrate` may crash with a nil pointer in this state. Always use `podman --storage-driver=overlay system migrate` to recover, and add `--storage-driver=overlay` to all `podman build/run/rm` commands in `deploy.sh`. Add a pre-flight check (`podman ps || podman --storage-driver=overlay system migrate`) at the top of deploy scripts.
34. **Native MCP context requests must trigger VCS follow-up**: Kilo MCP state `contextRequests` and JSON stream `tool_call` / `tool_use` events for `aicr.fetch_more_context` must be replayed through the orchestrator's VCS-backed handler and followed by a final pass. Clear `.aicr-output-state.json` before each agent run so stale context or summary state cannot publish "无法访问完整仓库代码" as a final report.
35. **Container sandbox workdir must be `/workspace/agent`**: Docker/Podman sandbox runs must set the container workdir to the writable agent mount. Otherwise Kilo-spawned MCP servers can write `.aicr-output-state.json` under the image workdir (for example `/app`) and the orchestrator will miss structured results.
36. **Runtime image copies need build-stage directories for hoisted-only packages**: `deploy/Dockerfile` must copy `packages/sandbox/node_modules` and `packages/eval/node_modules` alongside their `dist/` outputs, but `pnpm install` can omit those package-local directories when the packages only use hoisted/workspace dependencies. Create them in the build stage with `mkdir -p packages/sandbox/node_modules packages/eval/node_modules` before the runtime `COPY --from=build ... node_modules` lines, or remote image builds will fail with `copier: stat: "/app/packages/.../node_modules": no such file or directory`.
37. **pnpm 10.x native module builds require `onlyBuiltDependencies` in workspace yaml**: pnpm 10 introduced a build-approval gate for native modules. The correct fix is adding `onlyBuiltDependencies: [better-sqlite3]` to `pnpm-workspace.yaml`. Do NOT use `pnpm config set onlyBuiltDependencies` (sets a global string, not a project list), `--allow-build` (does not exist in pnpm 10.20.0), or `pnpm rebuild` (also blocked by the approval mechanism).
38. **P4-enabled runtime image requires Ubuntu/glibc**: `deploy/Dockerfile`
  now uses `ubuntu:24.04` as the distro base and copies the Node 22
  userspace from `node:22-bookworm-slim`. Official Perforce packages provide
  an Ubuntu APT repository and do not support Alpine/non-glibc images. Do
  not switch the runtime `BASE_IMAGE` back to Alpine/Wolfi/Chainguard unless
  you also replace the `p4-cli` installation path and revalidate the full
  tool baseline (`git`, `subversion`, `p4`, `ripgrep`, `fd`, `bat`, `jq`,
  `yq`, `kubectl`, `helm`, `podman`, `buildah`, `skopeo`, `python3-pip`,
  `cmake`, `ninja`, `clang-tidy`, `cppcheck`, `gdb`, `valgrind`,
  `shellcheck`, `strace`, `lsof`, `universal-ctags`).
39. **Windows PowerShell file encoding defaults to UTF-16 LE**: PowerShell 5.1 `>` redirect and `Out-File` default to UTF-16 LE encoding; `Out-File -Encoding utf8` adds a BOM. For remote file transfers (`.env`, `config.yaml`, scripts), use `Out-File -Encoding ascii` or `Set-Content -Encoding utf8` (PS 7+). Better: use `scp` from the Linux-side or `printf` on the remote host to avoid encoding issues entirely.
40. **Admin config uses `session_ttl_seconds` not `minutes`**: The `adminAuthSchema` in `packages/core/src/config.ts` uses `session_ttl_seconds` (default 28800 = 8 hours). Do not set `session_ttl_minutes`; it will be silently ignored and sessions will expire at the default.
41. **Config-only changes need container restart, not rebuild**: `config.yaml` and `.env` are volume-mounted into the container, not baked into the image. After editing either file, restart the container (`podman restart aicr`); a full image rebuild is only needed for code changes.

## Default verification order

1. `node node_modules/eslint/bin/eslint.js .` (or `pnpm lint` on Linux)
2. `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false` (or `pnpm typecheck`)
3. `node node_modules/vitest/vitest.mjs run` (or `pnpm test`)
4. `node node_modules/markdownlint-cli2/markdownlint-cli2.mjs "**/*.md" "!**/node_modules/**" "!**/dist/**" "!**/coverage/**"` (or `pnpm markdownlint`)
5. Build step (if applicable)

## Referenced prompt files

- `docs/ai/AGENTS.repository-baseline.md`

## Relevant skills

- `.agents/skills/agent-behavior-guardrails/SKILL.md`
- `.agents/skills/repository-baseline-validation/SKILL.md`
- `.agents/skills/workspace-scaffold-maintenance/SKILL.md`
- `.agents/skills/ai-agent-maintenance/SKILL.md`
- `.agents/skills/plan-implementation-audit/SKILL.md`
- `.agents/skills/agent-runtime-integration/SKILL.md`
- `.agents/skills/output-channel-contracts/SKILL.md`
- `.agents/skills/remote-deployment/SKILL.md`
