---
title: Quick start
description: Get AICodeReviewer running locally or with Docker Compose and trigger your first review.
---

This guide walks through the two fastest ways to run AICodeReviewer (AICR):
[Docker Compose](#docker-compose) for a deployment-like setup, and
[local Node.js](#local-nodejs) for development. Pick one, then verify with a
[health check](#verify-the-server-is-running) and a
[dry-run review](#dry-run-a-review).

## Docker Compose

The `example/` directory ships a ready-to-edit Compose stack.

```bash
cd example/

# 1. Create .env from the sample and fill in secrets
cp .env.sample .env
# Edit .env: set AICR_LLM_API_KEY, AICR_GITEA_TOKEN, AICR_WEBHOOK_SECRET

# 2. Edit config.yaml: set your Gitea URL, repo, and model

# 3. Build and start
docker compose up -d
```

The Compose file mounts `config.yaml` read-only and persists three named
volumes: `aicr-data` (queue DB, run history), `aicr-workspaces` (cloned repo
caches), and `aicr-logs`. It exposes the service on port `8080` and ships a
health check against `/healthz`.

What goes where:

- `example/.env` — every secret as an environment variable. Never commit this
  file. See [Authentication & secrets](/en/configuration/authentication/).
- `example/config.yaml` — non-secret configuration. References env var *names*
  (e.g. `api_key_env: AICR_LLM_API_KEY`), never values.
- `example/docker-compose.yaml` — the stack definition.

## Local Node.js

For development or evaluation without Docker:

```bash
# From the repository root:

# 1. Install dependencies and build runtime packages
pnpm install
pnpm build

# 2. Set environment variables (one-time source, or export manually)
source example/.env

# 3. Start the server
node packages/cli/dist/index.js serve \
  --config example/config.yaml \
  --port 8080
```

:::note[Windows PowerShell]
`pnpm`, `npx`, and `.ps1` scripts may be blocked by default execution policy.
Invoke Node-based tools directly instead:

```powershell
node node_modules/vitest/vitest.mjs run
node packages/cli/dist/index.js serve --config example/config.yaml --port 8080
```

:::

## Verify the server is running

Once the server is up, confirm it answers the health endpoint:

```bash
curl http://localhost:8080/healthz
# ok
```

The `/healthz` endpoint returns a plain-text `ok` and is the canonical liveness
probe (also used by the Compose health check). If you enabled the observability
dashboard (`admin.*` in config), visit `http://localhost:8080/dashboard`.

## Dry-run a review

Before wiring up a webhook, run a one-shot review against a local checkout to
confirm the LLM and pipeline are healthy. Dry-run does not publish any output.

```bash
export AICR_LLM_API_KEY=sk-xxx

node packages/cli/dist/index.js review \
  --config example/config.yaml \
  --repo "my-org/my-repo" \
  --provider gitea \
  --source-root . \
  --dry-run
```

Flags of note:

- `--provider` — the trigger provider kind from your config (`gitea`, `github`,
  `gitlab`, `p4`, `svn`).
- `--source-root` — the checkout to review.
- `--dry-run` — prepare and run the review but skip all output channels.

If the dry-run succeeds, the LLM credentials, agent, and sandbox are wired up
correctly. Next, point a VCS webhook at the server — see
[Your first webhook review](/en/start/first-webhook/).

## Next steps

- [Authentication & secrets](/en/configuration/authentication/) — understand the
  three-layer model before opening the server to webhooks.
- [Output channels](/en/integrations/output-channels/) — where findings get
  published.
- [VCS providers](/en/integrations/vcs-providers/) — webhook and trigger setup
  per provider.
