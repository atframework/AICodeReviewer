# 稳定决策索引

这份文档收纳长期有效、会影响实现和审查方式的决策记录。
原先散落在 `Plan.md` 的 D1-D31 已搬到这里，`Plan.md` 只保留与当前执行顺序有关的摘要。

## 使用方式

- 按下表议题定位所需决策；仅在任务涉及执行优先级时读取 `Plan.md`。
- 当任务涉及稳定取舍、历史约束或“为什么这样设计”时，再按需读取这里。
- 若实现变更会推翻这里的某条决策，应同步更新相关文档、示例和测试。

## 决策表

| ID | 议题 | 决策 | 当前落点 |
| --- | --- | --- | --- |
| D1 | 部署形态 | 单容器自托管为主，Helm chart 为可选；常驻进程监听 HTTP 端口接收所有 VCS 的 webhook / trigger script POST。 | `docs/podman.md`、`deploy/Dockerfile`、`deploy/deploy.sh` |
| D2 | 核心语言 | 选 TypeScript（Node 22+ / Bun 友好），与目标 Agent CLI、MCP 与 `ai-sdk` 生态对齐。 | `docs/ai/architecture.md` §2.1 |
| D3 | AST / 语法服务 | 当前不内置；通过 Context Provider 插件接口预留扩展位。 | `docs/ai/architecture.md` §10.1 |
| D4 | 审批流 | 当前不实现；通过 Output Pipeline 中间件 + Run 状态机扩展预留口子。 | `docs/ai/architecture.md` §10.2 |
| D5 | Workspace 目录布局 | 使用扁平、自包含布局 `workspaces/<workspace_id>/{source,prompts,skills,memory,templates,...}`。 | `docs/ai/architecture.md` §2.2、`docs/ai/architecture.md` §3.10 |
| D6 | VCS 拉取深度 | 默认 `--depth=100`，缺 base 时在闸门控制下做 deepen。 | `docs/ai/architecture.md` §3.2 |
| D7 | 压缩触发阈值 | 默认 `trigger_tokens: 131072`，并叠加 `max_input_ratio: 0.6`。 | `docs/ai/architecture.md` §3.3 |
| D8 | LLM 限流策略 | 单次调用层使用 bounded rate-limit retry，与队列层 retry 解耦。 | `docs/ai/architecture.md` §3.5 |
| D9 | 模板与 @-mention | 输出走 Handlebars 模板；@-mention 通过作者解析管线与黑名单保护。 | `docs/output-channels.md`、`docs/ai/architecture.md` §3.9 |
| D10 | 沙箱引擎 | docker 与 podman 平等支持，`sandbox.engine: auto` 自动检测。 | `docs/podman.md`、`docs/ai/architecture.md` §3.8 |
| D11 | 文档自校验 | `Plan.md` 与 `docs/*.md` 统一走 markdownlint。 | `AGENTS.md` 验证要求、`.markdownlint.json` |
| D12 | 思考强度 | `ModelSpec.thinkingLevel` 作为统一抽象，adapter 再翻译到各 provider。 | `docs/ai/architecture.md` §3.7.3 |
| D13 | 压缩阈值参考模型 | 阈值以当代长上下文模型为参考，不按单一供应商硬编码。 | `docs/ai/architecture.md` §3.3 |
| D14 | workspaces 命名空间 | 强制 `cache / defaults / instances.<id>` 三段式。 | `docs/ai/architecture.md` §3.10、`packages/core/src/config.ts` |
| D15 | Forgejo 支持 | Forgejo 与 Gitea API 兼容，复用同一 adapter。 | `docs/ai/architecture.md` §3.2、`docs/output-channels.md` |
| D16 | 仓库 AI 维护资产 | `AGENTS.md` 是唯一常驻指令源，`.agents/skills/` 是 canonical skill 源。 | `AGENTS.md`、`docs/ai/architecture.md` §3.6 |
| D17 | 默认提示词分层与 repo-local AI 资产加载 | system prompt 仅保留稳定硬规则，repo-local `AGENTS.md` / path instructions / skills 按需归一化加载。 | `docs/prompt-research.md`、`docs/ai/architecture.md` §3.6.1、§4 |
| D18 | 反向代理支持 | TLS 由代理终止，通过 `trust_proxy`、`path_prefix`、`base_url` 处理转发与回调。 | `docs/podman.md`、`packages/server` |
| D19 | Trigger 非阻塞语义 | `/webhooks/*` 与 `/triggers/*` 可配置 async，鉴权通过后立即返回 `202 + runId`。 | `docs/ai/architecture.md` §3.1、`packages/server/src/index.ts` |
| D20 | P4 trigger 职责边界 | trigger 脚本只发最小 metadata；分析 workspace 不得回退成提交者 workspace。 | `docs/ai/architecture.md` §3.1、§3.2、`example/p4-trigger.sh` |
| D21 | P4 凭据与过滤语义 | 支持非交互 `p4 login` 后重试；SSL 指纹未信任时自动 `p4 trust -y`（指纹不匹配时退到 `p4 trust -y -f` 强制替换）并重试；client workspace 被删时经 `p4 client -i` 自动重建最小只读 spec；不含 `/` 的 glob 走 basename 语义。 | `docs/ai/architecture.md` §3.2、`packages/vcs/src/p4.ts` |
| D22 | Problem 报告契约 | MCP problem 保持最小稳定字段，`message` 说明问题，`suggestion` 给出修复方式。 | `docs/output-channels.md`、`packages/mcp-output/src/index.ts` |
| D23 | 部署验收 agent | 部署测试以 Kilo Code 作为首要验收入口。 | `example/README.md`、`development/README.md` |
| D24 | 提交归因契约 | attribution 必须来自事件、provider API 或只读 VCS 工具验证，不得猜测。VCS 层归因通过**可选** `VcsAdapter.fetchAttribution` 提供（best-effort，缺失返回 `not_found`/`partial`，不污染 fingerprint）；`aicr.try_blame` 是只读 MCP 上下文工具，orchestrator 验证并回灌归因结果，`aicr.report_problem` 不接收 agent 自报 attribution。 | `docs/ai/architecture.md` §3.2、§3.9.2、`docs/output-channels.md`、`packages/vcs/src/{contracts,git,p4,svn,attribution}.ts` |
| D25 | 多源上下文 | 默认保持 `primary` 单仓行为，辅助仓库与子仓库显式访问。 | `docs/ai/architecture.md` §3.2、§3.10 |
| D26 | Agent Runtime Bundle | 每次 run 在隔离 `agent/` 目录物化 LLM、MCP、instructions、skills、env 与 manifest。 | `docs/ai/architecture.md` §3.6.3、§3.7 |
| D27 | 无问题输出策略与目标链接 | `no_problems.action` 按全局 → channel → workspace 覆盖，模板用 `target` 上下文渲染不同目标类型。 | `docs/output-channels.md`、`docs/ai/architecture.md` §3.9.1、§3.10 |
| D28 | 统一基础存储配置 | 数据库、缓存和对象存储使用顶层 `storage` 命名空间，供观测、队列、artifact、runtime 等能力复用。数据库默认 `/app/data/aicr.sqlite` SQLite + Drizzle；Postgres 字段为未来集中化持久后端预留，当前 runtime 必须显式拒绝未实现后端而不是静默回退。Redis 只做缓存/session/短期索引，不能作为唯一历史统计存储；对象存储默认 filesystem，预留 AWS S3、MinIO、RustFS 等 S3-compatible 后端。Prometheus/OTel/run snapshot 只是外部观测或审计补充；project 维度基于 workspace + trigger + repo，并对已从配置删除的项目执行 soft delete + 级联 GC。 | `docs/ai/architecture.md` §3.10-§3.11.1 |
| D29 | Per-workspace prompt 覆盖与强制技能 | workspace 级 `prompt.base_system_prompt_file` 覆盖全局 system prompt 模板；`prompt.force_skills` 按 skill 名称强制激活，忽略 `Applies To` glob 过滤。配置合并遵循全局 → defaults → instance 分层。 | `docs/ai/architecture.md` §3.10.1、`packages/core/src/config.ts` |
| D30 | Reflection memory 存储 | `reflectionMemory` 表按 workspace 隔离，支持 TTL 过期、条目上限压缩和 `occurrence_count` 计数。review 开始前读取并注入 `memoryHints`，review 完成后写入 light reflections、repo convention 抽象提示和 thorough mode 重复 category 聚合。repo convention 只保存 category/severity/文件类型/目录/相对路径+行号，不保存源码片段或 problem 正文；注入前去重、限长、脱敏并优先排在普通 reflection 前。跨 workspace 知识迁移明确不做。 | `docs/ai/architecture.md` §3.12、`packages/store/src/reflection.ts`、`packages/core/src/reflection-extractor.ts` |
| D31 | 模型元数据来源与缓存回退 | 模型参数（上下文窗口、最大输入/输出、价格、工具调用/视觉/搜索/推理 effort/mode/interleaved reasoning/结构化输出/温度/stream/logprobs/请求参数支持/原生工具能力）统一以 models.dev `api.json` 为来源，按 `<provider>/<model>` 解析。刷新缓存默认存 SQLite（store keyed 表 `model_catalog`，按模型主键点查，复用 `storage.database`），Redis 结构化后端已实现并复用 `storage.cache.redis`（启动时加载 namespace 到内存索引，刷新/seed 后持久化 entry/model/source key；`storage.cache.kind: redis` 与可解析 `redis.url_env` 为硬要求），memory 仅用于测试/临时开发；整份 `api.json` 只在刷新时解析一次并逐行 upsert，读路径不全量解析 JSON。远端刷新按 source-level `refresh_interval_hours`（默认每天）判定，未知模型不会在周期内反复触发远端请求；拉取失败按“过期本地行 → 打包期从 `anomalyco/models.dev` 拉取并签入的只读保底快照（仅按需 seed 一次）”回退。catalog 元数据合并进 `ModelSpec` 时**用户显式配置永远优先**，缺失才填补，绝不臆造；lifecycle/provider/运营 metadata（display name、family、knowledge/release/status、provider npm/env/API URL/aliases/多平台 model IDs、apiProtocol、latency、priority tier、rate/concurrency/throughput hints 等）只用于映射、告警、dashboard 和审计，不直接发给模型 API。Agent 配置转换按工具区分：opencode 已知 provider 走原生 models.dev；自定义 provider 按 `provider.<provider>.models.<model>` 生成 schema-valid 配置，仅注入完整 `limit`/`cost` 对及已知能力，transport/auth 与请求参数分别放 provider/model `options`；Kilo/Zoo 自定义 OpenAI-compatible 注入各自原生模型字段；Claude Code 由 `maxOutputTokens` / `contextWindow` 派生现行限制变量、由显式预算派生 `MAX_THINKING_TOKENS`，其余委托内置目录；Copilot CLI 无注入面，manifest 显式降级。 | `docs/ai/milestones/M10.md`、`docs/ai/architecture.md` §3.13、`packages/core/src/config.ts`（`llm.model_catalog` schema）、`packages/store/src/schema.ts` + `database.ts`（`model_catalog`/`model_catalog_source` 表 + 迁移 `003_model_catalog`）、`packages/store/src/model-catalog.ts`（repo）、`packages/llm/src/model-catalog.ts`（纯解析/归一化）、`packages/llm/src/gateway.ts`（`estimateCost` 按 token 类别计费：非缓存输入 / 缓存命中 / 缓存写入 / 输出，复用 catalog `costCacheReadPerMTok` / `costCacheWritePerMTok`，缺失回退输入价，仅无任何 catalog 价格时回落 `(tokens/1000)*0.002` 占位）、`packages/server/src/model-catalog-service.ts`（刷新/回退/充实）、`packages/server/src/bootstrap.ts`（编排）、`packages/agents/src/model-metadata.ts`（adapter 注入） |
| D32 | GitHub App 原生认证（M12） | GitHub trigger 除静态 `token_env`（PAT / 预先获取的 installation token）外，新增可选 `app` 认证：`app_id`/`client_id` + `private_key_env`/`private_key_path`（恰好其一）+ 可选 `installation_id`。用 `node:crypto` 签发 RS256 App JWT（`iat-60s`、`exp+540s`、`iss=app_id\|client_id`），换取并**缓存/自动刷新** installation access token（剩余 < 5min 刷新），缺省 `installation_id` 时按 `owner/repo` 动态解析并缓存；GHE 由 `base_url` 推导 `/api/v3`。零新增依赖。Token 服务归属 `packages/server`，三个注入点（VCS factory 改异步、output publisher resolver 改异步、webhook PR 详情拉取用 payload `installation.id`）统一在 server 层解析出字符串 token，`packages/vcs`/`packages/outputs` 保持只消费字符串 token 的平台中立合同；`git.ts` 既有 `x-access-token:<token>@` 约定天然兼容 installation token。签名校验（`x-hub-signature-256` + webhook secret）对 App/PAT 通用不变；`installation`/`installation_repositories` 事件返回 `202 unsupported_event`。私钥与签发 token 绝不进日志/输出，`secret-scrubber` 的 `gh[pousr]_`/`private_key`/`jwt` 已覆盖 `ghs_`/PEM/JWT（M12 已补回归测试）。 | `docs/ai/milestones/M12.md`、`docs/ai/architecture.md` §3.2.1、`packages/core/src/config.ts`（`triggerSchema.app`）、`packages/server/src/github-app-token.ts`、`packages/server/src/bootstrap.ts`（`createAppTokenServices`、`resolveTriggerTokenForContext`、`buildWebhookConfigFromTrigger`）、`packages/server/src/webhook-common.ts`（`VcsWebhookConfig.appTokenResolver`）、`packages/server/src/github-webhook.ts`（`extractInstallationId`）、`example/config.yaml`、`example/README.md` |
| D33 | pi 与 oh-my-pi agent 集成（M13） | pi 与 omp（pi fork）作为一等 AgentKind 接入：`AgentKind` 增加 `"pi"`/`"oh-my-pi"`，配置目录隔离统一走 orchestrator 注入的 `PI_CODING_AGENT_DIR`（沙箱可见路径，同 `AICR_OUTPUT_STATE_PATH` 注入模式），pi 另设 `PI_OFFLINE=1`/`PI_TELEMETRY=0`。密钥不落盘：pi models.json 写 `$ENV` 引用，omp models.yml 写 env 名（keyless 用原生 `auth: none`）。v1 仅支持已核验的 provider kind（`openai_compatible`/`ollama`/`anthropic`/`google_ai_studio`），其余 kind 显式报错并给出指引，不猜测未核验的认证管线；`contextWindow`/`maxOutputTokens` 缺失时显式报错并指引启用 `llm.model_catalog`（两家自定义模型条目都必填限额）。MCP 按能力分流：omp 原生走 `$PI_CODING_AGENT_DIR/mcp.json`（manifest `nativeSurfaces.mcp: "config_file"`）；pi 上游明确不做内置 MCP，runtime bundle 生成用户级扩展 `extensions/aicr-output.ts` 桥接 stdio JSON-RPC 并注册 `pi_aicr_*` 工具（manifest `"extension"` 面，server 规格经 `AICR_PI_MCP_SERVERS` env 传入）。两者输出同族 NDJSON，orchestrator 用共享提取器只聚合 `message_end.message.usage`（disjoint 计数器），`message_update` 累计快照不混入。任务文本走 `--` 之后的位置参数，`buildStdin()` 返回空串防 stdin 双写；Windows 原生沙箱 argv 32k 上限记为已知坑位（生产路径为 Linux 容器沙箱）。pi 的 headless trust 决策：bundle 目录完全由 AICR 物化，`--approve` 安全且是项目级 `.agents/skills` 加载的前提。 | `docs/ai/milestones/M13.md`、`docs/ai/architecture.md` §3.6.3/§3.7.2/§3.13.5、`packages/agents/src/{pi,oh-my-pi,pi-family,pi-mcp-bridge}.ts`、`packages/agents/src/runtime-bundle.ts`、`packages/server/src/review-orchestrator.ts`、`packages/core/src/config.ts` |
| D34 | 多源上下文聚合（M14） | 辅助仓库用 workspace 级 `context_repositories` 声明式配置（alias + kind + 连接字段，`workspaces.defaults`/`instances` 均可声明，merge 整体替换），连接信息只来自 config.yaml，payload 不可注入。每次 run 全新物化到 `<workspace>/context-repos/<alias>`（v1 不跨 run 缓存）：git 浅克隆 `--depth 1`（token 经 `GIT_CONFIG_*` env 注入 `http.extraHeader`，不进 argv 不落盘，重试前重建空目录）、svn `export --no-auth-cache`、p4 `files -e` + 有界并发 `print -q` 按字节导出（与 adapter 共享 trust/login/delete 判定，含 `trust -y -f` 回退与 session/ticket 过期重试；维持不执行 `p4 sync` 不变式）。所有 VCS 子进程 10 分钟超时，多仓库并发 3 物化，p4 文件数上限 5000 且字节在导出循环内累计即超即停。仅 agent 路径物化，容器沙箱经 `extraMounts` 只读挂载 `/workspace/context-repos/<alias>`；单仓库失败隔离（告警 + `status: failed` + 清理目录），物化前清扫配置外残留 alias 目录；`max_mb`（默认 512）强制闸门。结果经 `summarizeReviewOrchestrationForWebhook` 进入 webhook 响应与 run 快照。`aicr.fetch_more_context` 仍只服务主仓库，problem 锚定不变更。 | `docs/ai/architecture.md` §3.2.2、`packages/core/src/config.ts`（`contextRepositorySchema`）、`packages/vcs/src/context-repos.ts`、`packages/server/src/review-orchestrator.ts`、`packages/server/src/bootstrap.ts`（`contextRepositoriesResolver`） |
| D35 | 自动提交调度与 P4 批次 diff 端点内容（M15） | 自动提交事件统一走持久接收 + `AutoCommitStore`（memory/SQLite/Redis 三后端共享 conformance）+ 单 timer 调度器；`review.auto_commit` 三层配置（delay/周计划/exclude_sources，RE2 经 re2-wasm）。P4 批次净 diff 用 `diff2 <depot>/...@base @head` 两趟：枚举趟权威给出文件集合，`-u` 趟只供文本内容 hunk（真实 p4d 2025.1 核验：`-u` 完全省略 add/delete 条目）；add/delete 条目用 `p4 print -q <path>@<存活端点 CL>` 合成单 hunk，print 次数有界 ≤ add/delete 块数，二进制（NUL 探测）与空内容保持无 hunk 但绝不丢条目，print 失败明确报错而非误判无变更。`path@=N` 被服务器拒绝，状态语法是 `path@N`；`identical` 对不算变更；move 表现为 delete+add。 | `docs/ai/architecture.md` §3.1.1、`packages/vcs/src/p4.ts`、`packages/vcs/test/p4-batch-diff.test.ts` |
| D36 | 直接路径执行时段与持久化延期（M16） | PR/MR 等直接路径复用周计划钳制：新增可选 `review.pull_request.schedule`（三层整体替换，仅 timezone+rules），pull_request 事件优先使用它，各层未设置时回退 `review.auto_commit.schedule`，其余 target kind 始终用后者；同步模式不延期。窗口外延期由 `ReviewDeferralManager` 持久化到 `review_deferrals` 表（事件信封 + dedup key + not_before，同目标替换且不提前），单定时器到期原子 claim 后经 resumeHandler 重新进入常规调度，重启恢复 claimed→pending 并重新武装；无 store 退化为内存定时器。执行开始后的结果（含内存重试链）归 run 生命周期。评论命令（reason 以 `:comment_review` 结尾）被延期时回复一条说明计划开始时间的评论。可观测：落库最近 100 条 webhook 事件（`webhook_events` 表）经 `GET /api/admin/events` 供 Dashboard Events 面板展示处理方式（processed/deferred/deduplicated/rejected/ignored/error）；Dashboard Overview 最近活动表新增 Tokens（总 token + 缓存命中率）列。 | `docs/ai/architecture.md` §3.1.1、`packages/core/src/pull-request-policy.ts`、`packages/server/src/deferral-manager.ts`、`packages/store/src/{schema,webhook-events,review-deferrals}.ts`、`packages/server/src/observability-api.ts` |
| D37 | 运行时配置 generation 与执行固定（P4） | `config_sources.database` 开关（bootstrap 边界，默认 file-only 单 generation）决定运行时配置来源；启用后每次 webhook 在鉴权和选路前重读持久 head，并在异步请求上下文中固定 generation（admission barrier，失败 503 不回退旧文件视图），任务在接收时钉住 configSnapshotId 并全程使用该 generation（receipt/batch 持久化该 pin，assembly 以 config_boundary 切批，空库先持久化 revision 0 快照；历史 null pin 统一解析到首次 CAS 建立的 legacy_import，跨发布/重启不漂移；缺失非空 pin 直接失败）。模型路由、trigger 注册表、App token 服务、VCS adapter、publisher、auto-commit policy 全部按 generation 解析；`optionsResolver` 是每 run 唯一的 execution plan 覆盖入口。模型链 entry `overrides` 接线（map 按 key 合并、数组替换、身份不可覆盖）。 | `docs/ai/architecture.md` §3.16、`packages/server/src/runtime-config.ts`、`packages/server/src/bootstrap.ts`、`packages/core/src/auto-commit-assembly.ts` |
| D38 | review 路径过滤与沙箱默认合同（P4） | `review.include/exclude/max_files` 复用仓库路径 glob 语义接入 changedPaths 过滤（`*` 只匹配当前目录，`**` 匹配零个或多个目录；默认 `**/*` 包含顶层文件，`**/vendor/**` 只排除 vendor 目录）；`agent.sandbox.kind` 取消默认值：未设置=自动探测并允许 native 回退，显式容器类型 preflight 失败即拒绝运行，绝不静默降级 native。 | `packages/core/src/review-policy.ts`、`packages/sandbox/src/factory.ts`、`docs/site/.../configuration/agent.md`（双语） |
| D39 | 配置管理 API 与统计解耦（P5） | `/api/admin/config`（read/schema/validate/preview-route/changesets/operations/revisions/restore/status）复用 admin Bearer session（ConfigStore 合同）与 P3 发布服务，install 钩子激活本机 generation；与统计 store 完全解耦——observability 的 store 可选，统计端点无 store 显式 503，login/live/配置管理不依赖统计库。请求体流式 UTF-8 字节上限 1MiB、严格 DTO（原型键与缺少 value 拒绝）、fileDigest 不一致 409、跨源写入拒绝、operationId 幂等、409 冲突、202 committed_activating、响应深度脱敏（env 只回名称与存在性）。 | `packages/server/src/config-api.ts`、`packages/server/src/observability-api.ts`、`docs/ai/architecture.md` §3.16 |

### D40：运行时账本与 secret 用途授权

runtime state 以 namespace/key CAS 持久化 pin、instance、legacy_import、queue version
和固定 catalog 结果；业务接收前写 pin，完整查询所有任务后端后才能回收。保留旧任务
null 字段但固定其解析基线，避免升级时跨业务后端重写和接收竞争。

文件隐式授权原有 env 用途；新增数据库用途必须由文件 secret_refs 明确授权名称、
稳定路径和目的地。继承凭据也参与目的地检查，不能只检查新增的 *_env 文本。
实现和边界见架构 §3.16、config-secret-policy.ts、runtime-config.ts 及对应测试。

注册明文凭据字段可经数据库直接配置；发布方提供的值可用于指定目的地，继承自
文件的明文仍受原路径和目的地限制。
持久化边界统一 AES-256-GCM 封存，密钥仅来自 `AICR_CONFIG_SECRETS_KEY` 部署环境，
缺密钥即 fail-closed。文件配置同样接受明文但维持"提交库的文件推荐 env 引用"的
建议。明文字段与 `*_env` 互斥；实体 update 省略脱敏字段即保留、null 即清除。
公共发布入口在提交前认证密文；重试与快照恢复比较解密后的内容并复用已有密文。
实现见 config-secret-sealing.ts、config-source.ts 的 carry-over 语义与 §3.16。

### D41：恢复与去重边界

成员按 stream + revision 唯一归属批次，投递 ID 还需按 provider、事件、trigger、workspace、
repo 和 scope 隔离。P4/SVN 的单通知只覆盖所报 revision；同来源合并依赖已收到的覆盖范围。
固定接收截止序号、日历下限和元数据重试预算都必须被调度器实际消费，不能只写入 schema。

执行租约保护存储状态，不能撤销已经发出的 LLM 请求或远端 POST。恢复策略的现行表述见
D50（逐目标发布恢复，2026-09-21）；本条早期"停止自动重放并要求人工核查"的表述已被取代。

编号修正：本条原以 D35 追加，与决策表中 D35（自动提交调度，M15）重复；全仓引用均指向
表内 D35，本条无引用，P8 文档同步时改号为 D41。

### D42：文件显式配置优先与字段级锁（P0/M18）

配置文件是显式声明层，数据库只能补充文件未声明的值：文件实体整体锁定，全局字段按叶子
锁定，父路径写入也必须检查后代锁；数组整体替换。来源合并带逐字段 provenance，来源视图
保留被文件遮盖的数据库字段值（shadowed）；管理 UI 中同名 shadowed 数据库实体只允许删除，
`unset` 只移除数据库 override，文件有效值保持不变。无效实体不能在合并中丢失。
实现见 `packages/core/src/config-source.ts` 与架构 §3.10、§3.15；交付验收见 M18。
显式例外见 D48（共享全局前缀数据库优先）。

### D43：发布协议——revision 文档、CAS head、operationId 幂等与 committed_activating 不回滚（P3/M18、P4–P5/M19）

每次发布生成不可变 revision 文档与审计条目，`ConfigStore.commitChangeset` 的 head CAS 是
唯一线性化点；baseRevision 过期即 `revision_conflict`，绝不静默分叉。`(namespace,
operationId)` 唯一：相同内容重试返回原已提交结果（S03），同 ID 不同内容报
`operation_conflict`；`getConfigOperation` 回答响应丢失后的落库查询（H14）。提交后
snapshot/install 失败返回 `committed_activating`：revision 已持久化，绝不伪装回滚；restore
以当前 head 为父重跑文件锁/引用/凭据检查并发布更高 revision，永不是 head 降级（C12/S07）。
实现见 `packages/core/src/config-publish.ts`、`config-store.ts` 与架构 §3.15–3.16；
交付验收见 M18/M19。

### D44：即时生效不依赖 pub/sub（P4/M19）

配置变更的即时生效由 admission barrier 保证：每次 webhook 接收在鉴权与选路前重读持久
head（H15），副本要么看到新版本、要么不接收工作（失败 503 `config_unavailable`）；不引入
LISTEN/NOTIFY 或任何形式的失效推送。后台 refresh 定时器
（`config_sources.runtime.refresh_interval_seconds`）只加速 generation 切换，永远不替代
barrier；关闭配置 store 会同时停止刷新。实现见
`packages/server/src/runtime-config.ts`、`bootstrap.ts` 与架构 §3.16；交付验收见 M19。

### D45：配置 store 三后端并发等价合同（P2/M17）

SQLite/PostgreSQL/Redis 配置后端（memory 同合同）共享同一 commit-conflict 语义，由
`packages/core/test/config-store-conformance.ts` 参数化锁定：并发 changeset 恰好一个
winner，loser 得到 `revision_conflict`，head 与审计恰好推进一次。实现机制因后端而异：
SQLite 用 `BEGIN IMMEDIATE` 串行化写事务；PostgreSQL 用 per-namespace
`pg_advisory_xact_lock`（`hashtext(namespace)`）加 head 行 `FOR UPDATE`；Redis 在单
hash-tag slot 内用 Lua CAS（不用 WATCH/MULTI，脚本先校验后写入），stale-generation
writer 被 fencing。实现见 `packages/core/src/{sqlite,pg,redis}-config-store.ts` 与架构
§3.14；交付验收见 M17（PG 18.6 实测）、M21。

### D46：首次升级先排空，兼容范围由实际版本对限定（P8/M24）

迁移锁只串行化参与锁协议的操作，不能阻止不认识新协议的旧进程在锁外写入。首次
升级必须停止全部旧实例的 admission/claim、等已接收任务和最终记账结束、确认退出，
再备份和迁移。CLI 的 drained 标记和正常退出共同构成排空证据；超时、SIGKILL 或
Windows 强制结束不能替代。Redis CAS 拒绝过期 generation，不等同于任意旧程序隔离。

MigrationRunner 保存最低 reader/writer 协议与 atomic 事务声明，旧账本缺列按 1/1
解释；协议不足和未知高 schema 均拒绝启动。原始文件格式仍为 1，数据库文档支持
1–2。已验证的历史代码基线固定为 `c5d221c`，其他版本对须追加真实进程证据。
实现与验收见 [架构](architecture.md) §3.14、§3.16 和 [M24](milestones/M24.md)。

### D47：workspace 解析与发布校验的失败封闭边界（2026-09-15 复审/M25）

- 停用语义在 legacy 绑定与 match 规则间一致：停用定义被跳过，但仍占有其
  trigger——没有任何其他规则可绑定该 trigger 时结果为 `no_match`（拒绝新准入），
  绝不落入 `unbound` 首 workspace 回退。首个启用 legacy 绑定仍按原顺序胜出。
- v2 图模式下绝不回退首 workspace：路由选中的 workspace 若无 match 规则或
  legacy 绑定可接纳该来源，准入即抛 `no_route`，与执行期 `layoutForEvent` 一致。
- 发布 prepare 与 generation build 共享同一份 workspace 校验
  （`validateWorkspaceDefinitions`）：matcher/模板/trigger 引用/互斥错误必须在
  prepare 失败；只校验 graph 会让非法配置 commit 后才在 install 失败
  （`committed_activating` + 副本 503）。
- 启用路由指向不存在或停用的 workspace 在发布期即 `invalid_reference`（R03）。
- 管理 API 读侧脱敏与写侧凭据策略使用同一敏感键集：URL userinfo、hash 与凭据
  命名的查询参数脱敏；非凭据查询值保持可见，否则脱敏视图无法原样回写编辑
  （"保存陷阱"）。

实现与回归测试见 [架构](architecture.md) §3.10、§3.15–3.16 与 [M25](milestones/M25.md)。

### D48：共享全局 agent/review/queue 前缀数据库优先（2026-09 管理页面修订）

`agent`、`review`、`queue.workers`、`queue.rate_limit`、`queue.retry`、`queue.dead_letter`
前缀（`DATABASE_PRIORITY_PREFIXES`）按 数据库 > 文件 > 默认值 合并，是 D42 合同唯一
显式例外：共享全局由值班管理员经 UI 调整（超时、并发、评审预算），不应要求改文件再部署。
文件锁对这些前缀豁免，UI 三页保持可编辑并提供"重置数据库配置"（按前缀 unset，回落
文件/默认）。例外只限上述前缀——`queue.kind`/`queue.sqlite` 仍属 bootstrap 信任边界
不可写，其余字段维持文件优先。`queue.retry` 从 bootstrap 固定值改为按 generation 热读取
（与并发/限流一致），这是例外可行的前提。实现见
`packages/core/src/config-source.ts` 与架构 §3.15。

### D49：命名模板与 system prompt 实体（2026-09 管理页面修订）

模板与 system prompt 是数据库实体集合 `templates`（`outputs.templates`）与
`prompts`（`prompts.system`）：map 键即实体名，记录值是整份 markdown 文档字符串。
文档可带 YAML frontmatter，仅作界面元数据（name/description）；实体 id 永远是存储键，
运行时只消费正文。channel `templates.{problem,summary}` 引用模板名（优先于 workspace
目录与内置查找）；workspace `prompt.system_prompt` 引用 prompt 名替换内置基底，
`prompt.extra_system_prompt` 拼接在基底之后。内置模板与内置基底 prompt 永不入库、
不可改，管理 UI 只读展示并提供"复制为新数据库配置"。模板/prompt 文本是展示内容
而非凭据：不参与封存，读取 API 不脱敏。实现见
`packages/core/src/{markdown-document,config-source}.ts`、
`packages/outputs/src/template-engine.ts`（`namedTemplateSource`）、
`packages/server/src/bootstrap.ts`（prompt resolvers）。

### D50：批次逐目标发布恢复——检查点载荷 + 逐渠道回执（2026-09-21，P1）

自动提交批次的 `publication_pending` 不再整体重放：分析完成后把产物（problems/summaries）
序列化进批次检查点，发布过程中逐渠道持久化回执（`pending`/`published`/`failed`/`unknown`）。
有效载荷重入时跳过 LLM/分析并保留原模型用量与费用，全部消息确认 `published` 的渠道不再触碰。
HTTP 4xx（除 408）记 `failed`；无响应、408、5xx 与部分发送的渠道记 `unknown`。
`buffered`/仅本地收集的结果记 `pending`，不视为已发送。发送前检查租约，回执保存后才处理
下一渠道；持久化失败立即停止。payload、回执与记账总计超过 1 MiB 时清除旧载荷并整体重放；
损坏载荷拒绝执行。Redis 对检查点使用不透明 JSON，避免空数组被 Lua 转成对象。
update_existing PR review 与指纹 reconcile 降低重复，但不构成远端和本地的原子事务。
自动终态恢复只增加一次执行机会，部分报告和内部 HTTP 重试仍可能重复多条消息；人工核查依据是
批次列表 API 的 `publications` 字段。实现见 `packages/core/src/auto-commit-store.ts`
（`BatchExecutionCheckpoint.publication`）、`packages/server/src/auto-commit-runtime.ts`
与 `packages/server/src/bootstrap.ts`（复合 publisher 恢复钩子）。

### D51：自动批次远端对账——写入前日志与 publisher 协议（2026-09-22）

`publication.remote.version=1` 逐 HTTP 报告写入持久化意图和精简回执，按批次、渠道、消息序号、
目标与请求内容生成身份。Git 平台按正文标记查询，状态更新/删除读取原对象；飞书应用复用有
时限的 UUID。未知 webhook、查询失败/缺失/歧义、超期 UUID 不自动重发。D50 的逐渠道恢复
继续负责整体完成判断，远端协议补足回执丢失窗口，仍不承诺 exactly-once。
人工重排保留远端日志，沿用既有恢复次数预算；有日志的检查点超限停止，禁止退化为盲目全量
发布。实现：`packages/outputs/src/publication-journal.ts`、server executor/composite 与三后端
manual Retry。合同见[输出渠道](../output-channels.md#automatic-commit-batch-publication)，
证据见 [M33](milestones/M33.md)。

## 维护规则

- 如果某条决策只影响已完成阶段的历史说明，优先更新相关 `milestones/*.md`。
- 如果某条决策仍约束当前实现，应同步更新 `Plan.md` 摘要、`docs/ai/architecture.md` 或专题文档。
- 当代码已经成为更精确的真源时，文档应指向实现，而不是重新复制实现细节。
