---
title: Telegram
description: 通过 Telegram 发送审查报告和执行授权的审查命令。
---

AICR 支持 `telegram_bot`，每次发布一条聚合报告，通过 HTTP 接收 `help`、`chat-id`、`review`、`status` 四种命令。
按钮和自然语言请求未纳入此实现。

## 创建和安装

打开 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示设置显示名和唯一 username。
把 Bot API token 通过部署环境注入 `AICR_TELEGRAM_TOKEN`，不要贴入浏览器地址栏、截图或聊天。
创建流程见 [Telegram 官方教程](https://core.telegram.org/bots/tutorial)。

### 获取 Bot ID 和 username

以下命令使用 PowerShell 7，只输出身份字段。辅助函数也用于下节的只读查询；失败时不打印含 token 的请求 URL。

```powershell
function Get-AicrTelegramInfo {
  param(
    [ValidateSet('getMe', 'getWebhookInfo', 'getUpdates', 'getChat', 'getChatMember')]
    [string] $Method,
    [hashtable] $Body = @{}
  )
  if (-not $env:AICR_TELEGRAM_TOKEN) { throw 'Set AICR_TELEGRAM_TOKEN first.' }
  try {
    $response = Invoke-RestMethod -Method Post -ContentType 'application/json' -Uri (
      'https://api.telegram.org/bot' + $env:AICR_TELEGRAM_TOKEN + '/' + $Method
    ) -Body ($Body | ConvertTo-Json -Compress) -ErrorAction Stop
  } catch { throw 'Telegram request failed; check credentials and network locally.' }
  if (-not $response.ok) { throw 'Telegram rejected the request.' }
  return $response.result
}
$me = Get-AicrTelegramInfo -Method getMe
$me | Select-Object id, username, is_bot
```

`id` 填入 `im.connections.bot.bot_id`，`username` 用于 `/aicr@你的机器人用户名`。
它们都不是群 ID；命令授权的 actor 则是人的数字 ID，不是人的 username。
依据：[getMe](https://core.telegram.org/bots/api#getme)。

### 获取群 ID

私聊由用户先启动 Bot；群聊先添加 Bot 并允许发送消息，普通群不需要管理员权限。
保持 privacy mode，群中使用 `/aicr@BotUsername` 定向命令。
先通过已有且授权的 Bot 管理流程取得数字 chat ID，以及精确用户授权需要的 actor ID，再启用 binding。

显示名和私有邀请链接不能传给 `getChat` 反查群 ID。公开 `@username` 也可能指向广播频道，须核对返回类型。
设置 webhook 前，可在群内发送定向命令，从 `getUpdates` 的 `message.chat.id` 取得群 ID；不要输出 token 或其他聊天内容。
polling 和 webhook 不能同时使用。未知用户不能通过 `chat-id` 自行加入精确用户白名单。

若定向命令仍没有更新且无法复制群内消息链接，可在设置 webhook 前临时使用
`getUpdates` 的 `allowed_updates: ["message", "my_chat_member"]`，从机器人的成员变更事件取得群 ID。
请群管理员从 `getMe` 确认的机器人页面重新加入目标群；只读取该 Bot 与目标群的事件，核对 `my_chat_member.chat.id`。
随后调用 `getChat` 核对群类型，并用 `getChatMember` 查询机器人自身的成员状态和发言权限。
不要改用广播频道、猜测 ID 或为排障关闭 privacy mode。生产 webhook 注册仍使用 `["message"]`，不删除待投递更新。
依据：[getUpdates](https://core.telegram.org/bots/api#getupdates)、[Update](https://core.telegram.org/bots/api#update)、[getChatMember](https://core.telegram.org/bots/api#getchatmember)。

ID 使用带引号的十进制字符串，群 ID 可以为负数。仅支持已建立的 private/group/supergroup；
forum/topic、channel、business、匿名 `sender_chat`、Bot 自己发送及编辑更新不触发审查。
依据：[Bot API](https://core.telegram.org/bots/api)、[privacy mode](https://core.telegram.org/bots/features#privacy-mode)。

对于尚未设置 webhook 的新 Bot，先执行上节辅助函数，再运行：

```powershell
$webhook = Get-AicrTelegramInfo -Method getWebhookInfo
if ($webhook.url) { throw 'Webhook exists. Use its current receiver; do not poll or delete it.' }
$targetGroupName = 'Your group name' # 改为目标群显示名，仅用于筛选候选事件
$updates = Get-AicrTelegramInfo -Method getUpdates -Body @{
  allowed_updates = @('message', 'my_chat_member'); timeout = 0
}
foreach ($update in $updates) {
  $event = if ($update.message) { $update.message } else { $update.my_chat_member }
  if ($event.chat.title -eq $targetGroupName) {
    [pscustomobject]@{
      chat_id = [string]$event.chat.id; type = $event.chat.type; title = $event.chat.title
      actor_id = [string]$event.from.id
    }
  }
}
```

先查询一次以设置事件类型，再在群内发送 `/aicr@你的机器人用户名 chat-id` 后重复查询；
若仍为空，移出并重新加入已核验的 Bot 后再查。此时 AICR 尚未接收消息，没有命令回复是正常的。
显示名筛选只用于找候选，重名时须结合自己刚发送命令或重新加群的操作核对。
成员事件的 `actor_id` 是执行成员变更的人，不一定是要授权的审查人。
取得数字 ID 后查询目标并核验机器人的成员状态：

```powershell
$chatId = '-1001234567890' # 替换为上一步核验的实际值，不能由邀请链接猜测
$chat = Get-AicrTelegramInfo -Method getChat -Body @{ chat_id = $chatId }
$chat | Select-Object id, type, title, is_forum
$member = Get-AicrTelegramInfo -Method getChatMember -Body @{ chat_id = $chatId; user_id = $me.id }
$member | Select-Object status, is_member, can_send_messages
```

`type` 应为 `group` 或非 forum 的 `supergroup`，并确认 Bot 可在群中发言。
已有 webhook 时通过当前接收器的授权管理流程取得 ID；不要删除 webhook 来执行此流程。
权限绑定建立后，`chat-id` 才能直接回复当前 actor 和 conversation。

## 在 AICR 中配置

另设 `AICR_TELEGRAM_WEBHOOK_SECRET`，长度 1–256，仅含字母、数字、下划线或连字符；
它与 Bot token 是不同秘密。例如在部署会话中生成，随后由部署工具传入服务环境，不打印其值：

```powershell
$env:AICR_TELEGRAM_WEBHOOK_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

可合并下文 YAML，或登录 Dashboard，打开 **Config → IM connections → New im connection**，
选择 `telegram_bot`。在 **Callback credentials** 中开启 callback 并填写 secret env。
下图为本地真实表单的身份部分，ID 为示例值。

[![AICR Telegram 连接表单：数字 Bot ID 和 Token env](/images/integrations/telegram-connection.png)](/images/integrations/telegram-connection.png)

点击图片可查看原图。

连接名须与 output、binding 的 `connection` 和回调 URL 末段一致；截图为 `telegram-demo`，下文为 `bot`。
使用数据库配置时，先在文件 `config_sources.secret_refs` 中按用途和目的地授权 env 引用，
再保存、发布并核验已激活版本及 snapshot，见[动态配置](/zh-cn/configuration/overview/#动态配置-api)。
接着填写群 ID、命令授权和报告渠道，部署完成后再注册 webhook。

## 发送报告

从 [example/telegram-bot.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/telegram-bot.yaml) 开始，
替换所有合成 ID 并设置 token 环境变量。output 引用 `im.connections.bot` 和准确目的地，
`ws.outputs.summary: [report]` 选择报告渠道。实际审查前合并已有 VCS/LLM 配置。
file-only 可以发送报告；干净结果默认使用 `publish_if_summary`，覆盖方式见[输出策略](/zh-cn/configuration/outputs/)。

模板仍按 named、workspace、内置的正常优先级选择。总预算为 3900 个 UTF-16 单位，
包含截断提示及可用的安全报告链接。Telegram 使用显式 UTF-16 entities，不开启 parse_mode。

同次审查还通过 issue 渠道发布完整报告时，AICR 先发送 issue，再使用其已确认链接发送简要通知：标题、问题数、严重级别/分类/位置和详情链接，并保留作者提醒。分析、建议和代码留在 issue。没有可用的已确认链接（包括 issue 写入失败）时，渠道仍发送完整报告。此行为不依赖渠道配置顺序，也不需要新增渠道选项。

报告按 Review target、Summary、Problems 分节，标题和严重级别使用加粗实体，问题标题保持单行。
代码使用独立的 code/pre 实体，围栏语言提示写入 pre 的 language，不作为正文显示。
含行内代码的加粗标签会分段，避免样式与代码实体重叠。
CRLF 与正文多余空行会归一化；内部审查标记不显示，代码示例内容保留。
实体及嵌套规则见 [Telegram 格式说明](https://core.telegram.org/bots/api#formatting-options)。

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
      kind: telegram_bot
      bot_id: "123456789"
      token_env: AICR_TELEGRAM_TOKEN
      callback:
        enabled: true
        secret_token_env: AICR_TELEGRAM_WEBHOOK_SECRET
  command_bindings:
    reviewers:
      enabled: true
      connection: bot
      actors: [{ type: telegram_user_id, id: "234567891" }]
      conversations: [{ kind: group, id: "-1001234567890" }]
      commands: [help, chat-id, review, status]
      repositories:
        demo: { workspace: ws, source_trigger: git, repo_ref: org/demo }
      report_policy: workspace_routes
```

连接、actor 策略、会话和仓库映射的交集决定权限。
允许配置群内的用户触发命令时，设置 `actors: [{kind: conversation_users}]`，无需逐个维护用户 ID。
该策略使用平台认证的消息发送人和群上下文，不查询成员目录；新增成员无需改配置，退群不自动取消已接受请求。
私聊和广播频道不能使用此策略；仍拒绝 `any`、目录 scope、通配仓库和额外命令。
`expires_at` 仍生效；重叠 binding 须合并，status 仍只允许原操作人查询原请求。
Telegram 私聊使用 `{kind: bot_direct}`，仍需显式列出数字用户 ID。

显式注册 HTTPS webhook，包含 `server.path_prefix`（若有）：

```bash
node scripts/register-social-im.mjs --platform telegram --bot-id 123456789 --token-env AICR_TELEGRAM_TOKEN --secret-env AICR_TELEGRAM_WEBHOOK_SECRET --callback-url https://aicr.example.org/callbacks/im/bot
# 核对 dry-run 输出后，追加 --apply 执行。
```

apply 先检查 `getMe` 和 `getWebhookInfo`，拒绝覆盖其他 webhook URL；`allowed_updates` 为 `["message"]`，
`drop_pending_updates` 保持 false。启动不会调用 `setWebhook`、`getUpdates` 或删除 webhook。
回调 ACK 是空 JSON 对象；授权后的短回复与命令接收在同一事务中写入 outbox。
依据：[webhook 方法](https://core.telegram.org/bots/api#setwebhook)。

## 验证流程

1. 在配置的用户和会话中执行 `/aicr@TestBot help`、`/aicr@TestBot chat-id`。
2. 用合成仓库中的真实固定提交执行 `/aicr@TestBot review demo 0123456789abcdef0123456789abcdef01234567`。
   Git revision 为 7–64 位十六进制，配置的 P4/SVN 使用固定正整数。
3. 保存 request ID，执行 `/aicr@TestBot status <request-id>`。
4. 核对完整报告只发到配置的输出目的地；来源会话只收 ID、状态和查询说明。
   status 保持同 actor、连接、会话和当前允许的仓库。

ACK 只代表接收，不代表完成分析。后台 readiness 核对平台身份及已配置目的地元数据，缓存 300 秒；
不可用时拒绝接收。本地接收预算为一秒，callback 不等待 VCS、模型、readiness 网络请求或消息发送。
后台在过期前刷新；刷新期间保留原有效期限，成功才续期，失败立即停用目的地。验证命令回复时须跨越缓存刷新周期。

## 运维与排障

401 时核对 `X-Telegram-Bot-Api-Secret-Token` 与配置的 webhook secret。群命令必须指向 `getMe` 返回的 username，不能用显示名。`blocked`/403 需要用户或群调整；群迁移不会自动改变配置 chat ID。429 的 `parameters.retry_after` 单位是秒。注册超时后先查 `getWebhookInfo`，再决定是否执行新的 apply。

出站超时时，从运行中的 Node 容器核验平台 API 访问。若部署使用代理，按
[运行时 HTTP 代理配置](/zh-cn/deployment/docker/#运行时-http-代理)核验；宿主请求成功不能代替 readiness。

每次新的 VCS、分析和远端发布前复查当前权限，执行内容继续使用接收时的 snapshot。
停用 binding、connection 或 callback 可停止新的授权工作。通过正常配置发布流程轮换秘密，保持平台身份稳定。
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

在输出渠道将审查身份映射到人的数字 Telegram user ID；不能填 username、Bot ID 或 chat ID：

```yaml
mention_author: true
author_mappings: { "alice@example.org": "234567891" }
```

Telegram Bot API 没有完整成员目录接口；使用显式映射或下方文件目录。授予管理员权限也不能列出所有成员。AICR 追加 `tg://user?id=…` 的 `text_link` 实体，offset/length 使用 UTF-16 单位；实际提及仍受 Telegram 的群成员、此前联系和隐私条件约束。依据：[格式与 ID 提及](https://core.telegram.org/bots/api#formatting-options)。

配置目录或映射后默认启用作者提醒；`mention_author: false` 关闭全部身份解析。映射键可匹配审查作者的邮箱、username、display name 或 P4 提交 workspace；先应用全局邮箱黑名单。使用 API 目录时，映射值必须是候选成员 ID；没有目录时是显式平台 ID；文件目录使用本地成员 key。`guess_author` 默认 false，保留精确匹配；设为 true 才启用 workspace 关联和专用身份模型。歧义、目录不可用或未匹配时照常发报告并省略 @。拒绝 `mention_fallback: all`；主评审提示词不接收目录。

文件目录支持 aliases、emails 和带来源范围的 VCS 账号。将下面片段合并到输出渠道，scope ID 必须与连接一致：

```yaml
member_directory:
  source: file
  path: ./members.yaml
  directory_id: team
  identity_scope: { kind: telegram_bot, id: "123456789" }
author_mappings: { "alice@example.org": alice }
```

```yaml
# members.yaml
version: 1
directories:
  team:
    platform: telegram
    identity_scope: { kind: telegram_bot, id: "123456789" }
    members:
      - key: alice
        emails: [alice@example.org]
        mention: { type: telegram_user_id, id: "234567891" }
```

先转义不可信正文，再插入原生提醒；长报告截断时预留提醒空间。文件路径相对配置目录解析，复用文件目录热加载。API 快照 TTL 按渠道、`outputs.author_resolution.directory_cache_ttl_seconds`、默认 43200 秒取值；0 禁用复用。每次快照最多 10000 成员、100 页、15 秒读取期限；刷新失败或分页不完整时不用过期成员。实际通知需在目标客户端验证。
