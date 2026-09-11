# AI 文档导航

这份索引用于把 `Plan.md` 保持为**前瞻型路线图**，同时把稳定设计、已完成里程碑和按需细节收纳到独立文档中。

## 快速入口

| 想知道什么 | 优先阅读 | 说明 |
| --- | --- | --- |
| 当前正在做什么 | `../../Plan.md` | 当前状态、本地下一步、外部验收与预留扩展 |
| Workspace 多工程、动态配置和迁移（仅设计，待实现） | [设计](../superpowers/specs/2026-09-11-workspace-config-management.md)、[执行计划](../superpowers/plans/2026-09-11-workspace-config-implementation.md)、[测试计划](../superpowers/plans/2026-09-11-workspace-config-tests.md) | 文件来源只读、数据库配置管理、Handlebars 路径变量、运行配置版本与 SQLite/PostgreSQL/Redis 迁移；不代表现版能力 |
| 自动提交调度（M15，已完成） | [里程碑](milestones/M15.md)、`architecture.md` §3.1.1、`decisions.md` D35 | 延迟、多组周计划、跨通知来源分组/成员去重、来源排除（glob/regex）；P4 至少 User+Client；Git/Redis/P4/SVN 均有真实环境实测 |
| 稳定架构与合同 | `architecture.md` | 详细设计和稳定章节引用；不依赖路线图章节编号 |
| 已完成里程碑历史 | `milestones/*.md` | 完成项沉淀与交付面，避免反复塞回 `Plan.md` |
| 稳定决策与取舍 | `decisions.md` | 长期有效决策及其实现入口 |
| 用户文档站交付 | [M11](milestones/M11.md) | 文档工程边界、内容分层、校验器和历史发布验收 |
| 公开用户文档站源 | `../site/` | M11 Astro Starlight 文档站工程（中英双语），发布到 GitHub Pages 的公开用户入口 |
| AI 规则与技能来源 | `source-index.md` | 外部 Agent/Skills/MCP 文档核验记录、刷新触发条件与兼容性证据 |
| 已知代码坑位 | `AGENTS.known-pitfalls.md` | 从根 `AGENTS.md` 拆出的按需清单；非平凡实现/审查前阅读 |
| Agent Skills 索引 | `../../.agents/skills/README.md` | 仓库技能目录地图；只按需读取具体 `SKILL.md` |
| 文档写作与去AI化风格 | `../../.agents/skills/docs-writing-style/SKILL.md` | 写/修订 Markdown 文档时的事实核验流程与中英禁忌清单 |
| 评审提示词设计依据 | `../prompt-research.md` | M0.5 调研与默认 prompt 设计 rationale |
| 输出通道契约 | `../output-channels.md` | MCP 输出工具、模板变量、路由与 IM 行为 |
| Podman 沙箱说明 | `../podman.md` | Podman/rootless 部署和沙箱说明 |
| 可运行示例与部署样例 | `../../example/README.md` | 本地、Compose、Webhook、P4 trigger 等示例 |

## 推荐阅读顺序

### 做实现或排查功能问题

1. `../../Plan.md`
2. `architecture.md`
3. 相关专题文档（如 `../output-channels.md`、`../podman.md`）
4. 需要历史背景时再读 `milestones/*.md`

### 做 Plan/实现差距审计

1. `../../Plan.md` 的当前状态与下一执行包
2. `architecture.md` 的对应章节
3. `decisions.md`
4. 相关 milestone 文档

### 做 AI 资产维护

1. `../../AGENTS.md`
2. `source-index.md`
3. `../../.agents/skills/README.md`
4. `AGENTS.repository-baseline.md`
5. 相关 `.agents/skills/*/SKILL.md`
6. 需要历史背景时再读 `milestones/*.md`

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
| 本地优先队列 P0-P15 | 已完成 | `milestones/local-priority-queue.md` |

## 维护规则

- `Plan.md` 只保留当前状态、本地下一步、外部验收与预留扩展。
- 已完成阶段的长篇总结放到 `milestones/*.md`。
- 稳定设计细节放到 `architecture.md`，避免把大段合同反复复制到 `Plan.md`、skills 或提示词中。
- 稳定决策放到 `decisions.md`，方便按主题按需读取。
- `docs/superpowers/specs/` 与 `docs/superpowers/plans/` 只保留进行中的任务资料；实现和验证完成且稳定结论已沉淀后，删除对应临时文件。
- 已修复的易回归问题放到 `AGENTS.known-pitfalls.md`，根 `AGENTS.md` 只保留读取条件和索引。
- 代码/配置的最终真源仍然是实现本身，例如：
  - `packages/core/src/config.ts`
  - `packages/store/src/schema.ts`
  - `packages/core/src/prompt-manager.ts`
  - `packages/outputs/src/template-engine.ts`
