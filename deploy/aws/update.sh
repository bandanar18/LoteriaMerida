#!/usr/bin/env bash
set -euo pipefail
umask 027
archive=${1:?Provide release archive}
revision=${2:?Provide revision}
import_history=${3:-false}
[[ "$import_history" = false || "$import_history" = --import-history ]] || { echo 'Invalid history option'; exit 1; }
[[ "$revision" =~ ^[a-f0-9]{7,40}$ ]] || { echo 'Invalid revision'; exit 1; }
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$revision"
release="/opt/loteria/releases/$release_id"
backup="/var/backups/loteria/$release_id"
previous=''
stopped=false

recover() {
  local result=$?
  trap - EXIT
  if [ "$result" -ne 0 ] && [ "$stopped" = true ]; then
    systemctl stop loteria || true
    if [ -n "$previous" ] && [ -d "$previous" ]; then
      ln -sfn "$previous" /opt/loteria/app
    fi
    systemctl start loteria || true
    echo 'Update failed; previous application restarted. Database backup preserved.' >&2
  fi
  exit "$result"
}
trap recover EXIT

install -d -m 755 /opt/loteria/releases
install -d -o loteria -g loteria -m 755 "$release"
tar -xzf "$archive" -C "$release"
chown -R loteria:loteria "$release"
chmod 755 "$release/apps" "$release/apps/web"
chmod -R a+rX "$release/apps/web/dist"
ln -s /etc/loteria.env "$release/apps/api/.env"
cd "$release"
sudo -u loteria npm ci --include=dev --no-audit --no-fund

install -d -m 700 "$backup"
systemctl stop loteria
stopped=true
sudo -u postgres pg_dump -Fc loteria > "$backup/database.dump"
cp -p /etc/loteria.env "$backup/environment"
tar -czf "$backup/documents.tar.gz" -C /var/lib/loteria kyc
sudo -u loteria npm run migrate -w @loteria/api
if [ "$import_history" = --import-history ]; then
  test -f "$release/apps/api/data/historial-sorteos.json"
  sudo -u loteria npm run historial:importar -w @loteria/api
fi

if [ -L /opt/loteria/app ]; then
  previous=$(readlink -f /opt/loteria/app)
else
  previous="/opt/loteria/releases/previous-$release_id"
  mv /opt/loteria/app "$previous"
fi
ln -sfn "$release" /opt/loteria/app
systemctl start loteria
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/v1/platform >/dev/null; then
    stopped=false
    printf 'Published release: %s\nBackup: %s\n' "$release_id" "$backup"
    exit 0
  fi
  sleep 1
done
echo 'API did not become healthy' >&2
exit 1
