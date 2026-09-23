# 本地优先执行队列归档

P0–P15 已交付；重复实现说明由下列合同/里程碑承接。

| 任务组 | 交付入口 |
| --- | --- |
| P0 HTTP MCP | [M5](M5.md) |
| P1/P2/P7 attribution、SVN trigger、try_blame | [M6](M6.md) |
| P3/P8 reflection 与 repo convention | [M7](M7.md) |
| P4/P5/P10 SQLite queue、rollup 与合同收敛 | [架构](../architecture.md) §3.8–3.11 |
| P6 输出合同 | [输出合同](../../output-channels.md) |
| P9/P11 catalog Redis 与缓存计费 | [M10](M10.md)、架构 §3.5/§3.13 |
| P12 离线 eval | [M8](M8.md) |
| P13 SVN hook | server/test/svn-hook-live.test.ts |
| P14 真实 Redis catalog | server/test/model-catalog-redis-live.test.ts |
| P15 配置示例 | core/test/config-examples.test.ts；扩展见 [M28](M28.md) |

2026-09-10：P13–P15 定向 6 项通过；Windows 全量 102 文件、2279 项零失败/跳过，
真实 Redis/P4/SVN 启用；完整 runtime 门禁、6 eval fixtures、54 页双语站通过。
日志 build/logs/roadmap-local/。SVN 真实提交 Alice/Alice/Bob 合为两批，重投不重跑；
Redis 新连接验证数据并仅清理随机前缀。未调用 LLM、远端发布或验证生产 ACL/TLS。
后续工作只在[AI 维护导航](../index.md)的前瞻扩展节维护。
