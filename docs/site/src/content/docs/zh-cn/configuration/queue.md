---
title: 队列与重试
description: 配置内存或持久化 SQLite 队列、worker 并发、限流，以及重试/死信策略。
---

`queue` 命名空间决定评审任务在哪里排队、同时跑多少个、对每个 provider 的调用多快、
以及任务失败时怎么重试。默认是内存队列；生产环境建议切换到持久化 SQLite 队列，
让任务在重启后仍然存在。

```yaml
queue:
  kind: sqlite              # memory（默认）| sqlite | redis

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

| 取值 | 说明 |
| --- | --- |
| `memory`（默认） | 进程内队列，重启即丢失。适合单实例开发。 |
| `sqlite` | 持久化队列，重启后仍在（单进程或多进程共享同一文件）。生产推荐。 |
| `redis` | 持久化到 Redis，适合多实例部署。配置见下。 |
| `rabbitmq` | 预留——尚未实现，配置了会告警并回退到 `memory`。 |

### `queue.redis` —— Redis 队列选项

Redis 队列的连接字段以透传方式接受：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url_env` | string | – | 存放 Redis URL 的环境变量名。 |
| `url` | string | – | 直接写 Redis URL（也可拆成 `host` / `port` / `password` / `db`）。 |
| `tls` | bool | `false` | 使用 TLS 连接。 |
| `key_prefix` | string | `"aicr:"` | 队列键前缀。共享 Redis 时请按环境取唯一值。 |

## `queue.workers`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `concurrency` | int > 0 | `4` | 全局 worker 并发（进程内同时运行的任务数）。 |
| `per_workspace_concurrency` | int > 0 | `1` | 每个 workspace 同时运行的任务上限。设为 `1` 可按仓库串行。 |
| `lock_ttl_seconds` | int > 0 | `1800` | worker 任务锁 TTL。 |

## `queue.sqlite` —— 持久化队列选项

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `path` | string | `data/queue.sqlite` | 队列使用的 SQLite 数据库文件。 |
| `lock_ttl_seconds` | int > 0 | `300` | 陈旧运行回收 TTL。运行锁早于该时长的任务视为崩溃并被回收。 |

### SQLite 持久化队列的工作原理

SQLite 队列基于 [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，
单进程或多个进程共享同一文件都安全。关键特性：

- **经 `UPDATE ... RETURNING` 原子领取。** worker 用单条语句领取下一个 queued
  任务并标记为 `running`，因此两个 worker 永远不会抢到同一个任务。
- **锁 TTL 后回收陈旧任务。** 后台扫描会把运行锁早于 `lock_ttl_seconds` 的
  `running` 任务重新入队，因此崩溃 worker 的任务最终会被其他 worker 重试。
- **WAL + `busy_timeout` 保证跨进程安全。** 队列以 `PRAGMA journal_mode = WAL`
  和 `PRAGMA busy_timeout = 5000` 打开，来自不同进程的并发写入会协作而非报错。

## `queue.rate_limit`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `per_provider_rps` | map<string, number> | 按 provider id 设置的每秒请求数上限。 |

```yaml
queue:
  rate_limit:
    per_provider_rps:
      gitea-internal: 5      # 对 gitea-internal provider 最多 5 rps
```

## `queue.retry` —— 请用 `attempts` + `backoff`

:::important[规范字段]
规范的重试字段是 **`attempts`** 与 **`backoff`**。旧字段
`max_attempts` / `backoff_seconds` 仍然会被接受并归一化，但**已弃用**——
请迁移到 `attempts` + `backoff`。
:::

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `attempts` | int > 0 | `3` | 总尝试次数（含首次）。`1` = 不重试。 |
| `backoff.kind` | enum | `exponential` | `exponential`、`linear` 或 `constant`。 |
| `backoff.base_ms` | number > 0 | `2000` | 首次/基础退避延迟（毫秒）。 |
| `backoff.max_ms` | number > 0 | `60000` | 单次退避延迟上限。 |
| `backoff.jitter` | bool | `true` | 是否加入随机抖动。 |

```yaml
queue:
  retry:
    attempts: 2              # 瞬时失败重试一次（1 = 不重试）
    backoff:
      kind: exponential
      base_ms: 5000
      max_ms: 60000
      jitter: true
```

### 旧字段（已弃用，会被归一化）

为向后兼容，加载器仍会读取并归一化这些字段，但新配置不应再使用：

| 旧字段 | 归一化为 |
| --- | --- |
| `max_attempts` | `attempts`（向下取整）。 |
| `backoff_seconds` | 一个 `constant` 退避，`base_ms = max_ms = backoff_seconds * 1000`，`jitter: false`。 |

两者同时存在时，`attempts` / `backoff` 始终优先。

## `queue.dead_letter` —— 预留，尚未生效

schema 接受 `dead_letter.enabled` 和 `dead_letter.max_age_hours` 两个字段，但当前
运行时没有消费它们：重试耗尽的任务按失败处理并写入运行历史，没有独立的停放区。
这两个字段保留给后续版本，现在配置不会产生任何行为。
