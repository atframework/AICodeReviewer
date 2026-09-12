---
name: remote-deployment
description: "Deploy or troubleshoot remote AICR, update deployed config, or perform authorized managed-issue repair; skip local development and CI-only changes."
user-invocable: false
---

# Remote Deployment

## Prepare the authorized change

1. Read the relevant host entry in `development/README.md` and the actual
   `deploy/deploy.sh`/Dockerfile. Recheck host, user, port, key, deploy root,
   engine, service manager, mounts, current image and health. Do not hardcode
   environment identity in committed scripts or display `.env`/secret values.
2. Inspect the local diff and deployed config shape, then state the rollout,
   validation and recovery plan. Preserve user edits and deployment data.
   Scope remote writes to the requested deployment; issue repair needs its own
   existing authorization. Read-only diagnosis does not authorize publication.
3. For source/config transfer, load [source and config](references/source-and-config.md).
   Run applicable local gates first, hydrate LFS, validate the exact staged config,
   and refresh both `source/` and the deployment-root build assets.
4. Execute the repository deploy script with the resolved settings. Keep systemd,
   compose and plain-container ownership distinct; do not start a competing
   container. Read [recovery](references/recovery.md) only for failed deploys,
   rollback, engine/socket problems, or managed issue repair.
5. Verify local and reverse-proxy health, service/container state, deployed
   version/config and bounded recent logs. Distinguish build/health from actual
   review acceptance; do not create reviews or notifications merely to test a deploy.

## Deployment invariants

- `config.yaml`/`.env` are mounts: config-only changes need the correct service
  restart, not a rebuild. Preserve YAML anchors, env indirection and UTF-8 encoding.
- The script builds with `<deploy-dir>/deploy/Dockerfile`, not
  `source/deploy/Dockerfile`; refresh the root deploy assets after source sync.
- Preserve data bind mounts, `--init`, restart policy and the existing engine
  options. Systemd and compose flags are mutually exclusive. Current script and
  host configuration own exact arguments, proxy behavior and image tags.
- Runtime tool availability does not imply host/WSL availability. Probe the host;
  use [PowerShell guidance](../modern-cli-toolkit/references/powershell-for-agents.md)
  for Windows quoting and launcher failures. Temporary artifacts stay under `build/`.
