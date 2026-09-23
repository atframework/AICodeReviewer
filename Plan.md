# AICodeReviewer 路线图

只保留未完成工作及完成条件；已完成证据见[里程碑](docs/ai/index.md#里程碑归档)，
最新验收与用户指定范围见 [M31](docs/ai/milestones/M31.md)。
P4 共享账号的飞书误 @ 修复见 [M32](docs/ai/milestones/M32.md)。
自动批次远端对账开发与验证见 [M33](docs/ai/milestones/M33.md)。
GitLab 固定版本端到端验收见 [M34](docs/ai/milestones/M34.md)。

## 待完成

当前无待完成项。

临时服务、环境变量门控和退出清理按[验收指南](docs/testing-services.md)执行；
本地替身不能作为模型质量或生产验收证据。

## 按需扩展（未纳入当前交付）

- `k8s_pod` / `firecracker` sandbox：明确隔离需求和运行环境后实现，当前为报错占位。
- Agent 查询成员目录：先定义按渠道授权、候选数量与脱敏返回；不将整份目录交给评审 MCP。
- `queue.workers.lock_ttl_seconds`、`dead_letter.*`：仅 schema 预留，没有运行时能力。

跨 workspace 知识迁移、版本 bump/tag 不在范围。任务完成后归档证据并删除对应待办；
文档精简不取消历史失败、跳过或固定版本限制。
