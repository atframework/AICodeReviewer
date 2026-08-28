---
title: 存储
description: 配置 storage 命名空间下的 database、cache、object 三类后端与 retention 保留策略。
---

`storage` 命名空间配置三个相互独立的后端——数据库、缓存和对象存储——外加一项保留
策略。它们支撑可观测性看板、模型元数据目录和反思记忆。当配置了 admin 鉴权、
`llm.model_catalog` 使用 SQLite 后端，或启用反思记忆时，数据库会自动创建。

:::note[各后端的接入程度不同]
数据库目前只有 `sqlite` 接入了运行时（dashboard 统计、模型目录、反思记忆），
`postgres` 是预留。缓存的 `redis` 已接入，供模型目录的 Redis 后端使用。
对象存储的 `s3` 字段是预留——能通过校验，但运行时还没有消费它们。
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

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | enum | `sqlite` | `sqlite`（可用）或 `postgres`（预留）。 |
| `sqlite.path` | string | `/app/data/aicr.sqlite` | SQLite 数据库文件路径。 |
| `postgres.url_env` | string | – | 存放 Postgres 连接 URL 的环境变量名。为未来多实例部署**预留**。 |

SQLite 数据库按需自动创建，存放可观测性统计、带键的 `model_catalog` 表（当目录使用
SQLite 后端时）以及反思记忆条目。

## `storage.cache`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | enum | `memory` | `memory`、`redis` 或 `none`。 |
| `redis.url_env` | string | – | 存放 Redis URL 的环境变量名。`kind: redis` 时必填。 |
| `ttl_seconds` | int > 0 | – | 可选的默认缓存 TTL。 |

Redis 与模型目录的 Redis 后端（`llm.model_catalog.cache.backend: redis`）共用。
当目录使用 Redis 时，`storage.cache.kind` **必须**为 `redis` 且
`redis.url_env` **必须**可解析，否则配置在加载时即被拒绝。目录侧见
[LLM 提供方与模型](/zh-cn/configuration/llm/)。

:::tip[跨环境共享 Redis]
在多个环境间共享同一个 Redis 时，请为每个环境使用唯一的 `key_prefix`，避免目录键
冲突。
:::

## `storage.object`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | enum | `filesystem` | `filesystem`（可用）或 `s3`（预留）。 |
| `filesystem.root` | string | `/app/data/objects` | 本地目录根。 |
| `s3.endpoint_url_env` | string | – | 存放 S3 endpoint URL 的环境变量名。 |
| `s3.bucket` | string | – | bucket 名。 |
| `s3.region_env` | string | – | 存放 region 的环境变量名。 |
| `s3.access_key_id_env` | string | – | 存放 access key id 的环境变量名。 |
| `s3.secret_access_key_env` | string | – | 存放 secret access key 的环境变量名。 |
| `s3.force_path_style` | bool | – | 使用 path-style 寻址（MinIO / RustFS / 许多 S3 兼容端点）。 |

S3 字段为**预留**——会通过校验，但尚未被运行时特性使用。

## `storage.retention`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `deleted_project_grace_days` | int ≥ 0 | `30` | 软删除的项目在该天数后被硬删除。 |

## 后端一览

| 后端 | 已接入运行时 | 预留 | 说明 |
| --- | --- | --- | --- |
| database | `sqlite` | `postgres` | 默认 SQLite 位于 `/app/data/aicr.sqlite`。 |
| cache | `memory`、`redis`、`none` | — | Redis 与模型目录 Redis 后端共用。 |
| object | `filesystem` | `s3` | 默认 filesystem 位于 `/app/data/objects`。 |
