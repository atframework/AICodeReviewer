---
title: AICodeReviewer
description: 自托管的 AI 代码评审编排服务，支持 GitHub、Gitea/Forgejo、GitLab、Perforce 和 Subversion。
template: splash
---

import { Card, CardGrid, LinkCard } from '@astrojs/starlight/components';

**AICodeReviewer (AICR)** 是一个自托管服务，用于跨多个版本控制系统编排 AI
代码评审。它把 webhook 和 trigger 归一到统一评审流水线，在你选定的沙箱内运行
agent CLI，并把结构化结果路由回 PR 评论、托管 issue 或 IM 机器人——而不是把
agent 的自由文本 stdout 当成正式报告。

## 工作流程

1. **Webhook 或 trigger 到达。** 来自你的 VCS（push、PR、手动命令）。AICR
   用你配置的 HMAC secret 或 API key 验证请求。
2. **VCS 适配器拉取变更。** 仅拉取变更的文件——scoped fetch，而非全量 clone。
   对 PR 计算 merge base diff；对 P4 和 SVN 计算 changelist 或 revision diff。
3. **Diff 压缩介入。** 当变更集超过模型的上下文窗口时，AICR 保留最相关的
   hunks 并裁剪其余部分。
4. **Agent 在沙箱中运行。** 你选择的 agent CLI（Kilo Code、Claude Code 等）
   在 Docker 或 Podman 容器中执行，带着 diff、你的 AI 指令和稳定的 MCP
   工具集。沙箱具有只读源码挂载、allowlist 命令和整棵进程树的超时清理。
5. **结构化结果路由。** Problem 变成 PR 行内评论（带代码上下文）、托管 issue
   （带生命周期跟踪和修复后自动关闭）或 IM 摘要卡片（飞书/企业微信，正确渲染）。
   同一个 `aicr.report_problem` 调用驱动全部三种输出。

## 核心特性

- **一条流水线，多种 VCS。** GitHub、Gitea、Forgejo、GitLab 通过 webhook
  接入；Perforce (P4) 和 Subversion (SVN) 通过 trigger 端点接入。全部归一为同一个
  `ReviewEvent`。
- **自带 agent。** Kilo Code、Claude Code、opencode、Zoo Code 和 Copilot CLI
  共用一套运行时合同。AICR 把你的 `ModelSpec` 翻译到每个工具的原生字段，并在
  run manifest 中显式记录能力降级，而不是静默丢弃。
- **AICR 拥有报告契约。** Agent 通过一个精简、稳定的 MCP 工具集产出结果
  （`aicr.report_problem`、`aicr.publish_summary`、`aicr.skip`、
  `aicr.fetch_more_context`、`aicr.try_blame`）。同一个 problem 可以干净地渲染为
  PR 行内评论、托管 issue 或 IM 摘要卡片。
- **默认安全。** Scoped VCS fetch（仅变更文件）、只读源码挂载、allowlist 沙箱命令、
  每个边界的 secret 脱敏、整棵进程树的超时清理，以及服务容器用 `--init` 回收僵尸进程。
- **上下文感知压缩。** 大 diff 在进入模型上下文窗口前自动压缩。按模型的覆盖阈值允许
  你为不同 provider 调整压缩策略，而无需改动评审流水线。
- **托管 Problem 生命周期。** Problem 通过稳定 fingerprint 跨 run 追踪。当文件被
  重新评审且问题消失时，托管 issue 自动关闭。解决受文件范围守卫保护——不涉及某文件的
  评审不会错误关闭该文件上的 issue。
- **内置可观测性。** Dashboard 提供按项目统计、按 run 的 token 估算与成本明细、
  provider 级 LLM 使用追踪、每日汇总，以及用于 Prometheus 抓取的 `/metrics` 端点。
- **重试与降级。** 队列级重试带指数退避。LLM fallback 链在主 provider 失败或限流时
  路由到下一个。死信队列保存持续失败的 run 以便后续排查。

## 从这里开始

<CardGrid stagger>
  <Card title="快速上手" icon="rocket">
    在本地或 Docker Compose 运行 AICodeReviewer，几分钟内触发第一次评审。
  </Card>
  <Card title="认证与密钥" icon="key">
    三层认证模型：webhook HMAC、服务端 API key、按 workspace 的 key。`.env` 与
    `config.yaml` 各放什么。
  </Card>
  <Card title="输出通道" icon="comment">
    MCP 报告工具、支持的 channel 类型，以及路由如何工作。
  </Card>
  <Card title="部署到生产" icon="seti:docker">
    单容器 Docker 或 Podman，反向代理处理 TLS，持久化卷。
  </Card>
  <Card title="LLM 提供商与模型" icon="puzzle">
    配置 OpenAI 兼容的 provider、模型目录、重试策略，以及按 run 的预算上限。
  </Card>
  <Card title="Agent 与沙箱" icon="terminal">
    选择 agent CLI、设置超时、启用自动压缩、锁定执行沙箱。
  </Card>
</CardGrid>

## 支持的集成

| 维度 | 选项 |
| --- | --- |
| VCS 提供商 | GitHub、Gitea、Forgejo、GitLab（webhook）；Perforce (P4)、Subversion (SVN)（trigger） |
| Agent CLI | Kilo Code、Claude Code、opencode、Zoo Code、Copilot CLI |
| 输出通道 | PR/MR 行内评论与摘要、托管 problem issue、飞书机器人、企业微信机器人 |
| 沙箱 | native、docker、podman、docker_socket（`k8s_pod`、`firecracker` 预留） |
| 模型提供商 | 任意 OpenAI 兼容 API；models.dev 目录提供上下文窗口和定价元数据 |

## 设计原则

- **最小假设。** AICR 归一化 VCS 输入但不猜测你的工作流。每个行为——跳过策略、
  输出路由、标签管理、提交策略——均可配置。
- **诚实降级。** 当 agent 适配器或模型不支持某项功能（如结构化输出、推理模式），
  会在 run manifest 中显式记录。没有任何功能被静默丢弃。
- **单容器部署。** 整个服务——HTTP server、队列 worker、agent 编排器、dashboard
  和 SQLite 数据库——运行在同一个进程中。`docker run` 或 `podman run` 即可部署；
  扩展时在共享数据库后增加 worker 数量。
- **可读输出。** 每个 problem 包含严重级别、分类、文件路径、行范围和人类可读消息。
  IM 机器人收到正确渲染的 Markdown 表格和代码块。没有任何 agent 原始 stdout 进入
  用户可见的通知。

## 推荐路径

到生产最快的方式是单个 Docker 或 Podman 容器，前置反向代理，由 GitHub 或 Gitea
webhook 触发。请从[快速上手](/zh-cn/start/quick-start/)开始。

如果你在做评估或贡献，[本地 Node.js 快速上手](/zh-cn/start/quick-start/#本地-node-js)
只需要 `pnpm install` 和 `pnpm build`。
