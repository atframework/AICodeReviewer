# 任务执行提示词

## CodeReview

请分析 Plan.md 和当前阶段的代码实现，分析并修复问题并尽可能补全单元测试。

## Continue Plan

请分析Plan.md和当前实现的进度，继续执行计划。

请分析Plan.md和当前实现的进度，先跳过依赖外部VCS（gitea,github等）验收部分，本地有kili命令行工具，继续执行计划。

## 验收

- 仅剩真实 Gitea e2e 验收（本地 docker 起 Gitea → PR 触发 → 看到 line comment）。其余 M1 核心能力（webhook → VCS → prompt → LLM → output 全链路 + 配置驱动 + CLI serve/dry-run）已全部落地。
- 使用真实 Kilo CLI 做完整 agent review。
- 未用真实 Docker/Podman 容器跑恶意 PR sandbox escape 场景。
- 队列/并发/限流和多事件路由的压力型测试仍可继续加强。
- M0.5/M1/M2 验收留存项
