---
title: Dashboard and logs
description: Enable the admin dashboard, navigate it, read /metrics, and find run logs and snapshots.
---

AICR ships a built-in admin dashboard and a Prometheus metrics
endpoint. The dashboard pairs observability (statistics, live runs, events)
with configuration management (the **Config** tab) and complements an
external time-series system when you have one. This page expands on the
[Quick start](/en/start/quick-start/) health check with how to enable admin
login, navigate the dashboard, read `/metrics`, and locate run logs and
snapshots.

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

When admin auth is configured, AICR initializes the statistics store selected by
`storage.database.kind`: SQLite uses `storage.database.sqlite.path` (default
`/app/data/aicr.sqlite`); PostgreSQL uses the URL named by
`storage.database.postgres.url_env`. The Config API can remain available when
statistics initialization fails, provided its own configuration store is available.

## Navigating the dashboard

The browser title and page heading are **AICodeReviewer Admin**. Config editors
are visible only on their current page. Switching Config subpages closes clean
or read-only drawers; dirty drawers require discarding changes or cancelling the
switch. Switching a top-level tab hides the editor and preserves its draft.
Literal credentials use password inputs: leave a stored value untouched to keep
it, enter a replacement, or choose **Clear stored value** to remove it. Search
credential rows let you choose an environment variable or a literal value.

Visit `http://<aicr-host>:8080/dashboard` (or `/`). Even before admin env is
configured, the route returns the dashboard shell with a setup-required
prompt instead of a 404; if `path_prefix` is set, the root paths redirect to
the prefixed entry.

After logging in, the dashboard lands on the **Overview** tab and has seven tabs:

- **Overview** — the landing tab: total reviews, success/failure/skip counts, runs that found
  problems, total problems, issues created, code analyzed, LLM requests,
  input/output/total tokens, prompt cache hit rate with the hit/miss token
  split, estimated cost, average duration. A time-window
  selector switches between today / this week / this month / all (all in
  UTC). The Recent activity table includes the same per-run token total,
  cache hit/miss split, and hit rate as the Runs tab, plus the branch and
  short revision with the commit time.
- **Live** — analyses running right now in this server process. Responsive cards show
  the worker slot, run ID, task title, attempt, workspace/trigger/repo, branch and revision (git short sha,
  SVN `r<N>`, P4 `CL <N>`; hover for the full revision) with the commit time
  when resolved, the model and agent, the phase (preparing → analyzing →
  publishing), the start time with a live elapsed counter, cumulative tokens
  with input/output and cache hit/miss/write counts (or `~N est. prompt` when
  usage is unavailable), cache hit rate, LLM request count, retry/fallback counts,
  estimated cost, and the usage update time. Worker numbers identify active
  analysis slots in this process; a released slot can serve a later run.
  Kilo/OpenCode and pi/oh-my-pi update usage after each completed model turn;
  other agents and direct LLM calls update when the invocation finishes.
  Entries disappear when an execution
  settles or the server restarts. A Refresh button reloads on demand, and the
  auto-refresh selector (default **Off (manual)**) polls every 5/15/30/60
  seconds after the previous request finishes. Polling pauses outside the Live
  tab and while the browser page is hidden; logout resets it to manual.
  A failed refresh labels retained data as stale.
- **Projects** — per-project aggregates (`workspaceId + triggerName +
  repoRef`): review/success/failure/skip counts, problem totals, issues
  created, files changed, lines added/deleted, LLM requests, tokens, cache-hit
  tokens and hit rate, cost, average duration. Soft-deleted projects stay
  visible during their grace period and are flagged `isActive`.
- **Providers** — per-provider+model aggregates: request count, input/output
  tokens, cache-hit tokens and hit rate, cost, retry/fallback/failure counts,
  average latency.
- **Runs** — the most recent 100 runs, paged 20 at a time with Prev/Next. Each row
  shows real token usage when captured: total tokens with the cache-hit and
  non-cached input split and the hit rate; `—` when the run reported no
  parseable usage. The Revision column shows the branch, the short revision,
  and the commit time when the VCS adapter could resolve it.
- **Events** — the most recent 100 received webhook/trigger events, paged 20
  at a time. Each row shows the receipt-time decision: `executed` (started
  immediately), `queued`/`duplicate` (auto-commit receipt), `deferred`
  (execution window, with the scheduled resume instant), `deduplicated`
  (merged into a pending re-review), `ignored` (label, unsupported event, or
  unconfigured repository), or `rejected` (bad signature, invalid payload,
  missing configuration), with the reason and details such as matched labels
  or the receipt id.

- **Config** — database configuration, field sources, routing preview and version
  history. Enable `config_sources.database.enabled` to use configuration management.

Usage is aggregated across the complete review run, including the initial model
call, context or format-repair calls, and any final direct-LLM fallback. For
Kilo, each `step_finish` model turn counts as one request. The locally estimated
prompt size is kept separate and is shown only when real usage was unavailable;
it is never mixed into provider token totals.

Cached tokens are part of the input total: the hit rate is
`cached tokens / input tokens`, and the non-cached input is
`input - cached - cache-write` tokens. The rate shows `—` until a provider
reports usage with a non-zero input.

The Projects and Providers tabs each call their own time-windowed API
(`GET /api/admin/stats/projects?since=` and `.../providers?since=`). The Runs
tab fetches the latest 100 runs from `GET /api/admin/runs?limit=100` and pages
them in the browser; the Events tab does the same against
`GET /api/admin/events?limit=100`, whose store keeps only the newest 100
entries. The Live tab polls `GET /api/admin/runs/live`, which reads an
in-memory registry of the current process. Completed runs are available in
Recent Runs, subject to its retention limit. The dashboard queries real-time aggregation
as the source of truth.

Branch, revision, and commit time come from the run's VCS stamp: the branch
travels with the webhook event; the analyzed head revision and VCS family
come from the adapter's resolved range and kind. The commit time is resolved
best-effort by the VCS adapter after the scoped fetch (`git log`, `svn log`,
or `p4 describe`). Git uses the committer date; SVN uses `svn:date`; P4 shows
the submit time only for submitted changelists. Times display in the browser's
local timezone. Unavailable commit times show `—`; legacy or unknown VCS kinds
retain the full revision without guessing a hash format.

## Managing configuration

In **Config**, edit providers, model groups, triggers, channels, routes, workspaces
and global settings. File-owned values are read-only; **Copy as new database
config** requires a distinct name. Database values supplement explicit file
configuration. A shadowed database record can be deleted; edit its file owner to
change the effective value. The `agent`, `review` and
`queue.workers|rate_limit|retry|dead_letter` prefixes are the exception: database
values win over file values, the Agent/Review/Queue pages stay editable, and
**Reset database overrides** clears the database overrides and falls back to the
file or default values.
Reserved Queue settings (`workers.lock_ttl_seconds` and `dead_letter.*`) remain
read-only because they have no runtime consumer. A reset also discards unsaved
page edits; a revision conflict shows the current database values before retry.
Reserved Queue settings (`workers.lock_ttl_seconds` and `dead_letter.*`) remain
read-only because they have no runtime consumer. A reset also discards unsaved
page edits; a revision conflict shows the current database values before retry.
Secret controls accept authorized environment variable
names. Replace or clear redacted legacy values before saving them.

The **Templates** and **Prompts** pages manage named template
(`outputs.templates`) and system-prompt (`prompts.system`) documents: the markdown
body is the runtime content, optional frontmatter only feeds the UI metadata.
Below the record table, read-only built-in assets (the built-in problem/summary
templates per channel kind and the built-in base prompt) offer **Copy as new
database config** to start a managed draft from their body. Channels reference
template names via `templates.{problem,summary}`; workspaces reference prompt
names via `prompt.system_prompt`/`prompt.extra_system_prompt`.
Document text round-trips unchanged, including URL fragments, credential-shaped
examples and names ending in `_env`. Preview and version history include these
entities. Delete or disable a referenced document only after removing its
references, or remove both in one staged publication.
Document text round-trips unchanged, including URL fragments, credential-shaped
examples and names ending in `_env`. Preview and version history include these
entities. Delete or disable a referenced document only after removing its
references, or remove both in one staged publication.

New providers can start from a **Platform preset** (Kimi For Coding, Kimi Open
Platform, Zhipu, Z.AI, Alibaba Cloud, Tencent Cloud, DeepSeek), which prefills
the endpoint, the wire protocol (OpenAI- or Anthropic-compatible), and the
catalog mapping. Presets only prefill the draft; every field stays editable
until you save. Endpoint tables and plan caveats live in
[LLM Providers and Models](/en/configuration/llm/#platform-presets-dashboard).

Use **Save** for one record or **Save page changes** for global settings. For
related edits, use **Stage changes** or **Stage page changes** on each page, then
**Publish staged changes**. For example, stage a provider, select it in a new model
group, and publish both together. Staged edits share one revision and remain in
browser memory; reloading the page discards them.

Reopen a staged record or page to continue editing its draft. Staging again keeps
earlier changes; returning a field to its published value removes that change.
**Discard staged changes** also clears the corresponding editor drafts.

Routing **Preview** includes staged changes without publishing. Stage open edits
first. Workspace path completion starts with `{{`, inserts `segment` expressions,
and uses `default` for nullable variables; choose a suitable fallback before
publication. Weekly schedules support multiple weekdays and time windows.

A successful save shows its revision. A conflict keeps the draft and offers a
comparison before retrying. If the response is lost, check the operation status;
**Resubmit** retries the original request. **Stored, activation pending** means
the write is durable but the runtime has not activated it. Resolve that status
before submitting another edit. **Versions → Restore** creates a new revision;
it retains file locks and validates references. Newly accepted tasks use the
published revision; already accepted tasks retain their original configuration.

## The admin API

Queued commit events show a **not before** time: receipt delay and execution
windows set the earliest eligible start; existing work can postpone it further.

All endpoints except `/login` require `Authorization: Bearer <token>`.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/admin/login` | Verify username/password, return session token + expiry |
| `POST /api/admin/logout` | Revoke the session token |
| `GET /api/admin/stats` | Overview + today/this-week/this-month windows, projects, providers, recent runs |
| `GET /api/admin/stats/projects?since=` | Per-project aggregates |
| `GET /api/admin/stats/providers?since=` | Per-provider+model aggregates |
| `GET /api/admin/runs?limit=` | Recent run list (1..100), each with token usage incl. the cache hit split and the VCS stamp |
| `GET /api/admin/runs/live` | Currently running analyses from the in-process registry: phase, elapsed start time, cumulative tokens/requests/cost |
| `GET /api/admin/events?limit=` | Recent webhook/trigger event log (1..100), each with the receipt-time decision and reason |
| `GET /api/admin/config` | Configuration view with provenance and paginated entities |
| `GET /api/admin/config/schema`, `/options/:source` | Form specification and dynamic options |
| `POST /api/admin/config/changesets` | Atomic publication with `baseRevision`, `fileDigest`, `operationId`, and `operations` |
| `POST /api/admin/config/preview-route` | Read-only event preview; optional `draft` contains `baseRevision`, `fileDigest`, and `operations` |
| `POST /api/admin/config/validate` | Side-effect-free changeset validation; returns the redacted preview report without writing |
| `GET /api/admin/config/revisions/:revision` | One revision's document plus its audit entries |
| `POST /api/admin/config/revisions/:revision/restore` | Publish a new revision restoring an old one; requires `fileDigest`, keeps file locks and reference validation |
| `GET /api/admin/config/operations/:id`, `/revisions`, `/status` | Operation recovery, version history and activation status |

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
