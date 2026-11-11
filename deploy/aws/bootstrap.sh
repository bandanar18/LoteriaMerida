#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
apt-get update
apt-get install -y nginx postgresql curl ca-certificates xz-utils certbot python3-certbot-nginx
mkdir -p /tmp/loteria-node
cd /tmp/loteria-node
curl -fsSLO https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
archive=$(awk '$2 ~ /linux-x64.tar.xz$/ {print $2}' SHASUMS256.txt)
curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$archive"
grep " $archive$" SHASUMS256.txt | sha256sum -c -
tar -xJf "$archive" -C /usr/local --strip-components=1
id loteria >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/loteria --shell /usr/sbin/nologin loteria
install -d -o loteria -g loteria -m 750 /opt/loteria/app /var/lib/loteria/kyc
systemctl enable --now postgresql nginx
touch /var/lib/loteria/bootstrap-ready
