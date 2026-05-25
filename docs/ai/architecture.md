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
- GitHub / GitLab 这类共享 webhook 路由允许挂多个同类 trigger profile；服务端需要先按请求凭据确认候选 trigger，再按仓库标识选择最终 profile，避免把不同仓库的 secret、token 或过滤规则混用。
- 当开启 async 语义时，入口应尽快返回 `202` 与 `runId`，后台完成 review。
- `ReviewEvent` 要覆盖提交者、目标、仓库映射、变更集、workspace 等最小稳定字段。
- P4 trigger 只负责最小 metadata POST；服务端负责拉取和补足 diff/describe。
- 提交者可见元数据必须来自事件或 provider/VCS 查询结果，不能回退成分析用 workspace 或 agent 本地环境。

#### 3.1.1 Review 去重与合并

- async 模式下，服务端维护一个内存中的 `ReviewDeduplicator`，对同一 target 的并发 review 进行去重。
- 去重 key 由 `triggerName:workspaceId:provider:repoRef:targetKind:targetId` 构成，避免同仓库不同 trigger/workspace 互相合并。
- `targetId` 优先使用 `branch`，其次使用目标 `url`，再回退到 `headSha` / `baseSha`；这保证同一 PR/MR 的多次 `/aicr review` 在新 commit 推送后仍能合并，同时缺少 SHA 的评论命令不会全部落到同一个 `unknown` target。
- 当同一 target 已有 review 正在运行时，新到达的 review 请求（如 `/aicr review` 评论命令）不会立即创建新 run，而是被记录为 **pending re-review**，覆盖同一 target 的任何先前 pending 请求。
- 当 running review 完成后（无论成功或失败），deduplicator 自动检查该 target 是否有 pending re-review；如果有，用最新的 `ReviewEvent` 重新触发一次 review。
- 去重只影响 async 调度层，不影响 review orchestration 本身的业务逻辑；sync 模式不受此机制影响。
- 代码真源：`packages/server/src/review-deduplicator.ts`；集成点在 `packages/server/src/index.ts` 的 `scheduleTriggerProcessing` 中。

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
  - `aicr.fetch_more_context` 请求未在 scoped tree 中的相关文件时，只在配置的 depot 内按当前 changelist revision 执行最小 `p4 print`，不扩大成全仓同步

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
- 代码真源：`packages/agents/src/runtime-bundle.ts`。
- `materializeRuntimeBundle()` 接受 adapter、model、instructions、skills、mcpTools 和 env 变量，输出完整文件集和 `manifest.json`。
- orchestrator 在 `runAgentReview` 中调用 `materializeRuntimeBundle` 替代原来的 `adapter.materializeConfig`，确保每次 agent run 都有完整 bundle。
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

- 支持 native、docker、podman，保留 `docker_socket`、`k8s_pod` 与 `firecracker` 扩展位。
- 容器后端必须通过 allowlist 验证允许执行的命令。
- 容器 `--env-file` 必须位于挂载工作区之外的临时路径，运行后删除。
- 源码工作区默认只读挂载，agent 工作目录与临时目录隔离。
- 白名单、cwd、超时、网络/命令限制由 sandbox 统一守卫。
- Podman 与 Docker 要共享一套容器合同，而不是两套分叉实现。

#### 3.8.1 后端能力与边界

| 后端 | 状态 | 说明 |
| --- | --- | --- |
| `native` | 已交付 | 直接 spawn 子进程，不依赖容器引擎；适用开发环境或无容器权限的场景。 |
| `docker` | 已交付 | 通过 CLI 调用 Docker，支持镜像、allowlist、只读挂载、env-file 隔离。 |
| `podman` | 已交付 | 与 Docker 共享同一容器合同，CLI 解析为 `podman`；支持 rootless。 |
| `docker_socket` | 已交付（映射实现） | 复用 `docker` 后端的容器实现，仅 `kind` 标识不同；适用于通过 Unix socket 访问 Docker daemon 的场景，不额外引入 Docker Engine API 客户端。 |
| `docker` (nested) | 已验证 | 当 AICR 本身运行在 Podman/Docker 容器内时，通过挂载宿主机容器引擎 socket + Docker 静态二进制实现嵌套容器隔离。见 `docs/podman.md` "Nested container sandbox"。 |
| `k8s_pod` | 预留扩展位 | 尚未实现。计划通过 Kubernetes API 创建 Job Pod，挂载 source/agent/tmp 卷，流式回传日志。需要集群环境、`@kubernetes/client-node` 和有效的 kubeconfig。 |
| `firecracker` | 预留扩展位 | 尚未实现。计划通过 Firecracker API 创建 microVM，以块设备或 virtiofs 挂载 workspace，流式回传日志。需要 `firecracker` 二进制和 API socket。 |

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
- Agent CLI 的自由文本 stdout 不是正式审查结果；无法解析出 AICR tool payload 时先触发结构化修复重试，避免中间思考泄露到 IM 通知。
- Kilo 等原生 MCP agent 写入 `.aicr-output-state.json` 后，orchestrator 必须读取其中的 problems / summaries / skip 和 `contextRequests`；`contextRequests` 需要通过 VCS `fetchExtraContext` 执行并回灌到 follow-up prompt，而不是只计数或发布“无法访问完整仓库代码”的摘要。
- Kilo JSON stream 中的 `tool_call` / `tool_use` 事件在 MCP state 缺失时作为兼容回退执行，确保 `aicr.fetch_more_context` 不会因为 stdout 中没有最终 JSON payload 而丢失。
- 每次 agent run 启动前要清理旧 `.aicr-output-state.json`，避免上一次 repair pass 的工具状态污染下一次输出。
- 如果 Agent 结构化修复后的自由文本明确表示“无问题 / 无可审查代码”，orchestrator 会归一为 `aicr.skip`，避免把格式修复失败的 fallback 文案发布到 IM；若仍无法解析且不属于无问题语义，则改走直连 LLM 修复兜底。
- Summary 中声称“发现问题”但没有 `aicr.report_problem` 记录时，也视为未满足输出合同并触发结构化修复，避免 `problemCount=0` 的问题被 `no_problems` 策略静默压掉。
- Skip reason 或 summary 要求人类补 diff/source context，或声称无法访问完整仓库/源码而无法验证时，orchestrator 也会修复为“只读命令检查已物化源码或 `aicr.fetch_more_context` 补拉具体路径”的流程，并在拿到上下文后要求最终结构化输出。
- `aicr.fetch_more_context` 可用于缺失/过窄 diff 下的完整变更文件，以及为验证变更行所必需的窄范围相关文件；problem 仍必须锚定到本次变更的文件与行。
- IM 通知保持 `Review target` / `Summary` / `Problems` 分段结构，问题位置必须来自 `aicr.report_problem.file` 与 `line`。

#### 3.9.0 PR Review Summary 更新模式

- PR/MR review 通道（`gitea_pr_review`、`github_pr_review`）支持 `review_update_strategy` 配置：
  - `always_new`：每次推送创建新的 review/comment。
  - `update_existing`（默认）：查找 PR 上已有的 AICR 管理的 summary comment，通过 PATCH 更新而非新建。
- 更新模式下 summary comment 使用 HTML 注释标记（`<!-- aicr:managed=pr-review -->`、`<!-- aicr:problems=fp1,fp2 -->`）做身份识别与 fingerprint 跟踪。
- 问题分三类呈现：**Still Open**（指纹在旧 comment 和当前均存在）、**New**（仅当前存在，标注引入 commit）、**Resolved**（仅旧 comment 存在，标记 ✅ 不删除）。
- 行级 inline comments（`publishProblem`）不受更新策略影响，仍然逐条创建 review comments。
- 配置字段：`outputs.channels[].review_update_strategy`，类型 `always_new | update_existing`。

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
- IM bot channels（当前实现 `feishu_bot`、`wecom_bot`，未来可扩展 `dingtalk_bot`、`slack_bot` 等）的 mention 方言由输出层负责转换，各平台使用 `im-markdown.ts` 中对应的 `toXxxMarkdown()` transformer 适配 Markdown 子集。
- 黑名单邮箱不能用于自动 mention。
- IM 总结要尽量输出 `@username (Display Name)` 这样的稳定格式；平台原生 mention tag（`<at>`、`<@user>` 等）由 `author-resolution.ts` 通过 `MentionChannelKind` 处理，模板只负责人类可读格式。

#### 3.9.5 Managed problem issue 生命周期

- managed problem issue 的创建、关闭与清理属于输出层职责。
- 最近问题列表受 `review.problem_issue.max_recent_issues` 控制。
- 零 problem 正常 review 的抑制逻辑，不能误伤错误报告、告警或生命周期回收。
- 支持 `issue_mode` 控制创建策略：
  - `consolidated`（默认）：一次分析的所有问题合并为一个 issue，基于 scope fingerprint（channel + repo）做生命周期管理。每次审查更新已有 issue 内容；零问题时按 `resolved_action` 关闭或删除。
  - `per_problem`：每个问题创建独立 issue，基于 fingerprint 做生命周期管理。
- consolidated 模式下 labels 使用最高严重级别，assignees 汇总所有关联负责人。
- managed issue 标题由输出层生成，优先保持单行可读：
  - `per_problem`：前缀 + 严重级别 + 缩短位置 + 简短摘要（如 `[AICR] [HIGH] src/app.ts:3 · Issue`）。
  - `consolidated`：单问题复用 `per_problem` 格式；多问题使用前缀 + 最高严重级别 + 问题数 + 代表摘要（如 `[AICR] [CRITICAL] 3 problems · SQL query uses unsanitized input`）。
- `aicr.publish_summary.title` 只影响 issue body 里的 summary heading，不直接控制 managed issue 标题。

### 3.10 配置体系

- 配置 schema 的代码真源是 `packages/core/src/config.ts`。
- `workspaces` 采用三段式：
  - `workspaces.cache`
  - `workspaces.defaults`
  - `workspaces.instances.<id>`
- workspace 配置文件不能写系统级字段。
- 当多个 GitHub / GitLab trigger 共用同一路由时，`workspaces.instances.<id>.source_repo.trigger` 必须显式绑定到对应 trigger profile；不同 repo 需要独立 token / webhook secret / 文件过滤规则时，不应复用同一个 trigger 名称。
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
- 计划中的内置观测首页认证配置与 trigger API key 分离；配置文件只保存 env var 名称，
  不保存超级管理员用户名/密码明文。密码哈希 env（如 `*_PASSWORD_HASH`，格式
  `sha256:<hex>`）优先且可单独使用；小型内网部署允许 raw password env，但必须
  固定长度 digest 比较、限速并禁止进入日志、snapshot 或 metrics label。
- 计划中的数据库、缓存和对象存储配置必须使用顶层 `storage` 命名空间，供观测、队列、
  artifact、runtime 等能力复用，不复用 `queue.kind` 或 `workspaces.cache`：
  - `storage.database.kind`: `sqlite`（默认）或 `postgres`。
  - `storage.database.sqlite.path`: 默认 `/app/data/aicr.sqlite`。
  - `storage.database.postgres.url_env`: 指向 Postgres 连接串环境变量。
  - `storage.cache.kind`: `memory`（默认）、`redis` 或 `none`。
  - `storage.cache.redis.url_env`: 指向 Redis 连接串环境变量。
  - `storage.object.kind`: `filesystem`（默认）或 `s3`。
  - `storage.object.filesystem.root`: 默认 `/app/data/objects`。
  - `storage.object.s3.endpoint_url_env`: 可指向 AWS S3、MinIO、RustFS 等 S3-compatible endpoint。
  - `storage.object.s3.bucket`: 对象存储 bucket 名称。
  - `storage.object.s3.region_env`、`access_key_id_env`、`secret_access_key_env`: 通过环境变量引用凭据和区域。
  - `storage.object.s3.force_path_style`: 支持 MinIO / RustFS 这类常见 S3-compatible 部署。
  - `storage.retention.deleted_project_grace_days`: 已删除项目统计硬删除宽限期。
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
- Prometheus histogram bucket、sum、count 必须按进程生命周期累计；只能把原始 duration 样本缓冲做滑动窗口裁剪。
- `/metrics` 计数与 `runs/<run_id>/run.json` 快照应覆盖同步和异步触发的 review run，不能只记录后台模式。

#### 3.11.1 内置观测首页（M8 follow-up — 已交付）

- 内置观测首页是 Prometheus/OTel 的补充，不是替代：外部时序系统存在时可以联动，
  但默认部署不应因为未配置 Prometheus 就失去基础统计能力。
- 页面和对应 JSON API 必须在认证后访问；认证面独立于 webhook/trigger API key。
  超级管理员用户名与密码或密码哈希通过环境变量 `AICR_ADMIN_USERNAME` +
  `AICR_ADMIN_PASSWORD` 或 `AICR_ADMIN_PASSWORD_HASH` 引用；比较时转为固定长度
  SHA-256 digest 后使用 `timingSafeEqual`。Session token 为 32 字节随机 hex，默认
  TTL 86400 秒。服务端不得打印或落盘密码原值。
- 持久化数据使用 SQLite + Drizzle ORM（`@aicr/store` 包）。
  代码真源为 `packages/store/src/schema.ts`，连接通过 `createStoreDb()` 初始化。
  SQLite 连接启用 WAL、`foreign_keys=ON`、`busy_timeout=5000` 和 `synchronous=NORMAL`。
  迁移通过内联 SQL + `_migrations` 跟踪表在启动时自动运行。
  `runs/<run_id>/run.json` 仍用于审计与问题排查，但不作为统计聚合查询真源。
- Postgres 和 Redis 后端为预留扩展位，当前仅实现 SQLite；当 admin dashboard 启用且
  `storage.database.kind` 不是 `sqlite` 时，启动必须失败并给出清晰错误，不能静默落回 SQLite。
- 统计 schema 包含六张表：
  - `projects`：由 `workspaceId + triggerName + repoRef` 派生的 project identity，
    含 `deleted_at` 软删除标记。
  - `review_runs`：run 事实表，含 provider、model、status、problem/summary/dispatch 计数、
    duration、skip reason、compression 标记、token 估算、target 元数据。
  - `code_metrics`：每 run 的文件变更数、增删行数、分析字节数。
  - `llm_usage`：每 run 的 provider+model 级请求数、token 数、成本、重试/fallback/失败次数、延迟。
  - `output_events`：每 run 的 channel dispatch 事件，含 issue/comment 创建标记。
  - `daily_rollups`：预留的按日聚合表（当前未写入，聚合从原始表实时计算）。
- Admin API 端点（Hono 子路由 `/api/admin`）：
  - `POST /login`：验证用户名/密码，返回 session token + 过期时间。
  - `POST /logout`：撤销 session token。
  - `GET /stats`：返回 overview + today/thisWeek/thisMonth 四个时间窗口统计、
    project 列表、provider+model 统计、最近 20 条 run。
  - `GET /stats/projects`：按 project 聚合统计，支持 `?since=` ISO 日期筛选。
  - `GET /stats/providers`：按 provider+model 聚合统计，支持 `?since=` 筛选。
  - `GET /runs`：最近 run 列表，支持 `?limit=` (1..100)。
  所有端点（`/login` 除外）需 `Authorization: Bearer <token>` 头。
- Dashboard SPA 嵌入于 `/dashboard` 和 `/` 路径，由 `packages/server/src/dashboard/dashboard.html`
  提供。深色主题、登录表单、选项卡视图（overview / projects / providers / runs）、
  时间窗口选择器（today / this week / this month / all）。
- 首屏统计包含：总 review 次数、成功/失败/跳过次数、发现问题的 run 次数、
  problem 总数、创建 issue 数、分析代码量、LLM 请求数、输入/输出/总 token、估算成本、平均 duration。
- 工程级维度按 project 聚合：分析次数、代码量、问题数、issue 数。
- provider+model 维度：请求数、token 数、成本、重试/fallback/失败、平均延迟。
- Store DB 仅在 `adminAuthConfig` 可用时初始化（即设置了 `AICR_ADMIN_USERNAME` +
  `AICR_ADMIN_PASSWORD`，或设置 `AICR_ADMIN_USERNAME` + `AICR_ADMIN_PASSWORD_HASH`）。
  `bootstrapServerApp` 解析 admin auth config 后创建 `StoreDb` 实例，并注入
  `ServerAppOptions.store` 和 `observability`。
- Review run 持久化通过 `persistReviewRunToStore`（成功）和 `persistFailedRunToStore`
  （失败）函数在 `scheduleTriggerProcessing` 和 `handleReviewOrchestration` 中调用。
- `/metrics` 保持低基数、进程累计语义；高基数查询走 SQLite 持久库。
- 观测数据只保存运行与用量元数据，不保存 prompt、完整 diff、secret 或未脱敏输出。
- 删除项目清理已实现：
  - `softDeleteMissingProjects(store, activeIdentities)`：启动/配置 reload 时将
    不在 active set 中的 project 标记 `deleted_at`；空 active set 时软删除所有 project。
  - `hardDeleteExpiredProjects(store, graceDays)`：按宽限期硬删除已软删除 project，
    通过外键 `ON DELETE CASCADE` 级联清理关联数据。

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
- 远程部署的操作性说明以 `example/README.md`、`docs/podman.md` 与仓库技能为准；`development/README.md` 是当前仓库操作约束，不是对外产品文档。
