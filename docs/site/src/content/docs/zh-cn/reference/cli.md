---
title: CLI 命令
description: aicr CLI 全部子命令与参数参考。
---

`aicr` CLI（由 `packages/cli` 构建）是服务、一次性评审、eval、replay、memory 查看和模板
校验的入口。先用 `pnpm build` 构建，再通过 Node 调用：

```bash
node packages/cli/dist/index.js <command> [options]
```

在 Linux/CI 等 `pnpm` 可直接运行的环境中，调用方式相同。随时用 `--help` / `-h` 查看帮助。

## 命令

| 命令 | 用途 |
| --- | --- |
| [`serve`](#serve) | 启动 webhook 服务 |
| [`review`](#review) | 运行代码评审（prompt 准备或完整 dry-run） |
| [`eval`](#eval) | 对配置的 LLM 运行评测基准 |
| [`replay`](#replay) | 回放已存储的评审 run 脚手架 |
| [`memory`](#memory) | 查看或清除 workspace memory |
| [`lint`](#lint) | 校验模板或配置脚手架 |
| [`doctor`](#doctor) | 打印环境诊断信息 |
| `help` | 显示帮助信息 |

## 全局参数

| 参数 | 说明 |
| --- | --- |
| `--config <path>` | 配置 YAML 文件路径 |
| `--workspace <id>` | Workspace ID |
| `--help`, `-h` | 显示帮助 |
| `--version`, `-v` | 显示版本 |

## serve

启动接收 webhook 和 trigger 事件的 HTTP 服务。

```bash
node packages/cli/dist/index.js serve \
  --config example/config.yaml \
  --port 8080
```

| 参数 | 说明 |
| --- | --- |
| `--port <number>` | HTTP 监听端口（默认 8080） |

服务暴露 `/healthz`、`/metrics`、`/dashboard`、`/api/admin/*`、`/webhooks/*`、
`/triggers/*`。各路由的鉴权方式见[认证与密钥](/zh-cn/configuration/authentication/)。

## review

不启动常驻服务，运行单次评审。加 `--dry-run` 会准备并运行评审，但跳过所有输出通道。

```bash
node packages/cli/dist/index.js review \
  --config example/config.yaml \
  --repo "my-org/my-repo" \
  --provider gitea \
  --source-root . \
  --dry-run
```

| 参数 | 说明 |
| --- | --- |
| `--repo <ref>` | 仓库引用（owner/repo） |
| `--provider <name>` | 配置 schema 中的 trigger provider 类型 |
| `--trigger <name>` | Trigger 名称 |
| `--reason <text>` | 评审原因 |
| `--source-root <path>` | 源码根目录 |
| `--base-prompt <path>` | 基础 system prompt 模板路径 |
| `--changed-file <path>` | 变更文件（可重复） |
| `--base-sha <sha>` | Base revision SHA |
| `--head-sha <sha>` | Head revision SHA |
| `--url <url>` | PR / MR / commit URL |
| `--author-username <u>` | 作者用户名 |
| `--author-email <e>` | 作者邮箱 |
| `--dry-run` | 运行但不发布到输出通道 |
| `--max-prompt-tokens <n>` | Prompt token 预算上限 |

## eval

运行评测 fixture。无密钥时，`--validate-only` 只校验 fixture 形状和预期 problem 契约——
这是 CI 运行的模式。

```bash
# 仅校验 fixture（无需 LLM、无需 config 密钥）
node packages/cli/dist/index.js eval --validate-only

# 完整基准运行（加载 config + LLM；需要 AICR_LLM_API_KEY 等）
node packages/cli/dist/index.js eval --eval-dir eval/
```

| 参数 | 说明 |
| --- | --- |
| `--eval-dir <path>` | 包含 eval JSON fixture 的目录 |
| `--validate-only` | 仅校验 fixture，不加载 config 或 LLM |

Fixture 位于 `eval/*.json`。根 CI 流水线在每次变更时运行 `pnpm eval:validate`
（即 `eval --validate-only`）。

## replay

回放已存储的评审 run 脚手架——用于从已捕获的输入复现历史 run，无需重新从 VCS 拉取。

```bash
node packages/cli/dist/index.js replay \
  --config example/config.yaml \
  --run-id <id>
```

| 参数 | 说明 |
| --- | --- |
| `--run-id <id>` | 要回放的 run ID |

## memory

查看或清除 workspace 反思/memory 脚手架。memory 按 workspace 隔离；清除不会跨 workspace。

```bash
# 查看 workspace 的 memory
node packages/cli/dist/index.js memory --workspace <id>

# 包含完整文件内容
node packages/cli/dist/index.js memory --workspace <id> --all

# 清除特定 scope（如 false-positives）
node packages/cli/dist/index.js memory clear --workspace <id> --scope false-positives
```

| 参数 | 说明 |
| --- | --- |
| `--workspace <id>` | Workspace ID |
| `--scope <scope>` | 清除的 memory scope（`false-positives`、`recurring-issues` 等） |
| `--all` | `memory show` 时包含完整文件内容 |

`memory` 子命令：`show`（默认）、`clear`。

## lint

校验模板或配置脚手架。针对示例上下文渲染单个模板，在部署前捕获模板错误。

```bash
node packages/cli/dist/index.js lint \
  --template path/to/template.hbs \
  --template-kind summary
```

| 参数 | 说明 |
| --- | --- |
| `--template <path>` | 要渲染和校验的模板文件 |
| `--template-kind <kind>` | 模板类型：`summary` 或 `problem` |
| `--channel-kind <kind>` | 校验示例上下文使用的输出 channel 类型 |

## doctor

打印环境诊断——Node 版本、解析到的二进制路径、沙箱引擎可用性和配置健全性。排障时建议
作为第一步。

```bash
node packages/cli/dist/index.js doctor --config example/config.yaml
```

`doctor` 只接受全局 `--config` 参数。
