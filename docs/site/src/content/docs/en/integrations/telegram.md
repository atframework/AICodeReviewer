---
title: Telegram
description: Send review reports and run authorized review commands through Telegram.
---

AICR supports `telegram_bot` for an aggregated report and four HTTP commands: `help`, `chat-id`, `review`, `status`.
Native author mentions, directories, buttons and natural-language requests are outside this implementation.

## Create and install

Create a Bot with BotFather. Put its Bot API token in `AICR_TELEGRAM_TOKEN` and use `getMe` to obtain the numeric Bot ID and username. Set a separate `AICR_TELEGRAM_WEBHOOK_SECRET` containing 1–256 letters, digits, underscores or hyphens. The webhook secret is not the Bot token.

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

IDs are quoted decimal strings; group IDs can be negative. Only established private/group/supergroup chats are supported. Forum/topic, channel, business, anonymous `sender_chat`, bot-authored and edited updates do not trigger reviews. [Bot API](https://core.telegram.org/bots/api), [privacy mode](https://core.telegram.org/bots/features#privacy-mode).

## Send reports

Start from [example/telegram-bot.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/telegram-bot.yaml).
Replace synthetic IDs and set the token environment variable. The channel references `im.connections.bot` and an exact destination;
`ws.outputs.summary: [report]` selects it. Merge your existing VCS/LLM settings before a real review.
File-only configuration can send reports; a clean review defaults to `publish_if_summary`.
See [output policy](/en/configuration/outputs/) for overrides.

Named, workspace and built-in templates retain the normal priority. The final message budget is 3900 UTF-16 units including
the truncation notice and optional safe report link. Telegram sends explicit UTF-16 entities without parse_mode.

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
Only an explicit 429 authorizes a timed reply retry. Lost responses, server failures and expired `sending` leases become `unknown`;
they are never automatically resent. Inspect remote messages and journal/outbox state before arranging a new request.

Before rollback, stop ingress and drain workers, then change binaries or restore a compatible backup.
Migration 013 adds the versioned reply payload column. Do not delete request/journal/outbox data to clear unknown results.
Deregister only resources owned by this deployment after checking current remote ownership.

Local tests use HTTP fixtures and real local stores. Live guild/Bot acceptance requires separate credentials and is tracked independently.
Local passing tests do not establish public callback delivery or client rendering.
