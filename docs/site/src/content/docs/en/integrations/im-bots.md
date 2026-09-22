---
title: IM bots
description: Push aggregated review summaries to Feishu (飞书) and WeCom (企业微信) group bots.
---

AICodeReviewer can push aggregated review problems to a Feishu or WeCom group
via a custom-bot webhook or a Feishu custom application's bot. These are **summary** channels — they receive the
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

## Feishu custom application

Use `feishu_app` to send reports as a custom application's bot. Enable the bot
capability, publish the application, and add it to the report group and member
source group. These groups may differ. A direct-message recipient must be within
the application's availability scope. This outbound integration needs no event
subscription, callback server, or WebSocket connection.

### Create the app and grant permissions

1. Create a **custom enterprise app** in the [Developer Console](https://open.feishu.cn/app).
   Under **App capabilities → Add capabilities**, enable **Bot**.
2. Open **Development configuration → Permissions → API permissions** and search
   for the scope identifiers below. Grant **application identity** permissions:
   AICR uses `tenant_access_token` and needs no user OAuth authorization.
3. For profile matching, add the source group's users or departments under
   **Permissions → Data permissions → Contact permission scope**. Group-member
   access does not expand this scope; app availability is a separate setting.
4. Create a version under **App release → Version management and release**, set
   its availability, submit it for review and confirm activation. After later
   permission or availability changes, complete publication and administrator
   approval as instructed by the console.
5. Add the bot to the report group and, when using a directory, the group in
   `member_directory.chat_id`. Allow the bot to speak in the report group.
   Direct-message recipients must be within the app's availability scope.

The following scopes cover the APIs AICR calls. Sending reports to `chat_id` or
`open_id` alone needs only the first row. Directory association adds group-member access, the contact API
permission and the required profile-field permissions.

| Purpose | Scope identifier | When needed |
| --- | --- | --- |
| Send reports as the app | `im:message:send_as_bot` | Required for every `feishu_app` channel |
| List source-group members | `im:chat.members:read` | A directory is configured and `mention_author` is enabled |
| Call the user-profile API | `contact:contact.base:readonly` | Enrich members through `GET /contact/v3/users/:user_id` |
| Name, English name and alias | `contact:user.base:readonly` | Read `name`, `en_name` and `nickname` |
| Email | `contact:user.email:readonly` | Recommended for matching the `email` field |
| Enterprise email | `contact:user.employee:readonly` | Read `enterprise_email` |
| Mobile number | `contact:user.phone:readonly` | Read `mobile` |
| User ID | `contact:user.employee_id:readonly` | Read `user_id` or use `receive_id_type: user_id` |

API access and field access are separate checks: `contact:user.base:readonly`
alone does not grant access to the contact API. The table selects a supported
combination; existing alternative scopes listed by the official API pages do
not require additional broader grants. AICR lists members and renders mentions
with `open_id`, so mentions do not require mobile numbers or `user_id`.
`email` and `enterprise_email` have different field permissions; enterprise
email also requires the administrator to enable Feishu Mail. Grant all rows
only if you need all supported profile fields, and check that users have filled
in those fields.

Sources: [send message](https://open.feishu.cn/document/server-docs/im-v1/message/create),
[list group members](https://open.feishu.cn/document/server-docs/group/chat-member/get),
[get user information](https://open.feishu.cn/document/server-docs/contact-v3/user/get)
and [app availability](https://open.feishu.cn/document/home/introduction-to-scope-and-authorization/availability).
External users, users outside the contact scope and unauthorized sensitive fields
may remain unavailable. AICR keeps available group data and omits uncertain
mentions. For error `41050`, check contact scope; for `230002`, check that the
bot is in the recipient group; for `230013`, check the direct recipient's app
availability.

### Configure AICR

Set `AICR_FEISHU_APP_SECRET` in the server environment, then merge this configuration:

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

`app_id` and `receive_id` are required. Choose exactly one of `app_secret_env`
or literal `app_secret`; database-backed literals use the existing sealing and
masked-edit workflow. `receive_id_type` defaults to `chat_id`; `open_id`,
`user_id`, `union_id` and `email` target individual users. `base_url` defaults to
`https://open.feishu.cn`; the only alternative is `https://open.larksuite.com`.
Do not append `/open-apis`. Open IDs are application-specific.

Both Feishu channels share built-in `feishu-summary.hbs`, problem rendering,
JSON 2.0 cards and `publish_if_summary` as the default zero-problem policy.
Named `templates.summary` / `templates.problem` references take precedence.
Workspace lookup checks the channel name, then `feishu_app.*`, then
`feishu_bot.*`, then generic templates. A webhook workspace template can
therefore also render application reports. Application sends wrap the card as
a JSON string in the message API's `content` field.

With `mention_author: true`, AICR pages through `member_directory.chat_id` and
enriches each member with the fields the app may read: `name`, `en_name`,
`nickname`, `email`, `enterprise_email`, `mobile`, `open_id`, `user_id` and
`union_id`. Only these fields are kept in memory. The cache lasts 12 hours by
default; `cache_ttl_seconds` accepts 0–604800 (7 days), with 0 disabling reuse.
The channel value overrides the global
`outputs.author_resolution.directory_cache_ttl_seconds`. A new configuration
generation has a separate cache. Both TTL fields support static files and database
configuration, under the usual file ownership rules. Temporary transport, HTTP 429
or HTTP 5xx failures may use an expired snapshot with a diagnostic; the next call
retries. Permission rejections and incomplete member lists invalidate the snapshot.
Zero TTL keeps no snapshot for fallback. Without a usable snapshot the report sends
without mentions. Directory data stays in the host's publication path and the
dedicated identity call; review MCP tools do not expose the member list. Profiles use at most
four concurrent requests; each request has a 15-second timeout and the refresh
has a 60-second work budget.

Matching uses case-insensitive, Unicode-normalized values in this order:

1. Channel-local `user_mappings`: exact author email, username, display name or
   complete P4 submitter workspace to the same app's `open_id`. If a directory
   is configured, the mapped user must be in that directory.
2. P4 `submitterWorkspace` against complete identifier segments separated by
   punctuation or spaces. For example, `build_alice_PC` matches alias `alice`;
   `malice_PC` does not. Short aliases below three characters are excluded here,
   except Chinese names with at least two characters. A unique workspace match
   takes precedence over a shared account such as `admin`, even if that login
   matches another member's email local part. Other providers skip this step.
3. Full author email against personal or enterprise email.
4. Exact username/display name against names, aliases, email local parts,
   phone numbers or IDs.
5. If all rules have no match and `guess_author` is enabled, a dedicated LLM
   call may associate the submitter with one directory candidate or abstain.

A tier with multiple candidates suppresses the mention without trying weaker
tiers or the model; this includes ambiguous P4 workspaces, even with
`mention_fallback: all`. The global email blacklist also suppresses it. AICR
does not use the push delivery actor or the analysis service's P4 workspace.
`mention_author` defaults to false. Without a directory, only explicit
`user_mappings` resolve users; global Git login mappings are not Feishu IDs.
Use `mention_fallback: skip` to avoid notifying everyone on an unmatched author.

`guess_author` defaults to true for `feishu_app`. Setting it to false disables
workspace heuristics and the model fallback while retaining explicit mappings
and exact email/name/alias matches. `mention_author` remains the switch for
actual notifications; when false, neither the directory nor the model is called.
Git output channels retain their platform-native author resolution. Webhook
Feishu and WeCom bots have no member-directory capability and never run this
model association.

For alias `owent` and work email `admin@owent.net`, P4 workspace
`owent_myrion-pc_6689`, independent P4 username `owent`, or GitHub/Gitea username
`owent` and that email already match through rules. No model call is needed.
For otherwise unmatched evidence, configure an independent model group:

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

Merge the group into your existing configuration. Selection is workspace
instance → workspace defaults → `llm.author_resolution_model_chain` →
`llm.default_model_chain`; it does not inherit the workspace review group.
All three fields support static files and database management. In the dashboard,
use **Model groups → Model chains** for the global setting and **Workspaces**
for defaults or instance overrides. Normal database priority/reset and model-group
reference validation apply. Each running task keeps its admitted configuration
generation even if settings are published before its report is sent.

The dedicated identity prompt sends only submitter identity hints and candidate
names, aliases and emails to the selected model provider. Phone numbers, native
directory IDs, credentials, review code and reports are excluded. Candidate keys
are temporary; the host validates membership and renders the mention. Directory
records never enter the main code-review prompt or persistent report state.
Only an allowed candidate with high model confidence is accepted. Ambiguity,
abstention, invalid output, model failure or a 15-second deadline suppresses @
without suppressing the report, including with `mention_fallback: all`.
The call uses the configured fallback/retry chain, provider limits and shared
run/daily budgets. More than 500 candidates or a serialized input over 64,000
characters skips model analysis entirely; candidates are never silently truncated.
See the [configuration reference](/en/reference/config-fields/) for field paths.

Directory failures or security-limited membership lists send the report without
mentions. Contact lookup failures retain only the available group fields and
emit a diagnostic without personal data. A source-group match may not be a
member of the report group; actual mention delivery still depends on Feishu's
membership and notification rules. Validate that boundary in your tenant.

The client caches tenant access tokens and refreshes an explicitly rejected
token once. HTTP errors, nonzero API codes and missing message receipts fail
publication. Delivery may already have occurred after a transport failure.
Automatic commit batches persist the send identity and reuse its UUID for up to
59 minutes after the first attempt; SQLite or Redis retains it across restarts.
An expired UUID or changed uncertain request blocks resending. Other review
paths reuse an in-memory UUID only for the token retry, without restart recovery.

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

The IM channel kinds share the common output-channel fields documented in
[Output channels config](/en/configuration/outputs/). The fields most relevant
to IM bots:

| Field | Meaning |
| --- | --- |
| `webhook_url_env` | Webhook channels: env var name holding the bot webhook URL |
| `secret_env` | `feishu_bot`: env var name holding the signing secret |
| `mention_author` | `true` to @-mention the commit author when resolvable |
| `mention_fallback` | `all` (mention @all) or `skip` when the author can't be resolved |
| `no_problems` | Zero-problem policy for this channel (`publish` / `suppress` / `publish_if_summary`) |

For routing, target-kind matching, and the zero-problem policy, see
[Output channels](/en/integrations/output-channels/) and
[Output channels config](/en/configuration/outputs/).
