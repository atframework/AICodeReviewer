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
  timeout_seconds: 600
  auto_approve: true
  context_compaction:
    auto: true
    prune: true
  web_search:
    enabled: false
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
| `pi` | pi (`@earendil-works/pi-coding-agent`) adapter. Requires catalog-supplied `context_window` / `max_output_tokens`. |
| `oh-my-pi` | oh-my-pi (`omp`, pi fork) adapter. Same model-metadata requirements as `pi`. |

:::note[Stick with the default]
`kilo` is the validated default. Switch to another `AgentKind` only when you are
explicitly validating that adapter. The `pi` and `oh-my-pi` adapters support the
provider kinds `openai_compatible`, `ollama`, `anthropic`, and
`google_ai_studio`, and both require the model's context window and output-token
limit — enable `llm.model_catalog` (or set overrides) before using them. The
runtime image built from `deploy/Dockerfile` ships pinned Kilo and `omp` CLIs,
which covers the native sandbox inside that image; any other sandbox image needs
the matching CLI preinstalled (the binaries are on the sandbox command allowlist
by default).
:::

The schema also accepts `agent.default` at the `workspaces.defaults.agent.default`
and `workspaces.instances.<id>.agent.default` layers, but the current version
builds a single adapter from the global value at startup — workspace-layer values
are parsed but have no effect.

## `agent.timeout_seconds` — hard per-run cap

```yaml
agent:
  timeout_seconds: 600   # the default; lower it for small-PR environments
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

The current orchestrator always behaves as if this were `true`: the schema
accepts the field, but setting `false` has no effect. It is reserved for a
future step-by-step approval debugging mode.

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
| opencode | `compaction.{auto,prune}` in `opencode.json` (working-directory root, discovered through sandbox cwd/`--dir`). |
| Zoo | `autoCondenseContext` / `condenseContextPercentThreshold` in `.roo/settings.json`. |
| Claude Code | Auto-compacts by default (delegated; no config injected). |
| Copilot CLI | Not applicable (no context-management surface). |
| pi | `compaction.enabled` in `settings.json` (pi has no threshold/prune fields; those stay delegated to pi defaults). |
| oh-my-pi | `compaction.enabled` plus `compaction.thresholdPercent` in `config.yml`. |

:::caution[Kilo needs a known context window]
Kilo only auto-compacts when the model's `contextWindow` is known, so
`threshold_percent` has something to measure against. Either:

- enable `llm.model_catalog` so the window is resolved from models.dev, **or**
- set `context_window` (and ideally `max_output_tokens`) in
  `llm.model_catalog.overrides` for the model.

Without a known window, Kilo compaction silently stays inactive. See
[LLM Providers and Models](/en/configuration/llm/) for the catalog and override
fields.
:::

## `agent.web_search` — agent web search control

omp ships a built-in `web_search` tool and enables it by default; kilo,
opencode, claude-code, and copilot-cli likewise ship built-in search tools that
auto-approval leaves reachable. AICR always materializes the explicit switch
(the section defaults to `false`), so reviews stay hermetic unless an operator
opts in. Enabling it lets the agent send review-context queries — code
snippets, symbols, error text — to the configured search engines, which makes
this a data-governance decision, not just a feature toggle.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | bool | `false` | Materialize the agent-native allow/deny switch; omp itself defaults `web_search.enabled` to `true`. |
| `providers` | string array | `[]` | omp uses the full ordered chain; kilo accepts only `exa`; opencode selects the first `exa`/`parallel` entry. |
| `exclude` | string array | `[]` | Provider ids removed from the chain → `providers.webSearchExclude`. |
| `timeout_seconds` | int (1–300) | – | Per-provider transport timeout → `providers.webSearchTimeoutSeconds` (omp default 60). |
| `credentials.<provider>` | string | – | Env var name holding that provider's credential on the AICR host; only enabled adapters inject the native env var via a `${VAR}` reference. |
| `searxng.endpoint` | string | – | Self-hosted SearXNG endpoint (keeps queries inside your network). |
| `searxng.categories` / `searxng.engines` / `searxng.language` | string | – | Optional SearXNG result filters. |
| `searxng.safesearch` | int (0–2) | – | SearXNG safe-search level. |

```yaml
agent:
  web_search:
    enabled: true
    providers: ["tavily", "duckduckgo"]
    exclude: ["google", "ecosia", "mojeek"]   # browser-backed scrapers
    timeout_seconds: 30
    credentials:
      tavily: AICR_SEARCH_TAVILY_KEY           # -> TAVILY_API_KEY=${AICR_SEARCH_TAVILY_KEY}
      searxng_basic_username: AICR_SEARCH_SEARXNG_USERNAME
      searxng_basic_password: AICR_SEARCH_SEARXNG_PASSWORD
    searxng:
      endpoint: https://searxng.internal:8080
      language: en
```

The `credentials` keys are limited to providers with a verified
omp-native env var: `tavily`, `brave`, `exa`, `jina`, `kagi`, `parallel`,
`kimi`, `perplexity`, `zai`, `xai`, `anthropic` (search-only key, independent
of the chat key), `tinyfish`, `firecrawl`, `searxng_token`,
`searxng_basic_username`, and `searxng_basic_password`. OAuth-stored
providers (gemini/codex/perplexity OAuth) cannot authenticate inside the
ephemeral per-run agent directory and are unsupported.

Credential-free scrapers (`duckduckgo`, `startpage`) work without keys;
browser-backed ones (`google`, `ecosia`, `mojeek`) attempt a Chromium download
on first use, which fails in locked-down containers and burns provider timeout —
prefer excluding them.

### Per-agent mapping

oh-my-pi has the richest surface; the other agents map what their CLI exposes
and ignore the rest with a startup warning plus a manifest audit entry:

| Agent | Switch | Providers / credentials | Manifest mode |
| --- | --- | --- | --- |
| oh-my-pi | `web_search.enabled` in `config.yml` | Full provider chain, 16 credential env names, SearXNG | `injected` |
| kilo | `permission.websearch: allow/deny` in `kilo.json` + `KILO_ENABLE_EXA` activation env | Exa only (`credentials.exa` → `EXA_API_KEY`) | `injected` |
| opencode | `permission.websearch` in `opencode.json` + activation and `OPENCODE_WEBSEARCH_PROVIDER` env | First listed Exa or Parallel provider; only its credential is injected | `injected` |
| claude-code | `--disallowedTools WebSearch` when disabled | None (Anthropic-owned backend) | `delegated` |
| copilot-cli | `--excluded-tools=web_search,web_fetch` when disabled | None (Copilot subscription backend) | `delegated` |
| zoo / pi | — | No built-in search tool | `not_applicable` |

kilo, claude-code, and copilot-cli run with auto-approval, so their built-in
search tools are otherwise reachable by default; the explicit deny switch is
what keeps reviews hermetic. A single global `agent.web_search` block can serve
mixed workspaces — unsupported provider ids and fields are skipped with a
warning instead of failing the run. Disabled runs receive no search credential
env vars.

Independent of web search, kilo reviews never read the developer's global kilo
state: AICR redirects `XDG_CONFIG_HOME`/`XDG_DATA_HOME` into the per-run bundle,
so an unrecognized key in a host `~/.config/kilo` config or a stale session
database from another kilo version cannot break a run.

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

The schema also accepts `sandbox` at the `workspaces.defaults` and
`workspaces.instances.<id>` layers, but like `agent.default` the runtime
currently uses only the global `agent.sandbox` — workspace-layer values have no
effect (see the override table on the
[Configuration Overview](/en/configuration/overview/) page).
