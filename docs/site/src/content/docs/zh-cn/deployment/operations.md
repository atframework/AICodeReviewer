---
title: 运维与安全
description: 可观测性 dashboard 与 metrics、管理员认证、secret scrubber、沙箱安全模型、socket 风险、备份与升级/回滚。
---

本页介绍 AICR 部署上线后的日常运维：可观测性 dashboard 与 Prometheus metrics 端点、管理员认证、
secret scrubber、沙箱安全模型、Podman/Docker socket 威胁模型、备份，以及升级/回滚。

## 可观测性 dashboard

设置 `admin.username_env` 加上 `admin.password_env` 或 `admin.password_hash_env` 之一，即可启用内置
dashboard。该 dashboard 是独立的超级管理员界面 — 它**不**复用 webhook HMAC 或 trigger API key
（参见 [身份认证与密钥](/zh-cn/configuration/authentication/)）。

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/dashboard` 与 `/` | GET | 提供内嵌的 SPA |
| `/api/admin/login` | POST | 返回 Bearer 会话令牌 |
| `/api/admin/stats` | GET | 全部时间、今天、本周、本月的统计，外加项目 / provider / 最近运行数据 |

### 管理员认证

生产环境优先使用 `password_hash_env`（格式 `sha256:<hex>`）；小型内部部署允许使用原始密码 env，但会
以常数时间摘要比较、限流，并且绝不记录日志。

:::caution[会话 TTL 单位是秒]
管理员会话 TTL 字段是 `session_ttl_seconds`（默认 `86400` = 24 小时）。名为 `session_ttl_minutes`
的字段会被**忽略**。如果你复制了使用分钟的旧示例，会话不会按你期望的间隔过期。
:::

生成 sha256 密码哈希：

```bash
node -e "console.log('sha256:' + require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" 'your-password'
```

## Prometheus metrics

服务端暴露了一个 Prometheus 兼容的 `/metrics` 端点。在你现有的 Prometheus/Grafana 技术栈中，把它与
`/healthz`（用于存活检测）一起抓取即可。

## SQLite 存储

内置存储是 SQLite + Drizzle，路径由 `storage.database.sqlite.path` 控制（默认
`/app/data/aicr.sqlite`）。配置 schema 已经在顶层 `storage.*` 下预留了 Postgres、Redis 缓存和
S3 兼容对象存储，但 dashboard 运行时目前**仅使用 SQLite**。

密钥请保留在 `.env` 中；`config.yaml` 应只包含环境变量名。

## Secret scrubber

AICR 在四个边界对已知密钥进行脱敏，之后再持久化或输出内容：

| 边界 | 脱敏内容 |
| --- | --- |
| Prompt | 交给 agent 的指令负载 |
| Log | 写入应用日志的任何内容 |
| Template | 渲染后的 output-channel 模板 |
| Output | 最终发布的报告（PR 评论、飞书卡片等） |

:::note[这是纵深防御，而非最小暴露]
scrubber 是**纵深防御**措施，不能替代最小暴露原则。无论如何都应坚持最小权限：

- 每个 VCS provider 使用只读、受限的出站令牌。
- 使用专用、受限的 P4/SVN 服务账号。
- LLM 密钥仅限定在 AICR 实际使用的模型上。

scrubber 用于捕获意外泄露；它无法撤销被故意放进 prompt 或提交进被审查文件中的密钥。
:::

## 沙箱安全模型

每个 agent 运行都可以隔离在沙箱容器中。该安全模型在 `native`、`docker`、`docker_socket` 和
`podman` 后端上都成立：

- **命令白名单。** 在调用任何容器引擎之前，会先针对 `ALLOWED_COMMANDS` 检查容器命令。未知命令在
  预检阶段失败。
- **只读 `source/`。** 源码以只读方式挂载到 `/workspace/source`。agent 无法修改被审查的代码。
- **隔离的 cwd。** `agent/` 和 `tmp/` 是仅有的可写 workspace 挂载；工作目录按每次运行进行范围隔离。
- **env 文件位于挂载之外。** 临时 `--env-file` 文件创建在挂载的 workspace 目录**之外**，并在运行后
  删除，因此被攻破的 agent 无法从 workspace 树读取同级运行的密钥。
- **超时清理。** `agent.timeout_seconds` 会触发整棵进程树的杀死 — agent 二进制及其 worker 子进程 —
  因此运行无法通过遗留孤儿 worker 来超支。参见
  [Docker 部署](/zh-cn/deployment/docker/#agent-超时与进程清理)。

## Podman / Docker socket 风险

嵌套容器沙箱（见 [Docker](/zh-cn/deployment/docker/) 与 [Podman](/zh-cn/deployment/podman/)）需要
把宿主 Podman 或 Docker socket 挂载进 AICR 容器。**该 socket 是对宿主容器引擎的完整、root 等效
访问** — 谁能与它对话，谁就能以拥有该 socket 的宿主用户身份启动容器并运行任意代码。

仅在你完全可控的宿主上启用嵌套容器沙箱，并尽可能优先使用 rootless 用户级 Podman socket
（`/run/user/$UID/podman/podman.sock`），而不是系统级 Docker socket。

## 数据目录备份

备份三个挂载的数据卷即可。它们包含了 AICR 持久化的全部内容：

| 卷 | 容器路径 | 内容 |
| --- | --- | --- |
| `aicr-data` | `/app/data` | SQLite 存储、运行历史、队列状态 |
| `aicr-workspaces` | `/app/workspaces` | 克隆仓库 / 检出缓存 |
| `aicr-logs` | `/app/logs` | 应用日志文件 |

一个最小的离线备份：

```bash
docker run --rm -v aicr-data:/data -v "$PWD/backup:/backup" alpine \
  tar czf /backup/aicr-data-$(date +%F).tgz -C /data .
```

`config.yaml` 和 `.env` 在宿主上（通常在 `example/` 下）— 请单独备份。它们不属于命名卷。

:::tip[恢复顺序]
先停止容器，恢复三个卷，再启动容器。SQLite 存储承载了运行状态，因此在服务端运行期间恢复它会造成
状态撕裂。
:::

## 升级与回滚

由于 `config.yaml` 和 `.env` 是**卷挂载**的（不是固化进镜像的），升级有两条通道：

| 变更类型 | 流程 |
| --- | --- |
| **仅配置**（LLM 模型、triggers、outputs、新增 workspace、标签规则等） | 编辑 `config.yaml` 和/或 `.env`，然后重启容器。无需重新构建。 |
| **代码变更**（新的 AICR 版本、Dockerfile / 工具列表变更） | `docker build -t aicodereviewer -f deploy/Dockerfile .`，然后重启容器。 |

仅配置变更的重启：

```bash
docker restart aicr
```

回滚按相反顺序同理操作：保留上一版本的镜像标签，对相同的卷 `docker run` 旧镜像即可。因为状态位于
卷中（而非镜像中），只要 SQLite schema 没有发生不可逆的前向迁移，镜像回滚不会丢失运行历史 — 因此
在部署会带来 schema 迁移的新镜像之前，先对 `aicr-data` 卷做一次快照。
