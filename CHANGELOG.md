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

### Changed

- **M5**: `Plan.md` current execution package updated to reflect actual delivery status (runtime bundle, MCP config injection, agent repair, MCP state file reading marked delivered).
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
