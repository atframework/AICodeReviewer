# AI 文档导航

从任务涉及的代码开始。下面只用于定位资料，不要求先读路线图、整份架构或历史。
长文先搜索标题/符号，再读对应章节；仅当当前约定解释不足时补充相关决策或里程碑。
设计文档和双语用户说明的统一入口见[文档目录](../README.md)。

| 任务 | 首选实现与参考 |
| --- | --- |
| 当前待办与验收边界 | [Plan.md](../../Plan.md)：既有 IM 待办与 Slack/Discord/Telegram 接入；[路线图](#路线图)；Workspace 动态配置规则见架构 §3.10、§3.14–3.16 |
| Config / workspace / model groups | `packages/core/src/config.ts`、server bootstrap；[架构 §3.10](architecture.md#310-配置体系)、[配置坑点](pitfalls/AGENTS.config-and-state.md) |
| Webhook / 调度 / 去重 / PR 延期 | server runtime/scheduler/deferral-manager；[架构 §3.1](architecture.md#31-触发器与-reviewevent-归一化)、[调度坑点](pitfalls/AGENTS.scheduling.md) |
| VCS / 多源上下文 / GitHub App | `packages/vcs/src/`、server credential wiring；[架构 §3.2](architecture.md#32-vcs-adapter-与-scoped-fetch)、[VCS 坑点](pitfalls/AGENTS.vcs.md) |
| Prompt / agent / MCP / sandbox | core prompt-manager、agents runtime-bundle、mcp-output；[运行时 skill](../../.agents/skills/agent-runtime-integration/SKILL.md)、架构 §3.6–3.8 |
| 输出 / 模板 / IM / 问题生命周期 | outputs、server bootstrap；[输出渠道规范](../output-channels.md)、[输出 skill](../../.agents/skills/output-channel-contracts/SKILL.md) |
| Store / 用量 / 实时面板 | store、server live-runs/observability；[架构 §3.11](architecture.md#311-run-状态与可观测性) |
| 模型目录 / 压缩 / reflection | llm、server catalog-service、core reflection；架构 §3.3、§3.5、§3.12–3.13 |
| 验证 / 工具 / 公开文档站 | [基线门禁](AGENTS.repository-baseline.md)、[文档 skill](../../.agents/skills/docs-writing-style/SKILL.md)、[构建坑点](pitfalls/AGENTS.build-and-docs.md) |
| AI 提示词与 skills 维护 | [维护 skill](../../.agents/skills/ai-agent-maintenance/SKILL.md)、[技能索引](../../.agents/skills/README.md)、[来源地图](source-index.md) |
| 易回归问题 / 设计取舍 | [坑点地图](AGENTS.known-pitfalls.md)、[决策索引](decisions.md)，按议题选择 |
| 默认评审 prompt 依据 | [设计依据](../prompt-research.md)、[实际模板](../../prompts/system/code-reviewer.system.md) |
| 部署 / 用户示例 | [部署 skill](../../.agents/skills/remote-deployment/SKILL.md)、[Podman](../podman.md)、[示例](../../example/README.md) |

## 路线图

托管问题生命周期的长期验收需覆盖多次部分修复、累计进度保留、跨提交再次报告
已修复项（包括本轮没有新修复项）、计入 Resolved 前缀的临界正文降级、最终正文与关闭状态一致，以及下一次自然提交的
逐指纹复核日志。单次人工修复和健康检查不能
替代自然流量验收；规则见[输出规范](../output-channels.md)。

Slack、Discord、Telegram 的本地实现已落地；待完成专用账户上的公开 HTTPS 回调、
真实命令、报告显示、长任务终态与回滚验收。按
[执行步骤](../design/slack-discord-telegram-execution.md)和
[验收矩阵](../design/slack-discord-telegram-acceptance.md)控制调用预算并保留未覆盖边界。
真实平台验收需核验实际运行容器的 API 访问与目的地 readiness，再验证命令和报告；公网健康检查不能替代这些证据。
命令无回复时需核验客户端实际 slash 调用、平台命令定义和回调状态；Slack/Discord 的 inline 初始回复与 Telegram 回复 outbox 分开验收。
Slack 的 HTTP 命令验收需确认 Socket Mode 已关闭、命令 Request URL 可编辑且与回调一致；导入生成的 manifest 不能代替该检查。
SDC-13-live：Slack Socket Mode 需补跨刷新周期 help/chat-id ACK 与控制台/HTTP 回切；
回切时核验应用级开关与接收器配置一致，并验证保留的 HTTP URL。实际命令回复与连接状态分列验收。
真实命令可用性需跨越 readiness 缓存刷新周期验证；一次成功的签名探针不能替代连续接收证据。
平台验收还需在并发命令和刷新重叠时观察 ACK 时限与实际回复；本地配置读取超时、刷新合并和代码块保真用例不能替代客户端证据。
报告显示待复验单行问题标题、分节与空行、内部标记隐藏、Slack 围栏和 Telegram 嵌套实体；检查含代码的长报告在实际客户端的截断呈现。
真实平台还需核验 issue 成功后的简要通知、issue 失败时的全文回退、恢复链接及截断后作者提醒；
确认终态采用实际 flush 回执，并验收发送前五次退避耗尽与未知发送不重发。
作者提醒待补真实平台验收：核对映射/目录中的人类用户 ID、Slack 实际 Bot scopes 与频道成员资格、
Discord Server Members Intent 和目标可见性、Telegram 用户 ID 与隐私条件；验证精确 @、歧义省略、
权限撤销和长报告截断后的通知。真实目录读取、宿主本地构造的提及 payload 和健康检查不能替代客户端通知证据。
稳定配置与恢复约定见[接入规范](../design/slack-discord-telegram.md)，外部接口见
[官方来源](sources/slack-discord-telegram.md)，使用文档见[目录](../README.md)。
指定群/频道的 `conversation_users` 批量授权还需补真实成员变化与 status 归属证据；
它使用平台认证的命令上下文，不查询当前成员目录，退群不自动取消已接受任务。
精确 `repo_ref` 旧报告路由按既有配置中的仓库核验映射及其他组织隔离；本次不扩展组织仓库清单或 GitHub 安装权限。
配置清单不代表平台授权，真实审查结果仍需单独验证。

IM 任务进度和验收条件见 [Plan.md](../../Plan.md)，接口边界见
[IM 实施规范](../design/im-implementation-spec.md)，外部协议见[来源记录](sources/im-integrations.md)。
主要未完成项：

- IM-11、IM-17：补原平台动作/范围目录在真实重启组合中的授权证据；命令持久 readiness 和当前授权复查已有实现。
- IM-14：补队列多进程交接与共享并发许可的组合证据；queued ID 复用、忙 workspace 排除、执行窗口和阶段次数/IO 退避已有本地断言。
- IM-13、IM-19、IM-20：核验 VCS 家族与范围、真实重启及多连接竞争，完成逐项验收证据映射；
  现有测试通过不代表整个验收矩阵完成。

## 路线图：运行控制与队列治理（RUN，2026-10）

稳定约定见[架构 §3.1.1、§3.11](architecture.md)，已完成事项与验证边界见
[M36](milestones/M36.md)、[M37](milestones/M37.md)。后续工作：

- RUN-1：为自动提交排队超时增加按输出渠道推送的通知。当前通过日志、
  run 行 `timeout` 与 Events `timeout` 呈现；IM 请求已复用通知 outbox。
- RUN-2：为缺少完整事件的历史记录设计受控的事件补录；新记录支持保留
  PR/MR、fork 和提交区间重评，不能从旧 run 的 head 猜测原目标。
- RUN-3：将管理端重评接受记录转为持久化待执行载体。当前 202 返回新
  runId，可在 Runs/Live 查询并取消，但进程内等待任务重启后不会自动续跑，
  会由启动清扫标记中断；不得宣称该入口具备跨重启执行保证。
- RUN-4：将取消控制面扩展到尚未封存的 push 收据和成员。当前批次 Cancel 仅覆盖
  已封存批次；取消长 push 积压须同时检查未封存成员，不能据批次数宣称清空队列。
  需要持久禁止取消收据再次展开，并覆盖分页、并发封存和重复投递。

## 前瞻扩展（未纳入当前交付）

以下候选项未纳入当前交付。

- `k8s_pod` / `firecracker` sandbox：明确隔离需求和运行环境后实现，当前为报错占位。
- Agent 查询成员目录：先定义按渠道授权、候选数量与脱敏返回；不将整份目录交给评审 MCP。
- `queue.workers.lock_ttl_seconds`、`dead_letter.*`：仅 schema 预留，没有运行时能力。

跨 workspace 知识迁移、版本 bump/tag 不在范围。

## 里程碑归档

归档简述问题、解决方式和必要验收限制；当前行为以源码和主题规范为准。

| 里程碑 | 主题 |
| --- | --- |
| [M0](milestones/M0.md) | 项目骨架 |
| [M0.5](milestones/M0.5.md) | 默认评审提示词 |
| [M1](milestones/M1.md) | Git 与单模型评审闭环 |
| [M2](milestones/M2.md) | Agent CLI 与沙箱 |
| [M3](milestones/M3.md) | 大差异与失败恢复 |
| [M4](milestones/M4.md) | 多渠道输出与作者提醒 |
| [M5](milestones/M5.md) | 多 Agent 与 MCP |
| [M6](milestones/M6.md) | 跨 VCS 评审 |
| [M7](milestones/M7.md) | Workspace 定制与记忆 |
| [M8](milestones/M8.md) | 可观测性与离线评估 |
| [M9](milestones/M9.md) | 部署交付 |
| [M10](milestones/M10.md) | 模型元数据 |
| [M11](milestones/M11.md) | 双语用户文档站 |
| [M12](milestones/M12.md) | GitHub App 认证 |
| [M13](milestones/M13.md) | pi 与 oh-my-pi 接入 |
| [M13.1](milestones/M13.1.md) | Agent 搜索与凭据隔离 |
| [M14](milestones/M14.md) | 多源上下文 |
| [M15](milestones/M15.md) | 自动提交调度 |
| [M16](milestones/M16.md) | PR/MR 执行时段与延期 |
| [M17](milestones/M17.md) | 配置存储与迁移 |
| [M18](milestones/M18.md) | 配置合并与发布 |
| [M19](milestones/M19.md) | 运行时配置与管理 API |
| [M20](milestones/M20.md) | 配置管理页面 |
| [M21](milestones/M21.md) | 集成测试与 SVN 修复 |
| [M22](milestones/M22.md) | 配置组合验收 |
| [M23](milestones/M23.md) | 动态配置复审 |
| [M24](milestones/M24.md) | 跨版本迁移与停机排空 |
| [M25](milestones/M25.md) | Workspace 与动态配置复审 |
| [M26](milestones/M26.md) | 配置版本生命周期复审 |
| [M27](milestones/M27.md) | 管理页面与文档实体 |
| [M28](milestones/M28.md) | 逐渠道发布恢复与配置示例校验 |
| [M29](milestones/M29.md) | 文档精简与 Gitea 验收 |
| [M30](milestones/M30.md) | 真实服务验收与 SVN 物化修复 |
| [M31](milestones/M31.md) | 验收范围与部署验证 |
| [M32](milestones/M32.md) | P4 提交者归属 |
| [M33](milestones/M33.md) | 自动批次远端对账 |
| [M34](milestones/M34.md) | GitLab 端到端验收 |
| [M35](milestones/M35.md) | 品牌图标与静态资源 |
| [M36](milestones/M36.md) | 运行控制与队列治理 |
| [M37](milestones/M37.md) | Git push 完整评审单元 |
| [M38](milestones/M38.md) | IM 回调重新评审与恢复修复 |
| [M39](milestones/M39.md) | Slack、Discord、Telegram 本地接入 |
| [M40](milestones/M40.md) | 社交 IM 复审与依赖、模型快照维护 |
| [P0–P15](milestones/local-priority-queue.md) | 本地优先执行队列 |

归档规则见根 [AGENTS.md](../../AGENTS.md)；详细过程由 Git 历史追溯。
