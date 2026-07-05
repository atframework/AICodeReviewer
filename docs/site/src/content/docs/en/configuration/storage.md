---
title: Storage
description: Configure the database, cache, and object storage backends.
---

The `storage` namespace configures three independent backends — a database, a
cache, and an object store — plus a retention policy. These back the
observability dashboard, the model metadata catalog, reflection memory, and
future features. The database is created automatically when admin auth is
configured, when `llm.model_catalog` uses the SQLite backend, or when
reflection memory is enabled.

:::note[M8 runtime uses SQLite only]
The M8 dashboard runtime currently uses **SQLite only**. PostgreSQL, Redis, and
S3 are **reserved** for future multi-instance deployments — the fields exist
and validate, but are not yet wired into runtime features.
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
```

## `storage.database`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | enum | `sqlite` | `sqlite` (available) or `postgres` (reserved). |
| `sqlite.path` | string | `/app/data/aicr.sqlite` | SQLite database file path. |
| `postgres.url_env` | string | – | Name of the env var holding the Postgres connection URL. **Reserved** for future multi-instance deployments. |

The SQLite database is created automatically when needed. It stores the
observability stats, the keyed `model_catalog` table (when the catalog uses
the SQLite backend), and reflection memory entries.

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
[/en/configuration/llm/](/en/configuration/llm/) for the catalog side.

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

## Backends at a glance

| Backend | Available now | Reserved | Notes |
| --- | --- | --- | --- |
| database | `sqlite` | `postgres` | SQLite at `/app/data/aicr.sqlite` by default. |
| cache | `memory`, `none` | `redis` | Redis reused by the model catalog Redis backend. |
| object | `filesystem` | `s3` | Filesystem at `/app/data/objects` by default. |
