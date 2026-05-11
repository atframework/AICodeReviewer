---
name: remote-deployment
description: "Use when: deploying AICR to the remote server at 10.64.8.2, updating deployed config.yaml, syncing source files, or troubleshooting podman build/run issues; do not use for local development or CI pipeline changes."
user-invocable: false
---

# Remote Deployment

Deploy AICR to the production server (`10.64.8.2`, user `tools`, port `36000`, key `D:/workspace/keys/id_ed25519.it`).

## Remote Layout

```
/data/disk2/AICodeReviewer/
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
ssh -p 36000 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no \
  -o User=tools -i D:/workspace/keys/id_ed25519.it 10.64.8.2
```

On Windows PowerShell, **do not use `&&` inside a single command string** — it fails with a parser error. Chain with `;` or use separate tool calls.

## File Sync (Windows Host → Remote)

### Problem: rsync is not available on Windows

**Solution:** Use `tar czf` + `scp` + `ssh tar xzf`:

```powershell
# 1. Create tarball locally
tar czf /tmp/aicr-update.tar.gz -C D:/workspace/git/github/atframework/AICodeReviewer `
  file1 file2 dir1/ ...

# 2. SCP to remote
scp -P 36000 -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no `
  -i D:/workspace/keys/id_ed25519.it `
  /tmp/aicr-update.tar.gz tools@10.64.8.2:/data/disk2/AICodeReviewer/

# 3. Extract on remote (separate SSH call)
ssh -p 36000 ... 10.64.8.2 `
  "cd /data/disk2/AICodeReviewer/source; tar xzf ../aicr-update.tar.gz; rm ../aicr-update.tar.gz"
```

If many files changed, sync the entire `packages/` tree or use `git archive` from the local repo.

## Config Updates

### Problem: Python `yaml` module destroys YAML anchors

The remote `config.yaml` uses YAML anchors (`&safe_issue_triage`) and aliases (`*safe_issue_triage`). Loading with `yaml.safe_load` and dumping with `yaml.dump` strips them, corrupting the file.

**Solution:** Use targeted string replacement (Python or sed) instead of round-tripping through a YAML parser.

**Preferred approach — Python script written to temp file:**

```python
import re

with open("/data/disk2/AICodeReviewer/config.yaml", "r") as f:
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
    with open("/data/disk2/AICodeReviewer/config.yaml", "w") as f:
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
with open('/data/disk2/AICodeReviewer/config.yaml', 'r') as f:
    content = f.read()
# ... replacement logic ...
"@
Set-Content -Path C:\temp\update_config.py -Value $script

# SCP and execute
scp -P 36000 ... C:\temp\update_config.py tools@10.64.8.2:/data/disk2/AICodeReviewer/
ssh -p 36000 ... 10.64.8.2 "python3 /data/disk2/AICodeReviewer/update_config.py; rm -f /data/disk2/AICodeReviewer/update_config.py"
```

### Problem: Config kind drift between code and deployed config

The code schema may have renamed a channel `kind` (e.g., `gitea_finding_issue` → `gitea_problem_issue`). The deployed `config.yaml` may still use the old name, causing the server to reject the config on startup.

**Always verify before deploy:**

```bash
ssh ... 10.64.8.2 "grep 'kind: gitea_problem_issue' /data/disk2/AICodeReviewer/config.yaml"
```

If the kind name changed, update it in the remote config **before** running `deploy.sh`.

## Build and Deploy

### Standard deploy flow

```bash
# 1. Sync source files to remote source/
# 2. Update config.yaml if needed
# 3. Run deploy script on remote
ssh -p 36000 ... 10.64.8.2 "cd /data/disk2/AICodeReviewer; bash deploy.sh"
```

The `deploy.sh` script:
1. Builds podman image `aicr:latest` from `source/` using `deploy/Dockerfile`
2. Stops and removes old `aicr` container
3. Starts new container with volume mounts and env vars
4. Runs health check on `http://127.0.0.1:8090/healthz`

### Post-deploy verification

```bash
# Health check (remote)
curl -sf http://127.0.0.1:8090/healthz

# Health check (via reverse proxy)
curl -sf https://aicr.m-oa.com:6023/healthz

# Container status
ssh ... 10.64.8.2 "podman ps --filter name=aicr"

# Recent logs
ssh ... 10.64.8.2 "podman logs --tail 50 aicr"
```

## Environment Variables on Remote

The `.env` file on remote contains secrets. **Never display its full contents in logs.** The known env vars are:

- `ALIYUN_CODING_TOKEN`, `TENCENT_CODING_TOKEN` — LLM API keys
- `GITEA_TOKEN`, `GITEA_WEBHOOK_SECRET` — Gitea integration
- `P4USER`, `P4PASSWORD` — Perforce integration
- `AICR_API_KEY` — Server API key for `/triggers/*`
- `FEISHU_WEBHOOK`, `FEISHU_SECRET` — Feishu bot

## Common Failures and Recovery

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `deploy.sh` fails at build stage | Outdated `source/` or lockfile mismatch | Re-sync source, ensure `pnpm-lock.yaml` is up to date |
| `healthz` returns non-200 | Config validation failed | Check `podman logs aicr` for Zod/config errors |
| Container exits immediately | Port conflict or missing volume | Check `podman ps -a` and logs |
| Feishu/webhook notifications fail | Missing env var in `.env` | Verify `.env` has required vars, restart container |
| Gitea issues not created | `kind` mismatch or missing `token_env` | Verify config `kind` matches code, check `token_env` resolution |

## Security Notes

- The SSH key path `D:/workspace/keys/id_ed25519.it` is fixed; do not hardcode it in committed scripts.
- `.env` and `secret.json` are in `.gitignore` equivalents; never commit them.
- API keys and webhook secrets must be sourced from the remote `.env` file, not embedded in scripts.
