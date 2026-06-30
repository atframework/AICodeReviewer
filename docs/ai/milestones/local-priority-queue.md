# 本地优先执行队列归档

## 范围

这份归档记录此前从 `Plan.md` 拆出的 P0-P7 本地闭环任务。它们的共同标准是：不依赖真实 GitLab / SVN / Redis / Kubernetes / CI 权限，可通过本地单元测试、集成测试、typecheck、build 或 markdownlint 验证。

## 已完成任务

| 项 | 落点 | 归档位置 |
| --- | --- | --- |
| P0 Streamable HTTP MCP transport | `@aicr/mcp-output --transport http`；runtime bundle 默认仍使用 stdio | `M5.md` |
| P1 blame/annotate 归因基础能力 | `VcsAdapter.fetchAttribution` + git/P4/SVN attribution 实现 | `M6.md` |
| P2 SVN 触发入口合同层 | `/triggers/svn`、`translateSvnTriggerToReviewEvent`、`example/svn-trigger.sh` | `M6.md` |
| P3 Reflection thorough mode | `occurrence_count` 与 `extractCrossRunPatterns` 最小跨 run 聚合 | `M7.md` |
| P4 SQLite durable queue | `queue.kind: "sqlite"` 与原子 claim | `../architecture.md` §3.10 |
| P5 daily_rollups 写入 | UTC 日分区 `recomputeDailyRollup` 与 rollup 测试 | `M8.md` |
| P6 输出/合同测试收束 | `no_problems`、git context 边界、manifest 降级矩阵、Feishu 2.0 schema 等测试补齐 | `../architecture.md` §3.9、`../../output-channels.md` |
| P7 `aicr.try_blame` MCP 工具与 orchestrator 接线 | `@aicr/mcp-output` registry/server、runtime manifest、orchestrator VCS attribution replay 与 follow-up pass | `M6.md` |

## 后续规则

- 新的本地优先项仍应先写回 `Plan.md` §8.3，完成后再归档到对应 milestone 或本文件。
- 如果实施中发现必须访问真实外部系统，把本地合同层和真实环境验收拆开；不要把未验收的外部路径标成已完成。

