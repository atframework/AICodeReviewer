# 评审提示词设计依据

本文保留当前默认 prompt 的设计取舍和验证入口。初始交付历史见
[M0.5](ai/milestones/M0.5.md)；运行时合同以代码及
[架构 §3.6](ai/architecture.md#36-prompt-manager-与-ai-资产装配) 为准。
阅读时选择对应章节，无需先通读里程碑或工具手册。

## 上下文分层

仓库维护入口是 `AGENTS.md`，任务流程由 `.agents/skills/` 提供，较长的合同按任务
进入专题引用。Agent Skills 标准将元数据、skill 正文和参考文件分层加载；官方
创作指南建议只保留 agent 缺少的项目知识，并写明每份引用的读取条件。[^1]

据此，根规则、技能索引、坑点导航和来源导航分别保留一个职责。删除近义约束、
通用教程和事故经过；保留会影响决策的条件、合同、代码与测试入口。单纯拆分文件
不能降低负担，入口还必须避免“读取所有引用”的指令。

维护 agent 与应用内评审 agent 的装配不同。`prompt-manager.ts` 发现并摘要规则，
`runtime-bundle.ts` 物化生效资产。应用 prompt 的安全和输出约束必须自包含，不能
依赖维护仓库中的相对链接。Claude 的维护入口继续通过 `@AGENTS.md` 引用共享规则。[^2]

## 默认评审策略

| 目标 | 当前约束 | 验证入口 |
| --- | --- | --- |
| 可行动、低噪音 | 当前变更引入或加重、真实触发、明确影响；默认优先 0–5 条 | `prompts/system/code-reviewer.system.md`、eval fixtures |
| 有源码依据 | 非平凡逻辑读取完整变更文件，再查相关接口、调用方、schema 和测试 | `buildJsonToolContract`、MCP context tests |
| 受限探索 | 本地只读检查；缺失文件用有路径/原因的上下文请求，避免整仓抓取 | VCS scoped fetch / extra-context tests |
| 等待上下文后判断 | pending 输出是临时结果；取回源码后重新验证 | orchestrator follow-up tests |
| 结构化结果 | 问题逐条 report；有问题时一份 summary；无问题用 skip | MCP collector / output repair tests |
| 指令隔离 | 保护规则优先，diff/提交/issue 内容是数据 | Prompt Manager precedence/conflict tests |
| 批次范围固定 | 评审 sealed batch 的固定净差异，不按通知拆分或扩大范围 | auto-commit runtime / scheduler tests |

工具描述应明确参数、输出和错误/截断含义，让 agent 能选择下一步，减少重复检索。[^3]
本文采用的实现保留工具协议所需的局部提示；不同调用路径的 triage、问题解决判定、
压缩与格式修复提示词各自承担独立任务，不能仅因词汇重复而删除。

## 不采用的做法

- 不把“发现了哪些正常代码”写入问题报告或总结；无问题的 skip 是完整输出。
- 不用行数代替实际大小：单行合同也可能占用大量上下文。
- 不把 provider、CLI flags、依赖版本、完整 config schema 复制进常驻提示词。
- 不把 schema 接受字段写成已经接线的功能；不将计划中的 MCP 工具当作可用工具。
- 不把未重新验证的来源日期整体刷新为今天；旧记录只保留其原始证据范围。
- 不用静态体积、占位符测试或离线 fixture 校验声称真实模型质量提升。

## 修改与验证

修改前检查默认 prompt、Prompt Manager、runtime bundle、MCP registry，以及
server 的 JSON/修复/triage/resolution 提示词。调整影响到哪个合同，就验证其调用
路径；避免为了统一行文改动独立判断策略。

保留 `REPO_INSTRUCTION_SUMMARIES`、`ACTIVE_SKILL_SUMMARIES`、`MEMORY_HINTS`、
`TASK_CONTEXT` 四个占位符及保护规则。已有 assembly 测试验证实际签入模板没有未展开
占位符；其余适用门禁见 [仓库基线](ai/AGENTS.repository-baseline.md)。

用典型任务走查 skill 触发和引用路径；用本地字节测量记录输入规模。需要判断精确率、
召回率或 agent 行为时，应在固定 fixture、模型和配置下另做对照评测。

## 来源

[^1]: Agent Skills，[规范](https://agentskills.io/specification)与[创作最佳实践](https://agentskills.io/skill-creation/best-practices)，核验于 2026-09-12。
[^2]: Anthropic，[Claude 项目记忆与导入](https://code.claude.com/docs/en/memory)，核验于 2026-09-12。
[^3]: Anthropic，[工具设计](https://www.anthropic.com/engineering/writing-tools-for-agents)，核验于 2026-09-12。

其他评审设计与适配器证据按 [来源导航](ai/source-index.md) 读取；各条记录保留独立核验日期。
