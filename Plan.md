# AICodeReviewer 实施计划

> 这份 `Plan.md` 现在只承担**前瞻型路线图**职责：描述当前方向、活跃里程碑、
> 下一执行包和各稳定合同的摘要。
>
> 已完成阶段的长篇总结已迁移到 `docs/ai/milestones/*.md`；稳定设计合同迁移到
> `docs/ai/architecture.md`；长期有效决策迁移到 `docs/ai/decisions.md`。

## 1. 文档角色与当前目标

### 1.1 这份计划文档负责什么

- 说明当前优先级、活跃里程碑和执行顺序。
- 提供稳定设计的**摘要入口**，而不是承载全部细节正文。
- 指向代码、专题文档、里程碑归档和决策索引这些按需阅读的落点。

### 1.2 当前焦点

- 继续推进 M5：补齐 Agent Runtime Bundle、原生 MCP 配置物化与 Kilo Code 端到端验收。
- 继续推进 M6：补齐 GitHub/GitLab/SVN 实战覆盖、行级 attribution 与多源上下文能力。
- 继续推进 M8：补齐 replay 快照、metrics / trace 与 eval 基线。
- 继续推进 M9：完成最终发布资产、剩余沙箱后端、从零部署验收与 changelog/版本固定。
- 本轮已完成文档收束：已完成阶段与稳定细节已搬离 `Plan.md`，未来 agent 应按需读文档，
  而不是默认吞下整份历史记录。

### 1.3 文档地图

- `docs/ai/index.md`：AI 文档总导航。
- `docs/ai/architecture.md`：稳定架构与实现合同。
- `docs/ai/decisions.md`：长期有效决策索引。
- `docs/ai/milestones/*.md`：已完成阶段归档。
- `docs/prompt-research.md`：默认评审 prompt 调研依据。
- `docs/output-channels.md`：输出通道、模板与 MCP 输出工具合同。
- `docs/podman.md`：Podman 沙箱与部署专题说明。
- `example/README.md`：示例配置、运行与部署入口。

## 2. 技术方向与仓库组织

### 2.1 技术栈摘要

- 核心实现使用 TypeScript / Node 20。
- 工作区使用 pnpm + TypeScript project references。
- review 流程长期目标是“服务编排 + AgentAdapter + Sandbox + Output Pipeline”。
- 单容器自托管是主路径，Podman 与 Docker 平等支持。

### 2.2 目录与 workspace 布局

- 仓库采用多 package workspace。
- runtime workspace 采用 `workspaces/<workspace_id>/` 扁平布局。
- `workspace_id` 只允许出现在 `workspaces.instances.<id>` 下。
- 公共模块保持平台中立；provider/VCS 特有命名留在适配层、配置层和平台专用文档中。

### 2.3 AI 资产组织原则

- `AGENTS.md` 是唯一常驻仓库级规则源。
- `.agents/skills/*/SKILL.md` 是 canonical workflow 技能源。
- 已完成阶段长文总结放到 `docs/ai/milestones/*.md`。
- prompt/skill 只保留稳定约束和入口索引，不复制历史大段正文。

## 3. 核心组件摘要

> 本节只保留摘要与引用点；详细合同见 `docs/ai/architecture.md`。

### 3.1 触发器与 ReviewEvent

- 所有 webhook、trigger、手工和定时入口都要归一到统一 `ReviewEvent`。
- 鉴权、签名校验与事件归一化必须先于入队执行。
- GitHub / GitLab 共享 webhook 路由支持按已验证 secret/token + repo 标识选择不同 trigger profile，用于隔离不同仓库的 token、webhook secret 与文件过滤规则。
- async 入口以 `202 + runId` 作为非阻塞语义。
- P4 trigger 只提交最小 metadata，服务端负责后续拉取和分析。
- **Review 去重**：async 模式下，同一 target（`provider:repoRef:targetKind:branch`）的并发 review 请求会被合并；running review 完成后自动触发最后一次 pending 的 re-review。
- 详细合同：`docs/ai/architecture.md` §3.1、§3.1.1。

### 3.2 VCS adapter 与 scoped fetch

- VCS 访问保持统一三段式合同：列举变更、scoped fetch、额外上下文/归因。
- 默认以单仓 `primary` 行为为主，多源上下文显式开启。
- Git、P4、SVN、GitHub、GitLab、Gitea/Forgejo 的平台差异留在适配层消化。
- P4 的额外上下文保持最小拉取：diff 缺失/过窄时先取完整变更文件，必要的相关文件按 changelist revision 在配置 depot 内 `p4 print`，不做全仓同步。
- 归因能力必须来自事件、provider API 或只读 VCS 工具。
- 详细合同：`docs/ai/architecture.md` §3.2。

### 3.3 Compression

- 压缩是 `summarize -> review` 两阶段，而不是简单截断 diff。
- 触发由 token 阈值和输入占比共同控制。
- 大 diff 稳定性优先于“全量上下文强行塞进模型”。
- 详细合同：`docs/ai/architecture.md` §3.3。

### 3.4 Secrets Scrubber

- prompt 前与输出前都要做 scrubber。
- 脱敏是兜底，不替代更上游的最小暴露原则。
- 详细合同：`docs/ai/architecture.md` §3.4。

### 3.5 LLM Gateway、Fallback 与预算

- LLM 调用通过统一 gateway 进入 provider client。
- bounded retry、fallback chain、预算与速率限制分层治理。
- provider 差异由 translator 与 gateway 吸收。
- 详细合同：`docs/ai/architecture.md` §3.5。

### 3.6 Prompt Manager 与 AI 资产装配

- 保护性规则、用户公共层、工程层规则按稳定优先级合并。
- repo-local `AGENTS.md`、path instructions 与 skills 需要自动发现、去重和冲突检测。
- 只激活与当前 review 路径相关的 repo-local 资产。
- 详细合同：`docs/ai/architecture.md` §3.6、§3.6.1、§3.6.2。

### 3.7 AgentAdapter 与模型翻译

- Kilo、Claude Code、OpenCode、Roo、Copilot CLI 等 adapter 共用统一 runtime 合同。
- `ModelSpec` / `thinkingLevel` 在 adapter 内翻译到各 provider 原生字段。
- 能力不支持时要显式降级，而不是静默忽略。
- 详细合同：`docs/ai/architecture.md` §3.7、§3.7.3。

### 3.8 SandboxBackend

- native、docker、podman 是当前主路径；`docker_socket`、`k8s_pod` 保留扩展位。
- 沙箱必须统一执行 allowlist、只读源码挂载、隔离 cwd 和超时治理。
- Podman 与 Docker 共享同一容器合同。
- 详细合同：`docs/ai/architecture.md` §3.8 与 `docs/podman.md`。

### 3.9 输出通道、模板与 MCP 工具

- 输出层统一承接 problem、summary、issue、IM 通知等渲染与发布。
- 当前稳定工具集合为：
  - `aicr.report_problem`
  - `aicr.publish_summary`
  - `aicr.skip`
  - `aicr.fetch_more_context`
- 未落地能力不得提前作为“已实现工具”对外宣传。
- Agent CLI 自由文本 stdout 不作为正式报告；无法解析工具 payload 时先做结构化修复重试，IM 输出保持 target/summary/problems 分段并从 `aicr.report_problem` 渲染位置。
- Summary 声称发现问题但没有 `aicr.report_problem` 记录，或 skip/summary 要求人类补 diff/source context 时，按结构化输出失败处理并修复，避免 `problemCount=0` 被 no-problems 策略静默压掉。
- 详细合同：`docs/ai/architecture.md` §3.9 与 `docs/output-channels.md`。

### 3.9.0 PR Review Summary 更新模式

- PR/MR review 通道（`gitea_pr_review`、`github_pr_review`）支持 `review_update_strategy`：`always_new` 或 `update_existing`（默认）。
- `update_existing` 模式下，summary comment 通过 HTML 标记识别，用 PATCH 更新而非每次新建；问题按 fingerprint 分为 Still Open / New / Resolved 三类。
- 详细合同：`docs/ai/architecture.md` §3.9.0。

### 3.9.1 `no_problems` 与 target 渲染

- `no_problems.action` 按全局 → channel → workspace 覆盖。
- 目标链接用标准化 `target` 上下文渲染，不把所有目标都写成 `View PR`。
- 详细合同：`docs/ai/architecture.md` §3.9.1 与 `docs/output-channels.md`。

### 3.9.5 Managed problem issue 生命周期

- `gitea_problem_issue` 和 `github_problem_issue` 支持 `issue_mode`:
  - `consolidated`（默认）：一次分析的所有问题合并为一个 issue，scope fingerprint 驱动更新与关闭。
  - `per_problem`：每个问题独立 issue，fingerprint 驱动生命周期。
- managed issue 标题由输出层生成并保持单行可读：单问题用 `per_problem` 格式（含位置与摘要），多问题在最高 severity + 计数后附加代表性摘要；summary title 只影响正文 summary heading。
- 详细合同：`docs/ai/architecture.md` §3.9.5 与 `docs/output-channels.md`。

### 3.10 配置体系

- 配置 schema 的代码真源是 `packages/core/src/config.ts`。
- `workspaces.cache` / `workspaces.defaults` / `workspaces.instances.<id>`
  是稳定命名空间。
- 同一路由上的多 GitHub / GitLab trigger 需要通过 `source_repo.trigger` 做 repo → profile 显式绑定。
- 配置变更应同步 schema 测试、示例配置、专题文档与本计划摘要。
- 详细合同：`docs/ai/architecture.md` §3.10。

### 3.11 Run 状态与可观测性

- 持久化 schema 的代码真源是 `packages/store/src/schema.ts`。
- async trigger、失败报告、publisher 行为和 replay 需要统一落在可观测性合同里。
- 详细合同：`docs/ai/architecture.md` §3.11。

### 3.12 Reflection 与 memory

- 当前只保留 schema 与扩展位，不提前宣传为已完成功能。
- 真正落地时要明确 workspace 隔离、脱敏边界和收益评估。
- 详细合同：`docs/ai/architecture.md` §3.12。

## 4. 默认评审 Prompt 原则

- 默认 system prompt 只保留稳定硬规则、输出协议与安全边界。
- 调研依据与样例保留在 `docs/prompt-research.md`。
- repo-local AI 资产按路径与优先级按需装配，不整仓注入。
- 删除行、旧代码、上下文缺失等高风险场景需要在 prompt 中显式约束。
- 工具合同由实现与注册表定义，不靠 prompt 发明字段。

## 5. 用户入口与专题文档

- 配置和部署示例：`example/README.md`
- 输出合同：`docs/output-channels.md`
- Podman 指引：`docs/podman.md`
- AI 文档总导航：`docs/ai/index.md`
- 代码级真源优先级高于文档；文档用于解释合同与边界，不复制实现细节。

## 6. 安全与运营基线

- 先鉴权，后入队。
- secret scrubber 覆盖 prompt、日志和输出边界。
- attribution、作者信息和用户可见 target 必须可验证。
- sandbox 执行最小权限、最小挂载、最小命令能力原则。
- 远程部署和调试流程不得打印 `.env` 或 secret 文件原文。

## 7. 测试与验证基线

- 默认验证顺序：
  1. `node node_modules/eslint/bin/eslint.js .`
  2. `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false`
  3. `node node_modules/vitest/vitest.mjs run`
  4. `node node_modules/markdownlint-cli2/markdownlint-cli2.mjs "**/*.md" "!**/node_modules/**" "!**/dist/**" "!**/coverage/**"`
  5. 构建步骤
- 在 Linux/CI 等 `pnpm` 可直接执行的环境中，可使用等价的
  `pnpm lint/typecheck/test/markdownlint/build`。
- `Plan.md` 与 `docs/**/*.md` 共同接受 markdownlint 校验。
- 配置、输出合同、runtime bundle、sandbox、AI 资产层变更必须补对应测试或至少补齐文档理由。

## 8. 里程碑与执行顺序

### 8.1 当前状态

| 里程碑 | 状态 | 主要落点 | 下一步 |
| --- | --- | --- | --- |
| M0 | 已完成 | `docs/ai/milestones/M0.md` | 保持基线稳定 |
| M0.5 | 已完成 | `docs/ai/milestones/M0.5.md`、`docs/prompt-research.md` | 继续为 prompt/runtime 变更提供依据 |
| M1 | 已完成 | `docs/ai/milestones/M1.md` | 作为最小 review 闭环基线 |
| M2 | 已完成 | `docs/ai/milestones/M2.md` | 作为 agent/sandbox 基线 |
| M3 | 已完成 | `docs/ai/milestones/M3.md` | 继续复用压缩、预算、队列与 scrubber 能力 |
| M4 | 已完成 | `docs/ai/milestones/M4.md` | 继续扩展模板、路由与 attribution |
| M5 | 进行中 | 多 Agent CLI、Podman、runtime bundle | Kilo Code 端到端验收、原生 MCP server 注入 |
| M6 | 进行中 | 多 VCS、trigger 面、P4 生产链路 | 补齐 SVN、真实 GitHub/GitLab e2e、归因与多源上下文 |
| M7 | 未开始 | workspace 定制、skill by glob、国际化、memory | 等待 M5/M6 更稳定后推进 |
| M8 | 进行中 | structured logs、replay 基础、日志落盘 | 补齐 OTel、metrics、runs 快照、eval |
| M9 | 进行中 | 文档、示例、发布与剩余沙箱后端 | 补齐 `docker_socket` / `k8s_pod`、发布资产与从零验收 |

### 8.2 当前执行包

1. **M5：runtime bundle 与 agent 原生能力对齐**
    - ~~物化原生 MCP 配置~~（已交付：runtime bundle 物化 MCP 工具清单到 manifest）
    - ~~补齐 Agent Runtime Bundle manifest~~（已交付：`@aicr/agents` `materializeRuntimeBundle`）
    - ~~移除 Kilo 适配器过期标志~~（已交付：`--dangerously-skip-permissions` 已从 kilo adapter 移除，`--auto` 即为 kilo 7.x 的自动审批方式）
    - ~~MCP server 配置注入~~（已交付：runtime bundle 支持 `mcpServers` 参数，Kilo adapter 自动写入 `mcp` 配置段到 `.kilo/kilo.json`）
    - 完成 Kilo Code 端到端验收
    - 独立 MCP 服务器进程（当前为 stdout 回退；需要将 `@aicr/mcp-output` 暴露为 stdio/HTTP 独立服务）
2. **M6：跨 VCS 能力补齐**
   - SVN 支持
   - GitHub/GitLab 真实 e2e
   - blame/annotate 归因链路
   - 多源上下文 selector
3. **M8：观测与回放**
   - OTel trace
   - Prometheus metrics
   - `runs/<run_id>/` 完整快照
   - eval CLI / 基准集
4. **M9：发布收尾**
   - `docker_socket` / `k8s_pod`
   - 版本固定与 changelog
   - 从零部署文档验收
   - 最终发布检查单

### 8.3 已完成阶段归档

- `docs/ai/milestones/M0.md`
- `docs/ai/milestones/M0.5.md`
- `docs/ai/milestones/M1.md`
- `docs/ai/milestones/M2.md`
- `docs/ai/milestones/M3.md`
- `docs/ai/milestones/M4.md`

## 9. 稳定决策索引

- 长期有效的 D1-D27 决策已迁移到 `docs/ai/decisions.md`。
- 典型使用方式：
  - 先看本计划确认“现在做什么”
  - 再看 `docs/ai/decisions.md` 理解“为什么这样做”
  - 最后看 `docs/ai/architecture.md` 或代码确认“现在是怎么做的”

## 10. 扩展点

- Context Provider 插件：见 `docs/ai/architecture.md` §10.1。
- Output Pipeline 中间件 / 审批流扩展：见 `docs/ai/architecture.md` §10.2。
- 扩展点目标是**保留接口与边界**，不是提前把未实现能力包装成已完成能力。

## 11. 部署与发布摘要

- 首选单容器自托管，HTTP 入站由反向代理处理 TLS。
- 持久化保留 `config.yaml`、`.env`、workspace 数据、数据库和日志目录。
- Podman / Docker 使用同一构建与运行合同，差异由 engine 选择吸收。
- 健康检查统一使用 `/healthz`。
- 部署与验收入口：`example/README.md`、`docs/podman.md` 与相关 skill。
