---
title: Agent 适配器
description: 支持的 agent CLI 以及 AICR 如何把模型、instructions 和 MCP 工具翻译到每个 agent 的运行时 bundle。
---

AICR 通过外部 agent CLI（以及内置的直连 LLM 路径）完成代码推理。每种 agent kind 都由一个 `AgentAdapter` 包装，把 AICR 的 provider 中立 model spec 翻译成 agent 的原生配置。适配器还会按 run 物化隔离的运行时 bundle，因此 AICR 永远不会修改你全局的 agent CLI 配置目录。

这里引用的配置字段参见[Agent 与沙箱](/zh-cn/configuration/agent/)。agent 回调的 MCP 工具参见 [MCP 工具](/zh-cn/integrations/mcp-tools/)。

## 运行时 bundle 如何物化

每次 agent run，AICR 会向 run 的 `agent/` 目录写入完整、隔离的 bundle，并以该目录作为配置根运行 agent。bundle 包含：

- LLM provider/model 配置（已翻译为 agent 的原生格式）。
- 指向本地 `aicr-output` server 的 MCP 配置。
- 生效中的 instructions（system prompt、repo-local 规则、已激活技能）。
- 已激活技能（完整技能文件或精简摘要，取决于适配器能力）。
- 环境变量注入。
- 一个 `manifest.json`，记录哪些参数被注入、哪些委托给工具原生 catalog、哪些被降级——能力缺口可审计，而不是被静默丢弃。

orchestrator 每次 run 调用一次 `materializeRuntimeBundle`，而不是修改任何全局配置。每个适配器再把 bundle 翻译成自己的文件布局（如 Kilo 的 `kilo.json`、opencode 的 `.opencode/`、Zoo Code 的 `.roo/`）。

## ModelSpec 翻译

AICR 维护单个 provider 中立的 `ModelSpec`（context window、最大输入/输出 token、能力 flag、定价、reasoning effort 等）。每个适配器把 `ModelSpec` 加上可选的 `thinkingLevel` 翻译成 agent CLI 期望的 provider 原生字段（Azure、Vertex、Bedrock、OpenAI-compatible、Anthropic、Gemini 等）。

当启用 [model catalog](/zh-cn/configuration/llm/) 时，AICR 会在翻译前用 models.dev 充实 `ModelSpec`。你在 `llm.providers[]` 和 `model_catalog.overrides` 里显式写的值始终优先于 catalog 数据；缺失字段不会被臆造。

## 能力降级

当适配器无法原生表达某个能力时，它**不会**静默丢弃，而是在运行时 bundle 的 `manifest.json` 中记录该能力的降级模式：

- `injected` —— AICR 把值写进了 agent 的原生配置。
- `delegated` —— agent CLI 从自己的内置 catalog 解析。
- `not_applicable` —— agent 没有这个能力的接入面。

这让每个 model-translation 决策都能从 run 快照中审计。

## 支持的 agent kind

### `kilo`（Kilo Code）

首要的部署验收 agent。AICR 物化 Kilo 的 `kilo.json`，包含 LLM provider 配置、本地 stdio `aicr-output` MCP server、技能、instructions 以及 `compaction.{auto,threshold_percent,prune}` 对话设置。

Kilo 不读 models.dev，因此对 OpenAI-compatible 自定义 provider，AICR 会向 model info 块注入 `contextWindow`、`maxTokens`、`supportsImages`、`supportsComputerUse`、`supportsPromptCache` 以及每百万 token 定价。

:::caution[Kilo 压缩需要 context window]
Kilo 只为声明了 `contextWindow` 的 model 自动压缩。如果禁用了 model catalog 又没设 `context_window` 覆盖，Kilo 会静默跳过压缩，大 PR 会溢出。**始终启用 `llm.model_catalog` 或在 overrides 中设置 `context_window`。** 参见[常见问题](/zh-cn/troubleshooting/)。
:::

### `opencode`

opencode 对已知 provider 原生走 models.dev 解析。对于 opencode 无法解析的自定义 `@ai-sdk/openai-compatible` provider，AICR 会向 model 块注入 `limit.context`、`limit.output`、按 token 的 `cost` 以及 `name`。当 provider 命中 models.dev 已知 provider 时跳过注入，避免双写冲突。

opencode 的原生压缩（`compaction.{auto,prune}`）写入 `.opencode/config.json`。

### `zoo`（Zoo Code）

Zoo Code 适配器对外 `AgentKind: "zoo"`。CLI 二进制和项目配置路径仍沿用上游的 `roo` / `.roo` / `.roomodes` 兼容面，因此 AICR 把配置写入 Zoo Code 当前的 `.roo/settings.json` 路径，而不是臆造 `.zoo` 路径。

Zoo Code 不读 models.dev，因此 AICR 会向 `apiConfiguration.openAiCustomModelInfo` 注入 `contextWindow`、`maxTokens`、`supportsImages`、`supportsComputerUse`、`supportsPromptCache`、`inputPrice`、`outputPrice`。原生 auto-condense 设置（`autoCondenseContext`、`condenseContextPercentThreshold`）写入同一个 settings 文件。

### `claude-code`（Claude Code）

Claude Code 依赖内置的 Anthropic catalog 和环境变量；没有文件级 model-metadata 接入面。当解析出的 `ModelSpec` 有 `maxOutputTokens` 时，AICR 据此派生 `ANTHROPIC_MAX_TOKENS`。context window 和定价委托给 Claude Code 的原生 catalog。能力缺口在 manifest 中记录为 `delegated`。

Claude Code 默认自动压缩，因此 AICR 不注入额外的压缩配置。

### `copilot-cli`（Copilot CLI）

Copilot CLI 使用其订阅固定的 model catalog。没有注入接入面，对话级上下文管理为 `not_applicable`。AICR 在 manifest 中把模型记录为 `not_applicable`。

## 直连 LLM 回退（不是 agent kind）

当 agent CLI 即便经过结构化修复 pass 也无法产出结构化输出时，orchestrator 可以回退到直接调用 LLM gateway。这是内部回退机制，**不是**可配置的 `agent.default` 值——合法的 `agent.default` 值只有 `kilo`、`opencode`、`zoo`、`copilot-cli` 和 `claude-code`。orchestrator 计算
`maxPromptTokens = floor(contextWindow × 0.6)`，让 prompt manager 在预算内裁剪 memory hints、技能和 instructions；diff 本身由 AICR 侧的压缩阶段处理。

## Model catalog 注入差异汇总

| 适配器 | 是否原生读 models.dev | 注入策略 |
| --- | --- | --- |
| opencode | 已知 provider 是；自定义 OpenAI-compatible provider 否 | 仅对自定义 provider 注入 `limit`/`cost`/`name` |
| kilo | 否 | 注入 `contextWindow`、`maxTokens`、`supportsImages`、`supportsComputerUse`、`supportsPromptCache`、定价 |
| zoo | 否 | 注入 `.roo/settings.json` 的 `openAiCustomModelInfo` |
| claude-code | 否（内置 Anthropic catalog） | 派生 `ANTHROPIC_MAX_TOKENS`；其余委托 |
| copilot-cli | 否（固定订阅 catalog） | 不注入；记录为 N/A |

注入只发生在自定义或未被工具原生解析的 provider 路径；当工具自己能从 models.dev 解析时，AICR 跳过注入以避免双写冲突。

## 选择 agent

全局设置 `agent.default`，按 workspace 用 `workspaces.instances.<id>.agent.default` 覆盖，或用 `workspaces.defaults.agent.default` 为一组 workspace 设置默认值。适用于所有 agent kind 的超时、沙箱和上下文压缩字段参见 [Agent 与沙箱](/zh-cn/configuration/agent/)。
