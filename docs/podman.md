# Podman sandbox guide

This guide explains how to run AICodeReviewer with the Podman-compatible sandbox path described in `docs/ai/architecture.md` §3.8 and tracked in the `Plan.md` M5 roadmap. The implementation uses the same container contract as Docker, but resolves the CLI to `podman` when `sandbox.kind: podman` or `sandbox.engine: podman` is selected.

## When to choose Podman

Use Podman when the deployment environment prefers rootless, daemonless containers or cannot run a privileged Docker daemon. AICR still mounts only the scoped review directories into each run container and keeps `source/` read-only.

## Rootless local setup

Install Podman with your platform package manager, then verify the CLI is visible to the service user:

```bash
podman --version
podman run --rm --network none alpine:latest true
```

On Linux, enable the user socket only when a socket-based deployment mode needs it:

```bash
systemctl --user enable --now podman.socket
systemctl --user status podman.socket
```

The rootless socket path is usually:

```text
/run/user/$UID/podman/podman.sock
```

## AICR configuration

Force Podman for local or self-hosted runs:

```yaml
agent:
  sandbox:
    kind: podman
    engine: podman
    image: ghcr.io/owent/aicr-agent:latest
```

Let AICR detect Docker first, then Podman:

```yaml
agent:
  sandbox:
    kind: docker
    engine: auto
```

Use workspace overrides only to increase isolation or select a workspace-specific image:

```yaml
workspaces:
  instances:
    internal-python:
      source_repo: { trigger: gitea-internal, repo: owent/example }
      sandbox:
        kind: podman
        engine: podman
        image: ghcr.io/example/python-review:latest
```

## Runtime guarantees

The Podman path must preserve the same sandbox guarantees as Docker:

- The container command is checked against `ALLOWED_COMMANDS` before Podman is invoked.
- The container runs with `--network none` unless a future allowlist proxy is explicitly wired.
- `source/` is mounted read-only at `/workspace/source`.
- `agent/` and `tmp/` are the only writable workspace mounts.
- Temporary `--env-file` files are created outside mounted workspace directories and deleted after the run.
- Docker and Podman host sockets are not mounted by default.

## SELinux notes

On SELinux-enabled hosts, bind mounts may need relabeling. Prefer a dedicated review image and workspace directory owned by the service user. If the host requires explicit labels, add them in the future backend mount policy rather than editing generated commands by hand.

## Troubleshooting

### `invalid internal status, try resetting the pause process with "podman system migrate"`

This error occurs when rootless Podman's storage driver initialization fails, often after a system reboot, OOM kill, or when `/etc/containers/storage.conf` uses a custom `rootless_storage_path`.

**Important:** The error message `"could not find any running process"` is misleading. The root cause is usually **storage-layer initialization failure**, not a missing pause process.

**Quick fix (non-destructive):**

```bash
# Force overlay driver explicitly — this bypasses the broken auto-detection
podman --storage-driver=overlay system migrate

# Restart stopped containers
podman start aicr caddy

# Verify
curl -sf http://127.0.0.1:8090/healthz
```

**Why this works:** When `/etc/containers/storage.conf` configures custom paths (`graphroot`, `runroot`, `rootless_storage_path`), Podman 5.x may fail to auto-detect the storage driver in rootless mode. Explicit `--storage-driver=overlay` skips auto-detection and directly opens the overlay-backed storage.

**If migrate still crashes:** Check for a stale container exit record with code 137 (SIGKILL) in `/run/user/$UID/libpod/tmp/exits/` or `/run/user/$UID/libpod/tmp/persist/`. Remove those files, then retry migrate.

**Prevention in deploy scripts:** Always specify `--storage-driver=overlay` in `deploy.sh`:

```bash
podman --storage-driver=overlay build -t aicr:latest ...
podman --storage-driver=overlay run -d --name aicr ...
```

**Pre-flight check for automation:**

```bash
if ! podman ps >/dev/null 2>&1; then
  podman --storage-driver=overlay system migrate
fi
```

### Other common issues

- `podman --version` fails: install Podman for the service user and ensure `PATH` is available in the service environment.
- Containers cannot read `/workspace/source`: verify the host source directory exists and the service user has read permission.
- Containers cannot write `/workspace/agent` or `/workspace/tmp`: verify workspace ownership and rootless UID mapping.
- The sandbox falls back to native mode: set `agent.sandbox.kind: podman` and `agent.sandbox.engine: podman` to make a missing Podman binary fail preflight instead of using Docker first.
