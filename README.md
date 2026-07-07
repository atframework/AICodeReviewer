<div align="center">

<img src="docs/site/public/favicon.svg" alt="AICodeReviewer logo" width="112" height="112" />

# AICodeReviewer

<p><strong>Self-hosted AI code review orchestration service</strong></p>

<p><em>Multi-VCS · bring-your-own-agent · structured findings · single container</em></p>

[![CI](https://github.com/atframework/AICodeReviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/atframework/AICodeReviewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Deploy](https://img.shields.io/badge/Deploy-Docker%20%7C%20Podman-2496ED?logo=docker&logoColor=white)](https://aicr.atframe.work/en/deployment/docker/)
[![Docs](https://img.shields.io/badge/Docs-aicr.atframe.work-2f6bff)](https://aicr.atframe.work/en/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://aicr.atframe.work/en/development/)

[Documentation](https://aicr.atframe.work/en/) ·
[Quick Start](https://aicr.atframe.work/en/start/quick-start/) ·
[Configuration](https://aicr.atframe.work/en/configuration/overview/) ·
[Integrations](https://aicr.atframe.work/en/integrations/vcs-providers/) ·
[中文文档](https://aicr.atframe.work/zh-cn/)

</div>

---

## What is AICodeReviewer?

AICodeReviewer (AICR) is a self-hosted service that orchestrates AI code
review across multiple version-control systems. It normalizes webhooks and
triggers into a single review pipeline, runs the agent CLI of your choice
inside a locked-down sandbox, and routes structured findings back to
pull-request comments, managed issues, or IM bots.

## Key Features

- **Multi-VCS support** — GitHub, Gitea, Forgejo, and GitLab via webhooks;
  Perforce (P4) and Subversion (SVN) via trigger endpoints. All normalized
  into one `ReviewEvent`.
- **Bring your own agent** — Kilo Code, Claude Code, opencode, Zoo Code, and
  Copilot CLI share one runtime contract. AICR translates your `ModelSpec`
  into each tool's native fields and records capability downgrades in the run
  manifest.
- **Structured reports** — Agents emit findings through a small, stable MCP
  tool set. The same problem renders cleanly as a PR line comment, a managed
  issue, or an IM summary card.
- **Secrets scrubbing** — Credentials are stripped from prompts, logs, and
  output boundaries; logging never prints `.env` or config secrets.
- **Safe sandbox** — Scoped VCS fetch (only changed files), read-only source
  mounts, allowlisted sandbox commands, whole-process-tree timeout cleanup,
  and `--init` zombie reaping in the service container.
- **Observability** — Built-in dashboard with per-project stats, LLM cost
  tracking, and `/metrics` endpoint for Prometheus scraping.

## How it works

```text
┌──────────┐    webhook/trigger    ┌──────────────┐
│ GitHub   │ ────────────────────► │              │
│ Gitea    │                       │  AICR Server │
│ GitLab   │                       │              │
│ P4 / SVN │                       │  ┌─────────┐ │
└──────────┘                       │  │ Queue   │ │
                                   │  └────┬────┘ │
                                   │       │      │
                                   │  ┌────▼────┐ │
                                   │  │ Sandbox │ │
                                   │  │ (docker │ │
                                   │  │  podman)│ │
                                   │  └────┬────┘ │
                                   │       │      │
                                   └───────┼──────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
             ┌──────────┐          ┌──────────┐          ┌──────────┐
             │ PR       │          │ Managed  │          │ IM Bot   │
             │ Comments │          │ Issues   │          │ Feishu / │
             │ & Review │          │          │          │ WeCom    │
             └──────────┘          └──────────┘          └──────────┘
```

1. A webhook or trigger arrives → validated, normalized to `ReviewEvent`.
2. VCS adapter fetches the changed files (scoped, not full clone).
3. The selected agent runs inside a Docker/Podman sandbox with the diff and
   AI instructions.
4. Agent reports problems through MCP tools; the orchestrator flushes
   structured results to configured output channels.

## Review output standards

Every finding follows one contract, so reports stay consistent regardless of
which agent produced them or which channel renders them. A problem always
carries a **severity**, a **category**, a **file path**, a **line range**, and a
human-readable **message** (plus an optional fix suggestion).

| Severity | Meaning |
|----------|---------|
| `critical` | Must fix before merge — data loss, security breach, crash, or corruption |
| `high` | Likely bug or vulnerability with real impact under realistic conditions |
| `medium` | Correctness, contract, or performance risk worth addressing |
| `low` | Minor issue or smell; safe to defer |
| `info` | Advisory note or observation, no action required |

Categories group findings into stable families such as `correctness`,
`security`, `performance`, `api-contract`, and `style`. Findings render as
proper Markdown — IM bots receive real tables and code blocks, never raw agent
stdout. See [MCP tools](https://aicr.atframe.work/en/integrations/mcp-tools/)
for the full report contract.

## Quick Start

**Prerequisites:** Node.js ≥20, pnpm 10

```bash
git clone https://github.com/atframework/AICodeReviewer.git
cd AICodeReviewer
pnpm install
pnpm build
```

For Docker deployment:

```bash
cp example/config.yaml ./
# edit config.yaml with your LLM provider and VCS settings
docker build -t aicr -f deploy/Dockerfile .
docker run -d --init --name aicr -p 8090:8090 \
  -v $(pwd)/config.yaml:/app/config.yaml:ro \
  -v $(pwd)/data/workspaces:/app/data/workspaces \
  -v $(pwd)/data/db:/app/data/db \
  aicr
```

See the full [Quick Start guide](https://aicr.atframe.work/en/start/quick-start/)
for local Node.js, Docker Compose, and your first review walkthrough.

## Documentation

Full documentation is available at **[aicr.atframe.work](https://aicr.atframe.work/en/)**:

| Section | Topics |
|---------|--------|
| [Getting Started](https://aicr.atframe.work/en/start/quick-start/) | Quick start, Docker Compose, first webhook, dry-run, dashboard |
| [Configuration](https://aicr.atframe.work/en/configuration/overview/) | LLM, agent, sandbox, outputs, storage, queue |
| [Integrations](https://aicr.atframe.work/en/integrations/vcs-providers/) | VCS providers, agent adapters, output channels, IM bots, MCP tools |
| [Deployment](https://aicr.atframe.work/en/deployment/docker/) | Docker, Podman, operations & security |
| [Reference](https://aicr.atframe.work/en/reference/cli/) | CLI commands, config fields, template variables |

[中文文档](https://aicr.atframe.work/zh-cn/) also available.

## Repository Structure

| Package | Description |
|---------|-------------|
| `packages/core` | Shared config schemas, utilities, logging, token estimation |
| `packages/llm` | LLM gateway, provider routing, model catalog, compression |
| `packages/agents` | Agent CLI adapter layer (Kilo, opencode, Zoo, Claude Code, Copilot CLI) |
| `packages/sandbox` | Agent execution sandbox (native, docker, podman) |
| `packages/vcs` | VCS adapters (Git, Gitea, GitHub, GitLab, P4, SVN) |
| `packages/outputs` | Output rendering (PR comments, IM cards, problem issues) |
| `packages/mcp-output` | MCP server exposing AICR tools to agents |
| `packages/store` | SQLite/Postgres storage and observability schema |
| `packages/server` | HTTP server, webhook endpoints, trigger handling |
| `packages/cli` | CLI entry point (`aicr` binary) |
| `packages/eval` | Benchmark/evaluation fixture validation |
| `docs/site` | Documentation site (Astro Starlight, bilingual) |

## Security

- Secrets are scrubbed from prompts, logs, and every output boundary; logging
  never prints `.env` or config values.
- The sandbox uses scoped VCS fetch (only changed files), read-only source
  mounts, an allowlist of sandbox commands, and hard timeouts with
  whole-process-tree cleanup.
- Reviews are guided to reason about common vulnerability classes, including the
  OWASP Top 10.

Please report suspected vulnerabilities privately to the maintainers (for
example via GitHub Security Advisories) rather than opening a public issue.

## Contributing

Contributions are welcome. See the [Development guide](https://aicr.atframe.work/en/development/) for repository layout, setup, testing instructions, and how to add a package, config field, output channel, or agent adapter.

## License

[MIT](LICENSE) © 2025-2026 AICodeReviewer Contributors
