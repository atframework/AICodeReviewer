---
title: Queue and Retry
description: Configure the in-memory, SQLite, or Redis queue, worker concurrency, rate limits, and the retry policy.
---

The `queue` namespace decides where review jobs wait, how many run at once,
how fast they can call each provider, and how failures are retried. The default
is an in-memory queue; for production you should switch to the durable SQLite
queue so jobs survive restarts.

```yaml
queue:
  kind: sqlite              # memory (default) | sqlite | redis

  workers:
    concurrency: 4
    per_workspace_concurrency: 1
    lock_ttl_seconds: 1800

  rate_limit:
    per_provider_rps:
      gitea-internal: 5

  retry:
    attempts: 3
    backoff:
      kind: exponential
      base_ms: 2000
      max_ms: 60000
      jitter: true
```

## `queue.kind`

| Value | Description |
| --- | --- |
| `memory` (default) | In-process queue. Jobs are lost on restart. Fine for single-instance dev. |
| `sqlite` | Durable queue that survives restarts (single process or multiple processes sharing the same file). Recommended for production. |
| `redis` | Durable queue backed by Redis, for multi-instance deployments. Options below. |
| `rabbitmq` | Reserved — not implemented; setting it logs a warning and falls back to `memory`. |

### `queue.redis` — Redis queue options

Redis queue connection fields are accepted as passthrough keys:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `url_env` | string | – | Name of the env var holding the Redis URL. |
| `url` | string | – | Redis URL directly (or use `host` / `port` / `password` / `db`). |
| `tls` | bool | `false` | Connect over TLS. |
| `key_prefix` | string | `"aicr:"` | Key prefix for the queue. Use a unique value per environment when sharing Redis. |

## `queue.workers`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `concurrency` | int > 0 | `4` | Global worker concurrency (jobs running at once across the process). |
| `per_workspace_concurrency` | int > 0 | `1` | Max jobs running concurrently per workspace. Use `1` to serialize per repo. |
| `lock_ttl_seconds` | int > 0 | `1800` | Worker job-lock TTL. |

## `queue.sqlite` — durable queue options

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | `data/queue.sqlite` | SQLite database file for the queue. |
| `lock_ttl_seconds` | int > 0 | `300` | Stale-running reclaim TTL. A running job whose lock is older than this is treated as crashed and reclaimed. |

### How the SQLite durable queue works

The SQLite queue is built on [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
and is safe for either a single process or multiple processes sharing the same
file. Its key properties:

- **Atomic claim via `UPDATE ... RETURNING`.** A worker claims the next queued
  job and marks it `running` in a single statement, so two workers can never
  grab the same job.
- **Stale-job reclaim after the lock TTL.** A background sweep requeues any
  `running` job whose lock is older than `lock_ttl_seconds`, so a crashed
  worker's job is eventually retried by another worker.
- **WAL + `busy_timeout` for cross-process safety.** The queue opens with
  `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000`, so concurrent
  writers from different processes cooperate instead of erroring.

## `queue.rate_limit`

| Field | Type | Description |
| --- | --- | --- |
| `per_provider_rps` | map<string, number> | Per-provider requests-per-second cap, keyed by provider id. |

```yaml
queue:
  rate_limit:
    per_provider_rps:
      gitea-internal: 5      # max 5 rps to the gitea-internal provider
```

## `queue.retry` — use `attempts` + `backoff`

:::important[Canonical fields]
The canonical retry fields are **`attempts`** and **`backoff`**. The legacy
`max_attempts` / `backoff_seconds` pair is still accepted and normalized, but
**deprecated** — migrate to `attempts` + `backoff`.
:::

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `attempts` | int > 0 | `3` | Total attempts including the first try. `1` = no retry. |
| `backoff.kind` | enum | `exponential` | `exponential`, `linear`, or `constant`. |
| `backoff.base_ms` | number > 0 | `2000` | First/backoff base delay in ms. |
| `backoff.max_ms` | number > 0 | `60000` | Cap on a single backoff delay. |
| `backoff.jitter` | bool | `true` | Add random jitter. |

```yaml
queue:
  retry:
    attempts: 2              # retry once on transient failures (1 = no retry)
    backoff:
      kind: exponential
      base_ms: 5000
      max_ms: 60000
      jitter: true
```

### Legacy fields (deprecated, normalized)

For backward compatibility the loader still reads these and normalizes them,
but new configs should not use them:

| Legacy field | Normalized to |
| --- | --- |
| `max_attempts` | `attempts` (floor of the value). |
| `backoff_seconds` | a `constant` backoff with `base_ms = max_ms = backoff_seconds * 1000`, `jitter: false`. |

`attempts` / `backoff` always take precedence when both are present.

## `queue.dead_letter` — reserved, no effect yet

The schema accepts `dead_letter.enabled` and `dead_letter.max_age_hours`, but
the runtime does not consume them today: jobs that exhaust their retries are
marked failed and recorded in the run history — there is no separate parking
area. Both fields are reserved for a future release; setting them now changes
nothing.
