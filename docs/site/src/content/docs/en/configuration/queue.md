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

## Automatic commit schedules

Git push, P4 `change-commit`, and SVN `post-commit` events wait 120 seconds by
default. `review.auto_commit` controls this delay, allowed weekly windows, and
source exclusions. Set it globally, in `workspaces.defaults.review`, or in
`workspaces.instances.<id>.review`. The nearest `schedule` or `exclude_sources`
replaces the inherited value as a whole.

```yaml
review:
  auto_commit:
    delay_seconds: 120
    schedule:
      timezone: Asia/Shanghai
      rules:
        - days: [mon, tue, wed, thu, fri]
          windows:
            - { start: "00:00", end: "13:00" }
            - { start: "18:00", end: "24:00" }
        - days: [sat, sun]
          windows:
            - { start: "00:00", end: "24:00" }
    exclude_sources:
      - id: ci-client
        vcs: p4
        match:
          client: { glob: "ci-*" }
```

Rules are combined by union. Windows include their start and exclude their
end; overnight windows belong to their starting weekday. Omitted schedules or
`schedule.rules: []` allow all times. The default timezone is UTC. Running
reviews may finish after the window closes. The window also gates asynchronous
pull-request, issue, and comment processing: outside it the first attempt and
every retry wait for the next window, logged as `trigger processing deferred
by execution window`. `exclude_sources: []` clears inherited exclusions; rules
use OR, fields within a rule use AND, and each field accepts either `glob` or
RE2 `regex`.

`include_branches` is a receive-side branch allowlist for the same automatic
commit events: when the resolved list is non-empty, pushes to unlisted branches
are ignored at receive time without persisting a receipt. The nearest layer
wins wholesale and `[]` clears back to all branches. PR/MR, comment, and issue
flows are never filtered, and branchless P4/SVN hooks bypass the check.
Use exact, case-sensitive branch names such as `main` or `release/1.x`, without
the `refs/heads/` prefix; glob patterns and regular expressions are not expanded.
GitLab `Push Hook` events use this same filter and persistent queue. Branch
creation/deletion notifications with an all-zero before/after SHA are ignored.

## Pull request schedules

PR/MR analysis can use its own weekly window with the same shape as
`review.auto_commit.schedule`, under `review.pull_request.schedule` at any of
the three layers (global, `workspaces.defaults.review`,
`workspaces.instances.<id>.review`; the nearest `schedule` replaces the
inherited one as a whole):

```yaml
review:
  pull_request:
    schedule:
      timezone: Asia/Shanghai
      rules:
        - days: [mon, tue, wed, thu, fri]
          windows:
            - { start: "00:00", end: "13:00" }
            - { start: "18:00", end: "24:00" }
        - days: [sat, sun]
          windows:
            - { start: "00:00", end: "24:00" }
```

When no layer sets `review.pull_request.schedule`, pull-request events fall
back to the resolved `review.auto_commit.schedule`; when neither is set,
every instant is allowed. Only automatic pull-request events and
comment-triggered review commands are gated — a deferred comment command
posts a reply on the PR/MR stating the scheduled start. There is no
first-receive delay or commit batching for pull requests.

`review.pull_request.include_target_branches` restricts PR/MR analysis to the
listed target (base) branches — for example `[main]` analyzes only PRs/MRs
that merge into `main`. It follows the same three-layer wholesale replacement
and `[]` clears back to all branches. Events whose target branch is unknown
(a failed PR-detail fetch for a comment command) are allowed through; push,
issue, and manual flows are never filtered.
Target branch names also use exact, case-sensitive matching. A missing ref is
allowed; a supplied empty or non-string webhook ref is rejected as invalid.
These lists apply at reception and do not re-filter previously accepted work.

```yaml
workspaces:
  instances:
    atframe-utils:
      review:
        pull_request:
          include_target_branches: [main]
```

Outside the window the event is held by the deferral registry instead of a
bare timer. With the observability store configured (`storage.database` plus
`admin`, see the dashboard page), deferrals persist and resume after a
restart; repeated events for the same target replace the stored envelope so
only the newest state is reviewed, and the resume instant never moves
earlier. Without the store, deferrals fall back to process memory and a
restart drops them, matching the rest of the asynchronous trigger path.
Waiting targets do not hold a running-review deduplication slot. Both timer
scheduling and the actual attempt check the window, including after a process
pause or clock change. Already running analyses can finish outside the window.

A submission source is raw Git author name + email, P4 User + Client, or SVN
`svn:author`, scoped to the repository and stream. Consecutive due commits may
merge across notifications, up to 50 members per batch. Notifications covering
`A1–A3`, `A4–A5`, and `B1` yield `[A1–A5]` and `[B1]` when all are due before
sealing. Duplicate notifications never restart the delay or regroup sealed
members. P4/SVN hooks cover only their named revision. Missing exclusion evidence
uses bounded retries and then fails the member; it cannot silently allow it.

Receipts, batch membership, and execution checkpoints use the `queue.kind`
backend. Memory state is lost on restart. A completed checkpoint recovers local
result accounting without rerunning analysis or publication. Interrupted or
partially published work requires operator inspection (`execution_outcome_unknown`);
its dead batch holds the stream. Remote publication has no automatic per-target
recovery. Each scheduler executes one batch at a time; across consumers the global
cap uses `queue.workers.concurrency` (1 when the workers block is absent), with
one active batch per workspace.

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
| `backoff.base_ms` | number > 0 | `5000` | First/backoff base delay in ms. |
| `backoff.max_ms` | number > 0 | `60000` | Cap on a single backoff delay. |
| `backoff.jitter` | bool | `true` | Add random jitter. |

Trigger-level retry exists to absorb transient IO failures (timeouts, connection
resets, DNS blips, HTTP 408/5xx). Only errors classified as transient are retried;
deterministic failures — most notably `context_overflow` — are never retried,
regardless of `attempts`. Finer-grained retries also happen one layer down: LLM
provider calls, output-channel fetches, VCS CLI network operations, GitHub App
token exchange, and the issue-triage API client each retry transient IO errors up
to 3 times with a short exponential backoff before an error can fail the whole
trigger run. At the output and triage layers only idempotent methods retry;
non-idempotent POSTs never do, so a lost response can never duplicate an issue or
comment. HTTP 429 is left to the LLM gateway, which honors `Retry-After`.

```yaml
queue:
  retry:
    attempts: 3              # transient-failure retries (1 = no retry)
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
