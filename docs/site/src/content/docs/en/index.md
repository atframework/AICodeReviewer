---
title: AICodeReviewer
description: Self-hosted AI code review orchestration service for GitHub, Gitea/Forgejo, GitLab, Perforce, and Subversion.
template: splash
---

import { Card, CardGrid, LinkCard } from '@astrojs/starlight/components';

**AICodeReviewer (AICR)** is a self-hosted service that orchestrates AI code
review across your version-control systems. It normalizes webhooks and triggers
into a single review pipeline, runs the agent CLI of your choice inside a
locked-down sandbox, and routes structured findings back to pull-request
comments, managed issues, or IM bots — never as free-form agent stdout.

## How it works

1. **A webhook or trigger arrives** from your VCS (push, PR, manual command).
   AICR validates the request against your configured HMAC secret or API key.
2. **VCS adapter fetches changes.** Only the changed files are pulled — scoped
   fetch, not a full clone. For PRs the merge base diff is computed; for P4 and
   SVN the changelist or revision diff.
3. **Diff compression** kicks in when the change set is too large for the
   model's context window. AICR keeps the most relevant hunks and trims the
   rest.
4. **The agent runs in a sandbox.** Your chosen agent CLI (Kilo Code, Claude
   Code, etc.) executes inside a Docker or Podman container with the diff, your
   AI instructions, and the stable MCP tool set. The sandbox has read-only
   source mounts, allowlisted commands, and a hard timeout with whole-tree
   cleanup.
5. **Structured findings are routed.** Problems become PR line comments (with
   code context), managed issues (with lifecycle tracking and auto-close on
   fix), or IM summary cards (Feishu/WeCom with proper rendering). The same
   `aicr.report_problem` call drives all three.

## Key features

- **One pipeline, many VCS.** GitHub, Gitea, Forgejo, and GitLab arrive over
  webhooks; Perforce (P4) and Subversion (SVN) arrive over trigger endpoints.
  All are normalized into one `ReviewEvent`.
- **Bring your own agent.** Kilo Code, Claude Code, opencode, Zoo Code, and
  Copilot CLI share one runtime contract. AICR translates `ModelSpec` into each
  tool's native fields and records capability downgrades in the run manifest
  instead of silently dropping them.
- **AICR owns the report contract.** Agents emit findings through a small,
  stable MCP tool set (`aicr.report_problem`, `aicr.publish_summary`,
  `aicr.skip`, `aicr.fetch_more_context`, `aicr.try_blame`). The same problem
  renders cleanly as a PR line comment, a managed issue, or an IM summary card.
- **Safe by default.** Scoped VCS fetch (only changed files), read-only source
  mounts, allowlisted sandbox commands, secret scrubbing at every boundary,
  whole-process-tree timeout cleanup, and `--init` zombie reaping in the
  service container.
- **Context-aware compression.** Large diffs are automatically compressed before
  hitting the model's context window. Per-model override thresholds let you tune
  compression per provider without changing the review pipeline.
- **Managed problem lifecycle.** Problems are tracked across runs with stable
  fingerprints. When a file is re-reviewed and a problem is gone, its managed
  issue is auto-closed. Resolution is guarded by file-scope — a review that
  doesn't touch a file won't falsely close its issues.
- **Built-in observability.** Dashboard with per-project stats, per-run token
  estimates and cost breakdown, provider-level LLM usage tracking, daily
  rollups, and a `/metrics` endpoint for Prometheus scraping.
- **Retry and fallback.** Queue-level retry with exponential backoff. LLM
  fallback chains route to the next provider when the primary fails or throttles.
  Dead-letter queues capture persistently failing runs for later inspection.

## Start here

<CardGrid stagger>
  <Card title="Quick start" icon="rocket">
    Run AICodeReviewer locally or with Docker Compose and trigger your first
    review in minutes.
  </Card>
  <Card title="Authentication & secrets" icon="key">
    The three-layer model: webhook HMAC, server API key, and per-workspace key.
    What goes in `.env` vs `config.yaml`.
  </Card>
  <Card title="Output channels" icon="comment">
    The MCP report tools, the supported channel kinds, and how routing works.
  </Card>
  <Card title="Deploy to production" icon="seti:docker">
    Single-container Docker or Podman, reverse-proxy TLS, persistent volumes.
  </Card>
  <Card title="LLM providers & models" icon="puzzle">
    Configure OpenAI-compatible providers, model catalogs, retry strategies,
    and per-run budget caps.
  </Card>
  <Card title="Agent & sandbox" icon="terminal">
    Choose your agent CLI, set timeouts, enable auto-compaction, and lock down
    the execution sandbox.
  </Card>
</CardGrid>

## Supported integrations

| Surface | Options |
| --- | --- |
| VCS providers | GitHub, Gitea, Forgejo, GitLab (webhooks); Perforce (P4), Subversion (SVN) (triggers) |
| Agent CLIs | Kilo Code, Claude Code, opencode, Zoo Code, Copilot CLI |
| Output channels | PR/MR line comments & summary, managed problem issues, Feishu bot, WeCom bot |
| Sandboxes | native, docker, podman, docker_socket (`k8s_pod`, `firecracker` reserved) |
| Model providers | Any OpenAI-compatible API; models.dev catalog for context window and pricing metadata |

## Design principles

- **Minimal assumptions.** AICR normalizes VCS inputs but doesn't guess your
  workflow. Every behavior — skip policies, output routing, label management,
  commit strategies — is configurable.
- **Honest downgrades.** When an agent adapter or model doesn't support a
  feature (e.g., structured output, reasoning), it's recorded in the run
  manifest. Nothing is silently dropped.
- **Single container.** The entire service — HTTP server, queue worker, agent
  orchestrator, dashboard, and SQLite database — runs in one process. Deploy
  with `docker run` or `podman run`; scale by adding workers behind a shared
  database.
- **Readable output.** Every problem includes a severity, category, file path,
  line range, and human-readable message. IM bots receive properly rendered
  Markdown tables and code blocks. No raw agent stdout makes it into a user-
  facing notification.

## Recommended path

The fastest path to production is a single Docker or Podman container behind a
reverse proxy, fed by a GitHub or Gitea webhook. See
[Quick start](/en/start/quick-start/) to begin.

If you are evaluating or contributing, the [local Node.js quick
start](/en/start/quick-start/#local-node-js) needs only `pnpm install` and
`pnpm build`.
