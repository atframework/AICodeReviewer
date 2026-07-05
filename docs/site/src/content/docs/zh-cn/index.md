---
title: AICodeReviewer
description: 自托管的 AI 代码评审编排服务，支持 GitHub、Gitea/Forgejo、GitLab、Perforce 和 Subversion。
template: splash
---

import { Card, CardGrid } from '@astrojs/starlight/components';

**AICodeReviewer (AICR)** 是一个自托管服务，用于跨多个版本控制系统编排 AI
代码评审。它把 webhook 和 trigger 归一到统一评审流水线，在你选定的沙箱内运行
agent CLI，并把结构化结果路由回 PR 评论、托管 issue 或 IM 机器人——而不是把
agent 的自由文本 stdout 当成正式报告。

## 为什么选择 AICR

- **一条流水线，多种 VCS。** GitHub、Gitea/Forgejo、GitLab 通过 webhook
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
  <Card title="部署到生产" icon="rocket">
    单容器 Docker 或 Podman，反向代理处理 TLS，持久化卷。
  </Card>
</CardGrid>

## 支持的集成

| 维度 | 选项 |
| --- | --- |
| VCS 提供商 | GitHub、Gitea、Forgejo、GitLab（webhook）；Perforce (P4)、Subversion (SVN)（trigger） |
| Agent CLI | Kilo Code、Claude Code、opencode、Zoo Code、Copilot CLI、native LLM |
| 输出通道 | PR/MR 行内评论与摘要、托管 problem issue、飞书机器人、企业微信机器人 |
| 沙箱 | native、docker、podman、docker_socket（`k8s_pod`、`firecracker` 预留） |

## 推荐路径

到生产最快的方式是单个 Docker 或 Podman 容器，前置反向代理，由 GitHub 或 Gitea
webhook 触发。请从[快速上手](/zh-cn/start/quick-start/)开始。

如果你在做评估或贡献，[本地 Node.js 快速上手](/zh-cn/start/quick-start/#本地-node-js)
只需要 `pnpm install` 和 `pnpm build`。
