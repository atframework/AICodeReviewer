#!/bin/bash
# =============================================================================
# svn-trigger.sh — Subversion post-commit hook for AICodeReviewer
# =============================================================================
# Install on the SVN server host (NOT inside the AICR container).
#
# Recommended hook entry (in repository hooks/post-commit):
#   /path/to/svn-trigger.sh "$REPOS" "$REV"
#
# The script uses `svnlook` (available in the SVN server environment) to read
# the author, log message and changed paths for the just-committed revision,
# then POSTs a minimal JSON payload to AICR's /triggers/svn endpoint.
# AICR will use its own configured SVN credentials (`repository_url`,
# `username_env`/`password_env`) to run `svn diff --summarize` / `svn cat`
# and perform the review; the hook itself does not need SVN network access.
#
# This script requires `jq` to safely encode JSON from `svnlook` output.
# =============================================================================
set -euo pipefail

REPOS="${1:?Usage: $0 <repository-path> <revision>}"
REV="${2:?Usage: $0 <repository-path> <revision>}"

AICR_URL="${AICR_URL:-http://localhost:8080}"
AICR_KEY="${AICR_API_KEY:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="${SCRIPT_DIR}/svn-trigger.log"
MAX_SIZE=$((20 * 1024 * 1024))

rotate_log_if_needed() {
  if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -ge "$MAX_SIZE" ]; then
    mv "$LOG_FILE" "${LOG_FILE}.$(date +%Y%m%d%H%M%S)"
  fi
}

log() {
  rotate_log_if_needed
  printf '[%s] %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" >> "$LOG_FILE"
}

if ! command -v svnlook >/dev/null 2>&1; then
  log "ERROR: svnlook is not available on this host."
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq is not available on this host; install jq to safely encode SVN metadata as JSON."
  exit 0
fi

AUTHOR="$(svnlook author -r "$REV" "$REPOS" 2>/dev/null || true)"
MESSAGE="$(svnlook log -r "$REV" "$REPOS" 2>/dev/null || true)"
# svnlook changed emits three fixed-width status columns followed by the path.
# Copies/moves may append " (from <source>:<rev>)"; strip that suffix.
CHANGED_FILES="$(svnlook changed -r "$REV" "$REPOS" 2>/dev/null \
  | sed -E 's/^[A-Za-z_ ]+ //; s/ \(from .*//' \
  | sed '/^$/d' \
  || true)"
FILES_JSON="$(printf '%s\n' "$CHANGED_FILES" | jq -R . | jq -s .)"

if [ -z "$AICR_KEY" ]; then
  log "WARNING: AICR_API_KEY is not set. Request may be rejected if server.auth is enabled."
fi

# Build the JSON object with jq so every field is safely encoded. The server-side
# `triggers[].repository_url` selects the SVN repository; the hook only sends
# commit metadata.
BODY="$(jq -n \
  --arg rev "$REV" \
  --arg author "$AUTHOR" \
  --arg message "$MESSAGE" \
  --argjson files "$FILES_JSON" \
  '{revision: $rev, author: $author, message: $message, files: $files}')"

CURL_ARGS=(-fsS -X POST "${AICR_URL%/}/triggers/svn" -H "Content-Type: application/json")
if [ -n "$AICR_KEY" ]; then
  CURL_ARGS+=(-H "X-API-Key: ${AICR_KEY}")
fi

RESPONSE="$(curl "${CURL_ARGS[@]}" -d "$BODY" 2>&1)" || {
  log "ERROR: curl failed for r$REV: $RESPONSE"
  # Never block an SVN commit because the async reviewer is down.
  exit 0
}

log "r$REV queued for AICR: $RESPONSE"
exit 0
