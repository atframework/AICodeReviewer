---
title: Discord
description: Send review reports and run authorized review commands through Discord.
---

AICR supports `discord_bot` for an aggregated report and four HTTP commands: `help`, `chat-id`, `review`, `status`.
Native author mentions, directories, buttons and natural-language requests are outside this implementation.

## Create and install

Create an application and Bot in the Discord Developer Portal. Copy the application ID, public key and Bot token; store the token in `AICR_DISCORD_TOKEN`. Enable Developer Mode to copy guild, channel and user IDs; keep all snowflakes as quoted strings. Replace the synthetic public key below with the Portal's actual public key.

Install into the selected guild with `bot` and `applications.commands` scopes. Grant **View Channel** and **Send Messages** in the command/report channels. This implementation does not request Administrator, Message Content or other privileged Gateway intents; it uses HTTP interactions and the Bot message API. Only ordinary guild text channels (type 0) in the configured guild are supported. DMs, forum posts, threads, announcements and Gateway receive are not implemented. [Application commands](https://docs.discord.com/developers/interactions/application-commands), [channel types](https://docs.discord.com/developers/resources/channel).

## Send reports

Start from [example/discord-bot.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/discord-bot.yaml).
Replace synthetic IDs and set the token environment variable. The channel references `im.connections.bot` and an exact destination;
`ws.outputs.summary: [report]` selects it. Merge your existing VCS/LLM settings before a real review.
File-only configuration can send reports; a clean review defaults to `publish_if_summary`.
See [output policy](/en/configuration/outputs/) for overrides.

Named, workspace and built-in templates retain the normal priority. The final message budget is 1900 UTF-16 units including
the truncation notice and optional safe report link. Discord disables allowed mentions and URL previews are controlled by the platform.

## Enable commands

To select reports for specific repositories with legacy routes, use `outputs.routes.rules[].match.repo_ref` together with `trigger` and `target_kind`. It matches the exact, case-sensitive repository reference. Put these rules before broader rules and keep the existing channel lists when appending the Bot output. A matching legacy route takes precedence over workspace output lists. See [configuration fields](/en/reference/config-fields/).

Merge the fragment below into the output configuration, preserving the connection identity/token.
Replace the actor, conversation, repository and public key.
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
      kind: discord_bot
      application_id: "123456789012345678"
      guild_id: "123456789012345679"
      token_env: AICR_DISCORD_TOKEN
      callback:
        enabled: true
        public_key: "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737"
  command_bindings:
    reviewers:
      enabled: true
      connection: bot
      actors: [{ type: discord_user_id, id: "123456789012345681" }]
      conversations: [{ kind: channel, id: "123456789012345680" }]
      commands: [help, chat-id, review, status]
      repositories:
        demo: { workspace: ws, source_trigger: git, repo_ref: org/demo }
      report_policy: workspace_routes
```

The connection, actor policy, conversation and repository mapping must all authorize the request.
To allow users in the listed guild text channels without maintaining user IDs, set `actors: [{kind: conversation_users}]`.
This uses the authenticated interaction sender and channel context. Added users can submit commands without a config change;
leaving a guild does not cancel previously accepted requests. It does not query a member directory.
Private chats cannot use this policy. `any`, directory scopes, wildcard repositories and extra commands are rejected.
The `expires_at` field still applies. Merge overlapping bindings; status stays limited to the original request owner.

Set the application's **Interactions Endpoint URL** to your public HTTPS origin plus any `server.path_prefix` and `/callbacks/im/bot`. The server validates Ed25519 signatures before replying to PING. Register exactly one guild command with one required STRING option named `command`:

```bash
node scripts/register-social-im.mjs --platform discord --application-id 123456789012345678 --guild-id 123456789012345679 --token-env AICR_DISCORD_TOKEN
# After reviewing the dry-run output, repeat with --apply.
```

The tool reads the command inventory and creates or patches only the guild `aicr` CHAT_INPUT command. It never bulk overwrites other commands. Initial responses are ephemeral (flags 64), within the platform's three-second deadline. Terminal replies use the Bot API and do not depend on a 15-minute interaction token. [Interaction lifecycle](https://docs.discord.com/developers/interactions/receiving-and-responding).

## Verify the flow

1. In the configured conversation, run `/aicr command: help`, then `/aicr command: chat-id`.
2. Run `/aicr command: review demo 0123456789abcdef0123456789abcdef01234567` using a real fixed synthetic commit.
   Git accepts 7–64 hex characters; configured P4/SVN use fixed positive numeric revisions.
3. Save the request ID and run `/aicr command: status <request-id>`.
4. Check that the full report reaches only the configured output destination.
   Source replies contain only request ID/state/query instructions.
   Status requires the same actor, connection, conversation and currently authorized repository.

ACK confirms admission, not completed analysis. Background readiness verifies platform identity and configured destination metadata,
cached for 300 seconds; callbacks fail closed when unavailable. Admission has a one-second local budget and does not wait for
VCS, models, readiness network calls or message sends.
Background checks refresh before expiry. Pending reads retain the existing cache deadline; success renews it and failure immediately invalidates the destination. Verify command replies across a refresh cycle.

## Operations and troubleshooting

If a command has no reply, type `/aicr` in the configured text channel, select the
correct app from the slash menu, and enter `help` in the `command` field before
submitting. The guide's `command:` notation denotes the argument field; sending
it as ordinary chat text does not invoke the command. The initial reply is
visible only to the caller. If the menu is missing, check guild command
registration, app installation and the caller's application command permissions.
If the client says the application did not respond, keep its original error and
the command time, then check the Interactions Endpoint URL, callback HTTP status,
signature verification and readiness.

A successfully admitted valid command leaves an `im_inbox` row. A missing row can
also mean rejection before admission; it does not prove that no request arrived.
`help` and `chat-id` use the HTTP interaction response directly, bypassing the Bot
message outbox. The Bot's **Send Messages** permission is used for reports and
terminal notifications; check it against outbound failure evidence. Log only
required metadata; exclude interaction tokens, signatures and complete request
bodies. See [application commands](https://docs.discord.com/developers/interactions/application-commands)
and [initial responses](https://docs.discord.com/developers/interactions/receiving-and-responding).

For PING/command 401, verify the public key and timestamp headers; AICR enforces a five-minute local freshness window. For outbound 403, inspect the Bot's channel permissions. A 429 uses `retry_after` in seconds; the reply outbox persists the due time. Do not use interaction tokens as Bot tokens. A channel from another guild or of another type fails readiness before sending.

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
