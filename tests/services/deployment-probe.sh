#!/usr/bin/env bash
# No credential values or raw failure responses are printed.
set -euo pipefail
phase=${1:?write or read}
password=$(cat /srv/password)
export PGPASSWORD="$password" PGSSLMODE=verify-full PGSSLROOTCERT=/srv/tls/ca.crt
pg=(psql -X -w -h localhost -U aicr -d aicr_test -v ON_ERROR_STOP=1 -At)
export REDISCLI_AUTH="$password"
redis=(redis-cli --tls --cacert /srv/tls/ca.crt -h localhost --user aicr --no-auth-warning)
reader=(redis-cli --tls --cacert /srv/tls/ca.crt -h localhost --user reader --no-auth-warning)
svnargs=(--non-interactive --no-auth-cache --config-option servers:global:ssl-authority-files=/srv/tls/ca.crt)
repo=https://localhost/svn/repo
if [[ "$phase" == write ]]; then
  [[ $("${pg[@]}" -c 'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()') == t ]]
  if PGSSLMODE=disable "${pg[@]}" -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi
  if PGPASSWORD=wrong "${pg[@]}" -c 'SELECT 1' >/dev/null 2>&1; then exit 1; fi
  "${pg[@]}" -c "CREATE TABLE acceptance (value text); INSERT INTO acceptance VALUES ('durable'); CREATE ROLE reader LOGIN PASSWORD '$password'; GRANT CONNECT ON DATABASE aicr_test TO reader; GRANT USAGE ON SCHEMA public TO reader; GRANT SELECT ON acceptance TO reader;" >/dev/null
  [[ $("${pg[@]}" -U reader -c 'SELECT value FROM acceptance') == durable ]]
  if "${pg[@]}" -U reader -c "INSERT INTO acceptance VALUES ('denied')" >/dev/null 2>&1; then exit 1; fi
  [[ $("${redis[@]}" SET acceptance:durable yes) == OK ]]
  [[ $("${reader[@]}" GET acceptance:durable) == yes ]]
  [[ $("${reader[@]}" SET acceptance:durable no) == *NOPERM* ]]
  [[ $("${reader[@]}" GET forbidden:key) == *NOPERM* ]]
  [[ $(env -u REDISCLI_AUTH redis-cli --tls --cacert /srv/tls/ca.crt PING) == *NOAUTH* ]]
  if timeout 3 redis-cli -h localhost PING >/dev/null 2>&1; then exit 1; fi
  # Untrusted certificates must fail, rather than using --insecure or trust-all.
  if curl -fsS "$repo" >/dev/null 2>&1; then exit 1; fi
  [[ $(curl --cacert /srv/tls/ca.crt -s -o /dev/null -w '%{http_code}' "$repo") == 401 ]]
  svn info "${svnargs[@]}" --username reader --password "$password" "$repo/trunk" >/dev/null
  if svn mkdir "${svnargs[@]}" --username reader --password "$password" -m denied "$repo/denied" >/dev/null 2>&1; then exit 1; fi
  svn mkdir "${svnargs[@]}" --username writer --password "$password" -m persistence "$repo/persisted" >/dev/null
  [[ $(cat /srv/svn/repo/hooks/last-revision) == 3 ]]
  [[ $(cat /srv/svn/repo/hooks/last-user) == www-data ]]
elif [[ "$phase" == read ]]; then
  [[ $("${pg[@]}" -c 'SELECT value FROM acceptance') == durable ]]
  [[ $("${redis[@]}" GET acceptance:durable) == yes ]]
  svn info "${svnargs[@]}" --username reader --password "$password" "$repo/persisted" >/dev/null
  [[ $(cat /srv/svn/repo/hooks/last-revision) == 3 ]]
else
  exit 2
fi
printf 'Deployment acceptance %s passed: PostgreSQL SCRAM/TLS/roles, Redis TLS/ACL/AOF, SVN HTTPS/authz/hook/persistence\n' "$phase"
