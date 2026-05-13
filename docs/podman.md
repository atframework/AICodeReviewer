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

- `podman --version` fails: install Podman for the service user and ensure `PATH` is available in the service environment.
- Containers cannot read `/workspace/source`: verify the host source directory exists and the service user has read permission.
- Containers cannot write `/workspace/agent` or `/workspace/tmp`: verify workspace ownership and rootless UID mapping.
- The sandbox falls back to native mode: set `agent.sandbox.kind: podman` and `agent.sandbox.engine: podman` to make a missing Podman binary fail preflight instead of using Docker first.
