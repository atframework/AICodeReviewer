---
title: AICodeReviewer
description: Self-hosted AI code review orchestration service for GitHub, Gitea/Forgejo, GitLab, Perforce, and Subversion.
template: splash
---

import { Card, CardGrid } from '@astrojs/starlight/components';

**AICodeReviewer (AICR)** is a self-hosted service that orchestrates AI code
review across your version-control systems. It normalizes webhooks and triggers
into a single review pipeline, runs the agent CLI of your choice inside a
locked-down sandbox, and routes structured findings back to pull-request
comments, managed issues, or IM bots — never as free-form agent stdout.

## Why AICR

- **One pipeline, many VCS.** GitHub, Gitea/Forgejo, and GitLab arrive over
  webhooks; Perforce (P4) and Subversion (SVN) arrive over trigger endpoints.
  All are normalized into one `ReviewEvent`.
- **Bring your own agent.** Kilo Code, Claude Code, opencode, Zoo Code, and
  Copilot CLI share one runtime contract. AICR translates your `ModelSpec` into
  each tool's native fields and records capability downgrades in the run
  manifest instead of silently dropping them.
- **AICR owns the report contract.** Agents emit findings through a small,
  stable MCP tool set (`aicr.report_problem`, `aicr.publish_summary`,
  `aicr.skip`, `aicr.fetch_more_context`, `aicr.try_blame`). The same problem
  renders cleanly as a PR line comment, a managed issue, or an IM summary card.
- **Safe by default.** Scoped VCS fetch (only changed files), read-only source
  mounts, allowlisted sandbox commands, secret scrubbing at every boundary,
  whole-process-tree timeout cleanup, and `--init` zombie reaping in the
  service container.

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
</CardGrid>

## Supported integrations

| Surface | Options |
| --- | --- |
| VCS providers | GitHub, Gitea, Forgejo, GitLab (webhooks); Perforce (P4), Subversion (SVN) (triggers) |
| Agent CLIs | Kilo Code, Claude Code, opencode, Zoo Code, Copilot CLI, native LLM |
| Output channels | PR/MR line comments & summary, managed problem issues, Feishu bot, WeCom bot |
| Sandboxes | native, docker, podman, docker_socket (`k8s_pod`, `firecracker` reserved) |

## Recommended path

The fastest path to production is a single Docker or Podman container behind a
reverse proxy, fed by a GitHub or Gitea webhook. See
[Quick start](/en/start/quick-start/) to begin.

If you are evaluating or contributing, the [local Node.js quick
start](/en/start/quick-start/#local-node-js) needs only `pnpm install` and
`pnpm build`.
