---
title: Agent 适配器
description: 支持的 agent CLI 以及 AICR 如何把模型、instructions 和 MCP 工具翻译到每个 agent 的运行时 bundle。
---

AICR 通过外部 agent CLI（以及内置的直连 LLM 路径）完成代码推理。每种 agent kind 都由一个 `AgentAdapter` 包装，把 AICR 的 provider 中立 model spec 翻译成 agent 的原生配置。适配器还会按 run 物化隔离的运行时 bundle，因此 AICR 永远不会修改你全局的 agent CLI 配置目录。

这里引用的配置字段参见[Agent 与沙箱](/zh-cn/configuration/agent/)。agent 回调的 MCP 工具参见 [MCP 工具](/zh-cn/integrations/mcp-tools/)。

## 运行时 bundle 如何物化

每次 agent run，AICR 会向 run 的 `agent/` 目录写入完整、隔离的 bundle，并以该目录作为配置根运行 agent。bundle 包含：

- LLM provider/model 配置（已翻译为 agent 的原生格式）。
- 指向本地 `aicr-output` server 的 MCP 配置（通过 agent 的原生 MCP 接入面接线：配置文件或 CLI flag）。
- 一份合并后的 `AGENTS.md`（生效中的仓库 instructions）——这是所有受支持 CLI 都会原生发现的 instructions 文件。
- 已激活技能（标准 Agent Skills 布局 `.agents/skills/<name>/SKILL.md`；需要不同根目录的 CLI 另有适配器原生副本）。
- 环境变量注入。
- 一个 `manifest.json`，记录哪些参数被注入、哪些委托给工具原生 catalog、哪些被降级，以及哪些原生接入面（instructions/技能/MCP）被接线——能力缺口可审计，而不是被静默丢弃。

orchestrator 每次 run 调用一次 `materializeRuntimeBundle`，而不是修改任何全局配置。每个适配器再把 bundle 翻译成自己的文件布局（如 Kilo 的 `kilo.json`、opencode 的 `opencode.json`、Zoo Code 的 `.roo/`）。

## 原生接入面接线

instructions、技能和 `aicr-output` MCP server 会接线到各 agent 的原生发现面；run manifest 在 `nativeSurfaces` 下记录接线情况：

| 接入面 | kilo | opencode | claude-code | copilot-cli | zoo | pi | oh-my-pi |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Instructions | `AGENTS.md`（自动加载） | `AGENTS.md`（自动加载） | 经 `CLAUDE.md` `@AGENTS.md` 导入 | `AGENTS.md`（自动加载） | `AGENTS.md` | `AGENTS.md`（自动加载） | `AGENTS.md`（自动加载） |
| 技能 | `kilo.json` `skills.paths` → `.agents/skills` | `.agents/skills/<name>/SKILL.md` + `permission.skill` 放行 | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md`（资源） | `.agents/skills/<name>/SKILL.md`（需 `--approve`） | `.agents/skills/<name>/SKILL.md` |
| `aicr-output` MCP | `kilo.json` `mcp` | `opencode.json` `mcp` | `--mcp-config` + `--strict-mcp-config` CLI flag | `--additional-mcp-config` CLI flag | 无（仅 prompt 注入） | 生成的扩展 `.pi-agent/extensions/aicr-output.ts`（pi 无内置 MCP） | `$PI_CODING_AGENT_DIR/mcp.json` |

MCP 输出状态文件路径通过 server 环境里的 `AICR_OUTPUT_STATE_PATH` 钉死，因此无论宿主 CLI 以哪个工作目录拉起 MCP server，orchestrator 都能可靠收集上报的问题与摘要。对 pi 与 oh-my-pi，orchestrator 同样以沙箱可见路径注入 `PI_CODING_AGENT_DIR`（run `agent/` 目录下的 `.pi-agent` / `.omp-agent`）。

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

opencode 对已知 provider 原生走 models.dev 解析。对于 opencode 无法解析的自定义 `@ai-sdk/openai-compatible` provider，AICR 按 `provider.<provider-id>.models.<model-id>` 组织配置，并注入 schema 要求字段完整的 `limit` / `cost` 以及已知能力。当 provider 命中 models.dev 已知 provider 时跳过重复 catalog metadata，避免双写冲突。

agent 以 `opencode --pure run --format json --auto --dir <agent-dir> --model provider/model` 运行，解析 `part` 包裹的 `text` / `tool_use` 与 `step_finish` usage 事件。配置写入工作目录根部的 `opencode.json`，由 sandbox cwd/`--dir` 原生发现，避免把 host absolute path 带进容器；provider transport/auth 放在 provider `options`，模型请求参数放在 model `options`，API key 使用 `{env:NAME}` 引用。文件同时携带 `compaction.{auto,prune}`、`aicr-output` 的 `mcp` 段和 `permission.skill` 放行规则。逐来源 instruction 文件仅供审计，合并后的 `AGENTS.md` 是唯一生效的 instruction 面。`--pure` 禁用外部插件，一次性 run 同时关闭更新、标题和 LSP 下载副作用。

### `zoo`（Zoo Code）

Zoo Code 适配器对外 `AgentKind: "zoo"`。CLI 二进制和项目配置路径仍沿用上游的 `roo` / `.roo` / `.roomodes` 兼容面，因此 AICR 把配置写入 Zoo Code 当前的 `.roo/settings.json` 路径，而不是臆造 `.zoo` 路径。

Zoo Code 不读 models.dev，因此 AICR 会向 `apiConfiguration.openAiCustomModelInfo` 注入 `contextWindow`、`maxTokens`、`supportsImages`、`supportsComputerUse`、`supportsPromptCache`、`inputPrice`、`outputPrice`。原生 auto-condense 设置（`autoCondenseContext`、`condenseContextPercentThreshold`）写入同一个 settings 文件。

### `claude-code`（Claude Code）

agent 以 headless 方式运行：`claude -p --output-format json`（print 模式，评审 prompt 经 stdin 管道传入），沙箱内加 `--dangerously-skip-permissions`，并通过 `--mcp-config`/`--strict-mcp-config` 把 `aicr-output` MCP server 与用户/项目级 MCP 配置隔离接线。JSON 结果信封让 orchestrator 拿到最终答复、逐轮 token 用量、USD 成本和轮数。reasoning effort 映射到 `--effort`（AICR 的 `minimal` 档映射为 `low`）。

Claude Code 依赖内置的 Anthropic catalog 和环境变量；没有文件级 model-metadata 接入面。环境变量翻译遵循当前的 Claude Code env-var 合同：`maxOutputTokens`（或显式 `extraParams.max_tokens`）派生 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`，`contextWindow` 派生 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，显式 thinking 预算设置 `MAX_THINKING_TOKENS` 并加 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`（否则固定预算在自适应推理模型上会被忽略），beta header 走 `ANTHROPIC_BETAS`。一次性沙箱 run 会禁用自更新、遥测和 print 模式的标题生成。context window 和定价委托给 Claude Code 的原生 catalog；能力缺口在 manifest 中记录为 `delegated`。

instructions 经生成的 `CLAUDE.md`（`@AGENTS.md` 导入共享 instructions 文件）送达 Claude Code，技能物化到 `.claude/skills/<name>/SKILL.md`。

Claude Code 默认自动压缩，因此 AICR 不注入额外的压缩配置（显式关闭时设置 `DISABLE_AUTO_COMPACT`）。

### `copilot-cli`（Copilot CLI）

适配器面向当前的 GitHub Copilot CLI（`copilot` 二进制），而不是已弃用的 `gh copilot suggest` 扩展。agent 以编程模式运行：`copilot --prompt <task> --silent --no-ask-user --allow-all-tools --allow-all-paths`，可选 `--model`、`--effort`（reasoning effort），`aicr-output` MCP server 通过 `--additional-mcp-config` 按 run 接线。headless 认证使用 `COPILOT_GITHUB_TOKEN`（CLI 优先级最高的认证环境变量）。

Copilot CLI 使用其订阅固定的 model catalog。没有模型元数据注入接入面，对话级上下文管理为 `not_applicable`（CLI 接近 token 上限时自动压缩）。AICR 在 manifest 中把模型记录为 `not_applicable`。

### `pi`

适配器面向 pi CLI（`@earendil-works/pi-coding-agent`，`pi` 二进制）。agent 以 `pi --mode json --approve --no-session --model provider/id -- <task>` 运行，评审 prompt 作为位置参数传入，stdin 保持为空。`--approve` 信任按 run 物化的 bundle 目录，使 pi 加载其中的项目级 `.agents/skills`；bundle 完全由 AICR 物化且一次性，信任它是安全的。`PI_OFFLINE=1` 与 `PI_TELEMETRY=0` 为一次性 run 关闭更新检查与安装遥测。

配置目录通过 `PI_CODING_AGENT_DIR` 隔离，指向 bundle 的 `.pi-agent/`（自定义 provider 写入 `models.json`，压缩开关写入 `settings.json`）。pi 上游明确**不内置 MCP client**，因此 runtime bundle 生成一个 TypeScript 扩展（`extensions/aicr-output.ts`），把本地 stdio `aicr-output` MCP server 桥接为名为 `pi_aicr_*` 的 pi 工具；manifest 把它如实记录为 `extension` 接入面，而不是伪装成配置文件接线。reasoning effort 与 pi 的 `--thinking` 档位一一对应，直接透传。

pi 的自定义模型条目必填 `contextWindow` 与 `maxTokens`：请启用 `llm.model_catalog`（或设置 overrides）让这些限额可解析——适配器在缺失时会抛出带指引的错误，而不是编造数值。支持的 provider kind 为 `openai_compatible`、`ollama`、`anthropic`、`google_ai_studio`；其余 kind 会显式报错，不猜测未核验的认证管线。发布镜像未内置 `pi` 二进制，使用该 kind 需要自带安装此 CLI 的自定义沙箱镜像。

### `oh-my-pi`（omp）

oh-my-pi 是 pi 的 fork（`omp` 二进制），与 pi 共用同一 JSON 事件流、`PI_CODING_AGENT_DIR` 隔离和模型 catalog 要求（镜像要求同 pi：需自定义沙箱镜像安装 `omp`）。运行形态为 `omp -p --mode json --auto-approve --no-session --model provider/id -- <task>`。与 pi 不同，它有**原生 MCP 接入面**：AICR 写 `.omp-agent/mcp.json`（manifest 记为 `config_file`），`aicr-output` 工具以 `mcp__aicr_output_aicr_*` 形态出现。自定义 provider 写入 `.omp-agent/models.yml`（`apiKey` 先按 env 名解析，keyless provider 用 `auth: none`），压缩配置写入 `.omp-agent/config.yml`（`compaction.enabled` + `compaction.thresholdPercent`）。

## 直连 LLM 回退（不是 agent kind）

当 agent CLI 即便经过结构化修复 pass 也无法产出结构化输出时，orchestrator 可以回退到直接调用 LLM gateway。这是内部回退机制，**不是**可配置的 `agent.default` 值——合法的 `agent.default` 值只有 `kilo`、`opencode`、`zoo`、`copilot-cli`、`claude-code`、`pi` 和 `oh-my-pi`。orchestrator 计算
`maxPromptTokens = floor(contextWindow × 0.6)`，让 prompt manager 在预算内裁剪 memory hints、技能和 instructions；diff 本身由 AICR 侧的压缩阶段处理。

## Model catalog 注入差异汇总

| 适配器 | 是否原生读 models.dev | 注入策略 |
| --- | --- | --- |
| opencode | 已知 provider 是；自定义 OpenAI-compatible provider 否 | 使用 schema 原生 provider/model 嵌套；仅对自定义 provider 注入完整 `limit`/`cost` 对和已知能力 |
| kilo | 否 | 注入 `contextWindow`、`maxTokens`、`supportsImages`、`supportsComputerUse`、`supportsPromptCache`、定价 |
| zoo | 否 | 注入 `.roo/settings.json` 的 `openAiCustomModelInfo` |
| claude-code | 否（内置 Anthropic catalog） | 派生输出/上下文限制与显式 thinking budget；其余委托 |
| pi | 否 | `$PI_CODING_AGENT_DIR/models.json` 写自定义 provider；`contextWindow`/`maxTokens` 必填（缺失时报错并给指引）；`apiKey` 用 `$ENV` 引用 |
| oh-my-pi | 否 | `$PI_CODING_AGENT_DIR/models.yml` 写自定义 provider；限额同样必填；`apiKey` 按 env 名解析或用 `auth: none` |
| copilot-cli | 否（固定订阅 catalog） | 不注入；记录为 N/A |

注入只发生在自定义或未被工具原生解析的 provider 路径；当工具自己能从 models.dev 解析时，AICR 跳过注入以避免双写冲突。

## 选择 agent

用全局 `agent.default` 设置。schema 也接受 `workspaces.defaults.agent.default` 和
`workspaces.instances.<id>.agent.default`，但当前版本启动时只创建一份全局适配器，
workspace 层的设置会被解析而不生效——混用 agent 需要等后续版本。适用于所有 agent kind
的超时、沙箱和上下文压缩字段参见 [Agent 与沙箱](/zh-cn/configuration/agent/)。

### 该用哪个 agent？

| Agent | 适用场景 | 注意事项 |
| --- | --- | --- |
| `kilo`（默认） | 经过验证、受支持的默认路径，端到端测试覆盖和生产硬化最充分。 | 需要声明 `contextWindow` 才能自动压缩——启用 `llm.model_catalog` 或在 overrides 里设置 `context_window`，否则大 PR 会溢出。 |
| `claude-code` | 已以 Claude Code 为标准的团队；Anthropic 原生 model catalog。 | 默认自动压缩（委托给 Claude Code 内置行为）。AICR 派生输出/上下文限制与显式 thinking budget，其余委托原生 catalog。 |
| `opencode` | 开源优先的部署；自定义 OpenAI-compatible provider。 | 已知 provider 原生从 models.dev 解析；自定义 provider 需要显式且符合 schema 的 provider/model 配置。 |
| `zoo` | 以 Zoo Code 为主力工具的团队。 | 始终需要注入 `contextWindow`/`maxTokens`/`supportsImages`/价格——启用 model catalog。 |
| `copilot-cli` | 使用 GitHub Copilot 订阅、希望零单次 LLM 成本的环境。 | 使用订阅固定的 catalog；不注入模型元数据。无对话级自动压缩接入面（`not_applicable`）。 |
| `pi` | 偏好极简、可扩展的 pi 运行时；接受扩展桥接工具的团队。 | 要求 catalog 提供 `contextWindow`/`maxTokens`；仅支持 `openai_compatible`/`ollama`/`anthropic`/`google_ai_studio`；MCP 经生成的扩展接入，不是配置文件。 |
| `oh-my-pi` | 需要原生 MCP（`mcp.json`）与更细压缩配置的 pi 系运行时。 | 模型元数据与 provider kind 要求同 `pi`。 |

### 决策指引

- **刚开始或不确定？** 用 `kilo`（默认）。它的生产验证最深，也是部署验证流程检查的 agent。
- **大 PR 上下文溢出？** 无论选哪个 agent，都要确保模型声明了 `contextWindow`（通过
  `llm.model_catalog` 或显式 `context_window` override）。否则 Kilo 和 Zoo 无法跟踪上下文用量，
  会溢出而非自动压缩。若仍发生溢出，AICR 抛出 `AgentContextOverflowError`，附带模型上限、
  请求 token 数和可操作指引——不会是泛化的 `review_orchestration_failed`。
- **想混用 agent？** 当前版本所有 workspace 共用全局 `agent.default`；workspace 层的
  agent 覆盖尚未生效，混用需要等后续版本。

能力缺口（vision、reasoning、结构化输出、工具调用）记录在每个 run 的 `manifest.json` 中，
标记为 `injected`、`delegated` 或 `not_applicable`——绝不静默丢弃。
