---
title: Docker Compose deployment
description: Volume layout, health check, restart policy, and what goes in .env vs config.yaml for the Compose stack.
---

The fastest deployment-like setup is the Compose stack in `example/`. This
page expands on [Quick start](/en/start/quick-start/) with the details you
need once you are ready to run AICR long-term. For non-Compose Docker runs,
see [Docker deployment](/en/deployment/docker/).

## What the stack persists

The Compose file mounts `config.yaml` read-only and persists three named
volumes:

| Volume | Mount | Purpose |
| --- | --- | --- |
| `aicr-data` | `/app/data` | SQLite queue DB, run history, dashboard stats, model-catalog cache |
| `aicr-workspaces` | `/app/workspaces` | Per-workspace `source/`, `agent/`, `tmp/` directories and cloned repo caches |
| `aicr-logs` | `/app/logs` | Review run logs |

The service listens on port `8080` and is brought up with `docker compose up
-d` from the `example/` directory.

## Health check and restart policy

The stack ships a Compose health check against `/healthz`, the canonical
liveness probe (it returns a plain-text `ok`):

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/healthz"]
  interval: 30s
  timeout: 5s
  retries: 3
```

Pair the health check with a restart policy so the container recovers from
transient failures:

```yaml
restart: unless-stopped
```

:::note[Run with `--init`]
If you build a custom run command or image, keep `--init` (Podman and Docker
both support it). It runs an init process as PID 1 that reaps zombies left
behind by agent subprocesses that escape the sandbox kill. Removing `--init`
will eventually degrade reviews into timeout failures. The Compose file and
`deploy/deploy.sh` already include it.
:::

## `.env` vs `config.yaml`

The split is simple: **secrets live in `.env`, everything else lives in
`config.yaml`**.

`.env` holds raw secret values and is never committed:

```bash
# Inbound: webhook HMAC secrets (protect /webhooks/*)
AICR_WEBHOOK_SECRET=7f3a...
AICR_GITHUB_APP_WEBHOOK_SECRET=b2c1...

# Inbound: API key (protects /triggers/* like P4/SVN)
AICR_API_KEY=c6d7e8f9...

# Outbound: AICR calls external services
AICR_LLM_API_KEY=sk-...
AICR_GITEA_TOKEN=4b5d...
AICR_FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/...
AICR_FEISHU_SECRET=3Ob2...

# Outbound: GitHub App (recommended for GitHub)
AICR_GITHUB_APP_PRIVATE_KEY=LS0t...

# Outbound: legacy GitHub PAT (only if the trigger still uses token_env)
# AICR_GITHUB_TOKEN=ghp_...
```

`config.yaml` holds non-secret configuration and references env var **names**
(never values):

```yaml
triggers:
  - name: gitea
    kind: gitea
    webhook_secret_env: AICR_WEBHOOK_SECRET

llm:
  providers:
    - id: primary
      kind: openai_compatible
      api_key_env: AICR_LLM_API_KEY
```

See [Authentication & secrets](/en/configuration/authentication/) for the
full three-layer model (webhook HMAC, server API key, per-workspace API key)
and the dashboard's separate admin login.

## Editing configuration after start

`config.yaml` and `.env` are volume-mounted into the container, not baked
into the image. After editing either file, restart the container — a full
image rebuild is only needed for code changes:

```bash
docker compose restart
```

## Verifying the stack

```bash
# Liveness
curl http://localhost:8080/healthz

# Server logs
docker compose logs -f
```

Once the health check passes, run a [dry-run review](/en/start/dry-run/) to
confirm the LLM credentials, agent, and sandbox are wired up, then wire up
your [first webhook](/en/start/first-webhook/).
