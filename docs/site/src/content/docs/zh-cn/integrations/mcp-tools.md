---
title: MCP 工具
description: AICR MCP 评审输出、源码上下文、提交元数据和评审范围工具，以及传输和后续回填流程。
---

AICR 向评审 agent 暴露一个小而稳定的 MCP 工具集。agent 调用这些工具报告发现；AICR 负责校验、路由和渲染。agent 的自由文本 stdout 永远不会被视为最终报告。

报告的 problem 和 summary 如何按 channel 渲染和分发，参见[输出通道](/zh-cn/integrations/output-channels/)。调用这些工具的 agent 运行时参见 [Agent 适配器](/zh-cn/integrations/agent-adapters/)。

## 工具总览

| 工具 | 用途 |
| --- | --- |
| `aicr.report_problem` | 报告一个锚定到变更行的可操作问题 |
| `aicr.publish_summary` | 发布一个结构化 Markdown 评审 summary |
| `aicr.skip` | 标记本次评审为有意跳过 |
| `aicr.fetch_more_context` | 请求某个变更文件或窄范围相关文件的源码上下文 |
| `aicr.try_blame` | 请求 VCS 校验的、尽力而为的行级归因（不返回文件内容） |
| `aicr.get_review_commits` | 查询评审涉及的 commit/revision、文件、补丁及可选作者/仓库信息 |
| `aicr.get_review_context` | 恢复当前评审的端点、仓库/分支身份和实际文件范围 |

`aicr.fetch_more_context` 和 `aicr.try_blame` 是只读上下文工具。orchestrator 通过配置的 VCS 适配器回放它们，并带获取到的内容/归因跑一次最终 follow-up pass。

## `aicr.get_review_commits`

读取当前评审的 VCS 范围，调用方不能指定其他仓库或 revision。
Git 返回从 head 可达但从 base 不可达的提交，包含合并进来的侧分支；
没有 base 时只读取 head。SVN/P4 查询 `(base, head]`，没有 base 时只查指定的
revision/changelist。自动提交的 `head_only` 评审策略将列表限定为 head。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `detail` | `ids` | `ids`：只返回提交号；`files`：逐提交文件；`diffs`：逐提交文件和完整结构化补丁；`summary`：本页提交的文件并集 |
| `include_authors` | `false` | 返回可用的作者/committer 姓名和邮箱、SVN 用户名或 P4 user/workspace |
| `include_repositories` | `false` | 返回 `repositories.source` 和 `repositories.target`，各含 `repository`、`branch` |
| `limit` | `20` | 每页提交数，范围 1–100 |
| `cursor` | 无 | 本次评审上一页的 `next_cursor`；保持 detail 和元数据选项一致 |
| `max_bytes` | `200000` | 响应字节上限，范围 1024–1048576；超限报错，不截断补丁 |

结果包含 `status: complete | partial | unavailable`、`vcs` 和
`commits: [{ revision, ... }]`。`partial` 带有 `next_cursor`，继续查询才能覆盖完整范围。
Git 从 head 向 base 按拓扑顺序返回，SVN/P4 按提交号升序返回。
游标按本次评审签名，评审结束后不能复用。`summary` 的 `files_scope: "page"`
表示本页文件并集；合并所有页的 `files` 才是完整汇总。
先修改后回退的文件也可能在列表中，即使最终净 diff 不再包含它。

`diff.files` 包含路径、状态、原始头信息和 hunks；hunk 行带类型、内容及新旧行号。
补丁使用三行上下文，Git merge 与第一父提交比较；二进制内容不以文本返回。
SVN/P4 文件路径遵循适配器配置的范围。空提交返回空补丁。
响应过大时降低 `limit` 或增加 `max_bytes`；单个补丁仍超限时可先用 `files` 查询。

作者字段为 VCS 原始记录：`username`、`display_name`、`email`、`workspace`、
`committer_name`、`committer_email`，缺失值为 `null`。
Git 显示名不等于平台用户名，因此 Git 的 `username` 保持 `null`，不猜测关联账号。
commit 评审的来源与目标为同一仓库和分支；PR/MR 则保留请求方与被合入方的信息，
包括 fork。旧事件、已删除的 fork 或不完整 payload 可能使来源身份未知。

```json
{
  "toolCalls": [
    {
      "name": "aicr.get_review_commits",
      "input": {
        "detail": "diffs",
        "include_authors": true,
        "include_repositories": true,
        "limit": 5
      }
    }
  ]
}
```

## `aicr.get_review_context`

传入 `{}`，返回 `provider`、`target_kind`、`base_revision`、`head_revision`、
`repositories`、`commit_strategy`、`reviewed_files` 和 `reviewed_file_count`。
文件范围已经过过滤和提交策略处理。最多返回 1000 个路径，超出时
`files_truncated` 为 true。这个工具可用于上下文压缩后恢复范围，或区分历史提交
涉及的文件与本次实际评审的文件。

两个查询工具均接入进程内 registry 和原生 MCP。原生 stdio/HTTP 调用将请求写入
输出状态的 `reviewDataRequests`，并返回 `pending: true`。agent 应结束当前 pass，
宿主通过 VCS 适配器查询，再在有次数上限的 follow-up pass 中回填结果。
凭据留在宿主侧。单独启动 MCP 而没有评审编排器时只记录请求。
历史不可读或元数据缺失不能被当作空评审；报告历史补丁中的问题前仍需验证最终 head。

## `aicr.report_problem`

报告一个锚定到变更行的可操作代码评审问题。

| 字段 | 必填 | 类型 | 描述 |
| --- | --- | --- | --- |
| `file` | 是 | string | 受影响文件的仓库相对路径 |
| `line` | 是 | int | 主锚点的新文件行号；必须是变更行或可评论 diff 行 |
| `end_line` | 否 | int | 范围问题的结束行；渲染为 `file:start-end` |
| `severity` | 是 | enum | `info`、`low`、`medium`、`high`、`critical` |
| `category` | 是 | string | 短问题族（`correctness`、`security`、`api-contract`…）；保持稳定以便分组/去重 |
| `message` | 是 | string | 问题分析：错在哪、触发场景、影响。这是评论正文 |
| `suggestion` | 否 | string | 最小 plausible 修复方向；可包含 fenced `diff` 补丁 |
| `fingerprint` | 否 | string | 稳定的去重键；在支持的 channel 中保留在隐藏评论里 |

行为说明：

- `aicr.report_problem` **不**接受 agent 自报的归因。当分析需要作者或 revision 上下文时，调用 `aicr.try_blame`；AICR 会通过事件元数据、provider API 或配置的 VCS 适配器校验归因，再回灌。归因仅作参考上下文，永远不会成为 problem fingerprint 的一部分。
- 用 `message` 讲分析，用 `suggestion` 给修复。如果补丁有用，把小型 fenced `diff` 放进 `suggestion`，而不是新增字段。
- Git 类 channel 可能用 AICR 派生的代码引用片段（取自已解析的 diff）补充 problem 的上下文。这不会给工具加字段——agent 仍应只报告上面的稳定 schema。

示例：

```json
{
  "toolCalls": [
    {
      "name": "aicr.report_problem",
      "input": {
        "file": "src/service.ts",
        "line": 42,
        "severity": "high",
        "category": "correctness",
        "message": "The new retry path can return before persisting the failed job. A transient database error would drop the job instead of retrying it.",
        "suggestion": "Persist the failed state before returning from the retry branch."
      }
    }
  ]
}
```

## `aicr.publish_summary`

发布一个结构化 Markdown 评审 summary。

| 字段 | 必填 | 类型 | 描述 |
| --- | --- | --- | --- |
| `title` | 否 | string | 简短、channel 友好的标题；适当时渲染为次级标题或顶部标题 |
| `markdown` | 是 | string | 完整结构化分析正文（Markdown） |

用于 PR/MR summary 评论、Gitea managed problem issue、IM bot 聚合报告，以及可能没有行评论目标的 push/commit/P4 changelist/SVN revision 事件。对于 push/commit/P4 事件，当配置的 channel 需要审计轨迹时发布非空 summary；`no_problems` 策略按 channel 决定零问题结果是发布还是抑制。

示例：

```json
{
  "toolCalls": [
    {
      "name": "aicr.publish_summary",
      "input": {
        "title": "发现 1 个高风险问题",
        "markdown": "## Review Summary\n\n发现 1 个高风险问题，建议优先修复事务提交时序。"
      }
    }
  ]
}
```

## `aicr.skip`

标记本次评审为有意跳过。

| 字段 | 必填 | 类型 | 描述 |
| --- | --- | --- | --- |
| `reason` | 是 | string | 跳过原因（如 `lgtm`、`no_reviewable_code`、`no_output_publisher`） |

当不应分派任何可操作结果时使用 `aicr.skip`，包括空变更或无可评审代码。当 agent 修复尝试只返回“无可操作问题”或“无可评审代码”语义的散文时，AICR 会归一化为 `skipReason="lgtm"` 或 `skipReason="no_reviewable_code"`，让 IM channel 保持安静。

## `aicr.fetch_more_context`

请求某个变更文件或窄范围相关仓库文件的源码上下文。

| 字段 | 必填 | 类型 | 描述 |
| --- | --- | --- | --- |
| `path` | 是 | string | 要拉取的仓库相对路径 |
| `range` | 否 | object | 可选行范围（`start_line`、`end_line`） |
| `reason` | 是 | string | 为什么评审需要这段上下文 |

用于在评审中补齐源码上下文缺口：

- 当 diff 缺失或过窄时，不带 `range` 请求整个变更文件。
- 仅当理解某个 API 契约、调用路径、schema、生成接口或配置（且直接影响某变更行）所必需时，才请求变更之外的相关文件。

适配器保持初始 scoped fetch 最小化（只把变更文件写入 workspace）。当相关文件尚未物化时，AICR 按评审 revision 从 VCS 拉取并持久化以供后续读取：

- git：`git show <revision>:<path>`
- P4：`p4 print <path>@<revision>`（在配置的 depot 内）
- SVN：`svn cat -r <revision> <repository_url>/<path>`

请求一个在该 revision 不存在（或在配置的仓库/depot 之外）的路径会被拒绝——这个拒绝就是“停止重试该路径”的信号。

## `aicr.try_blame`

请求 VCS 校验的、尽力而为的行级归因（不返回文件内容）。

| 字段 | 必填 | 类型 | 描述 |
| --- | --- | --- | --- |
| `path` | 是 | string | 仓库相对路径 |
| `range` | 否 | object | 可选行范围（`start_line`、`end_line`） |
| `reason` | 是 | string | 为什么需要归因 |

仅当归属、最近变更作者或 revision 来源实质影响评审时使用。结果带 `status: ok | partial | not_found` 以及可用的行/revision/作者元数据——绝不含源码文本。如果当前 VCS 适配器没有归因后端，AICR 返回 `not_found`，而不是让模型猜测作者。

## 输出状态流转

每次工具调用后，MCP 输出 server 都会向 run 的隔离 `agent/` 目录写入 `.aicr-output-state.json`。agent run 结束时，orchestrator 读取该状态文件并据此填充 AICR 的输出收集器——校验过的 problem、summary、跳过原因，以及 `contextRequests`、`attributionRequests` 和 `reviewDataRequests`。

这个状态文件是 agent 与 AICR 之间的结构化合同。orchestrator 会：

1. 在每次 agent run 前清理旧的 `.aicr-output-state.json`，避免上一次 repair pass 的工具状态污染下一次输出。
2. run 结束后读取状态。
3. 通过 VCS 适配器的 `fetchExtraContext` 执行记录的 `aicr.fetch_more_context` 请求。
4. 在支持时通过 VCS 适配器的 `fetchAttribution` 执行记录的 `aicr.try_blame` 请求。
5. 通过本次评审的宿主 handler 和 Git/SVN/P4 适配器执行元数据查询。
6. 把获取到的内容、归因及元数据回灌，跑一次最终 follow-up pass，然后发布结果。

:::caution[容器 workdir 必须是 `/workspace/agent`]
Docker/Podman 沙箱 run 必须把容器 workdir 设为可写的 agent 挂载。否则 agent spawn 的 MCP server 会把 `.aicr-output-state.json` 写到镜像 workdir（如 `/app`）下，orchestrator 就会漏掉结构化结果。参见[常见问题](/zh-cn/troubleshooting/)。
:::

## 传输方式

`@aicr/mcp-output` 包提供一个 review executor 使用的进程内工具注册表，外加两个共享同一工具集和 `.aicr-output-state.json` 合同的 server 传输：

- **stdio**（运行时 bundle 默认）：每个 agent 运行时 bundle 物化本地 stdio `aicr-output` MCP server 配置，agent 通过其原生 MCP client 与之通信。
- **Streamable HTTP**（测试 / 远程 MCP client）：通过本地 HTTP endpoint 启动同一组工具：

  ```bash
  node packages/mcp-output/dist/server.js --transport http --host 127.0.0.1 --port 3000
  ```

  用于 agent 之外的传输级冒烟测试，或只支持 HTTP MCP 的 client。生产 agent 运行时 bundle 仍使用 stdio，除非适配器显式选择 HTTP。

## Kilo MCP 工具名归一化

Kilo Code（≥7.x）会给 MCP 工具名加 server 名前缀，并把点转成下划线。一次对 `aicr.report_problem` 的调用会被发出为
`aicr-output_aicr_report_problem`。AICR 的 `normalizeToolName` 在执行前把该格式映射回规范 `aicr.*` 名，因此 agent 与 AICR 在工具身份上保持一致。

作为兼容回退，当 MCP 状态文件缺失时，Kilo JSON stream 中的 `tool_call` / `tool_use` 事件也会被捕获并执行，因此即便 stdout 中没有最终 JSON payload，`aicr.fetch_more_context` 和 `aicr.try_blame` 请求也不会被静默丢弃。
