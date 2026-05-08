#!/bin/bash
# =============================================================================
# p4-trigger.sh — Perforce change-commit trigger for AICodeReviewer
# =============================================================================
# Install on the P4 server host (NOT inside the AICR container).
#
# Recommended trigger entry:
#   aicr-review change-commit //depot/main/... "/path/to/p4-trigger.sh %change% %user% %client%"
#
# By default this script does NOT call `p4 describe` from inside the p4d trigger
# process. That avoids first-run SSL trust prompts such as:
#   The authenticity of '127.0.0.1:8666' can't be established ... p4 trust
# AICR will use its own configured P4 connection to fetch changelist details.
# The depot path is also taken from AICR server config by default; set
# AICR_DEPOT_PATH only when one script must override the server-side depot.
#
# If AICR_P4_COLLECT_FILES=1 is explicitly enabled, the script will run `p4`
# with a user selected in this order: AICR_P4USER, trigger %user%, P4USER.
# The p4d trigger process does not inherit the submitter's authenticated P4
# session; pass %user% in the trigger entry or configure AICR_P4USER/P4PASSWD.
# =============================================================================
set -euo pipefail

CHANGE="${1:?Usage: $0 <changelist-number> [user] [client]}"
SUBMIT_USER="${2:-}"
SUBMIT_CLIENT="${3:-}"

AICR_URL="${AICR_URL:-http://localhost:8080}"
AICR_KEY="${AICR_API_KEY:-}"
DEPOT_PATH="${AICR_DEPOT_PATH:-}"
COLLECT_FILES="${AICR_P4_COLLECT_FILES:-0}"
AICR_P4PORT="${AICR_P4PORT:-}"
AICR_P4_AUTO_TRUST="${AICR_P4_AUTO_TRUST:-0}"
LOG_FILE="$(readlink -f "$0")"
LOG_FILE="${LOG_FILE%.sh}.log"
MAX_SIZE=$((20 * 1024 * 1024))

rotate_log_if_needed() {
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -ge "$MAX_SIZE" ]; then
    mv "$LOG_FILE" "${LOG_FILE}.$(date +%Y%m%d%H%M%S)"
  fi
}

log() {
  rotate_log_if_needed
  printf '[%s] %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"
}

json_array_from_lines() {
  if command -v jq >/dev/null 2>&1; then
    jq -R . | jq -s .
  else
    # Keep the trigger non-blocking even if jq is missing on the P4 host.
    log "WARNING: jq is not installed; sending an empty file list."
    printf '[]\n'
    cat >/dev/null
  fi
}

collect_changed_files() {
  if [ "$COLLECT_FILES" != "1" ] && [ "$COLLECT_FILES" != "true" ]; then
    printf '\n'
    return 0
  fi

  if ! command -v p4 >/dev/null 2>&1; then
    log "WARNING: AICR_P4_COLLECT_FILES is enabled, but p4 CLI is not available; sending an empty file list."
    printf '\n'
    return 0
  fi

  local p4_port="${AICR_P4PORT:-${P4PORT:-}}"
  if [ -z "$p4_port" ]; then
    log "WARNING: AICR_P4_COLLECT_FILES is enabled, but AICR_P4PORT/P4PORT is empty; refusing to fall back to 127.0.0.1:8666."
    printf '\n'
    return 0
  fi

  local p4_user="${AICR_P4USER:-}"
  if [ -z "$p4_user" ] && [ -n "$SUBMIT_USER" ]; then
    p4_user="$SUBMIT_USER"
  fi
  if [ -z "$p4_user" ] && [ -n "${P4USER:-}" ] && [ "${P4USER:-}" != "root" ]; then
    p4_user="${P4USER:-}"
  fi
  if [ -z "$p4_user" ]; then
    log "WARNING: AICR_P4_COLLECT_FILES is enabled, but no P4 user is available; pass %user% to the trigger or set AICR_P4USER. Sending an empty file list."
    printf '\n'
    return 0
  fi

  local p4_client="${AICR_P4CLIENT:-}"
  if [ -z "$p4_client" ] && [ -n "$SUBMIT_CLIENT" ]; then
    p4_client="$SUBMIT_CLIENT"
  fi
  if [ -z "$p4_client" ]; then
    p4_client="${P4CLIENT:-}"
  fi

  local p4_passwd="${AICR_P4PASSWD:-${P4PASSWD:-}}"
  if [ -n "$p4_passwd" ]; then
    export P4PASSWD="$p4_passwd"
  fi

  local p4_trust="${AICR_P4TRUST:-${P4TRUST:-$(dirname "$LOG_FILE")/.p4trust-aicr}}"
  export P4TRUST="$p4_trust"

  local p4_args=(-p "$p4_port" -u "$p4_user")
  if [ -n "$p4_client" ]; then p4_args+=(-c "$p4_client"); fi

  if [ "${AICR_P4_AUTO_TRUST:-0}" = "1" ] || [ "${AICR_P4_AUTO_TRUST:-}" = "true" ]; then
    p4 "${p4_args[@]}" trust -y >/dev/null 2>&1 || log "WARNING: p4 trust -y failed for $p4_port"
  fi

  local describe_output
  if ! describe_output="$(p4 "${p4_args[@]}" describe -s "$CHANGE" 2>&1)"; then
    log "WARNING: p4 describe failed for CL $CHANGE as user $p4_user: $describe_output"
    printf '\n'
    return 0
  fi

  if [ -z "$SUBMIT_USER" ]; then
    SUBMIT_USER="$(printf '%s\n' "$describe_output" | sed -n '1s/^Change [^ ]* by \([^@]*\)@.*/\1/p')"
  fi
  if [ -z "$SUBMIT_CLIENT" ]; then
    SUBMIT_CLIENT="$(printf '%s\n' "$describe_output" | sed -n '1s/^Change [^ ]* by [^@]*@\([^ ]*\).*/\1/p')"
  fi

  printf '%s\n' "$describe_output" | grep '^\.\.\.' | awk '{print $2}' | sed 's/#.*$//' || true
}

if [ -z "$AICR_KEY" ]; then
  log "WARNING: AICR_API_KEY is not set. Request may be rejected if server.auth is enabled."
fi

FILES="$(collect_changed_files)"
FILES_JSON="$(printf '%s\n' "$FILES" | sed '/^$/d' | json_array_from_lines)"

if command -v jq >/dev/null 2>&1; then
  BODY="$(jq -n \
    --arg ch "$CHANGE" \
    --arg u "$SUBMIT_USER" \
    --arg c "$SUBMIT_CLIENT" \
    --arg dp "$DEPOT_PATH" \
    --argjson f "$FILES_JSON" \
    '{change: $ch, user: $u, client: $c, files: $f} + (if $dp == "" then {} else {depot_path: $dp} end)')"
else
  if [ -n "$DEPOT_PATH" ]; then
    BODY="{\"change\":\"$CHANGE\",\"user\":\"$SUBMIT_USER\",\"client\":\"$SUBMIT_CLIENT\",\"depot_path\":\"$DEPOT_PATH\",\"files\":[]}"
  else
    BODY="{\"change\":\"$CHANGE\",\"user\":\"$SUBMIT_USER\",\"client\":\"$SUBMIT_CLIENT\",\"files\":[]}"
  fi
fi

CURL_ARGS=(-fsS -X POST "${AICR_URL%/}/triggers/p4" -H "Content-Type: application/json")
if [ -n "$AICR_KEY" ]; then
  CURL_ARGS+=(-H "X-API-Key: ${AICR_KEY}")
fi

RESPONSE="$(curl "${CURL_ARGS[@]}" -d "$BODY" 2>&1)" || {
  log "ERROR: curl failed for CL $CHANGE: $RESPONSE"
  # Never block a Perforce submit/commit because the async reviewer is down.
  exit 0
}

log "CL $CHANGE queued for AICR: $RESPONSE"
exit 0
