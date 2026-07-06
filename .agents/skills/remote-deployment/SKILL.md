---
name: remote-deployment
description: "Use when: deploying AICR to a remote server, updating deployed config.yaml, syncing source files, or troubleshooting podman build/run issues; do not use for local development or CI pipeline changes."
user-invocable: false
---

# Remote Deployment

Deploy AICR to the production server. The actual host, port, user, key path, and deploy directory are documented in `development/README.md` and must never be hardcoded in committed scripts.

## Remote Layout

```text
<deploy-dir>/
  source/              # Build context for Dockerfile (copied from local repo)
  deploy/              # Dockerfile and deploy assets
  deploy.sh            # Build + restart script
  config.yaml          # Runtime config (mounted ro into container)
  .env                 # API keys and tokens
  data/                # Persistent volumes (workspaces, db, logs)
```

## SSH Common Options

All SSH/SCP commands must include these flags:

```bash
ssh -p <ssh-port> -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no \
  -o User=<remote-user> -i <ssh-key> <remote-host>
```

On Windows PowerShell, **do not use `&&` inside a single command string** — it fails with a parser error. Chain with `;` or use separate tool calls.

## File Sync (Windows Host → Remote)

### Problem: rsync is not available on Windows

**Solution:** Use `tar czf` + `scp` + `ssh tar xzf`.
Per `AGENTS.md`, keep the local tarball under `build/`, never in the repository root:

```powershell
# 1. Create tarball locally under build/
tar czf build/aicr-deploy-latest.tar.gz `
  --exclude=.git --exclude=node_modules --exclude=dist --exclude=coverage .

# 2. SCP to remote
scp -P <ssh-port> -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no `
  -i <ssh-key> `
  build/aicr-deploy-latest.tar.gz <remote-user>@<remote-host>:<deploy-dir>/

# 3. Extract on remote and clean up tarball (separate SSH call)
ssh -p <ssh-port> ... <remote-host> `
  "cd <deploy-dir> && rm -rf source/* && mkdir -p source && tar xzf aicr-deploy-latest.tar.gz -C source && rm -f aicr-deploy-latest.tar.gz"
```

If many files changed, sync the entire `packages/` tree or use `git archive` from the local repo.

## Config Updates

### Problem: Python `yaml` module destroys YAML anchors

The remote `config.yaml` uses YAML anchors (`&safe_issue_triage`) and aliases (`*safe_issue_triage`). Loading with `yaml.safe_load` and dumping with `yaml.dump` strips them, corrupting the file.

**Solution:** Use targeted string replacement (Python or sed) instead of round-tripping through a YAML parser.

**Preferred approach — Python script written to temp file:**

```python
import re

with open("<deploy-dir>/config.yaml", "r") as f:
    content = f.read()

old_block = """    - name: gitea-managed-findings
      kind: gitea_problem_issue
      trigger: gitea-internal
      marker_prefix: \"[AICR]\"
      marker_label: \"aicr-managed\"
      resolved_action: delete"""

new_block = old_block + "\n      assign_committer: true"

if old_block in content:
    content = content.replace(old_block, new_block)
    with open("<deploy-dir>/config.yaml", "w") as f:
        f.write(content)
    print("Updated OK")
else:
    print("Block not found — check remote config")
```

**Never do this:**

```python
# WRONG — destroys anchors
import yaml
config = yaml.safe_load(open("config.yaml"))
# ... modify ...
yaml.dump(config, open("config.yaml", "w"))  # anchors gone!
```

### Problem: Inline Python via SSH quoting is fragile on Windows

PowerShell + SSH + Python string quoting creates escaping nightmares.

**Solution:** Write the Python script to a local temp file, `scp` it to remote, execute it, then delete it:

```powershell
# Write script locally
$script = @"
import re
with open('<deploy-dir>/config.yaml', 'r') as f:
    content = f.read()
# ... replacement logic ...
"@
Set-Content -Path C:\temp\update_config.py -Value $script

# SCP and execute
scp -P <ssh-port> ... C:\temp\update_config.py <remote-user>@<remote-host>:<deploy-dir>/
ssh -p <ssh-port> ... <remote-host> "python3 <deploy-dir>/update_config.py; rm -f <deploy-dir>/update_config.py"
```

### Problem: Config kind drift between code and deployed config

The code schema may have renamed a channel `kind` (e.g., `gitea_finding_issue` → `gitea_problem_issue`). The deployed `config.yaml` may still use the old name, causing the server to reject the config on startup.

**Always verify before deploy:**

```bash
ssh ... <remote-host> "grep 'kind: gitea_problem_issue' <deploy-dir>/config.yaml"
```

If the kind name changed, update it in the remote config **before** running `deploy.sh`.

## Build and Deploy

### Standard deploy flow

```bash
# 1. Sync source files to remote source/
# 2. Update config.yaml if needed
# 3. Run deploy script on remote
ssh -p <ssh-port> ... <remote-host> "cd <deploy-dir>; bash deploy.sh"
```

The `deploy.sh` script:

1. Builds podman image `aicr:latest` from `source/` using `deploy/Dockerfile`
2. Stops and removes old `aicr` container
3. Starts new container with volume mounts and env vars
4. Runs health check on `http://127.0.0.1:<host-port>/healthz`

If the deploy host listens on TCP `3128` and no explicit `HTTP_PROXY` /
`HTTPS_PROXY` is exported, `deploy.sh` auto-detects that host-side HTTP proxy
and uses it for host downloads plus image-build fetches. If the proxy only
binds to loopback, the script temporarily builds with host networking so
Dockerfile `RUN` steps can still reach `127.0.0.1:3128`.

### Post-deploy verification

```bash
# Health check (remote)
curl -sf http://127.0.0.1:<host-port>/healthz

# Health check (via reverse proxy)
curl -sf <reverse-proxy>/healthz

# Container status
ssh ... <remote-host> "podman ps --filter name=aicr"

# Recent logs
ssh ... <remote-host> "podman logs --tail 50 aicr"
```

### Rollback

`deploy.sh` tags the previous image as `<image>:previous` before building the new one, then stops the old container and starts a new one. If the new container fails the health check, the old container is already gone but the previous image is preserved. To roll back:

1. Verify the `:previous` image exists:

   ```bash
   ssh ... <remote-host> "$ENGINE_CMD images --filter reference='aicr:previous'"
   ```

2. Stop the failed container and start one from the previous image:

   ```bash
   ssh ... <remote-host> "\
     podman --storage-driver=overlay rm -f <container-name> 2>/dev/null; \
     podman --storage-driver=overlay run -d --name <container-name> \
       -p <host-port>:8080 \
       --env-file <deploy-dir>/.env \
       -v <deploy-dir>/config.yaml:/app/config.yaml:ro \
       -v <deploy-dir>/data/workspaces:/app/workspaces \
       -v <deploy-dir>/data/db:/app/data \
       -v <deploy-dir>/data/logs:/app/logs \
       aicr:previous"
   ```

   **Important**: `deploy.sh` uses bind mounts from `<deploy-dir>/data/*`, not named volumes.

3. Verify health:

   ```bash
   curl -sf "http://127.0.0.1:<host-port>/healthz"
   ```

### Container sandbox deployment (optional)

When AICR itself runs inside a container and you want the sandbox to spawn child containers for agent isolation, enable the nested container sandbox:

```bash
# On the host: ensure user-level Podman socket is active
ssh ... <remote-host> "systemctl --user enable --now podman.socket"

# Deploy with container sandbox enabled
ssh -p <ssh-port> ... <remote-host> \
  "cd <deploy-dir>; AICR_ENABLE_CONTAINER_SANDBOX=true bash deploy.sh"
```

Requirements:

- Host must have Podman with user-level socket (`/run/user/$(id -u)/podman/podman.sock`).
- The runtime image ships `podman`, `buildah`, and `skopeo`; no Podman daemon runs inside the AICR container.
- `deploy.sh` sets `CONTAINER_HOST` for the native Podman CLI and `DOCKER_HOST` for Docker-compatible clients.
- `deploy.sh` downloads a Docker static binary (~40MB) on first run when Docker-compatible socket clients are needed.
- Prefer `sandbox.kind: podman` with `sandbox.engine: podman`; use `sandbox.kind: docker` only when the Docker CLI compatibility path is required.
- `deploy.sh` adds `--userns=keep-id --group-add keep-groups` so the container process can access the socket, and disables SELinux labeling for the mounted Podman socket.
- Treat the mounted Podman socket as privileged host-user access; do not expose it to untrusted workloads.

Verify after deploy:

```bash
ssh ... <remote-host> "podman exec aicr sh -c 'podman --version && podman run --rm alpine:latest echo podman-ok'"
ssh ... <remote-host> "podman exec aicr sh -c 'docker --version && docker run --rm alpine:latest echo docker-ok'"
```

### From-scratch deployment verification

To verify the complete zero-to-deployment flow on an empty directory (e.g., AICodeReviewerTest):

1. Stop existing test container and remove directory:

   ```bash
   ssh ... <remote-host> "podman --storage-driver=overlay rm -f aicr-test 2>/dev/null; rm -rf <test-dir>; mkdir -p <test-dir>"
   ```

2. Extract source and set up directory layout:

   ```bash
   ssh ... <remote-host> "cd <test-dir>; mkdir -p source; tar xzf /path/to/aicr-test-deploy.tar.gz -C source; cp -r source/deploy .; cp source/deploy/deploy.sh ."
   ```

3. Write `.env` and `config.yaml` (copy from production or create minimal versions).

4. Ensure Podman user socket is active:

   ```bash
   ssh ... <remote-host> "systemctl --user enable --now podman.socket"
   ```

5. Deploy with container sandbox:

   ```bash
   ssh ... <remote-host> "cd <test-dir>; AICR_DEPLOY_DIR=<test-dir> AICR_IMAGE_NAME=aicr:test AICR_CONTAINER_NAME=aicr-test AICR_HOST_PORT=8091 AICR_ENABLE_CONTAINER_SANDBOX=true bash deploy.sh"
   ```

6. Verify:

   ```bash
   # Health check
   ssh ... <remote-host> "curl -sf http://127.0.0.1:8091/healthz"
   # Nested sandbox
   ssh ... <remote-host> "podman exec aicr-test sh -c 'podman --version && podman run --rm alpine:latest echo podman-ok'"
   ssh ... <remote-host> "podman exec aicr-test sh -c 'docker --version && docker run --rm alpine:latest echo docker-ok'"
   ```

## Environment Variables on Remote

The `.env` file on remote contains secrets. **Never display its full contents in logs.** The known env vars are:

- `AICR_LLM_API_KEY` — LLM provider API key
- `AICR_GITEA_TOKEN`, `AICR_WEBHOOK_SECRET` — Gitea integration
- `AICR_GITHUB_TOKEN`, `AICR_GITHUB_WEBHOOK_SECRET` — GitHub integration
- `AICR_P4USER`, `AICR_P4PASSWORD` — Perforce integration
- `AICR_API_KEY` — Server API key for `/triggers/*`
- `AICR_FEISHU_WEBHOOK`, `AICR_FEISHU_SECRET` — Feishu bot
- `AICR_WECOM_WEBHOOK` — WeCom (企业微信) bot

### Encoding safety

The `.env` file must be ASCII or UTF-8 without BOM. Windows PowerShell 5.1 `>` redirect and `Out-File` default to UTF-16 LE, which the container cannot parse. `deploy.sh` detects UTF-16 encoding and aborts before starting the container. Prefer `scp` or remote `printf` to transfer `.env` files.

### Config-only changes

`config.yaml` and `.env` are volume-mounted into the container. After editing either, restart the container (`podman restart <name>`) — no image rebuild needed.

## Common Failures and Recovery

| Symptom                                                            | Likely Cause                                                                                                     | Fix                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `deploy.sh` fails at build stage                                   | Outdated `source/` or lockfile mismatch                                                                          | Re-sync source, ensure `pnpm-lock.yaml` is up to date                                                                           |
| `healthz` returns non-200                                          | Config validation failed                                                                                         | Check `podman logs aicr` for Zod/config errors                                                                                  |
| Container exits immediately                                        | Port conflict or missing volume                                                                                  | Check `podman ps -a` and logs                                                                                                   |
| Feishu/webhook notifications fail                                  | Missing env var in `.env`                                                                                        | Verify `.env` has required vars, restart container                                                                              |
| WeCom notifications fail                                           | Missing `WECOM_WEBHOOK` in `.env`                                                                                | Add env var, restart container                                                                                                  |
| Gitea issues not created                                           | `kind` mismatch or missing `token_env`                                                                           | Verify config `kind` matches code, check `token_env` resolution                                                                 |
| `podman ps` fails with `invalid internal status`                   | Rootless storage driver init failure (custom `rootless_storage_path` in `/etc/containers/storage.conf`)          | `podman --storage-driver=overlay system migrate`, then `podman start <containers>`                                              |
| Container sandbox fails with "permission denied" on socket         | Missing `--group-add keep-groups`, missing `CONTAINER_HOST`, or SELinux label blocking the mounted Podman socket | Ensure `AICR_ENABLE_CONTAINER_SANDBOX=true` in deploy.sh; verify `systemctl --user status podman.socket` is active              |
| Build fails at `COPY deploy/docker-static` after clean source sync | Optional Docker static binary placeholder missing from `source/deploy/`                                          | Use current `deploy.sh`; it creates a placeholder when nested sandboxing is disabled and downloads the real binary when enabled |
| `.env` UTF-16 encoding causes container startup failure            | PowerShell `>` redirect wrote `.env` as UTF-16 LE                                                                | Use `scp` or remote `printf`; `deploy.sh` auto-detects and rejects UTF-16 `.env` files                                          |
| `admin` sessions expire unexpectedly                               | Config used `session_ttl_minutes` instead of `session_ttl_seconds`                                               | Schema only recognizes `session_ttl_seconds` (default 28800 = 8 hours); `session_ttl_minutes` is silently ignored               |
| Reviews `Agent kilo timed out after <N>ms` where N ≫ `agent.timeout_seconds`, retries get progressively slower | Orphaned agent worker processes (`.kilo`) survived a timeout kill and are accumulating, exhausting CPU (death spiral). Confirm with `podman exec aicr ps -eo pid,ppid,etime,comm \| grep kilo` (many PPID=1 rows = orphans) | Redeploy the fixed image (timeout now kills the whole process tree, including `setsid` workers, via a `/proc` PPID walk; outer container runs with `--init` so PID 1 reaps zombies). To recover immediately, `podman restart aicr` so the runtime reaps all orphaned processes, then verify with `podman logs --tail 50 aicr`. Do not remove `--init` from `deploy.sh` |
| GitHub/GitLab/P4 issue events fail with `issue_triage_failed` / `fetch failed` | Issue triage only has a Gitea client but is being applied to non-Gitea issue events (provider not gated) | Redeploy the fixed image (triage is now provider-gated). No GitHub/GitLab triage client exists; non-Gitea workspaces must not rely on issue auto-close |
| `github-managed-findings` (or `github_problem_issue`) returns 401/403   | The trigger's `token_env` token is expired, revoked, or lacks Issues read/write scope (webhook `Issues` event subscription does NOT grant REST issue create/update permission) | Rotate the PAT / refresh the GitHub App installation token with `repo`/`issues:write`; verify with `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" https://api.github.com/user` (expect 200); restart container after updating `.env` |

### Podman `invalid internal status` deep-dive

**Root cause:** The server uses a custom `rootless_storage_path` in `/etc/containers/storage.conf`. Podman 5.x rootless auto-detection can fail to initialize the overlay storage driver after a reboot or OOM kill, producing the misleading message `"could not find any running process"`. The real issue is storage-layer initialization, not a missing pause process.

**Verified fix:**

```bash
# Force explicit overlay driver — bypasses broken auto-detection
podman --storage-driver=overlay system migrate

# Restart containers stopped by migrate
podman start <container-names>

# Verify
curl -sf http://127.0.0.1:<port>/healthz
```

**Prevention in deploy.sh:**

All `podman` commands in `deploy.sh` must include `--storage-driver=overlay`:

```bash
podman --storage-driver=overlay build -t aicr:latest -f deploy/Dockerfile .
podman --storage-driver=overlay rm -f aicr 2>/dev/null || true
podman --storage-driver=overlay run -d --name aicr -p <host-port>:8080 ...
```

Add a pre-flight check at the top of `deploy.sh`:

```bash
if ! podman ps >/dev/null 2>&1; then
  podman --storage-driver=overlay system migrate
fi
```

**Why `--storage-driver=overlay` is required:** When the system `storage.conf` sets custom paths such as `graphroot`, `runroot`, or `rootless_storage_path` (e.g. on a host that redirects container storage to a non-default disk), Podman 5.x rootless auto-detection may fail to initialize the overlay driver. Without an explicit driver flag, Podman may open the storage database with a nil `storageService`, causing nil-pointer crashes during `system migrate`.

## Security Notes

- The SSH key path is environment-specific; do not hardcode it in committed scripts.
- `.env` and `secret.json` are in `.gitignore` equivalents; never commit them.
- API keys and webhook secrets must be sourced from the remote `.env` file, not embedded in scripts.
