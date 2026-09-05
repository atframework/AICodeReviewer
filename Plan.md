# AICodeReviewer 实施计划

> `Plan.md` 只承担**前瞻型路线图**职责：说明当前方向、活跃里程碑、
> 下一执行包、外部验收项和稳定合同入口。
>
> 已完成阶段的长篇总结在 `docs/ai/milestones/*.md`；稳定设计合同在
> `docs/ai/architecture.md`；长期决策在 `docs/ai/decisions.md`。不要把这些
> 历史正文再次复制回本文件。

## 1. 文档角色与当前目标

### 1.1 维护原则

- 本文件只回答“现在做什么、下一步做什么、哪些仍未完成”。
- 已完成内容只保留一行状态和归档链接；实现细节读 `docs/ai/index.md` 后按需跳转。
- 未完成内容统一收进 §8.3 Backlog，并显式标注所依赖的外部条件。
- 当代码、配置、输出合同、部署或公共 workflow 变化时，同步更新相关 `docs/`、
  `example/` 与本计划摘要；若无需更新，变更说明里写明原因。

### 1.2 当前焦点

- M0–M13.1 全部里程碑已交付（M6/M8/M9/M10 留有个别外部验收项，见 §8.3）。
- M14 多源上下文聚合已交付：workspace 级 `context_repositories` 声明式配置 + 每次 run
  全新物化 + 容器沙箱只读挂载（`docs/ai/architecture.md` §3.2.2、`docs/ai/milestones/M14.md`）。
- 当前没有其他新的运行时代码本地执行包；剩余工作全部依赖外部系统或外部事件，
  集中列在 §8.3，避免散落在已完成里程碑描述中。

### 1.3 文档地图

- `docs/ai/index.md`：AI 文档总导航。
- `docs/ai/architecture.md`：稳定架构与实现合同。
- `docs/ai/decisions.md`：长期有效决策索引。
- `docs/ai/AGENTS.known-pitfalls.md`：已修复的易回归坑位按需清单；非平凡实现/审查前阅读。
- `docs/ai/documentation-site-plan.md`：M11 文档站子工程建设计划。
- `docs/ai/milestones/*.md`：已完成阶段归档。
- `docs/site/`：M11 用户文档站子工程（Astro Starlight，中英双语），公开用户入口。
- `docs/prompt-research.md`：默认评审 prompt 调研依据。
- `docs/output-channels.md`：输出通道、模板与 MCP 输出工具合同。
- `docs/podman.md`：Podman 沙箱与部署专题说明。
- `example/README.md`：示例配置、运行与部署入口。

## 2. 技术方向与仓库组织

### 2.1 技术栈摘要

- 核心实现使用 TypeScript / Node，仓库使用 pnpm workspace。
- review 流程长期主路径是“服务编排 + AgentAdapter + Sandbox + Output Pipeline”。
- 单容器自托管是主部署路径，Podman 与 Docker 平等支持。
- 用户文档站使用 Node/pnpm 生态的静态站点方案（Astro Starlight），不引入独立
  Python/Ruby 工具链作为主路径。

### 2.2 目录与 workspace 布局

- 运行时代码包继续放在 `packages/*`。
- runtime workspace 采用 `workspaces/<workspace_id>/` 扁平布局。
- `docs/site` 文档站作为 `docs/` 下的“文档应用”接入 pnpm workspace；不进入根
  `tsconfig.json` 运行时代码 project references，依赖不进入运行时镜像。

### 2.3 AI 资产组织原则

- `AGENTS.md` 是唯一常驻仓库级规则源。
- `.agents/skills/*/SKILL.md` 是 canonical workflow 技能源。
- 已完成阶段长文总结放到 `docs/ai/milestones/*.md`。
- prompt/skill 只保留稳定约束和入口索引，不复制历史大段正文。
- 易回归坑位和长合同进入 `docs/ai/AGENTS.known-pitfalls.md` 或 skill `references/`，
  主提示词只保留按需读取条件。

## 3. 核心组件摘要

> 本节只保留路线图级摘要和稳定引用。详细合同见 `docs/ai/architecture.md`。

### 3.1 触发器与 ReviewEvent

- 所有 webhook、trigger、手工和定时入口都归一到统一 `ReviewEvent`。
- async 入口以 `202 + runId` 作为非阻塞语义。
- PR review request、评论命令 re-review、push 全零 SHA 跳过、trigger 去重等稳定行为见
  `docs/ai/architecture.md` §3.1。

### 3.2 VCS adapter 与 scoped fetch

- VCS 访问保持统一三段式合同：列举变更、scoped fetch、额外上下文/归因。
- Git、P4、SVN、GitHub、GitLab、Gitea/Forgejo 差异留在适配层。
- `aicr.fetch_more_context` 与 `aicr.try_blame` 是只读上下文工具，详细边界见
  `docs/ai/architecture.md` §3.2、§3.9.2。
- GitHub 出站认证支持静态 PAT / installation token，以及 GitHub App 原生 JWT →
  installation token 自动签发与刷新（M12 已交付）；token 服务归属 `packages/server`，
  `packages/vcs`、`packages/outputs` 继续只消费字符串 token，合同见
  `docs/ai/architecture.md` §3.2.1。
- 多源上下文聚合（M14）：workspace 级 `context_repositories` 声明辅助仓库，每次 run
  全新物化并以只读挂载暴露给 agent 沙箱，合同见 `docs/ai/architecture.md` §3.2.2。

### 3.3 Compression 与上下文管理

- AICR 侧 diff 压缩和 agent 运行时 auto-compaction 是两层互补能力。
- 未显式配置时，压缩阈值从模型 context window 派生。
- Kilo 等 agent 需要可用的 `contextWindow` 元数据才能正确自动压缩。

### 3.4 Secrets Scrubber

- Scrubber 覆盖 prompt 前、日志/模板渲染和输出前边界。
- 脱敏是兜底，不替代最小暴露原则。

### 3.5 LLM Gateway、Fallback 与预算

- LLM 调用通过统一 gateway 进入 provider client。
- bounded retry、fallback chain、预算、速率限制与队列 retry 分层治理；瞬时 IO 错误
  （超时、连接失败、HTTP 408/5xx）由共享 `io-retry` 分类器统一重试（HTTP 429 由
  gateway 按 Retry-After 单独处理；输出与 triage 层的非幂等 POST 不重试）。明确的
  账户余额、套餐周期或 spend-limit 耗尽不重试当前模型，立即沿 `llm.model_chain` 切换；
  普通限流/容量型 429 仍按退避策略处理，其他确定性 4xx 不重试。
- Agent CLI 路径从终端事件、错误信封或进程错误中识别同一组额度耗尽信号，切换时用下一条
  `ModelSpec` 重新物化整套 runtime bundle 后重跑本次任务；最终模型和 fallback 计数进入 run 摘要。
- `llm.model_chain` 定义命名模型组，`llm.default_model_chain` 选择全局主链。
  workspace defaults / instances 可用 `model_chain` 选择不同组；主模型、agent
  故障切换和压缩摘要都在所选组内解析。旧数组配置报迁移错误。
- `triage_model_chain` 在 llm、workspace defaults / instances 层引用同一组定义，
  越具体的层优先；均未配置时继承当前 workspace 主链。Git 服务 issue triage、
  PR/MR 增量评论的 Resolved 标记与托管 problem issue 的 `close` / `mark_resolved`
  使用此组复核。指纹、文件范围和提交祖先关系只生成候选；模型未确认时保持 open。
- 成本估算按非缓存输入、缓存命中、缓存写入、输出 token 类别计费。

### 3.6 Prompt Manager 与 AI 资产装配

- 保护性规则、用户公共层、工程层规则按稳定优先级合并。
- repo-local `AGENTS.md`、path instructions 与 skills 自动发现、去重和冲突检测。
- 每次 agent run 必须通过 runtime bundle 物化 instructions、skills、MCP 工具、env 与 manifest。

### 3.7 AgentAdapter 与模型翻译

- Kilo、Claude Code、OpenCode、Zoo、Copilot CLI、pi、oh-my-pi 等 adapter 共用统一
  runtime 合同。
- `ModelSpec` / `thinkingLevel` 在 adapter 内翻译到 provider 原生字段。
- Reasoning effort 档位 `minimal/low/medium/high/max`：direct-LLM 发送 `reasoning_effort`，
  Kilo adapter 物化 `variants` 并以 `--variant` 运行（见 `docs/ai/architecture.md` §3.7.3）。
- 能力不支持时在 manifest 显式降级，而不是静默忽略。
- `agent.web_search`（默认关闭）治理各 agent 内置搜索工具：始终物化显式开关保证评审
  封闭默认，启用时凭据经 env 名间接寻址注入，密钥不落盘；manifest 记录
  `webSearch.{enabled,mode}`。设计与验收见 `docs/ai/milestones/M13.1.md`。

### 3.8 SandboxBackend

- native、docker、podman 是当前主路径；`k8s_pod`、`firecracker` 仍为预留扩展（见 §8.3）。
- 容器后端必须执行 allowlist、只读源码挂载、隔离 cwd、env-file 外置和超时治理。
- 进程超时必须杀整棵进程树；外层容器必须用 `--init` 回收僵尸进程。

### 3.9 输出通道、模板与 MCP 工具

- 稳定工具集合为 `aicr.report_problem`、`aicr.publish_summary`、`aicr.skip`、
  `aicr.fetch_more_context`、`aicr.try_blame`。
- Agent CLI 自由文本 stdout 不作为正式问题报告。
- PR review summary 更新、managed problem issue 生命周期、IM Markdown 转换和
  `no_problems` 策略见 `docs/output-channels.md` 与 `docs/ai/architecture.md` §3.9。

### 3.10 配置体系

- 配置 schema 的代码真源是 `packages/core/src/config.ts`。
- `workspaces.cache` / `workspaces.defaults` / `workspaces.instances.<id>` 是稳定命名空间。
- 顶层 `storage` 统一承载 database/cache/object 配置。
- 配置变更必须同步 schema 测试、示例配置、专题文档和本计划摘要。

### 3.11 Run 状态与可观测性

- 持久化 schema 的代码真源是 `packages/store/src/schema.ts`。
- async trigger、失败报告、publisher 行为、dashboard 和 replay 统一落在可观测性合同里。
- Dashboard 已覆盖 Overview / Projects / Providers / Runs 及 today/thisWeek/thisMonth/all
  时间维度；日汇总分区按 UTC day。
- Token usage 按 review 路径区分口径（`llm_gateway` / `agent_stdout` / `mixed`），本地
  prompt 估算独立存放、不混入 `llm_usage`；细节见 `docs/ai/architecture.md` §3.11。

### 3.12 Reflection 与 memory

- light mode、thorough mode 最小跨 run 聚合、repo 约定学习与 prompt 自动注入已交付。
- memory 按 workspace 隔离，稳定 fingerprint 幂等覆盖，跨 workspace 知识迁移明确不做。

### 3.13 模型元数据 Catalog

- M10 已基本交付：models.dev 元数据可补齐 context window、输出上限、价格和模型能力。
- SQLite、memory 与 Redis 结构化后端可用；Redis 复用 `storage.cache.redis`。
- 用户显式配置优先于 catalog；缺失字段不臆造。

### 3.14 用户文档站

- M11 已完成：`docs/site`（Astro v7 / Starlight）接入 pnpm workspace 与 CI docs job，
  中英双语全章节正文落地，六道校验（公开内容边界、配置字段覆盖、CLI 一致性、内部
  链接/锚点、SEO 元数据、双语一致性）接入 `pnpm docs:build`/`docs:check`，GitHub Pages
  发布链路已上线核验（`aicr.atframe.work`，2026-08-28）。
- 选型、内容结构、工程集成与验收记录见 `docs/ai/documentation-site-plan.md`。
- 边界：`docs/site` 不进根 `tsconfig.json` references；root `build` 只构建
  `./packages/*`；runtime Dockerfile 不复制 `docs/site`。

## 4. 默认评审 Prompt 原则

- 默认 system prompt 只保留稳定硬规则、输出协议与安全边界。
- 评审输出以已验证的问题为中心；不展开无问题部分，无 actionable problem 时以
  `aicr.skip` 完成，不用重复近义 prompt 段落强化同一规则。
- 调研依据与样例保留在 `docs/prompt-research.md`。
- repo-local AI 资产按路径与优先级按需装配，不整仓注入。
- 工具合同由实现与注册表定义，不靠 prompt 发明字段。

## 5. 用户入口与专题文档

- GitHub Pages 文档站（`aicr.atframe.work`）是对外用户入口；仓库内 `docs/ai/*`
  继续承担内部架构、路线图和 agent 维护上下文。
- 文档站不直接发布 `docs/ai/*` 内容，避免把内部路线图、agent 规则和运维细节混入
  用户手册。

## 6. 安全与运营基线

- 先鉴权，后入队。
- secret scrubber 覆盖 prompt、日志和输出边界。
- attribution、作者信息和用户可见 target 必须可验证。
- sandbox 执行最小权限、最小挂载、最小命令能力原则。
- 远程部署和调试流程不得打印 `.env` 或 secret 文件原文。

## 7. 测试与验证基线

- 默认验证顺序：
  1. `node node_modules/eslint/bin/eslint.js . --max-warnings=0`
  2. `node node_modules/typescript/bin/tsc -b tsconfig.json --pretty false`
  3. `node node_modules/vitest/vitest.mjs run --coverage`
  4. `node node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs`
  5. `cmd /c "pnpm build"`
  6. `node packages/cli/dist/index.js eval --validate-only`
- 定向检查用于迭代定位；最后一次修改后必须重新运行全部适用门禁，并确认工具实际
  发现了预期文件或测试。在 Linux/CI 等 `pnpm` 可直接执行的环境中，最终 runtime 门禁
  以 `pnpm ci` 为准。
- `Plan.md` 与 `docs/**/*.md` 共同接受 markdownlint 校验。
- CI 在 `.github/workflows/ci.yml` 的独立 `docs` job 中运行 `pnpm docs:build`：先执行
  六道校验，再做静态站点构建。

## 8. 里程碑与执行顺序

### 8.1 当前状态

| 里程碑 | 状态 | 归档 | 备注 |
| --- | --- | --- | --- |
| M0 | 已完成 | `docs/ai/milestones/M0.md` | 保持基线稳定 |
| M0.5 | 已完成 | `docs/ai/milestones/M0.5.md`、`docs/prompt-research.md` | 维持高信号、findings-only 输出纪律 |
| M1 | 已完成 | `docs/ai/milestones/M1.md` | 最小 review 闭环基线 |
| M2 | 已完成 | `docs/ai/milestones/M2.md` | agent/sandbox 基线 |
| M3 | 已完成 | `docs/ai/milestones/M3.md` | 压缩、预算、队列与 scrubber 能力 |
| M4 | 已完成 | `docs/ai/milestones/M4.md` | 模板、路由与 attribution |
| M5 | 已完成 | `docs/ai/milestones/M5.md` | runtime bundle 与 MCP transport 合同 |
| M6 | 部分完成 | `docs/ai/milestones/M6.md` | 未验收项见 §8.3 |
| M7 | 已完成 | `docs/ai/milestones/M7.md` | 跨 workspace 知识迁移明确不做 |
| M8 | 基本完成 | `docs/ai/milestones/M8.md` | 未验收项见 §8.3 |
| M9 | 基本完成 | `docs/ai/milestones/M9.md` | 不进入版本 bump / git tag；扩展沙箱见 §8.3 |
| M10 | 基本完成 | `docs/ai/milestones/M10.md` | 真实外部 Redis smoke/e2e 按需 |
| M11 | 已完成 | `docs/ai/documentation-site-plan.md` | Pages 已上线（`aicr.atframe.work`，2026-08-28 核验） |
| M12 | 已完成 | `docs/ai/milestones/M12.md` | 生产 push 全链路已签收；PR 路径待自然触发，见 §8.3 |
| M13 | 已完成 | `docs/ai/milestones/M13.md` | pi/omp 适配与最佳实践对齐全量交付 |
| M13.1 | 已完成 | `docs/ai/milestones/M13.1.md` | agent web search 治理与 WSL 集成验证通过 |
| M14 | 已完成 | `docs/ai/milestones/M14.md` | 多源上下文聚合（`context_repositories` 物化 + 只读挂载） |

### 8.2 当前执行包

无活跃本地执行包。M11-P1–P6、M12-P1–P5、M13-P1–P5 全部交付并归档：

- M11 执行与验收记录：`docs/ai/documentation-site-plan.md`。
- M12 交付与生产验收证据：`docs/ai/milestones/M12.md`；稳定合同
  `docs/ai/architecture.md` §3.2.1。
- M13 调研结论与交付面：`docs/ai/milestones/M13.md`。

后续工作只来自 §8.3 Backlog 的外部条件触发，或新方向的立项。

### 8.3 Backlog（依赖外部系统或延后扩展）

| 项 | 来源 | 状态 | 依赖的外部条件 |
| --- | --- | --- | --- |
| GitLab 真实仓库 e2e | M6 | 代码已实现 | 可用的真实 GitLab 环境（实例 + 测试仓库 + token） |
| SVN 真实仓库 e2e | M6 | adapter 与 trigger 合同层已实现 | 真实 SVN 仓库及 hook 部署环境 |
| GitHub App `pull_request` 事件生产行使 | M12 | push 路径已签收；注入点有单测覆盖 | 目标仓库出现首次自然 PR（被动等待，无需准备环境） |
| CI 真实 LLM eval benchmark | M8 | `aicr eval --validate-only` 已入 CI | CI secrets 中配置真实 LLM provider 凭据与预算 |
| `k8s_pod` sandbox 实现 | M9 | 预留扩展，未实现 | 可用 Kubernetes 集群 + 引入 `@kubernetes/client-node` 依赖的决策 |
| `firecracker` sandbox 实现 | M9 | 预留扩展，未实现 | Firecracker 二进制与 API socket 运行环境 |

明确不做或暂不进入计划：跨 workspace 知识迁移；版本 bump / git tag。

### 8.4 已完成阶段归档

- `docs/ai/milestones/M0.md`
- `docs/ai/milestones/M0.5.md`
- `docs/ai/milestones/M1.md`
- `docs/ai/milestones/M2.md`
- `docs/ai/milestones/M3.md`
- `docs/ai/milestones/M4.md`
- `docs/ai/milestones/M5.md`
- `docs/ai/milestones/M6.md`
- `docs/ai/milestones/M7.md`
- `docs/ai/milestones/M8.md`
- `docs/ai/milestones/M9.md`
- `docs/ai/milestones/M10.md`
- `docs/ai/milestones/M12.md`
- `docs/ai/milestones/M13.md`
- `docs/ai/milestones/M13.1.md`
- `docs/ai/milestones/M14.md`
- `docs/ai/milestones/local-priority-queue.md`

## 9. 稳定决策索引

- 长期有效的 D1-D31 决策已迁移到 `docs/ai/decisions.md`。
- 使用方式：
  - 先看本计划确认“现在做什么”
  - 再看 `docs/ai/decisions.md` 理解“为什么这样做”
  - 最后看 `docs/ai/architecture.md` 或代码确认“现在是怎么做的”

## 10. 扩展点

- Context Provider 插件：见 `docs/ai/architecture.md` §10.1。
- Output Pipeline 中间件 / 审批流扩展：见 `docs/ai/architecture.md` §10.2。
- 扩展点目标是保留接口与边界，不是提前把未实现能力包装成已完成能力。

## 11. 部署与发布摘要

- 首选单容器自托管，HTTP 入站由反向代理处理 TLS。
- 持久化保留 `config.yaml`、`.env`、workspace 数据、数据库和日志目录。
- Podman / Docker 使用同一构建与运行合同，差异由 engine 选择吸收。
- 运行时镜像内置现代 CLI 工具基线（`rg`/`fd`/`sd`/`bat`/`eza`/`jq`/`yq`/`miller`/`delta`/`difft` 等），
  清单与 agent 使用规则见 `.agents/skills/modern-cli-toolkit/`。
- 健康检查统一使用 `/healthz`。
- 部署与验收入口：`example/README.md`、`docs/podman.md` 与相关 skill。
- M11 文档站发布走静态站点构建与 `gh-pages` 分支 workflow，不改变 AICR 服务运行时镜像。
