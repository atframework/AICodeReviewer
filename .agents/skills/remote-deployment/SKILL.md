---
name: remote-deployment
description: "Use when: deploying AICR to a remote server, updating deployed config.yaml, syncing source files, or troubleshooting podman build/run issues; do not use for local development or CI pipeline changes."
user-invocable: false
---

# Remote Deployment

Deploy AICR to the production server. The actual host, port, user, key path, and deploy directory are documented in `development/README.md` and must never be hardcoded in committed scripts.

## Remote Layout

```
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
- `deploy.sh` downloads a Docker static binary (~40MB) on first run.
- `config.yaml` must set `sandbox.kind: docker` (Docker CLI inside container talks to Podman socket).
- `deploy.sh` adds `--userns=keep-id --group-add keep-groups` so the container process can access the socket.

Verify after deploy:

```bash
ssh ... <remote-host> "podman exec aicr sh -c 'docker --version && docker run --rm alpine:latest echo sandbox-ok'"
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

## Common Failures and Recovery

| Symptom                           | Likely Cause                            | Fix                                                             |
| --------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `deploy.sh` fails at build stage  | Outdated `source/` or lockfile mismatch | Re-sync source, ensure `pnpm-lock.yaml` is up to date           |
| `healthz` returns non-200         | Config validation failed                | Check `podman logs aicr` for Zod/config errors                  |
| Container exits immediately       | Port conflict or missing volume         | Check `podman ps -a` and logs                                   |
| Feishu/webhook notifications fail | Missing env var in `.env`               | Verify `.env` has required vars, restart container              |
| WeCom notifications fail          | Missing `WECOM_WEBHOOK` in `.env`       | Add env var, restart container                                  |
| Gitea issues not created          | `kind` mismatch or missing `token_env`  | Verify config `kind` matches code, check `token_env` resolution |
| `podman ps` fails with `invalid internal status` | Rootless storage driver init failure (custom `rootless_storage_path` in `/etc/containers/storage.conf`) | `podman --storage-driver=overlay system migrate`, then `podman start <containers>` |
| Container sandbox fails with "permission denied" on socket | Missing `--group-add keep-groups` when using `--userns=keep-id` in detached containers | Ensure `AICR_ENABLE_CONTAINER_SANDBOX=true` in deploy.sh; verify `systemctl --user status podman.socket` is active |

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
