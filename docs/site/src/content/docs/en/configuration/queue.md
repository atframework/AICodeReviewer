---
title: Queue and Retry
description: Configure the in-memory or durable SQLite queue, worker concurrency, rate limits, and the retry/dead-letter policy.
---

The `queue` namespace decides where review jobs wait, how many run at once,
how fast they can call each provider, and what happens when a job keeps
failing. The default is an in-memory queue; for production you should switch
to the durable SQLite queue so jobs survive restarts.

```yaml
queue:
  kind: memory              # memory (default) | sqlite | redis (reserved)

  workers:
    concurrency: 4
    per_workspace_concurrency: 1
    lock_ttl_seconds: 1800

  rate_limit:
    per_provider_rps:
      gitea-internal: 5

  retry:
    attempts: 2
    backoff:
      kind: exponential
      base_ms: 5000
      max_ms: 60000
      jitter: true

  dead_letter:
    enabled: true
    max_age_hours: 72
```

## `queue.kind`

| Value | Description |
| --- | --- |
| `memory` (default) | In-process queue. Jobs are lost on restart. Fine for single-instance dev. |
| `sqlite` | Durable queue that survives restarts (single process or multiple processes sharing the same file). Recommended for production. |
| `redis` | Reserved — listed in the schema, not yet implemented. |
| `rabbitmq` | Reserved — not yet implemented. |

## `queue.workers`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `concurrency` | int > 0 | – | Global worker concurrency (jobs running at once across the process). |
| `per_workspace_concurrency` | int > 0 | – | Max jobs running concurrently per workspace. Use `1` to serialize per repo. |
| `lock_ttl_seconds` | int > 0 | – | Stale-running reclaim TTL for the SQLite queue's running lock. |

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
| `attempts` | int > 0 | – | Total attempts including the first try. `1` = no retry. |
| `backoff.kind` | enum | – | `exponential`, `linear`, or `constant`. |
| `backoff.base_ms` | number > 0 | – | First/backoff base delay in ms. |
| `backoff.max_ms` | number > 0 | – | Cap on a single backoff delay. |
| `backoff.jitter` | bool | – | Add random jitter. |

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

## `queue.dead_letter`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | bool | – | When `true`, jobs that exhaust their retries are parked for inspection instead of discarded. |
| `max_age_hours` | int > 0 | – | Parked items older than this are pruned. |

```yaml
queue:
  dead_letter:
    enabled: true
    max_age_hours: 72
```
