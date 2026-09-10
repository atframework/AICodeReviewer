# 本地优先执行队列归档

## 范围

这份归档记录从 `Plan.md` 拆出的 P0-P15 本地任务。它们无需共享远端环境或生产凭据，可使用本机临时服务，通过单元测试、集成测试和仓库门禁验证。

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
| P12 CI-safe eval fixture validation | `@aicr/eval` 新增 fixture 合同校验；`aicr eval --validate-only` 不加载 config/LLM 只校验 `eval/*.json`；root `pnpm ci` build 后运行 `pnpm eval:validate`，真实 LLM benchmark 保持外部验收 | `M8.md` |
| P13 SVN hook 本地验收 | 真实 `svnserve` + post-commit hook + 带认证 HTTP 入口 + SQLite 调度；Alice/Alice/Bob 三次通知生成两批，重复通知不重跑；执行真实 metadata/diff，不调用 LLM 或远端发布 | `packages/server/test/svn-hook-live.test.ts`、`M6.md` |
| P14 Model catalog 真实 Redis 验收 | 默认 URL 连接路径，写入后关闭连接，再用新连接验证目录、来源元数据、修正后的 model-id 索引和命名空间隔离 | `packages/server/test/model-catalog-redis-live.test.ts`、`M10.md` |
| P15 配置示例自动校验 | 公共 loader 加载部署配置；schema 校验 example README 和中英文 queue 页的完整自动提交 YAML 示例 | `packages/core/test/config-examples.test.ts`、`M11.md` |

## 2026-09-10 本地验收

- `AICR_SVN_TEST_EXECUTABLE` 指向真实 `svn` 可执行文件，同目录提供 `svnadmin` 和 `svnserve`。测试在 `build/tmp/` 创建独立仓库，使用临时端口和合成账户。
- `AICR_REDIS_TEST_URL` 指向本机测试 Redis。目录测试只清理随机前缀下的自有键，不使用 `FLUSHDB`；该连接也可启用自动提交存储的真实 Redis 测试。
- 未设置对应变量时，服务集成测试会跳过，不能把普通单元测试通过当成真实服务验收。配置示例测试始终运行。
- P13-P15 定向测试共 6 项已通过。部署专属的 SVN 账户/ACL/HTTP 认证、Redis ACL/TLS/网络/持久化，以及真实 LLM 和发布通道仍留在 `Plan.md` 的外部验收表。
- 最终 Windows 验证：ESLint、TypeScript build references、102 个文件的 2279 项测试（零失败、零跳过）、102 个 Markdown 文件、runtime build、6 个离线 eval fixtures 和 54 页双语文档站均通过。Redis/P4/SVN 集成开关均开启；本轮未执行 Linux 或生产部署验收。
- 覆盖率：statements 87.12%、branches 77.28%、functions 90.11%、lines 88.43%。原始日志和 Vitest JSON 位于本次工作区的 `build/logs/roadmap-local/`，该目录不纳入版本管理。

## 后续规则

- 新的本地优先项仍应先写回 `Plan.md` 的本地下一步表，完成后再归档到对应 milestone 或本文件。
- 如果实施中发现必须访问真实外部系统，把本地合同层和真实环境验收拆开；不要把未验收的外部路径标成已完成。
