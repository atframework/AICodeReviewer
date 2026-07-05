---
title: Operations and Security
description: Observability dashboard and metrics, admin auth, the secret scrubber, sandbox security model, socket risk, backup, and upgrade / rollback.
---

This page covers day-2 operations for a running AICR deployment: the
observability dashboard and Prometheus metrics endpoint, admin authentication,
the secret scrubber, the sandbox security model, the Podman/Docker socket
threat model, backups, and upgrade / rollback.

## Observability dashboard

Set `admin.username_env` plus either `admin.password_env` or
`admin.password_hash_env` to enable the built-in dashboard. The dashboard is a
separate super-admin surface — it does **not** reuse webhook HMAC or trigger
API keys (see [Authentication & secrets](/en/configuration/authentication/)).

| Route | Method | Purpose |
| --- | --- | --- |
| `/dashboard` and `/` | GET | Serve the embedded SPA |
| `/api/admin/login` | POST | Returns a Bearer session token |
| `/api/admin/stats` | GET | All-time, today, this-week, this-month statistics, plus project / provider / recent-run data |

### Admin auth

Prefer `password_hash_env` (format `sha256:<hex>`) in production; a raw password
env is allowed for small internal deployments but is compared with a
constant-time digest check, rate-limited, and never logged.

:::caution[Session TTL is in seconds]
The admin session TTL field is `session_ttl_seconds` (default `86400` = 24 hours).
A field named `session_ttl_minutes` is **ignored**. If you copy an older example
that uses minutes, your sessions will not expire at the interval you expect.
:::

Generate a sha256 password hash:

```bash
node -e "console.log('sha256:' + require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" 'your-password'
```

## Prometheus metrics

The server exposes a Prometheus-compatible `/metrics` endpoint. Scrape it from
your existing Prometheus/Grafana stack alongside `/healthz` for liveness.

## SQLite store

The built-in store is SQLite + Drizzle at `storage.database.sqlite.path`
(default `/app/data/aicr.sqlite`). The config schema already reserves
Postgres, Redis cache, and S3-compatible object storage under top-level
`storage.*`, but the dashboard runtime currently uses **SQLite only**.

Keep secrets in `.env`; `config.yaml` should contain env-var names only.

## Secret scrubber

AICR scrubs known secrets at four boundaries before persisting or emitting
content:

| Boundary | What is scrubbed |
| --- | --- |
| Prompt | The instruction payload handed to the agent |
| Log | Anything written to the application log |
| Template | Rendered output-channel templates |
| Output | Final published reports (PR comments, Feishu cards, etc.) |

:::note[Defense-in-depth, not least-exposure]
The scrubber is **defense-in-depth**, not a substitute for least exposure.
Keep practicing least privilege regardless:

- Read-only, scoped outbound tokens per VCS provider.
- A dedicated, scoped P4/SVN service account.
- LLM keys scoped to only the models AICR uses.

The scrubber catches accidental leakage; it cannot undo a secret that was
deliberately placed into a prompt or committed into a reviewed file.
:::

## Sandbox security model

Every agent run can be isolated in a sandbox container. The security model
holds across the `native`, `docker`, `docker_socket`, and `podman` backends:

- **Command allowlist.** The container command is checked against
  `ALLOWED_COMMANDS` before any container engine is invoked. Unknown commands
  fail preflight.
- **Read-only `source/`.** Source is mounted read-only at `/workspace/source`.
  The agent cannot modify the code under review.
- **Isolated cwd.** `agent/` and `tmp/` are the only writable workspace mounts;
  the working directory is scoped per run.
- **Env file outside mounts.** Temporary `--env-file` files are created
  **outside** the mounted workspace directories and deleted after the run, so a
  compromised agent cannot read sibling run secrets from the workspace tree.
- **Timeout cleanup.** `agent.timeout_seconds` triggers a whole-process-tree
  kill — the agent binary and its worker subprocesses — so runs cannot overrun
  by leaving orphaned workers behind. See
  [Docker deployment](/en/deployment/docker/#agent-timeout-and-process-cleanup).

## Podman / Docker socket risk

The nested container sandbox (see [Docker](/en/deployment/docker/) and
[Podman](/en/deployment/podman/)) requires mounting the host Podman or Docker
socket into the AICR container. **That socket is full, root-equivalent access
to the host container engine** — whoever can talk to it can start containers and
run arbitrary code as the host user that owns it.

Only enable a nested container sandbox on a host you fully control, and prefer
the rootless user-level Podman socket (`/run/user/$UID/podman/podman.sock`)
over the system Docker socket when possible.

## Data directory backup

Back up the three mounted data volumes. They contain everything AICR persists:

| Volume | Container path | What it holds |
| --- | --- | --- |
| `aicr-data` | `/app/data` | SQLite store, run history, queue state |
| `aicr-workspaces` | `/app/workspaces` | Cloned repo / checkout caches |
| `aicr-logs` | `/app/logs` | Application log files |

A minimal offline backup:

```bash
docker run --rm -v aicr-data:/data -v "$PWD/backup:/backup" alpine \
  tar czf /backup/aicr-data-$(date +%F).tgz -C /data .
```

`config.yaml` and `.env` live on the host (typically under `example/`) — back
those up separately. They are not part of the named volumes.

:::tip[Restore order]
Stop the container, restore the three volumes, then start the container again.
The SQLite store carries run state, so restoring it while the server is running
will produce a torn state.
:::

## Upgrade and rollback

Because `config.yaml` and `.env` are **volume-mounted** (not baked into the
image), there are two upgrade lanes:

| Change type | Procedure |
| --- | --- |
| **Config-only** (LLM model, triggers, outputs, workspace additions, label rules, etc.) | Edit `config.yaml` and/or `.env`, then restart the container. No rebuild needed. |
| **Code change** (new AICR release, Dockerfile / tool-list change) | `docker build -t aicodereviewer -f deploy/Dockerfile .` then restart the container. |

Restart for config-only changes:

```bash
docker restart aicr
```

Rollback works the same way in reverse: keep the previous image tag around, and
`docker run` the old image against the same volumes. Because state lives in the
volumes (not the image), an image rollback does not lose run history as long as
the SQLite schema has not migrated forward irreversibly — so before deploying a
new image that ships a schema migration, snapshot the `aicr-data` volume.
