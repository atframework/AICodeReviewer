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

## 维护规则

- 如果某条决策只影响已完成阶段的历史说明，优先更新相关 `milestones/*.md`。
- 如果某条决策仍约束当前实现，应同步更新 `Plan.md` 摘要、`docs/ai/architecture.md` 或专题文档。
- 当代码已经成为更精确的真源时，文档应指向实现，而不是重新复制实现细节。
