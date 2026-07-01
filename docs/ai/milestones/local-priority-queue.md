# 本地优先执行队列归档

## 范围

这份归档记录此前从 `Plan.md` 拆出的 P0-P11 本地闭环任务。它们的共同标准是：不依赖真实 GitLab / SVN / Redis / Kubernetes / CI 权限，可通过本地单元测试、集成测试、typecheck、build 或 markdownlint 验证。

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
| P8 repo 约定学习与 prompt 自动注入 | `extractRepositoryConventions()` + `buildMemoryHintsForPrompt()`；同 workspace 读取、抽象模式、去重、限长、scrubber 兜底 | `M7.md` |
| P9 Model catalog Redis backend 本地合同层 | `createRedisModelCatalogBackend()`、`storage.cache.redis` 接线、entry/model/source key 持久化、bootstrap enrichment 和缺失 Redis 配置显式拒绝测试 | `M10.md` |
| P10 稳定合同收敛（实现-文档-测试对齐） | `firecracker` sandbox config enum 与 `k8s_pod` 对称；`auth.ts` API-key 中间件安全测试（401/403/Bearer/per-workspace）；`path-filters.ts` glob 契约测试（pin 住 `example/config.yaml` 文档化的 `**/*.cpp` / `*.md` / `src/**` / `**/*.pb.*` 语义与 exclude 优先）；`dailyRollups` schema 列断言补全；`example/config.yaml` 的 `rate_limit`（`per_provider_rps`）/ `dead_letter`（`enabled`）/ `rabbitmq`（标注未实现）文档漂移修正 | `../architecture.md` §3.8、`example/config.yaml` |
| P11 按 token 类别的缓存成本估算 | `ChatCompletionUsage` 新增 `cachedPromptTokens`/`cacheCreationTokens`；OpenAI/DeepSeek/Gemini/Anthropic extractor 解析原生缓存 token（Anthropic 把 `cache_read_input_tokens` 折进 `promptTokens` 保持“总输入含缓存命中”不变式）；`ModelPricing`/`extractModelPricing` 增加 `costCacheReadPerMTok`/`costCacheWritePerMTok`；`estimateCost` 按非缓存输入 / 缓存命中 / 缓存写入 / 输出四类套 catalog 价格，缓存价缺失回退输入价，无任何价格才回落 `(tokens/1000)*0.002` 占位；gateway 与各 extractor 测试补齐 | `../architecture.md` §3.5、§3.13 |

## 后续规则

- 新的本地优先项仍应先写回 `Plan.md` §8.3，完成后再归档到对应 milestone 或本文件。
- 如果实施中发现必须访问真实外部系统，把本地合同层和真实环境验收拆开；不要把未验收的外部路径标成已完成。

