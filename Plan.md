# AICodeReviewer 路线图

这里只记录未完成工作及其验收条件。实现合同见[架构](docs/ai/architecture.md)，
交付与历史验证见[里程碑索引](docs/ai/index.md#里程碑归档)；
本轮临时服务验收见 [M29](docs/ai/milestones/M29.md)。
历史阶段的局部失败、跳过和固定版本限制不因归档精简而取消。

## 1. 可本地推进的下一步

| 工作 | 验收条件 | 边界 |
| --- | --- | --- |
| P4/SVN 辅助仓库物化 | 用真实服务驱动 context_repositories 物化、revision/内容核验、失败清理与 agent 只读挂载 | M14 只有物化合同测试；已有主仓库 diff/hook 测试不能替代辅助仓库链路。临时服务可在 WSL 隔离运行 |
| GitLab 真仓库端到端 | 固定镜像版本，临时用户/仓库/token/webhook；真实 push/MR 筛选→持久入队→发布，核验出站目标与身份 | WSL/Podman 技术可行；按官方内存要求单独串行安排，见[服务验收](docs/testing-services.md)。LLM 可用确定性替身，但不能据此声称模型质量通过 |
| 自动批次远端对账 | 按 publisher 定义查询/幂等协议，覆盖远端已写入但本地回执丢失、部分发布与恢复次数 | D50/M28 已有逐渠道续发；协议设计仍未完成。Gitea 可本地验收其分支，其他渠道需各自测试目标；不承诺 exactly-once |

完成后将证据移入里程碑并删除对应待办。WSL 临时服务使用独立目录、回环端口、
资源上限与退出清理，结束后核对容器、数据和本轮镜像，无全局清库或 prune。

## 2. 依赖目标环境的验收

| 场景 | 尚缺证据 | WSL/Podman 能覆盖的部分 |
| --- | --- | --- |
| 飞书自建应用与成员匹配 | 应用发送/群成员/通讯录权限；来源群≠接收群、重名/外部成员/字段不可见、刷新和真实 @；获准候选资料及预算下的误匹配/拒答 | 可测协议替身；不能替代租户权限和身份模型质量，见[接入指南](docs/site/src/content/docs/zh-cn/integrations/im-bots.md#飞书自建应用) |
| 跨 workspace 并发与保留策略 | 部署重启恢复、Events 标签、YAML/DB 保留策略及重置，既有汇总不变 | 本地并发/恢复/清理可测；自然 P4/GitHub 重叠记录不等于公网事件重放，历史 queued 不是当前队列数量 |
| 国内 LLM 预设与 Anthropic 接入 | 合用途的账户、预算和目标 CLI 版本；鉴权、模型权限、计费池、限流 | 请求/配置产物可测；不能代替付费账户调用 |
| GitHub/Gitea issue 指派 | GitHub 真账号权限/邮箱关联/不可指派用户；目标 Gitea 版本与权限策略 | Gitea 1.25.4 的真实本地发布/assignees 与失败边界见 M29；不推广为 GitHub、Forgejo 或其他 Gitea 版本验收 |
| 数据库凭据部署 | 副本同主密钥/退役密钥；真实调用、轮换后重启及旧任务恢复 | 本地加密/恢复可测；临时服务凭据不能证明生产凭据有效 |
| SVN 部署环境 | hook 账户/PATH、ACL、实际 HTTP(S)/认证 | 本地 svnserve/hook 已通过；可容器化复验，不能代替目标网络 |
| Redis 部署环境 | 目标版本、ACL/TLS、中断与持久化策略 | 可隔离模拟 ACL/断网/重启，普通/OOM 必须独立实例；已有本机真实服务证据 |
| PostgreSQL 部署环境 | 目标版本、角色权限、TLS/网络 | 可隔离验证迁移与权限，低权限测试需 CREATE ROLE；已有本机真实服务及固定旧版本矩阵 |
| GitHub App pull_request 生产路径 | 等自然 PR 后核验入站、分析、发布 | 本地 token 注入测试不能替代生产；不代用户创建 PR |
| PR/MR 避峰恢复生产路径 | 窗口外自然事件持久化与下一窗口恢复运行证据 | 已有七个窗口边界/恢复隔离证据；不主动制造分析或通知 |
| CI 真实 LLM benchmark | CI secrets/provider 凭据、调用预算 | 六个 fixture 离线校验已入 CI；容器不提供模型质量证据 |
| 其他部署版本升级 | 固定实际旧源码/驱动重跑矩阵；首次升级确认全部旧实例退出 | M24 只覆盖 c5d221c 模块与当前驱动；迁移锁不能代替旧实例排空 |

## 3. 预留扩展

| 项目 | 启动条件 |
| --- | --- |
| k8s_pod / firecracker sandbox | 明确隔离需求、客户端方案及对应集群/二进制/socket；当前只有明确报错的预留实现 |
| Agent 查询成员目录 | 先定义按渠道授权、候选数限制与脱敏返回；宿主 ChannelUserDirectory 的整份名单不进入评审 MCP |

queue.workers.lock_ttl_seconds、dead_letter.* 等 schema 预留字段不算运行时能力。
跨 workspace 知识迁移、版本 bump/tag 不在当前范围。
维护入口：[文档目录](docs/README.md)、[验证基线](docs/ai/AGENTS.repository-baseline.md)、
[示例](example/README.md)。已完成执行资料按根 AGENTS.md 退役，不在路线图复制合同或日志。
