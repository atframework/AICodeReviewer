---
title: 存储
description: 配置 storage 命名空间下的 database、cache、object 三类后端与 retention 保留策略。
---

`storage` 命名空间配置三个相互独立的后端——数据库、缓存和对象存储——外加一项保留
策略。它们支撑可观测性看板、模型元数据目录和反思记忆。当配置了 admin 鉴权、
`llm.model_catalog` 使用 SQLite 后端、启用反思记忆，或启用数据库配置源
（`config_sources.database.enabled: true`）时，数据库会自动创建。

:::note[各后端的接入程度不同]
`sqlite` 与 `postgres` 都已接入运行时数据库（仪表盘统计、模型目录、反思记忆、评审延期、webhook 事件）。缓存的 `redis` 已接入，供模型目录的 Redis 后端使用。
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

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | enum | `sqlite` | `sqlite` 或 `postgres`。 |
| `sqlite.path` | string | `/app/data/aicr.sqlite` | SQLite 数据库文件路径。 |
| `postgres.url_env` | string | – | 存放 Postgres 连接 URL 的环境变量名。 |
| `migrate` | enum | `auto` | 启动 schema 模式：`auto` 应用待执行步骤；`verify` 在 schema 缺失、落后、漂移或版本过高时拒绝启动，不执行迁移。 |

SQLite 数据库按需自动创建，存放可观测性统计、带键的 `model_catalog` 表（当目录使用
SQLite 后端时）、反思记忆、延期审查、webhook 事件与配置版本/session。
PostgreSQL 支持相同业务合同。配置表和 PostgreSQL 业务表使用带 checksum 的
`schema_migrations`；SQLite 业务表保留历史名称账本 `_migrations`。
`aicr migrate --status|--check|--apply` 在两个后端均检查或升级 `config` 与
`store` 命名空间，无需启动服务，见 [CLI 参考](/zh-cn/reference/cli/)。

SQLite WAL 数据库应放在同一主机进程共享的本地文件系统。WAL 不支持网络文件系统；
WSL 数据库测试应使用 Linux 文件系统，避免 Windows 盘挂载。参见
[SQLite WAL 要求](https://www.sqlite.org/wal.html)。

### 升级兼容性

首次升级前，停止所有旧实例的入口与 claim，排空已接收任务，确认旧进程已退出后备份
数据库。迁移锁无法检测闲置旧进程。已验证的历史基线为提交 `c5d221c`：SQLite/
PostgreSQL 必须按上述停机顺序升级，旧程序会拒绝重新打开 schema 2。Redis 保持
既有键和 JSON 格式，两版本均可读写 v1/v2 文档，并由 CAS 保护冲突。其他版本组合
需要各自的兼容性测试。

SQL 账本记录最低 reader/writer 协议和事务模式，当前读写协议均为 1，缺少字段的
历史记录按协议 1 解释。仅支持原子 SQL 迁移。PostgreSQL 迁移锁最多等待 5 秒，
迁移语句最多执行 30 秒。`migrate --status` 报告兼容状态；`--check`/`--apply`
拒绝不兼容要求。数据库文档/有效配置读写范围为 v1–v2；原始配置文件仍使用 v1。

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

配置源的 Redis 后端（`config_sources.database.backend: redis`）同样复用这份
连接声明：要求 `storage.cache.kind: redis` 且 `redis.url_env` 可解析，否则配置
在加载时即被拒绝。

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
| `recent_runs.max_count` | int 1–1000000 | `2000` | 保留最近的逐次运行详情数量。 |
| `recent_runs.max_age_months` | int 1–1200 | `6` | 运行详情最长保留月数，从运行开始时间计算。 |
| `events.max_count` | int 1–1000000 | `2000` | 保留最近的接收事件数量。 |
| `events.max_age_months` | int 1–1200 | `6` | 事件最长保留月数，从接收时间计算。 |
| `queue.max_count` | int 1–1000000 | `1000` | 保留最近的已结束自动提交批次数量。 |
| `queue.max_age_months` | int 1–1200 | `6` | 已结束批次历史最长保留月数，从批次创建时间计算。 |

数量或时长**任一超限**即淘汰。月数按 UTC 日历月计算，目标月份没有对应日期时取该月
最后一天。数量上限覆盖同一 store 中的所有 workspace。等待、运行、待重试批次以及仍被
stream 的活动指针引用的批次不受历史清理影响。

这六项同时支持 YAML 和数据库配置；即使 YAML 显式设置了值，数据库值仍优先。
在 Admin → Config → Advanced 的 Storage 字段中修改，使用 **Reset database overrides**
清除数据库覆盖后，回退到 YAML 值；YAML 未设置时使用默认值。发布后，后续历史查询和
清理使用新策略。提高上限不能找回已淘汰的详情。存储连接设置仍属于只读的文件启动配置。

Recent Runs 清理逐次运行的展示详情，保留统计事实、数值用量和 run ID；Overview、
Projects、Providers、每日汇总和检查点去重仍计入旧运行。Events 删除事件记录；Queue
删除已结束批次详情和 outbox，保留防止重复分析所需的 receipt 与成员身份。此策略不删除
运行目录产物，也不清空数据库中的全部统计记账行。

启动时、每 60 秒和历史查询前执行有界清理，每轮每类最多处理 500 条。即使升级后存在
清理积压，查询仍立即遵循配置上限。三个面板均从服务端按页取 20 条；默认保留
2000/2000/1000 条不会把全部历史加载到浏览器。SQL 使用时间/ID 索引，Redis 使用状态
有序集合；升级后的首次启动会为既有 Redis 批次回填索引。

## 后端一览

| 后端 | 已接入运行时 | 预留 | 说明 |
| --- | --- | --- | --- |
| database | `sqlite`、`postgres` | — | 默认 SQLite 位于 `/app/data/aicr.sqlite`；Postgres 经 `postgres.url_env`。 |
| cache | `memory`、`redis`、`none` | — | Redis 与模型目录 Redis 后端共用。 |
| object | `filesystem` | `s3` | 默认 filesystem 位于 `/app/data/objects`。 |
