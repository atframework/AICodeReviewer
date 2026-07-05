---
title: 模板变量
description: summary 和 problem 输出模板中可用的变量、模板文件名解析顺序，以及一个 Handlebars 示例。
---

AICR 在发布每个 problem 和 summary 之前，都会先通过 Handlebars 模板渲染。内置模板位于部署目录的
`templates/builtin/*.hbs`，覆盖每种内置 channel kind 的 problem-comment 与 summary 变体。你可以按
workspace 覆盖它们，而无需 fork 内置模板。

渲染后的模板如何分发到各 channel kind，参见[输出通道](/zh-cn/integrations/output-channels/)；下面引用的
channel 级字段参见[配置字段参考](/zh-cn/reference/config-fields/)。

## 候选模板文件名解析顺序

覆盖模板从 workspace 模板目录加载：

```text
workspaces/<workspace_id>/templates/
```

对于给定的 channel 和模板 `kind`（通常是 `summary` 或 `problem`），AICR 按以下顺序解析候选文件名，使用第一个匹配：

1. `<channel_name>.<kind>.md.hbs`（例如 `feishu-code-review.summary.md.hbs`）
2. `<channel_name>.<kind>.hbs`
3. `<channel_kind>.<kind>.md.hbs`（例如 `feishu_bot.summary.md.hbs`）
4. `<channel_kind>.<kind>.hbs`
5. `<kind>.md.hbs`（例如 `summary.md.hbs`）
6. `<kind>.hbs`

`<channel_name>` 是你在 `outputs.channels[]` 中为 channel 设置的 `name`；`<channel_kind>` 是 channel 的
`kind`（如 `feishu_bot` 或 `gitea_pr_review`）。更具体的 channel-name 覆盖总是优先于 channel-kind 回退，
后者又优先于仅按 kind 的通用回退。

如果找不到任何覆盖，则使用该 channel kind 和 kind 对应的内置模板。

## 变量树

所有变量作为一个上下文对象传入。下表列出最常用的字段。标记为 *when available*（视情况可用）的字段是可选的，取决于 trigger kind 和事件 payload（PR/MR、push、commit、P4 changelist、SVN revision、scheduled、manual）。

| 变量 | 含义 |
| --- | --- |
| `{{event.author}}` | 归一化的事件作者用户名（视情况可用） |
| `{{event.email}}` | 作者邮箱（视情况可用） |
| `{{event.displayName}}` | 作者显示名（视情况可用） |
| `{{event.url}}` | 原始事件 URL（视情况可用）；模板不应假定它一定是 PR/MR URL |
| `{{event.title}}` | 事件标题（PR/MR 标题、commit message 主题、changelist 描述等，视情况可用） |
| `{{target.kind}}` | 目标类型（`pull_request`、`merge_request`、`push`、`commit`、`changeset`、`revision`、`scheduled`、`manual`） |
| `{{target.displayText}}` | 适用于任何事件类型的安全纯文本目标标签 |
| `{{target.markdownLink}}` | 安全的 Markdown 目标链接；用它代替硬编码 `[View PR]` |
| `{{target.url}}` | 目标 URL（视情况可用） |
| `{{repo.name}}` | 短仓库名 |
| `{{repo.fullName}}` | 完整仓库引用（`owner/repo`、depot path 或仓库 URL） |
| `{{vcs.branch}}` | Git 分支名（视情况可用） |
| `{{vcs.sourcePath}}` | provider 专属源 namespace/path（depot 或仓库子路径，视情况可用） |
| `{{vcs.workspace}}` | 从事件捕获的提交者 client/workspace 名（P4 的 `%client%`/payload `client`，视情况可用）；这是提交者的 workspace，不是 AICR 的分析 client |
| `{{vcs.repositoryPath}}` | 仓库/depot 引用路径（视情况可用） |
| `{{run.id}}` | review run ID（视情况可用） |
| `{{atMentions}}` | 预渲染的、channel 专属的 mention 字符串（已是平台原生 mention 语法） |
| `{{summaryTitle}}` | 通过 `aicr.publish_summary.title` 提供的可选简短 summary 标题 |
| `{{summary}}` | summary Markdown 正文 |
| `{{problems}}` | problem 列表（用于 summary 模板）；用 `{{#each problems}}` 迭代 |
| `{{problem.file}}` | 某个已报告 problem 的仓库相对路径（problem 模板） |
| `{{problem.line}}` | 主锚点行号 |
| `{{problem.location}}` | 预渲染的位置标签（`file:line`） |
| `{{problem.severity}}` | `info` / `low` / `medium` / `high` / `critical` |
| `{{problem.category}}` | 短问题族（如 `correctness`、`security`） |
| `{{problem.message}}` | 问题分析：错在哪、触发场景、影响 |
| `{{problem.suggestion}}` | 可选的修复方向；可包含 fenced `diff` 补丁 |
| `{{problem.codeSnippet}}` | 可选的 AICR 派生代码引用片段（Git 类 channel） |
| `{{problem.codeLanguage}}` | 片段检测到的语言 |
| `{{{problem.codeFence}}}` | 预构建的 fenced 代码块（使用三花括号——已是转义后的 HTML） |

### 作者渲染

对于 Git 类 channel（`gitea_*`、`github_*`、`gitlab_mr_review`），内置模板在能拿到 provider 用户名时优先使用
`@username`。如果同时有显示名，则渲染为 `@username (Display Name)`，这样平台仍能解析 mention，而人眼看到的是昵称。IM bot summary 模板（`feishu_bot`、`wecom_bot`）对事件作者使用同样的可读 `@username (Display Name)` 约定；原生 bot mention 在启用时通过单独的 `{{atMentions}}` 路径流动。

### 已移除的变量

模板必须使用 `{{problems}}` 和 `{{problem.*}}`。已废弃的 `{{findings}}` 和 `{{finding.*}}` 不再提供。同样，不要为非 PR/MR 事件渲染 `[View PR]`——改用 `target.markdownLink` 或 `target.displayText`。

## URL 模板变量

trigger 和 channel 接受 URL 模板（`commit_url_template`、`revision_url_template`、`change_url_template`），用于不暴露可推导 commit/revision URL 的 provider（P4 Swarm、ViewVC、自定义评审 UI）。值在替换前会做 **URL 编码**。支持的变量：

`{{revision}}`、`{{commit}}`、`{{commit_id}}`、`{{headSha}}`、`{{head_sha}}`、`{{baseSha}}`、`{{base_sha}}`、`{{repo}}`、`{{repo_ref}}`、`{{provider}}`、`{{trigger}}`、`{{workspace_id}}`。

```yaml
triggers:
  - name: p4-main
    kind: p4
    change_url_template: "https://swarm.example.com/changes/{{revision}}"

outputs:
  channels:
    - name: feishu-code-review
      kind: feishu_bot
      revision_url_template: "https://review.example.com/revisions/{{revision}}"
```

## Handlebars 示例

一个 workspace 级的 Feishu summary 覆盖模板。放在
`workspaces/p4-main/templates/feishu_bot.summary.hbs`：

```handlebars
**{{target.displayText}}**{{#if event.author}}
**Author**: @{{event.author}}{{#if event.email}} <{{event.email}}>{{/if}}{{/if}}{{#if vcs.sourcePath}}
**Source**: {{vcs.sourcePath}}{{/if}}{{#if vcs.workspace}}
**Workspace**: {{vcs.workspace}}{{/if}}
{{{summary}}}
```

一个遍历 problem 列表的 problem-comment 模板：

```handlebars
## {{summaryTitle}}

{{#if atMentions}}{{atMentions}} {{/if}}Reviewed {{target.displayText}}.

{{{summary}}}

{{#each problems}}
### [{{severity}}] {{category}} — {{location}}

{{message}}

{{#if suggestion}}
**Suggested fix**

{{suggestion}}
{{/if}}

{{#if codeFence}}
{{{codeFence}}}
{{/if}}
{{/each}}
```

注意事项：

- 对已经包含渲染后 Markdown 或 HTML 的字段（`summary`、`codeFence`），使用三花括号（`{{{ }}}`）；对纯文本字段使用双花括号（`{{ }}`），让 Handlebars 转义它们。
- 渲染后，AICR 会在发布前修复并校验 Markdown。如果模板无法变得安全且有效，AICR 会优先使用纯文本回退，而不是丢弃报告。
- 部署前用 [`lint` CLI 命令](/zh-cn/reference/cli/#lint) 校验模板。
