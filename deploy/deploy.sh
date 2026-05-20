#!/bin/bash
set -euo pipefail

DEPLOY_DIR="${AICR_DEPLOY_DIR:-/data/disk2/AICodeReviewer}"
IMAGE_NAME="${AICR_IMAGE_NAME:-aicr:latest}"
HOST_PORT="${AICR_HOST_PORT:-8090}"
CONTAINER_PORT="${AICR_CONTAINER_PORT:-8080}"
CONTAINER_NAME="${AICR_CONTAINER_NAME:-aicr}"
SD_FLAG="--storage-driver=overlay"

cd "$DEPLOY_DIR"

# Ensure persistent data directories exist
mkdir -p "$DEPLOY_DIR/data/workspaces" "$DEPLOY_DIR/data/db" "$DEPLOY_DIR/data/logs"
chmod u+rwX,g+rwX,o+rwX "$DEPLOY_DIR/data/workspaces" "$DEPLOY_DIR/data/db" "$DEPLOY_DIR/data/logs"

P4_MOUNT_ARGS=()
if command -v p4 >/dev/null 2>&1; then
  P4_BIN="$(command -v p4)"
  P4_MOUNT_ARGS=(-v "$P4_BIN:/usr/bin/p4:ro" -e P4TRUST=/app/data/p4trust)
fi

# Pre-flight: recover from rootless storage driver corruption (Podman 5.x)
ENGINE_CMD="${AICR_ENGINE:-podman}"
if ! $ENGINE_CMD ps >/dev/null 2>&1; then
  echo "=== Preflight: $ENGINE_CMD migrate with $SD_FLAG ==="
  $ENGINE_CMD $SD_FLAG system migrate
fi

# Build the image
echo "=== Building AICR image ==="
$ENGINE_CMD $SD_FLAG build \
  --build-arg NPM_STRICT_SSL=false \
  -t "$IMAGE_NAME" \
  -f "$DEPLOY_DIR/deploy/Dockerfile" \
  "$DEPLOY_DIR/source"

# Stop existing container if any
echo "=== Stopping old container ==="
$ENGINE_CMD $SD_FLAG rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Run new container
echo "=== Starting AICR container ==="
$ENGINE_CMD $SD_FLAG run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  -v "$DEPLOY_DIR/config.yaml:/app/config.yaml:ro" \
  -v "$DEPLOY_DIR/data/workspaces:/app/workspaces" \
  -v "$DEPLOY_DIR/data/db:/app/data" \
  -v "$DEPLOY_DIR/data/logs:/app/logs" \
  "${P4_MOUNT_ARGS[@]}" \
  -e AICR_LOG_DIR=/app/logs \
  -e AICR_LOG_FILE=aicr.log \
  -e AICR_LOG_MAX_AGE_DAYS=7 \
  -e AICR_LOG_MAX_FILES=3 \
  -e AICR_LOG_MAX_SIZE_BYTES=104857600 \
  --env-file "$DEPLOY_DIR/.env" \
  "$IMAGE_NAME"

echo "=== Waiting for startup ==="
for attempt in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${HOST_PORT}/healthz" >/dev/null; then
    break
  fi
  sleep 1
done

P4_PORT="$(sed -n '/name: p4-main/,$p' "$DEPLOY_DIR/config.yaml" | sed -n 's/^[[:space:]]*port:[[:space:]]*["'"'"']\{0,1\}\([^"'"'"']*\)["'"'"']\{0,1\}.*/\1/p' | head -1)"
if [ -n "$P4_PORT" ] && $ENGINE_CMD exec "$CONTAINER_NAME" test -x /usr/bin/p4 >/dev/null 2>&1; then
  $ENGINE_CMD exec "$CONTAINER_NAME" p4 -p "$P4_PORT" trust -y >/dev/null 2>&1 || true
fi

# Check health
echo "=== Health check ==="
curl -sf "http://127.0.0.1:${HOST_PORT}/healthz" && echo " - OK" || echo " - FAILED"

echo "=== Done ==="
$ENGINE_CMD ps --filter name="$CONTAINER_NAME"
