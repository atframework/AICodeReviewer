---
title: Telegram
description: Send review reports and run authorized review commands through Telegram.
---

AICR supports `telegram_bot` for an aggregated report and four HTTP commands: `help`, `chat-id`, `review`, `status`.
Commands must fit on one line. A newline after `/aicr@TestBot` or at the end of the message is rejected without a command reply.
Buttons and natural-language requests are outside this implementation.

## Create and install

Open [@BotFather](https://t.me/BotFather), send `/newbot` and follow the prompts for a display name and unique username.
Inject the Bot API token into `AICR_TELEGRAM_TOKEN` through your deployment environment; keep it out of browser URLs, screenshots and chats.
See [Telegram's creation tutorial](https://core.telegram.org/bots/tutorial).

### Get the Bot ID and username

Use PowerShell 7 to print only identity fields. This helper also supports the read queries below;
errors omit the request URL, which contains the token.

```powershell
function Get-AicrTelegramInfo {
  param(
    [ValidateSet('getMe', 'getWebhookInfo', 'getUpdates', 'getChat', 'getChatMember')]
    [string] $Method,
    [hashtable] $Body = @{}
  )
  if (-not $env:AICR_TELEGRAM_TOKEN) { throw 'Set AICR_TELEGRAM_TOKEN first.' }
  try {
    $response = Invoke-RestMethod -Method Post -ContentType 'application/json' -Uri (
      'https://api.telegram.org/bot' + $env:AICR_TELEGRAM_TOKEN + '/' + $Method
    ) -Body ($Body | ConvertTo-Json -Compress) -ErrorAction Stop
  } catch { throw 'Telegram request failed; check credentials and network locally.' }
  if (-not $response.ok) { throw 'Telegram rejected the request.' }
  return $response.result
}
$me = Get-AicrTelegramInfo -Method getMe
$me | Select-Object id, username, is_bot
```

Set `im.connections.bot.bot_id` to `id` and use `username` in `/aicr@YourBotUsername`.
Neither is the group ID. An authorized actor is a person's numeric ID, not their username.
See [getMe](https://core.telegram.org/bots/api#getme).

### Get the group ID

For a private destination the user must start the Bot first. For a group, add the Bot and allow it to send messages; administrative rights are not required for an ordinary group. Keep privacy mode enabled and use directed `/aicr@BotUsername` commands in groups. Obtain the numeric chat ID and any explicit actor IDs from your authorized Bot administration workflow before enabling bindings.

A display name or private invitation link cannot be passed to `getChat` to resolve a group ID. A public `@username` may identify a broadcast channel rather than a group; check the returned type. Before setting a webhook, a directed group command can supply `message.chat.id` through `getUpdates`; do not print its token or unrelated messages. Polling and webhooks cannot be used together. Unknown actors cannot bootstrap an explicit user allowlist using `chat-id`.

If directed commands produce no updates and no group message link is available, temporarily use
`allowed_updates: ["message", "my_chat_member"]` with `getUpdates` before registering the webhook.
Ask the group administrator to add the Bot again from the profile verified by `getMe`.
Read only events for that Bot and target group, then take the ID from `my_chat_member.chat.id`.
Verify the chat type with `getChat` and the Bot's own membership and sending permissions with `getChatMember`.
Do not substitute a broadcast channel, guess the ID or disable privacy mode for this check.
Production webhook registration still uses `["message"]` and preserves pending updates.
[getUpdates](https://core.telegram.org/bots/api#getupdates), [Update](https://core.telegram.org/bots/api#update), [getChatMember](https://core.telegram.org/bots/api#getchatmember).

IDs are quoted decimal strings in the safe-integer range `-9007199254740991` to `9007199254740991`. Bot and user IDs are positive; group IDs can be negative. Only established private/group/supergroup chats are supported. Forum/topic, channel, business, anonymous `sender_chat`, bot-authored and edited updates do not trigger reviews. [Bot API](https://core.telegram.org/bots/api), [privacy mode](https://core.telegram.org/bots/features#privacy-mode).

For a new Bot with no webhook, load the helper above and run:

```powershell
$webhook = Get-AicrTelegramInfo -Method getWebhookInfo
if ($webhook.url) { throw 'Webhook exists. Use its current receiver; do not poll or delete it.' }
$targetGroupName = 'Your group name' # Change this to filter candidate events
$updates = Get-AicrTelegramInfo -Method getUpdates -Body @{
  allowed_updates = @('message', 'my_chat_member'); timeout = 0
}
foreach ($update in $updates) {
  $event = if ($update.message) { $update.message } else { $update.my_chat_member }
  if ($event.chat.title -eq $targetGroupName) {
    [pscustomobject]@{
      chat_id = [string]$event.chat.id; type = $event.chat.type; title = $event.chat.title
      actor_id = [string]$event.from.id
    }
  }
}
```

Run the query once to select the event types, send `/aicr@YourBotUsername chat-id` in the group, then query again.
If it remains empty, remove and re-add the verified Bot and query again. AICR is not receiving these messages yet,
so no command reply is expected. The display name only filters candidates: correlate the result with your command
or membership change if names collide. A membership event's `actor_id` belongs to the person who changed membership,
who may not be the reviewer you intend to authorize. Verify the resulting numeric ID and Bot membership:

```powershell
$chatId = '-1001234567890' # Replace with the verified value; do not derive it from an invitation link
$chat = Get-AicrTelegramInfo -Method getChat -Body @{ chat_id = $chatId }
$chat | Select-Object id, type, title, is_forum
$member = Get-AicrTelegramInfo -Method getChatMember -Body @{ chat_id = $chatId; user_id = $me.id }
$member | Select-Object status, is_member, can_send_messages
```

The type should be `group` or a non-forum `supergroup`; also confirm the Bot can send messages there.
For an existing webhook, obtain IDs through the current receiver's authorized administration workflow;
do not delete the webhook for this procedure. Once bindings exist, `chat-id` can reply with the current actor and conversation.

## Configure AICR

Set a separate `AICR_TELEGRAM_WEBHOOK_SECRET` containing 1–256 letters, digits, underscores or hyphens.
It is different from the Bot token. For example, generate it in a deployment session and pass it to the service
environment through your deployment tool, without printing its value:

```powershell
$env:AICR_TELEGRAM_WEBHOOK_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Merge the YAML below, or sign in to the Dashboard and open **Config → IM connections → New im connection**.
Choose `telegram_bot`. In **Callback credentials**, enable the callback and set the secret env reference.
This screenshot shows the real local identity form with a synthetic ID.

[![AICR Telegram connection form with numeric Bot ID and Token env](/images/integrations/telegram-connection.png)](/images/integrations/telegram-connection.png)

Open the image for full resolution.

The connection name must match the output/binding's `connection` and the last callback URL segment;
the screenshot uses `telegram-demo`, while the YAML below uses `bot`.
For database configuration, allow environment references by purpose and destination in the file's
`config_sources.secret_refs`, then save, publish and verify the active revision and snapshot.
See [dynamic configuration](/en/configuration/overview/#dynamic-configuration-api).
Configure the group ID, command authorization and report channels, then deploy before registering the webhook.

## Send reports

Start from [example/telegram-bot.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/telegram-bot.yaml).
Replace synthetic IDs and set the token environment variable. The channel references `im.connections.bot` and an exact destination;
`ws.outputs.summary: [report]` selects it. Merge your existing VCS/LLM settings before a real review.
File-only configuration can send reports; a clean review defaults to `publish_if_summary`.
See [output policy](/en/configuration/outputs/) for overrides.

Named, workspace and built-in templates retain the normal priority. The final message budget is 3900 UTF-16 units including
the truncation notice and optional safe report link. Telegram sends explicit UTF-16 entities without parse_mode.

When the same review also publishes its full report through an issue channel, AICR sends the issue first and uses its confirmed URL for a brief notification: a headline, problem count, severity/category/location titles and a full-report link. Native author reminders are preserved. Analysis, suggestions and code remain in the issue. Without a usable confirmed URL, including an issue write failure, the channel keeps the full report. Route order does not change this behavior; no new channel option is required.

Reports have Review target, Summary and Problems sections. Headings and severity labels use bold entities,
with each problem label on one line. Code uses separate code/pre entities; fence language labels become
the pre entity's language instead of visible content. Bold labels containing inline code are split to avoid
overlapping style and code entities. CRLF and excess prose spacing are normalized; internal review markers
are hidden outside code examples, whose content is preserved.
See [Telegram's formatting and entity rules](https://core.telegram.org/bots/api#formatting-options).

## Enable commands

To select reports for specific repositories with legacy routes, use `outputs.routes.rules[].match.repo_ref` together with `trigger` and `target_kind`. It matches the exact, case-sensitive repository reference. Put these rules before broader rules and keep the existing channel lists when appending the Bot output. A matching legacy route takes precedence over workspace output lists. See [configuration fields](/en/reference/config-fields/).

Merge the fragment below into the output configuration, preserving the connection identity/token.
Replace the actor, conversation, repository and secret reference.
Review commands require a durable SQLite/PostgreSQL store, database config source, snapshot and running worker.
File-only mode rejects review before creating a request. Platform callback authentication works without an admin session;
admin APIs keep their own authentication.

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

The connection, actor policy, conversation and repository mapping must all authorize the request.
To allow users in the listed groups without maintaining user IDs, set `actors: [{kind: conversation_users}]`.
This uses the authenticated message sender and group context. Added users can submit commands without a config change;
leaving a group does not cancel previously accepted requests. It does not query a member directory.
Private chats and broadcast channels cannot use this policy. `any`, directory scopes, wildcard repositories and extra commands are rejected.
The `expires_at` field still applies. Merge overlapping bindings; status stays limited to the original request owner.
Private Telegram bindings use `{kind: bot_direct}` plus explicit numeric actors.

Register the HTTPS webhook explicitly, including any `server.path_prefix`:

```bash
node scripts/register-social-im.mjs --platform telegram --bot-id 123456789 --token-env AICR_TELEGRAM_TOKEN --secret-env AICR_TELEGRAM_WEBHOOK_SECRET --callback-url https://aicr.example.org/callbacks/im/bot
# After reviewing the dry-run output, repeat with --apply.
```

Apply verifies `getMe`, then `getWebhookInfo`; it refuses to replace another webhook URL. `allowed_updates` is `["message"]` and `drop_pending_updates` stays false. Startup does not call `setWebhook`, `getUpdates` or delete a webhook. Callback ACK is an empty JSON object; authorized short replies are queued durably in the same transaction as command admission. [Webhook methods](https://core.telegram.org/bots/api#setwebhook).

## Verify the flow

1. In the configured conversation, run `/aicr@TestBot help`, then `/aicr@TestBot chat-id`.
2. Run `/aicr@TestBot review demo 0123456789abcdef0123456789abcdef01234567` using a real fixed synthetic commit.
   Git accepts 7–64 hex characters; configured P4/SVN use fixed positive numeric revisions.
3. Save the request ID and run `/aicr@TestBot status <request-id>`.
4. Check that the full report reaches only the configured output destination.
   Source replies contain only request ID/state/query instructions.
   Status requires the same actor, connection, conversation and currently authorized repository.

ACK confirms admission, not completed analysis. Background readiness verifies platform identity and configured destination metadata,
cached for 300 seconds; callbacks fail closed when unavailable. Admission has a one-second local budget and does not wait for
VCS, models, readiness network calls or message sends.
Background checks refresh before expiry. Pending reads retain the existing cache deadline; success renews it and failure immediately invalidates the destination. Verify command replies across a refresh cycle.

## Operations and troubleshooting

For 401, compare `X-Telegram-Bot-Api-Secret-Token` with the configured webhook secret. Group commands must address the username returned by `getMe`, not a display name. `blocked`/403 requires user or group action; group migration is rejected without changing the configured chat ID. A 429 uses `parameters.retry_after` in seconds. Inspect `getWebhookInfo` after a registration timeout before applying again.

For outbound timeouts, check API access from the running Node container. If the deployment uses a proxy,
follow [runtime HTTP proxy configuration](/en/deployment/docker/#runtime-http-proxy); successful host requests alone do not prove readiness.

Current authorization is rechecked before new VCS, analysis and publication operations; execution content retains the admitted snapshot.
Disable the binding/connection/callback to stop new work. Rotate secrets through normal config publication while keeping identities stable.
A changed app/guild/Bot identity prevents delivery of old notifications through the replacement connection.

Complete matching receipts become `delivered`; explicit failures become `rejected`.
After POST starts, only an explicit 429 authorizes a timed reply retry. Lost responses, server failures and expired `sending` leases become `unknown`;
they are never automatically resent. Inspect remote messages and journal/outbox state before arranging a new request.

Local configuration, credential or storage errors before POST back off with a persisted due time. These safe retries and explicit rate-limit retries share a five-attempt budget; exhaustion becomes `failed`. A possible POST or missing receipt persistence stays fenced as `sending`, then becomes `unknown` when its lease expires. Logs contain fixed error codes, never raw upstream errors.

Before rollback, stop ingress and drain workers, then change binaries or restore a compatible backup.
Migration 013 adds the versioned reply payload column. Do not delete request/journal/outbox data to clear unknown results.
Deregister only resources owned by this deployment after checking current remote ownership.

Local tests use HTTP fixtures and real local stores. Live guild/Bot acceptance requires separate credentials and is tracked independently.
Local passing tests do not establish public callback delivery or client rendering.

## Mention the review author

Map a review identity to the person's numeric Telegram user ID in the output channel. A username, Bot ID or chat ID cannot replace it:

```yaml
mention_author: true
author_mappings: { "alice@example.org": "234567891" }
```

Telegram Bot API has no complete member-directory endpoint. Use explicit mappings or the file directory below; administrator permissions do not create an API for listing all members. AICR appends a `text_link` entity with `tg://user?id=…` and UTF-16 offsets. Telegram's membership, prior-contact and privacy conditions still apply. See [formatting options and ID mentions](https://core.telegram.org/bots/api#formatting-options).

A configured directory or mapping enables author reminders by default; `mention_author: false` disables all resolution. Mapping keys match the review author's email, username, display name or P4 submitter workspace, with the global email blacklist applied first. With an API directory, mapping values must be candidate user IDs; without a directory, they are explicit platform IDs. With a file, values are local member keys. Exact matches work with `guess_author: false` (the default); true additionally enables workspace matching and the dedicated identity model. Ambiguous, unavailable or unmatched identities send the report without a mention. `mention_fallback: all` is rejected. Main review prompts receive no directory.

File directories support aliases, emails and scoped VCS accounts. Merge this fragment into the output channel; the scope ID must match its connection:

```yaml
member_directory:
  source: file
  path: ./members.yaml
  directory_id: team
  identity_scope: { kind: telegram_bot, id: "123456789" }
author_mappings: { "alice@example.org": alice }
```

```yaml
# members.yaml
version: 1
directories:
  team:
    platform: telegram
    identity_scope: { kind: telegram_bot, id: "123456789" }
    members:
      - key: alice
        emails: [alice@example.org]
        mention: { type: telegram_user_id, id: "234567891" }
```

Mentions are inserted after untrusted report text is escaped and retain reserved space when a report is truncated. File paths resolve against the configuration directory; hot reload uses the shared file-directory service. API snapshots use the channel TTL, then `outputs.author_resolution.directory_cache_ttl_seconds`, then 43200 seconds; zero disables reuse. A snapshot is limited to 10000 members, 100 pages and a 15-second read deadline. Failed or incomplete refreshes do not reuse expired members. Validate notification delivery with the actual client and destination.
