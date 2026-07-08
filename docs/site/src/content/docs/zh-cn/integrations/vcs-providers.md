---
title: VCS 提供商
description: 将 GitHub、Gitea/Forgejo、GitLab、Perforce (P4) 和 Subversion (SVN) 接入 AICR。
---

AICR 从两类来源接入评审事件：

- **Webhook 提供商** —— GitHub、Gitea、Forgejo、GitLab。它们 POST 到
  `/webhooks/{gitea,forgejo,github,gitlab}`，由 HMAC 或 token 验证。
- **Trigger 提供商** —— Perforce (P4)、Subversion (SVN)。VCS 服务端 hook 脚本把最小元数据
  POST 到 `/triggers/{p4,svn}`，由 API key 鉴权；AICR 再用自己的 VCS 凭据拉取 diff。

两者都归一为同一个 `ReviewEvent`。本页介绍配置和按提供商的接入步骤；各提供商的鉴权机制
见[认证与密钥](/zh-cn/configuration/authentication/)。

## Webhook 提供商

### Gitea / Forgejo

添加 trigger，并把仓库 webhook 指向 AICR。

```yaml
triggers:
  - name: gitea
    kind: gitea              # Forgejo 实例用 "forgejo"
    base_url: https://git.example.com
    token_env: AICR_GITEA_TOKEN                 # 出站（发评论、读文件）
    webhook_secret_env: AICR_WEBHOOK_SECRET      # 入站（HMAC 校验）
    # 可选文件过滤（省略 = 全部分析）：
    # watch_path: ["src/", "include/"]
    # include_cr_file: ["**/*.cpp", "**/*.h"]
    # exclude_cr_file: ["**/*.gen.cpp"]
```

Gitea 中配置 webhook：

1. **仓库 → Settings → Webhooks → Add Webhook → Gitea**
2. **Target URL**：`http://<aicr-host>:8080/webhooks/gitea`
3. **Content type**：`application/json`
4. **Secret**：与 `AICR_WEBHOOK_SECRET` 相同的值
5. **Events**：勾选 **Pull Request**。如需在指定 reviewer 时自动重审，还需启用
   `pull_request_review_request` 事件；AICR 在 `review_requested` 动作上触发，
   忽略 `review_request_removed`。

### GitHub

```yaml
triggers:
  - name: github
    kind: github
    base_url: https://github.com     # github.com 可省略；GitHub Enterprise 填 GHE URL
    token_env: AICR_GITHUB_TOKEN
    webhook_secret_env: AICR_GITHUB_WEBHOOK_SECRET
```

把仓库 webhook 指向 `http://<aicr-host>:8080/webhooks/github`，secret 设为与
`AICR_GITHUB_WEBHOOK_SECRET` 相同的 HMAC 密钥，订阅 **Pull requests**。AICR 把
`pull_request` 的 `review_requested` 动作当作 PR 重审 trigger。

对于评论触发的重审，配置 `token_env`（或 GitHub App `app` 块——见下文）以便 AICR 拉取 PR
head/base SHA 和分支信息。若该拉取不可用，AICR 用评论 payload 中的 PR URL 作为去重标识，而不会
把不相关的 PR 合并到 `unknown` 目标。

#### GitHub App 认证（M12）

除了静态 PAT，还可以配置 GitHub App，让 AICR 签发 RS256 JWT 并自动刷新 installation token
（零新增依赖）：

```yaml
triggers:
  - name: github-app
    kind: github
    base_url: https://github.com     # GHE：设为你的主机；API 推导为 {base_url}/api/v3
    app:
      app_id: "123456"                # 数字 App ID（或使用 client_id）
      private_key_env: AICR_GITHUB_APP_PRIVATE_KEY   # PEM 或 base64 PEM
      # private_key_path: /run/secrets/github-app.pem  # 替代：挂载的 .pem 文件
      # installation_id: "7890123"     # 可选；省略时按仓库自动解析
    webhook_secret_env: AICR_GITHUB_WEBHOOK_SECRET
```

`app` 与 `token_env` 互斥。通道级 `token_env` 优先于 trigger 级 `app` token。trigger 的
`base_url` 语义是**主机**（`https://github.com` 或 GHE 主机）；AICR 用它签发 App JWT 与 git
clone，并为经此 trigger 路由的 GitHub 输出通道自动派生 REST API base（`https://api.github.com`
或 `{host}/api/v3`），已使用 `.../api/v3` 的旧配置原样保留。App 最小权限：
Contents Read、Pull requests Read/Write、Issues Read/Write、Metadata Read。订阅事件：
Pull request、Push、Issue comment、Issues。`installation` 和 `installation_repositories`
事件返回 `202 unsupported_event`。

### GitLab

```yaml
triggers:
  - name: gitlab
    kind: gitlab
    base_url: https://gitlab.com
    token_env: AICR_GITLAB_TOKEN
    webhook_secret_env: AICR_GITLAB_WEBHOOK_SECRET   # 以 x-gitlab-token 发送
```

GitLab 通过 token 比对（`x-gitlab-token` 头）校验入站 webhook，而非 HMAC。

### 同一路由上的多 profile

GitHub 和 GitLab 可以在**同一路由**上定义多个 trigger profile。当不同仓库需要不同的出站
token、webhook secret 或文件过滤时，使用独立的 trigger 名称；AICR 根据已验证的凭据加上
webhook payload 中的仓库 `full_name` 选择最终 profile。

```yaml
triggers:
  - name: github-core
    kind: github
    token_env: AICR_GITHUB_CORE_TOKEN
    webhook_secret_env: AICR_GITHUB_CORE_WEBHOOK_SECRET
  - name: github-external
    kind: github
    token_env: AICR_GITHUB_EXTERNAL_TOKEN
    webhook_secret_env: AICR_GITHUB_EXTERNAL_WEBHOOK_SECRET
    include_cr_file: ["**/*.ts", "**/*.tsx"]

workspaces:
  instances:
    core-repo:
      source_repo: { trigger: github-core, repo: "my-org/core-repo" }
    external-repo:
      source_repo: { trigger: github-external, repo: "partner-org/external-repo" }
```

## Trigger 提供商

Trigger 提供商不接收 VCS webhook。VCS 服务端 hook 把最小元数据（变更号、作者、client）
POST 到 AICR，AICR 用**自己**配置的凭据拉取 diff。hook 端点由服务端 API key
（`X-API-Key` 头）鉴权，而非 HMAC。

### Perforce (P4)

```yaml
triggers:
  - name: p4-main
    kind: p4
    port: "ssl:perforce.corp:1666"      # TLS 加 ssl: 前缀
    user_env: AICR_P4USER
    password_env: AICR_P4PASSWORD       # 密码或登录 ticket
    depot_path: "//depot/main"
    workspace: "aicr-p4-main"           # AICR 使用的 P4 client 名（仅用于分析）
    change_url_template: "https://swarm.example.com/changes/{{revision}}"
    watch_path: ["src/", "include/"]
    include_cr_file: ["**/*.cpp", "**/*.h"]
    exclude_cr_file: ["**/*.gen.cpp", "**/*.pb.h"]
```

用 `p4 triggers` 注册：

```text
aicr-review change-commit //depot/main/... "/path/to/p4-trigger.sh %change% %user% %client%"
```

保留 `%user%` 和 `%client%`——它们作为 changelist 作者和提交 client 转发给 AICR，用于报告
归属。AICR 适配器配置的 P4 workspace 仅作分析 client，不作为对外的提交者元数据。

把 `example/p4-trigger.sh` 复制到 **P4 服务端主机**（不是 AICR 容器），加可执行权限
（`chmod +x`），并在该主机设置以下环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AICR_URL` | 是 | AICR 服务地址，如 `http://10.64.8.2:8090` |
| `AICR_API_KEY` | 是 | 必须与 `config.yaml` 中 `server.auth.api_key_env` 一致 |
| `AICR_DEPOT_PATH` | 否 | depot 路径覆盖。留空则使用 `config.yaml` 中的服务端 `depot_path`。 |
| `AICR_P4_COLLECT_FILES` | 否 | 默认 `0`。保持禁用，这样 p4d trigger 不运行 `p4 describe`，也不需要本地 `p4 trust`。 |
| `AICR_P4PORT` | 否 | 仅当 `AICR_P4_COLLECT_FILES=1` 时必填；必须显式指定，如 `ssl:p4.example.com:1666`。 |
| `AICR_P4USER` | 否 | 可选采集模式用户覆盖；否则脚本用 trigger `%user%`，再退到 `P4USER`（绝不隐式用 OS `root`）。 |
| `AICR_P4CLIENT` | 否 | 可选采集模式 client 覆盖；否则用 trigger `%client%`，再退到 `P4CLIENT`。 |
| `AICR_P4PASSWD` | 否 | 可选采集模式密码/ticket；仅当 P4 安全级别要求登录时，配合显式 service user 使用。 |
| `AICR_P4_AUTO_TRUST` | 否 | 可选采集模式的 `1`/`true`；默认 `0`。否则以 trigger OS 用户身份执行一次 `p4 trust`。 |

脚本默认**不**运行 `p4 describe`，避免 p4d 侧 SSL trust 提示阻塞提交。脚本在本地记录失败并以
成功码退出，这样异步评审永远不会阻塞提交链路。

服务启动后，可手动测试端点：

```bash
# 带 API key（启用 server.auth 时必填）：
curl -X POST http://localhost:8080/triggers/p4 \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"change":"12345","user":"testuser","depot_path":"//depot/main","files":["//depot/main/src/main.cpp"]}'
```

成功响应返回 `{"accepted": true, ...}`。

### Subversion (SVN)

```yaml
triggers:
  - name: svn-main
    kind: svn
    repository_url: "https://svn.example.com/repos/project/trunk"  # 必填
    username_env: AICR_SVN_USER         # 可选
    password_env: AICR_SVN_PASSWORD     # 可选
    trust_server_cert: false            # 除非外部固定 trust，否则保持 false
    revision_url_template: "https://svn.example.com/viewvc/project?view=revision&revision={{revision}}"
    watch_path: ["src/", "include/"]
    include_cr_file: ["**/*.cpp", "**/*.h"]
    exclude_cr_file: ["**/*.gen.cpp"]
```

`repository_url` 对 `/triggers/svn` **必填**。post-commit hook 只转发 revision 元数据；
AICR 用服务端配置的 `repository_url` 加自己的 SVN 凭据拉取 diff。payload 中的仓库 URL 字段
会被忽略，入站 hook 无法切换被评审的仓库。

在 SVN 仓库 `hooks/` 目录安装 `post-commit`：

```bash
#!/bin/bash
REPOS="$1"
REV="$2"
export AICR_URL="http://<aicr-host>:8080"
export AICR_API_KEY="<与 server.auth.api_key_env 相同的值>"
/path/to/svn-trigger.sh "$REPOS" "$REV"
```

把 `example/svn-trigger.sh` 复制到 SVN 服务端主机并加可执行权限（`chmod +x`）。脚本需要
`jq` 和 `svnlook`（SVN 服务端环境自带）：`svnlook` 读取作者、日志信息和变更路径，脚本再
把它们编码为 JSON 并 POST 到 `/triggers/svn`。脚本不发送仓库 URL——AICR 始终使用服务端配置的
`repository_url`。

服务启动后，可手动测试端点：

```bash
# 带 API key（启用 server.auth 时必填）：
curl -X POST http://localhost:8080/triggers/svn \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"revision":"123","author":"testuser","files":["src/app.cpp"]}'
```

成功响应返回 `{"accepted": true, ...}`。

## 文件过滤

所有提供商共用同一套三级过滤流水线，在评审前应用到变更文件列表：

```text
全部变更文件 → watch_path → include_cr_file → exclude_cr_file → 待评审文件
```

| 字段 | 类型 | 行为 |
| --- | --- | --- |
| `watch_path` | `string[]` | 仅分析这些 depot/仓库相对子路径下的文件。省略 = 全部路径。 |
| `include_cr_file` | `string[]` | glob 模式；文件**至少匹配一个**才会被分析。 |
| `exclude_cr_file` | `string[]` | glob 模式；匹配**任意**模式的文件被**跳过**。 |

glob 语法：

- `**/*.cpp` —— 匹配 `foo.cpp`、`src/foo.cpp`、`a/b/c/foo.cpp`（任意深度）
- `*.md` —— 匹配任意深度的文件 basename
- `src/**` —— 匹配 `src/` 下所有内容
- `**/*.pb.*` —— 匹配 `foo.pb.h`、`foo.pb.cc` 等

## 通过评论手动重审

在支持的 PR/MR 评论事件中，用户可以不推送新提交就请求一次新评审：

- `/aicr review`
- `/review`

在 async 模式下，同一目标的重复命令会被合并：当前评审先完成，然后 AICR 用最新事件跑一次
最终重审。

## 非 PR 评审的目标链接

内置模板渲染 `target.markdownLink` / `target.displayText`，不假设每次评审都是 PR。Git 提交
链接由 `base_url` + 仓库 + revision 自动推导。P4 和 SVN 可以提供显式 URL 模板：

```yaml
triggers:
  - name: p4-main
    kind: p4
    change_url_template: "https://swarm.example.com/changes/{{revision}}"
  - name: svn-main
    kind: svn
    revision_url_template: "https://svn.example.com/viewvc/project?view=revision&revision={{revision}}"
```

模板变量在替换前做 URL 编码。
