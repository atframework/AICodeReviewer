---
title: Dashboard and logs
description: Enable the observability dashboard, navigate it, read /metrics, and find run logs and snapshots.
---

AICR ships a built-in observability dashboard and a Prometheus metrics
endpoint. The dashboard is a complement to (not a replacement for) an
external time-series system — when none is configured, you still get basic
statistics. This page expands on the [Quick start](/en/start/quick-start/)
health check with how to enable admin login, navigate the dashboard, read
`/metrics`, and locate run logs and snapshots.

## Enabling admin login

The dashboard has a separate super-admin login that is **independent** of
webhook HMAC and trigger API keys. Set the admin env vars to turn it on:

```bash
# .env
AICR_ADMIN_USERNAME=admin
AICR_ADMIN_PASSWORD=<strong-password>
# Or use a hash instead of the raw password (takes precedence):
# AICR_ADMIN_PASSWORD_HASH=sha256:<hex>
```

Corresponding config (defaults shown):

```yaml
admin:
  username_env: AICR_ADMIN_USERNAME
  password_env: AICR_ADMIN_PASSWORD
  password_hash_env: AICR_ADMIN_PASSWORD_HASH   # optional, takes precedence
  session_ttl_seconds: 86400                      # 24 hours is the default; the field unit is seconds, not minutes
```

:::note[Use `session_ttl_seconds`, not minutes]
The session TTL field is `session_ttl_seconds` (default `86400` = 24 hours).
A `session_ttl_minutes` field is silently ignored. Password comparison uses
a fixed-length SHA-256 digest and `timingSafeEqual`; the server never prints
or persists the raw password.
:::

When admin auth is configured, AICR initializes the SQLite store (at
`storage.database.sqlite.path`, default `/app/data/aicr.sqlite`) that backs
the dashboard. Postgres and Redis backends are reserved extension points;
the dashboard runtime currently requires SQLite — startup fails loudly if
`storage.database.kind` is not `sqlite` when the dashboard is enabled.

## Navigating the dashboard

Visit `http://<aicr-host>:8080/dashboard` (or `/`). Even before admin env is
configured, the route returns the dashboard shell with a setup-required
prompt instead of a 404; if `path_prefix` is set, the root paths redirect to
the prefixed entry.

After logging in, the dashboard has four tabs:

- **Overview** — total reviews, success/failure/skip counts, runs that found
  problems, total problems, issues created, code analyzed, LLM requests,
  input/output/total tokens, estimated cost, average duration. A time-window
  selector switches between today / this week / this month / all (all in
  UTC).
- **Projects** — per-project aggregates (`workspaceId + triggerName +
  repoRef`): review/success/failure/skip counts, problem totals, issues
  created, files changed, lines added/deleted, LLM requests, tokens, cost,
  average duration. Soft-deleted projects stay visible during their grace
  period and are flagged `isActive`.
- **Providers** — per-provider+model aggregates: request count, input/output
  tokens, cost, retry/fallback/failure counts, average latency.
- **Runs** — the most recent runs (up to 100 via `?limit=`).

Usage is aggregated across the complete review run, including the initial model
call, context or format-repair calls, and any final direct-LLM fallback. For
Kilo, each `step_finish` model turn counts as one request. The locally estimated
prompt size is kept separate and is shown only when real usage was unavailable;
it is never mixed into provider token totals.

The Projects and Providers tabs each call their own time-windowed API
(`GET /api/admin/stats/projects?since=` and `.../providers?since=`). The
dashboard queries real-time aggregation as the source of truth.

## The admin API

All endpoints except `/login` require `Authorization: Bearer <token>`.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/admin/login` | Verify username/password, return session token + expiry |
| `POST /api/admin/logout` | Revoke the session token |
| `GET /api/admin/stats` | Overview + today/this-week/this-month windows, projects, providers, recent runs |
| `GET /api/admin/stats/projects?since=` | Per-project aggregates |
| `GET /api/admin/stats/providers?since=` | Per-provider+model aggregates |
| `GET /api/admin/runs?limit=` | Recent run list (1..100) |

## `/metrics`

`/metrics` exposes low-cardinality, process-lifetime Prometheus counters and
histograms. It covers both sync and async review runs. High-cardinality
queries (per-project, per-provider) belong to the SQLite store behind the
dashboard, not `/metrics`. Histogram buckets, sums, and counts accumulate
over the process lifetime; only raw duration samples are windowed.

The dashboard stores only run and usage metadata — never prompts, full
diffs, secrets, or un-redacted output.

## Where run logs and snapshots live

Per-run artifacts live under the workspace directory:

```text
workspaces/<workspace_id>/runs/<run_id>/run.json
```

`run.json` is the audit snapshot for a run: target/workspace, provider/model,
`triggerName`, output and error summaries, resolved model-catalog source,
token estimates, and dispatch counts. The materialized agent runtime bundle
for the run lives under `workspaces/<workspace_id>/agent/` (instructions,
skills, MCP config, `manifest.json`, `.aicr-output-state.json`).

Server-level logs go to the `aicr-logs` volume (`/app/logs` in the
container); tail them with `docker compose logs -f` or your container
runtime's log driver.

## Next steps

- [Configuration fields](/en/reference/config-fields/) — the `admin` and
  `storage` namespaces.
- [Troubleshooting](/en/troubleshooting/) — diagnosing skipped runs and
  dispatch failures using the dashboard and run snapshots.
