---
title: LLM Providers and Models
description: Configure LLM providers, the fallback chain, retry/backoff, spend budget, and the opt-in models.dev metadata catalog.
---

The `llm` namespace is the heart of AICodeReviewer — without a provider and at
least one fallback-chain entry, no review can run. This page covers
`llm.providers`, `llm.fallback_chain`, `llm.retry`, `llm.budget`, and the M10
model metadata catalog (`llm.model_catalog`).

A complete, minimal example:

```yaml
llm:
  providers:
    - id: my-llm
      kind: openai_compatible
      base_url: https://api.openai.com/v1
      api_key_env: AICR_LLM_API_KEY

  fallback_chain:
    - provider: my-llm
      model: gpt-4o-mini
      role: any

  retry:
    max_attempts: 3
    backoff:
      kind: exponential
      base_ms: 1000
      max_ms: 30000
      jitter: true

  budget:
    per_run_usd: 0.10
    per_repo_daily_usd: 1.0
```

## `llm.providers[]` — connection definitions

Each provider entry describes one LLM endpoint. The `id` is what every other
section (the fallback chain, the model catalog) references; it is local to your
config.

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `id` | string | ✓ | Unique provider id used by `fallback_chain` and the catalog. |
| `kind` | enum | ✓ | Provider protocol. One of `openai_compatible`, `azure_openai`, `anthropic`, `vertex_ai`, `bedrock`, `google_ai_studio`, `ollama`, `copilot`. |
| `base_url` | string (URL) | – | API base URL. Optional for some hosted kinds. |
| `api_key_env` | string | – | Name of the env var holding the API key. Never inline the key. |
| `api_version` | string | – | API version (used by `azure_openai` and others). |
| `catalog_provider` | string | – | Map a custom provider to a models.dev provider id (e.g. `openai`). |
| `catalog_id` | string | – | Explicit models.dev lookup id (e.g. `openai/gpt-4o-mini`) for custom aliases. |

:::tip[Mapping custom gateways to the catalog]
A custom OpenAI-compatible gateway can still benefit from the models.dev
catalog: set `catalog_provider: openai` on the provider (resolved as
`openai/<modelId>`), or pin a specific entry with `catalog_id:
openai/gpt-4o-mini`.
:::

## `llm.fallback_chain[]` — which model does what

The fallback chain is an ordered list of `(provider, model, role)` triples.
Roles let you split work between a fast/cheap "light" model (used for diff
compression and per-file summaries) and a "heavy" model (the main reviewer).
`any` is used when no role is specified.

| Field | Type | Required | Description |
| --- | --- | :---: | --- |
| `provider` | string | ✓ | Must match a `providers[].id`. |
| `model` | string | ✓ | Model id passed to the provider. |
| `role` | enum | ✓ | `light`, `heavy`, or `any`. |

```yaml
llm:
  fallback_chain:
    - provider: my-llm
      model: gpt-4o-mini
      role: light          # diff compression, per-file summaries
    - provider: my-llm
      model: gpt-4o
      role: heavy          # main reviewer
    - provider: my-llm
      model: gpt-4o-mini
      role: any            # fallback for any role
```

## `llm.retry` — transient-failure handling

Applied to LLM calls that fail with a transient error (rate limit, 5xx,
network). Per-provider overrides are supported via
`llm.per_provider_overrides` (a map of provider id → `{ max_attempts,
give_up_after_seconds }`).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_attempts` | int > 0 | – | Total attempts including the first call. |
| `respect_retry_after` | bool | – | Honor a `Retry-After` header when present. |
| `give_up_after_seconds` | number > 0 | – | Hard wall-clock give-up bound. |
| `backoff.kind` | enum | – | `exponential`, `linear`, or `constant`. |
| `backoff.base_ms` | number > 0 | – | First/backoff base delay in ms. |
| `backoff.max_ms` | number > 0 | – | Cap on a single backoff delay. |
| `backoff.jitter` | bool | – | Add random jitter to avoid thundering herds. |

```yaml
llm:
  retry:
    max_attempts: 3
    backoff:
      kind: exponential
      base_ms: 1000
      max_ms: 30000
      jitter: true
```

## `llm.budget` — spend caps

Soft caps that abort or warn when exceeded. Cost accounting uses catalog pricing
when the model catalog is enabled; otherwise it falls back to a legacy flat
estimate.

| Field | Type | Description |
| --- | --- | --- |
| `per_run_usd` | number ≥ 0 | Cap for a single review run. |
| `per_repo_daily_usd` | number ≥ 0 | Rolling daily cap per repository. |

```yaml
llm:
  budget:
    per_run_usd: 0.10
    per_repo_daily_usd: 1.0
```

## `llm.model_catalog` — models.dev metadata (M10, opt-in)

Available since M10 and **disabled by default**. When enabled, AICodeReviewer
reads model parameters from [models.dev](https://models.dev/) so you do not have
to hand-maintain context windows, output limits, capability flags, and pricing
per provider. These values feed diff-compression thresholds, `llm.budget` cost
accounting, and the model config passed to external agent CLIs (Kilo, Zoo,
opencode, Claude Code).

```yaml
llm:
  model_catalog:
    enabled: true                       # opt-in; disabled by default
    source_url: https://models.dev/api.json
    refresh_interval_hours: 24          # source-level refresh cadence (default daily)
    fetch_timeout_ms: 10000
    offline: false                      # true = bundled snapshot only, never hit the network
    apply_to_model_spec: true           # fill ModelSpec gaps from catalog
    cache:
      backend: sqlite                   # sqlite (default) | memory (test/dev) | redis
    overrides:                          # manual per-model overrides win over catalog
      "my-llm/gpt-4o-mini":
        catalog_id: openai/gpt-4o-mini
        context_window: 128000
        max_output_tokens: 16384
        supports_tool_call: true
        supports_vision: true
        supports_cache_prompt: true
        cost_input_per_mtok: 0.15
        cost_output_per_mtok: 0.6
        display_name: "GPT-4o mini (via gateway)"
```

### Top-level catalog fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | bool | `false` | Master switch. |
| `source_url` | string (URL) | `https://models.dev/api.json` | Catalog source. |
| `refresh_interval_hours` | int > 0 | `24` | Source-level refresh cadence. The remote `api.json` is fetched only when source metadata is missing or older than this. Unknown model ids do not trigger repeated fetches inside the interval. |
| `fetch_timeout_ms` | int > 0 | `10000` | Network fetch timeout. |
| `offline` | bool | `false` | Never touch the network; serve only the bundled snapshot. |
| `apply_to_model_spec` | bool | `true` | Fill gaps in the resolved `ModelSpec` from catalog data. |
| `cache.backend` | enum | `sqlite` | `sqlite`, `memory`, or `redis`. |
| `overrides` | map | `{}` | Per-model manual overrides. Keyed `"<providerId>/<modelId>"`. |

### Cache backends

| Backend | Storage | Notes |
| --- | --- | --- |
| `sqlite` (default) | Reuses `storage.database` (a keyed `model_catalog` table). | Point lookups only; the full `api.json` is parsed once at refresh and upserted row by row, never re-parsed on read. |
| `memory` | In-process. | Intended for tests and local dev. Lost on restart. |
| `redis` | Reuses `storage.cache.redis`. | **Requires** `storage.cache.kind: redis` **and** a resolvable `storage.cache.redis.url_env`. Use a unique `key_prefix` when sharing Redis across environments. See [Storage](/en/configuration/storage/). |

### Resolution order

When a model is looked up, AICodeReviewer resolves in this order:

1. **Keyed refresh cache** (SQLite by default). The remote source is fetched
   only when source-level refresh metadata is missing or older than
   `refresh_interval_hours`. Unknown model ids do **not** refetch repeatedly
   inside the interval.
2. **Stale cached row** — on a failed remote fetch.
3. **Read-only bundled snapshot** — last resort, built at package build time
   from `github.com/anomalyco/models.dev` and seeded into the backend on demand.

### `overrides` — your config always wins

Per-model overrides under `model_catalog.overrides` (keyed
`"<providerId>/<modelId>"`) **always win over catalog data**, and
`llm.providers[]` fields win over both. Missing fields are **never fabricated**:
if neither you nor the catalog provides a value, it stays unset.

The most useful override fields:

| Field | Type | Description |
| --- | --- | --- |
| `catalog_id` | string | Optional models.dev lookup id for custom aliases. |
| `context_window` | int > 0 | Model context window in tokens. |
| `max_input_tokens` | int > 0 | Max input tokens. |
| `max_output_tokens` | int > 0 | Max output tokens. |
| `cost_input_per_mtok` | number ≥ 0 | USD per 1M input tokens. |
| `cost_output_per_mtok` | number ≥ 0 | USD per 1M output tokens. |
| `cost_cache_read_per_mtok` | number ≥ 0 | USD per 1M cached-read tokens. |
| `cost_cache_write_per_mtok` | number ≥ 0 | USD per 1M cache-write tokens. |
| `supports_tool_call` | bool | Tool/function calling. |
| `supports_vision` | bool | Image input. |
| `supports_cache_prompt` | bool | Prompt caching. |
| `supports_reasoning` | bool | Reasoning models. |
| `supports_structured_output` | bool | Structured/JSON output. |
| `display_name` | string | Human-friendly label. |
| `family` | string | Model family. |

The schema also accepts many more optional fields (modalities, reasoning
efforts, latency class, rate-limit tier, knowledge cutoff, …). See the
`modelCatalogOverrideSchema` in `packages/core/src/config.ts` for the full list.

:::caution[Redis cache prerequisites]
Choosing `cache.backend: redis` enables two validations at config-load time:

- `storage.cache.kind` must be `redis`.
- `storage.cache.redis.url_env` must resolve.

If either is missing, the config is rejected with a pointer to the offending
field. Configure both as described in [Storage](/en/configuration/storage/).
:::

## How the catalog feeds the rest of the system

The resolved metadata is consumed by three subsystems:

1. **Diff compression** — `compression.trigger_tokens` and `max_input_ratio`
   default from the model's `context_window` when the `compression` section is
   omitted. Larger windows raise the compression threshold automatically.
2. **`llm.budget` accounting** — catalog pricing replaces the legacy flat cost
   estimate, so spend caps reflect real per-token prices.
3. **Agent config injection** — the context window, max output tokens, vision
   flag, and pricing are injected into the agent CLI's config so each runtime
   knows the model's limits. This is also why **agent context auto-compaction
   depends on a known context window** — see
   [Agent and Sandbox](/en/configuration/agent/) for the
   `context_compaction` settings and the Kilo requirement that the window be
   known (enable the catalog or set `context_window` in `overrides`).
