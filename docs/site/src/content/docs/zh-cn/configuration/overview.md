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
| `llm` | 模型提供方、fallback 链、重试/退避、费用预算，以及 models.dev 元数据目录。 | [/zh-cn/configuration/llm/](/zh-cn/configuration/llm/) |
| `triggers` | 每个 VCS 源（Gitea、GitHub、GitLab、P4、SVN）一个条目——入站 webhook/HMAC 校验与出站 token。 | [/zh-cn/configuration/authentication/](/zh-cn/configuration/authentication/) |
| `workspaces` | 你要评审的代码仓库：源绑定、按 workspace 覆盖，以及克隆缓存。 | 本页 |
| `outputs` | 输出通道（PR review、IM 机器人、托管 issue）、路由规则，以及零问题策略。 | [/zh-cn/configuration/outputs/](/zh-cn/configuration/outputs/) |
| `agent` | 驱动哪个 agent CLI、单次运行超时、上下文自动压缩，以及沙箱后端。 | [/zh-cn/configuration/agent/](/zh-cn/configuration/agent/) |
| `review` | 文件过滤、label 管理、托管问题 issue 的生命周期上限，以及反思记忆。 | 本页 |
| `queue` | 内存或持久化 SQLite 队列、worker 并发、限流，以及重试/死信策略。 | [/zh-cn/configuration/queue/](/zh-cn/configuration/queue/) |
| `storage` | 数据库、缓存与对象存储后端，用于可观测性、模型目录及未来特性。 | [/zh-cn/configuration/storage/](/zh-cn/configuration/storage/) |
| `compression` | AICR 侧的 diff 摘要，在模型看到大任务前先压缩。 | [/zh-cn/configuration/llm/](/zh-cn/configuration/llm/)（上下文依赖） |
| `server` | HTTP 监听器与 `/triggers/*` 的全局 API key 鉴权。 | [/zh-cn/configuration/authentication/](/zh-cn/configuration/authentication/) |
| `admin` | 可选的可观测性看板超级管理员登录（与 webhook/trigger 鉴权相互独立）。 | [/zh-cn/configuration/authentication/](/zh-cn/configuration/authentication/) |

:::note[最小配置]
要真正发起评审，只需要 `llm`、至少一个 `triggers[]` 条目，以及至少一个
`workspaces.instances.<id>`。其余部分都带有合理默认值，所以填好 LLM key 之后，
示例 `example/config.yaml` 可以直接跑起来。
:::

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
| `agent.default` | ✓ | ✓ | ✓ |
| `sandbox` | 经由 `agent.sandbox` | ✓ | ✓ |
| `prompt`（基础系统提示、`force_skills`） | — | ✓ | ✓ |
| `auth`（按 workspace 的 API key） | 经由 `server.auth` | — | ✓ |
| `compression`、`queue`、`storage`、`llm`、`server`、`admin`、`triggers` | ✓ | — | — |

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
如何组合使用，见 [/zh-cn/configuration/authentication/](/zh-cn/configuration/authentication/)。

## 接下来看哪里

- 刚接触本项目？先读 [/zh-cn/configuration/llm/](/zh-cn/configuration/llm/)——
  没有提供方和 fallback 链什么都跑不起来。
- 准备上生产？配置持久化队列（[/zh-cn/configuration/queue/](/zh-cn/configuration/queue/)）、
  存储（[/zh-cn/configuration/storage/](/zh-cn/configuration/storage/)）以及
  agent 沙箱（[/zh-cn/configuration/agent/](/zh-cn/configuration/agent/)）。
- 调整输出行为？看 [/zh-cn/configuration/outputs/](/zh-cn/configuration/outputs/)，
  涵盖通道、路由、零问题策略，以及托管 issue 的生命周期上限。
