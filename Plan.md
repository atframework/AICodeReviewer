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

- M5 已完成；runtime bundle 默认继续使用本地 stdio MCP server，`@aicr/mcp-output` 另提供显式启动的本地 Streamable HTTP MCP transport。
- M6 GitHub 生产链路已验收；SVN 基础 VCS adapter 已交付（`svn diff --summarize` /
  `svn cat` / `svn diff --git` / `fetch_more_context`）；GitLab e2e 与 SVN 真实仓库
  e2e/入站触发脚本移至 Backlog。
- 后续优先执行不依赖外部系统和权限的本地闭环任务，详见 §8.3：本地优先队列 P0–P6 已完成
  （Streamable HTTP MCP transport、blame/annotate 基础能力、SVN 触发入口合同层、Reflection
  thorough mode、SQLite durable queue、daily_rollups 写入、输出/合同测试收束），本地优先队列已清空，
  后续推进依赖外部系统的 Backlog 项或新的本地需求。
- M8 观测底座与内置观测首页已交付：OTel 已接入 serve 命令、Prometheus metrics 和 run snapshot 已连线、eval CLI 已添加；Dashboard 支持 Overview / Projects / Providers / Runs 四个标签，工程面板与 Provider 面板均支持 today/thisWeek/thisMonth/all 时间维度切换。
- M9 发布收尾已基本完成：从零部署验收、容器嵌套沙箱集成验证均通过；版本 bump 待用户决策。
- M7 已完成：workspace 定制、国际化、memory/reflection 全流程集成（light mode）已交付。
- 所有包均已补齐 `test/index.test.ts` barrel export 测试（AGENTS.md pitfall #10）。
- 本轮已完成文档收束：已完成阶段与稳定细节已搬离 `Plan.md`，未来 agent 应按需读文档，
  而不是默认吞下整份历史记录。
- M10（模型元数据 Catalog / models.dev 集成）已基本交付：config schema、store
  keyed 表 `model_catalog` + 迁移 `003_model_catalog`、纯解析/归一化模块、catalog
  service（刷新周期 + 三层回退 + 打包保底 seed）、bootstrap 编排（store 初始化条件
  扩展到 admin/catalog-sqlite/reflection，并在 gateway 之前充实 ModelSpec）、
  gateway 用 catalog 真实价格替换固定估算、Kilo/Roo/opencode/Claude Code 注入 +
  manifest 降级标注、打包保底快照 + 构建期刷新脚本。SQLite 与 memory 后端可用；
  Redis 结构化后端为预留项，当前显式拒绝。详见 §3.13、`docs/ai/architecture.md` §3.13。
- 公网正式环境稳定性修复已落地并归档到 AGENTS.md pitfall：沙箱进程树回收 +
  容器 `--init`（#49/#50）、issue triage 按事件 provider 族门控（#51）、
  git/P4/SVN `fetchExtraContext` 回退补拉（#52）、push 全零 SHA 跳过（#53）。
- 直接 push 到主干的 review 与 issue 创建链路已核查正确：两个 GitHub trigger
  订阅 `[pull_request, push, issues]`，全局 `outputs.routes` 按 `target_kind`
  路由 push → issue 通道，orchestrator `publishSummary` 始终带 problems 驱动
  `reconcileProblems`；详细合同见 §3.1、`docs/ai/architecture.md` §3.1。
- 运维待办：`github-managed-findings`（atframework）issue 创建生产返回 401，属
  `GITHUB_ATFRAMEWORK_TOKEN` 权限/有效期问题（非代码缺陷），需在 GitHub 侧为该 PAT
  补 `repo` 或 fine-grained `issues:write` 权限后重启容器。

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
- 部署镜像默认采用 `ubuntu:24.04`（glibc）并复用官方
  `node:22-bookworm-slim` 的 Node 22 userspace，以便稳定安装 `p4-cli`
  与常用代码检索/构建/诊断工具；同时内置 `kubectl`、`helm`、`yq`
  和 `podman`/`buildah`/`skopeo` 客户端，便于分析 Kubernetes manifest、
  Helm chart 与通过宿主 Podman socket 管理隔离容器；Python `pip`
  支持通过 `PIP_INDEX_URL` 配置镜像源。

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
- GitHub `pull_request.review_requested` 和 Gitea/Forgejo `pull_request_review_request` 的 `review_requested` action 会主动触发 PR re-review；移除 review request 不触发新 review。
- Webhook 平台代码保持分层：`webhook-common.ts` 放签名、repo mapping 与共用 payload 构造；`gitea-webhook.ts`、`github-webhook.ts`、`gitlab-webhook.ts` 分别承载平台事件语义；`webhook-translator.ts` 只做统一分发。
- async 入口以 `202 + runId` 作为非阻塞语义。
- P4 trigger 只提交最小 metadata，服务端负责后续拉取和分析。
- SVN trigger 同样只提交最小 metadata（revision、author、可选 changed_files），服务端使用配置的 `repository_url` 与 `svn diff`/`svn cat` 拉取实际变更。
- **Review 去重**：async 模式下，同一 target（`trigger:workspace:provider:repoRef:targetKind:branch/url/head/base`）的并发 review 请求会被合并；branch 优先，其次用目标 URL，再回退到 head/base revision；running review 完成后自动触发最后一次 pending 的 re-review。
- 详细合同：`docs/ai/architecture.md` §3.1、§3.1.1。

### 3.2 VCS adapter 与 scoped fetch

- VCS 访问保持统一三段式合同：列举变更、scoped fetch、额外上下文/归因。
- 默认以单仓 `primary` 行为为主，多源上下文显式开启。
- Git、P4、SVN、GitHub、GitLab、Gitea/Forgejo 的平台差异留在适配层消化。
- P4/SVN 的额外上下文保持最小拉取：diff 缺失/过窄时先取完整变更文件，必要的相关文件
  分别按 changelist revision 在配置 depot 内 `p4 print`、按 SVN revision 在
  `repository_url` 内 `svn cat -r`，不做全仓同步/checkout。
- 归因能力必须来自事件、provider API 或只读 VCS 工具。
- **归因（attribution）基础能力已交付（P1）**：VCS 层新增可选 `VcsAdapter.fetchAttribution`
  与 `AttributionRequest`/`AttributionEntry`/`AttributionResult` 合同，git/P4/SVN 分别用
  `git blame --line-porcelain`、`p4 annotate -c` + `p4 describe -s` join、`svn blame` 解析，
  best-effort 缺失返回 `not_found`/`partial`；`aicr.try_blame` MCP 工具尚未落地，不提前宣传。
- 详细合同：`docs/ai/architecture.md` §3.2、§3.9.2。

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
- **主动上下文获取**：默认 prompt 强制要求 agent 在报告问题前主动读取完整变更
  文件、接口/类型定义、调用方/被调用方、配置和 schema，不允许仅基于 diff hunks
  猜测。`buildJsonToolContract()` 和 MCP 工具描述已对齐此策略。
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
- Kilo 原生 MCP state 与 JSON stream tool-call 都必须进入同一条工具执行链；`contextRequests` 触发 VCS `fetchExtraContext` 补拉并回灌 follow-up，而不是发布“无法访问完整仓库代码/无法验证”之类的最终摘要。
- Agent 修复后若仍只输出“未发现问题 / 无可审查代码”自由文本，服务端归一为 `aicr.skip` 并跳过 IM；若仍无法解析且不是无问题语义，则改走直连 LLM 修复兜底。
- Summary 声称发现问题但没有 `aicr.report_problem` 记录，或 skip/summary 要求人类补 diff/source context / 声称源码不可访问时，按结构化输出失败处理并修复，避免 `problemCount=0` 被 no-problems 策略静默压掉。
- 复合输出通道隔离单 channel 发布失败：失败记录为 dispatch `failed` 并继续后续 channel；若全失败，run 以 `skipped/output_dispatch_failed` 结束，不再升级成触发器失败。
- 详细合同：`docs/ai/architecture.md` §3.9 与 `docs/output-channels.md`。

### 3.9.0 PR Review Summary 更新模式

- PR/MR review 通道（`gitea_pr_review`、`github_pr_review`）支持 `review_update_strategy`：`always_new` 或 `update_existing`（默认）。
- `update_existing` 模式下，summary comment 通过 HTML 标记识别，用 PATCH 更新而非每次新建；问题按 fingerprint 分为 Still Open / New / Resolved 三类，Resolved 显示可读标题/占位而不是 raw fingerprint。
- PR review 问题通过 `publishProblem` 缓冲并在 `publishSummary` 汇总成单个 Markdown reply body；line-comments-only 路由也必须触发 summary flush，避免问题丢失。
- 详细合同：`docs/ai/architecture.md` §3.9.0。

### 3.9.1 `no_problems` 与 target 渲染

- `no_problems.action` 按全局 → channel → workspace 覆盖。
- 目标链接用标准化 `target` 上下文渲染，不把所有目标都写成 `View PR`。
- 详细合同：`docs/ai/architecture.md` §3.9.1 与 `docs/output-channels.md`。

### 3.9.5 Managed problem issue 生命周期

- `gitea_problem_issue` 和 `github_problem_issue` 支持 `issue_mode`:
  - `consolidated`（默认）：一次分析的所有问题合并为一个 issue，scope fingerprint 驱动更新与关闭。
  - `per_problem`：每个问题独立 issue，fingerprint 驱动生命周期。
  - `per_commit`：按 commit scope fingerprint 创建 issue（含 headSha），不同 commit 的问题相互独立，不自动关闭其他 commit 的 issue。
- `resolved_action` 支持 `mark_resolved`：关闭 issue 时在正文顶部添加 ✅ Resolved 标记，保留 issue 供历史追踪。
- managed issue 标题由输出层生成并保持单行可读：单问题用 `per_problem` 格式（含位置与摘要），多问题在最高 severity + 计数后附加代表性摘要；summary title 只影响正文 summary heading。
- `log_thinking` 配置控制 orchestrator 是否输出详细思考/执行日志（默认 true）。
- consolidated issue per-fingerprint 解决跟踪与 webhook 重放保护：
  - issue body 包含 `<!-- aicr:commit={headSha} -->`、`<!-- aicr:open_problems=... -->`、`<!-- aicr:fp=... -->` 标记。
  - 更新时通过 VCS compare API 验证 commit 顺序；新 commit 分类新增/仍存在/已解决问题，同 commit 仅合并不解决，旧 commit 跳过更新，API 失败时安全降级。
  - 向后兼容无标记的旧 issue。
- `github_problem_issue` 的 `token_env` 必须具备 GitHub Issues read/write 权限；Webhook 事件订阅不等于 API 权限。
- 详细合同：`docs/ai/architecture.md` §3.9.5 与 `docs/output-channels.md`。

### 3.10 配置体系

- 配置 schema 的代码真源是 `packages/core/src/config.ts`。
- `workspaces.cache` / `workspaces.defaults` / `workspaces.instances.<id>`
  是稳定命名空间。
- 同一路由上的多 GitHub / GitLab trigger 需要通过 `source_repo.trigger` 做 repo → profile 显式绑定。
- 配置变更应同步 schema 测试、示例配置、专题文档与本计划摘要。
- 计划中的内置观测首页认证配置应独立于 trigger API key；超级管理员用户名与
  密码/密码哈希仅通过环境变量引用，不能写入明文配置、日志或 run snapshot。
- 计划中的数据库、缓存和对象存储配置使用顶层 `storage` 命名空间，供观测、队列、artifact、runtime 等能力复用：
  `storage.database.kind` 默认为 `sqlite`，可选 `postgres`；
  `storage.cache.kind` 默认为 `memory`，可选 `redis`；
  `storage.object.kind` 默认为 `filesystem`，预留 S3 / MinIO / RustFS 等 S3-compatible 后端。
- 计划中的 `llm.model_catalog` 使用 models.dev 元数据补齐 `ModelSpec`，默认复用
  `storage.database` 的 SQLite keyed 表，Redis 后端复用 `storage.cache.redis`，避免每次读模型参数
  都解析整份 JSON。
- 详细合同：`docs/ai/architecture.md` §3.10。

### 3.11 Run 状态与可观测性

- 持久化 schema 的代码真源是 `packages/store/src/schema.ts`。
- async trigger、失败报告、publisher 行为和 replay 需要统一落在可观测性合同里。
- `/metrics` 的 histogram 使用 Prometheus 累计语义；同步和异步 review run 都应记录 metrics 与 `runs/<run_id>/run.json` 快照。
- 内置观测首页已交付：认证后首屏展示整体、工程级、provider+模型级和时间窗口统计（today/thisWeek/thisMonth/all），使用 SQLite 持久化。
- 首页路由合同：`/` 与 `/dashboard` 都应落到 dashboard；未配置 admin env 时首页显示 setup 提示而不是 404；启用 `path_prefix` 时顶层根路径应重定向到带前缀的 dashboard 入口。
- 非 Prometheus/OTel 的观测数据层必须独立存在；未配置外部观测系统时，今日/本周/本月/汇总统计来自持久化 store/rollup，而不是进程内 metrics。
- 观测持久化使用统一 `storage.database` 配置，当前已实现默认 `/app/data/aicr.sqlite` SQLite + Drizzle；Postgres 字段为集中化或多实例部署预留，运行时在未实现前必须显式拒绝而不是静默回退；`runs/<run_id>/run.json` 只作为审计快照，不作为聚合查询真源。
- 观测查询缓存使用统一 `storage.cache` 配置，当前实时查询 SQLite；Redis 字段为跨进程/多实例缓存、session 和短期索引预留，不能作为唯一历史统计存储。
- 工程级统计至少覆盖分析次数、分析代码量（变更文件数、增删/分析行数、分析字节数）、发现问题的 run 次数、问题数量、创建 issue 数量，以及该工程消耗的 provider+模型请求数与 token 数；Dashboard Projects 面板支持 today/thisWeek/thisMonth/all 时间维度切换，以表格展示各工程的全部指标。
- provider+模型级统计至少覆盖请求数、输入/输出/总 token、失败/重试/fallback 次数和可用时的估算成本；Dashboard Providers 面板支持 today/thisWeek/thisMonth/all 时间维度切换，以表格展示各 provider+model 的全部指标。
- 项目维度应以 workspace + trigger + repo 形成稳定 project identity；从 `workspaces.instances` 删除的项目要在启动/配置 reload 后自动隐藏并按可配置宽限期级联清理统计数据。
- 详细合同：`docs/ai/architecture.md` §3.11。

### 3.12 Reflection 与 memory

- "light" 模式已交付：per-category 问题归纳、文件类型范围、summary 标题、skip reason。
- "thorough" 模式跨 run 聚合最小切片已交付：`reflection_memory` 追踪 `occurrence_count`，
  `extractCrossRunPatterns` 对重复出现的 category 生成可操作 hint（默认阈值 3 次）。
- workspace 隔离、稳定 fingerprint 和脱敏边界已保证。
- 仍未实现：repo 约定学习与自动注入、完整知识迁移系统。
- 详细合同：`docs/ai/architecture.md` §3.12。

### 3.13 模型元数据 Catalog（models.dev）

- 状态：**基本完成（M10）**。统一为每个 provider+model 提供上下文窗口、最大输入/输出
  token、输入/输出/缓存价格，以及是否支持工具调用、视觉/附件、搜索、推理等能力。
- 数据源是 models.dev `https://models.dev/api.json`，分三层读取：
  - **刷新缓存**（最新、可写）：默认存 SQLite（store keyed 表 `model_catalog`，按模型点查，
    复用 `storage.database`），可选 Redis 结构化后端（复用 `storage.cache.redis`，需显式配置）
    或 memory 临时后端；按 `refresh_interval_hours` 的 source-level 刷新元数据判断是否拉远端
    （默认每天一次，可配置），未知模型不会在周期内反复触发远端请求。整份 `api.json` 只在
    刷新时解析一次并逐行 upsert，读路径不再全量解析 JSON。
  - **打包保底缓存**（最旧、只读）：每次打包从 `anomalyco/models.dev` 拉取最新快照
    随镜像发布并签入仓库；仅在 store 缺该模型时按需 seed 一次。
  - **回退顺序**：远端失败 → 过期本地结构化缓存行 → 打包保底快照（按需 seed）。
- 元数据合并进 `ModelSpec`（用户显式配置优先于 catalog），供压缩阈值、`llm.budget`
  与观测成本统计使用，替代当前 gateway 的固定成本估算。
- Agent 配置转换按工具区分：opencode 已知 provider 走原生 models.dev、自定义
  provider 注入 `limit`/`cost`；如需 `OPENCODE_MODELS_PATH` 只能生成 run-local 小型
  api.json，不能指向 SQLite/Redis 缓存。Kilo / Roo 自定义 OpenAI-compatible 必须注入
  `contextWindow`/`maxTokens`/`supportsImages`/价格；Claude Code / Copilot CLI 无注入面，
  在 manifest 显式降级。
- 详细合同：`docs/ai/architecture.md` §3.13；配置 schema 真源 `packages/core/src/config.ts`
  的 `llm.model_catalog`。

## 4. 默认评审 Prompt 原则

- 默认 system prompt 只保留稳定硬规则、输出协议与安全边界。
- 调研依据与样例保留在 `docs/prompt-research.md`。
- repo-local AI 资产按路径与优先级按需装配，不整仓注入。
- 删除行、旧代码、上下文缺失等高风险场景需要在 prompt 中显式约束。
- 工具合同由实现与注册表定义，不靠 prompt 发明字段。
- 当 runtime / sandbox 已保证工具可用时，shell 只读检查优先使用
  `rg` / `fd` / `bat` / `jq`；`grep` / `find` / `cat` 只作为兼容或精确
  POSIX 语义兜底。

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
| M5 | 已完成 | `docs/ai/milestones/M5.md` | 保持 runtime bundle 与 MCP transport 合同稳定 |
| M6 | 部分完成 | GitHub 生产链路已验收；SVN 基础 adapter 已实现；VCS 归因（attribution）基础合同已交付 | GitLab e2e、SVN 真实仓库 e2e/触发脚本移至 Backlog |
| M7 | 已完成 | `docs/ai/milestones/M7.md` | thorough mode、跨 workspace 知识迁移 → Backlog |
| M8 | 大部分完成 | `docs/ai/milestones/M8.md` | CI eval 集成移至 Backlog |
| M9 | 基本完成 | `docs/ai/milestones/M9.md` | 版本 tag（用户决策） |
| M10 | 基本完成 | 模型元数据 Catalog（models.dev），见 §3.13、`docs/ai/architecture.md` §3.13 | Redis 结构化缓存后端预留实现 |

### 8.2 当前执行包

1. **M5：runtime bundle 与 agent 原生能力对齐** — 已完成，归档至 `docs/ai/milestones/M5.md`（Streamable HTTP MCP transport 已交付，stdio 仍为默认）。
2. **M6：跨 VCS 能力补齐**（GitHub 已验收；SVN adapter + VCS 归因合同已交付，交付面见 §8.1）
    - GitLab webhook、dispatcher 与 PR review 已实现并带单元测试；待补齐真实仓库端到端验证记录 → **Backlog**
    - SVN 真实仓库 e2e 与入站触发脚本/端点设计 → **Backlog**
3. **M8：观测与回放** — 大部分完成，归档至 `docs/ai/milestones/M8.md`
    - CI eval 基准集成（需 CI pipeline 权限，延后扩展）→ **Backlog**
4. **M9：发布收尾** — 基本完成，归档至 `docs/ai/milestones/M9.md`
    - 版本 bump 与 git tag（用户决策）
5. **M7：workspace 定制、国际化、memory** — 已完成，归档至 `docs/ai/milestones/M7.md`（`output_language`、per-workspace prompt 覆盖、`force_skills`、reflection memory 全流程 light mode 均已交付）。
6. **M10：模型元数据 Catalog（models.dev）** — 基本完成（config/store/解析/service/bootstrap/gateway 真实价格/adapter 注入 + manifest 降级/打包保底快照/文档同步全部交付，详见 §3.13、`docs/ai/architecture.md` §3.13）
    - Redis 结构化缓存后端：预留字段已校验，运行时显式拒绝（`not yet implemented`），待引入 Redis 客户端依赖后落地 → **Backlog**

### 8.3 本地优先执行队列（不依赖外部系统）

这些任务应优先于需要真实 GitLab/SVN/Redis/K8s/CI 权限的 Backlog 项执行。每项都必须
能用本地单元测试、集成测试、markdownlint/typecheck/build 闭环；若过程中发现必须接入
外部服务，应拆出本地合同层并把真实环境验证留在 §8.4。

最近完成（全部已交付，详细合同见对应章节）：

| 项 | 落点 | 合同引用 |
| --- | --- | --- |
| P0 Streamable HTTP MCP transport | `@aicr/mcp-output --transport http`；stdio 仍为默认 | §3.9、`docs/ai/milestones/M5.md` |
| P1 blame/annotate 归因 | `VcsAdapter.fetchAttribution` + `AttributionResult`；git/P4/SVN 实现 | §3.2、§3.9.2；`aicr.try_blame` MCP 待接线 |
| P2 SVN 触发入口合同层 | `/triggers/svn` + `translateSvnTriggerToReviewEvent` + `example/svn-trigger.sh` | §3.1；真实仓库 e2e 留 §8.4 |
| P3 Reflection thorough mode | `occurrence_count`/`extractCrossRunPatterns`（阈值 3） | §3.12 |
| P4 SQLite durable queue | `queue.kind: "sqlite"`，`UPDATE ... RETURNING` 原子 claim | `packages/server/src/queue-sqlite.ts` |
| P5 daily_rollups 写入 | `recomputeDailyRollup`（UTC 日分区，idempotent） | §3.11、`packages/store/test/rollups.test.ts` |
| P6 输出/合同测试收束 | `no_problems` 混合路由、git context 边界、manifest 降级矩阵、Feishu 2.0 schema 测试修复 | §3.9/§3.9.1、pitfall #56 |

| 优先级 | 项 | 来源里程碑 | 本地完成标准 |
| --- | --- | --- | --- |
| _(本地优先队列已清空)_ | — | — | 后续推进依赖外部系统的 Backlog 项或新的本地需求 |

### 8.4 Backlog（依赖外部系统或用户决策）

| 项                         | 来源里程碑 | 说明                                                           |
| -------------------------- | ---------- | -------------------------------------------------------------- |
| Model catalog Redis backend| M10        | `llm.model_catalog.cache.backend: redis` 预留；需引入 Redis 客户端，当前显式拒绝 |
| GitLab 真实仓库 e2e        | M6         | 代码已实现，待真实 GitLab 环境                                 |
| SVN 真实仓库 e2e           | M6         | 基础 VCS adapter 已实现；触发入口本地合同层完成后仍需真实 SVN 仓库验证 |
| 专用多源上下文聚合         | M6/M7      | 当前 `fetch_more_context` 部分覆盖；若无外部仓库选择器需求，先不扩大范围 |
| `k8s_pod` sandbox 实现     | M9         | 需要 Kubernetes 集群和 `@kubernetes/client-node`               |
| `firecracker` sandbox 实现 | M9         | 需要 Firecracker 二进制和 API socket                           |
| CI eval 基准集成           | M8         | 将 `aicr eval` 接入 CI 流水线（需 CI pipeline 权限，延后扩展） |
| 版本 bump / git tag        | M9         | 需要用户明确版本号与发布窗口决策                               |

### 8.5 已完成阶段归档

- `docs/ai/milestones/M0.md`
- `docs/ai/milestones/M0.5.md`
- `docs/ai/milestones/M1.md`
- `docs/ai/milestones/M2.md`
- `docs/ai/milestones/M3.md`
- `docs/ai/milestones/M4.md`
- `docs/ai/milestones/M5.md`
- `docs/ai/milestones/M7.md`
- `docs/ai/milestones/M8.md`
- `docs/ai/milestones/M9.md`

## 9. 稳定决策索引

- 长期有效的 D1-D31 决策已迁移到 `docs/ai/decisions.md`。
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
- 国内部署示例统一使用 USTC 的 Ubuntu APT 镜像（`amd64/i386` 默认
  `http://mirrors.ustc.edu.cn/ubuntu`，其他架构按文档切换到
  `http://mirrors.ustc.edu.cn/ubuntu-ports`），npm、PyPI、Kubernetes
  APT 与 Docker static 仍使用 `mirrors.tencent.com`；Helm/yq 暂无已验证
  的腾讯专用镜像时保留官方源或使用内部缓存覆盖 build arg。
- `deploy.sh` 在未显式设置 `HTTP_PROXY` / `HTTPS_PROXY` 时，会自动探测部署宿主机的 TCP `3128` HTTP 代理，并将宿主下载与镜像构建流量切到该代理；若代理只绑定 loopback，则临时使用 host build network 保证 Dockerfile 下载可达。
- 健康检查统一使用 `/healthz`。
- 部署与验收入口：`example/README.md`、`docs/podman.md` 与相关 skill。
