---
title: Dashboard 与日志
description: 启用可观测性 dashboard、导航它、读取 /metrics，并定位 run 日志与快照。
---

AICR 内置可观测性 dashboard 和 Prometheus metrics 端点。dashboard 是外部时序系统的补充（不是替代）——未配置外部系统时仍能提供基础统计。本页在[快速上手](/zh-cn/start/quick-start/)的健康检查基础上，介绍如何启用管理员登录、导航 dashboard、读取 `/metrics`，以及定位 run 日志和快照。

## 启用管理员登录

dashboard 有独立于 webhook HMAC 和 trigger API key 的超级管理员登录。设置管理员环境变量即可启用：

```bash
# .env
AICR_ADMIN_USERNAME=admin
AICR_ADMIN_PASSWORD=<强密码>
# 或改用哈希（优先级更高）：
# AICR_ADMIN_PASSWORD_HASH=sha256:<hex>
```

对应 config（默认值已显示）：

```yaml
admin:
  username_env: AICR_ADMIN_USERNAME
  password_env: AICR_ADMIN_PASSWORD
  password_hash_env: AICR_ADMIN_PASSWORD_HASH   # 可选，优先级更高
  session_ttl_seconds: 86400                      # 字段单位是秒，不要用 minutes
```

:::note[用 `session_ttl_seconds`，不是 minutes]
session TTL 字段是 `session_ttl_seconds`（默认 `86400` = 24 小时）。`session_ttl_minutes` 字段会被静默忽略。密码比较使用固定长度 SHA-256 digest 和 `timingSafeEqual`；服务端永不打印或落盘密码原值。
:::

配置管理员认证后，AICR 初始化支撑 dashboard 的 SQLite store（位于 `storage.database.sqlite.path`，默认 `/app/data/aicr.sqlite`）。Postgres 和 Redis 后端是预留扩展位；dashboard 运行时当前要求 SQLite——启用 dashboard 而 `storage.database.kind` 不是 `sqlite` 时启动会显式失败。

## 导航 dashboard

访问 `http://<aicr-host>:8080/dashboard`（或 `/`）。即使尚未配置管理员环境变量，该路由也会返回 dashboard 外壳并显示 setup-required 提示而不是 404；如果设置了 `path_prefix`，根路径会重定向到带前缀的入口。

登录后，dashboard 有四个标签：

- **Overview**——总评审次数、成功/失败/跳过次数、发现问题的 run 次数、problem 总数、创建 issue 数、分析代码量、LLM 请求数、输入/输出/总 token、估算成本、平均 duration。时间窗口选择器切换 today / this week / this month / all（均按 UTC）。
- **Projects**——按 project 聚合（`workspaceId + triggerName + repoRef`）：评审/成功/失败/跳过次数、problem 总数、创建 issue 数、变更文件数、增删行数、LLM 请求数、token、成本、平均 duration。软删除的 project 在宽限期内仍可见，并用 `isActive` 标记。
- **Providers**——按 provider+model 聚合：请求数、输入/输出 token、成本、重试/fallback/失败次数、平均延迟。
- **Runs**——最近运行列表（通过 `?limit=` 最多 100 条）。

用量按完整 review run 聚合，包括首次模型调用、上下文/格式修复调用以及最终直连 LLM 兜底。
对 Kilo 而言，每个 `step_finish` 模型回合计为一次请求。本地 prompt 大小估算单独保存，只有拿不到
真实 usage 时才作为参考显示，绝不会混入 provider token 总数。

Projects 和 Providers 标签各自调用带时间窗口的 API
（`GET /api/admin/stats/projects?since=` 和 `.../providers?since=`）。dashboard 以实时聚合为真源。

## 管理 API

除 `/login` 外所有端点都需要 `Authorization: Bearer <token>`。

| 端点 | 用途 |
| --- | --- |
| `POST /api/admin/login` | 校验用户名/密码，返回 session token + 过期时间 |
| `POST /api/admin/logout` | 撤销 session token |
| `GET /api/admin/stats` | overview + today/this-week/this-month 窗口、projects、providers、最近 run |
| `GET /api/admin/stats/projects?since=` | 按 project 聚合 |
| `GET /api/admin/stats/providers?since=` | 按 provider+model 聚合 |
| `GET /api/admin/runs?limit=` | 最近 run 列表（1..100） |

## `/metrics`

`/metrics` 暴露低基数、进程生命周期的 Prometheus 计数器和直方图，覆盖同步和异步 review run。高基数查询（按 project、按 provider）属于 dashboard 背后的 SQLite store，不属于 `/metrics`。直方图 bucket、sum、count 按进程生命周期累计；仅原始 duration 样本做滑动窗口裁剪。

dashboard 只保存运行和用量元数据——绝不保存 prompt、完整 diff、secret 或未脱敏输出。

## run 日志与快照在哪里

按 run 的产物位于 workspace 目录下：

```text
workspaces/<workspace_id>/runs/<run_id>/run.json
```

`run.json` 是某次 run 的审计快照：target/workspace、provider/model、`triggerName`、产出与错误摘要、解析到的 model-catalog 来源、token 估算和分派计数。该 run 物化的 agent 运行时 bundle 位于 `workspaces/<workspace_id>/agent/`（instructions、技能、MCP 配置、`manifest.json`、`.aicr-output-state.json`）。

服务级日志进入 `aicr-logs` 卷（容器内 `/app/logs`）；用 `docker compose logs -f` 或你的容器运行时日志驱动查看。

## 下一步

- [配置字段参考](/zh-cn/reference/config-fields/)——`admin` 和 `storage` 命名空间。
- [常见问题](/zh-cn/troubleshooting/)——用 dashboard 和 run 快照诊断跳过的 run 和分派失败。
