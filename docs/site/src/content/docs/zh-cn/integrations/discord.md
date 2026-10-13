---
title: Discord
description: 通过 Discord 发送审查报告和执行授权的审查命令。
---

AICR 支持 `discord_bot`，每次发布一条聚合报告，通过 HTTP 接收 `help`、`chat-id`、`review`、`status` 四种命令。
原生作者提醒、目录、按钮和自然语言请求未纳入此实现。

## 创建和安装

在 Discord Developer Portal 创建 application 和 Bot。复制 application ID、public key、Bot token，把 token 放入 `AICR_DISCORD_TOKEN`。启用 Developer Mode 后复制 guild、channel 和 user ID；snowflake 一律保留为带引号的字符串。下方合成 public key 必须替换为 Portal 中的实际值。

用 `bot` 和 `applications.commands` scopes 安装到指定 guild。在命令/报告频道授予 **View Channel** 和 **Send Messages**。
此接入使用 HTTP interactions 和 Bot 消息 API，不需要 Administrator 或 Message Content 等 Gateway 特权 intents。
仅支持配置 guild 的普通文字频道（type 0）；DM、论坛帖子、线程、公告频道和 Gateway 接收未实现。
依据：[应用命令](https://docs.discord.com/developers/interactions/application-commands)、[频道类型](https://docs.discord.com/developers/resources/channel)。

## 发送报告

从 [example/discord-bot.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/discord-bot.yaml) 开始，
替换所有合成 ID 并设置 token 环境变量。output 引用 `im.connections.bot` 和准确目的地，
`ws.outputs.summary: [report]` 选择报告渠道。实际审查前合并已有 VCS/LLM 配置。
file-only 可以发送报告；干净结果默认使用 `publish_if_summary`，覆盖方式见[输出策略](/zh-cn/configuration/outputs/)。

模板仍按 named、workspace、内置的正常优先级选择。总预算为 1900 个 UTF-16 单位，
包含截断提示及可用的安全报告链接。Discord 禁用 allowed mentions。

## 启用命令

按仓库选择报告时，旧路由可用 `outputs.routes.rules[].match.repo_ref` 与 `trigger`、`target_kind` 取交集。
仓库引用精确匹配并区分大小写；把这些规则放在宽泛规则之前，追加 Bot 输出时保留原有渠道列表。
匹配的旧路由优先于 workspace 输出列表。字段见[配置参考](/zh-cn/reference/config-fields/)。

合并下面片段，保留连接身份和 token，替换 actor、会话、仓库与public key。
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
      kind: discord_bot
      application_id: "123456789012345678"
      guild_id: "123456789012345679"
      token_env: AICR_DISCORD_TOKEN
      callback:
        enabled: true
        public_key: "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737"
  command_bindings:
    reviewers:
      enabled: true
      connection: bot
      actors: [{ type: discord_user_id, id: "123456789012345681" }]
      conversations: [{ kind: channel, id: "123456789012345680" }]
      commands: [help, chat-id, review, status]
      repositories:
        demo: { workspace: ws, source_trigger: git, repo_ref: org/demo }
      report_policy: workspace_routes
```

连接、actor 策略、会话和仓库映射的交集决定权限。
允许配置 guild 文字频道内的用户触发命令时，设置 `actors: [{kind: conversation_users}]`，无需逐个维护用户 ID。
该策略使用平台认证的 interaction 发送人和频道上下文，不查询成员目录；新增成员无需改配置，离开 guild 不自动取消已接受请求。
私聊不能使用此策略；仍拒绝 `any`、目录 scope、通配仓库和额外命令。
`expires_at` 仍生效；重叠 binding 须合并，status 仍只允许原操作人查询原请求。

把 application 的 **Interactions Endpoint URL** 设置为公网 HTTPS 地址加 `server.path_prefix`（若有）和 `/callbacks/im/bot`。服务先验证 Ed25519 签名，再响应 PING。注册一个 guild `aicr` CHAT_INPUT 命令，只包含必填 STRING 参数 `command`：

```bash
node scripts/register-social-im.mjs --platform discord --application-id 123456789012345678 --guild-id 123456789012345679 --token-env AICR_DISCORD_TOKEN
# 核对 dry-run 输出后，追加 --apply 执行。
```

工具读取命令清单，只创建或 PATCH 本 guild 的 `aicr` CHAT_INPUT，不批量覆盖其他命令。
初始回复为 ephemeral（flags 64），满足平台三秒期限；终态使用 Bot API，不依赖十五分钟 interaction token。
依据：[interaction 生命周期](https://docs.discord.com/developers/interactions/receiving-and-responding)。

## 验证流程

1. 在配置的用户和会话中执行 `/aicr command: help`、`/aicr command: chat-id`。
2. 用合成仓库中的真实固定提交执行 `/aicr command: review demo 0123456789abcdef0123456789abcdef01234567`。
   Git revision 为 7–64 位十六进制，配置的 P4/SVN 使用固定正整数。
3. 保存 request ID，执行 `/aicr command: status <request-id>`。
4. 核对完整报告只发到配置的输出目的地；来源会话只收 ID、状态和查询说明。
   status 保持同 actor、连接、会话和当前允许的仓库。

ACK 只代表接收，不代表完成分析。后台 readiness 核对平台身份及已配置目的地元数据，缓存 300 秒；
不可用时拒绝接收。本地接收预算为一秒，callback 不等待 VCS、模型、readiness 网络请求或消息发送。
后台在过期前刷新；刷新期间保留原有效期限，成功才续期，失败立即停用目的地。验证命令回复时须跨越缓存刷新周期。

## 运维与排障

命令没有回复时，在配置的文字频道键入 `/aicr`，从斜杠菜单选择正确的应用，
在 `command` 输入框填 `help` 后发送。指南中的 `command:` 表示参数栏，不能作为普通聊天文本发送。
初始回复仅操作者可见。若没有命令菜单，检查 guild 命令注册、应用安装及操作者的应用命令权限；
若客户端提示应用没有响应，记录原始错误和命令时间，再核对 Interactions Endpoint URL、回调 HTTP 状态及验签/readiness。

成功接收的合法命令会留下 `im_inbox` 记录；没有记录也可能是接收前拒绝，不能据此断定没有请求。
`help`、`chat-id` 直接使用 HTTP interaction 响应，不经过 Bot 消息 outbox。
Bot 的 **Send Messages** 用于报告和终态通知，应结合出站失败证据检查。
日志只保留必要元数据，禁止记录 interaction token、签名或完整请求体。
依据：[应用命令](https://docs.discord.com/developers/interactions/application-commands)、
[初始响应](https://docs.discord.com/developers/interactions/receiving-and-responding)。

PING/命令 401 时核对 public key 和时间戳头；AICR 本地要求五分钟内的新请求。出站 403 应检查 Bot 的频道权限。429 的 `retry_after` 单位是秒，回复 outbox 持久保存到期时间。不要把 interaction token 当作 Bot token。其他 guild 或非普通文字频道会在发送前被 readiness 拒绝。

出站超时时，从运行中的 Node 容器核验平台 API 访问。若部署使用代理，按
[运行时 HTTP 代理配置](/zh-cn/deployment/docker/#运行时-http-代理)核验；宿主请求成功不能代替 readiness。

每次新的 VCS、分析和远端发布前复查当前权限，执行内容继续使用接收时的 snapshot。
停用 binding、connection 或 callback 可停止新的授权工作。通过正常配置发布流程轮换秘密，保持平台身份稳定。
改变 app/guild/Bot 身份后，旧通知不会转发给同名新连接。

完整且目的地匹配的回执才是 `delivered`；明确失败是 `rejected`。
仅明确的 429 允许到期重试回复。丢失响应、服务端失败和过期 `sending` lease 保留为 `unknown`，不会自动重发。
先查远端消息与 journal/outbox，再决定是否创建新请求。

回滚前停用 ingress 并排空 worker，再更换程序或恢复兼容备份。迁移 013 新增版本化 reply payload 列；
不要删除请求、journal/outbox 来清除 unknown。注销平台资源前核对当前归属，只处理本部署拥有的资源。

仓库测试使用 HTTP 替身和真实本地存储；真实平台需单独凭据并独立验收。
本地通过不代表客户端呈现或公网回调已验证。
