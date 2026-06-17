# 稳定决策索引

这份文档收纳长期有效、会影响实现和审查方式的决策记录。
原先散落在 `Plan.md` 的 D1-D27 已搬到这里，`Plan.md` 只保留与当前执行顺序有关的摘要。

## 使用方式

- 先看 `Plan.md` 了解当前里程碑和执行优先级。
- 当任务涉及稳定取舍、历史约束或“为什么这样设计”时，再按需读取这里。
- 若实现变更会推翻这里的某条决策，应同步更新相关文档、示例和测试。

## 决策表

| ID | 议题 | 决策 | 当前落点 |
| --- | --- | --- | --- |
| D1 | 部署形态 | 单容器自托管为主，Helm chart 为可选；常驻进程监听 HTTP 端口接收所有 VCS 的 webhook / trigger script POST。 | `Plan.md` §11、`deploy/Dockerfile`、`deploy/deploy.sh` |
| D2 | 核心语言 | 选 TypeScript（Node 20 / Bun 友好），与目标 Agent CLI、MCP 与 `ai-sdk` 生态对齐。 | `Plan.md` §2.1 |
| D3 | AST / 语法服务 | 当前不内置；通过 Context Provider 插件接口预留扩展位。 | `docs/ai/architecture.md` §10.1 |
| D4 | 审批流 | 当前不实现；通过 Output Pipeline 中间件 + Run 状态机扩展预留口子。 | `docs/ai/architecture.md` §10.2 |
| D5 | Workspace 目录布局 | 使用扁平、自包含布局 `workspaces/<workspace_id>/{source,prompts,skills,memory,templates,...}`。 | `Plan.md` §2.2、`docs/ai/architecture.md` §3.10 |
| D6 | VCS 拉取深度 | 默认 `--depth=100`，缺 base 时在闸门控制下做 deepen。 | `docs/ai/architecture.md` §3.2 |
| D7 | 压缩触发阈值 | 默认 `trigger_tokens: 131072`，并叠加 `max_input_ratio: 0.6`。 | `docs/ai/architecture.md` §3.3 |
| D8 | LLM 限流策略 | 单次调用层使用 bounded rate-limit retry，与队列层 retry 解耦。 | `docs/ai/architecture.md` §3.5 |
| D9 | 模板与 @-mention | 输出走 Handlebars 模板；@-mention 通过作者解析管线与黑名单保护。 | `docs/output-channels.md`、`docs/ai/architecture.md` §3.9 |
| D10 | 沙箱引擎 | docker 与 podman 平等支持，`sandbox.engine: auto` 自动检测。 | `docs/podman.md`、`docs/ai/architecture.md` §3.8 |
| D11 | 文档自校验 | `Plan.md` 与 `docs/*.md` 统一走 markdownlint。 | `Plan.md` §7、`.markdownlint.json` |
| D12 | 思考强度 | `ModelSpec.thinkingLevel` 作为统一抽象，adapter 再翻译到各 provider。 | `docs/ai/architecture.md` §3.7.3 |
| D13 | 压缩阈值参考模型 | 阈值以当代长上下文模型为参考，不按单一供应商硬编码。 | `docs/ai/architecture.md` §3.3 |
| D14 | workspaces 命名空间 | 强制 `cache / defaults / instances.<id>` 三段式。 | `Plan.md` §3.10、`packages/core/src/config.ts` |
| D15 | Forgejo 支持 | Forgejo 与 Gitea API 兼容，复用同一 adapter。 | `docs/ai/architecture.md` §3.2、`docs/output-channels.md` |
| D16 | 仓库 AI 维护资产 | `AGENTS.md` 是唯一常驻指令源，`.agents/skills/` 是 canonical skill 源。 | `AGENTS.md`、`docs/ai/architecture.md` §3.6 |
| D17 | 默认提示词分层与 repo-local AI 资产加载 | system prompt 仅保留稳定硬规则，repo-local `AGENTS.md` / path instructions / skills 按需归一化加载。 | `docs/prompt-research.md`、`docs/ai/architecture.md` §3.6.1、§4 |
| D18 | 反向代理支持 | TLS 由代理终止，通过 `trust_proxy`、`path_prefix`、`base_url` 处理转发与回调。 | `Plan.md` §11、`packages/server` |
| D19 | Trigger 非阻塞语义 | `/webhooks/*` 与 `/triggers/*` 可配置 async，鉴权通过后立即返回 `202 + runId`。 | `docs/ai/architecture.md` §3.1、`packages/server/src/index.ts` |
| D20 | P4 trigger 职责边界 | trigger 脚本只发最小 metadata；分析 workspace 不得回退成提交者 workspace。 | `docs/ai/architecture.md` §3.1、§3.2、`example/p4-trigger.sh` |
| D21 | P4 凭据与过滤语义 | 支持非交互 `p4 login` 后重试；不含 `/` 的 glob 走 basename 语义。 | `docs/ai/architecture.md` §3.2、`packages/vcs/src/p4.ts` |
| D22 | Problem 报告契约 | MCP problem 保持最小稳定字段，`message` 说明问题，`suggestion` 给出修复方式。 | `docs/output-channels.md`、`packages/mcp-output/src/index.ts` |
| D23 | 部署验收 agent | 部署测试以 Kilo Code 作为首要验收入口。 | `example/README.md`、`development/README.md` |
| D24 | 提交归因契约 | attribution 必须来自事件、provider API 或只读 VCS 工具验证，不得猜测。 | `docs/ai/architecture.md` §3.2、§3.9 |
| D25 | 多源上下文 | 默认保持 `primary` 单仓行为，辅助仓库与子仓库显式访问。 | `docs/ai/architecture.md` §3.2、§3.10 |
| D26 | Agent Runtime Bundle | 每次 run 在隔离 `agent/` 目录物化 LLM、MCP、instructions、skills、env 与 manifest。 | `docs/ai/architecture.md` §3.6.3、§3.7 |
| D27 | 无问题输出策略与目标链接 | `no_problems.action` 按全局 → channel → workspace 覆盖，模板用 `target` 上下文渲染不同目标类型。 | `docs/output-channels.md`、`docs/ai/architecture.md` §3.9.1、§3.10 |
| D28 | 统一基础存储配置 | 数据库、缓存和对象存储使用顶层 `storage` 命名空间，供观测、队列、artifact、runtime 等能力复用。数据库默认 `/app/data/aicr.sqlite` SQLite + Drizzle；Postgres 字段为未来集中化持久后端预留，当前 runtime 必须显式拒绝未实现后端而不是静默回退。Redis 只做缓存/session/短期索引，不能作为唯一历史统计存储；对象存储默认 filesystem，预留 AWS S3、MinIO、RustFS 等 S3-compatible 后端。Prometheus/OTel/run snapshot 只是外部观测或审计补充；project 维度基于 workspace + trigger + repo，并对已从配置删除的项目执行 soft delete + 级联 GC。 | `Plan.md` §3.10-§3.11、`docs/ai/architecture.md` §3.10-§3.11.1 |
| D29 | Per-workspace prompt 覆盖与强制技能 | workspace 级 `prompt.base_system_prompt_file` 覆盖全局 system prompt 模板；`prompt.force_skills` 按 skill 名称强制激活，忽略 `Applies To` glob 过滤。配置合并遵循全局 → defaults → instance 分层。 | `docs/ai/architecture.md` §3.10.1、`packages/core/src/config.ts` |
| D30 | Reflection memory 存储 | `reflectionMemory` 表按 workspace 隔离，支持 TTL 过期和条目上限压缩。写入在 review 完成后，读取在 review 开始前注入 `memoryHints`。当前仅基础设施已就绪，写入/读取与 review lifecycle 的集成待实现。 | `docs/ai/architecture.md` §3.12、`packages/store/src/reflection.ts` |
| D31 | 模型元数据来源与缓存回退 | 模型参数（上下文窗口、最大输入/输出、价格、工具调用/视觉/搜索/推理 effort/mode/interleaved reasoning/结构化输出/温度/stream/logprobs/请求参数支持/原生工具能力）统一以 models.dev `api.json` 为来源，按 `<provider>/<model>` 解析。刷新缓存默认存 SQLite（store keyed 表 `model_catalog`，按模型主键点查，复用 `storage.database`），Redis 结构化后端为预留项（当前显式拒绝，待引入客户端），memory 仅用于测试/临时开发；整份 `api.json` 只在刷新时解析一次并逐行 upsert，读路径不全量解析 JSON。远端刷新按 source-level `refresh_interval_hours`（默认每天）判定，未知模型不会在周期内反复触发远端请求；拉取失败按“过期本地行 → 打包期从 `anomalyco/models.dev` 拉取并签入的只读保底快照（仅按需 seed 一次）”回退。catalog 元数据合并进 `ModelSpec` 时**用户显式配置永远优先**，缺失才填补，绝不臆造；lifecycle/provider/运营 metadata（display name、family、knowledge/release/status、provider npm/env/API URL/aliases/多平台 model IDs、apiProtocol、latency、priority tier、rate/concurrency/throughput hints 等）只用于映射、告警、dashboard 和审计，不直接发给模型 API。Agent 配置转换按工具区分：opencode 已知 provider 走原生 models.dev、自定义 provider 注入 `limit`/`cost`；Kilo/Roo 自定义 OpenAI-compatible 注入 `contextWindow`/`maxTokens`/`supportsImages`/价格；Claude Code 由 `maxOutputTokens` 派生 `ANTHROPIC_MAX_TOKENS`、其余委托内置目录；Copilot CLI 无注入面，manifest 显式降级。 | `Plan.md` §3.13、§8.2 M10、`docs/ai/architecture.md` §3.13、`packages/core/src/config.ts`（`llm.model_catalog` schema）、`packages/store/src/schema.ts` + `database.ts`（`model_catalog`/`model_catalog_source` 表 + 迁移 `003_model_catalog`）、`packages/store/src/model-catalog.ts`（repo）、`packages/llm/src/model-catalog.ts`（纯解析/归一化）、`packages/llm/src/gateway.ts`（`estimateCost` 真实价格）、`packages/server/src/model-catalog-service.ts`（刷新/回退/充实）、`packages/server/src/bootstrap.ts`（编排）、`packages/agents/src/model-metadata.ts`（adapter 注入） |

## 维护规则

- 如果某条决策只影响已完成阶段的历史说明，优先更新相关 `milestones/*.md`。
- 如果某条决策仍约束当前实现，应同步更新 `Plan.md` 摘要、`docs/ai/architecture.md` 或专题文档。
- 当代码已经成为更精确的真源时，文档应指向实现，而不是重新复制实现细节。
