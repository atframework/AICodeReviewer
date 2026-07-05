---
title: Agent 与沙箱
description: 选择 agent CLI、设置单次运行超时、启用上下文自动压缩，并选择沙箱后端。
---

AICodeReviewer 会在沙箱内驱动一个外部 agent CLI（默认 Kilo Code）。`agent`
命名空间用于选择运行哪个 CLI、设定单次运行的硬超时、为长评审启用上下文自动压缩，
并选择把 agent 与宿主机隔离的沙箱后端。

```yaml
agent:
  default: kilo
  timeout_seconds: 300
  auto_approve: true
  context_compaction:
    auto: true
    prune: true
  sandbox:
    kind: docker
    engine: auto
```

## `agent.default` —— 使用哪个 agent CLI

| 取值 | 行为 |
| --- | --- |
| `kilo`（默认） | Kilo Code，受支持的默认路径。 |
| `opencode` | opencode 适配器。仅在验证该适配器时设置。 |
| `zoo` | Zoo Code 适配器。仅在验证该适配器时设置。 |
| `copilot-cli` | GitHub Copilot CLI 适配器。 |
| `claude-code` | Claude Code 适配器。 |

:::note[沿用默认值]
`kilo` 是经过验证的默认值。只有在你明确要验证某个适配器时才切换到其他
`AgentKind`。
:::

`agent.default` 也可以在 `workspaces.defaults.agent.default` 和
`workspaces.instances.<id>.agent.default` 这两层覆盖。

## `agent.timeout_seconds` —— 单次运行的硬上限

```yaml
agent:
  timeout_seconds: 300   # 生产环境对大型 PR 常用 600
```

这是**单次 agent 跑一轮的硬上限**。超时触发时，沙箱会杀掉**整棵进程树**——
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

为 `true`（默认）时，AICodeReviewer 会在沙箱化的评审范围内自动批准 agent 提议的
工具动作。仅在需要逐步检查每个动作的调试流程中才设为 `false`。

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
| opencode | `.opencode/config.json` 中的 `compaction.{auto,prune}`。 |
| Zoo | `.roo/settings.json` 中的 `autoCondenseContext` / `condenseContextPercentThreshold`。 |
| Claude Code | 默认自动压缩（委托给其内置能力，不注入配置）。 |
| Copilot CLI | 不适用（没有上下文管理接口）。 |

:::caution[Kilo 需要已知 context window]
Kilo 仅在模型的 `contextWindow` 已知时才会自动压缩，这样 `threshold_percent` 才
有衡量基准。请二选一：

- 开启 `llm.model_catalog`，从 models.dev 解析窗口；**或**
- 在 `llm.model_catalog.overrides` 里为该模型设置 `context_window`
  （理想情况下同时设置 `max_output_tokens`）。

窗口未知时，Kilo 压缩会静默地不生效。目录与覆盖字段见
[/zh-cn/configuration/llm/](/zh-cn/configuration/llm/)。
:::

## `agent.sandbox` —— 隔离后端

沙箱把 agent 与宿主机隔离。它只挂载**受限的评审目录**，把源码树保持为**只读**，
并强制执行 agent 可触碰的命令/路径**白名单**。如果 agent 需要更多上下文，应当用
只读命令读取已挂载的文件，或针对具体路径调用 `aicr.fetch_more_context`。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `kind` | enum | `docker` | 沙箱类型（见下）。 |
| `engine` | enum | `auto` | 容器引擎：`auto`、`docker` 或 `podman`。 |
| `image` | string | – | 可选的显式沙箱镜像。 |

### `kind` 取值

| Kind | 状态 | 何时使用 |
| --- | --- | --- |
| `native` | 可用 | 直接在宿主机上运行 agent（无容器）。隔离度最低。 |
| `docker`（默认） | 可用 | 在 Docker 容器内运行。大多数部署的默认选择。 |
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

`sandbox` 还可在 `workspaces.defaults.sandbox` 和
`workspaces.instances.<id>.sandbox` 层覆盖（注意：实例级 `sandbox` 只能通过
`workspaces.defaults` 提供，不能直接放在实例上——覆盖表见
[/zh-cn/configuration/overview/](/zh-cn/configuration/overview/)）。
