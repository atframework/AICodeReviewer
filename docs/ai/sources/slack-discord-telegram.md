# Slack、Discord、Telegram 官方接口核查

- last_checked: 2026-10-12
- next_review: 2027-01-12，或平台公告改变相关接口时提前
- update_trigger: 认证、权限、消息格式、响应期限、限流或恢复策略变化
- evidence_scope: 当前官方文档与本地源码；真实账户部署证据单独记录，不替代 L01–L03

本记录支持[接入规范](../../design/slack-discord-telegram.md)。表中的平台事实与规范中的本地设计值
分开维护。实施时重开对应链接；如果字段或限制改变，先更新规范与验收项，不能靠猜测补兼容分支。

## Slack

| 编号 | 官方资料 | 本次确认及设计影响 |
| --- | --- | --- |
| S1 | [请求验签](https://docs.slack.dev/authentication/verifying-requests-from-slack/) | 对原始 body 和 timestamp 计算 HMAC-SHA256，格式为 `v0:timestamp:body`；检查签名并采用文档示例的 5 分钟时间窗；不能用旧 verification token 替代 |
| S2 | [Slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/) | 请求是 URL-encoded form；包含 command、text、team_id、user_id、channel_id、api_app_id；须在 3000 ms 内响应。Features → Slash Commands 单独定义命令和 Request URL；同名命令由最近安装的应用处理；自定义命令不能在线程或 App Agent 分栏中调用 |
| S3 | [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) | Bot Web API 支持主动发送；需检查业务 `ok` 及 channel/ts 回执。text 建议不超过 4000 字符，超过 40000 会截断，不能把建议值称为硬上限；私有频道要求应用成员身份 |
| S4 | [限流](https://docs.slack.dev/apis/web-api/rate-limits/) | 按方法及 workspace 计量；发送通常每频道每秒约 1 条；429 的 Retry-After 以秒计；不能硬编码一个全局通用配额 |
| S5 | [交互响应](https://docs.slack.dev/interactivity/handling-user-interaction/) | response_url 有次数/时间限制，超 30 分钟须改用正常发消息接口；其能力不等于普通频道权限。此计划不保存、不调用 response_url |
| S6 | [格式](https://docs.slack.dev/messaging/formatting-message-text/) | mrkdwn 与通用 Markdown 不同；`&`、`<`、`>` 及原生 mention/link 要分别处理，不能将审查文本直接当可信 mention markup |
| S7 | [auth.test](https://docs.slack.dev/reference/methods/auth.test/) | 可验证 token 的身份和 workspace；用 team_id/user_id 对照配置，不推断 app_id 一定出现在此响应中 |
| S8 | [conversations.info](https://docs.slack.dev/reference/methods/conversations.info/) | 返回 conversation 类型；公开/私有频道元数据分别涉及 channels:read/groups:read。不能只按 ID 首字母判断 DM；后台只读取已配置目标，不列出聊天历史或成员目录 |
| S9 | [App manifest](https://docs.slack.dev/reference/app-manifest/) | manifest 的 oauth_config.scopes.bot 与 scopes.user 分开授权；user action 权限不能替代 Bot token 权限。变更 Bot scopes 后重新安装，并核验当前 token 实际权限；工具只生成待导入对象，启动不注册 |
| S10 | [Conversation object](https://docs.slack.dev/reference/objects/conversation-object/) | context_team_id 为必填 workspace 身份；is_member 是调用 token 的成员资格；旧私有频道可能 is_group=true；is_read_only/is_frozen/is_thread_only 为 true 时不能主动发顶层报告 |
| S11 | [url_verification](https://docs.slack.dev/reference/events/url_verification/) / [Events API HTTP URL](https://docs.slack.dev/apis/events-api/using-http-request-urls/) | challenge 验证只属于 Events API Request URL，配置入口为 Event Subscriptions；Slash Commands 在自己的命令定义中设置 Request URL。当前本地 callback 只处理 slash form，不接收 Events API JSON |
| S12 | [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) / [App manifest](https://docs.slack.dev/reference/app-manifest/) | Socket Mode 开启时，事件与交互 payload（包括 slash command）只经 WebSocket 投递；命令编辑页不需要 HTTP Request URL。HTTP 接入须关闭控制台 Enable Socket Mode，manifest 字段为 settings.socket_mode_enabled=false。注册工具按 --slack-mode 显式生成此字段；Socket 使用 connections:write App-Level Token，核验 hello App ID 与 envelope_id ACK；应用多连接会分配 envelope |

实施时重查 S3 的错误定义：`internal_error`/`fatal_error` 可能部分成功，`ok:false` 并非一律安全重试；
client/journal 保留 unknown。三平台均采用主动 API，不持久化临时 response_url/interaction token。

未找到可用于本计划的、明确保证任意重启后去重的 `client_msg_id` 时间窗口。
文档中的参数或错误名不能单独证明 exactly-once；本地日志保留未知发送，不自动重发。
本期使用单 workspace 自建应用，发送要求 `chat:write`，命令要求 `commands`，
频道 readiness 要求 `channels:read`，使用私有频道时另需 `groups:read`；机器人显式加入报告频道。
不引入用户目录/history 读取权限、公开 Marketplace OAuth 安装服务或 GovSlack。

## Discord

| 编号 | 官方资料 | 本次确认及设计影响 |
| --- | --- | --- |
| D1 | [Interactions overview](https://docs.discord.com/developers/interactions/overview) | HTTP 与 Gateway 是交互的两种互斥接收方式；HTTP 需验证 Ed25519 签名（timestamp + 原始 body），包括 PING；验签失败返回 401，平台会发无效签名探测 |
| D2 | [接收与响应](https://docs.discord.com/developers/interactions/receiving-and-responding) | 首次响应限 3 秒，interaction token 有效 15 分钟；支持 inline HTTP 响应。长审查不能依赖 token 永久有效 |
| D3 | [Application commands](https://docs.discord.com/developers/interactions/application-commands) | Guild command 可单独创建/更新；同名创建会覆盖该命令；bulk overwrite 会覆盖整个命令集合。计划只管理名为 aicr 的一条命令 |
| D4 | [Message resource](https://docs.discord.com/developers/resources/message) | Create Message 的 content 上限 2000 字符；默认 mention 可能通知用户/角色/everyone；显式设置 allowed_mentions。nonce 最长 25 字符，enforce_nonce 仅覆盖过去几分钟，不能作为无限期恢复保证 |
| D5 | [Rate limits](https://docs.discord.com/developers/topics/rate-limits) | 按响应 bucket、major resource、全局限流和 retry_after 调度；不要猜每个 endpoint 固定可发送次数 |
| D6 | [OAuth2](https://docs.discord.com/developers/topics/oauth2) / [Channel](https://docs.discord.com/developers/resources/channel) / [User](https://docs.discord.com/developers/resources/user) | 通过应用、Bot 和频道信息核查配置身份与目标；使用 bot + applications.commands 安装和指定频道发送权限，频道所属 guild 必须符合连接配置 |

本期使用 API v10、单 guild 安装、HTTP interaction 和普通 guild 文本频道。
不读取一般聊天消息，因此没有为了收 slash command 而申请 Message Content intent 的需要。
Discord 的精确抗重放时间窗在上述文档中没有统一数值；规范采用本地 5 分钟策略并要求真实回调验证。

## Telegram

| 编号 | 官方资料 | 本次确认及设计影响 |
| --- | --- | --- |
| T1 | [Bot API：setWebhook](https://core.telegram.org/bots/api#setwebhook) | HTTPS JSON 更新；非 2xx 会有界重投；可用 secret_token 请求头认证，长度 1–256，允许字母数字、下划线、连字符；webhook 与 getUpdates 不能同时使用 |
| T2 | [Bot API：Update](https://core.telegram.org/bots/api#update) / [getMe](https://core.telegram.org/bots/api#getme) / [getChat](https://core.telegram.org/bots/api#getchat) | update_id 用于接收去重；getMe 核对 bot 身份，getChat 查询配置目标类型。不能把 chat_id、user.id、bot id 混为同一用途 |
| T3 | [Bot API：sendMessage](https://core.telegram.org/bots/api#sendmessage) / [MessageEntity](https://core.telegram.org/bots/api#messageentity) | text 为解析实体后 1–4096 字符；实体 offset/length 使用 UTF-16 单元。返回 Message 才能核验 message_id/chat.id；不要将 webhook 响应中代发方法视为已确认送达 |
| T4 | [ResponseParameters](https://core.telegram.org/bots/api#responseparameters) | retry_after 表示需等待秒数；migrate_to_chat_id 是目标迁移提示，不能自动扩大已授权群范围 |
| T5 | [Bots FAQ](https://core.telegram.org/bots/faq) / [Bots introduction](https://core.telegram.org/bots#how-are-bots-different-from-users) | privacy mode 下显式 `/command@this_bot` 可送达；webhook 与 polling 互斥；单聊需要用户先建立与 Bot 的会话；常规发送需按群、会话、Bot 限流 |
| T6 | [getUpdates](https://core.telegram.org/bots/api#getupdates) / [Update](https://core.telegram.org/bots/api#update) / [getChatMember](https://core.telegram.org/bots/api#getchatmember) | 设置 webhook 前可临时订阅 message/my_chat_member，通过 Bot 自身成员变更事件的 chat.id 核验群 ID；allowed_updates 不指定时沿用旧值。getChatMember 对其他用户只保证 Bot 管理员时可用，本流程只查自身；生产注册恢复 message，不丢弃 pending updates |

本期不使用聊天历史查询、支付广播、Business/Guest/Rich Message 新接口、inline mode 或 callback buttons。
Bot API 不提供本方案可依赖的 sendMessage 幂等键和丢失回执后的通用发送查询；未知结果停止自动发送。

## 命令上下文与批量授权

S2 的 user_id/channel_id、D2 的 member.user/channel_id/guild_id、T2 的 message.from/chat
描述命令发出时的操作人和会话；须先按 S1/D1/T1 验证来源。`conversation_users` 是本地显式授权策略，
不是平台提供的目录 scope 或实时成员查询。成员离开后，已接收任务不会自动取消。
T2 的 getChat 参数只接受数字 ID 或公开 @username，不接受私有邀请链接；返回的 channel 类型不能冒充 group。

## 测试数据与证据边界

- 本地协议样本只保留合成 app/team/guild/chat/user ID；签名向量用固定测试密钥和独立生成方式。
- Slack form 保留原始 `%` 编码、`+` 和字段顺序；Discord 保留原 JSON 字节；Telegram 包含负 chat ID 和 emoji。
- 平台限制测试、HTTP 替身及本地数据库重启不能证明真实权限、显示效果或公网回调可用。
- 真实账户验收另按[验收矩阵](../../design/slack-discord-telegram-acceptance.md)执行；没有凭据保持待验收。

## Slack SDK 与代理

S13：[Node Socket Mode SDK](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/)、
[v3 迁移](https://docs.slack.dev/tools/node-slack-sdk/migration/socket-mode/migrating-socket-mode-package-to-v3/)、
[SDK 源码](https://github.com/slackapi/node-slack-sdk/tree/main/packages/socket-mode)。
本地实际安装并核验 @slack/socket-mode 3.1.0：使用 undici dispatcher；slack_event 回调收到单个包含 ack/body/type 的对象；
hello 的 connection_info.app_id 可核验连接身份，slash payload 可能没有 api_app_id。
固定 undici 7.29.0；接收器显式 EnvHttpProxyAgent，原始 SDK 日志关闭；服务自行管理有界重试和停止。
