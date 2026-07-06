---
title: IM 机器人
description: 把聚合后的评审摘要推送到飞书和企业微信群机器人。
---

AICodeReviewer 可以通过自定义机器人 webhook 把聚合后的评审问题推送到飞书或企业微信群。
两者都是**摘要** channel——它们接收汇总后的评审结果，不接收逐行评论。在 `outputs.routes`
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

两种 IM channel 类型共享[输出通道配置](/zh-cn/configuration/outputs/)中记录的通用输出 channel 字段。
与 IM 机器人最相关的字段：

| 字段 | 含义 |
| --- | --- |
| `webhook_url_env` | 持有机器人 webhook URL 的环境变量名 |
| `secret_env` | （仅飞书）持有签名密钥的环境变量名 |
| `mention_author` | 为 `true` 时，可解析的情况下 @ 提交作者 |
| `mention_fallback` | 作者无法解析时的策略：`all`（@ 所有人）或 `skip` |
| `no_problems` | 该 channel 的零问题策略（`publish` / `suppress` / `publish_if_summary`） |

关于路由、target-kind 匹配和零问题策略，见[输出通道](/zh-cn/integrations/output-channels/)和
[输出通道配置](/zh-cn/configuration/outputs/)。
