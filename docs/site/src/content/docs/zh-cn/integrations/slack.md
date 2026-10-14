---
title: Slack
description: 通过 Slack 发送审查报告和执行授权的审查命令。
---

AICR 支持 `slack_app`，每次发布一条聚合报告，通过 HTTP 或 Socket Mode 接收 `help`、`chat-id`、`review`、`status` 四种命令。
按钮和自然语言请求未纳入此实现。

## 创建和安装

先选择接收方式；两种方式都需要 Bot OAuth token、Bot scopes 和频道成员资格。

| 接收方式 | Slack 控制台 | AICR 配置 | 额外凭据 |
| --- | --- | --- | --- |
| HTTP | 关闭 Socket Mode；设置 `/aicr` Request URL | `callback.enabled: true` | Signing Secret |
| Socket Mode | 开启 Socket Mode；命令页不显示 Request URL | `callback.enabled: false`、`socket_mode.enabled: true` | 带 `connections:write` 的 App-Level Token |

在 [Slack 应用控制台](https://api.slack.com/apps) 选择 **Create New App → From a manifest**。
已有应用则打开 **App Manifest**，合并生成的命令和 Bot scopes，保留原有配置。
HTTP 模式从仓库根目录生成 manifest（Socket Mode 使用后文的 `--slack-mode socket`）：

```bash
node scripts/register-social-im.mjs --platform slack --callback-url https://aicr.example.org/callbacks/im/bot
```

在 Slack 应用控制台导入输出中的 `manifest` 对象，安装到指定 workspace，并把 Bot 邀请到每个命令/报告频道。
记录 app ID、team ID、Bot user ID、Bot OAuth token 和 signing secret。在服务环境设置
`AICR_SLACK_TOKEN` 和 `AICR_SLACK_SIGNING_SECRET`。回调验签使用 signing secret，出站发送使用 Bot token。

在应用控制台 **Socket Mode** 中关闭 **Enable Socket Mode**，再为 `/aicr` 设置 HTTP Request URL。
若命令编辑页显示 `Socket Mode is enabled`，URL 输入框会隐藏，slash command 会经 WebSocket 投递。
使用 HTTP 时，注册工具显式生成 `settings.socket_mode_enabled: false`。保留既有 manifest 字段并合并此设置；Socket Mode 配置见下节。

```yaml
settings:
  socket_mode_enabled: false
```

Socket Mode 是应用级设置；切换时须核对该应用已有的事件和交互接收端点，并保留其他 manifest 字段。
依据：[Socket Mode 投递方式及控制台开关](https://docs.slack.dev/apis/events-api/using-socket-mode/)。

| Bot scope | 用途 |
| --- | --- |
| `chat:write` | 发送报告和终态回复 |
| `channels:read` | 核验公开频道身份、类型和成员关系 |
| `groups:read` | 配置私有频道时核验其身份 |
| `commands` | 注册和使用 `/aicr` |

支持已加入的公开/私有频道。DM、多人 DM、线程和跨 Slack Connect 租户扩展未纳入接入范围。
不能靠 ID 前缀判断频道类型。依据：[manifest](https://docs.slack.dev/reference/app-manifest/)、
[频道元数据](https://docs.slack.dev/reference/methods/conversations.info/)。

在 **OAuth & Permissions → Bot Token Scopes** 核对上表权限，或将它们合并到
`oauth_config.scopes.bot`；**User Token Scopes** 中的同名权限不能替代 Bot 权限。
修改后执行 **Reinstall to Workspace**，更新服务使用的 **Bot User OAuth Token**。
在每个目标频道执行 `/invite @你的机器人`；私有频道也必须显式邀请。
依据：[OAuth 安装与 scope](https://docs.slack.dev/authentication/installing-with-oauth/)。

| AICR 字段或变量 | 从哪里获取 |
| --- | --- |
| `app_id` | 应用 **Basic Information → App Credentials → App ID** |
| `team_id`、`bot_user_id` | 使用 Bot token 调用 `auth.test`，分别取 `team_id`、`user_id` |
| `AICR_SLACK_TOKEN` | **OAuth & Permissions → Bot User OAuth Token** |
| `AICR_SLACK_SIGNING_SECRET` | **Basic Information → App Credentials → Signing Secret**，HTTP 模式使用 |
| `AICR_SLACK_APP_TOKEN` | **Basic Information → App-Level Tokens**，Socket Mode 使用 |
| 会话及报告的 `channel_id` | Slack 客户端打开目标频道详情，复制底部频道 ID |
| 精确授权的 actor ID | 操作人个人资料菜单中的 **Copy member ID**，不是 Bot ID |

先通过部署环境注入 `AICR_SLACK_TOKEN`，再在 PowerShell 7 中只读取所需身份字段：

```powershell
if (-not $env:AICR_SLACK_TOKEN) { throw 'Set AICR_SLACK_TOKEN first.' }
try {
  $identity = Invoke-RestMethod -Method Post -Uri 'https://slack.com/api/auth.test' -Headers @{
    Authorization = 'Bearer ' + $env:AICR_SLACK_TOKEN
  } -ErrorAction Stop
} catch { throw 'Slack auth.test failed; check the token and network locally.' }
if (-not $identity.ok) { throw 'Slack rejected auth.test.' }
$identity | Select-Object team_id, user_id
```

`bot_user_id` 填这里的 `user_id`，不能填 `bot_id` 或人的 member ID。
依据：[auth.test 返回字段](https://docs.slack.dev/reference/methods/auth.test/)。

## 在 AICR 中配置

可直接合并下文 YAML，或登录 Dashboard，打开 **Config → IM connections → New im connection**，
选择 `slack_app`。下图来自本地真实表单，所有 ID 均为示例值；截图只展示连接身份部分。

[![AICR Slack 连接表单：App ID、Team ID、Bot user ID 和 Token env](/images/integrations/slack-connection.png)](/images/integrations/slack-connection.png)

点击图片可查看原图。

连接名须与 output、binding 的 `connection` 及 HTTP URL 末段一致。
例如连接名为 `slack-demo` 时，回调为 `/callbacks/im/slack-demo`；下文 YAML 使用 `bot`。
展开 **Callback credentials** 或 **Socket Mode** 填入所选方式的配置，再配置报告渠道和命令授权。
使用数据库配置时，环境变量引用须先在文件 `config_sources.secret_refs` 中按用途和目的地授权；
数据库表单修改保存后，核验已激活版本及 snapshot；文件中显式配置的连接字段在界面保持只读。
具体操作见[动态配置 API 与管理页面](/zh-cn/configuration/overview/#动态配置-api)。

## 发送报告

从 [example/slack-app.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/slack-app.yaml) 开始，
替换所有合成 ID 并设置 token 环境变量。output 引用 `im.connections.bot` 和准确目的地，
`ws.outputs.summary: [report]` 选择报告渠道。实际审查前合并已有 VCS/LLM 配置。
file-only 可以发送报告；干净结果默认使用 `publish_if_summary`，覆盖方式见[输出策略](/zh-cn/configuration/outputs/)。

模板仍按 named、workspace、内置的正常优先级选择。总预算为 3900 个 UTF-16 单位，
包含截断提示及可用的安全报告链接。Slack 转义不可信提醒标记并关闭链接展开。

同次审查还通过 issue 渠道发布完整报告时，AICR 先发送 issue，再使用其已确认链接发送简要通知：标题、问题数、严重级别/分类/位置和详情链接，并保留作者提醒。分析、建议和代码留在 issue。没有可用的已确认链接（包括 issue 写入失败）时，渠道仍发送完整报告。此行为不依赖渠道配置顺序，也不需要新增渠道选项。

报告按 Review target、Summary、Problems 分节，问题标题保持单行。
Slack 使用自己的 `mrkdwn`：标题和严重级别转为单星号加粗，代码围栏去掉语言提示，保留代码正文。
CRLF 与正文多余空行会归一化；内部审查标记不显示，代码示例中的同类文本保留。
自定义模板仍按上述优先级生效。平台语法见 [Slack 格式说明](https://docs.slack.dev/messaging/formatting-message-text/)。

## 启用命令

按仓库选择报告时，旧路由可用 `outputs.routes.rules[].match.repo_ref` 与 `trigger`、`target_kind` 取交集。
仓库引用精确匹配并区分大小写；把这些规则放在宽泛规则之前，追加 Bot 输出时保留原有渠道列表。
匹配的旧路由优先于 workspace 输出列表。字段见[配置参考](/zh-cn/reference/config-fields/)。

合并下面片段，保留连接身份和 token，替换 actor、会话、仓库与秘密引用。
review 需要持久 SQLite/PostgreSQL store、数据库配置来源、snapshot 和运行中的 worker；
file-only 在创建请求前拒绝 review。平台 callback 无需管理员会话，管理 API 保留原认证。

```yaml
config_sources:
  database: { enabled: true, backend: storage }
storage:
  database:
    kind: sqlite
    sqlite: { path: ./data/aicr.sqlite }
triggers:
  - { name: git, kind: github }
workspaces:
  instances:
    ws: {}
im:
  connections:
    bot:
      kind: slack_app
      app_id: A123
      team_id: T123
      bot_user_id: U123
      token_env: AICR_SLACK_TOKEN
      callback:
        enabled: true
        signing_secret_env: AICR_SLACK_SIGNING_SECRET
  command_bindings:
    reviewers:
      enabled: true
      connection: bot
      actors: [{ type: slack_user_id, id: U234 }]
      conversations: [{ kind: channel, id: C123 }]
      commands: [help, chat-id, review, status]
      repositories:
        demo: { workspace: ws, source_trigger: git, repo_ref: org/demo }
      report_policy: workspace_routes
```

连接、actor 策略、会话和仓库映射的交集决定权限。
允许配置频道内的用户触发命令时，设置 `actors: [{kind: conversation_users}]`，无需逐个维护用户 ID。
该策略使用平台认证的命令发送人和频道上下文，不查询成员目录；新增成员无需改配置，退群不自动取消已接受请求。
私聊不能使用此策略；仍拒绝 `any`、目录 scope、通配仓库和额外命令。
`expires_at` 仍生效；重叠 binding 须合并，status 仍只允许原操作人查询原请求。

manifest 设置 slash command URL；服务启动不会注册命令或事件订阅。URL 为公网 HTTPS 地址加 `server.path_prefix`（若有）和 `/callbacks/im/bot`。Slack 要求三秒内初次 ACK；AICR 本地接收预算为一秒，返回仅操作者可见的回复。

## 使用 Socket Mode

HTTP 和 Socket Mode 二选一；报告和终态回复均继续使用 Bot OAuth token。
在 **Basic Information → App-Level Tokens** 创建带 `connections:write` 的 Token，
仅在服务环境设置 `AICR_SLACK_APP_TOKEN`，不要把实际值填入 manifest 或提交到仓库。
保留 Bot scopes、频道邀请和命令 binding，并合并：

```yaml
im:
  connections:
    bot:
      kind: slack_app
      app_id: A123
      team_id: T123
      bot_user_id: U123
      token_env: AICR_SLACK_TOKEN
      callback:
        enabled: false
      socket_mode:
        enabled: true
        app_token_env: AICR_SLACK_APP_TOKEN
```

生成 Socket Mode manifest：

```bash
node scripts/register-social-im.mjs --platform slack --slack-mode socket
```

工具输出 `settings.socket_mode_enabled: true`，slash command 无需 Request URL。
先部署接收器，再在 Slack 控制台启用 **Socket Mode → Enable Socket Mode**；
它是应用级切换，事件和交互也会改走 WebSocket。本接收器仅执行四种 slash 命令，
其他 envelope 只 ACK，不处理 App Agent、mentions 或按钮；已有这些功能的应用须另行规划其接收器。
保留原 HTTP URL 和 signing secret，以便回切。

服务核验 hello 中的 App ID、命令 workspace 和当前授权，持久接收后按 envelope ID 返回 ephemeral ACK。
去重优先使用 trigger ID 的哈希，无 trigger ID 时使用 envelope ID 的哈希。
接收预算一秒；readiness 或持久执行不可用时不 ACK，不创建任务，留待平台重投。
SDK 处理 heartbeat，服务按 1、2、4 秒递增至 30 秒重连；配置变更最多 30 秒内重建连接，
变更后的旧连接立即拒绝新命令。进程排空时断开连接。

同一 App 使用一个命令接收实例；平台多连接会分配 envelope，不保证每个实例均收到。
使用标准 HTTP(S) proxy/no_proxy 环境变量时，HTTP 开连接与 WebSocket 共用显式代理 dispatcher。
日志只记录连接名和固定状态，禁止输出 App-Level Token、临时 WebSocket URL 和原始 envelope。

验证 `/aicr help`、`/aicr chat-id`，并在服务重启及 readiness 刷新后重复。
观察 `slack_socket_mode_status` 的 `connected`；连接成功仍需实际命令 ACK 验收。
回切时先在控制台关闭 Socket Mode，再停用 `socket_mode.enabled`、启用 HTTP callback，核验原 Request URL。
依据：[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)、
[Node SDK](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/)。

## 验证流程

1. 在配置的用户和会话中执行 `/aicr help`、`/aicr chat-id`。
2. 用合成仓库中的真实固定提交执行 `/aicr review demo 0123456789abcdef0123456789abcdef01234567`。
   Git revision 为 7–64 位十六进制，配置的 P4/SVN 使用固定正整数。
3. 保存 request ID，执行 `/aicr status <request-id>`。
4. 核对完整报告只发到配置的输出目的地；来源会话只收 ID、状态和查询说明。
   status 保持同 actor、连接、会话和当前允许的仓库。

ACK 只代表接收，不代表完成分析。后台 readiness 核对平台身份及已配置目的地元数据，缓存 300 秒；
不可用时拒绝接收。本地接收预算为一秒，callback 不等待 VCS、模型、readiness 网络请求或消息发送。
后台在过期前刷新；刷新期间保留原有效期限，成功才续期，失败立即停用目的地。验证命令回复时须跨越缓存刷新周期。

## 运维与排障

命令没有回复时，在已配置频道的主输入框键入 `/aicr`，从斜杠菜单选择此应用，再输入 `help`。
回复仅操作者可见。在线程、App Agent 分栏或普通 `@Bot` 消息中发送不会触发此接入。
在应用控制台 **Features → Slash Commands** 核对 `/aicr` 的 **Request URL**；
HTTP 模式下，若此字段不可见且页面提示 Socket Mode 已开启，先关闭 **Enable Socket Mode**，再返回编辑页。
Socket Mode 下隐藏 URL 是正常行为；核验 App-Level Token、连接状态与实际 envelope ACK。
`commands` scope 和安装成功仍需配合实际命令定义。同名命令可能被其他应用占用。
已有 App Agent 配置应合并 `features.slash_commands`，保留其他 manifest 字段。
依据：[命令创建、调用位置和同名规则](https://docs.slack.dev/interactivity/implementing-slash-commands/)。

若保存 URL 时提示 `Your URL didn't respond with the value of the challenge parameter`，
这是 **Event Subscriptions** 的 Events API 验证。AICR 当前接入处理 Slash Commands 的 form 请求，
不处理该 JSON challenge。进入 **Features → Slash Commands → Create New Command**，
设置 Command 为 `/aicr`，把回调地址填在这条命令的 **Request URL** 并保存。
若已有 `/aicr`，编辑该命令。已有 App Agent 的事件端点须保留；本接入无需新增事件订阅。
依据：[Events API URL 验证](https://docs.slack.dev/reference/events/url_verification/)。

排障时保留客户端原始错误、命令时间及回调 HTTP 状态。`operation_timeout` 表示 Slack 未在三秒内收到 ACK。
成功接收的合法命令会留下 `im_inbox` 记录；没有记录也可能是验签、readiness 或授权阶段拒绝，
不能单凭它判断请求未到达。`help`、`chat-id` 的初始回复随 HTTP 响应或 Socket envelope ACK 返回，
检查该响应与客户端显示；不要以终态回复 outbox 的有无判断初始命令是否成功。
日志只保留必要元数据，禁止记录 token、签名、`response_url` 或完整请求体。

回调 401 通常表示 signing secret、原始请求体或时间戳不匹配；允许的时钟偏差为五分钟。503 表示 readiness 或持久审查执行尚不可用。`not_in_channel` 或私有频道失败应核对 Bot 成员关系与 `groups:read`。Slack `internal_error`/`fatal_error` 可能部分成功，保留为 `unknown`。依据：[验签](https://docs.slack.dev/authentication/verifying-requests-from-slack/)、[消息错误](https://docs.slack.dev/reference/methods/chat.postMessage/)。

每次新的 VCS、分析和远端发布前复查当前权限，执行内容继续使用接收时的 snapshot。
停用 binding、connection 或当前接收方式可停止新的授权工作。通过正常配置发布流程轮换秘密，保持平台身份稳定。
改变 app/guild/Bot 身份后，旧通知不会转发给同名新连接。

完整且目的地匹配的回执才是 `delivered`；明确失败是 `rejected`。
进入 POST 后，仅明确的 429 允许到期重试回复。丢失响应、服务端失败和过期 `sending` lease 保留为 `unknown`，不会自动重发。
先查远端消息与 journal/outbox，再决定是否创建新请求。

进入 POST 前的本地配置、凭据或存储异常按持久 due time 退避。这些安全重试与明确限流重试共用最多五次的预算，耗尽时为 `failed`。可能已经发送或回执落库失败时保留 `sending` 围栏，租约到期后为 `unknown`。日志只保留固定错误码，不记录上游原始错误。

回滚前停用 ingress 并排空 worker，再更换程序或恢复兼容备份。迁移 013 新增版本化 reply payload 列；
不要删除请求、journal/outbox 来清除 unknown。注销平台资源前核对当前归属，只处理本部署拥有的资源。

仓库测试使用 HTTP 替身和真实本地存储；真实平台需单独凭据并独立验收。
本地通过不代表客户端呈现或公网回调已验证。

## 提醒审查作者

在输出渠道配置显式映射或 API 目录：

```yaml
mention_author: true
author_mappings: { "alice@example.org": U234 }
# 可选：在目标频道成员中自动匹配
# member_directory: { source: slack_api, cache_ttl_seconds: 43200 }
# guess_author: true
```

API 目录读取 `conversations.members` 和 `users.list` 的全部分页，只匹配目标频道内仍有效的人类成员。Bot Token Scopes 增加 `users:read`，按邮箱匹配另需 `users:read.email`；修改后重新安装并核对实际 token。仅使用显式映射无需目录权限。Slack 只会通知已加入该频道的被提及用户。依据：[用户提及](https://docs.slack.dev/messaging/formatting-message-text/#mentioning-users)、[users.list](https://docs.slack.dev/reference/methods/users.list/)。

配置目录或映射后默认启用作者提醒；`mention_author: false` 关闭全部身份解析。映射键可匹配审查作者的邮箱、username、display name 或 P4 提交 workspace；先应用全局邮箱黑名单。使用 API 目录时，映射值必须是候选成员 ID；没有目录时是显式平台 ID；文件目录使用本地成员 key。`guess_author` 默认 false，保留精确匹配；设为 true 才启用 workspace 关联和专用身份模型。歧义、目录不可用或未匹配时照常发报告并省略 @。拒绝 `mention_fallback: all`；主评审提示词不接收目录。

文件目录支持 aliases、emails 和带来源范围的 VCS 账号。将下面片段合并到输出渠道，scope ID 必须与连接一致：

```yaml
member_directory:
  source: file
  path: ./members.yaml
  directory_id: team
  identity_scope: { kind: slack_team, id: "T123" }
author_mappings: { "alice@example.org": alice }
```

```yaml
# members.yaml
version: 1
directories:
  team:
    platform: slack
    identity_scope: { kind: slack_team, id: "T123" }
    members:
      - key: alice
        emails: [alice@example.org]
        mention: { type: slack_user_id, id: "U234" }
```

先转义不可信正文，再插入原生提醒；长报告截断时预留提醒空间。文件路径相对配置目录解析，复用文件目录热加载。API 快照 TTL 按渠道、`outputs.author_resolution.directory_cache_ttl_seconds`、默认 43200 秒取值；0 禁用复用。每次快照最多 10000 成员、100 页、15 秒读取期限；刷新失败或分页不完整时不用过期成员。实际通知需在目标客户端验证。
