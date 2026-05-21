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

- M5 已基本交付；仅剩 HTTP/SSE MCP transport 待调研（非阻塞）。
- M6 GitHub 生产链路已验收；GitLab e2e 和 SVN adapter 移至 Backlog。
- M8 观测能力已大部分交付：OTel 已接入 serve 命令、Prometheus metrics 和 run snapshot 已连线、eval CLI 已添加。
- M9 发布收尾已基本完成：从零部署验收、容器嵌套沙箱集成验证均通过；版本 bump 待用户决策。
- M7 国际化（i18n）已开始：`output_language` 注入到 review task context 已交付。
- 所有包均已补齐 `test/index.test.ts` barrel export 测试（AGENTS.md pitfall #10）。
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
- **Review 去重**：async 模式下，同一 target（`trigger:workspace:provider:repoRef:targetKind:branch/url/head/base`）的并发 review 请求会被合并；branch 优先，其次用目标 URL，再回退到 head/base revision；running review 完成后自动触发最后一次 pending 的 re-review。
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
- Kilo 原生 MCP state 与 JSON stream tool-call 都必须进入同一条工具执行链；`contextRequests` 触发 VCS `fetchExtraContext` 补拉并回灌 follow-up，而不是发布“无法访问完整仓库代码/无法验证”之类的最终摘要。
- Agent 修复后若仍只输出“未发现问题 / 无可审查代码”自由文本，服务端归一为 `aicr.skip` 并跳过 IM；若仍无法解析且不是无问题语义，则改走直连 LLM 修复兜底。
- Summary 声称发现问题但没有 `aicr.report_problem` 记录，或 skip/summary 要求人类补 diff/source context / 声称源码不可访问时，按结构化输出失败处理并修复，避免 `problemCount=0` 被 no-problems 策略静默压掉。
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
- `/metrics` 的 histogram 使用 Prometheus 累计语义；同步和异步 review run 都应记录 metrics 与 `runs/<run_id>/run.json` 快照。
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
| M5 | 基本完成 | 多 Agent CLI、Podman、runtime bundle、Kilo Code e2e | HTTP/SSE MCP transport 调研（非阻塞） |
| M6 | 部分完成 | GitHub 生产链路已验收 | GitLab e2e、SVN adapter 移至 Backlog |
| M7 | 未开始 | workspace 定制、skill by glob、国际化、memory | 等待 M5/M6 更稳定后推进 |
| M8 | 大部分完成 | structured logs、OTel、metrics、run snapshot、eval CLI | eval fixture 已补齐；CI 集成移至 Backlog |
| M9 | 基本完成 | 文档、示例、deploy.sh、发布资产、部署验收 | 版本 tag（用户决策） |
| M7 | 已开始 | `output_language` 注入 review task context | skill by glob、workspace 定制、memory |

### 8.2 当前执行包

1. **M5：runtime bundle 与 agent 原生能力对齐**（基本完成）
    - ~~物化原生 MCP 配置~~（已交付：runtime bundle 物化 MCP 工具清单到 manifest）
    - ~~补齐 Agent Runtime Bundle manifest~~（已交付：`@aicr/agents` `materializeRuntimeBundle`）
    - ~~移除 Kilo 适配器过期标志~~（已交付：`--dangerously-skip-permissions` 已从 kilo adapter 移除，`--auto` 即为 kilo 7.x 的自动审批方式）
    - ~~MCP server 配置注入~~（已交付：runtime bundle 支持 `mcpServers` 参数，Kilo adapter 自动写入 `mcp` 配置段到 `.kilo/kilo.json`）
    - ~~Agent stdout 结构化修复与直连 LLM 兜底~~（已交付：orchestrator 支持 repair retry、skip 语义归一化、direct-LLM fallback）
    - ~~MCP 状态文件读取~~（已交付：agent 运行后 orchestrator 读取 `.aicr-output-state.json` 并回写 collector）
    - ~~独立 MCP 服务器进程~~（已交付：通过 Kilo MCP 配置注入，`@aicr/mcp-output` 以独立子进程启动；状态文件 `.aicr-output-state.json` 由 orchestrator 读取）
    - ~~完成 Kilo Code 端到端验收~~（已验收：生产日志证实 Kilo agent 在 sandbox 内完整运行，MCP 状态文件读取、stdout 流解析、结构化输出转换均正常工作）
    - HTTP/SSE 传输模式（`@aicr/mcp-output` 当前仅支持 stdio；待调研 MCP SDK HTTP transport 可行性；非阻塞项，可延后至 M9 之后）
2. **M6：跨 VCS 能力补齐**（GitHub 已验收）
    - ~~GitHub 真实仓库端到端验证~~（已验收：生产环境 `github-atframework` / `github-owent` 触发器正常运行，自动创建 issue 和分析 PR 记录完整）
    - GitLab webhook、dispatcher 与 PR review 已实现并带单元测试；待补齐真实仓库端到端验证记录 → **Backlog**
    - SVN 支持（config schema 已预留，待实现 VCS adapter）→ **Backlog**
    - ~~blame/annotate 归因链路~~（部分覆盖：`aicr.fetch_more_context` 提供额外上下文拉取能力；完整 blame/annotate 需 VCS 原生支持）
    - ~~多源上下文 selector~~（部分覆盖：`aicr.fetch_more_context` + VCS adapter `fetchExtraContext`；专用聚合模块待 M7）
3. **M8：观测与回放**（大部分完成）
    - ~~结构化日志落盘~~（已交付：pino logger）
    - ~~OTel trace exporter~~（已交付并接入：`createOtelSdk` 在 `aicr serve` 命令中自动启动，读取 `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` 环境变量）
    - ~~Prometheus metrics~~（已交付：`/metrics` 端点，`aicr_reviews_total` / `aicr_problems_total` / `aicr_review_duration_seconds` 等计数器与累计 histogram）
    - ~~`runs/<run_id>/` 完整快照~~（已交付：`saveRunSnapshot` 保存 `runs/<run_id>/run.json`，通过 `ServerAppOptions.runsDir` 配置，同步/异步 review 均覆盖）
    - ~~eval CLI / 基准集~~（已交付：`aicr eval` CLI 命令已接入 `@aicr/eval`，`eval/` 目录支持 JSON fixture 文件）
    - ~~eval fixture 扩充~~（已交付：6 个 fixture 覆盖 security/sql-injection、security/hardcoded-secret、correctness/null-deref、correctness/error-silenced、style/naming、performance/n-plus-one）
4. **M9：发布收尾**（接近完成）
    - ~~`docker_socket` 文档确认~~（已交付：`example/README.md` 和 `docs/ai/architecture.md` §3.8.1 已补充说明）
    - ~~容器嵌套沙箱验证~~（已交付：`AICodeReviewerTest` 测试环境验证通过，确认 Podman socket + Docker 静态二进制 + `--userns=keep-id --group-add keep-groups` 路径可行；`deploy.sh`、`Dockerfile`、`.gitignore`、`docs/podman.md`、`example/README.md` 已更新）
    - ~~`k8s_pod` / `firecracker` 平台能力边界说明~~（已交付：`architecture.md` §3.8.1 后端能力矩阵已明确标注为预留扩展位）
    - ~~版本固定与 changelog~~（已交付：`CHANGELOG.md` 已创建，所有包版本固定为 `0.1.0`）
    - ~~最终发布检查单~~（已交付：`docs/ai/milestones/M9-checklist.md` 已创建）
    - ~~`deploy.sh` 修复~~（已交付：所有 `podman` 命令通过条件化 engine 参数加 `--storage-driver=overlay`，Docker engine 不接收 Podman 专用参数；加入 preflight 检查）
    - ~~`deploy.sh` 硬编码路径~~（已交付：改为环境变量覆盖 `AICR_DEPLOY_DIR`/`AICR_IMAGE_NAME`/`AICR_HOST_PORT`/`AICR_CONTAINER_NAME`/`AICR_ENGINE`）
    - ~~`deploy/docker-static` 清洁同步兼容~~（已交付：未启用嵌套沙箱时 `deploy.sh` 创建空占位文件且运行镜像会移除该占位；启用时下载真实 Docker CLI，避免 clean source sync 后 Dockerfile COPY 失败）
    - ~~`.dockerignore`~~（已交付：排除 `.git`/`node_modules`/`dist`/`coverage`/`docs` 等）
    - ~~Dockerfile 前向兼容~~（已交付：补齐 `sandbox`/`eval` node_modules COPY）
    - ~~部署资产审计修复~~（已交付：P4 认证表修正、`.env.sample` 补齐缺失变量、`config.yaml` 补齐 queue 子项示例、`SKILL.md` 环境变量名对齐、`Caddyfile.example` 添加）
    - ~~增量部署验证~~（已交付：测试环境 `/data/disk2/AICodeReviewerTest` 源码同步 → `deploy.sh` 构建 → 启动 → `healthz` / `/metrics` 验证通过）
    - ~~从零部署验收~~（已交付：`AICodeReviewerTest` 空目录完整验收通过：`rm -rf` → `mkdir` → 解压源码 → 写入 config.yaml/.env → `deploy.sh` 构建 → `healthz` OK）
    - ~~容器嵌套沙箱集成验证~~（已交付：Docker CLI v27.5.1 在 AICR 容器内正常运行；嵌套 `docker run --rm alpine echo sandbox-ok` 成功；`--network none` 网络隔离验证通过；Podman user socket 挂载 + `DOCKER_HOST` 注入 + `userns=keep-id` 均正确）
    - 版本 bump 与 git tag（用户决策）
5. **M7：workspace 定制、国际化、memory**（已开始）
    - ~~`output_language` 注入 review task context~~（已交付：`ServerReviewOrchestrationOptions` 新增 `outputLanguage` 字段；`buildTaskContext` 在 `outputLanguage` 非 `en` 时追加 `Output language: <lang>` 指令；`bootstrap.ts` 从 `config.review.output_language` 注入；3 个单元测试覆盖注入/省略场景）
    - 所有包 barrel export 测试补齐（已交付：`@aicr/core`/`@aicr/cli`/`@aicr/server`/`@aicr/llm`/`@aicr/vcs`/`@aicr/outputs`/`@aicr/mcp-output`/`@aicr/store` 新增 `test/index.test.ts`，总计 1228 测试全部通过）
    - skill by glob（已有 `Applies To` 章节过滤；待配置级强制激活）
    - per-workspace baseSystemPrompt 覆盖（待实现）
    - memory / reflection 存储与检索（待实现）

### 8.3 Backlog（低优先级延后项）

| 项                         | 来源里程碑 | 说明                                                           |
| -------------------------- | ---------- | -------------------------------------------------------------- |
| HTTP/SSE MCP transport     | M5         | `@aicr/mcp-output` 仅支持 stdio；需调研 MCP SDK HTTP transport |
| GitLab 真实仓库 e2e        | M6         | 代码已实现，待真实 GitLab 环境                                 |
| SVN VCS adapter            | M6         | config schema 已预留，待实现                                   |
| 完整 blame/annotate        | M6         | 需 VCS 原生 `git blame` / `p4 annotate` 集成                   |
| 专用多源上下文聚合         | M6/M7      | 当前 `fetch_more_context` 部分覆盖                             |
| `k8s_pod` sandbox 实现     | M9         | 需要 Kubernetes 集群和 `@kubernetes/client-node`               |
| `firecracker` sandbox 实现 | M9         | 需要 Firecracker 二进制和 API socket                           |
| CI eval 基准集成           | M8         | 将 `aicr eval` 接入 CI 流水线（需 CI pipeline 权限，延后扩展） |

### 8.4 已完成阶段归档

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
