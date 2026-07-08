---
title: 认证与密钥
description: AICR 的三层认证模型，以及 .env 与 config.yaml 的密钥约定。
---

AICodeReviewer 使用**三层相互独立**的认证。它们保护不同的端点，不能混淆——
尤其是 webhook HMAC 与 API key 永远不会在同一个请求上组合使用。

| 层 | 范围 | 保护对象 | 配置位置 |
| --- | --- | --- | --- |
| Webhook HMAC | 按 trigger | 入站 VCS webhook（`/webhooks/*`） | `triggers[].webhook_secret_env` |
| 服务端 API key | 全局 | `/triggers/*` 路由（P4、SVN、自定义脚本） | `server.auth.api_key_env` |
| Workspace API key | 按 workspace | 同服务端 key，但限定 workspace | `workspaces.instances.<id>.auth.api_key_env` |

可观测性 dashboard 有**独立**的超级管理员登录（`admin.*`），不复用 webhook
HMAC 或 trigger API key。

:::caution[端点对应关系]
`/webhooks/*`（Gitea、Forgejo、GitHub、GitLab）**仅**由 HMAC 保护。
`/triggers/*`（P4、SVN）**仅**由 API key 保护。两层互相独立，从不组合。
:::

## 第一层 —— Webhook HMAC（按 trigger）

每个 trigger 类型使用特定的验证机制：

| Trigger 类型 | 配置字段 | 机制 | HTTP 头 | VCS 侧设置位置 |
| --- | --- | --- | --- | --- |
| `gitea` / `forgejo` | `webhook_secret_env` | HMAC-SHA256 | `x-gitea-signature-256` | Gitea webhook → Secret |
| `github` | `webhook_secret_env` | HMAC-SHA256 | `x-hub-signature-256` | GitHub webhook → Secret |
| `gitlab` | `webhook_secret_env` | Token 比对 | `x-gitlab-token` | GitLab webhook → Secret token |
| `p4` | `server.auth` | API key | `x-api-key` | `p4-trigger.sh` 发送 key |
| `svn` | `server.auth` | API key | `x-api-key` | `svn-trigger.sh` 发送 key |

生成密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

配置示例：

```yaml
triggers:
  - name: gitea
    kind: gitea
    webhook_secret_env: AICR_WEBHOOK_SECRET  # 持有密钥的环境变量
```

如果省略 `webhook_secret_env`，签名验证会被**跳过**——生产环境不推荐。

### 同一 webhook 路由上的多 profile

GitHub 和 GitLab 可以在**同一路由**（`/webhooks/github` 或 `/webhooks/gitlab`）
上定义多个 trigger profile。当不同仓库需要不同的出站 token、webhook secret 或
文件过滤规则时，使用独立的 trigger 名称；AICR 根据已验证的凭据加上 webhook
payload 中的仓库身份，选择最终的 profile。

## 第二层 —— 服务级 API key（仅 trigger）

用共享 API key 保护 `/triggers/*` 路由。VCS webhook（`/webhooks/*`）**不受**
影响——它们使用 HMAC。

trigger 端点的调用方发送 `X-API-Key: <key>` 或
`Authorization: Bearer <key>`。

```yaml
server:
  auth:
    api_key_env: AICR_API_KEY    # 持有全局 API key 的环境变量
    enabled: true                # 设为 false 可临时禁用
```

## 第三层 —— 按 workspace 的 API key（可选覆盖）

单个 workspace 可以有自己的 API key：

```yaml
workspaces:
  instances:
    my-repo:
      source_repo: { trigger: gitea, repo: "org/repo" }
      auth:
        api_key_env: AICR_MY_REPO_API_KEY
        enabled: true
```

全局 key 和 workspace key 都会被接受——请求匹配**任意一个**配置的 key 即放行。

## 可观测性 dashboard 管理员

设置 `admin.username_env` 加 `admin.password_env` 或 `admin.password_hash_env`
以启用内置 dashboard：

- `GET /dashboard` 和 `GET /` 提供内嵌 SPA。
- `POST /api/admin/login` 返回 Bearer session token。
- `GET /api/admin/stats` 返回全部时间、今天、本周、本月统计，以及
  project/provider/最近 run 数据。

生产环境优先使用 `password_hash_env`（格式 `sha256:<hex>`）；小型内网部署允许
raw password env，但会用定长 digest 比较、限速，且绝不写入日志。

:::note[Session TTL]
管理员 session TTL 字段是 `session_ttl_seconds`（默认 `86400` = 24 小时）。
名为 `session_ttl_minutes` 的字段会被忽略。
:::

## 密钥：`.env` 与 `config.yaml`

所有密钥放在 `.env`（或你的 secret manager）。`config.yaml` **只写环境变量名**，
不写值。这样 `config.yaml` 可以安全提交和 review。

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ .env（环境变量 —— 切勿提交到 git）                                       │
│                                                                         │
│ ── 入站：Webhook HMAC 密钥（保护 /webhooks/*）──                         │
│ AICR_WEBHOOK_SECRET=7f3a...        ← 与 Gitea webhook 配置共享          │
│ AICR_GITHUB_WEBHOOK_SECRET=b2c1... ← 与 GitHub webhook 配置共享         │
│ AICR_GITLAB_WEBHOOK_SECRET=d4e5... ← 与 GitLab webhook 配置共享         │
│                                                                         │
│ ── 入站：API key（保护 /triggers/* 如 P4/SVN）──                         │
│ AICR_API_KEY=c6d7e8f9...           ← p4-trigger.sh / svn-trigger.sh     │
│                                                                         │
│ ── 出站：AICR 调用外部服务 ──                                            │
│ AICR_GITEA_TOKEN=4b5d...           ← AICR → Gitea API（发布评论）       │
│ AICR_P4USER=p4-ci                  ← AICR → P4 服务（拉取文件）         │
│ AICR_P4PASSWORD=vUF_...            ← AICR → P4 服务（拉取文件）         │
│ AICR_FEISHU_SECRET=3Ob2...         ← AICR → 飞书 API（发送卡片）        │
│ AICR_LLM_API_KEY=sk-...            ← AICR → LLM API（补全）             │
└─────────────────────────────────────────────────────────────────────────┘
```

对于回写仓库的 GitHub 通道，`token_env`（或通道级覆盖，或 trigger 级 `app` 块——见
[VCS 提供商](/zh-cn/integrations/vcs-providers/)）必须是**出站** API 凭据，
而不是 webhook secret。`github_problem_issue` 特别需要仓库 Issues 读写权限。在
GitHub webhook 事件列表中勾选 **Issues** 或 **Issue comments** 只控制哪些入站事件
被投递，**不授予** REST API 权限。
