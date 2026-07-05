---
title: 队列与重试
description: 配置内存或持久化 SQLite 队列、worker 并发、限流，以及重试/死信策略。
---

`queue` 命名空间决定评审任务在哪里排队、同时跑多少个、对每个 provider 的调用多快、
以及任务持续失败时怎么处理。默认是内存队列；生产环境建议切换到持久化 SQLite 队列，
让任务在重启后仍然存在。

```yaml
queue:
  kind: memory              # memory（默认）| sqlite | redis（预留）

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

| 取值 | 说明 |
| --- | --- |
| `memory`（默认） | 进程内队列。重启即丢失。适合单实例开发。 |
| `sqlite` | 持久化队列，重启后仍在（单进程或多个进程共享同一文件）。生产推荐。 |
| `redis` | 预留——schema 中存在，尚未实现。 |
| `rabbitmq` | 预留——尚未实现。 |

## `queue.workers`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `concurrency` | int > 0 | – | 全局 worker 并发（进程内同时运行的任务数）。 |
| `per_workspace_concurrency` | int > 0 | – | 每个 workspace 同时运行的任务上限。设为 `1` 可按仓库串行。 |
| `lock_ttl_seconds` | int > 0 | – | SQLite 队列运行锁的陈旧回收 TTL。 |

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
| `attempts` | int > 0 | – | 总尝试次数（含首次）。`1` = 不重试。 |
| `backoff.kind` | enum | – | `exponential`、`linear` 或 `constant`。 |
| `backoff.base_ms` | number > 0 | – | 首次/基础退避延迟（毫秒）。 |
| `backoff.max_ms` | number > 0 | – | 单次退避延迟上限。 |
| `backoff.jitter` | bool | – | 是否加入随机抖动。 |

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

## `queue.dead_letter`

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | – | 为 `true` 时，重试耗尽的任务会被停放以供排查，而不是直接丢弃。 |
| `max_age_hours` | int > 0 | – | 早于该时长的停放项会被清理。 |

```yaml
queue:
  dead_letter:
    enabled: true
    max_age_hours: 72
```
