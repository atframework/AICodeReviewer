---
title: Configuration Overview
description: How AICodeReviewer configuration is organized into namespaces and layered from global defaults down to per-workspace overrides.
---

AICodeReviewer is configured through a single `config.yaml` file plus a `.env`
file for secrets. This page is the map: it lists every top-level namespace,
explains how settings cascade from global defaults down to a single workspace,
and states the one rule you must not break — **never put a secret value inside
`config.yaml`**.

Each namespace has its own dedicated page with the full field reference. Use
the table below as a jumping-off point.

## Top-level namespaces

| Namespace | What it controls | Detail page |
| --- | --- | --- |
| `llm` | Providers, fallback chain, retry/backoff, spend budget, and the models.dev metadata catalog. | [LLM Providers and Models](/en/configuration/llm/) |
| `triggers` | One entry per VCS source (Gitea, GitHub, GitLab, P4, SVN) — inbound webhook/HMAC verification and outbound tokens. | [Authentication & secrets](/en/configuration/authentication/) |
| `workspaces` | The repositories you review: source bindings, per-workspace overrides, and the clone cache. | this page |
| `outputs` | Output channels (PR reviews, IM bots, managed issues), routing rules, and the zero-problem policy. | [Output Channels and Routing](/en/configuration/outputs/) |
| `agent` | The agent CLI to drive, the per-run timeout, context auto-compaction, and the sandbox backend. | [Agent and Sandbox](/en/configuration/agent/) |
| `review` | File filters, label management, the managed-problem-issue lifecycle cap, and reflection memory. | this page |
| `queue` | In-memory or durable SQLite queue, worker concurrency, rate limits, and retry/dead-letter policy. | [Queue and Retry](/en/configuration/queue/) |
| `storage` | Database, cache, and object-store backends for observability, the model catalog, and future features. | [Storage](/en/configuration/storage/) |
| `compression` | AICR-side diff summarization that runs before the model sees a large task. | [LLM Providers and Models](/en/configuration/llm/) (context dependency) |
| `server` | HTTP listener and global API-key auth for `/triggers/*`. | [Authentication & secrets](/en/configuration/authentication/) |
| `admin` | Optional observability-dashboard super-admin login (separate from webhook/trigger auth). | [Authentication & secrets](/en/configuration/authentication/) |

:::note[A minimal config]
Only `llm`, at least one `triggers[]` entry, and at least one
`workspaces.instances.<id>` are required to review anything. Everything else
ships with sensible defaults so the sample `example/config.yaml` runs as-is once
you fill in your LLM key.
:::

## The three-layer override model

Settings that affect a review resolve in three layers, each one more specific
than the last. A value set at a lower layer always wins.

```text
global (config root)  →  workspaces.defaults  →  workspaces.instances.<id>
```

1. **Global** — top-level keys such as `review`, `outputs.no_problems`,
   `agent`, `compression`. These are the fallback for every workspace.
2. **Workspace defaults** — `workspaces.defaults.{review,outputs,agent,prompt,sandbox}`
   apply to all instances but can still be overridden per instance. Use this
   layer to share a policy across many repos.
3. **Workspace instance** — `workspaces.instances.<id>` is the most specific
   layer. Anything set here wins. `workspace_id` must not collide with the
   reserved root keys `cache`, `defaults`, or `instances`.

The override is **deep-merged per section**, not all-or-nothing. For example,
setting `outputs.no_problems` in an instance does not wipe the instance's
`outputs.summary` list — only the field you set is replaced.

```yaml
# global default — keep notification channels quiet
outputs:
  no_problems: { action: suppress }

workspaces:
  defaults:
    outputs:
      no_problems: { action: suppress }

  instances:
    critical-service:
      source_repo: { trigger: gitea, repo: "my-org/critical-service" }
      outputs:
        summary: [feishu-code-review]
        # per-workspace + per-channel override: this repo wants an audit trail
        channel_overrides:
          feishu-code-review:
            no_problems: { action: publish }
      # per-workspace review override (deep-merged with global review)
      review:
        problem_issue:
          max_recent_issues: 10
```

Not every section is overridable at every layer. The table below lists the
sections each layer accepts.

| Section | Global | `workspaces.defaults` | `workspaces.instances.<id>` |
| --- | :---: | :---: | :---: |
| `review` | ✓ | ✓ | ✓ |
| `outputs` (channel lists, `no_problems`, `channel_overrides`) | ✓ | ✓ | ✓ |
| `agent.default` | ✓ | ✓ | ✓ |
| `sandbox` | via `agent.sandbox` | ✓ | ✓ |
| `prompt` (base system prompt, `force_skills`) | — | ✓ | ✓ |
| `auth` (per-workspace API key) | via `server.auth` | — | ✓ |
| `compression`, `queue`, `storage`, `llm`, `server`, `admin`, `triggers` | ✓ | — | — |

## `.env` vs `config.yaml` — secrets convention

`config.yaml` is meant to be checked into source control, so it must never
contain a raw secret. Instead, every secret-bearing field takes the **name of
an environment variable**, and AICR reads the value from the environment at
startup.

```yaml
# config.yaml — stores the NAME of the env var, never the value
llm:
  providers:
    - id: my-llm
      kind: openai_compatible
      api_key_env: AICR_LLM_API_KEY   # reads $AICR_LLM_API_KEY
```

```bash
# .env (or your orchestrator's secret store) — stores the actual value
AICR_LLM_API_KEY=sk-xxxxxxxxxxxxxxxx
```

The naming convention is consistent across the whole config:

| Field suffix | Meaning | Example |
| --- | --- | --- |
| `*_env` | Name of an env var holding a secret (key, token, URL). | `api_key_env`, `webhook_secret_env`, `url_env` |
| `*_url_env` | Name of an env var holding a URL. | `endpoint_url_env`, `webhook_url_env` |

Keep these rules in mind:

- The `*_env` field is a **string name**, not the secret itself. Writing
  `api_key_env: sk-xxx` will look up an env var literally named `sk-xxx` and
  fail.
- If a secret field is omitted, the corresponding feature is disabled or runs
  unauthenticated (e.g. webhook HMAC verification is skipped — not recommended
  in production).
- Generate strong values with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

See [Authentication & secrets](/en/configuration/authentication/) for
how the three independent auth layers (webhook HMAC, server API key, workspace
API key) combine.

## Where to go next

- New to the project? Read [LLM Providers and Models](/en/configuration/llm/)
  first — without a provider and fallback chain nothing runs.
- Going to production? Configure a durable queue
  ([Queue and Retry](/en/configuration/queue/)), storage
  ([Storage](/en/configuration/storage/)), and the agent
  sandbox ([Agent and Sandbox](/en/configuration/agent/)).
- Tuning output behavior? See
  [Output Channels and Routing](/en/configuration/outputs/) for channels,
  routing, the zero-problem policy, and managed-issue lifecycle limits.
