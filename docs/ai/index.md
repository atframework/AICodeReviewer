# AI 文档导航

从任务涉及的代码开始。下面只用于定位资料，不要求先读路线图、整份架构或历史。
长文先搜索标题/符号，再读对应章节；仅当当前合同解释不足时补充相关决策或里程碑。
设计文档和双语用户说明的统一入口见[文档目录](../README.md)。

| 任务 | 首选实现与参考 |
| --- | --- |
| 当前待办与验收边界 | [Plan.md](../../Plan.md)；Workspace 动态配置稳定合同见架构 §3.10、§3.14–3.16，交付证据见 M17–M28 |
| Config / workspace / model groups | `packages/core/src/config.ts`、server bootstrap；[架构 §3.10](architecture.md#310-配置体系)、[配置坑点](pitfalls/AGENTS.config-and-state.md) |
| Webhook / 调度 / 去重 / PR 延期 | server runtime/scheduler/deferral-manager；[架构 §3.1](architecture.md#31-触发器与-reviewevent-归一化)、[调度坑点](pitfalls/AGENTS.scheduling.md) |
| VCS / 多源上下文 / GitHub App | `packages/vcs/src/`、server credential wiring；[架构 §3.2](architecture.md#32-vcs-adapter-与-scoped-fetch)、[VCS 坑点](pitfalls/AGENTS.vcs.md) |
| Prompt / agent / MCP / sandbox | core prompt-manager、agents runtime-bundle、mcp-output；[运行时 skill](../../.agents/skills/agent-runtime-integration/SKILL.md)、架构 §3.6–3.8 |
| 输出 / 模板 / IM / 问题生命周期 | outputs、server bootstrap；[输出合同](../output-channels.md)、[输出 skill](../../.agents/skills/output-channel-contracts/SKILL.md) |
| Store / 用量 / 实时面板 | store、server live-runs/observability；[架构 §3.11](architecture.md#311-run-状态与可观测性) |
| 模型目录 / 压缩 / reflection | llm、server catalog-service、core reflection；架构 §3.3、§3.5、§3.12–3.13 |
| 验证 / 工具 / 公开文档站 | [基线门禁](AGENTS.repository-baseline.md)、[文档 skill](../../.agents/skills/docs-writing-style/SKILL.md)、[构建坑点](pitfalls/AGENTS.build-and-docs.md) |
| AI 提示词与 skills 维护 | [维护 skill](../../.agents/skills/ai-agent-maintenance/SKILL.md)、[技能索引](../../.agents/skills/README.md)、[来源地图](source-index.md) |
| 易回归问题 / 设计取舍 | [坑点地图](AGENTS.known-pitfalls.md)、[决策索引](decisions.md)，按议题选择 |
| 默认评审 prompt 依据 | [设计依据](../prompt-research.md)、[实际模板](../../prompts/system/code-reviewer.system.md) |
| 部署 / 用户示例 | [部署 skill](../../.agents/skills/remote-deployment/SKILL.md)、[Podman](../podman.md)、[示例](../../example/README.md) |

## 里程碑归档

| 里程碑 | 状态 | 文档 |
| --- | --- | --- |
| M0 | 已完成 | `milestones/M0.md` |
| M0.5 | 已完成 | `milestones/M0.5.md` |
| M1 | 已完成 | `milestones/M1.md` |
| M2 | 已完成 | `milestones/M2.md` |
| M3 | 已完成 | `milestones/M3.md` |
| M4 | 已完成 | `milestones/M4.md` |
| M5 | 已完成 | `milestones/M5.md` |
| M6 | 部分完成 | `milestones/M6.md` |
| M7 | 已完成 | `milestones/M7.md` |
| M8 | 基本完成 | `milestones/M8.md` |
| M9 | 核心交付完成，预留扩展见路线图 | `milestones/M9.md` |
| M10 | 已交付，真实本机 Redis 已验收 | `milestones/M10.md` |
| M11 文档站子工程 | 已完成（2026-08-28 线上记录；本轮仅本地验证） | `milestones/M11.md` |
| M12 GitHub App 认证 | 已完成 | `milestones/M12.md` / `architecture.md` §3.2.1 |
| M13 pi + oh-my-pi 集成 | 已完成 | `milestones/M13.md` |
| M13.1 agent web search 治理 | 已完成 | `milestones/M13.1.md` |
| M14 多源上下文聚合 | 已完成 | `milestones/M14.md` / `architecture.md` §3.2.2 |
| M15 自动提交调度 | 已完成 | `milestones/M15.md` / `architecture.md` §3.1.1 / `decisions.md` D35 |
| M16 PR/MR 执行时段与持久化延期 | 已完成 | `milestones/M16.md` / `architecture.md` §3.1.1 / `decisions.md` D36 |
| M17 配置存储、schema 迁移与 PG 后端 | 已完成 | `milestones/M17.md` / `architecture.md` §3.14 |
| M18 来源合并、路由图与发布服务 | 已完成 | `milestones/M18.md` / `architecture.md` §3.15 |
| M19 运行时配置 generation 与配置管理 API | P4/P5 已交付；本地验收完成 | `milestones/M19.md` / `architecture.md` §3.16 |
| M20 配置管理表单与管理页面 | P6 已交付；本地验收完成 | `milestones/M20.md` |
| M21 P7 集成测试与审查修复 | SVN 修复、真实服务及故障证据 | `milestones/M21.md` |
| M22 P7 组合验收补齐、P8 收敛与资料退役 | 原交付记录；复审修正见 M23 | `milestones/M22.md` / `architecture.md` §3.10、§3.14–3.16 |
| M23 P8 复审 | 凭据/输出/预览修复；当时遗留的本地缺口已在 M24 补齐 | [M23](milestones/M23.md) |
| M24 跨版本迁移与停机排空 | 指定历史版本对与两平台真实服务验收完成，任务资料退役 | [M24](milestones/M24.md) |
| M25 Workspace 与动态配置全量复审 | 高/中/低 31 项修复含双高危（发布期 workspace 校验、v2 准入回退），合同精炼见 D47；任务资料退役记录见 M26 | [M25](milestones/M25.md) / `decisions.md` D47 |
| M26 Workspace 与动态配置再次复审 | generation 所有权、重复暂存、发布/恢复/预览边界修复与当前验收；任务资料已退役 | [M26](milestones/M26.md) |
| M27 管理页面修订与模板/Prompt 管理 | kind 区块隐藏、Routing 修复、共享全局数据库优先（D48）、模板/prompt 实体（D49）；合同同步双语公开文档 | [M27](milestones/M27.md) / `decisions.md` D48–D49 |
| M28 逐目标发布恢复与配置示例校验 | 批次 `publication_pending` 逐渠道回执续发（D50）、复合 publisher 恢复钩子、管理 API `publications`；文档配置片段全量 schema 校验与阴性用例 | [M28](milestones/M28.md) / `decisions.md` D50 |
| M29 计划精简与 WSL 临时服务验收 | 精简历史、核对残留条件，真实 Gitea 指派及资源清理 | [M29](milestones/M29.md) / [服务验收](../testing-services.md) |
| M30 环境变量验收与 SVN 修复 | 用户确认 P4/GitHub；飞书、两组 LLM、Podman SVN 及导出修复 | [M30](milestones/M30.md) |
| 本地优先队列 P0-P15 | 已完成 | `milestones/local-priority-queue.md` |

历史记录仅用于查交付证据；当前状态以代码、测试和前瞻路线图为准。公开用户文档位于
`docs/site/`，不发布本目录的内部指导。完成任务资料的保留规则见根 `AGENTS.md`。
归档只保留交付结论、证据入口和限制；完整过程可由 Git 历史追溯。
