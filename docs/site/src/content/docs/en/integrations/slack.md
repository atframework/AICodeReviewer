---
title: Slack
description: Send review reports and run authorized review commands through Slack.
---

AICR supports `slack_app` for one aggregated report per publication and four HTTP commands: `help`, `chat-id`, `review` and `status`. Report destinations and command conversations can be different. Native author mentions, member directories, buttons and natural-language review requests are outside this implementation.

## Create and install

Create a Slack app from a manifest. From the repository root, generate the manifest with:

```bash
node scripts/register-social-im.mjs --platform slack --callback-url https://aicr.example.org/callbacks/im/bot
```

Import the generated `manifest` object in Slack's app console. Install the app in the intended workspace and invite its Bot to every command/report channel. Record the app ID, team ID, Bot user ID, Bot OAuth token and signing secret. Set `AICR_SLACK_TOKEN` and `AICR_SLACK_SIGNING_SECRET` in the server environment. The callback uses the signing secret; the Bot token is used for outbound API calls.

| Bot scope | Purpose |
| --- | --- |
| `chat:write` | Send the review report and terminal reply |
| `channels:read` | Verify public channel identity, type and membership |
| `groups:read` | Verify private channels when configured |
| `commands` | Register and use `/aicr` |

Only joined public/private channels are supported. DMs, group DMs, threads and Slack Connect tenant expansion are outside this integration. A channel ID prefix is not proof of its type. [Slack manifest reference](https://docs.slack.dev/reference/app-manifest/), [channel metadata](https://docs.slack.dev/reference/methods/conversations.info/).

## Send reports

Start from [example/slack-app.yaml](https://github.com/atframework/AICodeReviewer/blob/main/example/slack-app.yaml). Replace every synthetic ID and set its token variable. Keep credentials in `im.connections.bot`; the output channel references that connection and its exact destination. The example's `ws.outputs.summary: [report]` selects the report channel.

File configuration alone can send reports. Merge your existing VCS/LLM configuration before running an actual review. A clean review sends only when the summary has content by default (`publish_if_summary`). Override `no_problems` per [output policy](/en/configuration/outputs/).

Reports use named, workspace or built-in templates in the normal priority order. Slack/Telegram are bounded to 3900 UTF-16 units including the truncation notice and optional safe report link. Telegram sends text plus explicit entities; Discord disables allowed mentions; Slack escapes native controls.

## Enable commands

Merge this fragment into the output configuration, preserving the Bot identity/token. Replace its actor, conversation, repository and secret reference with your values. A `review` requires a persistent SQLite/PostgreSQL store, database configuration source, durable snapshot and running worker. File-only mode rejects it before creating a request. The callback route must be reachable without an admin session; admin APIs still require their normal authentication.

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
      kind: slack_app
      app_id: A123
      team_id: T123
      bot_user_id: U123
      token_env: AICR_SLACK_TOKEN
      callback:
        enabled: true
        signing_secret_env: AICR_SLACK_SIGNING_SECRET
  command_bindings:
    reviewers:
      enabled: true
      connection: bot
      actors: [{ type: slack_user_id, id: U234 }]
      conversations: [{ kind: channel, id: C123 }]
      commands: [help, chat-id, review, status]
      repositories:
        demo: { workspace: ws, source_trigger: git, repo_ref: org/demo }
      report_policy: workspace_routes
```

The manifest sets the slash command URL. No command or event subscription is created by server startup. Set this URL to the public HTTPS origin plus any `server.path_prefix` and `/callbacks/im/bot`. Slack needs the initial command ACK within three seconds; AICR bounds local admission to one second and returns an ephemeral response.

## Verify the flow

1. From the configured actor and conversation, run `/aicr help`, then `/aicr chat-id`.
2. Run `/aicr review demo 0123456789abcdef0123456789abcdef01234567` using a real fixed commit in your synthetic repository. Git revisions require 7–64 hex characters; configured P4/SVN use fixed positive numeric revisions.
3. Save the returned request ID and run `/aicr status <request-id>`.
4. Confirm the full report appears only in the configured output destination. The source conversation receives only request ID/state/query instructions. Status is limited to the same actor, connection, conversation and authorized repository.

An ACK means admission, not completed analysis. Readiness is checked from platform identity and configured destination metadata, cached for 300 seconds; an unavailable destination rejects admission. The callback does not wait for VCS, models, readiness network calls or message sends.

## Operations and troubleshooting

A 401 callback response usually means the signing secret, raw body or timestamp is wrong; allow a maximum five-minute clock skew. A 503 means readiness or durable review execution is unavailable. For `not_in_channel` or private-channel failures, check Bot membership and `groups:read`. Slack `internal_error`/`fatal_error` can represent an ambiguous write and remain `unknown`. [Signature contract](https://docs.slack.dev/authentication/verifying-requests-from-slack/), [message errors](https://docs.slack.dev/reference/methods/chat.postMessage/).

Before each new VCS/analysis/publication operation, current authorization is rechecked while execution content retains the admitted configuration snapshot. Disable a binding/connection/callback to stop new authorized work. Rotate the Bot token or callback secret through the normal configuration publish process; keep app/team/guild/Bot identities stable. Changing an identity prevents old notifications from being sent through the replacement connection.

`delivered` requires a complete matching platform receipt. An explicit rejection is recorded as `rejected`; only a documented 429 authorizes a timed reply retry. Lost responses, server errors and expired `sending` leases become `unknown` and are never automatically resent. Inspect remote messages and the journal/outbox before arranging a new request.

For rollback, disable ingress and drain workers before changing binaries or restoring a compatible backup. Migration 013 adds a versioned reply payload column; do not delete request/journal/outbox data to clear an unknown result. Deregister only resources owned by this deployment after checking current remote ownership.

The repository tests use HTTP fixtures and real local stores. Live workspace/guild/Bot acceptance requires separate credentials and remains tracked independently; passing local tests does not establish client rendering or public callback delivery.
