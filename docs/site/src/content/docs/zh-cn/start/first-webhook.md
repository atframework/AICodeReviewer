---
title: 第一个 Webhook 评审
description: 把 Gitea webhook 接入 AICR，触发首次 PR 评审，并验证 run 已被调度。
---

本页讲解如何把 Gitea webhook 接入运行中的 AICR 服务、触发首次 pull-request 评审，并确认 run 已被调度并完成。完整的按 provider 参考参见 [VCS 提供商](/zh-cn/integrations/vcs-providers/)；webhook 密钥背后的认证模型参见[认证与密钥](/zh-cn/configuration/authentication/)。

## 前置条件

- AICR 正在运行，且 `curl http://<aicr-host>:8080/healthz` 返回 `ok`。参见[快速上手](/zh-cn/start/quick-start/)。
- 已对本地检出成功跑过一次 [dry-run 评审](/zh-cn/start/dry-run/)，确认 LLM、agent 和沙箱已知可用。
- 一个你有管理员权限的 Gitea 仓库。

## 1. 配置 trigger 和 workspace

在 `config.yaml` 中声明 Gitea trigger 并把一个 workspace 绑定到它。trigger 按环境变量**名**引用 webhook 密钥；真正的密钥值放在 `.env`。

```yaml
triggers:
  - name: gitea
    kind: gitea
    webhook_secret_env: AICR_WEBHOOK_SECRET
    base_url: https://gitea.example.com

outputs:
  channels:
    - name: gitea-pr-review
      kind: gitea_pr_review
      trigger: gitea
      token_env: AICR_GITEA_TOKEN
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]

workspaces:
  instances:
    my-repo:
      source_repo:
        trigger: gitea
        repo: "my-org/my-repo"
      outputs:
        line_comments: [gitea-pr-review]
        summary: [gitea-pr-review]
```

生成强 webhook 密钥并放入 `.env`：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
# .env
AICR_WEBHOOK_SECRET=<生成的密钥>
AICR_GITEA_TOKEN=<具有 repo 读+评论权限的 token>
```

重启服务使新配置生效：

```bash
docker compose restart   # 或重启本地 serve 进程
```

## 2. 在 Gitea 添加 webhook

在 Gitea 仓库中：

1. 进入 **Repository → Settings → Webhooks → Add Webhook → Gitea**。
2. **Target URL**：`http://<aicr-host>:8080/webhooks/gitea`。
3. **Content type**：`application/json`。
4. **Secret**：粘贴 `.env` 中 `AICR_WEBHOOK_SECRET` 的精确值。密钥不匹配是 webhook 鉴权失败最常见的原因——参见[常见问题](/zh-cn/troubleshooting/)。
5. **Events**：勾选 **Pull Request**。要在评审人被请求时触发主动 re-review，还需启用 Gitea/Forgejo 的 `pull_request_review_request` 事件；AICR 在 `review_requested` action 上触发，忽略 `review_request_removed`。
6. 保存。

:::note[GitHub]
对于 GitHub 仓库，把 webhook 指向 `/webhooks/github`，设置与 `AICR_GITHUB_WEBHOOK_SECRET` 相同的 HMAC 密钥，并订阅 **Pull requests**。AICR 把 `pull_request` 的 `review_requested` action 作为 PR re-review 触发器。
:::

## 3. 触发首次评审

在仓库中开一个 pull request（或向已有 PR 推送新 commit）。Gitea 会把一个 `pull_request` 事件投递给 AICR。

如果是 push/commit 事件，直接推送到分支——AICR 评审 commit 范围。建分支和删分支事件（全零 SHA）会被自动跳过。

你也可以随时在 PR 上评论触发手动 re-review：

```text
/aicr review
```

在 async 模式下，对同一 target 的重复 `/aicr review` 命令会被合并：当前评审先完成，然后 AICR 用最新事件跑一次最终 re-review。

## 4. 验证 run 已被调度

观察服务日志中是否出现被调度的 run 和完成的 `reviewRun`：

```bash
docker compose logs -f | grep -E "reviewRun|dispatchCount"
```

然后检查目标：

- PR 上应该有 AICR 评审或 summary 评论（managed 评论带隐藏的 `<!-- aicr:managed=pr-review -->` 标记）。
- 如果你配置了到 Feishu/WeCom 的 summary 路由，IM channel 应收到聚合报告。

如果最终报告只说“无法访问完整仓库/源码”，这是**失败的**验收，除非 agent 先通过 `aicr.fetch_more_context` 请求了具体上下文，且 AICR 重跑了最终 pass。该流程参见 [MCP 工具](/zh-cn/integrations/mcp-tools/)。

## 5. 检查 run（可选）

如果启用了 dashboard，访问 `http://<aicr-host>:8080/dashboard` 在最近运行列表中查看该 run，或读取 `/metrics` 获取进程级计数器。run 快照位于 `workspaces/<workspace_id>/runs/<run_id>/`——参见 [Dashboard 与日志](/zh-cn/start/dashboard/)。

## 下一步

- [输出通道](/zh-cn/integrations/output-channels/)——把 problem 和 summary 路由到 PR 评论、issue 和 IM 卡片。
- [常见问题](/zh-cn/troubleshooting/)——诊断 webhook 鉴权失败和“no output publisher”跳过。
