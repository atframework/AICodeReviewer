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
- Review request 事件属于主动 re-review 入口：GitHub `pull_request` 的 `review_requested` action 与 Gitea/Forgejo `pull_request_review_request` 的 `review_requested` action 都归一为 PR `ReviewEvent`；`review_request_removed` 不创建 review run。
- Webhook 实现必须保持平台边界清晰：共用签名校验、repo mapping、payload schema 与 ReviewEvent 构造放在 `packages/server/src/webhook-common.ts`；Gitea/Forgejo、GitHub、GitLab 的事件语义分别放在对应平台文件；`webhook-translator.ts` 只负责按 provider 分发。
- 当开启 async 语义时，入口应尽快返回 `202` 与 `runId`，后台完成 review。
- `ReviewEvent` 要覆盖提交者、目标、仓库映射、变更集、workspace 等最小稳定字段。
- P4 trigger 只负责最小 metadata POST；服务端负责拉取和补足 diff/describe。
- 提交者可见元数据必须来自事件或 provider/VCS 查询结果，不能回退成分析用 workspace 或 agent 本地环境。
- **Issue triage 仅支持 Gitea/Forgejo 且必须按事件 provider 族门控**：`resolveIssueTriageOptions`（`packages/server/src/bootstrap.ts`）只构造单个 `GiteaApiClient`（同时兼容 Gitea 与 Forgejo），因此 `packages/server/src/index.ts` 的 triage 分支只在 issue 事件的 `provider` 属于 `"gitea"`/`"forgejo"` 时执行，跳过 GitHub/GitLab/P4/SVN。门控依据**事件 provider 族**，而不是 trigger `kind` 派生的标签：Forgejo-kind trigger 实际由 `/webhooks/gitea` 路由提供服务（`options.forgejo` 从不填充，只填充 `options.gitea`），其事件带 `provider: "gitea"`，用 trigger kind 做相等比较会静默跳过 Forgejo triage。否则 GitHub/GitLab/P4 的 issue 事件会被 Gitea 客户端处理，指向内部不可达或语义不兼容的 URL，每次都以 `issue_triage_failed` / `fetch failed` 失败。当前不存在 GitHub triage 客户端，未新增对应 client 前不要把非 Gitea workspace 接入 triage。

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
  - `aicr.fetch_more_context` 请求未在 scoped tree 中的相关文件时，按当前 revision 执行最小 VCS 补拉并回灌工作区：git 适配器用 `git show <revision>:<path>`，P4 适配器在配置 depot 内用 `p4 print <path>@<revision>`，均不扩大成全仓同步；仓库中确实不存在的路径（或子模块 gitlink）会被拒绝作为"停止重试该路径"的信号
- SVN 基础 adapter 使用 Subversion 原生命令，不做全仓 checkout：`svn diff --summarize`
  列变更，`svn cat -r <revision>` 最小物化 changed/related 文件，
  `svn diff --git` 供统一 diff parser 消费；`watch_path`、
  `include_cr_file`、`exclude_cr_file` 与 P4 adapter 使用同一过滤语义。
  `aicr.fetch_more_context` 对未物化相关文件回拉
  `<repository_url>/<path>@revision` 等价内容，并拒绝配置 `repository_url` 外的 URL。
  真实 SVN 仓库 e2e 与入站触发脚本/端点仍属 Backlog。

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

#### 3.6.2 默认评审 prompt 上下文策略

- Diff hunks 不够用于准确评审。默认 prompt 强制要求 agent 在报告任何问题前
  主动读取完整变更文件、接口/类型定义、调用方/被调用方、配置和 schema。
- agent 必须使用 `aicr.fetch_more_context` 或 shell 只读工具（`rg`、`fd`、`bat`）
  获取相关代码，不允许仅基于 diff 片段发表猜测性问题。
- 当无法获取验证所需的上下文时：高影响问题可附带不确定性声明报告；中低影响问题
  应跳过。
- `buildJsonToolContract()` 和 MCP `aicr.fetch_more_context` 工具描述已对齐
  这一策略，在 JSON 格式指引和工具元数据层面都要求先读后报。

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
- **超时必须杀整个进程树（含 `setsid` 逃逸的 worker）**：native/docker 后端超时时调用共享 `killProcessTree`（`packages/sandbox/src/process-tree.ts`）终止整棵后代进程，而非只杀直接子进程。Agent 二进制（如 Kilo）会 `setsid` 把 worker 子进程放进独立 session/进程组，因此仅 `detached: true` + `process.kill(-pid)` 杀进程组**不足以**覆盖它们——worker 会逃逸、被 reparent 到 PID 1 继续运行并持有继承的 stdio，导致 spawn promise 挂起、`durationMs` 远超 `agent.timeout_seconds`（实测 600s 配置跑到 700s–1640s），重试越拖越慢形成 CPU 耗尽死亡螺旋。Linux 下 `killProcessTree` 必须额外按 `/proc` 的 PPID 链遍历后代（`setsid` 不改 PPID）并逐个 kill（先深后浅），再叠加 `kill(-pid)` 进程组信号与 `proc.kill(signal)`；Windows 用 `taskkill /T /F`。配 SIGTERM→SIGKILL 级联与强制 resolve 兜底。`packages/sandbox/test/native.test.ts` 同时覆盖继承 stdio 的孙进程与 `setsid` worker 回归（后者 Linux-only）。
- **外层容器必须 `--init` 回收僵尸**：`deploy/deploy.sh` 用 `podman run -d --init` 启动服务（不要删 `--init`）。否则 Node 作为 PID 1 不会回收逃出沙箱 kill 的后代（如 #49 的 `setsid` worker），它们以 `Z` 状态堆积在 PID 1 下（生产实测 31 个），在退出前持续拖慢重试。`--init` 让 `tini`/`catatonit` 作为 PID 1 回收 reparent 的僵尸，是容器内 Node-as-PID-1 的标准修复。

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
- 复合输出 publisher 必须隔离单通道发布失败：某个 channel（例如 GitHub issue API 403）失败时记录 `DispatchResult.status=failed` 和告警日志，继续尝试后续 channel；只有成功发布的 dispatch 才使 run 状态成为 `published`，若全部 dispatch 都失败则 run 以 `skipped/output_dispatch_failed` 结束，而不是把触发器升级为 `review_orchestration_failed`。

#### 3.9.0 PR Review Summary 更新模式

- PR/MR review 通道（`gitea_pr_review`、`github_pr_review`）支持 `review_update_strategy` 配置：
  - `always_new`：每次推送创建新的 review/comment。
  - `update_existing`（默认）：查找 PR 上已有的 AICR 管理的 summary comment，通过 PATCH 更新而非新建。
- 更新模式下 summary comment 使用 HTML 注释标记（`<!-- aicr:managed=pr-review -->`、`<!-- aicr:problems=fp1,fp2 -->`）做身份识别与 fingerprint 跟踪。
- 问题分三类呈现：**Still Open**（指纹在旧 comment 和当前均存在）、**New**（仅当前存在，标注引入 commit）、**Resolved**（仅旧 comment 存在，标记 ✅ 不删除）。Resolved 项优先显示元数据标题，旧 comment 无元数据时显示可读占位而不是 raw fingerprint。
- `publishProblem` 只缓冲问题；`publishSummary` 将所有问题、summary 和代码引用集中到一个 Markdown reply body。即使 PR review 通道只配置在 `line_comments` 路由下，也必须通过 summary flush 发布，避免缓冲问题丢失。
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
  - `per_commit`：按 commit scope fingerprint（channel + repo + headSha）创建 issue，不同 commit 的问题相互独立，不自动关闭其他 commit 的 issue。
- `resolved_action` 支持：
  - `close`（默认）：关闭 issue。
  - `delete`：删除 issue（仅 Gitea）。
  - `mark_resolved`：在 issue 正文顶部添加 ✅ Resolved 标记并关闭，保留 issue 供历史追踪。
  - `none`：不执行任何操作。
- consolidated 模式下 labels 使用最高严重级别，assignees 汇总所有关联负责人。
- managed issue 标题由输出层生成，优先保持单行可读：
  - `per_problem`：前缀 + 严重级别 + 缩短位置 + 简短摘要（如 `[AICR] [HIGH] src/app.ts:3 · Issue`）。
  - `consolidated`：单问题复用 `per_problem` 格式；多问题使用前缀 + 最高严重级别 + 问题数 + 代表摘要（如 `[AICR] [CRITICAL] 3 problems · SQL query uses unsanitized input`）。
- `aicr.publish_summary.title` 只影响 issue body 里的 summary heading，不直接控制 managed issue 标题。
- consolidated issue 支持 per-fingerprint 解决跟踪与 webhook 重放保护：
  - issue body 包含隐藏标记 `<!-- aicr:commit={headSha} -->` 和 `<!-- aicr:open_problems=fp1,fp2 -->`，每个问题标题后嵌入 `<!-- aicr:fp={fp} -->`。
  - 更新已有 consolidated issue 时，通过 VCS compare API 验证当前 commit 是否在存储 commit 之后：
    - 当前 commit 在存储 commit 之后（`ahead` 或 `identical`）：执行完整分类（新增/仍存在/已解决），在 issue body 中显示 Resolved 折叠区。
    - 相同 commit：仅合并新问题，不标记任何问题为已解决（避免 LLM 可变性误判）。
    - 当前 commit 更旧（`behind` 或 `diverged`）：完全跳过更新（防止 webhook 重放）。
    - compare API 失败或不可用：更新但不分类（fail-safe，不误标记已解决）。
  - 向后兼容：缺少新标记的旧 issue body 按原有逻辑全量替换。
- GitHub managed problem issue 需要 `token_env` 指向具备 Issues read/write 权限的 PAT 或 GitHub App installation token；Webhook 的 `Issues` / `Issue comments` 事件订阅只控制入站事件，不授予 REST API 创建/更新 issue 的权限。

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
  - `llm.model_catalog`（计划中，M10；见 §3.13）
  - `queue.workers`
  - `queue.rate_limit`
  - `queue.retry`
  - `queue.dead_letter`
  - `review.problem_issue.max_recent_issues`
  - `review.log_thinking`
  - `review.reflection.memory`
  - `workspaces.defaults.agent`
  - `workspaces.defaults.prompt.base_system_prompt_file`
  - `workspaces.defaults.prompt.force_skills`
  - `outputs.channels[].mention_fallback`
  - `outputs.routes`
- `queue.retry` 的规范字段是 `attempts` 与 `backoff`；旧配置中的
  `max_attempts` / `backoff_seconds` 仅作为兼容输入归一化，新增示例不要继续使用。
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

#### 3.10.1 Per-workspace prompt 覆盖

- `workspaces.defaults.prompt` 和 `workspaces.instances.<id>.prompt` 支持两个字段：
  - `base_system_prompt_file`：指向自定义 system prompt 模板文件的路径（相对于部署根目录）。设置后，该 workspace 的 review 使用此模板替代全局 `--base-prompt` 加载的模板。
  - `force_skills`：技能名称数组，强制激活指定技能，忽略 `Applies To` glob 过滤。适用于需要始终运行的审计、安全等技能。
- Bootstrap 阶段为每个 workspace 注册 `baseSystemPromptResolver` 和 `forceSkillsResolver`；orchestrator 在调用 `prepareReviewPrompt()` 前解析 workspace 级配置。
- 代码真源：`packages/server/src/bootstrap.ts`（resolver 注册）、`packages/server/src/review-orchestrator.ts`（运行时解析）。

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
  提供。深色主题、登录表单、选项卡视图（overview / projects / providers / runs）。
  即使尚未配置 admin env，`/` 与 `/dashboard` 也必须返回 dashboard shell，并显示
  setup-required 提示而不是 404；若启用了 `path_prefix`，顶层 `/` 与 `/dashboard`
  应重定向到带前缀的 dashboard 入口。
  Overview 标签有时间窗口选择器（today / this week / this month / all）；
  Projects 与 Providers 标签各自独立支持时间维度切换，按需调用
  `GET /stats/projects?since=` 与 `GET /stats/providers?since=`。
- 首屏统计包含：总 review 次数、成功/失败/跳过次数、发现问题的 run 次数、
  problem 总数、创建 issue 数、分析代码量、LLM 请求数、输入/输出/总 token、估算成本、平均 duration。
- 工程级维度按 project 聚合：Projects 面板以表格展示各工程的 reviewCount、successCount、
  failureCount、skipCount、problemTotal、issueCreatedCount、filesChangedTotal、
  linesAddedTotal / linesDeletedTotal、llmRequestTotal、tokensTotalTotal、costUsdTotal、
  avgDurationMs；支持 today/thisWeek/thisMonth/all 筛选。
- provider+model 维度：Providers 面板以表格展示各 provider+model 的 requestCount、
  tokensIn、tokensOut、tokensTotal、costUsd、retryCount+fallbackCount+failureCount、
  avgLatencyMs；支持 today/thisWeek/thisMonth/all 筛选。
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

- reflection / memory 是 M7 阶段的**已落地能力**，当前支持 "light" 模式。
- 配置 schema（`review.reflection`）：`enabled`（boolean）、`mode`（`"off"` | `"light"` | `"thorough"`）、`memory.max_size_kb`、`memory.max_entries`、`memory.retention_days`。
- 已交付的基础设施：
  - 存储表 `reflection_memory`（`packages/store/src/schema.ts`），含 `workspaceId`、`fingerprint`、`content`、`sourceRunId`、`createdAt`、`expiresAt`。
  - 数据库迁移 `002_reflection_memory`，自动在 store 初始化时运行。
  - 读写 API：`writeReflectionMemory()`、`readReflectionMemory()`、`compactReflectionMemory()`（`packages/store/src/reflection.ts`）。
  - 按 workspace 隔离，支持 TTL 过期和条目上限压缩。
- 已交付的流程集成：
  - **Pre-run memory 读取**：`memoryHintsResolver` 在 review run 开始前从 store 读取当前 workspace 的 memory 条目，映射为 `string[]` 注入 `memoryHints`，通过 prompt pipeline 渲染到 `{{MEMORY_HINTS}}` 模板占位。`memoryHintsResolver` 优先于静态 `memoryHints` 字段。
  - **Post-run reflection 提取与写入**：`postRunCallback` 在 review run 完成后调用 `extractReflections()`（`packages/core/src/reflection-extractor.ts`），从 `outputState` 提取 per-category 问题模式、文件类型范围、summary 标题等 reflection 条目，写入 store。每个条目使用 `sha256(workspaceId:pattern)` 生成 fingerprint 实现幂等覆盖。
  - **Compaction 触发**：每次写入后检查 `review.reflection.memory.max_entries` 配置，若设置则调用 `compactReflectionMemory` 清理过期和超限条目。
  - **Bootstrap 自动配置**：`bootstrapServerApp` 在 store 可用且 `review.reflection` 未显式禁用时，自动注入 `memoryHintsResolver` 和 `postRunCallback`。Post-run callback 异常仅输出 warn 日志，不阻塞 review 主流程。
- Light mode 提取规则：
  - Skipped run：记录 skip reason 作为 reflection。
  - 问题归纳：按 category 分组，统计 severity 分布、关联文件扩展名，3 条以内附加具体位置。
  - 文件类型范围：统计 changed files 的扩展名分布。
  - Summary 标题：记录最新 review 的 summary title。
- Thorough mode（预留，未实现）：
  - 跨 run 聚合分析 false-positive 模式。
  - Repo 约定学习与自动注入。
  - 更精细的去**敏策略。
- 真正落地时的约束：
  - memory 的写入边界由 extractor 的 fingerprint 保证幂等。
  - workspace 隔离已通过 `workspaceId` 列保证。
  - memory content 经过 secret scrubber 同样的脱敏规则。

### 3.13 模型元数据 Catalog（models.dev）

> 状态：**基本完成（M10）**。代码真源以 `packages/core/src/config.ts`、
> `packages/llm/src/model-catalog.ts`（纯解析/归一化）、`packages/store/src/model-catalog.ts`
> 与 `model_catalog`/`model_catalog_source` 表、`packages/server/src/model-catalog-service.ts`
> 编排、`packages/agents/src/model-metadata.ts` 注入与各 adapter 实现为准。Redis 结构化
> 缓存后端为预留项，当前显式拒绝。

#### 3.13.1 目标与职责

- 为每个被使用的 provider+model 提供统一的**模型参数元数据**：上下文窗口、最大
  输入/输出 token、输入/输出/缓存价格，以及是否支持工具调用、视觉/附件、搜索（若
  上游 catalog 提供）、推理、结构化输出等能力。
- 经过 GPT/OpenAI、Claude、Gemini、DeepSeek、GLM、Kimi 等主流模型能力面对照后，
  元数据分两层：
  - **运行时 ModelSpec 字段**：会影响压缩、预算、请求参数裁剪、agent 配置注入或输出解析。
  - **Catalog/vendor metadata**：用于审计、告警、映射和 UI，不直接变成请求参数。
- 元数据用于三个消费面：
  1. **压缩与预算**：`compression` 用 `contextWindow` 计算触发阈值；`llm.budget`
     与观测成本统计用真实价格替代当前 `gateway.ts` 里 `(tokens/1000)*0.002` 的
     占位估算。
  2. **ModelSpec 充实**：把元数据合并进 `ModelSpec`，让 `contextWindow`、
     `supportsToolCall`、`supportsVision`、`supportsCachePrompt` 等字段无需用户
     手填即可生效。
  3. **Agent/CLI 配置转换**：把元数据正确写入外部 Agent CLI 的模型配置（见
     §3.13.5），特别是那些**不会自己读取 models.dev、完全依赖用户配置**的自定义
     provider 路径。
- 数据来源是 models.dev 的 `https://models.dev/api.json`（provider+serving 视图）。
  数据为非 secret 的公开元数据；fetch 只读、只解析 JSON，不执行远端内容。

#### 3.13.2 缓存存储与三层回退顺序

刷新缓存使用**结构化按键存储**，复用顶层 `storage` 命名空间（见 §3.10、决策 D28），
**不在读路径上解析整份 `api.json`**：

- **默认 SQLite 后端（按模型点查）**：store 新增 keyed 表 `model_catalog`，主键
  `catalog_id` = `<provider>/<model>`，每个模型一行，存解析后的字段（`context`、
  `input`、`output`、各项 `cost`、能力 flag、`modalities`、`source`、`fetched_at`、
  `etag`），并用同一 SQLite 数据库记录每个 `source_url` 的上次整表刷新时间与 ETag。
  复用 `storage.database`（`sqlite.path` 默认 `/app/data/aicr.sqlite`）。新增表与迁移
  `003_model_catalog`（`packages/store/src/schema.ts`、`packages/store/src/database.ts`），
  随 store 初始化自动运行。
- **可选 Redis 后端**：`llm.model_catalog.cache.backend: redis` 时，使用
  `storage.cache.redis` 作为结构化缓存后端，按 key（如
  `aicr:model-catalog:<provider>/<model>`）存已解析结果，并用 source-level key 记录
  上次刷新时间；必须在 `storage.cache.kind: redis` 且 `redis.url_env` 可解析时启用，
  否则启动时显式报错。Redis 后端是派生缓存，不作为唯一历史统计存储。
- **memory 后端仅用于测试/临时开发**：不满足跨进程持久化，不应作为生产默认。
- **读路径是点查**：取某个 provider+model 参数是 SQLite 主键点查或 Redis `GET`。
  整份 `api.json` 只在刷新时解析一次并逐行 upsert，绝不每次读都全量解析整份 JSON。

远端访问按 `source_url` 的刷新元数据判定，而不是“某个模型未命中就无条件拉远端”，避免
未知模型导致每次 lookup 都触发远端请求：

1. **刷新（最新）**：从未成功刷新过，或上次整表刷新超过 `refresh_interval_hours`
   （默认 24h = 每天一次，可配置）时，拉一次 `source_url`，解析后逐行 upsert 进后端并
   更新 source-level 刷新元数据；周期内直接点查本地缓存，不访问远端。
2. **过期本地行（其次）**：远端拉取失败时，先用本地后端中已有（可能过期）的模型行。
3. **打包保底快照（最旧，只读）**：随构建产物发布的
   `packages/llm/assets/model-catalog/models-dev.json`，每次打包从
   `https://github.com/anomalyco/models.dev`（或其 `api.json`）拉取刷新并签入仓库，保证
   离线/无网络构建也能发布保底数据。仅当本地后端缺该模型时**按需 seed 一次**进
   `model_catalog` 后端；保底 JSON 可以在首次 seed 时解析一次，但不能在每次读时重复解析。

全部未命中时保留用户在 config 里显式写的字段，**不臆造**缺失值。`offline: true` 时直接跳过
远端，只用本地结构化缓存 + 打包保底快照。每条解析结果都标注来源
（`override` / `cache` / `remote` / `bundled` / `config`），写入 run 快照便于观测和排障。

`bootstrapServerApp` 当前只在 admin/dashboard 启用时初始化 store；M10 实现必须把 store
初始化条件扩展为：admin auth、`llm.model_catalog` SQLite 后端、reflection memory 任何一个
需要持久化时都应创建 `StoreDb`。模型解析顺序也必须调整为“初始化 catalog service → 解析并
充实 primary / fallback / summarize `ModelSpec` → 创建 LLM gateway / runtime bundle”，避免
当前 `resolveModelSpecFromConfig()` 早于 store 初始化而拿不到 catalog。

#### 3.13.3 解析链（providerId + modelId → catalog 条目）

models.dev 的 key 是 `<providerId>/<modelId>`（AI SDK 标识）。自定义 provider 通常
不会与 models.dev 的 provider id 对齐，因此按以下顺序解析，**显式配置永远优先**：

1. `llm.model_catalog.overrides["<providerId>/<modelId>"]`（手填覆盖，最高优先）。
2. override / provider 上的显式 `catalog_id`。
3. provider 配置了 `catalog_provider` 时用 `<catalog_provider>/<modelId>`。
4. 直接用 `<providerId>/<modelId>`。
5. 跨 provider 按 `<modelId>` 模糊匹配（最后兜底，命中多个时记录歧义告警）。
6. 全部未命中：保留用户在 config 里显式写的字段，**不臆造**缺失值。

#### 3.13.4 ModelSpec 充实与合并优先级

- `ModelSpec`（`packages/llm/src/index.ts`）在现有 `contextWindow`、
  `supportsToolCall`、`supportsVision`、`supportsCachePrompt` 基础上，新增可选字段：
  `maxInputTokens`、`maxOutputTokens`、`costInputPerMTok`、`costOutputPerMTok`、
  `costCacheReadPerMTok`、`costCacheWritePerMTok`、`costReasoningPerMTok`、
  `costInputAudioPerMTok`、`costOutputAudioPerMTok`、`supportsReasoning`、
  `supportedReasoningEfforts`、`defaultReasoningEffort`、`thinkingModes`、
  `supportsInterleavedReasoning`、`interleavedReasoningField`、`supportsStructuredOutput`、
  `supportsTemperature`、`supportsStreaming`、`supportsLogprobs`、`supportsAttachment`、
  `supportsSearch`、`supportsComputerUse`、`nativeToolCapabilities`、
  `supportedRequestParameters`、`unsupportedRequestParameters`、`inputModalities`、
  `outputModalities`、`catalogSource`。
- models.dev → ModelSpec 映射：`limit.context`→`contextWindow`，
  `limit.input`→`maxInputTokens`，`limit.output`→`maxOutputTokens`，
  `tool_call`→`supportsToolCall`，
  `attachment`（或 `modalities.input` 含 `image`）→`supportsVision`，
  `attachment`→`supportsAttachment`，`structured_output`→`supportsStructuredOutput`，
  `temperature`→`supportsTemperature`，`reasoning`→`supportsReasoning`，
  `reasoning_options[type=effort].values`→`supportedReasoningEfforts`（按 `string[]`
  原样保留所有档位并保序去重，含 GPT-5.x `xhigh`、DeepSeek `max`、`none`、`default` 等
  非 canonical 档位，不收窄到 `minimal/low/medium/high`），`reasoning_options[].type`
  →`thinkingModes`（`effort`/`toggle`/`budget_tokens`），
  `interleaved`→`supportsInterleavedReasoning` 与 `interleavedReasoningField`，
  `cost.cache_read`/`cache_write` 存在→`supportsCachePrompt`，
  `cost.input_audio`/`output_audio`→对应 audio 成本字段，`search` / `web_search`（若上游
  schema 提供）→`supportsSearch`，`cost.*`（每百万 token USD）→对应 `cost*PerMTok`。
  当前已核验的 models.dev schema 未保证搜索字段存在；缺失时只允许用户通过 overrides
  显式补充。
- 主流模型额外能力映射：OpenAI/Gemini 的 web/file search、URL context、code execution、
  computer use 等归入 `nativeToolCapabilities`（如 `"web_search"`、`"file_search"`、
  `"url_context"`、`"code_execution"`、`"computer_use"`）；Claude/GLM/Kimi/DeepSeek 的
  thinking/effort/mode/`reasoning_content`/`reasoning_details` 等归入 reasoning、
  `supportedReasoningEfforts`、`defaultReasoningEffort`、`thinkingModes` 与 interleaved 字段；
  DeepSeek/Kimi 的 `response_format`、OpenAI structured outputs、Gemini structured outputs 归入
  `supportsStructuredOutput`；DeepSeek 的 `logprobs` / `top_logprobs` 归入 logprob 与
  request-parameter support；Kimi 的 `prompt_cache_key`、DeepSeek 的 cache hit/miss 价格与
  GLM context caching 归入 cache 能力和 cost 字段。provider 文档中明确废弃或不支持的参数
  （如某些 penalty 参数）必须进入 `unsupportedRequestParameters` / `dropParams`，避免 adapter
  继续发送。
- Catalog/vendor metadata（不直接写进请求参数）：`catalogId`、`displayName`、`family`、
  `knowledgeCutoff`、`trainingCutoff`（若 provider 明确区分）、`releaseDate`、`lastUpdated`、
  `modelStatus`（`stable`/`preview`/`experimental`/`alpha`/`beta`/`deprecated`/`shutdown`）、
  `openWeights`、`license`、`modelLinks`、`providerDisplayName`、`providerNpmPackage`、
  `providerEnvVars`、`providerApiBaseUrl`、`providerDocsUrl`、`providerModelAliases`、
  `providerModelIds`（如 Claude API / Bedrock / Vertex / Foundry ID）、`apiProtocol` /
  `preferredEndpoint`（如 OpenAI Responses、Anthropic Messages、Gemini GenerateContent、
  OpenAI-compatible chat completions）、`latencyClass`、`priorityTierSupported`、
  `rateLimitTier`、`concurrencyLimit`、`throughputHintTokensPerSecond`。
  这些字段用于选择/告警/映射和 dashboard，不应让 adapter 自动发送给 LLM API。
- 合并优先级：**用户在 `llm.providers[]` / `overrides` 里显式写的字段 > catalog
  元数据**。catalog 只填补缺口，用户随时可覆盖。

#### 3.13.5 各 Agent/CLI 的配置转换（关键）

不同外部 Agent CLI 对 models.dev 的支持不同，转换策略必须按工具区分，避免“工具本身
能读 models.dev 时重复注入”或“工具不读 models.dev 时漏注入”：

| Adapter | 是否原生读 models.dev | 转换策略 |
| --- | --- | --- |
| **opencode** | 已知 provider 走 models.dev 自动解析；**自定义 `@ai-sdk/openai-compatible` provider 不自动解析** | 自定义 provider 注入 `models.<id>.limit.context`、`limit.output`、`cost.{input,output,cache_read,cache_write}`、`name`；如确需 `OPENCODE_MODELS_PATH`，只能指向 run `agent/` 目录下由 AICR 生成的 models.dev-compatible 小型 `api.json`，不能指向 SQLite/Redis 刷新缓存。命中 models.dev 已知 provider 时跳过注入。 |
| **Kilo Code** | 否（Cline/Roo 衍生） | OpenAI-compatible 自定义 provider 注入模型参数：`contextWindow`、`maxTokens`（输出上限）、`supportsImages`（视觉）、`supportsComputerUse`、`supportsPromptCache`、`inputPrice`、`outputPrice`、`cacheReadsPrice`、`cacheWritesPrice`。 |
| **Roo Code** | 否 | `.roo/settings.json` 的 `apiConfiguration.openAiCustomModelInfo` 注入 `contextWindow`、`maxTokens`、`supportsImages`、`supportsComputerUse`、`supportsPromptCache`、`inputPrice`、`outputPrice`。 |
| **Claude Code** | 否（依赖内置 Anthropic 目录 + 环境变量） | 无 file 级模型元数据面；有 `maxOutputTokens` 时设置 `ANTHROPIC_MAX_TOKENS`，上下文窗口/价格依赖 Anthropic 内置目录。能力缺失时在 manifest 显式降级。 |
| **Copilot CLI** | 否（Copilot 订阅固定目录） | 模型目录由 Copilot 订阅固定，无注入面；记为 N/A 并在 manifest 标注。 |

- 注入只在**自定义/未被工具原生解析**的 provider 路径发生；工具能自己从 models.dev
  解析时跳过，避免双写冲突。
- runtime bundle manifest（§3.6.3）记录每个模型“哪些参数被注入、哪些委托给工具
  原生目录”，能力不支持时显式降级而不是静默丢弃。

#### 3.13.6 配置、观测与安全

- 配置 schema：`llm.model_catalog`（`enabled`、`source_url`、`refresh_interval_hours`、
  `fetch_timeout_ms`、`offline`、`apply_to_model_spec`、
  `cache`、`overrides`）与每个 `llm.providers[]` 上可选的 `catalog_provider` /
  `catalog_id`。`cache.backend`（`sqlite` 默认 | `redis` | `memory`）选择结构化刷新缓存
  后端：`sqlite` 复用 `storage.database`（keyed `model_catalog` 表，按模型点查），
  `redis` 复用 `storage.cache.redis` 并要求 `storage.cache.kind: redis`，`memory` 仅适合
  测试/临时开发。不引入单独的 JSON 缓存文件路径。详见 §3.10 与
  `packages/core/src/config.ts`。
- 观测：`llmUsage` 与 `runs/<run_id>/run.json` 记录解析到的价格与 `catalogSource`，
  让 Dashboard 成本统计基于真实价格而非固定估算；catalog 刷新失败回退时记录告警。
- 安全：fetch 只取公开元数据，不含 secret；遵守全局 `http_proxy`；缓存写在
  `storage.database` / `storage.cache`，不写进只读 source/agent 挂载；解析前校验 JSON 结构。

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
