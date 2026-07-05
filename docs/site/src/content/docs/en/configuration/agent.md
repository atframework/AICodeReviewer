---
title: Agent and Sandbox
description: Choose the agent CLI, set the per-run timeout, enable context auto-compaction, and pick the sandbox backend.
---

AICodeReviewer drives an external agent CLI (Kilo Code by default) inside a
sandbox. The `agent` namespace picks which CLI to run, sets the hard per-run
timeout, enables context auto-compaction for long reviews, and selects the
sandbox backend that isolates the agent from the host.

```yaml
agent:
  default: kilo
  timeout_seconds: 300
  auto_approve: true
  context_compaction:
    auto: true
    prune: true
  sandbox:
    kind: docker
    engine: auto
```

## `agent.default` — which agent CLI

| Value | Behavior |
| --- | --- |
| `kilo` (default) | Kilo Code. The supported default path. |
| `opencode` | opencode adapter. Set only when validating that adapter. |
| `zoo` | Zoo Code adapter. Set only when validating that adapter. |
| `copilot-cli` | GitHub Copilot CLI adapter. |
| `claude-code` | Claude Code adapter. |

:::note[Stick with the default]
`kilo` is the validated default. Switch to another `AgentKind` only when you are
explicitly validating that adapter.
:::

`agent.default` can also be overridden at the `workspaces.defaults.agent.default`
and `workspaces.instances.<id>.agent.default` layers.

## `agent.timeout_seconds` — hard per-run cap

```yaml
agent:
  timeout_seconds: 300   # production commonly uses 600 for large PRs
```

This is a **hard cap on a single agent pass**. When the timeout fires, the
sandbox kills the **whole process tree** — the agent binary plus every worker
subprocess it spawned, including workers that `setsid` into their own session.
A run therefore cannot overrun by leaving orphaned workers behind.

Two things to keep in mind:

- **The orchestrator may run several passes** (initial review, context-repair,
  direct-LLM fallback), so the wall-clock time of a single review can be a few
  times this value. Set it comfortably above the slowest expected single pass.
- **The "death-spiral" pitfall**: if you set this too low for your typical diff
  size, every pass gets killed mid-work, the orchestrator retries, and you pay
  for partial work that never completes. Raise the value for large PRs rather
  than relying on retries.

## `agent.auto_approve`

```yaml
agent:
  auto_approve: true
```

When `true` (the default), AICodeReviewer auto-approves the agent's proposed
tool actions within the sandboxed review scope. Set to `false` only for
debugging flows where you want to inspect each action.

## `agent.context_compaction` — runtime-side history compaction

Long reviews (large diffs, many tool calls) can exceed the model's context
window before finishing. When enabled, AICodeReviewer injects each agent CLI's
**native** compaction settings so the agent summarizes its own conversation
history before hitting the limit. This **complements** (does not replace) the
top-level `compression` diff-summarization, which runs earlier in the pipeline.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `auto` | bool | `true` | Enable auto-compaction in supported agent runtimes. |
| `threshold_percent` | int (1–100) | – | Compact at this percent of the model context window (Kilo). |
| `prune` | bool | `true` | Prune old tool outputs between turns (Kilo / opencode). |

```yaml
agent:
  context_compaction:
    auto: true
    threshold_percent: 80   # Kilo: compact at 80% of the context window
    prune: true
```

### Per-adapter injection

Each agent CLI receives compaction config in its own format:

| Agent | Where it lands |
| --- | --- |
| Kilo | `compaction.{auto,threshold_percent,prune}` in `kilo.json`. |
| opencode | `compaction.{auto,prune}` in `.opencode/config.json`. |
| Zoo | `autoCondenseContext` / `condenseContextPercentThreshold` in `.roo/settings.json`. |
| Claude Code | Auto-compacts by default (delegated; no config injected). |
| Copilot CLI | Not applicable (no context-management surface). |

:::caution[Kilo needs a known context window]
Kilo only auto-compacts when the model's `contextWindow` is known, so
`threshold_percent` has something to measure against. Either:

- enable `llm.model_catalog` so the window is resolved from models.dev, **or**
- set `context_window` (and ideally `max_output_tokens`) in
  `llm.model_catalog.overrides` for the model.

Without a known window, Kilo compaction silently stays inactive. See
[/en/configuration/llm/](/en/configuration/llm/) for the catalog and override
fields.
:::

## `agent.sandbox` — isolation backend

The sandbox isolates the agent from the host. It only mounts the **scoped
review directories**, keeps the source tree **read-only**, and enforces an
**allowlist** of commands/paths the agent may touch. If the agent needs more
context, it should read mounted files with read-only commands or call
`aicr.fetch_more_context` for a concrete path.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | enum | `docker` | Sandbox kind (see below). |
| `engine` | enum | `auto` | Container engine: `auto`, `docker`, or `podman`. |
| `image` | string | – | Optional explicit sandbox image. |

### `kind` values

| Kind | Status | When to use |
| --- | --- | --- |
| `native` | Available | Run the agent directly on the host (no container). Lowest isolation. |
| `docker` (default) | Available | Run inside a Docker container. Default for most deployments. |
| `podman` | Available | Run inside a Podman container. Preferred with `deploy.sh` + `AICR_ENABLE_CONTAINER_SANDBOX` and a mounted Podman socket. |
| `docker_socket` | Available | Docker-compatible mode for workflows that specifically expect the Docker CLI over a mounted socket. |
| `k8s_pod` | Reserved | Not yet implemented. |
| `firecracker` | Reserved | Not yet implemented. |

### `engine` values

`auto` (default) detects an available engine; `docker` and `podman` force a
specific one. For `deploy.sh` with a mounted Podman socket, prefer
`kind: podman` and `engine: podman`. Docker-compatible mode remains available
when a workflow specifically expects the Docker CLI.

```yaml
agent:
  sandbox:
    kind: podman
    engine: podman
```

`sandbox` is also overridable at the `workspaces.defaults.sandbox` and
`workspaces.instances.<id>.sandbox` layers (note: per-instance `sandbox` is only
available via `workspaces.defaults`, not directly on an instance — see the
override table on the [/en/configuration/overview/](/en/configuration/overview/)
page).
