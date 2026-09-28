# IM 集成草案示例

这些片段属于[开发计划](../Plan.md)。自 IM-05 起 `wecom_app` 应用发送已接线
（连接引用、recipients/appchat 目标、2048 字节 UTF-8 安全分片、逐片回执）；
回调、文件目录与命令评审运行时仍未接线，数据库发布侧对无消费者记录仍由能力门禁拒绝，
不要把片段复制到生产 `config.yaml` 期待完整功能。
字段规则见[集成设计](../docs/design/im-integrations.md)和[文件目录](../docs/design/member-directory.md)。
开发按[执行手册](../docs/design/im-implementation.md)逐项推进，不能把 YAML 语法检查当运行验收。
凭据及人员资料均为占位值，不包含真实成员信息。

## 连接、输出与命令授权

```yaml
config_sources:
  database:
    enabled: true
    backend: storage

im:
  connections:
    corp-review:
      kind: wecom_app
      corp_id: ww_example
      agent_id: 1000002
      app_secret_env: AICR_WECOM_APP_SECRET
      callback:
        enabled: true
        token_env: AICR_WECOM_CALLBACK_TOKEN
        encoding_aes_key_env: AICR_WECOM_CALLBACK_AES_KEY
  command_bindings:
    reviewers:
      enabled: true
      connection: corp-review
      # 应用单聊，actor 必须使用这个企业中的真实 userid。
      conversations:
        - kind: app_direct
      actors:
        - type: wecom_userid
          id: alice_zhang
      commands: [help, chat-id, review, status]
      repositories:
        service:
          workspace: service-main
          source_trigger: github-main
          repo_ref: example-org/service
      report_policy: workspace_routes

outputs:
  channels:
    - name: wecom-application
      kind: wecom_app
      connection: corp-review
      target:
        kind: recipients
        users: [alice_zhang]
    - name: wecom-group
      kind: wecom_bot
      webhook_url_env: AICR_WECOM_GROUP_WEBHOOK
      mention_author: true
      mention_fallback: skip
      guess_author: false
      member_directory:
        source: file
        path: ./private/im-members.yaml
        directory_id: engineering-wecom
        identity_scope:
          kind: wecom_corp
          id: ww_example
        watch: true
        debounce_ms: 300
        poll_interval_seconds: 30
```

`github-main`、`service-main` 和输出路由必须在完整配置中存在且互相匹配。
review 命令还要求 SQLite/PG StoreDb、持久 ConfigStore、密封密钥及已接线 worker；
`backend: storage` 表示使用现有 storage.database，并不是新建名为 storage 的数据库。
文件目录的可选 `allowed_root` 缺省为主配置 baseDir；挂载在其他位置时显式指定管理员受信根。
应用单聊的会话策略不等于允许所有成员发命令，必须同时命中 actors。
群命令绑定必须列出明确的 typed chat ID，不接受任意群通配。
将 `target` 改成 `{kind: appchat, chat_id: exampleChat123}` 需要该应用具备对应群接口权限；
不能填入普通 webhook key 或 API 模式机器人 chatid。

## 成员文件

以下为 `./private/im-members.yaml` 的完整示意。多个目录互相隔离，频道只选择其中一个。

```yaml
version: 1
directories:
  engineering-wecom:
    platform: wecom
    identity_scope:
      kind: wecom_corp
      id: ww_example
    members:
      - key: alice
        display_name: Alice Zhang
        aliases: [张三]
        emails: [alice@example.invalid]
        vcs_accounts:
          - provider: github
            source_trigger: github-main
            username: alice-dev
        mention:
          type: wecom_userid
          id: alice_zhang
  engineering-feishu:
    platform: feishu
    identity_scope:
      kind: feishu_app
      id: cli_example
    members:
      - key: alice
        display_name: Alice Zhang
        emails: [alice@example.invalid]
        mention:
          type: feishu_open_id
          id: ou_example_alice
```

JSON 使用相同字段和类型。以临时文件写完并验证后，再原子替换正式文件；
服务端父目录 watch 加定时摘要检查负责重新读取。删除成员时发布不含该成员的有效目录，
显式 `members: []` 表示清空，损坏文件不会授权使用旧身份或 @all。
通讯录需要在部署的本地忽略目录中维护，不能提交真实邮箱/手机号到示例仓库。

## 命令交互

```text
aicr chat-id
aicr review service 0123456789abcdef0123456789abcdef01234567
aicr status <request-id>
```

例中的 SHA 仅示意语法，不代表存在的提交。服务端在 accepted 后验证目标，拒绝不可用/未授权修订。
群聊在命令前 @当前机器人；应用单聊直接发送。按钮使用服务器生成的 action ID，
不要求用户填写 raw callback JSON 或任何管理员 token。
