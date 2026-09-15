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
| `llm` | Providers, the model chain, retry/backoff, spend budget, and the models.dev metadata catalog. | [LLM Providers and Models](/en/configuration/llm/) |
| `triggers` | One entry per VCS source (Gitea, GitHub, GitLab, P4, SVN) — inbound webhook/HMAC verification and outbound tokens. | [Authentication & secrets](/en/configuration/authentication/) |
| `workspaces` | The repositories you review: source bindings, per-workspace overrides, and the clone cache. | this page |
| `outputs` | Output channels (PR reviews, IM bots, managed issues), routing rules, and the zero-problem policy. | [Output Channels and Routing](/en/configuration/outputs/) |
| `agent` | The agent CLI to drive, the per-run timeout, context auto-compaction, and the sandbox backend. | [Agent and Sandbox](/en/configuration/agent/) |
| `review` | File filters, label management, the managed-problem-issue lifecycle cap, and reflection memory. | this page |
| `queue` | In-memory, SQLite, or Redis queue, worker concurrency, rate limits, and retry policy. | [Queue and Retry](/en/configuration/queue/) |
| `storage` | Database, cache, and object-store backends for observability, the model catalog, and future features. | [Storage](/en/configuration/storage/) |
| `compression` | AICR-side diff summarization that runs before the model sees a large task. | [LLM Providers and Models](/en/configuration/llm/) (context dependency) |
| `server` | HTTP listener and global API-key auth for `/triggers/*`. | [Authentication & secrets](/en/configuration/authentication/) |
| `admin` | Optional observability-dashboard super-admin login (separate from webhook/trigger auth). | [Authentication & secrets](/en/configuration/authentication/) |
| `config_sources` | Database configuration source switch, runtime refresh cadence, and secret-reference grants. | this page (dynamic configuration API) |

:::note[A minimal config]
Only `llm`, at least one `triggers[]` entry, and at least one
`workspaces.instances.<id>` are required to review anything. Everything else
ships with sensible defaults so the sample `example/config.yaml` runs as-is once
you fill in your LLM key.
:::

## File validation

The loader accepts a YAML mapping up to 1 MiB. It rejects duplicate keys,
cyclic aliases and prototype keys before applying defaults. Provider IDs,
trigger names and channel names must be unique. Fields ending in `_env`
must contain an environment variable name matching `[A-Za-z_][A-Za-z0-9_]*`.
Historical model-chain forms are converted in memory; the file is never
rewritten. See [model groups](/en/configuration/llm/).

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
| `model_chain` (main group) | via `llm.default_model_chain` | ✓ | ✓ |
| `triage_model_chain` (lifecycle group) | via `llm.triage_model_chain` | ✓ | ✓ |
| `agent.default` | ✓ | ✓ | ✓ |
| `sandbox` | via `agent.sandbox` | ✓ | ✓ |
| `prompt` (base system prompt, `force_skills`) | — | ✓ | ✓ |
| `context_repositories` (auxiliary context repositories) | — | ✓ | ✓ |
| `auth` (per-workspace API key) | via `server.auth` | — | ✓ |
| `compression`, `queue`, `storage`, `llm`, `server`, `admin`, `triggers`, `config_sources` | ✓ | — | — |

Define groups once in `llm.model_chain`; workspaces reference group names.
The main group controls reviews, agent failover, and compression summaries.
Triage inherits that workspace's main group when omitted at every layer.
See the [model group example](/en/configuration/llm/).

Each run resolves `agent.default` and `sandbox` through the merged
global → defaults → instance selection and creates its own sandbox instance.

`context_repositories` declares auxiliary repositories the reviewer may consult
(shared libraries, protocol contracts, and so on): each review materializes a
fresh copy under `<workspace>/context-repos/<alias>` once changed files are
known, exposes it to the agent as the read-only mount
`/workspace/context-repos/<alias>` in container sandboxes, isolates per-repo
failures from the review, and enforces the `max_mb` size cap (default 512). An
instance list replaces the `defaults` list wholesale. Field details live in the
[config field reference](/en/reference/config-fields/#workspaces).

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
  first — without a provider and a model chain nothing runs.
- Going to production? Configure a durable queue
  ([Queue and Retry](/en/configuration/queue/)), storage
  ([Storage](/en/configuration/storage/)), and the agent
  sandbox ([Agent and Sandbox](/en/configuration/agent/)).
- Tuning output behavior? See
  [Output Channels and Routing](/en/configuration/outputs/) for channels,
  routing, the zero-problem policy, and managed-issue lifecycle limits.

## Multi-project workspaces (v2 matching)

An instance can serve many projects with `match[]` rules instead of a single
`source_repo` binding (the two are mutually exclusive). Rules are OR-ed; the
fields inside one rule are AND-ed. Git webhooks (GitHub, GitLab, Gitea,
Forgejo) verify credentials and match at admission: no rule hit returns
`202 repository_not_configured`, and a hit on more than one definition returns
`202 ambiguous_route`. P4/SVN profiles persist a routing receipt first and
resolve in the background against the verified changed paths.

A matched instance renders its directory from `work_path`, a restricted
Handlebars template (only the `segment`, `default`, `hash`, and `lower`
helpers; default `{{workspace.id}}`). The variable catalog lives in
[Template variables](/en/reference/template-variables/). Matched instances use
the `isolated_v2` layout: everything lives under
`<workspaces.root>/<work_path>/<instance_id>`, each run keeps its
source/agent/tmp/context-repos under `runs/<runId>/`, and cleanup follows the
whole review. Legacy cache paths stay intact.

Matching also adds the top override layer: each task resolves its analysis
selection as global → workspace defaults → instance → the matched route's
`analysis` block. When the database configuration source publishes new
revisions, file-owned values keep winning and stay read-only, and a
publication applies only to newly accepted tasks — queued and running tasks
keep the configuration they were accepted with. Field details live in the
[config field reference](/en/reference/config-fields/#workspaces).

## Dynamic configuration API

With `config_sources.database.enabled: true`, `/api/admin/config` publishes database
supplements to the file configuration. File-owned values stay read-only. Each webhook
loads the durable head before credential lookup and keeps one generation throughout
its asynchronous processing. Receipts and new persisted deferrals retain that snapshot.
An empty namespace gets a durable revision 0 snapshot before accepting work.

The admin API requires a Bearer session, limits JSON bodies to 1 MiB of UTF-8 bytes,
rejects cross-origin writes and mismatched `fileDigest`, and redacts historical credentials.
New literal credentials and credential-bearing URLs are rejected; use environment references.
The read view includes file/database origin, immutable record IDs, effective values and
`limit`/`offset` entity pagination. `/readyz` and admin `/status` return 503 when
the configuration cannot be activated.

Changesets and restore requests must include the current SHA-256 `fileDigest`.
The operation endpoint distinguishes durable commit from local activation; status lists
instance heartbeats and versions. Queued tasks and historical unpinned tasks keep their
original version across publication and restart. Unpinned legacy records resolve to a
single persisted `legacy_import` baseline.

Environment references are authorized by their name, configuration path and destination.
Existing file references authorize their current use. Add a file-owned
`config_sources.secret_refs` grant before introducing a database reference or changing its
destination, including inherited channel, model override and workspace/route search tokens.
See the [field reference](/en/reference/config-fields/) for the grant shape.

A channel without an explicit `trigger` inherits the accepting event's compatible
profile. Database channels need grants for every compatible profile's effective
credential and destination; pin `trigger` to restrict this set. File-owned
channels retain authorization for these existing uses. GitLab `project_id` is
part of the destination grant, so changing it requires a matching file grant.

The database may manage the global leaves `llm.default_model_chain`,
`llm.triage_model_chain`, `llm.retry`, `llm.per_provider_overrides`,
`llm.budget`, `llm.model_catalog`, `review`, `compression`, `agent`,
`outputs.template_engine`, `outputs.no_problems`, `outputs.author_resolution`,
`outputs.routes`, `queue.workers`, `queue.rate_limit`, `queue.retry`,
`queue.dead_letter`, `workspaces.cache` and `workspaces.defaults`, plus the
provider, model-group, trigger, channel, workspace and route entity
collections. The bootstrap trust boundary — `server`, `admin`, `storage`,
`config_sources`, `queue.kind`, `queue.sqlite` and `workspaces.root` — is
never writable from the database.

v2 routes, Review policies, agent/search/sandbox settings, model catalog and triage changes
apply to new tasks. An explicit empty v2 output list closes that output kind. The management
UI ships as the dashboard **Config** tab (see [Dashboard and logs](/en/start/dashboard/));
the API is available independently of the statistics store.
