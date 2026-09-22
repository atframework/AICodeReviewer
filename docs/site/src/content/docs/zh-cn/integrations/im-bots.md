---
title: IM 机器人
description: 把聚合后的评审摘要推送到飞书和企业微信群机器人。
---

AICodeReviewer 可以通过自定义机器人 webhook 或飞书自建应用机器人发送聚合后的评审问题。
这些都是**摘要** channel，接收汇总后的评审结果。在 `outputs.routes`
或按 workspace 的 `outputs.summary` 中配置路由。

## 飞书

### 1. 创建自定义机器人

1. 打开目标群 → **设置** → **群机器人** → **添加机器人** → **自定义机器人**
2. 设置机器人名称和头像
3. 复制 **webhook URL**（`https://open.feishu.cn/open-apis/bot/v2/hook/...`）
4. 如果启用了**签名校验**（推荐），复制机器人设置里显示的签名密钥
5. 点击**保存**

### 2. 设置环境变量

```bash
# 必填
export AICR_FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"

# 仅当飞书机器人设置启用了签名校验时必填
export AICR_FEISHU_SECRET="your-signing-secret"
```

### 3. 配置输出通道

```yaml
outputs:
  channels:
    - name: feishu-code-review
      kind: feishu_bot
      webhook_url_env: AICR_FEISHU_WEBHOOK   # 持有 webhook URL 的环境变量
      secret_env: AICR_FEISHU_SECRET          # 机器人启用签名校验时必填
      mention_author: true                     # @ 提交作者
      mention_fallback: skip                   # 作者无法解析时的策略："all" | "skip"
```

### 4. 把评审事件路由到飞书

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      # 把 P4 changelist 路由到飞书
      - match:
          trigger: p4-main
          target_kind: commit
        summary: [feishu-code-review]

      # 把 GitHub push 评审路由到飞书。若不配置 summary 路由，有问题的 run
      # 可能被记为跳过（skipReason="no_output_publisher"）。
      - match:
          trigger: github
          target_kind: push
        summary: [feishu-code-review]
```

或者按 workspace 固定 channel：

```yaml
workspaces:
  instances:
    p4-main:
      source_repo:
        trigger: p4-main
        repo: "//depot/main"
      outputs:
        summary: [feishu-code-review]
```

### 5. 签名校验

当飞书机器人启用了签名校验，每个请求必须包含 `timestamp` 和 `sign` 字段。AICR 用
`secret_env` 指定的密钥自动计算签名：

```text
string_to_sign = timestamp + "\n" + secret
signature = Base64(HMAC-SHA256(key=string_to_sign, message=""))
```

如果看到错误 `19021: sign match fail`，请确认 `secret_env` 的值与飞书机器人配置页显示的
签名密钥一致。

### 6. 卡片渲染

AICR 使用 **JSON 2.0 schema**（`card.schema = "2.0"`，markdown 放在
`card.body.elements` 下）发送飞书卡片。在 2.0 下，行内代码、带语言解析的代码块、标题、
引用块和表格都能原生渲染。AICR 在分发前应用 `toFeishuMarkdown()`——它只做 Markdown 修复
和空行折叠，**不会**把标题降级为粗体或把表格降级为纯文本（那些 1.0 时代的转换反而会
破坏 2.0 渲染）。如果行内代码或代码高亮显示为字面反引号，请确认 channel dispatcher 走的是
2.0 schema 路径。

## 飞书自建应用

使用 `feishu_app` 以自建应用机器人身份发送报告。启用机器人能力、发布应用，
将机器人加入报告接收群和成员来源群；两个群可以不同。单聊接收人需要在应用可用范围内。
该集成只主动发送消息，无需事件订阅、回调服务器或 WebSocket 连接。

### 创建应用与开通权限

1. 在[开发者后台](https://open.feishu.cn/app)创建**企业自建应用**，进入
   **应用能力 → 添加应用能力**，启用**机器人**。
2. 进入 **开发配置 → 权限管理 → API 权限**，按下表搜索权限标识并开通。
   AICR 使用 `tenant_access_token`，应开通**应用身份**权限，无需用户 OAuth 授权。
3. 使用成员资料匹配时，在 **权限管理 → 数据权限 → 通讯录权限范围** 中加入成员来源群涉及的用户或部门。
   群成员列表权限不会自动扩大通讯录权限范围，应用可用范围也不能代替通讯录权限范围。
4. 在 **应用发布 → 版本管理与发布** 创建版本，配置应用可用范围，提交审核并确认生效。
   后续修改权限或可用范围时，也需按控制台提示完成发布和管理员审核。
5. 将机器人加入报告接收群；使用成员目录时，还需加入 `member_directory.chat_id` 指定的来源群。
   机器人须有接收群的发言权限。单聊接收人须在应用可用范围内。

下表按 AICR 实际调用的接口选择权限。只使用 `chat_id` 或 `open_id` 发送报告时，仅需第一项；从群成员资料关联提交者时，
再开通群成员、通讯录接口和相应字段权限。

| 用途 | 权限标识 | 控制台权限名称 / 何时需要 |
| --- | --- | --- |
| 主动发送报告 | `im:message:send_as_bot` | **以应用的身份发消息**；所有 `feishu_app` 频道必需 |
| 拉取来源群成员 | `im:chat.members:read` | **查看群成员**；配置成员目录且开启 `mention_author` 时需要 |
| 调用成员资料接口 | `contact:contact.base:readonly` | **获取通讯录基本信息**；调用 `GET /contact/v3/users/:user_id` 补充资料时需要 |
| 姓名、英文名、别名 | `contact:user.base:readonly` | **获取用户基本信息**；读取 `name`、`en_name`、`nickname` 时需要 |
| 邮箱 | `contact:user.email:readonly` | **获取用户邮箱信息**；按 `email` 匹配时建议开通 |
| 企业邮箱 | `contact:user.employee:readonly` | **获取用户受雇信息**；需要 `enterprise_email` 时开通 |
| 手机号 | `contact:user.phone:readonly` | **获取用户手机号**；需要 `mobile` 时开通 |
| 用户 ID | `contact:user.employee_id:readonly` | **获取用户 user ID**；需要读取 `user_id` 或配置 `receive_id_type: user_id` 时开通 |

接口调用权限和字段权限是两层检查；单独开通 `contact:user.base:readonly` 不能代替通讯录接口权限。
上表选用接口页列出的权限组合；若已有官方列出的替代权限，无需重复申请更宽权限。
默认使用 `open_id` 拉取群成员和生成 @，无需为了 @ 额外读取手机号或 `user_id`。
`email` 与 `enterprise_email` 的字段权限不同；后者还要求企业管理员已启用飞书邮箱服务。
如需完整获取本功能支持的资料，可申请表中全部权限，并确认用户资料本身已填写。

核对依据：官方[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、
[获取群成员列表](https://open.feishu.cn/document/server-docs/group/chat-member/get)、
[获取单个用户信息](https://open.feishu.cn/document/server-docs/contact-v3/user/get)及
[配置应用可用范围](https://open.feishu.cn/document/home/introduction-to-scope-and-authorization/availability)。
外部成员、不在通讯录授权范围内的成员，或未授权的敏感字段，可能无法补全；
AICR 保留可用群内资料，匹配不确定时不 @。遇到 `41050` 优先检查通讯录权限范围，
`230002` 检查机器人是否在接收群，`230013` 检查单聊接收人的应用可用范围。

### 配置 AICR

在服务端环境设置 `AICR_FEISHU_APP_SECRET`，再合并以下配置：

```yaml
outputs:
  channels:
    - name: feishu-app-review
      kind: feishu_app
      app_id: cli_replace_me
      app_secret_env: AICR_FEISHU_APP_SECRET
      receive_id_type: chat_id
      receive_id: oc_report_group
      mention_author: true
      mention_fallback: skip
      guess_author: true
      member_directory:
        chat_id: oc_member_source_group
        cache_ttl_seconds: 300
      user_mappings:
        "alice@example.com": ou_replace_with_app_open_id
        "alice-dev-workspace": ou_replace_with_app_open_id
  routes:
    default:
      summary: [feishu-app-review]
```

`app_id` 和 `receive_id` 必填；`app_secret_env` 与明文 `app_secret` 二选一。
数据库配置中的明文凭据沿用现有加密存储和脱敏编辑流程。
`receive_id_type` 默认为 `chat_id`；`open_id`、`user_id`、`union_id` 和 `email`
用于指定个人接收人。`base_url` 默认为 `https://open.feishu.cn`，唯一备选值是
`https://open.larksuite.com`，无需添加 `/open-apis`。Open ID 在不同应用间不通用。

两种飞书渠道共享内置 `feishu-summary.hbs`、问题渲染、JSON 2.0 卡片和默认零问题策略
`publish_if_summary`。命名模板 `templates.summary` / `templates.problem` 优先；
工作区目录按渠道名、`feishu_app.*`、`feishu_bot.*`、通用模板的顺序查找，
因此已有 webhook 工作区模板也能用于应用报告。应用发送时将卡片序列化为 JSON 字符串，
放入消息接口的 `content` 字段。

设置 `mention_author: true` 后，AICR 分页读取 `member_directory.chat_id`，
再补充应用有权限读取的 `name`、`en_name`、`nickname`、`email`、`enterprise_email`、
`mobile`、`open_id`、`user_id` 和 `union_id`。只在内存保存这些字段；默认缓存 12 小时，
`cache_ttl_seconds` 范围为 0–604800（7 天），0 表示不复用缓存。渠道值覆盖全局
`outputs.author_resolution.directory_cache_ttl_seconds`。新配置代次使用独立缓存。
两个 TTL 字段均支持静态文件与数据库配置，沿用文件来源的优先级与锁定规则。
临时网络、HTTP 429 或 HTTP 5xx 失败可沿用过期快照并记录诊断，每次后续调用重新刷新。
权限拒绝或成员列表不完整会清除快照；TTL 为 0 时不保留快照用于回退。没有可用快照时
报告不带 @ 照常发送。成员数据只供宿主发布链路与独立身份模型调用使用，评审 MCP 工具
不暴露成员列表。资料请求最多并发 4 个，单次请求超时 15 秒，刷新工作预算为 60 秒。

匹配时统一 Unicode 表示并忽略大小写，按以下优先级查找：

1. 渠道内 `user_mappings`：作者邮箱、用户名、显示名或完整 P4 提交者 workspace
   精确映射到当前应用的 `open_id`。配置目录时，映射目标必须在来源群中。
2. 作者完整邮箱与个人邮箱或企业邮箱匹配。
3. 用户名或显示名与中英文名、别名、邮箱本地部分、手机号或 ID 精确匹配。
4. P4 的 `submitterWorkspace` 按标点或空格分隔后匹配完整标识片段。
   例如 `build_alice_PC` 匹配别名 `alice`，`malice_PC` 不匹配。
   此步骤排除不足三个字符的短别名，至少两个汉字的中文姓名除外。
5. 所有规则均未匹配且 `guess_author` 开启时，使用独立 LLM 调用选择一个目录候选人，
   或返回无法确定。

同一优先级出现多个候选时跳过 @，即使配置了 `mention_fallback: all` 也不会转为 @ 所有人；
全局邮箱黑名单同样禁止 @。AICR 不使用 push 投递者或分析服务自己的 P4 workspace 猜测作者。
`mention_author` 默认为 false；未配置目录时，只有显式 `user_mappings` 能解析个人，
全局 Git 登录名映射不能当作飞书 ID。推荐使用 `mention_fallback: skip`，避免未匹配作者触发群提醒。

`feishu_app` 的 `guess_author` 默认开启。设为 false 会关闭 workspace 推测和模型兜底，
保留显式映射及邮箱、姓名、别名的精确匹配。`mention_author` 仍控制实际通知；关闭时不拉目录，
也不调用关联模型。Git 输出频道沿用平台原生作者解析。飞书 webhook 和企业微信 webhook
机器人没有成员目录能力，不执行模型关联。

对于别名 `owent`、工作邮箱 `admin@owent.net`，P4 workspace `owent_myrion-pc_6689`、
独立 P4 用户名 `owent`，或 GitHub/Gitea 的同名用户及该邮箱，已有规则即可匹配，无需调用模型。
其他未匹配的信息可以使用独立模型组：

```yaml
llm:
  model_chain:
    default:
      - provider: your-existing-provider
        model: your-review-model
        role: heavy
    directory-identity:
      - provider: your-existing-provider
        model: your-identity-model
        role: light
  author_resolution_model_chain: directory-identity
workspaces:
  defaults:
    author_resolution_model_chain: directory-identity
  instances:
    your-workspace:
      author_resolution_model_chain: directory-identity
```

将模型组合并进现有配置。选择顺序为 workspace 实例 → workspace defaults →
`llm.author_resolution_model_chain` → `llm.default_model_chain`，不会继承 workspace 的审查主链。
三个字段都支持静态文件和数据库管理。管理界面的 **Model groups → Model chains** 设置全局值，
**Workspaces** 设置默认值及实例覆盖。沿用数据库优先级、重置和模型组引用校验；
报告发送前即使发布了新配置，运行中的任务仍使用接收时固定的配置版本。

专用身份提示词只向选定模型提供提交者身份线索、候选人的姓名、别名和邮箱；
不包含手机号、目录原生 ID、凭据、审查代码或报告。候选编号为临时值，程序校验其成员资格后生成 @。
目录资料不会进入主代码审查提示词或持久化报告状态。只有允许的候选且模型置信度为高时才接受；
重名、无法确定、无效输出、模型异常或超过 15 秒均跳过 @，报告照常发送，
即使配置 `mention_fallback: all` 也不会转成全员通知。
关联调用使用配置的回退链、重试、provider 限流及共享单次/每日预算。
候选超过 500 人或序列化输入超过 64,000 字符时，整体跳过模型分析，不截断候选列表。
完整字段路径见[配置参考](/zh-cn/reference/config-fields/)。

目录读取失败或成员列表受安全限制时，报告继续发送但不带 @。通讯录资料查询失败时，
保留可用群内字段，并记录不含个人资料的诊断。来源群匹配到的人可能不在报告接收群中；
实际 @ 效果仍取决于飞书的群成员和通知规则，需要在目标租户验收。

客户端缓存租户访问令牌，令牌被明确拒绝时刷新并重试一次。HTTP 错误、非零 API 状态码
或缺少消息回执均使发布失败。消息传输异常可能已完成投递，因此不会自动重发；
令牌重试复用同一个发送 UUID，这不提供跨运行或重启的持久去重。

## 企业微信

### 1. 创建群机器人

1. 打开目标群 → **群设置** → **群机器人** → **添加机器人**
2. 设置机器人名称和头像
3. 复制 **webhook URL**（`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`）
4. 点击**保存**

### 2. 设置环境变量

```bash
# 必填
export AICR_WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx"
```

企业微信群机器人 webhook **不**使用 HMAC 签名校验，无需 secret 环境变量。

### 3. 配置输出通道

```yaml
outputs:
  channels:
    - name: wecom-ops
      kind: wecom_bot
      webhook_url_env: AICR_WECOM_WEBHOOK
      mention_author: false                    # @ 提交作者
      mention_fallback: skip                   # 作者无法解析时的策略："all" | "skip"
      no_problems: { action: suppress }
      # mentioned_mobile_list: ["+86-13800138000"]  # 可选：按手机号 @ 指定用户
```

### 4. 把评审事件路由到企业微信

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      # 把 P4 changelist 路由到企业微信
      - match:
          trigger: p4-main
          target_kind: commit
        summary: [wecom-ops]
```

### 5. Markdown 渲染与长度限制

企业微信群机器人消息支持部分 Markdown：标题、粗体、链接、行内代码和引用块可原生渲染。
**表格会被拍平为纯文本行。** 代码块会被保留。AICR 在分发前自动应用
`toWeComMarkdown()`。

为遵守企业微信消息大小限制，消息会被**截断到 500 字符**，建议（suggestion）会被截断到
**300 字符**，并以 `...` 后缀标注。

## 公共字段

IM channel 类型共享[输出通道配置](/zh-cn/configuration/outputs/)中记录的通用输出 channel 字段。
与 IM 机器人最相关的字段：

| 字段 | 含义 |
| --- | --- |
| `webhook_url_env` | webhook 渠道：持有机器人 webhook URL 的环境变量名 |
| `secret_env` | `feishu_bot`：持有签名密钥的环境变量名 |
| `mention_author` | 为 `true` 时，可解析的情况下 @ 提交作者 |
| `mention_fallback` | 作者无法解析时的策略：`all`（@ 所有人）或 `skip` |
| `no_problems` | 该 channel 的零问题策略（`publish` / `suppress` / `publish_if_summary`） |

关于路由、target-kind 匹配和零问题策略，见[输出通道](/zh-cn/integrations/output-channels/)和
[输出通道配置](/zh-cn/configuration/outputs/)。
