---
title: Podman / Rootless
description: Run AICodeReviewer with Podman, including rootless local setup and the nested-container (Docker-out-of-Docker) sandbox pattern.
---

The Podman sandbox path uses the same container contract as Docker, but resolves
the CLI to `podman` when `sandbox.kind: podman` or `sandbox.engine: podman` is
selected. This page covers when to choose Podman, rootless local setup, the
nested-container pattern, runtime guarantees, SELinux notes, and the
`--storage-driver=overlay` recovery pitfall.

## When to choose Podman

Use Podman when the deployment environment prefers **rootless, daemonless**
containers, or cannot run a privileged Docker daemon. AICR still mounts only
the scoped review directories into each run container and keeps `source/`
read-only, so the isolation guarantees are identical to the Docker path.

## Rootless local setup

Install Podman with your platform package manager, then verify the CLI is
visible to the service user:

```bash
podman --version
podman run --rm --network none alpine:latest true
```

On Linux, enable the user socket **only** when a socket-based deployment mode
needs it:

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

Use workspace overrides only to increase isolation or select a
workspace-specific image:

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

## Nested container sandbox (AICR inside a container)

When AICR itself runs inside a container (for example via `deploy.sh`) and you
want the sandbox to spawn **child containers** for agent isolation, the host
container-engine socket must be mounted into the AICR container. This is a
Docker-out-of-Docker (DooD) pattern applied to Podman.

### Requirements

1. **Host user-level Podman socket** must be enabled:

   ```bash
   systemctl --user enable --now podman.socket
   ```

2. **Podman CLI** inside the AICR image. The runtime image ships `podman`, so
   `sandbox.kind: podman` / `sandbox.engine: podman` can talk to the mounted
   host socket through `CONTAINER_HOST`.
3. **Optional Docker static binary** inside the AICR image for Docker-compatible
   clients (installed by `deploy.sh` when `AICR_ENABLE_CONTAINER_SANDBOX=true`).
4. **`deploy.sh` environment variable**:

   ```bash
   AICR_ENABLE_CONTAINER_SANDBOX=true   # enables socket mount + Podman/Docker clients
   ```

5. **`config.yaml` sandbox kind** set to native Podman when possible:

   ```yaml
   agent:
     sandbox:
       kind: podman
       engine: podman
   ```

   Docker-compatible mode remains available when you specifically need Docker
   CLI semantics:

   ```yaml
   agent:
     sandbox:
       kind: docker
       engine: auto
   ```

### How it works

- The runtime image installs `podman`, `buildah`, and `skopeo`. No Podman
  daemon is started inside the AICR container — the CLI is only a client for the
  mounted host Podman API socket.
- `deploy.sh` downloads the Docker static binary and bakes it into the image
  when `AICR_ENABLE_CONTAINER_SANDBOX=true`; otherwise it creates a harmless
  empty `deploy/docker-static` placeholder so clean source syncs still satisfy
  the Dockerfile's optional `COPY` step. The runtime image removes that empty
  placeholder instead of installing a zero-byte `docker` executable.
- At runtime, `deploy.sh` mounts the host user-level Podman socket
  (`/run/user/$UID/podman/podman.sock`) into the AICR container.
- `deploy.sh` sets `CONTAINER_HOST=unix:///run/user/$UID/podman/podman.sock` so
  the Podman CLI talks to the host Podman service.
- `deploy.sh` also sets `DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock`
  so Docker-compatible tools can use Podman's Docker API layer.
- `--userns=keep-id --group-add keep-groups` ensures the container process can
  access the user-level socket.
- `--security-opt label=disable` is added when a Podman socket is mounted,
  which matches Podman's documented guidance for accessing the Unix socket from
  inside another container on SELinux-enabled hosts.

:::warning[Treat the socket as privileged]
The Podman API can start containers and execute arbitrary code as the host user
that owns the socket. Mounting it gives the AICR container that level of
control — only do this on a host you fully control. See
[Operations and Security](/en/deployment/operations/).
:::

### Verification

After deployment, confirm from inside the AICR container:

```bash
podman exec aicr sh -c 'podman --version && podman run --rm alpine:latest echo podman-ok'
podman exec aicr sh -c 'docker --version && docker run --rm alpine:latest echo docker-ok'
```

## Runtime guarantees

The Podman path preserves the same sandbox guarantees as Docker:

- The container command is checked against `ALLOWED_COMMANDS` before Podman is
  invoked.
- The container runs with `--network none` unless a future allowlist proxy is
  explicitly wired.
- `source/` is mounted read-only at `/workspace/source`.
- `agent/` and `tmp/` are the only writable workspace mounts.
- Temporary `--env-file` files are created **outside** mounted workspace
  directories and deleted after the run.
- Docker and Podman host sockets are **not** mounted by default.

## SELinux notes

On SELinux-enabled hosts, bind mounts may need relabeling. Prefer a dedicated
review image and a workspace directory owned by the service user. If the host
requires explicit labels, add them in the backend mount policy rather than
editing generated commands by hand.

## Troubleshooting

### `invalid internal status, try resetting the pause process with "podman system migrate"`

This error occurs when rootless Podman's storage driver initialization fails —
often after a system reboot, an OOM kill, or when
`/etc/containers/storage.conf` uses a custom `rootless_storage_path`.

:::caution[The error message is misleading]
The trailing `"could not find any running process"` is **not** a missing pause
process. The root cause is almost always **storage-layer initialization
failure**, not a missing process.
:::

Quick fix (non-destructive):

```bash
# Force overlay driver explicitly — bypasses the broken auto-detection
podman --storage-driver=overlay system migrate

# Restart stopped containers
podman start aicr caddy

# Verify
curl -sf http://127.0.0.1:8090/healthz
```

**Why this works:** when `/etc/containers/storage.conf` configures custom paths
(`graphroot`, `runroot`, `rootless_storage_path`), Podman 5.x may fail to
auto-detect the storage driver in rootless mode. Explicit `--storage-driver=overlay`
skips auto-detection and directly opens the overlay-backed storage.

**If migrate still crashes:** check for a stale container exit record with code
137 (SIGKILL) in `/run/user/$UID/libpod/tmp/exits/` or
`/run/user/$UID/libpod/tmp/persist/`. Remove those files, then retry migrate.

**Prevention in deploy scripts:** when `deploy.sh` runs Podman (the default
`AICR_ENGINE=podman` path), always specify `--storage-driver=overlay`:

```bash
podman --storage-driver=overlay build -t aicr:latest ...
podman --storage-driver=overlay run -d --name aicr ...
```

If `AICR_ENGINE=docker` is selected, omit this Podman-only flag and fail fast
if `docker ps` cannot connect to the daemon.

Pre-flight check for automation:

```bash
if ! podman ps >/dev/null 2>&1; then
  podman --storage-driver=overlay system migrate
fi
```

### Other common issues

- `podman --version` fails: install Podman for the service user and ensure
  `PATH` is available in the service environment.
- Containers cannot read `/workspace/source`: verify the host source directory
  exists and the service user has read permission.
- Containers cannot write `/workspace/agent` or `/workspace/tmp`: verify
  workspace ownership and rootless UID mapping.
- The sandbox falls back to native mode: set `agent.sandbox.kind: podman` and
  `agent.sandbox.engine: podman` to make a missing Podman binary fail preflight
  instead of silently using Docker first.
