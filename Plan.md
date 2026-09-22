# AICodeReviewer 路线图

只保留未完成工作及完成条件；已完成证据见[里程碑](docs/ai/index.md#里程碑归档)，
最新验收与用户指定范围见 [M31](docs/ai/milestones/M31.md)。

## 待完成

| 工作 | 剩余完成条件 |
| --- | --- |
| GitLab 端到端验收 | 固定版本真仓库的 push/MR 筛选→持久入队→发布，核对目标与身份；补窗口外自然 MR 持久化、下一窗口恢复的生产证据 |
| 自动批次远端对账开发 | 定义各 publisher 的查询/幂等协议，覆盖远端写入后本地回执丢失、部分发布和恢复次数；现有逐渠道续发不等于远端对账，不承诺 exactly-once |

临时服务、环境变量门控和退出清理按[验收指南](docs/testing-services.md)执行；
GitLab 按资源要求单独安排，本地替身不能作为模型质量或生产验收证据。

## 按需扩展（未纳入当前交付）

- `k8s_pod` / `firecracker` sandbox：明确隔离需求和运行环境后实现，当前为报错占位。
- Agent 查询成员目录：先定义按渠道授权、候选数量与脱敏返回；不将整份目录交给评审 MCP。
- `queue.workers.lock_ttl_seconds`、`dead_letter.*`：仅 schema 预留，没有运行时能力。

跨 workspace 知识迁移、版本 bump/tag 不在范围。任务完成后归档证据并删除对应待办；
文档精简不取消历史失败、跳过或固定版本限制。
