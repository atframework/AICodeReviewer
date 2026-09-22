#!/usr/bin/env bash
# Rootless WSL/Debian deployment acceptance; sequential write/restart/read, no production access.
set -euo pipefail
umask 077
for tool in podman timeout; do command -v "$tool" >/dev/null; done
base="${AICR_ACCEPTANCE_ROOT:-$HOME/workspace/github/atframework}"
mkdir -p "$base" build/logs
base=$(realpath "$base")
work=$(mktemp -d "$base/aicr-deployment.XXXXXXXX")
mkdir -p "$work/build/tmp"
service=$(basename "$work")
volume="$service-data"
image='docker.io/library/debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132'
had_image=false
if podman image exists "$image"; then had_image=true; fi
cleanup() {
  result=$?
  trap - EXIT INT TERM HUP
  if podman container exists "$service"; then
    podman logs "$service" >build/logs/deployment-service.log 2>&1 || true
    podman stats --no-stream "$service" >build/logs/deployment-resources.log 2>&1 || true
    podman rm --force --volumes "$service" >/dev/null || result=1
  fi
  if podman volume exists "$volume"; then podman volume rm "$volume" >/dev/null || result=1; fi
  if podman container exists "$service" || podman volume exists "$volume"; then result=1; fi
  if [[ "$had_image" == false ]] && podman image exists "$image"; then podman image rm "$image" >/dev/null || result=1; fi
  case "$work" in "$base"/aicr-deployment.*) rm -rf -- "$work" ;; *) result=1 ;; esac
  echo "Deployment cleanup finished: $service (exit $result)"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
if [[ "$had_image" == false ]]; then timeout 180 podman pull "$image" >build/logs/deployment-pull.log 2>&1; fi
cp tests/services/deployment-fixture.sh "$work/build/tmp/start.sh"
cp tests/services/debian-mirror.sh "$work/build/tmp/debian-mirror.sh"
cp tests/services/deployment-probe.sh "$work/build/tmp/probe.sh"
podman volume create "$volume" >/dev/null
podman run -d --name "$service" --init --timeout 900 --stop-timeout 20 \
  --label aicr.acceptance=deployment --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128 \
  --publish 127.0.0.1::443 --publish 127.0.0.1::5432 --publish 127.0.0.1::6379 --publish 127.0.0.1::6380 \
  --volume "$volume:/srv" --volume "$work/build/tmp:/fixture:ro" "$image" bash /fixture/start.sh >/dev/null
ready() {
  for ((attempt=0; attempt<600; attempt++)); do
    if podman exec "$service" bash -c 'test -f /srv/database-created && curl --cacert /srv/tls/ca.crt -s -o /dev/null https://localhost/svn/repo && REDISCLI_AUTH=$(cat /srv/password) redis-cli --tls --cacert /srv/tls/ca.crt --user aicr PING | grep -qx PONG' 2>/dev/null; then return; fi
    [[ $(podman inspect "$service" --format '{{.State.Running}}') == true ]] || break
    sleep 1
  done
  echo 'Deployment fixture readiness failed; see build/logs/deployment-service.log' >&2
  return 1
}
ready
podman exec "$service" cat /srv/package-versions >build/logs/deployment-versions.log
podman port "$service" >build/logs/deployment-ports.log
# Assert every publication is loopback-only, then test from the host namespace.
while read -r _ _ endpoint; do
  [[ "$endpoint" == 127.0.0.1:* ]]
  timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/"$1"' _ "${endpoint##*:}"
done <build/logs/deployment-ports.log
podman exec "$service" bash /fixture/probe.sh write
podman stop --time 20 "$service" >/dev/null
podman start "$service" >/dev/null
ready
podman exec "$service" bash /fixture/probe.sh read
echo 'WSL deployment services passed; 1 CPU / 512 MiB shared; 900s container lifetime'
if (($# > 0)); then
  password=$(podman exec "$service" cat /srv/password)
  pg_endpoint=$(podman port "$service" 5432/tcp)
  redis_endpoint=$(podman port "$service" 6379/tcp)
  oom_endpoint=$(podman port "$service" 6380/tcp)
  podman cp "$service:/srv/tls/ca.crt" "$work/build/tmp/ca.crt"
  export NODE_EXTRA_CA_CERTS="$work/build/tmp/ca.crt"
  export AICR_PG_TEST_URL="postgres://aicr:$password@$pg_endpoint/aicr_test?sslmode=verify-full"
  export AICR_REDIS_TEST_URL="rediss://aicr:$password@$redis_endpoint"
  export AICR_REDIS_OOM_TEST_URL="redis://:$password@$oom_endpoint"
  export WSLENV="${WSLENV:+$WSLENV:}NODE_EXTRA_CA_CERTS/p:AICR_PG_TEST_URL:AICR_REDIS_TEST_URL:AICR_REDIS_OOM_TEST_URL"
  "$@"
fi
