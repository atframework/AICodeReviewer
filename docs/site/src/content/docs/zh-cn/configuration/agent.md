---
title: Agent 与沙箱
description: 选择 agent CLI 或 AICR 直连 LLM 模式，并配置 CLI 超时、压缩与沙箱。
---

AICodeReviewer 可以在沙箱内驱动外部 agent CLI（默认 Kilo Code），也可以通过
`native-llm` 直接调用已配置的 LLM。`agent` 命名空间选择执行模式；超时、自动批准、
上下文压缩、网络搜索与沙箱设置用于 CLI 运行。

```yaml
agent:
  default: kilo
  timeout_seconds: 1800
  auto_approve: true
  context_compaction:
    auto: true
    prune: true
  web_search:
    enabled: false
  sandbox: {}  # kind 不设置 = 自动探测（docker→podman→native 回退）
```

## `agent.default` —— 执行模式

| 取值 | 行为 |
| --- | --- |
| `kilo`（默认） | Kilo Code，受支持的默认路径。 |
| `opencode` | opencode 适配器。仅在验证该适配器时设置。 |
| `zoo` | Zoo Code 适配器。仅在验证该适配器时设置。 |
| `copilot-cli` | GitHub Copilot CLI 适配器。 |
| `claude-code` | Claude Code 适配器。 |
| `pi` | pi（`@earendil-works/pi-coding-agent`）适配器。要求 catalog 提供 `context_window` / `max_output_tokens`。 |
| `oh-my-pi` | oh-my-pi（`omp`，pi 的 fork）适配器。模型元数据要求与 `pi` 相同。 |
| `native-llm` | AICR 通过 LLM gateway 直接调用已配置模型，不启动 agent CLI。 |

:::note[沿用默认值]
`kilo` 是经过验证的默认值。验证其他 CLI 适配器时可切换到对应 kind。
`pi` 与 `oh-my-pi` 适配器支持 `openai_compatible`、`ollama`、
`anthropic`、`google_ai_studio` 四种 provider kind，且两者都要求模型的上下文
窗口与输出 token 上限已知——使用前请先启用 `llm.model_catalog`（或设置
overrides）。由 `deploy/Dockerfile` 构建的运行时镜像内置固定版本的 Kilo 与
`omp` CLI，覆盖该镜像内的 native 沙箱路径；其他沙箱镜像需要预装对应 CLI
（这两个二进制默认已在沙箱命令白名单中）。
:::

`native-llm` 使用与直连 LLM 回退相同的模型路由、评审 prompt、diff 压缩和结构化输出
解析。它不会启动沙箱或生成 CLI runtime bundle。模型只能使用准备好的 prompt，无法
读取挂载文件、调用 MCP 工具、运行技能，或通过 agent 工具请求更多上下文；辅助上下文
仓库也会跳过。适用于已有 prompt 足以完成评审的场景。

执行模式、超时、批准、压缩和 web-search 设置按每个任务的
global → workspace defaults → instance → route analysis 合并。数组整体替换，
搜索凭据按 key 合并并受部署用途授权约束；CLI adapter 不支持的能力写入 CLI runtime manifest。
仓库拥有的配置只能选择 `agent.default`，不能提升批准、搜索凭据或沙箱权限。

每次 CLI 审查创建独立沙箱，HOME、USERPROFILE、APPDATA、XDG 和临时目录位于该 run 内；
MCP 子进程继承相同隔离目录。通过配置声明的环境变量提供认证，运行时不复制开发者的
全局 OAuth/auth store。operator 的模板和 `.agents/skills` 可从 definition 的旧策略目录
只读回退；详细目录合同见[配置字段参考](/zh-cn/reference/config-fields/)。

## `agent.timeout_seconds` —— 单次运行的硬上限

```yaml
agent:
  timeout_seconds: 1800  # 默认值；小 PR 为主的环境可以调低
```

这是**单次 CLI agent 运行的硬上限**，不限制 `native-llm` 的 gateway 请求。
超时触发时，沙箱会杀掉**整棵进程树**——
agent 二进制及其派生的全部 worker 子进程，包括那些用 `setsid` 进入自己会话的
worker。因此单次运行不会因为留下孤儿 worker 而超时拖延。

有两点需要注意：

- **编排器可能跑多轮**（初始评审、上下文修复、直连 LLM 兜底），所以单次评审的
  挂钟时间可能是该值的几倍。请把它设在略高于最慢单轮预期的位置。
- **"死亡螺旋"陷阱**：如果对典型 diff 大小把这个值设得过低，每一轮都会在中途被杀，
  编排器重试，你却要为从未完成的半截工作付费。对大型 PR 应当调高超时，而不是依赖
  重试。

## `agent.auto_approve`

```yaml
agent:
  auto_approve: true
```

编排器将合并后的值传给 adapter 的命令构造器。CLI 支持时，`false` 会取消自动批准，
无人值守运行可能因此等待 CLI 批准；该字段不提供交互式批准页面。

## `agent.context_compaction` —— 运行时侧的历史压缩

长评审（大 diff、大量工具调用）可能在完成前就超过模型的上下文窗口。开启后，
AICodeReviewer 会注入各 agent CLI 的**原生**压缩设置，让 agent 在触及上限前先
摘要自己的对话历史。它**补充**（而非取代）顶层 `compression` 的 diff 摘要——后者
在流水线更早的阶段运行。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `auto` | bool | `true` | 在受支持的 agent 运行时中启用自动压缩。 |
| `threshold_percent` | int (1–100) | – | 达到模型上下文窗口的该百分比时压缩（Kilo）。 |
| `prune` | bool | `true` | 在多轮之间修剪旧的工具输出（Kilo / opencode）。 |

```yaml
agent:
  context_compaction:
    auto: true
    threshold_percent: 80   # Kilo：在上下文窗口的 80% 处压缩
    prune: true
```

### 各适配器的注入位置

每个 agent CLI 以自己的格式接收压缩配置：

| Agent | 落点 |
| --- | --- |
| Kilo | `kilo.json` 中的 `compaction.{auto,threshold_percent,prune}`。 |
| opencode | `opencode.json`（工作目录根部，由 sandbox cwd/`--dir` 发现）中的 `compaction.{auto,prune}`。 |
| Zoo | `.roo/settings.json` 中的 `autoCondenseContext` / `condenseContextPercentThreshold`。 |
| Claude Code | 默认自动压缩（委托给其内置能力，不注入配置）。 |
| Copilot CLI | 不适用（没有上下文管理接口）。 |
| pi | `settings.json` 中的 `compaction.enabled`（pi 没有 threshold/prune 字段，这两项委托给 pi 默认行为）。 |
| oh-my-pi | `config.yml` 中的 `compaction.enabled` 与 `compaction.thresholdPercent`。 |

:::caution[Kilo 需要已知 context window]
Kilo 仅在模型的 `contextWindow` 已知时才会自动压缩，这样 `threshold_percent` 才
有衡量基准。请二选一：

- 开启 `llm.model_catalog`，从 models.dev 解析窗口；**或**
- 在 `llm.model_catalog.overrides` 里为该模型设置 `context_window`
  （理想情况下同时设置 `max_output_tokens`）。

窗口未知时，Kilo 压缩会静默地不生效。目录与覆盖字段见
[LLM 提供方与模型](/zh-cn/configuration/llm/)。
:::

## `agent.web_search` —— agent 网页搜索控制

omp 自带内置 `web_search` 工具且默认启用；kilo、opencode、claude-code、
copilot-cli 同样自带搜索工具，且在自动批准模式下默认可达。AICR 始终物化显式
开关（本节默认 `false`），因此评审默认保持封闭，运维显式开启后才放行。开启后，
agent 可以把评审上下文（代码片段、符号、报错文本）作为查询发给所配置的搜索
引擎——这是一个数据治理决策，不只是功能开关。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `false` | 物化 agent 原生 allow/deny 开关；omp 自身默认 `web_search.enabled: true`。 |
| `providers` | string 数组 | `[]` | omp 使用完整有序链；kilo 只接受 `exa`；opencode 选择首个 `exa`/`parallel`。 |
| `exclude` | string 数组 | `[]` | 从链路中剔除的 provider id → `providers.webSearchExclude`。 |
| `timeout_seconds` | int (1–300) | – | 单 provider 传输超时 → `providers.webSearchTimeoutSeconds`（omp 默认 60）。 |
| `credentials.<provider>` | string | – | 该 provider 凭据在 AICR 宿主机上的环境变量名；仅启用搜索的 adapter 会以 `${VAR}` 引用注入原生环境变量。 |
| `searxng.endpoint` | string | – | 自托管 SearXNG 端点（查询保留在内网）。 |
| `searxng.categories` / `searxng.engines` / `searxng.language` | string | – | 可选的 SearXNG 结果过滤。 |
| `searxng.safesearch` | int (0–2) | – | SearXNG 安全搜索级别。 |

```yaml
agent:
  web_search:
    enabled: true
    providers: ["tavily", "duckduckgo"]
    exclude: ["google", "ecosia", "mojeek"]   # 浏览器型抓取器
    timeout_seconds: 30
    credentials:
      tavily: AICR_SEARCH_TAVILY_KEY           # -> TAVILY_API_KEY=${AICR_SEARCH_TAVILY_KEY}
      searxng_basic_username: AICR_SEARCH_SEARXNG_USERNAME
      searxng_basic_password: AICR_SEARCH_SEARXNG_PASSWORD
    searxng:
      endpoint: https://searxng.internal:8080
      language: zh-CN
```

`credentials` 的键仅限已验证 omp 原生环境变量名的 provider：`tavily`、`brave`、
`exa`、`jina`、`kagi`、`parallel`、`kimi`、`perplexity`、`zai`、`xai`、
`anthropic`（搜索专用 key，独立于聊天 key）、`tinyfish`、`firecrawl`、
`searxng_token`、`searxng_basic_username`、`searxng_basic_password`。仅支持 OAuth
存储的 provider（gemini/codex/perplexity OAuth）
无法在每次运行临时生成的 agent 目录内完成认证，不支持。

免凭据抓取器（`duckduckgo`、`startpage`）无需 key；浏览器型（`google`、
`ecosia`、`mojeek`）首次使用会尝试下载 Chromium，在锁网的容器里会失败并消耗
provider 超时——建议排除。

### 各 agent 的映射

oh-my-pi 的接口面最完整；其余 agent 各取其 CLI 暴露的能力，用不到的字段以启动
告警 + manifest 审计记录的方式跳过：

| Agent | 开关 | Provider / 凭据 | manifest mode |
| --- | --- | --- | --- |
| oh-my-pi | `config.yml` 的 `web_search.enabled` | 完整 provider 链、16 个凭据 env 名、SearXNG | `injected` |
| kilo | `kilo.json` 的 `permission.websearch: allow/deny` + `KILO_ENABLE_EXA` 激活 env | 仅 Exa（`credentials.exa` → `EXA_API_KEY`） | `injected` |
| opencode | `opencode.json` 的 `permission.websearch` + 激活 env 与 `OPENCODE_WEBSEARCH_PROVIDER` | 首个列出的 Exa 或 Parallel；只注入所选后端凭据 | `injected` |
| claude-code | 禁用时追加 `--disallowedTools WebSearch` | 无（Anthropic 自有后端） | `delegated` |
| copilot-cli | 禁用时追加 `--excluded-tools=web_search,web_fetch` | 无（Copilot 订阅后端） | `delegated` |
| zoo / pi | — | 无内置搜索工具 | `not_applicable` |

kilo、claude-code、copilot-cli 以自动批准方式运行，其内置搜索工具在无显式拒绝
开关时默认可达；正是这个显式 deny 开关保证了评审的封闭性。一份全局
`agent.web_search` 配置可以同时服务混合 workspace——某个 agent 不支持的 provider id
与字段会被跳过并告警，而不是让整个运行失败。禁用搜索时不会注入任何搜索凭据 env。

除 web search 之外，kilo 评审也不会读取开发者的全局 kilo 状态：AICR 会把
`XDG_CONFIG_HOME`/`XDG_DATA_HOME` 重定向到每次运行的 bundle 内目录，因此宿主
`~/.config/kilo` 配置里的未识别键或其他 kilo 版本留下的过期会话数据库都不会
导致运行失败。

## `agent.sandbox` —— 隔离后端

沙箱把 agent 与宿主机隔离。它只挂载**受限的评审目录**，把源码树保持为**只读**，
并强制执行 agent 可触碰的命令/路径**白名单**。如果 agent 需要更多上下文，应当用
只读命令读取已挂载的文件，或针对具体路径调用 `aicr.fetch_more_context`。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | enum | *（未设置）* | 沙箱类型（见下）。未设置时自动探测并允许回退 native。 |
| `engine` | enum | *（未设置）* | 容器引擎：`auto`、`docker` 或 `podman`。 |
| `image` | string | – | 可选的显式沙箱镜像。 |

### `kind` 取值

| Kind | 状态 | 何时使用 |
| --- | --- | --- |
| `native` | 可用 | 直接在宿主机上运行 agent（无容器）。隔离度最低。 |
| `docker` | 可用 | 在 Docker 容器内运行。显式声明容器类型属于信任声明：preflight 探测不到引擎时任务直接失败，不会静默降级 native。 |
| `podman` | 可用 | 在 Podman 容器内运行。配合 `deploy.sh` + `AICR_ENABLE_CONTAINER_SANDBOX` 与挂载的 Podman socket 时首选。 |
| `docker_socket` | 可用 | Docker 兼容模式，适用于明确需要经由挂载 socket 使用 Docker CLI 的工作流。 |
| `k8s_pod` | 保留 | 尚未实现。 |
| `firecracker` | 保留 | 尚未实现。 |

### `engine` 取值

`auto`（默认）自动探测可用引擎；`docker` 和 `podman` 强制指定。配合
`deploy.sh` 与挂载的 Podman socket 时，优先用 `kind: podman` 和 `engine: podman`。
当工作流明确需要 Docker CLI 时，仍可使用 Docker 兼容模式。

```yaml
agent:
  sandbox:
    kind: podman
    engine: podman
```

`sandbox` 与 `agent.default` 均可放在 `workspaces.defaults` 和
`workspaces.instances.<id>` 两层：每次运行按 global → defaults → instance 合并
结果选择，workspace 可以使用不同的 agent CLI 或独立的沙箱镜像（覆盖表见
[配置总览](/zh-cn/configuration/overview/)）。
