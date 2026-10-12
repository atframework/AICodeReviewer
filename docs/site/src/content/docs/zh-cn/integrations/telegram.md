---
title: Telegram
description: 通过 Telegram 发送审查报告和执行授权的审查命令。
---

AICR 支持 `telegram_bot`，每次发布一条聚合报告，通过 HTTP 接收 `help`、`chat-id`、`review`、`status` 四种命令。
原生作者提醒、目录、按钮和自然语言请求未纳入此实现。

## 创建和安装

通过 BotFather 创建 Bot。把 Bot API token 放入 `AICR_TELEGRAM_TOKEN`，用 `getMe` 获取数字 Bot ID 和 username。
另设 `AICR_TELEGRAM_WEBHOOK_SECRET`，长度 1–256，仅含字母、数字、下划线或连字符；webhook secret 与 Bot token 是不同秘密。

私聊由用户先启动 Bot；群聊先添加 Bot 并允许发送消息，普通群不需要管理员权限。
保持 privacy mode，群中使用 `/aicr@BotUsername` 定向命令。
先通过已有且授权的 Bot 管理流程取得数字 actor/chat ID，再启用 binding；未知用户不能通过 `chat-id` 自行获得授权。

ID 使用带引号的十进制字符串，群 ID 可以为负数。仅支持已建立的 private/group/supergroup；
forum/topic、channel、business、匿名 `sender_chat`、Bot 自己发送及编辑更新不触发审查。
依据：[Bot API](https://core.telegram.org/bots/api)、[privacy mode](https://core.telegram.org/bots/features#privacy-mode)。

## 发送报告

从 [example/telegram-bot.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/telegram-bot.yaml) 开始，
替换所有合成 ID 并设置 token 环境变量。output 引用 `im.connections.bot` 和准确目的地，
`ws.outputs.summary: [report]` 选择报告渠道。实际审查前合并已有 VCS/LLM 配置。
file-only 可以发送报告；干净结果默认使用 `publish_if_summary`，覆盖方式见[输出策略](/zh-cn/configuration/outputs/)。

模板仍按 named、workspace、内置的正常优先级选择。总预算为 3900 个 UTF-16 单位，
包含截断提示及可用的安全报告链接。Telegram 使用显式 UTF-16 entities，不开启 parse_mode。

## 启用命令

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

连接、actor、会话、仓库映射的精确交集决定权限，不接受任意用户、目录 scope、通配仓库或额外命令。
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

## 运维与排障

401 时核对 `X-Telegram-Bot-Api-Secret-Token` 与配置的 webhook secret。群命令必须指向 `getMe` 返回的 username，不能用显示名。`blocked`/403 需要用户或群调整；群迁移不会自动改变配置 chat ID。429 的 `parameters.retry_after` 单位是秒。注册超时后先查 `getWebhookInfo`，再决定是否执行新的 apply。

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
