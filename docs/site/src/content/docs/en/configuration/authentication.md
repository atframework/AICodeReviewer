---
title: Authentication & secrets
description: The three-layer AICR authentication model and the .env vs config.yaml secret convention.
---

AICodeReviewer uses **three independent layers** of authentication. They protect
different endpoints and must not be confused — in particular, webhook HMAC and
API keys are never combined on the same request.

| Layer | Scope | What it protects | Config |
| --- | --- | --- | --- |
| Webhook HMAC | Per-trigger | Inbound VCS webhooks (`/webhooks/*`) | `triggers[].webhook_secret_env` |
| Server API key | Global | `/triggers/*` routes (P4, SVN, custom scripts) | `server.auth.api_key_env` |
| Workspace API key | Per-workspace | Same as server key, but workspace-scoped | `workspaces.instances.<id>.auth.api_key_env` |

The observability dashboard has a **separate** super-admin login (`admin.*`)
and does not reuse webhook HMAC or trigger API keys.

:::caution[Endpoint mapping]
`/webhooks/*` (Gitea, Forgejo, GitHub, GitLab) are protected **only by HMAC**.
`/triggers/*` (P4, SVN) are protected **only by API key**. The two layers are
independent and never combined.
:::

## Layer 1 — Webhook HMAC (per-trigger)

Each trigger kind uses a specific verification mechanism:

| Trigger kind | Config field | Mechanism | HTTP header | Where to set on VCS |
| --- | --- | --- | --- | --- |
| `gitea` / `forgejo` | `webhook_secret_env` | HMAC-SHA256 | `x-gitea-signature-256` | Gitea webhook → Secret |
| `github` | `webhook_secret_env` | HMAC-SHA256 | `x-hub-signature-256` | GitHub App → Webhook secret (or repo-level webhook → Secret) |
| `gitlab` | `webhook_secret_env` | Token comparison | `x-gitlab-token` | GitLab webhook → Secret token |
| `p4` | `server.auth` | API key | `x-api-key` | `p4-trigger.sh` sends the key |
| `svn` | `server.auth` | API key | `x-api-key` | `svn-trigger.sh` sends the key |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Config example:

```yaml
triggers:
  - name: gitea
    kind: gitea
    webhook_secret_env: AICR_WEBHOOK_SECRET  # env var holding the secret
```

If `webhook_secret_env` is omitted, signature verification is **skipped** — not
recommended for production.

### Multiple profiles on one webhook route

GitHub and GitLab can each define **multiple trigger profiles on the same route**
(`/webhooks/github` or `/webhooks/gitlab`). Use separate trigger names when
repositories need different outbound tokens, webhook secrets, or file filters;
AICR picks the final profile by the verified credential plus the repository
identity from the webhook payload.

## Layer 2 — Server-level API key (triggers only)

Protects `/triggers/*` routes with a shared API key. VCS webhooks (`/webhooks/*`)
are **not** affected — they use HMAC.

Callers of trigger endpoints send `X-API-Key: <key>` or
`Authorization: Bearer <key>`.

```yaml
server:
  auth:
    api_key_env: AICR_API_KEY    # env var holding the global API key
    enabled: true                # set false to temporarily disable
```

## Layer 3 — Per-workspace API key (optional override)

Individual workspaces can carry their own API key:

```yaml
workspaces:
  instances:
    my-repo:
      source_repo: { trigger: gitea, repo: "org/repo" }
      auth:
        api_key_env: AICR_MY_REPO_API_KEY
        enabled: true
```

Both global and workspace keys are accepted — a request is allowed if it matches
**any** configured key.

## Observability dashboard admin

Set `admin.username_env` plus either `admin.password_env` or
`admin.password_hash_env` to enable the built-in dashboard:

- `GET /dashboard` and `GET /` serve the embedded SPA.
- `POST /api/admin/login` returns a Bearer session token.
- `GET /api/admin/stats` returns all-time, today, this-week, and this-month
  statistics, plus project/provider/recent-run data.

Prefer `password_hash_env` (format `sha256:<hex>`) in production; raw password
env is allowed for small internal deployments but is compared with a
constant-time digest check, rate-limited, and never logged.

:::note[Session TTL]
The admin session TTL field is `session_ttl_seconds` (default `86400` = 24 hours).
A field named `session_ttl_minutes` is ignored.
:::

## Secrets: `.env` vs `config.yaml`

Keep every secret in `.env` (or your secret manager). `config.yaml` should
contain **only env var names**, never values. This keeps `config.yaml` safe to
commit and review.

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ .env (environment variables — never committed to git)                      │
│                                                                            │
│ ── Inbound: Webhook HMAC secrets (protect /webhooks/*) ──                  │
│ AICR_WEBHOOK_SECRET=7f3a...              ← shared with Gitea webhook     │
│ AICR_GITHUB_APP_WEBHOOK_SECRET=b2c1...     ← shared with GitHub App        │
│ AICR_GITLAB_WEBHOOK_SECRET=d4e5...         ← shared with GitLab webhook    │
│                                                                            │
│ ── Inbound: API key (protects /triggers/* like P4/SVN) ──                │
│ AICR_API_KEY=c6d7e8f9...                 ← p4-trigger.sh / svn-trigger.sh  │
│                                                                            │
│ ── Outbound: AICR calls external services ──                               │
│ AICR_LLM_API_KEY=sk-...                    ← AICR → LLM API              │
│ AICR_GITEA_TOKEN=4b5d...                   ← AICR → Gitea API              │
│ AICR_P4USER=p4-ci                          ← AICR → P4 server            │
│ AICR_P4PASSWORD=vUF_...                    ← AICR → P4 server            │
│ AICR_FEISHU_SECRET=3Ob2...                 ← AICR → Feishu API           │
│                                                                            │
│ ── Outbound: GitHub App (recommended for GitHub) ──                      │
│ AICR_GITHUB_APP_PRIVATE_KEY=LS0t...          ← base64 PEM, see below       │
│ AICR_GITHUB_TOKEN=ghp_...                  ← (legacy) GitHub PAT         │
└────────────────────────────────────────────────────────────────────────────┘
```

For GitHub, the recommended outbound credential is a GitHub App. Put the
private key (PEM or base64 PEM) in `AICR_GITHUB_APP_PRIVATE_KEY`, reference it
with `triggers[].app.private_key_env`, and make sure every reviewed repository
is selected in the App installation. A personal access token is still supported
via `token_env` (or a channel-level override) for legacy setups, but it must be
an **outbound** API credential, not the webhook secret. `github_problem_issue`
specifically needs repository Issues read/write permission. Selecting **Issues**
or **Issue comments** in the GitHub App/webhook event list only controls which
inbound events are delivered; it does not grant REST API permissions.
