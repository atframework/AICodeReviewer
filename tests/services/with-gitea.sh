#!/usr/bin/env bash
# Run a command against a disposable local Gitea. Invoke with bash (also in WSL).
set -euo pipefail
umask 077

if (($# == 0)); then
  echo 'Usage: bash tests/services/with-gitea.sh <command> [args...]' >&2
  exit 2
fi
for tool in podman curl node timeout; do command -v "$tool" >/dev/null; done
base="${AICR_ACCEPTANCE_ROOT:-$HOME/workspace/github/atframework}"
mkdir -p "$base" build/logs
base=$(realpath "$base")
work=$(mktemp -d "$base/aicr-acceptance.XXXXXXXX")
mkdir -p "$work/build/tmp/data" "$work/build/tmp/config"
service="$(basename "$work")-gitea"
image='docker.gitea.com/gitea:1.25.4-rootless'
had_image=false
if podman image exists "$image"; then had_image=true; fi

cleanup() {
  result=$?
  trap - EXIT INT TERM HUP
  if podman container exists "$service"; then
    podman logs "$service" >build/logs/gitea-service.log 2>&1 || true
    podman stats --no-stream "$service" >build/logs/gitea-resources.log 2>&1 || true
    podman rm --force --volumes "$service" >/dev/null || result=1
  fi
  if podman container exists "$service"; then
    echo "Cleanup failed: $service remains" >&2
    result=1
  fi
  if [[ "$had_image" == false ]] && podman image exists "$image"; then
    podman image rm "$image" >build/logs/gitea-image-cleanup.log 2>&1 || result=1
  fi
  case "$work" in "$base"/aicr-acceptance.*) rm -rf -- "$work" ;; *) result=1 ;; esac
  echo "Gitea cleanup finished: $service (exit $result)"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

timeout 180 podman pull "$image" >build/logs/gitea-pull.log 2>&1
podman image inspect "$image" --format '{{.Digest}}' >build/logs/gitea-image-digest.log
podman run -d --name "$service" --rm --timeout 900 --stop-timeout 5 \
  --label aicr.acceptance=gitea --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128 \
  --publish 127.0.0.1::3000 \
  --userns keep-id \
  --volume "$work/build/tmp/data:/var/lib/gitea" \
  --volume "$work/build/tmp/config:/etc/gitea" \
  --env GITEA__database__DB_TYPE=sqlite3 --env GITEA__security__INSTALL_LOCK=true \
  --env GITEA__server__DISABLE_SSH=true --env GITEA__service__DISABLE_REGISTRATION=true \
  --env GITEA__actions__ENABLED=false --env GITEA__repository__DISABLE_MIGRATIONS=true \
  --env GITEA__mailer__ENABLED=false --env GITEA__log__LEVEL=Warn \
  "$image" >"$work/build/tmp/container.id"
port=$(podman port "$service" 3000/tcp)
export AICR_GITEA_TEST_URL="http://$port"
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if curl --fail --silent --max-time 2 "$AICR_GITEA_TEST_URL/api/v1/version" >build/logs/gitea-version.json; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Gitea readiness timed out' >&2; exit 1; }
password=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
podman exec "$service" gitea admin user create --username aicr-admin \
  --password "$password" --email aicr-admin@example.invalid --admin --must-change-password=false \
  >"$work/build/tmp/admin.log" 2>&1
unset password
export AICR_GITEA_TEST_TOKEN
AICR_GITEA_TEST_TOKEN=$(podman exec "$service" gitea admin user generate-access-token \
  --username aicr-admin --token-name acceptance --scopes all --raw)
[[ "$AICR_GITEA_TEST_TOKEN" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid token output' >&2; exit 1; }
# Forward only these fixture variables when the command is a Windows executable.
export WSLENV="${WSLENV:+$WSLENV:}AICR_GITEA_TEST_URL:AICR_GITEA_TEST_TOKEN"
echo "Gitea ready: $AICR_GITEA_TEST_URL; 1 CPU / 512 MiB; 900s lifetime"
"$@"
