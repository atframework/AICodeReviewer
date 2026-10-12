---
title: Slack
description: 通过 Slack 发送审查报告和执行授权的审查命令。
---

AICR 支持 `slack_app`，每次发布一条聚合报告，通过 HTTP 接收 `help`、`chat-id`、`review`、`status` 四种命令。
原生作者提醒、目录、按钮和自然语言请求未纳入此实现。

## 创建和安装

创建 Slack app。从仓库根目录生成 manifest：

```bash
node scripts/register-social-im.mjs --platform slack --callback-url https://aicr.example.org/callbacks/im/bot
```

在 Slack 应用控制台导入输出中的 `manifest` 对象，安装到指定 workspace，并把 Bot 邀请到每个命令/报告频道。
记录 app ID、team ID、Bot user ID、Bot OAuth token 和 signing secret。在服务环境设置
`AICR_SLACK_TOKEN` 和 `AICR_SLACK_SIGNING_SECRET`。回调验签使用 signing secret，出站发送使用 Bot token。

| Bot scope | 用途 |
| --- | --- |
| `chat:write` | 发送报告和终态回复 |
| `channels:read` | 核验公开频道身份、类型和成员关系 |
| `groups:read` | 配置私有频道时核验其身份 |
| `commands` | 注册和使用 `/aicr` |

支持已加入的公开/私有频道。DM、多人 DM、线程和跨 Slack Connect 租户扩展未纳入接入范围。
不能靠 ID 前缀判断频道类型。依据：[manifest](https://docs.slack.dev/reference/app-manifest/)、
[频道元数据](https://docs.slack.dev/reference/methods/conversations.info/)。

## 发送报告

从 [example/slack-app.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/slack-app.yaml) 开始，
替换所有合成 ID 并设置 token 环境变量。output 引用 `im.connections.bot` 和准确目的地，
`ws.outputs.summary: [report]` 选择报告渠道。实际审查前合并已有 VCS/LLM 配置。
file-only 可以发送报告；干净结果默认使用 `publish_if_summary`，覆盖方式见[输出策略](/zh-cn/configuration/outputs/)。

模板仍按 named、workspace、内置的正常优先级选择。总预算为 3900 个 UTF-16 单位，
包含截断提示及可用的安全报告链接。Slack 转义不可信提醒标记并关闭链接展开。

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

连接、actor、会话、仓库映射的精确交集决定权限，不接受任意用户、目录 scope、通配仓库或额外命令。

manifest 设置 slash command URL；服务启动不会注册命令或事件订阅。URL 为公网 HTTPS 地址加 `server.path_prefix`（若有）和 `/callbacks/im/bot`。Slack 要求三秒内初次 ACK；AICR 本地接收预算为一秒，返回仅操作者可见的回复。

## 验证流程

1. 在配置的用户和会话中执行 `/aicr help`、`/aicr chat-id`。
2. 用合成仓库中的真实固定提交执行 `/aicr review demo 0123456789abcdef0123456789abcdef01234567`。
   Git revision 为 7–64 位十六进制，配置的 P4/SVN 使用固定正整数。
3. 保存 request ID，执行 `/aicr status <request-id>`。
4. 核对完整报告只发到配置的输出目的地；来源会话只收 ID、状态和查询说明。
   status 保持同 actor、连接、会话和当前允许的仓库。

ACK 只代表接收，不代表完成分析。后台 readiness 核对平台身份及已配置目的地元数据，缓存 300 秒；
不可用时拒绝接收。本地接收预算为一秒，callback 不等待 VCS、模型、readiness 网络请求或消息发送。

## 运维与排障

回调 401 通常表示 signing secret、原始请求体或时间戳不匹配；允许的时钟偏差为五分钟。503 表示 readiness 或持久审查执行尚不可用。`not_in_channel` 或私有频道失败应核对 Bot 成员关系与 `groups:read`。Slack `internal_error`/`fatal_error` 可能部分成功，保留为 `unknown`。依据：[验签](https://docs.slack.dev/authentication/verifying-requests-from-slack/)、[消息错误](https://docs.slack.dev/reference/methods/chat.postMessage/)。

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
