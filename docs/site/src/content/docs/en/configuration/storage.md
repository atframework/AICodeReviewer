---
title: Storage
description: Configure the database, cache, and object storage backends.
---

The `storage` namespace configures three independent backends — a database, a
cache, and an object store — plus a retention policy. These back the
observability dashboard, the model metadata catalog, and reflection memory. The
database is created automatically when admin auth is configured, when
`llm.model_catalog` uses the SQLite backend, when reflection memory is
enabled, or when the database configuration source is enabled
(`config_sources.database.enabled: true`).

:::note[Backends are wired in to different degrees]
Both `sqlite` and `postgres` are wired into the runtime database (dashboard
stats, model catalog, reflection memory, review deferrals, webhook events).
The `redis` cache is wired in and used by the model catalog's Redis backend.
The `s3` object-store fields are reserved — they validate but nothing consumes
them yet.
:::

```yaml
storage:
  database:
    kind: sqlite
    sqlite:
      path: /app/data/aicr.sqlite
  cache:
    kind: memory             # memory | redis | none
  object:
    kind: filesystem         # filesystem | s3
    filesystem:
      root: /app/data/objects
  retention:
    deleted_project_grace_days: 30
    recent_runs:
      max_count: 2000
      max_age_months: 6
    events:
      max_count: 2000
      max_age_months: 6
    queue:
      max_count: 1000
      max_age_months: 6
```

## `storage.database`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | enum | `sqlite` | `sqlite` or `postgres`. |
| `sqlite.path` | string | `/app/data/aicr.sqlite` | SQLite database file path. |
| `postgres.url_env` | string | – | Name of the env var holding the Postgres connection URL. |
| `migrate` | enum | `auto` | Startup schema mode: `auto` applies pending steps; `verify` refuses a missing, pending, drifted or newer schema without applying migrations. |

The SQLite database is created automatically when needed. It stores the
observability stats, the keyed `model_catalog` table (when the catalog uses
the SQLite backend), reflection memory entries, deferred reviews, received
webhook events, and the dynamic-config revision/session tables. The Postgres
backend serves the same contracts through a dedicated schema. Schema upgrades
use `schema_migrations` for config and PostgreSQL business tables; SQLite
business tables retain their historical name-only `_migrations` ledger.
`aicr migrate --status|--check|--apply` inspects or upgrades both `config` and
`store` namespaces on SQLite and PostgreSQL without starting the server (see
[CLI Reference](/en/reference/cli/)).

Keep SQLite WAL databases on a local filesystem shared by processes on the
same host. WAL does not support network filesystems; use the Linux filesystem
for WSL database tests rather than a Windows-drive mount. See the
[SQLite WAL requirements](https://www.sqlite.org/wal.html).

### Upgrade compatibility

Before the first upgrade, stop ingress and claims on every old instance, drain
accepted work, confirm the old processes have exited, and back up the database.
A migration lock does not detect an idle old process. The tested historical
baseline is commit `c5d221c`: SQLite/PostgreSQL require that stop-and-upgrade
sequence, and the old program refuses to reopen schema 2. Redis keeps its
existing keys and JSON shape; both versions can read/write v1/v2 documents with
CAS conflict protection. Other version pairs need their own compatibility test.

The SQL ledger records minimum reader/writer protocols and transaction mode.
Both protocols are currently 1; historical rows without those fields mean 1.
Only atomic SQL migrations are supported. PostgreSQL migration lock waits are
bounded to 5 seconds, and migration statements to 30 seconds. `migrate --status`
reports compatibility; `--check`/`--apply` reject incompatible requirements.
Database document/effective-config readers and writers accept formats 1–2;
raw configuration files continue to use format 1.

## `storage.cache`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | enum | `memory` | `memory`, `redis`, or `none`. |
| `redis.url_env` | string | – | Name of the env var holding the Redis URL. Required when `kind: redis`. |
| `ttl_seconds` | int > 0 | – | Optional default cache TTL. |

Redis is shared with the model catalog Redis backend
(`llm.model_catalog.cache.backend: redis`). When the catalog uses Redis,
`storage.cache.kind` **must** be `redis` and `redis.url_env` **must** resolve,
otherwise the config is rejected at load time. See
[LLM Providers and Models](/en/configuration/llm/) for the catalog side.

The configuration source's Redis backend (`config_sources.database.backend:
redis`) also reuses this connection declaration: it requires
`storage.cache.kind: redis` and a resolvable `redis.url_env`, otherwise the
config is rejected at load time.

:::tip[Sharing Redis across environments]
When sharing one Redis across multiple environments, use a unique `key_prefix`
for each so catalog keys do not collide.
:::

## `storage.object`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | enum | `filesystem` | `filesystem` (available) or `s3` (reserved). |
| `filesystem.root` | string | `/app/data/objects` | Local directory root. |
| `s3.endpoint_url_env` | string | – | Name of the env var holding the S3 endpoint URL. |
| `s3.bucket` | string | – | Bucket name. |
| `s3.region_env` | string | – | Name of the env var holding the region. |
| `s3.access_key_id_env` | string | – | Name of the env var holding the access key id. |
| `s3.secret_access_key_env` | string | – | Name of the env var holding the secret access key. |
| `s3.force_path_style` | bool | – | Use path-style addressing (MinIO / RustFS / many S3-compatible endpoints). |

S3 fields are **reserved** — they validate but are not yet used by runtime
features.

## `storage.retention`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `deleted_project_grace_days` | int ≥ 0 | `30` | Hard-delete soft-deleted projects after this many days. |
| `recent_runs.max_count` | int 1–1000000 | `2000` | Most recent run details to retain. |
| `recent_runs.max_age_months` | int 1–1200 | `6` | Maximum age of run details, measured from start time. |
| `events.max_count` | int 1–1000000 | `2000` | Most recent received events to retain. |
| `events.max_age_months` | int 1–1200 | `6` | Maximum age of events, measured from receipt time. |
| `queue.max_count` | int 1–1000000 | `1000` | Most recent terminal automatic-commit batches to retain. |
| `queue.max_age_months` | int 1–1200 | `6` | Maximum age of terminal batch history, measured from creation time. |

History expires when **either** limit is exceeded. Months are calendar months in
UTC, with the day clamped to the last day of the target month. Counts apply to
the whole store across workspaces. Pending, running and retrying batches, and
batches still referenced by an active stream, are protected from history cleanup.

These six fields support YAML and database configuration. Database values take
precedence, including when YAML explicitly sets a value. In Admin → Config →
Advanced, edit the Storage fields or use **Reset database overrides** to fall
back to the YAML value, then the default when YAML omits it. Published changes
apply to subsequent history reads and cleanup; increasing a limit cannot restore
details that have already been removed. Storage connection settings remain
file-only bootstrap settings.

Recent Runs cleanup erases per-run display details while retaining accounting
facts, numeric usage and run IDs. Overview, Projects, Providers, daily rollups
and checkpoint deduplication continue to include older runs. Events are deleted;
Queue cleanup removes terminal batch details and outbox records but preserves
receipt and member identities needed to prevent duplicate analysis. This policy
does not remove run-directory artifacts or all accounting rows from the database.

Startup, a 60-second maintenance timer and history reads perform bounded cleanup
(up to 500 records per category per sweep). Reads enforce the configured limits
even while an older cleanup backlog remains. The three panels fetch 20 rows per
page from server-side indexed queries, so retaining the default 2000/2000/1000
records does not load the full history into the browser. SQL uses time/ID indexes;
Redis uses status sorted sets, backfilled on first startup after upgrade.

## Backends at a glance

| Backend | Wired in | Reserved | Notes |
| --- | --- | --- | --- |
| database | `sqlite`, `postgres` | — | SQLite at `/app/data/aicr.sqlite` by default; Postgres via `postgres.url_env`. |
| cache | `memory`, `redis`, `none` | — | Redis reused by the model catalog Redis backend. |
| object | `filesystem` | `s3` | Filesystem at `/app/data/objects` by default. |
