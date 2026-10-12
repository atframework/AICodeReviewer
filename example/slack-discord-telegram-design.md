# Slack、Discord、Telegram 配置草案

状态：待实施，不能作为当前运行配置加载。这里固定[接入规范](../docs/design/slack-discord-telegram.md)中的字段和关系，
供后续模型实现及编写可运行样例；没有创建应用或注册回调。所有 ID/凭据都是占位值。
实现完成后按[文档交付任务](../docs/design/slack-discord-telegram-execution.md#sdc-09最终使用文档与可运行样例)
生成经 compiler/bootstrap 验证的独立 YAML 样例和双语指南。

## 仅发送结果

以下片段需合并到已有完整配置，`demo` workspace、源 trigger、模型和存储由该配置定义。
输出频道加入实际 workspace 的 summary 路由后才会发送；仅创建 connection 不会发送。

```yaml
im:
  connections:
    slack-review:
      kind: slack_app
      app_id: A0123456789
      team_id: T0123456789
      bot_user_id: U0123456789
      token_env: AICR_SLACK_TOKEN
    discord-review:
      kind: discord_bot
      application_id: "123456789012345678"
      guild_id: "234567890123456789"
      token_env: AICR_DISCORD_TOKEN
    telegram-review:
      kind: telegram_bot
      bot_id: "1234567890"
      token_env: AICR_TELEGRAM_TOKEN

outputs:
  channels:
    - name: slack-report
      kind: slack_app
      connection: slack-review
      channel_id: C0123456789
      no_problems: { action: publish_if_summary }
    - name: discord-report
      kind: discord_bot
      connection: discord-review
      channel_id: "345678901234567890"
      no_problems: { action: publish_if_summary }
    - name: telegram-report
      kind: telegram_bot
      connection: telegram-review
      chat_id: "-1001234567890"
      no_problems: { action: publish_if_summary }

workspaces:
  instances:
    demo:
      outputs:
        summary: [slack-report, discord-report, telegram-report]
```

Slack Bot 需要加入频道；Discord Bot 需要所属 guild 和目标频道权限；Telegram 私聊先由用户开始，群里先加入 Bot。
本期三种 output 不接受线程、topic、任意 API origin 或原生作者提醒字段。
file-only 配置可以只发送；命令需要下面的持久配置前提。

## 增加命令入口

在前一段连接上合并 callback，不替换 token/身份字段。命令启用须已有 SQLite/PG StoreDb、
数据库 ConfigStore、有效持久 snapshot 和已启动 worker；不能只粘贴 `enabled: true` 就认为完整部署。
数据库配置形式以实施时的存储文档和现有部署配置为准。

```yaml
config_sources:
  database:
    enabled: true
    backend: storage

im:
  connections:
    slack-review:
      callback:
        enabled: true
        signing_secret_env: AICR_SLACK_SIGNING_SECRET
    discord-review:
      callback:
        enabled: true
        # 公开验证材料，占位值，必须替换为 Developer Portal 的真实 public key。
        public_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    telegram-review:
      callback:
        enabled: true
        secret_token_env: AICR_TELEGRAM_WEBHOOK_SECRET
  command_bindings:
    slack-reviewers:
      enabled: true
      connection: slack-review
      actors: [{ type: slack_user_id, id: U1234567890 }]
      conversations: [{ kind: channel, id: C0123456789 }]
      commands: [help, chat-id, review, status]
      report_policy: workspace_routes
      repositories:
        demo: { workspace: demo, source_trigger: git-source, repo_ref: example/demo }
    discord-reviewers:
      enabled: true
      connection: discord-review
      actors: [{ type: discord_user_id, id: "456789012345678901" }]
      conversations: [{ kind: channel, id: "345678901234567890" }]
      commands: [help, chat-id, review, status]
      report_policy: workspace_routes
      repositories:
        demo: { workspace: demo, source_trigger: git-source, repo_ref: example/demo }
    telegram-reviewers:
      enabled: true
      connection: telegram-review
      actors: [{ type: telegram_user_id, id: "2345678901" }]
      conversations: [{ kind: group, id: "-1001234567890" }]
      commands: [help, chat-id, review, status]
      report_policy: workspace_routes
      repositories:
        demo: { workspace: demo, source_trigger: git-source, repo_ref: example/demo }
```

`git-source` 必须是真实存在且覆盖 `example/demo` 的 VCS trigger，workspace 和路由也须相容。
Telegram 私聊另建无重叠 binding，conversation 为 `{kind: bot_direct}`，actor 仍显式列出用户。
后台配置的秘密引用需要现有 secret_refs 用途授权；不要复制其他连接的授权目标。

## 用户操作样本

| 平台 | 帮助 | 重新评审 | 状态 |
| --- | --- | --- | --- |
| Slack | `/aicr help` | `/aicr review demo <完整提交号>` | `/aicr status <request-id>` |
| Discord | `/aicr command:help` | `/aicr command:review demo <完整提交号>` | `/aicr command:status <request-id>` |
| Telegram 私聊 | `/aicr help` | `/aicr review demo <完整提交号>` | `/aicr status <request-id>` |
| Telegram 群 | `/aicr@ExampleBot help` | `/aicr@ExampleBot review demo <完整提交号>` | `/aicr@ExampleBot status <request-id>` |

Discord 的 `command:` 表示 slash UI 中名为 command 的 STRING 参数，不是自由聊天文本。
chat-id 同样替换 help 的位置。Git 使用完整固定 commit ID；P4/SVN 使用授权仓库内的固定数字 revision。
accepted 只表示已持久接收；报告发送到配置路由，源会话终态通知只给编号和状态。

## 平台注册交付要求

这部分是后续需要生成的操作资料，不是本轮已执行的操作：

- Slack manifest：bot scopes `chat:write`、`commands`、`channels:read`，使用私有频道时另加 `groups:read`；slash `/aicr` URL 为
  `https://<部署域名>/<可选路径前缀>/callbacks/im/slack-review`；不启用一般消息订阅。
- Discord command JSON：仅一条 aicr，type=CHAT_INPUT，必填 STRING option command；
  Interactions URL 指向对应 callback。注册工具只改该命令，dry-run 默认开启。
- Telegram：setWebhook 的 URL 指向对应 callback，secret_token 与配置一致，allowed_updates 至少收 message；
  本期不收 callback_query。setMyCommands 仅登记 aicr 的提示；它不替代服务端授权。
  注册前 getWebhookInfo 核对归属，不默认 drop_pending_updates。

最终用户指南必须包含实际注册步骤、最小权限、撤权/轮换、未知发送处理及验证记录；
实现前不要把这些草案片段链接为“当前可用”的平台配置。
