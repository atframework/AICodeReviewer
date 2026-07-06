---
title: IM bots
description: Push aggregated review summaries to Feishu (飞书) and WeCom (企业微信) group bots.
---

AICodeReviewer can push aggregated review problems to a Feishu or WeCom group
via a custom-bot webhook. Both are **summary** channels — they receive the
rolled-up review result, not per-line comments. Configure routing in
`outputs.routes` or per-workspace `outputs.summary`.

## Feishu (飞书)

### 1. Create a custom bot

1. Open the target group → **Settings** → **Group Bots** → **Add Bot** →
   **Custom Bot**
2. Set the bot name and avatar
3. Copy the **webhook URL**
   (`https://open.feishu.cn/open-apis/bot/v2/hook/...`)
4. If you enable **signature verification** (recommended), copy the signing
   secret shown in the bot settings
5. Click **Save**

### 2. Set environment variables

```bash
# Required
export AICR_FEISHU_WEBHOOK="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"

# Required only if signature verification is enabled in Feishu bot settings
export AICR_FEISHU_SECRET="your-signing-secret"
```

### 3. Configure the output channel

```yaml
outputs:
  channels:
    - name: feishu-code-review
      kind: feishu_bot
      webhook_url_env: AICR_FEISHU_WEBHOOK   # env var holding the webhook URL
      secret_env: AICR_FEISHU_SECRET          # required if the bot has signature verification
      mention_author: true                     # @-mention the commit author
      mention_fallback: skip                   # "all" | "skip" when author can't be resolved
```

### 4. Route review events to Feishu

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      # Route P4 changelists to Feishu
      - match:
          trigger: p4-main
          target_kind: commit
        summary: [feishu-code-review]

      # Route GitHub push reviews to Feishu. Without a summary route, runs
      # with problems can be recorded as skipped (skipReason="no_output_publisher").
      - match:
          trigger: github
          target_kind: push
        summary: [feishu-code-review]
```

Or pin the channel at the workspace level:

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

### 5. Signature verification

When signature verification is enabled on the Feishu bot, every request must
include a `timestamp` and `sign` field. AICR computes the signature
automatically from the secret named by `secret_env`:

```text
string_to_sign = timestamp + "\n" + secret
signature = Base64(HMAC-SHA256(key=string_to_sign, message=""))
```

If you see error `19021: sign match fail`, verify that the `secret_env` value
matches the signing secret shown on the Feishu bot configuration page.

### 6. Card rendering

AICR sends Feishu cards using the **JSON 2.0 schema** (`card.schema = "2.0"`,
markdown placed under `card.body.elements`). Under 2.0, inline code, fenced
code blocks with language parsing, headings, blockquotes, and tables all
render natively. AICR applies `toFeishuMarkdown()` before dispatch — it only
runs Markdown fixing and blank-line collapse, and does **not** downgrade
headings to bold or tables to plain text (those 1.0-era transforms break 2.0
rendering). If inline code or code highlighting ever appears as literal
backticks, confirm the channel dispatcher is on the 2.0 schema path.

## WeCom (企业微信)

### 1. Create a group bot

1. Open the target group → **Group Settings** → **Group Bots** → **Add Bot**
2. Set the bot name and avatar
3. Copy the **webhook URL**
   (`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`)
4. Click **Save**

### 2. Set environment variables

```bash
# Required
export AICR_WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx"
```

WeCom group-bot webhooks do **not** use HMAC signature verification; no secret
env var is needed.

### 3. Configure the output channel

```yaml
outputs:
  channels:
    - name: wecom-ops
      kind: wecom_bot
      webhook_url_env: AICR_WECOM_WEBHOOK
      mention_author: false                    # @-mention the commit author
      mention_fallback: skip                   # "all" | "skip" when author can't be resolved
      no_problems: { action: suppress }
      # mentioned_mobile_list: ["+86-13800138000"]  # optional: @ specific users by phone
```

### 4. Route review events to WeCom

```yaml
outputs:
  routes:
    default:
      line_comments: [gitea-pr-review]
      summary: [gitea-pr-review]
    rules:
      # Route P4 changelists to WeCom
      - match:
          trigger: p4-main
          target_kind: commit
        summary: [wecom-ops]
```

### 5. Markdown rendering and limits

WeCom group-bot messages support a subset of Markdown: headings, bold, links,
inline code, and blockquotes render natively. **Tables are flattened to
plain-text rows.** Code fences are preserved. AICR applies
`toWeComMarkdown()` automatically before dispatch.

To stay within WeCom message-size limits, messages are **truncated to 500
characters** and suggestions to **300 characters**, with a `...` suffix.

## Common fields

Both IM channel kinds share the common output-channel fields documented in
[Output channels config](/en/configuration/outputs/). The fields most relevant
to IM bots:

| Field | Meaning |
| --- | --- |
| `webhook_url_env` | Env var name holding the bot webhook URL |
| `secret_env` | (Feishu only) Env var name holding the signing secret |
| `mention_author` | `true` to @-mention the commit author when resolvable |
| `mention_fallback` | `all` (mention @all) or `skip` when the author can't be resolved |
| `no_problems` | Zero-problem policy for this channel (`publish` / `suppress` / `publish_if_summary`) |

For routing, target-kind matching, and the zero-problem policy, see
[Output channels](/en/integrations/output-channels/) and
[Output channels config](/en/configuration/outputs/).
