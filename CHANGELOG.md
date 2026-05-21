# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **M8**: `@aicr/eval` package with minimal evaluation framework (`runEval`, `EvalExample`, message-pattern matching).
- **M8**: OTel OTLP HTTP trace exporter configuration in `@aicr/core` (`createOtelSdk` reads `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS`).
- **M8**: Prometheus metrics endpoint (`/metrics`) with counters (`aicr_reviews_total`, `aicr_reviews_skipped_total`, `aicr_reviews_failed_total`, `aicr_problems_total`) and histogram (`aicr_review_duration_seconds`).
- **M8**: Run snapshot persistence to `runs/<run_id>/run.json` via `saveRunSnapshot`, configurable through `ServerAppOptions.runsDir`.
- **M9**: `docker_socket` factory test confirming it maps to the docker backend implementation.
- **M9**: `k8s_pod` and `firecracker` sandbox backend skeletons with descriptive error messages.
- **Docs**: Podman rootless `invalid internal status` troubleshooting guide in `docs/podman.md`.
- **Docs**: Test environment isolation guidelines in `development/README.md`.
- **M9**: Sandbox backend capability matrix documented in `docs/ai/architecture.md` §3.8.1 (`native`, `docker`, `podman`, `docker_socket`, `k8s_pod`, `firecracker`).
- **M9**: `docker_socket` configuration example added to `example/README.md`.
- **M9**: Release checklist created at `docs/ai/milestones/M9-checklist.md`.
- **M5**: Kilo Code end-to-end acceptance verified via production log analysis (agent sandbox execution, MCP state file read, stdout stream parsing, structured output conversion all confirmed working).
- **M6**: GitHub production e2e verified (`github-atframework` / `github-owent` triggers running, auto-created issues and PR analysis records confirmed).
- **M8**: OTel SDK now wired into `aicr serve` command; starts automatically when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **M8**: `aicr eval` CLI command added — runs evaluation benchmarks from `eval/` directory JSON fixtures against configured LLM, outputs structured pass/fail summary.
- **M8**: Baseline eval fixture `eval/baseline-sql-injection.json` added as a seed test case.
- **M8**: Eval fixtures expanded to 6 total covering security (SQL injection, hardcoded secrets), correctness (null dereference, silenced errors), style (naming convention), and performance (N+1 query pattern).
- **M7**: `review.output_language` now injected into the review task context as `Output language: <lang>` directive when set to a non-English value (`packages/server/src/review-orchestrator.ts`, `packages/server/src/bootstrap.ts`).
- **M7**: Barrel export tests added for `@aicr/core`, `@aicr/cli`, `@aicr/server`, `@aicr/llm`, `@aicr/vcs`, `@aicr/outputs`, `@aicr/mcp-output`, `@aicr/store` (each package now has `test/index.test.ts` verifying exports per AGENTS.md pitfall #10).
- **M9**: `deploy/deploy.sh` now includes `--storage-driver=overlay` on all `podman` commands and a preflight `podman system migrate` check (addresses rootless Podman 5.x storage corruption).
- **M9**: `.dockerignore` added to reduce Docker build context size.
- **M9**: `deploy.sh` converted to use environment-variable overrides (`AICR_DEPLOY_DIR`, `AICR_IMAGE_NAME`, `AICR_HOST_PORT`, `AICR_CONTAINER_NAME`, `AICR_ENGINE`) instead of hardcoded paths.
- **M9**: `deploy/Caddyfile.example` added as a sample reverse proxy configuration for TLS termination.
- **M9**: `deploy/Dockerfile` now copies `sandbox` and `eval` node_modules for forward compatibility.
- **Docs**: `example/README.md` P4 authentication table row corrected — P4 uses server API key, not webhook HMAC.
- **Docs**: `example/.env.sample` updated with missing env vars (`AICR_WORKSPACE_API_KEY`, GitHub multi-profile, Feishu issue notification).
- **Docs**: `example/config.yaml` queue section updated with commented `rate_limit`, `retry`, `dead_letter` examples.
- **Docs**: `.agents/skills/remote-deployment/SKILL.md` env var names aligned with `example/.env.sample`.

### Changed

- **M5**: `Plan.md` current execution package updated to reflect actual delivery status (runtime bundle, MCP config injection, agent repair, MCP state file reading marked delivered).
- **Plan**: `Plan.md` milestone table updated: M5→基本完成, M6→部分完成 (GitHub e2e 验收, GitLab/SVN→Backlog), M8→大部分完成 (OTel 接入, eval CLI 添加), M9→进行中. Low-priority items moved to explicit Backlog section.
- **Docs**: `Note.md` moved to `development/README.md`; all references updated across skills and docs.
- **Skill**: `.agents/skills/remote-deployment/SKILL.md` stripped of hardcoded deployment targets (IP, ports, directories, domains); values replaced with placeholders. Concrete environment info lives in `development/README.md`.

### Fixed

- **M8**: Prometheus review duration histogram now keeps cumulative bucket/sum/count values while bounding only the raw duration sample buffer.
- **M8**: Inline webhook review processing now records metrics and persists run snapshots consistently with async processing.
- **M9**: Podman `invalid internal status` root cause identified and fixed on production server (`podman --storage-driver=overlay system migrate`).
- **M8**: `EvalUnexpectedProblem` missing `category` field in eval package interface.
- **M8**: Eval `runEval` missing/unexpected problem matching now symmetrically checks `file + line + severity + category + messagePattern`.
- **M8**: Eval `messagePattern` interface field now actually used in matching logic (RegExp and string support).

## [0.1.0] - 2024-12-08

### Added

- Initial AICR monorepo with workspace packages: `@aicr/core`, `@aicr/cli`, `@aicr/server`, `@aicr/llm`, `@aicr/vcs`, `@aicr/outputs`, `@aicr/sandbox`, `@aicr/agents`, `@aicr/store`, `@aicr/mcp-output`, `@aicr/eval`.
- Review orchestration pipeline: VCS adapter → prompt preparation → LLM gateway → output collector → publisher dispatch.
- Multi-provider LLM gateway with bounded retry, fallback chain, and budget controls.
- VCS adapters: Git, Perforce (P4), Gitea webhook.
- Output channels: Gitea PR review, GitHub PR review, GitLab MR review, Gitea/GitHub problem issues, Feishu/WeCom IM bots.
- Agent runtime bundle with Kilo Code adapter and native MCP tool manifest.
- Sandbox backends: native, docker, podman.
- Config schema with Zod validation, workspace instances, and channel routing.
- Review deduplication and async queue support (in-memory, Redis).
- Structured logging with pino and secret scrubber.

[Unreleased]: https://github.com/atframework/AICodeReviewer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/atframework/AICodeReviewer/releases/tag/v0.1.0
