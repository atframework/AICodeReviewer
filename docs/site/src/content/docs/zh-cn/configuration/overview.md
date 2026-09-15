---
title: 配置总览
description: AICodeReviewer 的配置命名空间划分，以及从全局默认到单个 workspace 实例的覆盖层次。
---

AICodeReviewer 通过一个 `config.yaml` 文件加一个 `.env` 文件完成全部配置。
本页是一张地图：列出所有顶层命名空间、说明配置如何从全局默认逐层下沉到单个
workspace，并强调一条不能破坏的规则——**绝不要把密钥明文写进 `config.yaml`**。

每个命名空间都有独立的详情页给出完整字段表，你可以把下表当作入口。

## 顶层命名空间

| 命名空间 | 控制内容 | 详情页 |
| --- | --- | --- |
| `llm` | 模型提供方、模型链、重试/退避、费用预算，以及 models.dev 元数据目录。 | [LLM 提供方与模型](/zh-cn/configuration/llm/) |
| `triggers` | 每个 VCS 源（Gitea、GitHub、GitLab、P4、SVN）一个条目——入站 webhook/HMAC 校验与出站 token。 | [认证与密钥](/zh-cn/configuration/authentication/) |
| `workspaces` | 你要评审的代码仓库：源绑定、按 workspace 覆盖，以及克隆缓存。 | 本页 |
| `outputs` | 输出通道（PR review、IM 机器人、托管 issue）、路由规则，以及零问题策略。 | [输出通道与路由](/zh-cn/configuration/outputs/) |
| `agent` | 驱动哪个 agent CLI、单次运行超时、上下文自动压缩，以及沙箱后端。 | [Agent 与沙箱](/zh-cn/configuration/agent/) |
| `review` | 文件过滤、label 管理、托管问题 issue 的生命周期上限，以及反思记忆。 | 本页 |
| `queue` | 内存、SQLite 或 Redis 队列、worker 并发、限流，以及重试策略。 | [队列与重试](/zh-cn/configuration/queue/) |
| `storage` | 数据库、缓存与对象存储后端，用于可观测性、模型目录及未来特性。 | [存储](/zh-cn/configuration/storage/) |
| `compression` | AICR 侧的 diff 摘要，在模型看到大任务前先压缩。 | [LLM 提供方与模型](/zh-cn/configuration/llm/)（上下文依赖） |
| `server` | HTTP 监听器与 `/triggers/*` 的全局 API key 鉴权。 | [认证与密钥](/zh-cn/configuration/authentication/) |
| `admin` | 可选的可观测性看板超级管理员登录（与 webhook/trigger 鉴权相互独立）。 | [认证与密钥](/zh-cn/configuration/authentication/) |
| `config_sources` | 数据库配置源开关、运行时刷新节奏，以及密钥引用授权。 | 本页（动态配置 API） |

:::note[最小配置]
要真正发起评审，只需要 `llm`、至少一个 `triggers[]` 条目，以及至少一个
`workspaces.instances.<id>`。其余部分都带有合理默认值，所以填好 LLM key 之后，
示例 `example/config.yaml` 可以直接跑起来。
:::

## 文件校验

加载器接受不超过 1 MiB 的 YAML 映射，在填入默认值前拒绝重复键、循环别名和原型键。
provider ID、trigger name 和 channel name 必须分别唯一。以 `_env` 结尾的字段必须填写
符合 `[A-Za-z_][A-Za-z0-9_]*` 的环境变量名称。旧模型链格式只在内存中转换，原文件不会
改写，详见[模型分组](/zh-cn/configuration/llm/)。

## 三层覆盖模型

影响某次评审的配置按三层解析，越往下越具体，下层设置的值总是优先。

```text
全局（config 根）  →  workspaces.defaults  →  workspaces.instances.<id>
```

1. **全局** —— 诸如 `review`、`outputs.no_problems`、`agent`、`compression`
   这样的顶层键，是所有 workspace 的兜底。
2. **workspace 默认** —— `workspaces.defaults.{review,outputs,agent,prompt,sandbox}`
   对所有实例生效，但仍可被实例覆盖。当你想在多个仓库间共享一份策略时用这一层。
3. **workspace 实例** —— `workspaces.instances.<id>` 是最具体的一层，这里设置的
   任何值都优先。`workspace_id` 不能与保留根键 `cache`、`defaults`、`instances`
   冲突。

覆盖是**按 section 深合并**的，不是整体替换。比如在实例里设置
`outputs.no_problems`，并不会清空该实例的 `outputs.summary` 列表——只有你显式
设置的字段才会被替换。

```yaml
# 全局默认 —— 通知类通道保持安静
outputs:
  no_problems: { action: suppress }

workspaces:
  defaults:
    outputs:
      no_problems: { action: suppress }

  instances:
    critical-service:
      source_repo: { trigger: gitea, repo: "my-org/critical-service" }
      outputs:
        summary: [feishu-code-review]
        # 按 workspace + 按通道覆盖：这个仓库需要审计留痕
        channel_overrides:
          feishu-code-review:
            no_problems: { action: publish }
      # 按 workspace 覆盖 review（与全局 review 深合并）
      review:
        problem_issue:
          max_recent_issues: 10
```

并非每个 section 都能在每一层覆盖。下表列出每一层接受的 section。

| Section | 全局 | `workspaces.defaults` | `workspaces.instances.<id>` |
| --- | :---: | :---: | :---: |
| `review` | ✓ | ✓ | ✓ |
| `outputs`（通道列表、`no_problems`、`channel_overrides`） | ✓ | ✓ | ✓ |
| `model_chain`（主链分组） | 经由 `llm.default_model_chain` | ✓ | ✓ |
| `triage_model_chain`（生命周期分析分组） | 经由 `llm.triage_model_chain` | ✓ | ✓ |
| `agent.default` | ✓ | ✓ | ✓ |
| `sandbox` | 经由 `agent.sandbox` | ✓ | ✓ |
| `prompt`（基础系统提示、`force_skills`） | — | ✓ | ✓ |
| `context_repositories`（辅助上下文仓库） | — | ✓ | ✓ |
| `auth`（按 workspace 的 API key） | 经由 `server.auth` | — | ✓ |
| `compression`、`queue`、`storage`、`llm`、`server`、`admin`、`triggers`、`config_sources` | ✓ | — | — |

分组定义统一放在 `llm.model_chain`；workspace 只填分组名。主链用于审查、
agent 故障切换和压缩摘要；triage 各层都未配置时继承该 workspace 的主链。
完整示例见[模型分组配置](/zh-cn/configuration/llm/)。

每次运行按 global → defaults → instance 的合并结果选择 `agent.default` 和
`sandbox`，并独立创建沙箱实例。workspace 层可以混用不同 agent 或独立沙箱镜像。

`context_repositories` 声明评审时可引用的辅助仓库（共享库、协议契约等）：每次评审
在确认存在变更文件后全新物化到 `<workspace>/context-repos/<alias>`，容器沙箱内以只读
挂载 `/workspace/context-repos/<alias>` 暴露给 agent，单仓库失败不阻塞评审，
`max_mb`（默认 512）限制物化体积。instance 的列表整体替换 `defaults` 的列表。
字段细节见[配置字段参考](/zh-cn/reference/config-fields/#workspaces)。

## `.env` 与 `config.yaml` —— 密钥约定

`config.yaml` 设计为可以提交到版本库，因此绝不能包含明文密钥。所有承载密钥
的字段都只接受**环境变量的名字**，AICR 在启动时从环境读取实际值。

```yaml
# config.yaml —— 只存放环境变量名，绝不放值
llm:
  providers:
    - id: my-llm
      kind: openai_compatible
      api_key_env: AICR_LLM_API_KEY   # 从 $AICR_LLM_API_KEY 读取
```

```bash
# .env（或编排系统的密钥库）—— 存放真正的值
AICR_LLM_API_KEY=sk-xxxxxxxxxxxxxxxx
```

整个配置里的命名约定是一致的：

| 字段后缀 | 含义 | 示例 |
| --- | --- | --- |
| `*_env` | 存放密钥（key、token、URL）的环境变量名。 | `api_key_env`、`webhook_secret_env`、`url_env` |
| `*_url_env` | 存放 URL 的环境变量名。 | `endpoint_url_env`、`webhook_url_env` |

请牢记：

- `*_env` 字段是一个**字符串名字**，不是密钥本身。如果写成
  `api_key_env: sk-xxx`，AICR 会去查找名为 `sk-xxx` 的环境变量并失败。
- 如果省略某个密钥字段，对应特性会被禁用或以未鉴权方式运行（例如跳过
  webhook 的 HMAC 校验——生产环境不建议）。
- 用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  生成强随机值。

三套相互独立的鉴权层（webhook HMAC、server API key、workspace API key）
如何组合使用，见 [认证与密钥](/zh-cn/configuration/authentication/)。

## 接下来看哪里

- 刚接触本项目？先读 [LLM 提供方与模型](/zh-cn/configuration/llm/)——
  没有提供方和模型链什么都跑不起来。
- 准备上生产？配置持久化队列（[队列与重试](/zh-cn/configuration/queue/)）、
  存储（[存储](/zh-cn/configuration/storage/)）以及
  agent 沙箱（[Agent 与沙箱](/zh-cn/configuration/agent/)）。
- 调整输出行为？看 [输出通道与路由](/zh-cn/configuration/outputs/)，
  涵盖通道、路由、零问题策略，以及托管 issue 的生命周期上限。

## 多工程 workspace（v2 匹配）

一个实例可以用 `match[]` 规则服务多个工程，代替单一的 `source_repo` 绑定
（两者互斥）。规则之间是 OR，单条规则内的字段是 AND。git 系 webhook
（GitHub、GitLab、Gitea、Forgejo）先验凭据、准入时匹配：无规则命中返回
`202 repository_not_configured`，命中多个定义返回 `202 ambiguous_route`。
P4/SVN profile 先持久化路由回执，再由后台对照验证过的变更路径完成解析。

命中的实例按 `work_path` 渲染目录——一个受限 Handlebars 模板（仅允许
`segment`、`default`、`hash`、`lower` 四个 helper，默认 `{{workspace.id}}`）。
变量目录见[模板变量](/zh-cn/reference/template-variables/)。命中的实例使用
`isolated_v2` 布局：所有内容位于 `<workspaces.root>/<work_path>/<instance_id>`，
每次运行的 source/agent/tmp/context-repos 位于 `runs/<runId>/`，并随整次评审
清理；legacy 缓存路径保持原样。

匹配还引入了最顶层的覆盖层：每个任务的分析选择按 全局 → workspace 默认 →
实例 → 命中路由的 `analysis` 块 合并。数据库配置源发布新版本时，文件显式值
仍然优先且保持只读，一次发布只对发布后新接收的任务生效——已排队和运行中的
任务保留接收时的配置。字段细节见
[配置字段参考](/zh-cn/reference/config-fields/#workspaces)。

## 动态配置 API

启用 `config_sources.database.enabled: true` 后，`/api/admin/config` 可发布数据库
补充配置，文件显式值保持只读。每次 webhook 在读取凭据前检查持久 head，异步处理
始终使用同一 generation。receipt 和新持久化延期任务保留接收时快照；空命名空间
在接收任务前先写入 revision 0 快照。

管理员 API 要求 Bearer session，JSON 请求按 UTF-8 字节限制为 1 MiB，拒绝跨源
写入和不一致的 `fileDigest`，读取历史凭据时脱敏。新增明文凭据和带凭据 URL
会被拒绝，应使用环境变量引用。读取视图包含文件/数据库来源、不可变记录 ID、
有效值和 `limit`/`offset` 实体分页。无法激活配置时，`/readyz` 和管理员
`/status` 返回 503。

changesets 和 restore 请求必须携带当前 SHA-256 `fileDigest`。operation 端点区分
持久提交与本机激活，status 列出实例心跳及版本。已排队任务和历史无 pin 任务在发布、
重启后保持原版本；历史 null 记录统一解析到持久化的 `legacy_import` 基线。

环境变量引用按名称、配置路径及目的地授权。原文件引用授权原有用途；新增数据库引用
或修改目的地前，需要在文件 `config_sources.secret_refs` 中授权，包括 channel、
model override、workspace/route search 继承的凭据。授权格式见
[字段参考](/zh-cn/reference/config-fields/)。

未指定 `trigger` 的 channel 继承接收事件的兼容 profile。数据库 channel 需要对所有
兼容 profile 的有效凭据与目的地授权；指定 `trigger` 可缩小这一范围。文件拥有的
channel 保留这些原有用途的授权。GitLab `project_id` 属于目的地授权字段，修改时
需要匹配的文件授权。

数据库可管理的全局叶子包括 `llm.default_model_chain`、`llm.triage_model_chain`、
`llm.retry`、`llm.per_provider_overrides`、`llm.budget`、`llm.model_catalog`、
`review`、`compression`、`agent`、`outputs.template_engine`、`outputs.no_problems`、
`outputs.author_resolution`、`outputs.routes`、`queue.workers`、`queue.rate_limit`、
`queue.retry`、`queue.dead_letter`、`workspaces.cache`、`workspaces.defaults`，
以及 provider、模型组、trigger、channel、workspace、route 实体集合。bootstrap
信任边界——`server`、`admin`、`storage`、`config_sources`、`queue.kind`、
`queue.sqlite`、`workspaces.root`——永远不可由数据库写入。

v2 路由、Review 策略、agent/search/sandbox、模型目录和 triage 变更对新任务生效。
v2 输出显式空列表关闭该类输出。管理 UI 已随看板 **Config** 标签发布（见
[Dashboard 与日志](/zh-cn/start/dashboard/)），API 可独立于统计 store 使用。
