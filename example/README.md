# AICodeReviewer Deployment Example

This directory contains a ready-to-edit deployment configuration.

## Quick Start (Docker Compose)

```bash
cd example/

# 1. Create .env from sample and fill in secrets
cp .env.sample .env
# Edit .env: set AICR_LLM_API_KEY, AICR_GITEA_TOKEN, AICR_WEBHOOK_SECRET

# 2. Edit config.yaml: set your Gitea URL, repo, and model

# 3. Build and start
docker compose up -d

# 4. Verify
curl http://localhost:8080/healthz
```

## Quick Start (Local Node.js)

```bash
# From the repository root:

# 1. Install and build
pnpm install
pnpm build

# 2. Set environment variables
source example/.env   # or export them manually

# 3. Start the server
node packages/cli/dist/index.js serve \
  --config example/config.yaml \
  --port 8080
```

## Docker (without Compose)

```bash
# Build
docker build -t aicodereviewer -f deploy/Dockerfile .

# Run
docker run -d \
  --name aicr \
  --env-file example/.env \
  -p 8080:8080 \
  -v $(pwd)/example/config.yaml:/app/config.yaml:ro \
  -v aicr-workspaces:/app/workspaces \
  aicodereviewer
```

## Configuring Gitea Webhook

After the server is running, add a webhook to your Gitea repository:

1. Go to **Repository → Settings → Webhooks → Add Webhook → Gitea**
2. **Target URL**: `http://<aicr-host>:8080/webhooks/gitea`
3. **Content type**: `application/json`
4. **Secret**: the same value as `AICR_WEBHOOK_SECRET` in your `.env`
5. **Events**: check `Pull Request`
6. Save

## File Reference

| File                   | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `config.yaml`          | Main configuration — LLM, triggers, outputs, workspaces |
| `.env.sample`          | All environment variables with descriptions             |
| `docker-compose.yaml`  | Docker Compose stack definition                         |
| `../deploy/Dockerfile` | Multi-stage Docker build                                |

## Adding More Repositories

Add additional entries under `workspaces.instances` in `config.yaml`:

```yaml
workspaces:
  instances:
    my-first-repo:
      source_repo:
        trigger: gitea
        repo: "my-org/first-repo"
      outputs:
        line_comments: [gitea-pr-review]
        summary: [gitea-pr-review]

    my-second-repo:
      source_repo:
        trigger: gitea
        repo: "my-org/second-repo"
      outputs:
        line_comments: [gitea-pr-review]
        summary: [gitea-pr-review]
```

## CLI One-shot Review (dry-run)

Run a single review without starting the server:

```bash
export AICR_LLM_API_KEY=sk-xxx

node packages/cli/dist/index.js review \
  --config example/config.yaml \
  --repo "my-org/my-repo" \
  --provider gitea \
  --source-root . \
  --dry-run
```
