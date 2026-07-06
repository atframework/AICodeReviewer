---
title: 常见问题
description: 常见问题及诊断与修复方法。
---

本页是运行 AICR 时最常遇到的问题的 FAQ 式索引。每条都给出症状、诊断和修复。各组件的深入背景请跟随交叉链接。

任何部署问题的第一步都可以是 [`doctor` CLI 命令](/zh-cn/reference/cli/#doctor)，它会打印 Node 版本、解析到的二进制路径、沙箱引擎可用性和配置健康度。

## Webhook 鉴权失败（HMAC 密钥不匹配）

**症状：** VCS 报告 webhook 投递返回非 2xx，或 AICR 日志报签名校验失败；没有 run 被调度。

**诊断：** VCS 端配置的 HMAC 密钥与 `triggers[].webhook_secret_env` 指向的环境变量不一致。入站两层认证相互独立：`/webhooks/*` 用 HMAC，`/triggers/*` 用 API key——两者永不在同一请求上组合。

**修复：**

- 确认 `.env` 中的值（如 `AICR_WEBHOOK_SECRET`）与 Gitea/GitHub webhook 设置中的 **Secret** 字段，或 GitLab 的 **Secret token** 完全一致。
- Gitea/Forgejo 校验 `x-gitea-signature-256`；GitHub 校验 `x-hub-signature-256`；GitLab 对 `x-gitlab-token` 做明文 token 比较。
- 如果 trigger 上省略 `webhook_secret_env`，会跳过签名校验（生产环境不推荐）。

参见[认证与密钥](/zh-cn/configuration/authentication/)。

## 输出通道未发布

**症状：** 评审完成且有问题，但目标 channel 没有任何输出；run 被标记为跳过且 `skipReason="no_output_publisher"`。

**诊断：** 没有summary 路由为该事件选中可发布的 channel。这通常发生在事件的 trigger/target_kind 不匹配任何 `outputs.routes.rules[]` 条目，且没有匹配的 workspace 级 `outputs.summary` 时。

**修复：** 添加 `outputs.routes.rules[].summary` 规则，或为该 trigger/target 添加 workspace 级 `outputs.summary`。例如把 GitHub push 评审发到 Feishu bot：

```yaml
outputs:
  routes:
    rules:
      - match:
          trigger: github
          target_kind: push
        summary: [feishu-code-review]
```

如果所有配置的 summary channel 都抑制零问题结果，run 会以 `skipReason="no_problems_suppressed"` 跳过。`no_problems` 策略和路由参见[输出通道](/zh-cn/integrations/output-channels/)。

## Agent 结构化输出修复失败

**症状：** agent 只产出自然语言散文；AICR 日志显示结构化修复尝试；IM channel 始终收不到 problem 报告。

**诊断：** agent 自由文本 stdout 永远不是最终报告。当 stdout 中无可解析的 AICR tool payload 时，AICR 会要求 agent 做一次有界结构化修复。如果修复输出仍是散文但明确表示无问题或无可评审代码，AICR 会归一化为跳过（`lgtm` / `no_reviewable_code`），而不是发布 fallback 错误 summary。否则会回退到直连 LLM 修复调用。

**修复：** 这是预期行为，不是 bug——它防止中间思考泄露到 IM 卡片，并确保 problem 位置来自 `aicr.report_problem`。如果你预期有问题，请确认 agent 拿到了所需上下文：它应通过 `aicr.fetch_more_context` 请求文件，或用只读 shell 工具检查已物化的源码。参见 [MCP 工具](/zh-cn/integrations/mcp-tools/)。

## 上下文溢出（`AgentContextOverflowError`）

**症状：** 评审以 `AgentContextOverflowError` 失败，并给出 model limit 和请求的 token 数。

**诊断：** agent CLI 的对话超出了 model 的 context window。Kilo 只为声明了 `contextWindow` 的 model 自动压缩；如果禁用了 model catalog 又没设 `context_window` 覆盖，Kilo 会静默跳过压缩，大 PR 会溢出。

**修复：**

- 启用 `llm.model_catalog.enabled: true`，让 AICR 把 `contextWindow` 注入 agent model info，**或**
- 在 `llm.model_catalog.overrides` 下显式设置 `context_window`。
- 对于特别大的 diff，也调一下 `compression.trigger_tokens`（缺省时 AICR 会从 context window 派生默认值）。

按 agent 的压缩行为参见 [Agent 适配器](/zh-cn/integrations/agent-adapters/)。

## Kilo MCP 状态未写入

**症状：** Kilo 评审完成但 AICR 报告没有结构化结果，或 run 循环/跳过/饿死。

**诊断：** Kilo spawn 的 MCP server 把 `.aicr-output-state.json` 写到了错误目录，orchestrator 没看到它。

**修复：**

- 容器/沙箱 workdir 必须是 `/workspace/agent`（可写的 agent 挂载）。任何其他 workdir 都会让状态文件落到镜像 workdir（如 `/app`）下从而被漏掉。
- 确认 agent 调用 AICR 工具后，run 的 `agent/` 目录下出现 `.aicr-output-state.json`。
- AICR 在每次 run 前清理旧状态；如果你看到“无法访问完整仓库代码”被发布为最终报告，可能是旧状态文件泄漏——重启容器以回收任何孤立的 agent 进程。

输出状态流转参见 [MCP 工具](/zh-cn/integrations/mcp-tools/)。

## Git / P4 / SVN 额外上下文获取失败

**症状：** orchestrator 日志出现 `ignored invalid fetch_more_context tool call`，或 agent 报告无法访问评审所需文件。

**诊断：** `aicr.fetch_more_context` 初始只写入变更文件。agent 询问的相关但未变更文件（如被变更 `.cpp` 引用的头文件）会按评审 revision 从 VCS 按需拉取。请求一个在该 revision 不存在的路径会被拒绝——这个拒绝就是“停止重试该路径”的信号。

**修复：**

- git：AICR 回退到 `git show <revision>:<path>`；如果仍失败，说明该路径在该 revision 确实不存在（或是子模块 gitlink），agent 应停止重试。
- P4：相关文件在配置的 depot 内用 `p4 print <path>@<revision>` 拉取；depot 外路径被拒绝。
- SVN：相关文件从 `<repository_url>/<path>@<revision>` 拉取；配置 `repository_url` 之外的 URL 被拒绝。

不要把缺失文件当作不可访问来报告——通过 `aicr.fetch_more_context` 请求它们，让 AICR 物化。

## Podman rootless / 嵌套容器问题

**症状：** rootless Podman 在重启或 OOM 后失败，报误导性错误 `"invalid internal status ... could not find any running process"`，或 `podman system migrate` 以空指针崩溃。

**诊断：** 真正原因是在 `/etc/containers/storage.conf` 中设置了自定义 `rootless_storage_path` 时的存储层初始化失败，不是缺少 pause 进程。

**修复：** 用 `podman --storage-driver=overlay system migrate` 恢复，并在部署脚本的所有 `podman build/run/rm` 命令上加 `--storage-driver=overlay`。在部署脚本顶部加预检：

```bash
podman ps || podman --storage-driver=overlay system migrate
```

对于嵌套容器沙箱（AICR 自身运行在容器内），通过 `AICR_ENABLE_CONTAINER_SANDBOX=true bash deploy/deploy.sh` 启用，并优先用 `sandbox.kind: podman` 加 `engine: podman`。参见 [Podman / rootless](/zh-cn/deployment/podman/)。

## Feishu / WeCom Markdown 渲染

**症状：** Feishu 中 inline code 或 fenced 代码块渲染成字面反引号，或 WeCom 消息被中途截断。

**诊断与修复：**

- **Feishu** 要求 JSON 卡片 2.0 schema。AICR 发送 `card.schema = "2.0"` 的卡片，让 inline `code`、带语言高亮的 fenced 代码块、标题、引用块和表格原生渲染。如果你覆盖 Feishu 模板，请把 markdown 元素放在 `card.body.elements` 下，不要把标题/表格降级为纯文本——那些 1.0 时代的转换会损害 2.0 渲染。
- **WeCom** 群 bot 消息被截断到 500 字符、建议截断到 300 字符（带 `...` 后缀），以适配大小限制。表格被铺平为纯文本行。AICR 在分派前自动应用 `toWeComMarkdown()`。

按 channel 的渲染说明参见[输出通道](/zh-cn/integrations/output-channels/)。

## GitHub Pages base-path 404

**症状：** 本文档站点（或任何托管在 GitHub Pages 的 AICR Web UI）对静态资源或深链接返回 404。

**诊断：** Astro 的 `site`、`base` 或 `CNAME` 与生产 GitHub Pages 目标不一致。本文档站点发布在自定义域名根路径 `https://aicr.atframe.work/`，因此不能使用 project page 的 `base` 路径。

**修复：** 在 `astro.config.mjs` 中保留自定义域名 `site`，不要设置 `base`：

```js
export default defineConfig({
  site: "https://aicr.atframe.work",
  // ...
});
```

保持 `public/CNAME` 为 `aicr.atframe.work`，并在仓库 Settings > Pages 中使用 `gh-pages` / `/` 发布源和同一个 custom domain。

## 评审挂起或越来越慢

**症状：** `durationMs` 远超 `agent.timeout_seconds`，重试越来越慢。

**诊断：** 某个 agent 二进制（如 Kilo）会 `setsid` 把 worker 子进程放进新 session，进程组信号够不到它们；它们存活、被 reparent 到 PID 1、持有继承的 stdio，形成 CPU 耗尽死亡螺旋。

**修复：** 沙箱在超时时会杀整棵进程树，但要从已陷入螺旋的服务恢复，**重启容器**让运行时回收所有孤立进程。确保容器以 `--init` 运行，让 PID 1 回收僵尸。相关说明见 [Docker Compose 部署](/zh-cn/start/docker-compose/)。

## 修改配置后 run 仍引用旧值

**症状：** 你修改了 `config.yaml` 或 `.env`，但服务仍用旧值。

**诊断：** 配置和 env 文件是挂载的，不是烘焙进镜像的，因此只在容器重启时重新加载。

**修复：** `docker compose restart`（或重启本地 `serve` 进程）。只有代码变更才需要完整重建镜像。

## Dashboard 显示需要配置 / admin 未配置

**症状：** `/dashboard` 返回需要配置的页面，或 `POST /api/admin/login` 返回 401。

**诊断：** 可观测性 dashboard 有**独立**的超级管理员登录（`admin.*`），与 webhook HMAC
和 trigger API key 无关。如果 `config.yaml` 中未设置 `admin.username_env` 加
`admin.password_env`（或 `admin.password_hash_env`），或引用的环境变量为空，dashboard
会被禁用。

**修复：** 设置三个 admin 环境变量并在 `config.yaml` 中引用：

```yaml
admin:
  username_env: AICR_ADMIN_USERNAME
  password_hash_env: AICR_ADMIN_PASSWORD_HASH   # sha256:<hex>，推荐
  session_ttl_seconds: 86400                      # 24 小时；单位是秒，不是分钟
```

修改后重启容器。生产环境优先用 `password_hash_env`（`sha256:<hex>`），而非 raw `password_env`。

## GitHub issue/评论写回失败（403 / 404）

**症状：** `github_problem_issue` 或 `github_pr_review` 无法发布；日志显示 GitHub API 返回
403 或 404。

**诊断：** 对于回写仓库的 GitHub channel，`token_env`（或通道级覆盖）必须是**出站** API 凭据，
且具有仓库 Issues 读写权限——它不是 webhook secret。在 GitHub webhook 事件列表中勾选
**Issues** 或 **Issue comments** 只控制哪些**入站**事件被投递，**不授予** REST API 权限。

**修复：**

- 个人访问令牌：确保具有 `repo` scope（或目标仓库上的细粒度 `Issues: Read and write` 权限）。
- GitHub App：更新仓库权限后，**重新安装或刷新安装**再重试——权限变更不会追溯应用到已有安装。
- 确认 `triggers[].token_env` 或通道级覆盖引用的是出站凭据，而不是 `AICR_GITHUB_WEBHOOK_SECRET`。
