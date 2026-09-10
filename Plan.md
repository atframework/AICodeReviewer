# AICodeReviewer 路线图

本文件只记录尚未完成的工作及其验收条件。稳定合同见
[架构](docs/ai/architecture.md)，交付历史见 [里程碑索引](docs/ai/index.md)。
代码、配置和完整验证要求以 [AGENTS.md](AGENTS.md) 及对应实现为准。

## 1. 当前状态

M0–M15 的核心交付已归档；待验收的外部场景与预留扩展列在下文，不能据此宣称已全覆盖。
自动提交调度的跨通知合并、三后端存储和恢复边界见
[M15](docs/ai/milestones/M15.md)，多源上下文聚合见 [M14](docs/ai/milestones/M14.md)。

2026-09-10 已推进的本地验收：真实 svnserve + post-commit hook 到持久调度、
模型目录 Redis 新连接重载，以及部署配置/双语自动提交示例的 schema 校验。
记录与复现条件见 [本地验收](docs/ai/milestones/local-priority-queue.md)。

## 2. 可本地推进的下一步

下列工作不以获得远端服务凭据为前提；实现前仍需确定恢复语义和范围。

| 优先级 | 工作 | 本地产物与验收 | 边界 |
| --- | --- | --- | --- |
| P1 | 自动批次逐目标发布恢复 | 先梳理 publisher 能力矩阵；设计持久目标回执及状态转换；覆盖部分成功、响应丢失、租约过期与重入调用次数 | 当前仅完成检查点可恢复本地记账；未知 POST 结果不得自动重发。远端对账另行验收 |
| P1 | dead 批次的管理与人工恢复 | 定义鉴权、审计和 CAS 操作；区分本地记账重试与可能重复远端副作用的操作；用三个存储后端验证 | dead 目前会占住 stream；不得以清空成员归属或重新组批作为恢复办法 |
| P2 | 扩展配置示例校验 | 在现有 config-examples 测试上覆盖更多独立命名空间片段，补错误字段/失效引用的阴性场景 | 当前自动验证完整部署配置和 README/双语队列页的自动提交示例；其他片段仍需人工核对 |

不把单元测试或本地服务通过写成生产集成验收通过。完成一项后将证据移入对应里程碑，
从本表删除，不累积完成清单。

## 3. 依赖外部环境的验收

| 场景 | 已有本地证据 | 仍需的条件与验收 |
| --- | --- | --- |
| GitLab 真实仓库端到端流程 | 适配器、webhook 与输出合同测试 | GitLab 实例、测试仓库、token、webhook 权限；验证真实入站与发布 |
| SVN 部署环境 | file:// 仓库及本机 svnserve、认证 HTTP hook、SQLite 调度、真实 diff | 目标服务器上的 hook 账户/PATH、网络 ACL，以及实际使用的 HTTP(S)/认证方式 |
| Redis 部署环境 | 自动调度和模型目录均已通过本机真实 Redis | 仅部署特定的 Redis 版本、ACL/TLS、网络中断及持久化配置需要现场验证 |
| GitHub App pull_request 生产路径 | push 已签收，PR token 注入有单测 | 目标仓库自然出现 PR 后核验入站、分析和发布；不为验收代用户创建 PR |
| CI 真实 LLM benchmark | 6 个 eval fixtures 的离线校验已入 CI | CI secrets、provider 凭据和明确调用预算 |
| 自动批次远端对账 | 执行检查点与未知结果保护；逐目标协议待实现 | 对应 publisher 的查询/幂等协议及测试目标；在本地协议实现后验收 |

## 4. 预留扩展

| 项目 | 当前状态 | 启动条件 |
| --- | --- | --- |
| k8s_pod sandbox | 只有明确报错的预留实现 | 部署需求、客户端依赖方案与可用 Kubernetes 集群 |
| firecracker sandbox | 只有明确报错的预留实现 | 隔离需求、Firecracker 二进制和 API socket 环境 |

这两项是产品范围选择，不能仅因能够编写 mock 就视为可完成的本地任务。
跨 workspace 知识迁移、版本 bump 和 git tag 不在当前范围。

## 5. 文档入口

- [AI 文档索引](docs/ai/index.md)：架构、决策、交付历史和技能入口。
- [输出合同](docs/output-channels.md)：发布策略和自动批次恢复边界。
- [示例与部署](example/README.md)、[Podman](docs/podman.md)：公共使用说明。
- [文档站交付记录](docs/ai/milestones/M11.md)：文档工程边界、六道校验和发布历史。

执行中的任务资料放在 docs/superpowers/specs/ 与 docs/superpowers/plans/；完成且稳定结论
已迁移后删除。不要把稳定架构、整份里程碑表或验证命令表复制回路线图。
