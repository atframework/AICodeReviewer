---
title: 输出通道与路由
description: 配置输出通道、路由规则、零问题策略、label 管理，以及托管 problem issue 的生命周期。
---

评审完成后，AICodeReviewer 会按**路由规则**把结果分发到一个或多个**输出通道**——
PR 行内评论、IM 机器人、托管 issue。`outputs` 命名空间定义通道、路由、模板引擎，
以及决定"无问题评审是否通知"的零问题策略。

```yaml
outputs:
  template_engine: handlebars
  no_problems: { action: suppress }
  channels:
    - name: gitea-pr-review
      kind: gitea_pr_review
      trigger: gitea
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
```

## `outputs.template_engine`

| 取值 | 说明 |
| --- | --- |
| `handlebars`（默认） | Handlebars 模板（`*.hbs`）。内置模板位于 `templates/builtin/*.hbs`。 |
| `eta` | ETA 模板。 |

按 workspace 覆盖模板：把文件放在 `workspaces/<workspace_id>/templates/` 下。
候选文件名按顺序匹配：`<channel_name>.<kind>.md.hbs` → `<channel_name>.<kind>.hbs`
→ `<channel_kind>.<kind>.md.hbs` → `<channel_kind>.<kind>.hbs` → `<kind>.md.hbs`
→ `<kind>.hbs`。

## `outputs.no_problems` —— 零问题策略

决定一次成功且**无可操作问题**的评审是否通知每个通道。通知类通道默认安静；
生命周期或审计类通道可以单独开启发布。

| `action` | 行为 |
| --- | --- |
| `suppress`（示例默认） | 无问题时不通知。 |
| `publish` | 始终通知，即使零问题。 |
| `publish_if_summary` | 仅在产生了非空摘要时通知。 |

策略分三层设置，越往下越具体：

1. `outputs.no_problems`（所有通道的全局默认）
2. `outputs.channels[]` 内按通道的 `no_problems`
3. 经由 `workspaces.instances.<id>.outputs.channel_overrides.<channel>.no_problems`
   按 workspace + 按通道覆盖

```yaml
outputs:
  no_problems: { action: suppress }
  channels:
    - name: feishu-code-review
      kind: feishu_bot
      no_problems: { action: suppress }

workspaces:
  instances:
    critical-service:
      outputs:
        channel_overrides:
          feishu-code-review:
            no_problems: { action: publish }   # 该仓库需要审计留痕
```

如果所有选中的 summary 通道都对零问题结果抑制，运行会被记为 skipped，
`skipReason="no_problems_suppressed"`。

## `outputs.channels[]` —— 输出目标

每个通道有一个 `name`（被路由和 workspace 输出列表引用）和一个 `kind`。下面的
通用字段对大多数 kind 适用；各 kind 专属字段见对应说明。

### 通用字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 唯一的通道 id。 |
| `kind` | string | 通道类型（见下表）。`gitea_finding_issue` 已移除，请用 `gitea_problem_issue`。 |
| `trigger` | string | 该通道绑定的 trigger 名（用于依赖 VCS 的类型）。 |
| `mention_author` | bool | 在消息中 @ 提交作者。 |
| `mention_fallback` | enum | `all`（@ 所有人）或 `skip`（找不到作者时不 @）。 |
| `no_problems` | object | 按通道的零问题策略（见上）。 |
| `commit_url_template` | string | 覆盖 push/commit 目标的提交链接。 |
| `revision_url_template` | string | 覆盖 revision 链接（P4/SVN）。 |
| `change_url_template` | string | 覆盖 change 链接。 |
| `marker_prefix` | string | 托管 issue 的标题前缀（例如 `[AICR]`）。 |
| `marker_label` | string | 标识托管 issue 的隐藏 label（例如 `aicr-managed`）。 |
| `labels` | string[] | 要附加的 label。 |
| `label_ids` | int[] | 数字 label id（部分 VCS API）。 |
| `issue_mode` | enum | `per_problem`、`consolidated`（默认）或 `per_commit`。 |
| `resolved_action` | enum | `none`、`close`、`mark_resolved` 或 `delete`。问题被修复时执行的动作。 |
| `assign_committer` | bool | 把提交作者加为 assignee（默认 `true`）。 |
| `owners_file` | string | OWNERS 文件路径（默认 `OWNERS`）。 |
| `add_owners_as_assignees` | bool | 把匹配到的 OWNERS 加为 assignee。 |
| `severity_label_prefix` | string | 自动创建 label 的前缀（例如 `aicr:problem:`）。 |
| `severity_label_colors` | map | 自定义 label 颜色（不带 `#` 的十六进制）。 |
| `review_mode` | enum | `auto`（默认）、`review` 或 `comment`。 |
| `review_event` | enum | `COMMENT`（默认）或 `REQUEST_CHANGES`。 |
| `review_update_strategy` | enum | `always_new` 或 `update_existing`（默认）。 |
| `notify_feishu` | object | 可选的 issue 创建时飞书通知（`webhook_url_env`、`secret_env`）。 |

### 通道类型

| Kind | 说明 |
| --- | --- |
| `gitea_pr_review` | Gitea/Forgejo PR 上的行内评论。 |
| `github_pr_review` | GitHub PR 上的行内评论。 |
| `gitlab_mr_review` | GitLab MR 上的行内评论。 |
| `gitea_problem_issue` | 按 problem 指纹创建/关闭的 Gitea 托管 issue。 |
| `github_problem_issue` | 按 problem 指纹的 GitHub 托管 issue（不支持删除——GitHub 不允许）。 |
| `gitea_issue` | 把汇总评审作为评论发到既有 Gitea issue。 |
| `github_issue` | 把汇总评审作为评论发到既有 GitHub issue。 |
| `feishu_bot` | 通过自定义机器人把汇总问题推送到飞书群。 |
| `wecom_bot` | 通过 webhook 把汇总问题推送到企业微信群。 |

### `review_mode` —— PR review API 策略

适用于 `*_pr_review` / `*_mr_review` 类型：

| 取值 | 行为 |
| --- | --- |
| `auto`（默认） | 先尝试 PR review API；403/422 时回退到 issue 评论。 |
| `review` | 始终使用 PR review API，不回退。 |
| `review_event` `COMMENT`（默认）/ `REQUEST_CHANGES` | 使用 review API 时控制 review 事件类型。 |

### PR review 摘要更新策略

`review_update_strategy` 控制跨 push 时 PR 摘要的行为：

| 取值 | 行为 |
| --- | --- |
| `always_new` | 每次 push 都创建新的 review/评论（旧行为）。 |
| `update_existing`（默认） | 找到并更新 PR 上前一次的 AICR 摘要评论。未解决的问题保留；已解决的问题标 ✅；新问题打上引入它的 commit 标记。 |

AICR 通过由 `marker_prefix`/`marker_label` 派生的稳定**托管评论标记**识别自己的
评论，因此只会更新 AICR 自己的摘要评论，其他评论原样不动。

## `outputs.routes` —— 把结果送到正确的通道

路由把评审输出（`line_comments` 和 `summary`）映射到通道列表。`default`
对每个事件生效；`rules[]` 针对特定 trigger 或 target kind 覆盖。

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      - match:
          trigger: p4-main
          target_kind: commit
        summary: [feishu-code-review]
      - match:
          trigger: github
          target_kind: push
        summary: [feishu-code-review, github-problem-issues]
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `default.line_comments` | string[] | 行内评论的通道。 |
| `default.summary` | string[] | 汇总摘要的通道。 |
| `rules[].match.trigger` | string | 匹配来自该 trigger 名的事件。 |
| `rules[].match.target_kind` | string | 匹配某种 target kind（例如 `commit`、`push`、`pull_request`）。`pr` 会被归一化为 `pull_request`。 |
| `rules[].line_comments` | string[] | 覆盖匹配事件的行内评论通道。 |
| `rules[].summary` | string[] | 覆盖匹配事件的汇总通道。 |

按 workspace 的输出列表（`workspaces.instances.<id>.outputs.line_comments`
与 `.summary`）对该 workspace 优先于全局路由。

## label 管理（`review.labels`）

AICodeReviewer 可以基于 label 跳过评审，并在处理时自动给 PR/MR/issue 打标签。
这一段位于 `review`（不是 `outputs`），但与输出分发紧密相关。

```yaml
review:
  labels:
    ignore: ["aicr:ignore", "aicr-ignore"]   # 命中任一 label 即跳过评审
    auto_tag: "aicr"                         # AICR 启动时打的固定 tag
    reviewed_tag: "aicr:reviewed"            # 评审完成时打的 tag
```

| 字段 | 行为 |
| --- | --- |
| `ignore` | 在 webhook 层检查。如果 PR/MR/issue 带有任一所列 label，AICR 立即返回，不调度评审。 |
| `auto_tag` | 由输出分发器（`gitea_pr_review`、`github_pr_review`、`gitlab_mr_review`、`gitea_issue`、`gitea_problem_issue`）在发布时打上的固定 tag。不存在则自动创建。 |
| `reviewed_tag` | 评审完成时打上的 tag。 |

所有字段都支持全局 → workspace 级的覆盖层次。

## 托管 problem issue 的生命周期上限

`gitea_problem_issue` 与 `github_problem_issue` 通过仅列出最近的开放 issue 来
回收陈旧的托管 issue。上限位于 `review.problem_issue`，可按 workspace 收紧。

```yaml
review:
  problem_issue:
    max_recent_issues: 20   # 默认；有效范围 1..100

workspaces:
  instances:
    latency-sensitive-service:
      review:
        problem_issue:
          max_recent_issues: 10
```

如果仓库的开放托管 issue 多于上限，超出最近窗口的指纹在该轮不会被去重或关闭。
后续运行——或临时调高上限——可用于大批量清理。

如果某个配置的输出通道无法发布，AICR 会记录该通道失败并继续尝试其余已路由通道。
当所有分发尝试都失败时，运行被记为 skipped，
`skipReason: output_dispatch_failed`（而非 `review_orchestration_failed`），
这样评审结果与失败原因仍然可见，又不会污染 trigger 队列。

## 非 PR 目标链接

内置模板渲染 `target.markdownLink` / `target.displayText`，而不是默认每次评审都是
PR。Gitea、Forgejo、GitHub、GitLab 的提交链接由 trigger 的 `base_url`、仓库和
revision 推导。P4/SVN/内部系统可通过 trigger 的 `change_url_template` 或
`revision_url_template` 提供显式 URL 模板（变量在替换前会做 URL 编码）：

```yaml
triggers:
  - name: p4-main
    kind: p4
    change_url_template: "https://swarm.example.com/changes/{{revision}}"
  - name: svn-main
    kind: svn
    revision_url_template: "https://svn.example.com/viewvc/project?view=revision&revision={{revision}}"
```

## 接下来看哪里

- 完整的按通道字段约定，包括 agent 用来获取更多上下文的 MCP 工具约定，见
  [输出通道](/zh-cn/integrations/output-channels/)。
- trigger 侧的 URL 模板与文件过滤器，见
  [VCS 提供商](/zh-cn/integrations/vcs-providers/)。
