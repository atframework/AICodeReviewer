---
title: Discord
description: Send review reports and run authorized review commands through Discord.
---

AICR supports `discord_bot` for an aggregated report and four HTTP commands: `help`, `chat-id`, `review`, `status`.
Buttons and natural-language requests are outside this implementation.

## Create and install

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and select **New Application**.
2. Copy **Application ID** and **Public Key** from **General Information**. Obtain the Bot token on the **Bot** page
   and inject it into `AICR_DISCORD_TOKEN` through your deployment environment. The public key verifies signatures; the token cannot replace it.
3. Under **Installation**, enable **Guild Install**, set the scopes and permissions below and use the installation link for your server.
4. In the Discord client, enable **User Settings → Advanced → Developer Mode**.
   Right-click the server, channel and person to copy their Server ID, Channel ID and User ID.

See [Discord's application setup guide](https://docs.discord.com/developers/quick-start/getting-started).

| AICR field | Platform value |
| --- | --- |
| `application_id` | Application ID |
| `guild_id` | Server ID |
| `callback.public_key` | Public Key: 64 hexadecimal characters |
| Conversation/report `channel_id` | Channel ID |
| Actor ID for an explicit allowlist | The person's User ID |

Keep all IDs as quoted strings. Replace the synthetic public key below with the Portal's actual public key.

Install into the selected guild with `bot` and `applications.commands` scopes. Grant **View Channel** and **Send Messages** in the command/report channels. Sending reports and receiving commands require neither Administrator nor Message Content; an optional API member directory requires Server Members Intent; it uses HTTP interactions and the Bot message API. Only ordinary guild text channels (type 0) in the configured guild are supported. DMs, forum posts, threads, announcements and Gateway receive are not implemented. [Application commands](https://docs.discord.com/developers/interactions/application-commands), [channel types](https://docs.discord.com/developers/resources/channel).

## Configure AICR

Merge the YAML below, or sign in to the Dashboard and open **Config → IM connections → New im connection**.
Choose `discord_bot` and enter its identity and credential. Expand **Callback credentials**, enable the callback and enter the public key.
The screenshot shows the real local form with synthetic IDs; callback fields are outside the pictured section.

[![AICR Discord connection form with Application ID, Guild ID and Token env](/images/integrations/discord-connection.png)](/images/integrations/discord-connection.png)

Open the image for full resolution.

The connection name must match the output/binding's `connection` and the last callback URL segment;
the screenshot uses `discord-demo`, while the YAML below uses `bot`.
For database configuration, allow environment references by purpose and destination in the file's
`config_sources.secret_refs`, then save, publish and verify the active revision and snapshot.
See [dynamic configuration](/en/configuration/overview/#dynamic-configuration-api).
Continue with report channels and command bindings; creating a connection does not authorize reviews.

## Send reports

Start from [example/discord-bot.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/discord-bot.yaml).
Replace synthetic IDs and set the token environment variable. The channel references `im.connections.bot` and an exact destination;
`ws.outputs.summary: [report]` selects it. Merge your existing VCS/LLM settings before a real review.
File-only configuration can send reports; a clean review defaults to `publish_if_summary`.
See [output policy](/en/configuration/outputs/) for overrides.

Named, workspace and built-in templates retain the normal priority. The final message budget is 1900 UTF-16 units including
the truncation notice and optional safe report link. Discord permits only host-resolved author mentions and URL previews are controlled by the platform.

When the same review also publishes its full report through an issue channel, AICR sends the issue first and uses its confirmed URL for a brief notification: a headline, problem count, severity/category/location titles and a full-report link. Native author reminders are preserved. Analysis, suggestions and code remain in the issue. Without a usable confirmed URL, including an issue write failure, the channel keeps the full report. Route order does not change this behavior; no new channel option is required.

Reports have Review target, Summary and Problems sections, with each problem label on one line.
CRLF and excess prose spacing are normalized. Internal review markers are hidden outside code,
while code fences, language labels and content are preserved. Custom templates retain the priority above;
messages that exceed the total budget include a truncation notice.
See [Discord's message formatting reference](https://docs.discord.com/developers/reference#message-formatting).

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

Deploy and activate the AICR configuration with the public key first. Then set the application's
**General Information → Interactions Endpoint URL** to your public HTTPS origin plus any `server.path_prefix` and `/callbacks/im/bot`.
Discord sends a PING when you save the URL; the server validates its Ed25519 signature before replying.
Next, register exactly one guild command with one required STRING option named `command`:

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
After POST starts, only an explicit 429 authorizes a timed reply retry. Lost responses, server failures and expired `sending` leases become `unknown`;
they are never automatically resent. Inspect remote messages and journal/outbox state before arranging a new request.

Local configuration, credential or storage errors before POST back off with a persisted due time. These safe retries and explicit rate-limit retries share a five-attempt budget; exhaustion becomes `failed`. A possible POST or missing receipt persistence stays fenced as `sending`, then becomes `unknown` when its lease expires. Logs contain fixed error codes, never raw upstream errors.

Before rollback, stop ingress and drain workers, then change binaries or restore a compatible backup.
Migration 013 adds the versioned reply payload column. Do not delete request/journal/outbox data to clear unknown results.
Deregister only resources owned by this deployment after checking current remote ownership.

Local tests use HTTP fixtures and real local stores. Live guild/Bot acceptance requires separate credentials and is tracked independently.
Local passing tests do not establish public callback delivery or client rendering.

## Mention the review author

Configure the output channel with either an explicit mapping or an API directory:

```yaml
mention_author: true
author_mappings: { "alice@example.org": "234567891" }
# Optional automatic matching among guild members:
# member_directory: { source: discord_api, cache_ttl_seconds: 43200 }
# guess_author: true
```

The API directory paginates guild members and matches usernames, global names and guild nicknames. It cannot read users' email addresses. Enable **Bot → Privileged Gateway Intents → Server Members Intent** in the Developer Portal, with approval where Discord requires it. This REST endpoint requires `GUILD_MEMBERS` even when commands use HTTP. Explicit mappings alone need no member-list intent. The outgoing `allowed_mentions.users` contains only the resolved author; roles, everyone and reply pings remain disabled. A guild match does not prove the person can view a private destination channel. See [List Guild Members](https://docs.discord.com/developers/resources/guild#list-guild-members) and [allowed mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object).

A configured directory or mapping enables author reminders by default; `mention_author: false` disables all resolution. Mapping keys match the review author's email, username, display name or P4 submitter workspace, with the global email blacklist applied first. With an API directory, mapping values must be candidate user IDs; without a directory, they are explicit platform IDs. With a file, values are local member keys. Exact matches work with `guess_author: false` (the default); true additionally enables workspace matching and the dedicated identity model. Ambiguous, unavailable or unmatched identities send the report without a mention. `mention_fallback: all` is rejected. Main review prompts receive no directory.

File directories support aliases, emails and scoped VCS accounts. Merge this fragment into the output channel; the scope ID must match its connection:

```yaml
member_directory:
  source: file
  path: ./members.yaml
  directory_id: team
  identity_scope: { kind: discord_guild, id: "123456789012345679" }
author_mappings: { "alice@example.org": alice }
```

```yaml
# members.yaml
version: 1
directories:
  team:
    platform: discord
    identity_scope: { kind: discord_guild, id: "123456789012345679" }
    members:
      - key: alice
        emails: [alice@example.org]
        mention: { type: discord_user_id, id: "234567891" }
```

Mentions are inserted after untrusted report text is escaped and retain reserved space when a report is truncated. File paths resolve against the configuration directory; hot reload uses the shared file-directory service. API snapshots use the channel TTL, then `outputs.author_resolution.directory_cache_ttl_seconds`, then 43200 seconds; zero disables reuse. A snapshot is limited to 10000 members, 100 pages and a 15-second read deadline. Failed or incomplete refreshes do not reuse expired members. Validate notification delivery with the actual client and destination.
