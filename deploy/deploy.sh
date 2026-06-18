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

ensure_writable_tree() {
  local path="$1"

  mkdir -p "$path"

  # Bind-mounted files keep host ownership. When the runtime image changes its
  # default UID/GID (for example an older image or an alternate distro base),
  # previously created database, log, or workspace files can become read-only
  # to the new container user even though the top-level directory still exists.
  # Repair the whole tree before starting a new container so restarts and
  # rollouts remain no-downtime.
  chmod u+rwX,g+rwX,o+rwX "$path" 2>/dev/null || true
  if [ "$ENGINE_BASENAME" = "podman" ]; then
    "$ENGINE_CMD" unshare chmod -R u+rwX,g+rwX,o+rwX "$path"
  else
    chmod -R u+rwX,g+rwX,o+rwX "$path"
  fi
}

# Ensure persistent data directories exist
ensure_writable_tree "$DEPLOY_DIR/data/workspaces"
ensure_writable_tree "$DEPLOY_DIR/data/db"
ensure_writable_tree "$DEPLOY_DIR/data/logs"

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
SANDBOX_SECURITY_ARGS=()
USERNS_ARGS=()

DEFAULT_BUILD_PROXY_PORT=3128
BUILD_HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}"
BUILD_HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
BUILD_NO_PROXY="${NO_PROXY:-${no_proxy:-}}"
BUILD_PROXY_SOURCE=""
BUILD_NETWORK_MODE=""
BUILD_PROXY_ENV=()

extract_host_from_endpoint() {
  local endpoint="$1"

  if [[ "$endpoint" == \[*\]:* ]]; then
    endpoint="${endpoint#\[}"
    endpoint="${endpoint%%\]*}"
  else
    endpoint="${endpoint%:*}"
  fi

  printf '%s' "$endpoint"
}

extract_host_from_url() {
  local url="$1"

  url="${url#*://}"
  url="${url%%/*}"

  if [[ "$url" == \[*\]* ]]; then
    url="${url#\[}"
    url="${url%%\]*}"
  else
    url="${url%%:*}"
  fi

  printf '%s' "$url"
}

is_loopback_host() {
  case "$1" in
    127.*|::1|localhost)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

first_listening_tcp_endpoint() {
  local port="$1"
  local endpoint=""

  if command -v ss >/dev/null 2>&1; then
    endpoint="$(ss -H -ltn "( sport = :${port} )" 2>/dev/null | awk 'NR == 1 { print $4 }')"
  elif command -v netstat >/dev/null 2>&1; then
    endpoint="$(netstat -ltn 2>/dev/null | awk -v port=":${port}$" '$4 ~ port { print $4; exit }')"
  fi

  printf '%s' "$endpoint"
}

detect_primary_ipv4() {
  local detected_ip=""

  if command -v ip >/dev/null 2>&1; then
    detected_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  fi

  if [ -z "$detected_ip" ]; then
    detected_ip="$(hostname -I 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+\./) { print $i; exit }}')"
  fi

  printf '%s' "$detected_ip"
}

auto_detect_build_proxy_url() {
  local endpoint=""
  local host_value=""

  endpoint="$(first_listening_tcp_endpoint "$DEFAULT_BUILD_PROXY_PORT")"
  [ -n "$endpoint" ] || return 1

  host_value="$(extract_host_from_endpoint "$endpoint")"
  case "$host_value" in
    ""|"*"|"0.0.0.0"|"::")
      host_value="$(detect_primary_ipv4)"
      ;;
  esac

  if [ -z "$host_value" ]; then
    host_value="127.0.0.1"
  fi

  printf 'http://%s:%s' "$host_value" "$DEFAULT_BUILD_PROXY_PORT"
}

if [ -z "$BUILD_HTTP_PROXY" ] && [ -z "$BUILD_HTTPS_PROXY" ]; then
  AUTO_BUILD_PROXY_URL="$(auto_detect_build_proxy_url || true)"
  if [ -n "$AUTO_BUILD_PROXY_URL" ]; then
    BUILD_HTTP_PROXY="$AUTO_BUILD_PROXY_URL"
    BUILD_HTTPS_PROXY="$AUTO_BUILD_PROXY_URL"
    BUILD_PROXY_SOURCE="auto-detected host port ${DEFAULT_BUILD_PROXY_PORT}"
  fi
fi

if [ -n "$BUILD_HTTP_PROXY" ] && [ -z "$BUILD_HTTPS_PROXY" ]; then
  BUILD_HTTPS_PROXY="$BUILD_HTTP_PROXY"
fi
if [ -n "$BUILD_HTTPS_PROXY" ] && [ -z "$BUILD_HTTP_PROXY" ]; then
  BUILD_HTTP_PROXY="$BUILD_HTTPS_PROXY"
fi

if [ -n "$BUILD_HTTP_PROXY" ]; then
  BUILD_PROXY_ENV+=("HTTP_PROXY=${BUILD_HTTP_PROXY}" "http_proxy=${BUILD_HTTP_PROXY}")
fi
if [ -n "$BUILD_HTTPS_PROXY" ]; then
  BUILD_PROXY_ENV+=("HTTPS_PROXY=${BUILD_HTTPS_PROXY}" "https_proxy=${BUILD_HTTPS_PROXY}")
fi
if [ -n "$BUILD_NO_PROXY" ]; then
  BUILD_PROXY_ENV+=("NO_PROXY=${BUILD_NO_PROXY}" "no_proxy=${BUILD_NO_PROXY}")
fi

if [ -n "$BUILD_HTTP_PROXY" ] && is_loopback_host "$(extract_host_from_url "$BUILD_HTTP_PROXY")"; then
  BUILD_NETWORK_MODE="host"
elif [ -n "$BUILD_HTTPS_PROXY" ] && is_loopback_host "$(extract_host_from_url "$BUILD_HTTPS_PROXY")"; then
  BUILD_NETWORK_MODE="host"
fi

run_with_build_proxy() {
  if [ "${#BUILD_PROXY_ENV[@]}" -gt 0 ]; then
    env "${BUILD_PROXY_ENV[@]}" "$@"
  else
    "$@"
  fi
}

if [ -n "$BUILD_HTTP_PROXY" ] || [ -n "$BUILD_HTTPS_PROXY" ]; then
  if [ -n "$BUILD_PROXY_SOURCE" ]; then
    echo "=== Build/download proxy: enabled (${BUILD_PROXY_SOURCE}) ==="
  else
    echo "=== Build/download proxy: enabled (from environment) ==="
  fi
  if [ -n "$BUILD_NETWORK_MODE" ]; then
    echo "=== Build network mode: ${BUILD_NETWORK_MODE} (loopback proxy detected) ==="
  fi
fi

mkdir -p "$(dirname "$DOCKER_STATIC")"

if [ "$AICR_ENABLE_CONTAINER_SANDBOX" = "true" ]; then
  # Download Docker static binary if not already present
  if [ ! -s "$DOCKER_STATIC" ]; then
    echo "=== Downloading Docker static binary v${DOCKER_VERSION} ==="
    DOCKER_TGZ_URL="${DOCKER_DOWNLOAD_MIRROR}/docker-${DOCKER_VERSION}.tgz"
    if command -v curl >/dev/null 2>&1; then
      run_with_build_proxy curl -fsSL -o /tmp/docker.tgz "$DOCKER_TGZ_URL"
    elif command -v wget >/dev/null 2>&1; then
      run_with_build_proxy wget -qO /tmp/docker.tgz "$DOCKER_TGZ_URL"
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
    SANDBOX_ENV_ARGS=(-e "DOCKER_HOST=unix://$PODMAN_SOCK" -e "CONTAINER_HOST=unix://$PODMAN_SOCK")
    SANDBOX_SECURITY_ARGS=(--security-opt label=disable)
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
if [ -n "$BUILD_NETWORK_MODE" ]; then
  BUILD_ARGS+=("--network=${BUILD_NETWORK_MODE}")
fi
if [ -n "$BUILD_HTTP_PROXY" ] || [ -n "$BUILD_HTTPS_PROXY" ] || [ -n "$BUILD_NO_PROXY" ]; then
  if [ "$ENGINE_BASENAME" = "podman" ]; then
    BUILD_ARGS+=(--http-proxy=true)
  else
    if [ -n "$BUILD_HTTP_PROXY" ]; then
      BUILD_ARGS+=(--build-arg "HTTP_PROXY=${BUILD_HTTP_PROXY}" --build-arg "http_proxy=${BUILD_HTTP_PROXY}")
    fi
    if [ -n "$BUILD_HTTPS_PROXY" ]; then
      BUILD_ARGS+=(--build-arg "HTTPS_PROXY=${BUILD_HTTPS_PROXY}" --build-arg "https_proxy=${BUILD_HTTPS_PROXY}")
    fi
    if [ -n "$BUILD_NO_PROXY" ]; then
      BUILD_ARGS+=(--build-arg "NO_PROXY=${BUILD_NO_PROXY}" --build-arg "no_proxy=${BUILD_NO_PROXY}")
    fi
  fi
fi
if [ -n "${NPM_REGISTRY:-}" ]; then
  BUILD_ARGS+=(--build-arg "NPM_REGISTRY=${NPM_REGISTRY}")
fi
if [ -n "${PIP_INDEX_URL:-}" ]; then
  BUILD_ARGS+=(--build-arg "PIP_INDEX_URL=${PIP_INDEX_URL}")
fi
if [ -n "${PIP_TRUSTED_HOST:-}" ]; then
  BUILD_ARGS+=(--build-arg "PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}")
fi
if [ -n "${KUBERNETES_APT_REPO_BASE:-}" ]; then
  BUILD_ARGS+=(--build-arg "KUBERNETES_APT_REPO_BASE=${KUBERNETES_APT_REPO_BASE}")
fi
if [ -n "${KUBERNETES_APT_REPO_VERSION:-}" ]; then
  BUILD_ARGS+=(--build-arg "KUBERNETES_APT_REPO_VERSION=${KUBERNETES_APT_REPO_VERSION}")
fi
if [ -n "${HELM_APT_REPO:-}" ]; then
  BUILD_ARGS+=(--build-arg "HELM_APT_REPO=${HELM_APT_REPO}")
fi
if [ -n "${HELM_APT_KEY_URL:-}" ]; then
  BUILD_ARGS+=(--build-arg "HELM_APT_KEY_URL=${HELM_APT_KEY_URL}")
fi
if [ -n "${YQ_VERSION:-}" ]; then
  BUILD_ARGS+=(--build-arg "YQ_VERSION=${YQ_VERSION}")
fi
if [ -n "${YQ_DOWNLOAD_BASE:-}" ]; then
  BUILD_ARGS+=(--build-arg "YQ_DOWNLOAD_BASE=${YQ_DOWNLOAD_BASE}")
fi
APT_MIRROR_VALUE="${APT_MIRROR:-${APK_MIRROR:-}}"
if [ -n "${APT_MIRROR_VALUE}" ]; then
  BUILD_ARGS+=(--build-arg "APT_MIRROR=${APT_MIRROR_VALUE}")
fi
if [ -n "${BASE_IMAGE:-}" ]; then
  BUILD_ARGS+=(--build-arg "BASE_IMAGE=${BASE_IMAGE}")
fi
if [ -n "${NODE_IMAGE:-}" ]; then
  BUILD_ARGS+=(--build-arg "NODE_IMAGE=${NODE_IMAGE}")
fi
if [ -n "${PERFORCE_APT_DISTRO:-}" ]; then
  BUILD_ARGS+=(--build-arg "PERFORCE_APT_DISTRO=${PERFORCE_APT_DISTRO}")
fi
run_with_build_proxy "$ENGINE_CMD" "${ENGINE_ARGS[@]}" build \
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
  --init \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  -v "$DEPLOY_DIR/config.yaml:/app/config.yaml:ro" \
  -v "$DEPLOY_DIR/data/workspaces:/app/workspaces" \
  -v "$DEPLOY_DIR/data/db:/app/data" \
  -v "$DEPLOY_DIR/data/logs:/app/logs" \
  "${SANDBOX_MOUNT_ARGS[@]}" \
  "${SANDBOX_SECURITY_ARGS[@]}" \
  -e AICR_LOG_DIR=/app/logs \
  -e AICR_LOG_FILE=aicr.log \
  -e AICR_LOG_MAX_AGE_DAYS=7 \
  -e AICR_LOG_MAX_FILES=3 \
  -e AICR_LOG_MAX_SIZE_BYTES=104857600 \
  -e P4TRUST=/app/data/p4trust \
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
