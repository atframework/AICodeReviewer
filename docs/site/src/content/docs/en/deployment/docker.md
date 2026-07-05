---
title: Docker Deployment
description: Build and run the AICodeReviewer single-container image with Docker, configure the runtime tool baseline, and enable the nested-container sandbox.
---

For most deployments, the quickest path is [Docker Compose](/en/start/docker-compose/).
This page covers the equivalent plain `docker build` / `docker run` flow, the
runtime image baseline (what tools ship in the image and why), the build args
you can override for restricted networks, and the two container-based sandbox
backends.

## Build and run without Compose

```bash
# Build the image from the repository root
docker build -t aicodereviewer -f deploy/Dockerfile .

# Run it
docker run -d \
  --name aicr \
  --init \
  --env-file example/.env \
  -p 8080:8080 \
  -v $(pwd)/example/config.yaml:/app/config.yaml:ro \
  -v aicr-data:/app/data \
  -v aicr-workspaces:/app/workspaces \
  -v aicr-logs:/app/logs \
  aicodereviewer
```

:::tip[Always pass --init]
The container's entrypoint is `node packages/cli/dist/index.js`. Node is **not**
a PID-1 init: it does not reap orphaned/zombie processes left behind by agent
subprocesses. Always add `--init` (Docker injects `tini`) so child reaping
works and signal forwarding is correct. The [agent timeout](#agent-timeout-and-process-cleanup)
section explains why this matters.
:::

### Volume layout

| Host side | Container path | Mode | Purpose |
| --- | --- | --- | --- |
| `example/config.yaml` | `/app/config.yaml` | `:ro` | Main configuration — LLM, triggers, outputs, workspaces |
| `aicr-data` | `/app/data` | rw | Persistent queue DB, run history, SQLite store |
| `aicr-workspaces` | `/app/workspaces` | rw | Cloned repo / checkout caches |
| `aicr-logs` | `/app/logs` | rw | Application log files |

`config.yaml` is mounted read-only on purpose: it should contain **only env-var
names**, never secret values (see [Authentication & secrets](/en/configuration/authentication/)).
Secrets themselves come in through `--env-file example/.env`, which is **not**
mounted into the container filesystem — Docker reads it on the host and injects
the variables into the process environment.

The container exposes port `8080` (`-p 8080:8080`) and serves `/healthz` for
health checks. The Compose file wires that into a `healthcheck` block; for a
plain `docker run`, point your own probe at `http://localhost:8080/healthz`.

## Runtime image baseline

The image intentionally uses `ubuntu:24.04` as the distro base and copies the
Node 22 userspace from the official `node:22-bookworm-slim` image. This keeps
Node on an official LTS userspace while letting AICR install the **official
Perforce Ubuntu APT package (`p4-cli`)**. The Perforce package needs glibc and
the Ubuntu package layout — building the whole base on the slim Node image would
not give you that.

### Tool list

The runtime tool baseline, grouped by job:

| Group | Tools |
| --- | --- |
| VCS | `git`, `git-lfs`, `subversion`, `p4` |
| Search & inspection | `rg`, `fd`, `bat`, `jq`, `tree`, `universal-ctags` |
| Kubernetes & YAML | `kubectl`, `helm`, Mike Farah `yq`; use `kubectl kustomize` for Kustomize overlays when a standalone `kustomize` binary is not required |
| Container clients | `podman`, `buildah`, `skopeo`, plus an optional Docker static CLI for Docker-compatible socket workflows |
| Build & static analysis | `build-essential`, `cmake`, `ninja`, `pkg-config`, `clang`, `clang-format`, `clang-tidy`, `cppcheck` |
| Python | `python3`, `python`, `pip`, `venv`, Python headers, setuptools, wheel |
| Debugging & troubleshooting | `gdb`, `valgrind`, `shellcheck`, `strace`, `lsof`, `inotify-tools`, `curl`, `wget`, `dnsutils`, `iputils-ping`, `iproute2`, `tcpdump`, `netcat-openbsd`, `openssl` |
| Data & sync | `sqlite3`, `rsync`, `xxd`, `bsdextrautils` |
| Patch & archive | `diffutils`, `patch`, `unzip`, `zip`, `xz`, `tar`, `gzip`, `bzip2`, `zstd`, `lz4` |

On Debian/Ubuntu the distro packages expose `fdfind` and `batcat`. The image
adds compatibility symlinks (`fd`, `bat`) so agent prompts can consistently refer
to those names. The container also ships `p4` directly, so deployment no longer
depends on bind-mounting a host-side Perforce binary.

## Configurable build args

All of these are optional. Override them with `docker build --build-arg ...`
when your network cannot reach the upstream registries, or when you want to pin
a different version.

| Build arg | Default | Purpose |
| --- | --- | --- |
| `BASE_IMAGE` | `ubuntu:24.04` | Distro base for build and runtime stages |
| `NODE_IMAGE` | `node:22-bookworm-slim` | Official Node 22 image used as the Node userspace source. Omit/leave default when the host already rewrites registry pulls through a global mirror |
| `APT_MIRROR` | *(empty)* | Ubuntu apt mirror root, e.g. `http://mirrors.ustc.edu.cn/ubuntu` |
| `PERFORCE_APT_DISTRO` | `noble` | Ubuntu codename for the Perforce APT repo |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | npm/pnpm registry |
| `NPM_STRICT_SSL` | `true` | Set to `false` when using an HTTP mirror |
| `PIP_INDEX_URL` | `https://pypi.org/simple` | pip simple index URL |
| `KUBERNETES_APT_REPO_BASE` | `https://pkgs.k8s.io/core:/stable:` | kubectl APT repo base (must end in `core:/stable:`) |
| `KUBERNETES_APT_REPO_VERSION` | `v1.36` | Kubernetes minor repo for kubectl |
| `HELM_APT_REPO` | `https://packages.buildkite.com/helm-linux/helm-debian/any/` | Helm Debian package repo |
| `HELM_APT_KEY_URL` | `https://packages.buildkite.com/helm-linux/helm-debian/gpgkey` | Helm repo signing key |
| `YQ_VERSION` | `v4.53.2` | Mike Farah `yq` release version |
| `YQ_DOWNLOAD_BASE` | `https://github.com/mikefarah/yq/releases/download` | `yq` release download base |

The following is a `deploy.sh` environment variable (not a Dockerfile `ARG`),
used only when the nested container sandbox downloads the optional Docker
static CLI:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCKER_DOWNLOAD_MIRROR` | `https://download.docker.com/linux/static/stable/x86_64` | Mirror for the optional Docker static CLI downloaded by `deploy.sh` |

:::note[Deprecated alias]
`APK_MIRROR` is still accepted as a backward-compatibility alias for `APT_MIRROR`.
New setups should use `APT_MIRROR`.
:::

### USTC mirror notes (arm64 vs amd64)

USTC mirror docs recommend `http://mirrors.ustc.edu.cn/ubuntu` for `amd64`/`i386`,
while `arm64`/`armhf`/`ppc64el`/`s390x` should use
`http://mirrors.ustc.edu.cn/ubuntu-ports`. `deploy/Dockerfile` rewrites **both**
the standard Ubuntu `archive`/`security` entries **and** the `ports.ubuntu.com`
variants before the first `apt-get update`, so a single HTTP mirror value works
for both architectures without a pre-bootstrap CA fetch.

For Tencent mirrors, the Kubernetes path is `kubernetes_new` (set via
`KUBERNETES_APT_REPO_BASE`). No dedicated `mirrors.tencent.com/helm/` or
`mirrors.tencent.com/yq/` endpoint is verified — for fully internal builds,
point the Helm/yq args at an internal cache that preserves the same repository
layout.

## Extra CAs for corporate proxies

If your build host reaches external HTTPS through a corporate proxy or local
mirror that uses a private root CA, copy the required `.crt` files into
`deploy/extra-ca/` before building:

```bash
cp /etc/ssl/certs/my-corporate-root.crt deploy/extra-ca/
docker build -t aicodereviewer -f deploy/Dockerfile .
```

`deploy/Dockerfile` copies `deploy/extra-ca/` into
`/usr/local/share/ca-certificates/` and runs `update-ca-certificates` **before**
fetching any external keys, npm packages, or release artifacts, so the rest of
the build trusts your private root.

## HTTP proxy autodetect

If the deployment host exposes an HTTP proxy on TCP `3128`, `deploy.sh`
auto-detects it and uses it for host-side downloads plus `podman build` /
`docker build` fetches. Explicit `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
environment variables always **take precedence** over autodetection, and a
loopback-only proxy (`127.0.0.1:3128`) automatically switches the build to host
networking so Dockerfile `RUN` steps can still reach it.

## Sandbox backends

AICR can isolate each agent run in its own container. Two container backends
are relevant when the service itself runs inside Docker.

### `docker_socket` backend

`docker_socket` uses the same container contract as `docker` but identifies runs
that access the Docker daemon through a Unix socket. Configure it when the
service runs inside a container that mounts `/var/run/docker.sock`:

```yaml
agent:
  sandbox:
    kind: docker_socket
    engine: docker
    image: ghcr.io/owent/aicr-agent:latest
```

No additional Docker Engine API client is required — AICR invokes the `docker`
CLI and relies on the host socket being available to the service container.

:::warning[Socket = privileged access]
Mounting `/var/run/docker.sock` gives the container full, root-equivalent
control of the host Docker daemon. Only do this on a host you fully control.
See [Operations and Security](/en/deployment/operations/) for the threat model.
:::

### Nested container sandbox (AICR inside a container)

When AICR itself runs inside a container and you want sandbox-spawned **child
containers** for agent isolation, enable the nested container sandbox in
`deploy.sh`:

```bash
AICR_ENABLE_CONTAINER_SANDBOX=true bash deploy/deploy.sh
```

This tells `deploy.sh` to:

1. Download a Docker static binary into the build context when Docker-compatible
   socket clients are needed.
2. Mount the host user-level Podman socket into the AICR container.
3. Set `CONTAINER_HOST` for the native `podman` CLI and `DOCKER_HOST` for the
   Docker CLI so both route to the host Podman service.
4. Add `--userns=keep-id --group-add keep-groups` so the container user can
   access the socket.

When nested container sandboxing is **disabled**, `deploy.sh` still creates an
empty `deploy/docker-static` placeholder so clean syncs do not fail the
Dockerfile's optional `COPY` step. The runtime image removes that empty
placeholder rather than installing a zero-byte `docker` executable.

#### Host requirements

Enable the host user-level Podman socket (rootless):

```bash
systemctl --user enable --now podman.socket
```

Then prefer native Podman when reviewing containerized workloads through the
host Podman socket:

```yaml
agent:
  sandbox:
    kind: podman
    engine: podman
```

For Docker-compatible workflows, set `sandbox.kind: docker` and let the Docker
CLI inside the container talk to Podman through `DOCKER_HOST`:

```yaml
agent:
  sandbox:
    kind: docker
    engine: auto
```

The full Podman rootless setup, runtime guarantees, SELinux notes, and the
`--storage-driver=overlay` recovery pitfall live on the
[Podman](/en/deployment/podman/) page.

## Agent timeout and process cleanup

`agent.timeout_seconds` is a hard cap on an agent run. When it fires, the
sandbox kills the **whole process tree** — the agent binary plus its worker
subprocesses — not just the direct child, so a run cannot overrun the budget by
leaving orphaned workers behind.

If reviews ever appear to hang or get progressively slower across retries, the
cause is usually lingering agent processes that escaped tree cleanup (this is
exactly why `--init` matters). **Restart the AICR container** — the runtime
reaps any lingering agent processes on restart.
