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
解析 kind）。

| Kind | Problem 输出 | Summary 输出 | 说明 |
| --- | --- | --- | --- |
| `gitea_pr_review` | 一条合并的 PR review/评论正文 | PR review / 配置的 summary 发布器 | problem 先缓冲，再作为一条 Markdown 正文 flush；403/422 时退化为一条 issue 评论 |
| `github_pr_review` | 一条合并的 PR review/评论正文 | PR review / 配置的 summary 发布器 | 与 `gitea_pr_review` 相同的缓冲+flush；403/422 时退化为 issue 评论 |
| `gitlab_mr_review` | 当 `baseSha`/`headSha` 可用时发 MR discussion | MR note / 配置的 summary 发布器 | 行锚点不可用时退化为通用 MR note |
| `gitea_problem_issue` / `github_problem_issue` | 收集后对账 | 创建 / 更新 / 解决托管 problem issue | 这里 fingerprint 稳定性最重要；`github_problem_issue` 用字符串标签名，`resolved_action` 仅支持 `close` 和 `none`（GitHub 无 issue 删除 API） |
| `gitea_issue` / `github_issue` | 收集后渲染为 issue 评论 | 聚合 issue 评论 | 适用于 push 事件或基于 issue 的分诊 |
| `feishu_bot` | 收集后聚合 | 交互卡片（JSON 2.0 schema） | 见 [IM 机器人](/zh-cn/integrations/im-bots/) |
| `wecom_bot` | 收集后聚合 | Markdown 消息 | 见 [IM 机器人](/zh-cn/integrations/im-bots/) |

:::note[飞书卡片使用 schema 2.0]
飞书卡片 payload 设置 `card.schema = "2.0"`，markdown 放在
`card.body.elements` 下。旧版 1.0 schema 不渲染行内代码和基于语言的高亮。AICR 在
分发前应用 `toFeishuMarkdown()`。
:::

:::note[PR review 的 problem 会先缓冲]
`gitea_pr_review` 和 `github_pr_review` 把 `publishProblem` 调用缓冲起来，在
`publishSummary` 被调用时作为**一条**合并 Markdown 回复 flush。不要期望每个 problem 一次
HTTP POST 或每个 problem 一条行内评论。如果把 PR review channel 只配置在 `line_comments`
下，复合发布器仍必须调用 summary flush，否则缓冲的 problem 会被丢弃。
:::

## 托管 problem issue 生命周期

`gitea_problem_issue` 和 `github_problem_issue` 跨评审对账过期的托管 issue。关键行为：

- **Fingerprint 稳定性。** 每个 problem 带一个 `fingerprint`。AICR 在每个托管 issue 内的
  隐藏 `aicr:problems` 标记里跟踪打开的 fingerprint。当之前打开的 fingerprint 消失，该 issue
  被移到 Resolved 段（可选关闭）。
- **文件范围解决守卫。** 只有当当前评审确实重新分析了包含该 problem 的文件时，该 problem
  才会被标记为"已解决"。由触及无关文件的提交触发的评审——或什么都没发现的评审——**不会**
  把之前报告的每个 problem 都标记为已解决。每个托管 issue 正文嵌入
  `aicr:file=<path>`，以便恢复文件归属。
- **最近 issue 上限。** 对账只列出最近打开的 issue，上限由
  `review.problem_issue.max_recent_issues` 控制（默认 20，范围 1–100，可按 workspace 覆盖）。
  最近窗口之外的 fingerprint 不会在该 run 去重或关闭。
- **GitHub `resolved_action`。** 仅支持 `close` 和 `none`（GitHub 无 issue 删除 API）。Gitea
  额外支持 `delete`。

`issue_mode`、`resolved_action`、`assign_committer`、`owners_file` 和严重性标签字段见
[输出通道配置](/zh-cn/configuration/outputs/)。

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

- 完整的按 channel 选项和 IM Markdown 转换：见[输出通道配置](/zh-cn/configuration/outputs/)。
- 完整 MCP 工具输入 schema 和 `.aicr-output-state.json` 流转：见
  [MCP 工具](/zh-cn/integrations/mcp-tools/)。
- summary/problem 渲染的模板变量：见[模板变量](/zh-cn/reference/template-variables/)。
- 配置飞书或企业微信群机器人：见 [IM 机器人](/zh-cn/integrations/im-bots/)。
