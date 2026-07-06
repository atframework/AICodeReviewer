---
title: 配置字段参考
description: 全量配置字段参考，按顶层命名空间组织，并以 Zod schema 为准审计。
---

本页是 `config.yaml` 的全量字段参考。代码真源是 `packages/core/src/config.ts` 中的 Zod schema。本页以该 schema 为准审计；当两者不一致时，**以 schema 为准**。各命名空间的叙述请跟随链接到对应配置页。

下面每个命名空间都链接到其叙述页，并列出 schema 校验的每个字段（类型、默认值、一句话描述）。没有 schema 默认值的可选字段在“默认值”列标记为 *—*。

## 枚举参考

这些枚举值出现在多个命名空间中，集中放在这里方便查阅。

| 概念 | 枚举值 |
| --- | --- |
| Trigger `kind` | `gitea`、`forgejo`、`github`、`gitlab`、`p4`、`svn`、`scheduled`、`manual` |
| Agent `kind` | `kilo`、`opencode`、`zoo`、`copilot-cli`、`claude-code` |
| Sandbox `kind` | `native`、`docker`、`podman`、`docker_socket`、`k8s_pod`、`firecracker` |
| Sandbox `engine` | `auto`、`docker`、`podman` |
| Queue `kind` | `memory`、`sqlite`、`redis`、`rabbitmq`（预留） |
| Storage `database.kind` | `sqlite`、`postgres` |
| Storage `cache.kind` | `memory`、`redis`、`none` |
| Storage `object.kind` | `filesystem`、`s3` |
| Model catalog `cache.backend` | `sqlite`、`redis`、`memory` |
| LLM provider `kind` | `openai_compatible`、`azure_openai`、`anthropic`、`vertex_ai`、`bedrock`、`google_ai_studio`、`ollama`、`copilot` |

:::note[Channel `kind` 是自由字符串]
输出 channel 的 `kind` 字段是受输出注册表约束的自由字符串，不是封闭枚举。内置 channel kind 包括
`gitea_pr_review`、`github_pr_review`、`gitlab_mr_review`、`gitea_issue`、`gitea_problem_issue`、
`github_issue`、`github_problem_issue`、`feishu_bot`、`wecom_bot`。已移除的 `gitea_finding_issue` kind 会被
校验拒绝；请使用 `gitea_problem_issue`。参见[输出通道](/zh-cn/configuration/outputs/)。
:::

## `llm`

叙述：[LLM 提供商与模型](/zh-cn/configuration/llm/)。

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `llm.providers[]` | array | `[]` | LLM provider 连接；每项有 `id`、`kind`，以及可选的 `base_url`、`api_key_env`、`api_version`、`catalog_provider`、`catalog_id` |
| `llm.providers[].id` | string | — | 被 `fallback_chain` 引用的 provider 标识 |
| `llm.providers[].kind` | enum | — | provider kind（见上方 LLM provider 枚举） |
| `llm.providers[].base_url` | URL | — | provider API base URL |
| `llm.providers[].api_key_env` | string | — | 持有 API key 的环境变量名 |
| `llm.providers[].api_version` | string | — | API 版本（Azure 等） |
| `llm.providers[].catalog_provider` | string | — | 覆盖 catalog 查询时的 models.dev provider id |
| `llm.providers[].catalog_id` | string | — | 覆盖 catalog 查询时的 models.dev `<provider>/<model>` id |
| `llm.fallback_chain[]` | array | `[]` | 失败时按序尝试的 provider/model 条目；每项有 `provider`、`model`、`role`（`light`/`heavy`/`any`） |
| `llm.retry` | object | — | 单次调用重试策略 |
| `llm.retry.max_attempts` | int > 0 | — | 单次 LLM 调用最大尝试次数 |
| `llm.retry.respect_retry_after` | boolean | — | 遵守 `Retry-After` 响应头 |
| `llm.retry.backoff` | object | — | `kind`（`exponential`/`linear`/`constant`）、`base_ms`、`max_ms`、`jitter` |
| `llm.retry.give_up_after_seconds` | number > 0 | — | 硬性挂钟放弃时间 |
| `llm.budget` | object | — | 预算上限 |
| `llm.budget.per_run_usd` | number ≥ 0 | — | 单次 run USD 上限 |
| `llm.budget.per_repo_daily_usd` | number ≥ 0 | — | 单仓每日 USD 上限 |
| `llm.per_provider_overrides` | map | — | 按 provider id 配置 `max_attempts` / `give_up_after_seconds` |
| `llm.model_catalog` | object | 见下 | models.dev 元数据 catalog |

### `llm.model_catalog`

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `llm.model_catalog.enabled` | boolean | `false` | 启用 models.dev 元数据查询 |
| `llm.model_catalog.source_url` | URL | `https://models.dev/api.json` | catalog 源 |
| `llm.model_catalog.refresh_interval_hours` | int > 0 | `24` | 刷新间隔 |
| `llm.model_catalog.fetch_timeout_ms` | int > 0 | `10000` | 拉取超时 |
| `llm.model_catalog.offline` | boolean | `false` | 永不访问网络；仅用缓存 + 打包快照 |
| `llm.model_catalog.apply_to_model_spec` | boolean | `true` | 将 catalog 元数据合并进解析后的 `ModelSpec` |
| `llm.model_catalog.cache.backend` | enum | `sqlite` | 刷新缓存后端；`redis` 需要 `storage.cache.kind: redis` + `redis.url_env` |
| `llm.model_catalog.overrides` | map | `{}` | 手填的按 `<provider>/<model>` 覆盖；显式值始终优先于 catalog 数据 |

## `triggers`

叙述：[VCS 提供商](/zh-cn/integrations/vcs-providers/)。

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `triggers[].name` | string | — | trigger profile 名；被 `workspaces.instances.<id>.source_repo.trigger` 引用 |
| `triggers[].kind` | enum | — | trigger kind（见枚举表） |
| `triggers[].watch_path` | string[] | — | 只分析这些 depot/仓库相对子路径下的文件 |
| `triggers[].include_cr_file` | string[] | — | glob 模式；文件必须至少匹配一个才会被分析 |
| `triggers[].exclude_cr_file` | string[] | — | glob 模式；匹配任一则跳过 |
| `triggers[].commit_url_template` | string | — | commit 链接的 URL 模板（变量会做 URL 编码） |
| `triggers[].revision_url_template` | string | — | revision 链接的 URL 模板 |
| `triggers[].change_url_template` | string | — | changelist 链接的 URL 模板（P4 Swarm 等） |

provider 专属字段（`webhook_secret_env`、`token_env`、`port`、`user_env`、`password_env`、`depot_path`、`workspace`、`repository_url`）通过 `passthrough` 校验接受，文档见[VCS 提供商](/zh-cn/integrations/vcs-providers/)与[认证与密钥](/zh-cn/configuration/authentication/)。

## `workspaces`

叙述：[配置总览](/zh-cn/configuration/overview/)。

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `workspaces.cache.max_total_gb` | number > 0 | `50` | workspace 缓存总大小上限（GB） |
| `workspaces.cache.eviction` | enum | `lru` | 淘汰策略：`lru`、`mru`、`ttl` |
| `workspaces.cache.ttl_days` | int > 0 | `30` | `ttl` 淘汰的 TTL（天） |
| `workspaces.defaults` | object | `{}` | 合并进每个 instance 的默认值（sandbox、review、agent、outputs、prompt） |
| `workspaces.defaults.sandbox` | object | — | 默认 sandbox 配置（见 `agent.sandbox`） |
| `workspaces.defaults.review` | object | — | 默认 review 配置（见 `review`） |
| `workspaces.defaults.agent.default` | enum | — | 这组 workspace 的默认 agent kind |
| `workspaces.defaults.outputs` | object | — | 默认 outputs（见 `outputs` 的 workspace 字段） |
| `workspaces.defaults.prompt.base_system_prompt_file` | string | — | 自定义 base system prompt 文件（相对于部署根目录） |
| `workspaces.defaults.prompt.force_skills` | string[] | — | 始终激活的技能名，忽略 `Applies To` glob |
| `workspaces.instances` | map | `{}` | 按 workspace id 组织的 instance |
| `workspaces.instances.<id>.source_repo.trigger` | string | — | trigger profile 名 |
| `workspaces.instances.<id>.source_repo.repo` | string | — | 仓库引用 |
| `workspaces.instances.<id>.agent.default` | enum | — | agent kind 覆盖 |
| `workspaces.instances.<id>.review` | object | — | review 配置覆盖（见 `review`） |
| `workspaces.instances.<id>.outputs` | object | — | outputs 覆盖 |
| `workspaces.instances.<id>.sandbox` | object | — | sandbox 覆盖 |
| `workspaces.instances.<id>.triage` | object | — | issue triage 覆盖（仅 Gitea/Forgejo） |
| `workspaces.instances.<id>.prompt` | object | — | prompt 覆盖（形状同 `workspaces.defaults.prompt`） |
| `workspaces.instances.<id>.auth.api_key_env` | string | — | workspace 级 API key 环境变量 |
| `workspaces.instances.<id>.auth.enabled` | boolean | `true` | 切换 workspace 级 API key |

workspace id 不能与保留键 `cache`、`defaults`、`instances` 冲突。

## `outputs`

叙述：[输出通道与路由](/zh-cn/configuration/outputs/)。

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `outputs.template_engine` | enum | `handlebars` | 模板引擎：`handlebars` 或 `eta` |
| `outputs.no_problems` | object | — | 全局零问题策略 |
| `outputs.no_problems.action` | enum | — | `publish`、`suppress` 或 `publish_if_summary` |
| `outputs.channels[]` | array | `[]` | 输出 channel 定义 |
| `outputs.channels[].name` | string | — | 用于路由和模板解析的 channel 名 |
| `outputs.channels[].kind` | string | — | channel kind（自由字符串；受输出注册表约束） |
| `outputs.channels[].trigger` | string | — | 该 channel 绑定的 trigger 名 |
| `outputs.channels[].mention_author` | boolean | — | `@` mention 解析出的提交作者 |
| `outputs.channels[].mention_fallback` | enum | — | 作者无法解析时取 `all` 或 `skip` |
| `outputs.channels[].no_problems` | object | — | channel 级零问题策略 |
| `outputs.channels[].commit_url_template` | string | — | commit 链接模板 |
| `outputs.channels[].revision_url_template` | string | — | revision 链接模板 |
| `outputs.channels[].change_url_template` | string | — | changelist 链接模板 |
| `outputs.channels[].marker_prefix` | string | — | managed issue 标题前缀（默认 `[AICR]`） |
| `outputs.channels[].marker_label` | string | — | 用于界定 managed issue 的隐藏 body 标记 |
| `outputs.channels[].label_ids` | int[] | — | 要附加的 Gitea label ID |
| `outputs.channels[].labels` | string[] | — | 要附加的 GitHub label 名 |
| `outputs.channels[].issue_mode` | enum | — | `per_problem`、`consolidated`、`per_commit` |
| `outputs.channels[].resolved_action` | enum | — | `none`、`close`、`mark_resolved`、`delete`（仅 Gitea） |
| `outputs.channels[].assign_committer` | boolean | — | 把 review 作者加为 assignee |
| `outputs.channels[].owners_file` | string | — | owners 文件路径（默认 `OWNERS`） |
| `outputs.channels[].add_owners_as_assignees` | boolean | — | 把匹配到的 OWNERS 条目加为 assignee |
| `outputs.channels[].severity_label_prefix` | string | — | 自动创建/附加一个 severity label，如 `aicr:problem:high` |
| `outputs.channels[].severity_label_colors` | map | — | 自动创建 label 的 severity 到颜色映射 |
| `outputs.channels[].review_mode` | enum | — | `auto`、`review`、`comment` |
| `outputs.channels[].review_event` | enum | — | `COMMENT` 或 `REQUEST_CHANGES` |
| `outputs.channels[].review_update_strategy` | enum | — | `always_new` 或 `update_existing` |
| `outputs.channels[].notify_feishu` | object | — | issue 创建时的 Feishu 通知（`webhook_url_env`、可选 `secret_env`） |
| `outputs.author_resolution` | object | — | `email_mappings` 映射和 `email_blacklist` 数组 |
| `outputs.routes.default` | object | — | 无规则匹配时应用的默认路由 |
| `outputs.routes.rules[]` | array | `[]` | 有序路由规则 |
| `outputs.routes.rules[].match.trigger` | string | — | 要匹配的 trigger 名 |
| `outputs.routes.rules[].match.target_kind` | enum | — | 目标类型（`pull_request`、`push`、`commit`、`issue`、`manual`、`scheduled`）；`pr` 会被归一化为 `pull_request`。GitLab MR 以 `pull_request` 报告。 |
| `outputs.routes.rules[].line_comments` | string[] | — | 接收行评论输出的 channel 名 |
| `outputs.routes.rules[].summary` | string[] | — | 接收 summary 输出的 channel 名 |

## `agent`

叙述：[Agent 与沙箱](/zh-cn/configuration/agent/)。

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `agent.default` | enum | `kilo` | 默认 agent kind |
| `agent.timeout_seconds` | int > 0 | `600` | 单次 run 硬超时；超时时杀整棵进程树 |
| `agent.auto_approve` | boolean | `true` | 自动批准 agent 工具动作 |
| `agent.sandbox` | object | `{ kind: "docker", engine: "auto" }` | 沙箱后端 |
| `agent.sandbox.kind` | enum | — | sandbox kind（见枚举表） |
| `agent.sandbox.engine` | enum | — | 容器引擎选择 |
| `agent.sandbox.image` | string | — | 使用的容器镜像 |
| `agent.context_compaction` | object | `{ auto: true, prune: true }` | 注入各 agent 的对话级自动压缩 |
| `agent.context_compaction.auto` | boolean | `true` | 启用自动压缩 |
| `agent.context_compaction.threshold_percent` | int 1–100 | — | 压缩触发阈值 |
| `agent.context_compaction.prune` | boolean | `true` | 修剪压缩后的历史 |

## `review`

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `review.languages_auto_detect` | boolean | — | 自动检测评审语言 |
| `review.include` | string[] | — | 包含的 glob 模式 |
| `review.exclude` | string[] | — | 排除的 glob 模式 |
| `review.max_files` | int > 0 | — | 单次评审最大文件数 |
| `review.max_patch_bytes` | int > 0 | — | 最大 patch 字节数 |
| `review.incremental` | boolean | — | 增量评审 |
| `review.skip_lgtm` | boolean | — | 跳过看起来干净的评审 |
| `review.output_language` | string | — | summary 输出语言（如 `zh-CN`） |
| `review.commit_strategy` | enum | — | `per_commit`、`aggregate`、`head_only` |
| `review.log_thinking` | boolean | — | 记录模型 thinking 轨迹 |
| `review.git.allow_deepen` | boolean | — | 允许对浅克隆执行 `git fetch --deepen` |
| `review.labels.ignore` | string[] | — | 跳过评审的 label |
| `review.labels.auto_tag` | string | — | AICR 启动时附加的固定 tag |
| `review.labels.reviewed_tag` | string | — | 评审完成时附加的 tag |
| `review.problem_issue.max_recent_issues` | int 1–100 | — | 单次 run 对账的最近 managed issue 上限 |
| `review.fetch_extra.max_bytes` | int > 0 | — | 单次额外上下文请求的最大字节数 |
| `review.fetch_extra.max_files` | int > 0 | — | 单次额外上下文请求的最大文件数 |
| `review.fetch_extra.allow_paths` | string[] | — | 额外上下文拉取允许的路径 glob |
| `review.reflection.enabled` | boolean | — | 启用 reflection memory |
| `review.reflection.mode` | enum | — | `off`、`light`、`thorough` |
| `review.reflection.memory.max_size_kb` | int > 0 | — | memory 最大大小（KB） |
| `review.reflection.memory.max_entries` | int > 0 | — | memory 最大条目数 |
| `review.reflection.memory.retention_days` | int > 0 | — | memory TTL（天） |

## `queue`

叙述：[队列与重试](/zh-cn/configuration/queue/)。

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `queue.kind` | enum | `memory` | 队列后端 |
| `queue.sqlite.path` | string | — | SQLite 队列 DB 路径 |
| `queue.sqlite.lock_ttl_seconds` | int > 0 | — | stale running job 回收 TTL |
| `queue.workers.concurrency` | int > 0 | — | 全局 worker 并发 |
| `queue.workers.per_workspace_concurrency` | int > 0 | — | 单 workspace 并发上限 |
| `queue.workers.lock_ttl_seconds` | int > 0 | — | worker 锁 TTL |
| `queue.rate_limit.per_provider_rps` | map | — | 按 provider 的每秒请求数上限 |
| `queue.retry.attempts` | int > 0 | — | trigger 级重试次数（兼容旧 `max_attempts`） |
| `queue.retry.backoff` | object | — | `kind`、`base_ms`、`max_ms`、`jitter` |
| `queue.dead_letter.enabled` | boolean | — | 启用死信处理 |
| `queue.dead_letter.max_age_hours` | int > 0 | — | 进入死信前的最大时长（小时） |

## `storage`

叙述：[存储](/zh-cn/configuration/storage/)。

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `storage.database.kind` | enum | `sqlite` | 数据库后端（`sqlite` 或 `postgres`） |
| `storage.database.sqlite.path` | string | `/app/data/aicr.sqlite` | SQLite DB 路径 |
| `storage.database.postgres.url_env` | string | — | Postgres 连接串环境变量 |
| `storage.cache.kind` | enum | `memory` | 缓存后端 |
| `storage.cache.redis.url_env` | string | — | Redis 连接串环境变量 |
| `storage.cache.ttl_seconds` | int > 0 | — | 缓存 TTL |
| `storage.object.kind` | enum | `filesystem` | 对象存储后端 |
| `storage.object.filesystem.root` | string | `/app/data/objects` | 文件系统对象根目录 |
| `storage.object.s3.endpoint_url_env` | string | — | S3 兼容 endpoint 环境变量（AWS S3、MinIO、RustFS） |
| `storage.object.s3.bucket` | string | — | bucket 名 |
| `storage.object.s3.region_env` | string | — | region 环境变量 |
| `storage.object.s3.access_key_id_env` | string | — | access key id 环境变量 |
| `storage.object.s3.secret_access_key_env` | string | — | secret access key 环境变量 |
| `storage.object.s3.force_path_style` | boolean | — | 使用 path-style 寻址（MinIO/RustFS） |
| `storage.retention.deleted_project_grace_days` | int ≥ 0 | `30` | 软删除项目的硬删除宽限期（天） |

## `compression`

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `compression.trigger_tokens` | int > 0 | — | 触发 diff 压缩的 token 阈值 |
| `compression.max_input_ratio` | number 0–1 | — | 压缩前的最大输入占比 |
| `compression.summarize_model_role` | string | — | summarize 阶段使用的 model role（`light`/`heavy`/`any`） |
| `compression.keep_hunks_top_k` | int > 0 | — | 原样保留的最高风险 hunk 数 |
| `compression.context_lines` | int > 0 | — | 保留 hunk 周围的上下文行数 |
| `compression.per_model_overrides` | map | — | 按 model 配置 `trigger_tokens` 覆盖 |

当 `compression` 缺省时，bootstrap 会从 review model 的 context window 派生默认
`trigger_tokens = min(131072, floor(contextWindow × 0.6))`。

## `server`

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `server.port` | int > 0 | `8080` | HTTP 监听端口 |
| `server.hostname` | string | `0.0.0.0` | 监听 hostname |
| `server.trust_proxy` | boolean \| enum \| string[] | `false` | trust proxy 设置（`loopback`/`linklocal`/`uniquelocal` 或 CIDR 列表） |
| `server.base_url` | string | — | 外部 base URL |
| `server.path_prefix` | string | — | URL 路径前缀（反代子路径） |
| `server.auth.api_key_env` | string | — | 全局 API key 环境变量（保护 `/triggers/*`） |
| `server.auth.enabled` | boolean | `true` | 切换全局 API key |

## `admin`

叙述：[Dashboard 与日志](/zh-cn/start/dashboard/)。

| 字段 | 类型 | 默认值 | 描述 |
| --- | --- | --- | --- |
| `admin.username_env` | string | `AICR_ADMIN_USERNAME` | 管理员用户名环境变量 |
| `admin.password_env` | string | `AICR_ADMIN_PASSWORD` | 管理员密码环境变量 |
| `admin.password_hash_env` | string | — | 管理员密码哈希环境变量（`sha256:<hex>`）；优先于 `password_env` |
| `admin.session_ttl_seconds` | int > 0 | `86400` | session TTL（秒，不是分钟） |
