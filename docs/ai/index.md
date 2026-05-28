# AI 文档导航

这份索引用于把 `Plan.md` 保持为**前瞻型路线图**，同时把稳定设计、已完成里程碑和按需细节收纳到独立文档中。

## 快速入口

| 想知道什么 | 优先阅读 | 说明 |
| --- | --- | --- |
| 当前正在做什么 | `../../Plan.md` | 只保留当前路线图、活跃里程碑、下一执行包和简版架构摘要 |
| 稳定架构与合同 | `architecture.md` | 详细设计，按 `Plan.md` 的章节编号保留稳定引用点 |
| 已完成里程碑历史 | `milestones/*.md` | 完成项沉淀与交付面，避免反复塞回 `Plan.md` |
| 稳定决策与取舍 | `decisions.md` | 归档 D1-D27 等长期有效决策 |
| AI 规则与技能来源 | `source-index.md` | 外部 Agent/Skills/MCP 文档核验记录、刷新触发条件与兼容性证据 |
| Agent Skills 索引 | `../../.agents/skills/README.md` | 仓库技能目录地图；只按需读取具体 `SKILL.md` |
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
| M5 | 基本完成 | `milestones/M5.md` |
| M8 | 大部分完成 | `milestones/M8.md` |
| M9 | 基本完成 | `milestones/M9.md` |
| M6 | 部分完成 | 先看 `../../Plan.md` |
| M7 | 已开始 | `milestones/M7.md` |

## 维护规则

- `Plan.md` 只保留当前路线图、活跃风险、下一执行包和简要设计摘要。
- 已完成阶段的长篇总结放到 `milestones/*.md`。
- 稳定设计细节放到 `architecture.md`，避免把大段合同反复复制到 `Plan.md`、skills 或提示词中。
- 稳定决策放到 `decisions.md`，方便按主题按需读取。
- 代码/配置的最终真源仍然是实现本身，例如：
  - `packages/core/src/config.ts`
  - `packages/store/src/schema.ts`
  - `packages/core/src/prompt-manager.ts`
  - `packages/outputs/src/template-engine.ts`
