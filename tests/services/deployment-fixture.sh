#!/usr/bin/env bash
# Only inside the owned Debian container. All service data survives container restart in /srv.
set -euo pipefail
umask 077
if [[ ! -f /srv/initialized ]]; then
  export DEBIAN_FRONTEND=noninteractive
  sh /fixture/debian-mirror.sh
  packages=(postgresql-17 redis-server subversion libapache2-mod-svn apache2 openssl curl)
  pinned=()
  for package in "${packages[@]}"; do
    version=$(apt-cache policy "$package" | awk '/Candidate:/ {print $2}')
    [[ -n "$version" && "$version" != '(none)' ]]
    pinned+=("$package=$version")
  done
  # Prevent package postinst from starting an unrelated default cluster/service.
  printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
  chmod 755 /usr/sbin/policy-rc.d
  apt-get install -y --no-install-recommends "${pinned[@]}"
  dpkg-query -W "${packages[@]}" >/srv/package-versions
  rm -rf /var/lib/apt/lists/*
  mkdir -p /srv/tls /srv/pg /srv/redis /srv/svn /srv/seed/trunk
  chmod 755 /srv /srv/tls
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout /srv/tls/server.key -out /srv/tls/ca.crt 2>/dev/null
  chmod 644 /srv/tls/ca.crt
  openssl rand -hex 24 >/srv/password
  password=$(cat /srv/password)
  cp /srv/tls/server.key /srv/pg/server.key
  cp /srv/tls/ca.crt /srv/pg/server.crt
  printf '%s\n' "$password" >/srv/pg/init-password
  chown -R postgres:postgres /srv/pg
  runuser -u postgres -- /usr/lib/postgresql/17/bin/initdb -D /srv/pg/data -U aicr \
    --pwfile=/srv/pg/init-password -A scram-sha-256 --no-locale -E UTF8 >/srv/pg/init.log
  rm /srv/pg/init-password
  cat >>/srv/pg/data/postgresql.conf <<'CONF'
listen_addresses = '*'
ssl = on
ssl_cert_file = '/srv/pg/server.crt'
ssl_key_file = '/srv/pg/server.key'
shared_buffers = '32MB'
max_connections = 30
fsync = on
CONF
  cat >/srv/pg/data/pg_hba.conf <<'CONF'
local all all trust
hostssl all all 0.0.0.0/0 scram-sha-256
hostnossl all all 0.0.0.0/0 reject
CONF
  chown postgres:postgres /srv/pg/data/pg_hba.conf
  cp /srv/tls/server.key /srv/redis/server.key
  cat >/srv/redis/users.acl <<CONF
user default off
user aicr on >$password ~* &* +@all
user reader on >$password ~acceptance:* +get +ping
CONF
  cat >/srv/redis/redis.conf <<'CONF'
port 0
tls-port 6379
bind 0.0.0.0
tls-cert-file /srv/tls/ca.crt
tls-key-file /srv/redis/server.key
tls-ca-cert-file /srv/tls/ca.crt
tls-auth-clients no
aclfile /srv/redis/users.acl
dir /srv/redis
appendonly yes
appendfsync always
save ""
maxmemory 64mb
maxmemory-policy noeviction
CONF
  chown -R redis:redis /srv/redis
  cat >/srv/redis/oom.conf <<CONF
port 6380
bind 0.0.0.0
requirepass $password
save ""
appendonly no
maxmemory 64mb
maxmemory-policy noeviction
CONF
  chown redis:redis /srv/redis/oom.conf
  printf 'first revision\n' >/srv/seed/trunk/content.txt
  svnadmin create /srv/svn/repo
  svn import -q --username alice -m initial /srv/seed file:///srv/svn/repo
  svn checkout -q file:///srv/svn/repo /srv/wc
  printf 'second revision\n' >/srv/wc/trunk/content.txt
  svn commit -q --username bob -m update /srv/wc
  # A hook runs as the actual HTTP service user with a deliberately explicit PATH.
  cat >/srv/svn/repo/hooks/post-commit <<'HOOK'
#!/bin/sh
set -eu
PATH=/usr/bin:/bin
export PATH
svnlook youngest "$1" >"$1/hooks/last-revision"
id -un >"$1/hooks/last-user"
HOOK
  chmod 755 /srv/svn/repo/hooks/post-commit
  htpasswd -iBc /srv/svn/passwd writer <<<"$password" >/dev/null 2>&1
  htpasswd -iB /srv/svn/passwd reader <<<"$password" >/dev/null 2>&1
  cat >/srv/svn/authz <<'CONF'
[repo:/]
writer = rw
reader = r
* =
CONF
  chown -R www-data:www-data /srv/svn
  a2enmod ssl dav_svn authz_svn >/dev/null
  a2dissite 000-default >/dev/null
  printf 'Listen 443\n' >/etc/apache2/ports.conf
  cat >/etc/apache2/sites-available/acceptance.conf <<'CONF'
ServerName localhost
<VirtualHost *:443>
SSLEngine on
SSLCertificateFile /srv/tls/ca.crt
SSLCertificateKeyFile /srv/tls/server.key
<Location /svn>
DAV svn
SVNParentPath /srv/svn
AuthType Basic
AuthName acceptance
AuthUserFile /srv/svn/passwd
AuthzSVNAccessFile /srv/svn/authz
Require valid-user
</Location>
</VirtualHost>
CONF
  a2ensite acceptance >/dev/null
  touch /srv/initialized
fi
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /srv/pg/data -l /srv/pg/server.log -w start
if [[ ! -f /srv/database-created ]]; then
  runuser -u postgres -- createdb -h /var/run/postgresql -U aicr aicr_test
  touch /srv/database-created
fi
runuser -u redis -- redis-server /srv/redis/redis.conf >/srv/redis/server.log 2>&1 &
redis_pid=$!
runuser -u redis -- redis-server /srv/redis/oom.conf >/srv/redis/oom.log 2>&1 &
oom_pid=$!
apache2ctl -DFOREGROUND >/srv/apache.log 2>&1 &
apache_pid=$!
cleanup() {
  apache2ctl -k stop || true
  kill "$redis_pid" "$oom_pid" 2>/dev/null || true
  runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /srv/pg/data -m fast -w stop || true
  wait "$redis_pid" "$oom_pid" "$apache_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
wait -n "$redis_pid" "$oom_pid" "$apache_pid"
