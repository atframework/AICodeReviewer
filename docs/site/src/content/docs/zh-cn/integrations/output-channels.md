---
title: 输出通道
description: AICR 的 MCP 报告工具如何把 agent 发现转化为 PR 评论、issue 和 IM 卡片。
---

AICR 把 agent 的职责（代码推理）与自身的职责（报告契约、校验、路由和渲染）分离。
所有正式评审结果都通过 AICR 工具产出，绝不通过 agent 的自由文本 stdout。同一个
problem 可以干净地渲染为 VCS 行内评论、issue 条目或 IM 摘要卡片。

## 报告工具

进程内工具注册表向评审执行器暴露以下 AICR 工具：

| 工具 | 用途 | 必填字段 |
| --- | --- | --- |
| `aicr.report_problem` | 报告一个锚定到变更行的可操作 problem | `file`、`line`、`severity`、`category`、`message` |
| `aicr.publish_summary` | 发布结构化 Markdown 评审摘要 | `markdown` |
| `aicr.skip` | 标记评审被有意跳过 | `reason` |
| `aicr.fetch_more_context` | 请求变更文件或窄范围相关文件的源码上下文 | `path`、`reason` |
| `aicr.try_blame` | 请求 VCS 校验的、尽力而为的行归属（不含文件内容） | `path`、`reason` |

`aicr.fetch_more_context` 和 `aicr.try_blame` 是只读上下文工具。编排器会通过配置的
VCS 适配器回放它们，并用获取到的内容/归属跑一次最终 follow-up。

:::important[自由文本 stdout 不是报告]
Agent 适配器运行**绝不能**把自然语言 stdout 当作 IM 摘要发布。如果 agent 无法产出
结构化输出，AICR 触发结构化修复 pass；若仍失败，回退到直接 LLM 调用。说明"没有可操作
问题"或"没有可评审代码"的散文会被归一化为 `aicr.skip`，而不是作为兜底消息发布。
:::

## Problem schema

`aicr.report_problem` 接受最小化、通道无关的形状：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `file` | 是 | 受影响文件的仓库相对路径 |
| `line` | 是 | 主锚点的新文件行号（必须是变更行或可评论的 diff 行） |
| `end_line` | 否 | 范围 problem 的结束行（渲染为 `file:start-end`） |
| `severity` | 是 | `info`、`low`、`medium`、`high` 或 `critical` |
| `category` | 是 | 简短 problem 家族，如 `correctness`、`security`、`api-contract` |
| `message` | 是 | 问题分析：哪里错、触发场景、影响 |
| `suggestion` | 否 | 最小可行的修复方向；可包含 fenced `diff` 补丁 |
| `fingerprint` | 否 | 稳定的去重 key（在支持的通道中以隐藏评论保留） |

`aicr.report_problem` 不接受 agent 提供的归属信息。需要作者或修订上下文时，agent
调用 `aicr.try_blame`；AICR 校验请求并把归属回填到 follow-up pass。

## Channel 类型

Channel 的 `kind` 是由输出实现注册表约束的自由字符串（Zod 校验形状；dispatcher
解析 kind）。`example/config.yaml` 中演练过的 kind：

| Kind | 渲染到 |
| --- | --- |
| `gitea_pr_review` / `github_pr_review` / `gitlab_mr_review` | PR/MR 行内评论 + 一条托管摘要评论 |
| `gitea_problem_issue` / `github_problem_issue` | 托管 issue，每个 problem 一条（或合并），带生命周期对账 |
| `gitea_issue` / `github_issue` | 非 PR 目标的通用 issue 评论 |
| `feishu_bot` | 飞书群机器人卡片 |
| `wecom_bot` | 企业微信群机器人 Markdown 消息 |

:::note[飞书卡片使用 schema 2.0]
飞书卡片 payload 设置 `card.schema = "2.0"`，markdown 放在
`card.body.elements` 下。旧版 1.0 schema 不渲染行内代码和基于语言的高亮。AICR 在
分发前应用 `toFeishuMarkdown()`。
:::

## 路由

`outputs.routes` 决定某次评审的 `line_comments` 和 `summary` 发往哪些 channel。
一个 `default` 块加上可选的 `rules`（按 `trigger` 和 `target_kind` 匹配），可以按
provider/事件类型路由。Workspace 也可以通过 `workspaces.instances.<id>.outputs`
固定 channel。

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      - match: { trigger: p4-main, target_kind: commit }
        summary: [feishu-code-review]
```

## 零问题策略

`no_problems.action` 决定一次成功但无可操作问题的评审是否通知各 channel
（`publish`、`suppress` 或 `publish_if_summary`）。channel 可以按 channel 或按
workspace 覆盖全局策略。如果所有选中的 summary channel 都抑制零问题结果，run 会被
记为跳过，`skipReason="no_problems_suppressed"`。

## 下一步

- 完整的按 channel 选项和 IM Markdown 转换：见[输出通道配置](/zh-cn/configuration/outputs/)（规划中）。
- 完整 MCP 工具输入 schema 和 `.aicr-output-state.json` 流转：见
  [MCP 工具](/zh-cn/integrations/mcp-tools/)（规划中）。
- summary/problem 渲染的模板变量：见[模板变量](/zh-cn/reference/template-variables/)（规划中）。
