---
title: Dry-run 评审
description: 通过 CLI 运行一次性评审，不发布任何输出，并解读本地结果。
---

`aicr review` 命令无需长驻服务即可运行单次评审。加上 `--dry-run` 会准备并运行完整评审流水线，但跳过所有输出 channel，因此你可以在不污染 PR 或 IM channel 的情况下验证 LLM、agent 和沙箱。本页在[快速上手的 dry-run 段落](/zh-cn/start/quick-start/#dry-run-评审)基础上展开。

完整 CLI 命令参考参见 [CLI 命令](/zh-cn/reference/cli/)。

## 何时使用 dry-run

- 在向 webhook 开放服务前，验证 LLM 凭据、agent CLI 和沙箱配置正确。
- 在不发布的情况下迭代 prompt、技能或模型选择。
- 从本地检出本地复现一次评审。

无论 `outputs.routes` 如何配置，dry-run 都**不会**向任何 channel 发布。非 dry-run 评审若没有匹配的输出路由，会被记录为跳过且 `skipReason="no_output_publisher"`——那是路由问题，不是 dry run。

## 运行 dry-run

```bash
export AICR_LLM_API_KEY=sk-xxx

node packages/cli/dist/index.js review \
  --config example/config.yaml \
  --repo "my-org/my-repo" \
  --provider gitea \
  --source-root . \
  --dry-run
```

## 参数

| 参数 | 描述 |
| --- | --- |
| `--config <path>` | config YAML 文件路径 |
| `--repo <ref>` | 仓库引用（如 `owner/repo`） |
| `--provider <name>` | config schema 中的 trigger provider kind（`gitea`、`github`、`gitlab`、`p4`、`svn`） |
| `--trigger <name>` | trigger 名 |
| `--reason <text>` | 评审原因 |
| `--source-root <path>` | 待评审的源码根目录 |
| `--base-prompt <path>` | base system prompt 模板路径（覆盖 workspace prompt 文件） |
| `--changed-file <path>` | 变更文件（可重复） |
| `--base-sha <sha>` | base revision SHA |
| `--head-sha <sha>` | head revision SHA |
| `--url <url>` | PR / MR / commit URL |
| `--author-username <u>` | 作者用户名 |
| `--author-email <e>` | 作者邮箱 |
| `--dry-run` | 运行但不发布到输出 channel |
| `--max-prompt-tokens <n>` | 最大 prompt token 预算 |

`--provider` 选择应用哪个 trigger profile 的 VCS 适配器和过滤规则。`--source-root` 指向本地检出；与 `--changed-file`（或 `--base-sha` / `--head-sha`）配合来界定 diff 范围。

## 解读结果

dry-run 会打印解析出的评审 summary、报告的 problem 列表（如果有）以及跳过时的跳过原因。常见跳过原因：

| 跳过原因 | 含义 |
| --- | --- |
| `lgtm` | 未发现可操作问题 |
| `no_reviewable_code` | 变更中没有可评审内容 |
| `no_output_publisher` | 没有匹配的输出路由（仅非 dry-run） |
| `no_problems_suppressed` | 所有选中的 summary channel 都抑制了零问题结果 |
| `output_dispatch_failed` | 所有分派尝试都失败 |

如果 dry-run 报告了 problem，说明 LLM 和流水线健康。如果报 `AgentContextOverflowError` 错误，请启用 `llm.model_catalog` 或设置 `context_window` 覆盖——参见[常见问题](/zh-cn/troubleshooting/)。

## 下一步

dry-run 干净后，接入你的[第一个 webhook](/zh-cn/start/first-webhook/)，让真实 VCS 事件驱动评审。
