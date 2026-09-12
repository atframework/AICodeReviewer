---
title: Dashboard 与日志
description: 启用可观测性 dashboard、导航它、读取 /metrics，并定位 run 日志与快照。
---

AICR 内置可观测性 dashboard 和 Prometheus metrics 端点。dashboard 覆盖基础统计；
有外部时序系统时两者可以互补。本页在[快速上手](/zh-cn/start/quick-start/)的健康检查基础上，介绍如何启用管理员登录、导航 dashboard、读取 `/metrics`，以及定位 run 日志和快照。

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

配置管理员认证后，AICR 初始化支撑 dashboard 的 SQLite store（位于 `storage.database.sqlite.path`，默认 `/app/data/aicr.sqlite`）。数据库后端目前只有 `sqlite` 接入运行时（`postgres` 是预留）——启用 dashboard 而 `storage.database.kind` 不是 `sqlite` 时启动会显式失败。

## 导航 dashboard

访问 `http://<aicr-host>:8080/dashboard`（或 `/`）。即使尚未配置管理员环境变量，该路由也会返回 dashboard 外壳并显示 setup-required 提示而不是 404；如果设置了 `path_prefix`，根路径会重定向到带前缀的入口。

登录后，dashboard 有六个标签：

- **Live**——当前服务进程中正在执行的分析。卡片随屏幕宽度排列，展示 worker 槽位、run ID、任务标题、attempt、workspace/trigger/repo、分支和 revision（git 短 sha、SVN `r<N>`、P4 `CL <N>`，悬停显示完整 revision）、提交时间、model 与 agent、phase（preparing → analyzing → publishing）、开始时间及耗时。指标包括输入/输出 token、缓存命中/未命中/写入量、命中率、LLM 请求数、重试/fallback 次数、估算成本及用量更新时间；usage 缺失时单独显示 `~N est. prompt`。worker 编号代表本进程的活动分析槽位，任务结束后可复用。Kilo/OpenCode 和 pi/oh-my-pi 每完成一个模型回合便更新用量，其他 agent 和直连 LLM 在调用结束时更新。执行结束或服务重启后条目消失。Refresh 手动刷新；自动刷新默认 **Off (manual)**，可选前次请求结束后每 5/15/30/60 秒刷新。离开 Live 或隐藏浏览器页面时暂停，退出登录恢复手动模式；刷新失败时保留的快照标为过期。
- **Overview**——总评审次数、成功/失败/跳过次数、发现问题的 run 次数、problem 总数、创建 issue 数、分析代码量、LLM 请求数、输入/输出/总 token、prompt 缓存命中率（含命中/未命中 token 拆分）、估算成本、平均 duration。时间窗口选择器切换 today / this week / this month / all（均按 UTC）。Recent activity 表格与 Runs 标签一样展示每条 run 的总 token、缓存命中/未命中拆分与命中率，外加分支、缩写 revision 与提交时间。
- **Projects**——按 project 聚合（`workspaceId + triggerName + repoRef`）：评审/成功/失败/跳过次数、problem 总数、创建 issue 数、变更文件数、增删行数、LLM 请求数、token、缓存命中 token 与命中率、成本、平均 duration。软删除的 project 在宽限期内仍可见，并用 `isActive` 标记。
- **Providers**——按 provider+model 聚合：请求数、输入/输出 token、缓存命中 token 与命中率、成本、重试/fallback/失败次数、平均延迟。
- **Runs**——最近 100 条运行记录，每页 20 条，用 Prev/Next 翻页。每行展示真实 token 用量：总 token、命中/未命中输入拆分与命中率；run 未上报可解析 usage 时显示 `—`。Revision 列展示分支、缩写 revision，以及 VCS adapter 解析成功时的提交时间。
- **Events**——最近收到的 100 条 webhook/trigger 事件，每页 20 条。每行展示接收时刻的处理决定：`executed`（立即执行）、`queued`/`duplicate`（auto-commit 回执）、`deferred`（执行窗口延期，含计划恢复时刻）、`deduplicated`（合并进待重审）、`ignored`（label 忽略、不支持的事件、仓库未配置）或 `rejected`（签名无效、payload 非法、触发器未配置），以及原因和细节（命中的 label、回执 id 等）。

用量按完整 review run 聚合，包括首次模型调用、上下文/格式修复调用以及最终直连 LLM 兜底。
对 Kilo 而言，每个 `step_finish` 模型回合计为一次请求。本地 prompt 大小估算单独保存，只有拿不到
真实 usage 时才作为参考显示，绝不会混入 provider token 总数。

缓存命中 token 已含在输入总量内：命中率 = `命中 token / 输入 token`，未命中输入 =
`输入 - 命中 - 缓存写入` token。provider 尚未上报非零输入的 usage 时命中率显示 `—`。

Projects 和 Providers 标签各自调用带时间窗口的 API
（`GET /api/admin/stats/projects?since=` 和 `.../providers?since=`）。Runs 标签通过
`GET /api/admin/runs?limit=100` 拉取最近 100 条并在浏览器内分页；Events 标签同样通过
`GET /api/admin/events?limit=100` 拉取，其存储只保留最新 100 条。Live 标签轮询
`GET /api/admin/runs/live`，读取当前进程的内存注册表。已结束的 run 可在 Recent Runs
的保留范围内查询。dashboard 以实时聚合为真源。

分支随 webhook 事件携带，实际分析的 head revision 和 VCS 类型来自 adapter 解析的范围和类型。
提交时间由 VCS adapter 在 scoped fetch 后尽力解析（`git log` / `svn log` / `p4 describe`）：
Git 取 committer date，SVN 取 `svn:date`，P4 仅对 submitted changelist 展示提交时间。
时间按浏览器本地时区显示。无法解析的提交时间显示 `—`；旧记录或未知 VCS 类型保留完整
revision，不按字符串形状猜测 hash 格式。

## 管理 API

提交事件的 **not before** 表示首次接收延迟和执行窗口共同决定的最早可执行时间，
已有任务仍可能让实际开始时间更晚。

除 `/login` 外所有端点都需要 `Authorization: Bearer <token>`。

| 端点 | 用途 |
| --- | --- |
| `POST /api/admin/login` | 校验用户名/密码，返回 session token + 过期时间 |
| `POST /api/admin/logout` | 撤销 session token |
| `GET /api/admin/stats` | overview + today/this-week/this-month 窗口、projects、providers、最近 run |
| `GET /api/admin/stats/projects?since=` | 按 project 聚合 |
| `GET /api/admin/stats/providers?since=` | 按 provider+model 聚合 |
| `GET /api/admin/runs?limit=` | 最近 run 列表（1..100），含 token 用量、缓存命中拆分与 VCS stamp |
| `GET /api/admin/runs/live` | 进程内注册表中正在执行的分析：phase、开始时间、累计 token/请求数/成本 |
| `GET /api/admin/events?limit=` | 最近 webhook/trigger 事件日志（1..100），含接收时刻的处理决定与原因 |

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
