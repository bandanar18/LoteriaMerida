#!/usr/bin/env bash
set -euo pipefail
hostname=${1:?Provide the public hostname}
app=/opt/loteria/app
if [ ! -f /etc/loteria.env ]; then
  umask 077
  db_password=$(openssl rand -hex 32)
  jwt_secret=$(openssl rand -hex 48)
  kyc_key=$(openssl rand -hex 32)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE loteria LOGIN PASSWORD '$db_password'" >/dev/null
  sudo -u postgres createdb -O loteria loteria
  cat > /etc/loteria.env <<EOF
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://loteria:$db_password@127.0.0.1:5432/loteria
JWT_SECRET=$jwt_secret
KYC_ENCRYPTION_KEY=$kyc_key
KYC_STORAGE_DIR=/var/lib/loteria/kyc
LOTTERY_SCHEDULER=true
SPORTS_ENABLED=false
SIMULATION_MODE=true
LICENSE_LABEL="Demostracion - solo dinero ficticio"
EOF
  chown root:loteria /etc/loteria.env
  chmod 640 /etc/loteria.env
fi
chown -R loteria:loteria "$app"
# Nginx needs read access to the compiled public web assets only.
chmod 755 /opt/loteria /opt/loteria/app /opt/loteria/app/apps /opt/loteria/app/apps/web
chmod -R a+rX "$app/apps/web/dist"
ln -sfn /etc/loteria.env "$app/apps/api/.env"
cd "$app"
sudo -u loteria npm ci --include=dev --no-audit --no-fund
sudo -u loteria npm run migrate -w @loteria/api
sudo -u loteria npm run seed -w @loteria/api
cp deploy/aws/loteria.service /etc/systemd/system/loteria.service
sed "s/HOSTNAME_PLACEHOLDER/$hostname/g" deploy/aws/nginx.conf > /etc/nginx/sites-available/loteria
ln -sfn /etc/nginx/sites-available/loteria /etc/nginx/sites-enabled/loteria
if [ -L /etc/nginx/sites-enabled/default ]; then unlink /etc/nginx/sites-enabled/default; fi
nginx -t
systemctl daemon-reload
systemctl enable --now loteria
systemctl reload nginx
certbot --nginx -d "$hostname" --non-interactive --agree-tos --register-unsafely-without-email --redirect
systemctl enable --now certbot.timer
