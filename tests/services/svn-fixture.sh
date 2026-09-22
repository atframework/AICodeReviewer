#!/bin/sh
# Runs only inside the disposable Debian container; no host package changes.
set -eu
export DEBIAN_FRONTEND=noninteractive
sh /fixture/debian-mirror.sh
apt-get install -y --no-install-recommends subversion=1.14.5-3
rm -rf /var/lib/apt/lists/*
mkdir -p /srv/seed/trunk /srv/repos
printf 'first revision\n' >/srv/seed/trunk/content.txt
svnadmin create /srv/repos/repo
svn import -q --username alice -m initial /srv/seed file:///srv/repos/repo
svn checkout -q file:///srv/repos/repo /srv/wc
printf 'second revision\n' >/srv/wc/trunk/content.txt
svn commit -q --username bob -m update /srv/wc
printf '[general]\nanon-access = read\nauth-access = none\n' >/srv/repos/repo/conf/svnserve.conf
chown -R nobody:nogroup /srv/repos
svn --version --quiet
exec runuser -u nobody -- svnserve --daemon --foreground --listen-host 0.0.0.0 --root /srv/repos
