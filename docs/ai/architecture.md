# AICodeReviewer 架构与实现合同

这份文档承接原先 `Plan.md` 里稳定、细节化、不会每轮都变的设计说明。
`Plan.md` 现在只保留当前路线图、活跃里程碑、下一执行包和简版摘要；需要深挖时，再按需读取这里。

为降低引用迁移成本，本页尽量沿用 `Plan.md` 的章节编号语义，尤其是 `3.x` 系列合同。

## 2. 技术方向与仓库组织

### 2.1 技术栈基线

- 核心实现使用 TypeScript / Node 20。
- 工作区用 pnpm 管理，TypeScript project references 负责跨包构建。
- LLM 直连与外部 Agent CLI 两条路径并存，但长期主路径是“服务编排 + AgentAdapter + Sandbox”。
- 运行环境以单容器自托管为主，Podman 与 Docker 平等支持。

### 2.2 工作目录与资产分层

- 工作目录以 `workspaces/<workspace_id>/` 扁平布局组织。
- 每个 workspace 自包含 `source/`、`agent/`、`tmp/` 等运行目录。
- AI 维护资产分三层：
  - 平台/产品内置层
  - 用户/运营公共层
  - 项目 / workspace / repo-local 层
- 公共模块（如 `packages/cli/src`）保持平台中立，不在公共 API 中泄漏 Gitea/GitHub/P4 等 provider 命名。

### 2.3 文档分层

- `Plan.md`：前瞻路线图与当前执行顺序
- `docs/ai/architecture.md`：稳定设计合同
- `docs/ai/decisions.md`：长期有效决策
- `docs/ai/milestones/*.md`：已完成阶段归档
- `docs/output-channels.md`、`docs/podman.md`、`docs/prompt-research.md`：专题文档

## 3. 核心组件合同

### 3.1 触发器与 ReviewEvent 归一化

- 入站面包含：`/webhooks/*`、`/triggers/*`、手工触发、定时触发。
- 所有入口都应收敛到统一 `ReviewEvent`，避免在公共模块暴露平台私有字段名。
- 触发器需要在**鉴权/签名校验通过后**再创建 run。
- 当开启 async 语义时，入口应尽快返回 `202` 与 `runId`，后台完成 review。
- `ReviewEvent` 要覆盖提交者、目标、仓库映射、变更集、workspace 等最小稳定字段。
- P4 trigger 只负责最小 metadata POST；服务端负责拉取和补足 diff/describe。
- 提交者可见元数据必须来自事件或 provider/VCS 查询结果，不能回退成分析用 workspace 或 agent 本地环境。

### 3.2 VCS Adapter 与 scoped fetch

- VCS adapter 维持统一三段式合同：
  - 列举变更
  - 按 review 目标做 scoped fetch
  - 在需要时获取额外上下文或归因
- 公共路径与对象工具函数放在 `packages/core/src/utils.ts`，不要在其他模块复制实现。
- Git 默认浅拉取并允许在闸门下 deepen；P4 / SVN 保持 provider 原生方式。
- 多源上下文默认关闭：只有显式 `repository` selector 或 alias 才访问辅助仓库。
- `normalizePath` 必须统一反斜杠、压缩重复斜杠并去除前导 `./`。
- `isPlainObject` 必须拒绝 `Date`、`RegExp` 等内建类实例。
- Git blame / P4 annotate / SVN blame 等 attribution 能力属于 best-effort 上下文工具，不应污染默认 fingerprint。
- P4 需要支持：
  - `describe` / `print` / `diff`
  - ticket/password 失败后的非交互 `p4 login` 重试
  - basename 级别 glob 过滤
  - trigger payload 中的提交者用户名与 client/workspace 透传

### 3.3 Compression

- 压缩是 `summarize -> review` 两阶段，而不是简单截断 diff。
- 触发阈值由 token 预算与输入占比共同决定。
- `estimateTokens` 需要正确处理 CJK 字符，避免低估上下文成本。
- 压缩输出必须保留文件级摘要、关键 hunk 与足够的定位上下文。
- 是否压缩、选择哪些 hunk、使用哪个 summarize model 都应可配置。

### 3.4 Secrets Scrubber

- Scrubber 在进入 prompt 前执行一次，在 problems / summary 输出前再执行一次。
- 检测策略包含：
  - 明确规则匹配
  - 熵检测
  - 常见键值对模式
- Scrubber 是安全兜底，不替代调用方的最小暴露原则。
- 日志、模板渲染和错误信息都要走同样的脱敏边界。

### 3.5 LLM Gateway、Fallback 与预算

- LLM 调用经统一 gateway 进入 provider client。
- 单次调用层支持 bounded retry，尊重 `Retry-After`。
- provider fallback chain 与队列 retry 是两层不同机制，不要混用。
- 每日预算、每 provider 覆盖与速率限制独立配置。
- provider 兼容层要对外暴露统一模型抽象，而不是把厂商字段散落到上层编排代码。

### 3.6 Prompt Manager 与 AI 资产装配

- 常驻仓库规则只放在 `AGENTS.md`。
- 详细、可复用的 workflow 放在 `.agents/skills/*/SKILL.md`。
- 历史阶段说明放在 `docs/ai/milestones/*.md`。
- Prompt Manager 负责发现、筛选、排序和合并 repo-local AI 资产。
- 保护性规则必须稳定压在更具体但较弱的项目规则之上。

#### 3.6.1 repo-local AI 资产发现与冲突处理

- 自动发现 `AGENTS.md`、path-specific instructions 和 Agent Skills。
- 技能命名以能力/工作流命名，不使用 `M0`、`M1` 之类阶段编号。
- 需要检测并记录：
  - 重名 skills
  - 重叠 path instructions
  - alias/桥接文件与 canonical 资产的冲突
- 只对当前 review 路径相关的 repo-local 规则做激活，避免把全仓规则一次性塞进主 prompt。

#### 3.6.2 Canonical AI 资产约束

- `AGENTS.md` 与 `.agents/skills/` 是跨工具共享真源。
- Claude / Roo / Kilo / Copilot 等私有格式只做桥接，不维护重复正文。
- 共享规则写在 canonical 层，工具私有文件只保留最小差异。

#### 3.6.3 Agent Runtime Bundle

- 每次 run 在隔离 `agent/` 目录物化整套 runtime bundle：
  - LLM 配置
  - MCP 配置
  - 生效中的 instructions
  - 生效中的 skills
  - env 注入
  - manifest / 审计信息
- 不得修改开发者的全局 Agent CLI 配置目录。
- 适配器原生支持不足时，可以降级为：
  - 注入简版 skill 摘要到 prompt
  - 把完整 skill 文件作为只读资源挂载
  - 用 stdout tool-call 作为兼容回退
- MCP 工具名必须来自注册表，而不是从 prompt 文本反推。

### 3.7 AgentAdapter 与模型翻译

- `AgentAdapter` 统一封装 Kilo、Claude Code、OpenCode、Roo、Copilot CLI 等外部 agent。
- 每个 adapter 都要显式说明支持能力：
  - 模型配置
  - 原生 MCP
  - 原生 skill 目录
  - repo instructions
  - 隔离 HOME
  - stdout fallback
- 不支持的能力需要在 manifest 和测试中显式降级，不能静默丢弃。

#### 3.7.1 适配目标

- Kilo Code 是部署与端到端验收的首要目标。
- Claude Code、OpenCode、Roo、Copilot CLI 作为并行适配面。
- 新 adapter 应尽量复用 runtime bundle 物化与 sandbox contract，而不是重新发明一套配置树。

#### 3.7.2 调用合同

- adapter 的输入至少包括：工作目录、模型、工具、超时、skill/instruction 层和输出收集器。
- adapter 的输出要么是 MCP 工具调用结果，要么是兼容回退解析后的同构结果。
- 工具调用与普通文本输出必须分流处理。

#### 3.7.3 ModelSpec 翻译

- 统一抽象 `ModelSpec` / `thinkingLevel` / provider 级覆盖配置。
- 再按 provider 翻译为 Azure、Vertex、Bedrock、OpenAI-compatible、Anthropic、Gemini 等原生字段。
- 可选字段传递时需注意 `exactOptionalPropertyTypes`，避免直接写入 `undefined`。

### 3.8 SandboxBackend

- 支持 native、docker、podman，保留 `docker_socket` 与 `k8s_pod` 扩展位。
- 容器后端必须通过 allowlist 验证允许执行的命令。
- 容器 `--env-file` 必须位于挂载工作区之外的临时路径，运行后删除。
- 源码工作区默认只读挂载，agent 工作目录与临时目录隔离。
- 白名单、cwd、超时、网络/命令限制由 sandbox 统一守卫。
- Podman 与 Docker 要共享一套容器合同，而不是两套分叉实现。

### 3.9 输出通道、模板与 MCP 工具

- 输出分为：PR/MR 行级评论、summary、issue、IM 通知等。
- MCP 输出工具当前稳定集合为：
  - `aicr.report_problem`
  - `aicr.publish_summary`
  - `aicr.skip`
  - `aicr.fetch_more_context`
- 尚未完全落地的工具（如 `aicr.try_blame`、memory/skill recall）不能提前宣传为已实现能力。
- problem 合同保持最小稳定字段；`message` 讲问题与影响，`suggestion` 给修复建议。
- 模板渲染与最终发布由输出层统一控制，而不是让 agent 直写各平台方言。

#### 3.9.1 `no_problems` 与 target 渲染

- `no_problems.action` 按全局 → channel → workspace 分层覆盖。
- 这是**每个通道**独立决策，不是整个复合 publisher 共享一个布尔值。
- 目标链接通过标准化 `target` 上下文渲染，不把所有 URL 都写成 `View PR`。
- 非 PR/MR 目标如果没有安全可用的链接，就只输出纯文本标签。

#### 3.9.2 Attribution 与只读上下文工具

- attribution 来源只能是事件、provider API 或只读 VCS 工具。
- agent 不得根据 commit message、diff 文本或昵称猜测作者。
- best-effort attribution 缺失时，必须显式返回 `not_found` / `partial`。

#### 3.9.3 模板引擎

- 内置模板使用 Handlebars。
- workspace 可以覆盖模板，但变量合同要与内置模板对齐。
- 模板变量属于稳定合同的一部分，变更时需同步文档、测试与示例。

#### 3.9.4 作者解析与 @-mention

- 作者解析优先事件用户名，再补 display name、邮箱或 provider profile。
- Feishu / WeCom / issue comment 的 mention 方言由输出层负责转换。
- 黑名单邮箱不能用于自动 mention。
- IM 总结要尽量输出 `@username (Display Name)` 这样的稳定格式。

#### 3.9.5 Managed problem issue 生命周期

- managed problem issue 的创建、关闭与清理属于输出层职责。
- 最近问题列表受 `review.problem_issue.max_recent_issues` 控制。
- 零 problem 正常 review 的抑制逻辑，不能误伤错误报告、告警或生命周期回收。

### 3.10 配置体系

- 配置 schema 的代码真源是 `packages/core/src/config.ts`。
- `workspaces` 采用三段式：
  - `workspaces.cache`
  - `workspaces.defaults`
  - `workspaces.instances.<id>`
- workspace 配置文件不能写系统级字段。
- 需要长期保持覆盖完整性的关键配置包括：
  - `compression`
  - `llm.fallback_chain`
  - `llm.retry`
  - `llm.budget`
  - `llm.per_provider_overrides`
  - `queue.workers`
  - `queue.rate_limit`
  - `queue.retry`
  - `queue.dead_letter`
  - `review.problem_issue.max_recent_issues`
  - `review.reflection.memory`
  - `workspaces.defaults.agent`
  - `outputs.channels[].mention_fallback`
  - `outputs.routes`
- 输出路由、模板、agent、queue、review 行为都支持全局 → workspace default → workspace instance 覆盖。
- 当配置 shape 变化时，要同步更新 schema 测试、示例配置、专题文档和 `Plan.md` 摘要。

### 3.11 Run 状态与可观测性

- 状态与持久化 schema 真源是 `packages/store/src/schema.ts`。
- 运行记录至少要覆盖：
  - run 元数据
  - target / workspace
  - provider / model
  - triggerName
  - 产出与错误摘要
- async trigger 的调度、完成、失败都要有结构化日志。
- 发布失败和 review 失败应保留足够上下文供 replay，而不是只吐一条裸字符串。
- 当 `dryRun` 为 `false` 时，run status 不能因为没有 publisher 而错误回落到 `dry_run`。

### 3.12 Reflection 与 memory

- reflection / memory 是规划中的长期能力，不应提前伪装成已完成实现。
- 当前配置与文档仅保留 schema 与扩展位。
- 真正落地时应明确：
  - memory 的写入边界
  - 去敏策略
  - workspace 级隔离
  - 对 false-positive 抑制的实际收益评估

## 4. 默认评审 Prompt 合同

- 默认 system prompt 只保留稳定硬规则、输出协议与安全边界。
- 详细调研、采纳/拒绝理由和样例留在 `docs/prompt-research.md`。
- repo-local AI 资产按路径和优先级按需装配，不直接把全量仓库文档塞进系统 prompt。
- 删除行、旧代码、上下文缺失等高风险区域需要在 prompt 中显式约束，降低 hallucination。
- 工具合同是真源；prompt 不应单方面扩展未实现的工具名或字段。

## 6. 安全模型

- webhook / trigger 入口先鉴权，后入队。
- secret scrubber 作用于 prompt、日志和最终输出。
- sandbox 保证最小权限、最小挂载、最小网络/命令能力。
- 归因、作者信息、target URL 等外部可见数据必须可验证，不能靠模型猜测。
- 远端部署和调试流程中不得打印 `.env` 或 secret 文件原文。

## 7. 测试与验证策略

- 默认仓库级验证顺序：
  1. ESLint
  2. TypeScript build / typecheck
  3. Vitest
  4. markdownlint
  5. 构建
- 变更配置 contract、输出 contract、runtime bundle、sandbox 行为时，都要补对应测试。
- AI 资产变更至少要过 markdownlint，并检查 skill frontmatter / 目录名 / `name` 一致性。
- 文档不是“写完就算”，它们与示例、测试、配置 shape 一起构成实现合同。

## 10. 扩展点

### 10.1 Context Provider 插件

- 为 AST、LSP、RAG、跨仓额外上下文等能力预留插件接口。
- 插件应返回结构化 `ContextChunk`，由 orchestrator 统一参与压缩与 prompt 组装。
- 外部 MCP server 如果只是上下文提供者，应通过 AICR 的 allowlist 和单一工具面暴露。

### 10.2 Output Pipeline 中间件

- 输出在 dispatch 前可经过 `redact`、`dedupe`、`render`、`rateLimit` 等中间件。
- 审批流未来以中间件形式扩展，而不是硬编码到 dispatcher。
- 状态机的新增中间态只在启用审批等能力时可见，对默认部署透明。

## 11. 部署概览

- 首选单容器自托管，监听 HTTP，由反向代理处理 TLS。
- 生产部署应保留：
  - `config.yaml`
  - `.env`
  - 数据目录
  - 日志目录
  - workspace 持久卷
- Podman / Docker 使用同一构建与运行合同，差异通过 engine 选择吸收。
- 健康检查统一使用 `/healthz`。
- 远程部署的操作性说明以 `example/README.md`、`docs/podman.md` 与仓库技能为准；`Note.md` 是当前仓库操作约束，不是对外产品文档。
