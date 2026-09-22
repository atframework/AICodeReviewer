#!/bin/sh
# Only inside the pinned Debian fixture; preserve its suites and Debian signing key.
set -eu
export DEBIAN_FRONTEND=noninteractive
sources=/etc/apt/sources.list.d/debian.sources
sed -i 's|http://deb.debian.org/debian|http://mirrors.ustc.edu.cn/debian|g' "$sources"
# The slim image has no CA bundle. APT still verifies Debian signatures during bootstrap.
if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates
fi
sed -i 's|http://mirrors.ustc.edu.cn/debian|https://mirrors.ustc.edu.cn/debian|g' "$sources"
apt-get update -qq
