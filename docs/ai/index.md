# AI 文档导航

从任务涉及的代码开始。下面只用于定位资料，不要求先读路线图、整份架构或历史。
长文先搜索标题/符号，再读对应章节；仅当当前合同解释不足时补充相关决策或里程碑。

| 任务 | 首选实现与参考 |
| --- | --- |
| 当前待办、Workspace 动态配置设计 | [Plan.md](../../Plan.md)，保留其链接的未完成 specs/plans；设计不代表现版能力 |
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
| 本地优先队列 P0-P15 | 已完成 | `milestones/local-priority-queue.md` |

历史记录仅用于查交付证据；当前状态以代码、测试和前瞻路线图为准。公开用户文档位于
`docs/site/`，不发布本目录的内部指导。完成任务资料的保留规则见根 `AGENTS.md`。
