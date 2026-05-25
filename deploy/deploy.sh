#!/bin/bash
set -euo pipefail

DEPLOY_DIR="${AICR_DEPLOY_DIR:-/data/disk2/AICodeReviewer}"
IMAGE_NAME="${AICR_IMAGE_NAME:-aicr:latest}"
HOST_PORT="${AICR_HOST_PORT:-8090}"
CONTAINER_PORT="${AICR_CONTAINER_PORT:-8080}"
CONTAINER_NAME="${AICR_CONTAINER_NAME:-aicr}"
ENGINE_CMD="${AICR_ENGINE:-podman}"
ENGINE_BASENAME="$(basename "$ENGINE_CMD")"
ENGINE_ARGS=()
if [ "$ENGINE_BASENAME" = "podman" ]; then
  ENGINE_ARGS=(--storage-driver=overlay)
fi

cd "$DEPLOY_DIR"

# Ensure persistent data directories exist
mkdir -p "$DEPLOY_DIR/data/workspaces" "$DEPLOY_DIR/data/db" "$DEPLOY_DIR/data/logs"
chmod u+rwX,g+rwX,o+rwX "$DEPLOY_DIR/data/workspaces" "$DEPLOY_DIR/data/db" "$DEPLOY_DIR/data/logs"

P4_MOUNT_ARGS=()
if command -v p4 >/dev/null 2>&1; then
  P4_BIN="$(command -v p4)"
  P4_MOUNT_ARGS=(-v "$P4_BIN:/usr/bin/p4:ro" -e P4TRUST=/app/data/p4trust)
fi

# ---------------------------------------------------------------------------
# Optional container-nested sandbox support
# ---------------------------------------------------------------------------
# When AICR itself runs inside a container and config.yaml sets
# sandbox.kind=docker|podman, the host container engine socket must be
# mounted into the AICR container so it can spawn child containers.
# The Docker static binary inside the image talks to Podman's
# docker-compatible socket via DOCKER_HOST.
AICR_ENABLE_CONTAINER_SANDBOX="${AICR_ENABLE_CONTAINER_SANDBOX:-false}"
DOCKER_VERSION="${DOCKER_VERSION:-27.5.1}"
DOCKER_DOWNLOAD_MIRROR="${DOCKER_DOWNLOAD_MIRROR:-https://download.docker.com/linux/static/stable/x86_64}"
DOCKER_STATIC="$DEPLOY_DIR/source/deploy/docker-static"
SANDBOX_MOUNT_ARGS=()
SANDBOX_ENV_ARGS=()
USERNS_ARGS=()

mkdir -p "$(dirname "$DOCKER_STATIC")"

if [ "$AICR_ENABLE_CONTAINER_SANDBOX" = "true" ]; then
  # Download Docker static binary if not already present
  if [ ! -s "$DOCKER_STATIC" ]; then
    echo "=== Downloading Docker static binary v${DOCKER_VERSION} ==="
    DOCKER_TGZ_URL="${DOCKER_DOWNLOAD_MIRROR}/docker-${DOCKER_VERSION}.tgz"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL -o /tmp/docker.tgz "$DOCKER_TGZ_URL"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO /tmp/docker.tgz "$DOCKER_TGZ_URL"
    else
      echo "ERROR: curl or wget required to download Docker CLI"
      exit 1
    fi
    tar xzf /tmp/docker.tgz -C /tmp
    cp /tmp/docker/docker "$DOCKER_STATIC"
    chmod +x "$DOCKER_STATIC"
    rm -rf /tmp/docker /tmp/docker.tgz
    echo "=== Docker static binary ready ==="
  fi

  # Detect host container engine socket
  # Prefer user-level Podman socket (rootless) because system-level sockets
  # are often root-owned and inaccessible to the service user.
  PODMAN_SOCK="/run/user/$(id -u)/podman/podman.sock"
  if [ -S "$PODMAN_SOCK" ]; then
    echo "=== Container sandbox: using Podman socket $PODMAN_SOCK ==="
    SANDBOX_MOUNT_ARGS=(-v "$PODMAN_SOCK:$PODMAN_SOCK")
    SANDBOX_ENV_ARGS=(-e "DOCKER_HOST=unix://$PODMAN_SOCK")
  elif [ -S "/var/run/docker.sock" ]; then
    echo "=== Container sandbox: using Docker socket /var/run/docker.sock ==="
    SANDBOX_MOUNT_ARGS=(-v "/var/run/docker.sock:/var/run/docker.sock")
    SANDBOX_ENV_ARGS=(-e "DOCKER_HOST=unix:///var/run/docker.sock")
  else
    echo "WARNING: AICR_ENABLE_CONTAINER_SANDBOX=true but no container engine socket found."
    echo "  Checked: $PODMAN_SOCK, /var/run/docker.sock"
    echo "  For Podman rootless: systemctl --user enable --now podman.socket"
  fi

  # userns=keep-id maps the host user's UID/GID into the container so the
  # container process can access the user-level Podman socket (which is
  # owned by the host user). Without this, the container user has no
  # permission to talk to the socket even after it is mounted.
  # --group-add keep-groups is required for detached containers so the host
  # user's supplementary groups (including the tools group that owns the
  # socket) are visible inside the container.
  USERNS_ARGS=(--userns=keep-id --group-add keep-groups)
else
  # deploy/Dockerfile has an unconditional COPY for this optional binary.
  # Keep a harmless placeholder in the build context when nested sandboxing is
  # disabled so clean source syncs do not fail before the runtime starts.
  [ -f "$DOCKER_STATIC" ] || : > "$DOCKER_STATIC"
fi

# Pre-flight: recover from rootless storage driver corruption (Podman 5.x)
if ! "$ENGINE_CMD" "${ENGINE_ARGS[@]}" ps >/dev/null 2>&1; then
  if [ "$ENGINE_BASENAME" = "podman" ]; then
    echo "=== Preflight: $ENGINE_CMD migrate with ${ENGINE_ARGS[*]} ==="
    "$ENGINE_CMD" "${ENGINE_ARGS[@]}" system migrate
  else
    echo "ERROR: $ENGINE_CMD ps failed; automatic storage migration is only supported for Podman."
    "$ENGINE_CMD" ps
    exit 1
  fi
fi

# Preserve the previous image for rollback before overwriting the tag
PREV_TAG="${IMAGE_NAME%:*}:previous"
if "$ENGINE_CMD" "${ENGINE_ARGS[@]}" inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  echo "=== Preserving previous image as $PREV_TAG ==="
  "$ENGINE_CMD" "${ENGINE_ARGS[@]}" tag "$IMAGE_NAME" "$PREV_TAG" 2>/dev/null || true
fi

# Build the image
echo "=== Building AICR image ==="
BUILD_ARGS=(--build-arg NPM_STRICT_SSL=false)
if [ -n "${NPM_REGISTRY:-}" ]; then
  BUILD_ARGS+=(--build-arg "NPM_REGISTRY=${NPM_REGISTRY}")
fi
if [ -n "${APK_MIRROR:-}" ]; then
  BUILD_ARGS+=(--build-arg "APK_MIRROR=${APK_MIRROR}")
fi
if [ -n "${BASE_IMAGE:-}" ]; then
  BUILD_ARGS+=(--build-arg "BASE_IMAGE=${BASE_IMAGE}")
fi
"$ENGINE_CMD" "${ENGINE_ARGS[@]}" build \
  "${BUILD_ARGS[@]}" \
  -t "$IMAGE_NAME" \
  -f "$DEPLOY_DIR/deploy/Dockerfile" \
  "$DEPLOY_DIR/source"

# Stop existing container if any
echo "=== Stopping old container ==="
"$ENGINE_CMD" "${ENGINE_ARGS[@]}" rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Validate .env file is not UTF-16 (PowerShell redirect produces UTF-16 LE)
if [ -f "$DEPLOY_DIR/.env" ]; then
  if grep -qPml '\x00' "$DEPLOY_DIR/.env" 2>/dev/null || file "$DEPLOY_DIR/.env" 2>/dev/null | grep -qi "UTF-16"; then
    echo "ERROR: $DEPLOY_DIR/.env appears to be UTF-16 encoded. Convert to ASCII/UTF-8 first:"
    echo "  iconv -f UTF-16LE -t UTF-8 .env > .env.tmp && mv .env.tmp .env"
    exit 1
  fi
fi

# Run new container
# Rewrite proxy vars: replace any proxy host with host.containers.internal
# so the container can reach the host proxy through Podman's DNS resolution.
# Matches any host (IP or hostname) between :// and :port in proxy URLs.
PROXY_ENV_ARGS=()
for _pe in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY; do
  _pv="$(grep -oP "^${_pe}=\K.*" "$DEPLOY_DIR/.env" 2>/dev/null || true)"
  if [ -n "$_pv" ]; then
    _pv="$(echo "$_pv" | sed -E 's#://[^:/]+(:[0-9]+)?#://host.containers.internal\1#g')"
    PROXY_ENV_ARGS+=(-e "${_pe}=${_pv}")
  fi
done

echo "=== Starting AICR container ==="
"$ENGINE_CMD" "${ENGINE_ARGS[@]}" run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  -v "$DEPLOY_DIR/config.yaml:/app/config.yaml:ro" \
  -v "$DEPLOY_DIR/data/workspaces:/app/workspaces" \
  -v "$DEPLOY_DIR/data/db:/app/data" \
  -v "$DEPLOY_DIR/data/logs:/app/logs" \
  "${P4_MOUNT_ARGS[@]}" \
  "${SANDBOX_MOUNT_ARGS[@]}" \
  -e AICR_LOG_DIR=/app/logs \
  -e AICR_LOG_FILE=aicr.log \
  -e AICR_LOG_MAX_AGE_DAYS=7 \
  -e AICR_LOG_MAX_FILES=3 \
  -e AICR_LOG_MAX_SIZE_BYTES=104857600 \
  "${SANDBOX_ENV_ARGS[@]}" \
  "${PROXY_ENV_ARGS[@]}" \
  --env-file "$DEPLOY_DIR/.env" \
  "${USERNS_ARGS[@]}" \
  "$IMAGE_NAME"

echo "=== Waiting for startup ==="
for attempt in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null; then
    break
  fi
  sleep 1
done

P4_PORT="$(sed -n '/name: p4-main/,$p' "$DEPLOY_DIR/config.yaml" | sed -n 's/^[[:space:]]*port:[[:space:]]*["'"'"']\{0,1\}\([^"'"'"']*\)["'"'"']\{0,1\}.*/\1/p' | head -1)"
if [ -n "$P4_PORT" ] && "$ENGINE_CMD" "${ENGINE_ARGS[@]}" exec "$CONTAINER_NAME" test -x /usr/bin/p4 >/dev/null 2>&1; then
  "$ENGINE_CMD" "${ENGINE_ARGS[@]}" exec "$CONTAINER_NAME" p4 -p "$P4_PORT" trust -y >/dev/null 2>&1 || true
fi

# Check health
echo "=== Health check ==="
curl -sf "http://127.0.0.1:${HOST_PORT}/healthz" && echo " - OK" || echo " - FAILED"

echo "=== Done ==="
"$ENGINE_CMD" "${ENGINE_ARGS[@]}" ps --filter name="$CONTAINER_NAME"
