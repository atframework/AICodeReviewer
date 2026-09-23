#!/usr/bin/env bash
# Run a command against a disposable local GitLab CE. Invoke with bash (also in WSL).
set -euo pipefail
umask 077

if (($# == 0)); then
  echo 'Usage: bash tests/services/with-gitlab.sh <command> [args...]' >&2
  exit 2
fi
for tool in podman curl node timeout; do command -v "$tool" >/dev/null; done
base="${AICR_ACCEPTANCE_ROOT:-$HOME/workspace/github/atframework}"
mkdir -p "$base" build/logs
base=$(realpath "$base")
work=$(mktemp -d "$base/aicr-acceptance.XXXXXXXX")
mkdir -p "$work/build/tmp"
service="$(basename "$work")-gitlab"
volume_data="$service-data"
image='gitlab/gitlab-ce:19.4.0-ce.0'
had_image=false
if podman image exists "$image"; then had_image=true; fi

cleanup() {
  result=$?
  trap - EXIT INT TERM HUP
  if podman container exists "$service"; then
    podman logs "$service" >build/logs/gitlab-service.log 2>&1 || true
    podman stats --no-stream "$service" >build/logs/gitlab-resources.log 2>&1 || true
    # On failure keep webhook delivery evidence (status + internal error)
    # before the disposable container vanishes.
    if ((result != 0)); then
      podman exec -i "$service" gitlab-rails runner - >build/logs/gitlab-webhooks.log 2>&1 <<'RUBY' || true
WebHookLog.order(id: :desc).limit(30).each do |l|
  puts "hook=#{l.web_hook_id} status=#{l.response_status} trigger=#{l.trigger} url=#{l.url} err=#{l.internal_error_message.to_s[0,160]}"
end
RUBY
    fi
    podman rm --force --volumes "$service" >/dev/null || result=1
  fi
  if podman container exists "$service"; then
    echo "Cleanup failed: $service remains" >&2
    result=1
  fi
  if podman volume exists "$volume_data"; then
    podman volume rm "$volume_data" >/dev/null 2>&1 || result=1
  fi
  if [[ "$had_image" == false ]] && podman image exists "$image"; then
    podman image rm "$image" >build/logs/gitlab-image-cleanup.log 2>&1 || result=1
  fi
  case "$work" in "$base"/aicr-acceptance.*) rm -rf -- "$work" ;; *) result=1 ;; esac
  echo "GitLab cleanup finished: $service (exit $result)"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# The image is ~1 GiB; first pull on a slow mirror needs far longer than the
# small fixtures, while an existing image returns immediately.
timeout 2400 podman pull "$image" >build/logs/gitlab-pull.log 2>&1
podman image inspect "$image" --format '{{.Digest}}' >build/logs/gitlab-image-digest.log
# external_url must carry the final published port: GitLab bakes it into API
# responses, webhook targets and clone URLs at reconfigure time.
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
export AICR_GITLAB_TEST_URL="http://127.0.0.1:$port"
# Trimmed single-node config per the official omnibus keys valid on 19.4:
# no Prometheus family/KAS/registry, puma solo mode, small sidekiq and
# shared_buffers. (grafana/mattermost keys were removed from omnibus.)
omnibus_config=$(cat <<EOF
external_url '$AICR_GITLAB_TEST_URL'
puma['worker_processes'] = 0
puma['min_threads'] = 1
puma['max_threads'] = 2
sidekiq['concurrency'] = 5
prometheus_monitoring['enable'] = false
alertmanager['enable'] = false
gitlab_kas['enable'] = false
registry['enable'] = false
letsencrypt['enable'] = false
postgresql['shared_buffers'] = '128MB'
postgresql['max_worker_processes'] = 4
EOF
)
root_password=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')
# Rootless podman keeps the container default userns (NOT keep-id): the image
# owns its internal uid map. Data lives on this round's named volume because
# rootless bind mounts cannot satisfy the omnibus permission checks.
# Omnibus derives the nginx listen port from external_url, so the container
# listens on the same port the host publishes (not 80).
podman run -d --name "$service" --rm --timeout 7200 --stop-timeout 30 \
  --label aicr.acceptance=gitlab --cpus 2 --memory 6g --memory-swap 6g --pids-limit 1024 \
  --hostname gitlab.local --shm-size 256m \
  --add-host host.containers.internal:host-gateway \
  --publish "127.0.0.1:$port:$port" \
  --volume "$volume_data:/var/opt/gitlab" \
  --env GITLAB_ROOT_PASSWORD="$root_password" \
  --env GITLAB_OMNIBUS_CONFIG="$omnibus_config" \
  "$image" >"$work/build/tmp/container.id"
unset root_password omnibus_config
# First boot runs the full omnibus reconfigure; 3-10 minutes is normal. The
# /-/readiness endpoint is gone with prometheus_monitoring disabled, so the
# sign-in page stands in as the full-stack (nginx+workhorse+puma+rails) probe.
ready=false
for ((attempt=0; attempt<150; attempt++)); do
  if curl --fail --silent --max-time 5 --output /dev/null "$AICR_GITLAB_TEST_URL/users/sign_in"; then
    ready=true
    break
  fi
  sleep 5
done
[[ "$ready" == true ]] || { echo 'GitLab readiness timed out' >&2; exit 1; }
# PAT over rails runner: 16+ stores token digests, so set_token must assign the
# raw value. The token travels over stdin only, never over argv or the logs.
export AICR_GITLAB_TEST_TOKEN
AICR_GITLAB_TEST_TOKEN=$(node -e 'process.stdout.write("glpat-"+require("crypto").randomBytes(20).toString("hex"))')
podman exec -i "$service" gitlab-rails runner - >"$work/build/tmp/pat.log" 2>&1 <<EOF
user = User.find_by_username('root')
pat = user.personal_access_tokens.new(scopes: [:api, :read_repository, :write_repository], name: 'acceptance', expires_at: 7.days.from_now)
pat.set_token('$AICR_GITLAB_TEST_TOKEN')
pat.save!
EOF
[[ "$AICR_GITLAB_TEST_TOKEN" =~ ^glpat- ]] || { echo 'Invalid token output' >&2; exit 1; }
# Verify the token against the live API before handing it to the test.
curl --fail --silent --max-time 10 --header "PRIVATE-TOKEN: $AICR_GITLAB_TEST_TOKEN" \
  "$AICR_GITLAB_TEST_URL/api/v4/user" >"$work/build/tmp/user.json"
# Webhook targets live on the host loopback (host.containers.internal); allow
# local requests once here so the value never toggles during the container's
# lifetime. Toggling races the per-process settings cache in sidekiq workers
# and intermittently blocks delivery ("URL is blocked" in web_hook_logs).
curl --fail --silent --max-time 15 --request PUT --header "PRIVATE-TOKEN: $AICR_GITLAB_TEST_TOKEN" \
  --header 'content-type: application/json' \
  --data '{"allow_local_requests_from_web_hooks_and_services":true}' \
  "$AICR_GITLAB_TEST_URL/api/v4/application/settings" >"$work/build/tmp/settings.json"
# Forward only these fixture variables when the command is a Windows executable.
export WSLENV="${WSLENV:+$WSLENV:}AICR_GITLAB_TEST_URL:AICR_GITLAB_TEST_TOKEN"
echo "GitLab ready: $AICR_GITLAB_TEST_URL; 2 CPU / 6 GiB; 7200s lifetime"
"$@"
