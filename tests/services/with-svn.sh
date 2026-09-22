#!/usr/bin/env bash
# A small read-only network fixture, consumed with the host's svn client.
set -euo pipefail
umask 077
if (($# == 0)); then
  echo 'Usage: bash tests/services/with-svn.sh <command> [args...]' >&2
  exit 2
fi
for tool in podman timeout; do command -v "$tool" >/dev/null; done
base="${AICR_ACCEPTANCE_ROOT:-$HOME/workspace/github/atframework}"
mkdir -p "$base" build/logs
base=$(realpath "$base")
work=$(mktemp -d "$base/aicr-acceptance.XXXXXXXX")
mkdir -p "$work/build/tmp"
service="$(basename "$work")-svn"
logs_pid=''
image='docker.io/library/debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132'
had_image=false
if podman image exists "$image"; then had_image=true; fi
cleanup() {
  result=$?
  trap - EXIT INT TERM HUP
  if podman container exists "$service"; then
    podman stats --no-stream "$service" >build/logs/svn-resources.log 2>&1 || true
    podman rm --force --volumes "$service" >/dev/null || result=1
  fi
  if [[ -n "$logs_pid" ]]; then
    kill "$logs_pid" 2>/dev/null || true
    wait "$logs_pid" 2>/dev/null || true
  fi
  if podman container exists "$service"; then result=1; fi
  if [[ "$had_image" == false ]] && podman image exists "$image"; then
    podman image rm "$image" >build/logs/svn-image-cleanup.log 2>&1 || result=1
  fi
  case "$work" in "$base"/aicr-acceptance.*) rm -rf -- "$work" ;; *) result=1 ;; esac
  echo "SVN cleanup finished: $service (exit $result)"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
if [[ "$had_image" == false ]]; then
  timeout 180 podman pull "$image" >build/logs/svn-pull.log 2>&1
fi
podman image inspect "$image" --format '{{.Digest}}' >build/logs/svn-image-digest.log
cp tests/services/svn-fixture.sh "$work/build/tmp/start.sh"
podman run -d --name "$service" --rm --timeout 900 --stop-timeout 5 \
  --label aicr.acceptance=svn --cpus 1 --memory 256m --memory-swap 256m --pids-limit 64 \
  --publish 127.0.0.1::3690 --volume "$work/build/tmp/start.sh:/start.sh:ro" \
  "$image" sh /start.sh >"$work/build/tmp/container.id"
podman logs --follow "$service" >build/logs/svn-service.log 2>&1 &
logs_pid=$!
port=$(podman port "$service" 3690/tcp)
export AICR_SVN_TEST_URL="svn://$port/repo/trunk"
ready=false
for ((attempt=0; attempt<120; attempt++)); do
  if podman exec "$service" svn info --non-interactive svn://127.0.0.1/repo/trunk >build/logs/svn-info.log 2>/dev/null; then
    ready=true
    break
  fi
  podman container exists "$service" || break
  sleep 1
done
[[ "$ready" == true ]] || { echo 'SVN readiness failed; see build/logs/svn-service.log' >&2; exit 1; }
export WSLENV="${WSLENV:+$WSLENV:}AICR_SVN_TEST_URL"
echo "SVN ready: $AICR_SVN_TEST_URL; 1 CPU / 256 MiB; 900s lifetime"
"$@"
