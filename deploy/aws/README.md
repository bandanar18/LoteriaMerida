# AWS Lightsail deployment

Deployment created in `us-east-1`:

- Instance: `loteria-merida`, Ubuntu 24.04, bundle `micro_3_0` (1 GB RAM).
- Static IP resource: `loteria-merida-ip` (`54.208.140.254`).
- Temporary URL: `https://54.208.140.254.sslip.io`.
- Web: Nginx serves `apps/web/dist`; `/api/` proxies HTTP and WebSockets to the API.
- API: systemd service `loteria`, Node 22, runs as the unprivileged `loteria` user.
- PostgreSQL: local database `loteria`; no public database port.
- Environment: `/etc/loteria.env`, readable only by root and the application group.
- Uploaded documents: `/var/lib/loteria/kyc`.
- HTTPS: Let's Encrypt through Certbot, with automatic renewal.
- Fresh demonstration database. Administrator `jesusoralis@gmail.com` was created on 2026-11-10 using a privately supplied password; public login was verified. No local credentials or customer data were uploaded.

The temporary hostname uses the external sslip.io DNS service. Replace it with your own domain when available.

Latest update: `9f40be6` from `origin/main`, deployed 2026-11-10 as
`/opt/loteria/releases/20261110T212325Z-9f40be6` (plus the existing local startup and WebSocket fixes).
All 22 migrations were already applied; the demonstration seed was not rerun.
The committed history importer added 187 missing draws. All 231 game/date pairs in the history file are present;
existing draws were preserved and random sample history was not regenerated.
The previous release remains under `/opt/loteria/releases/20261110T205335Z-6e53c31`;
the database, environment and document backup is in `/var/backups/loteria/20261110T212325Z-9f40be6`.
Public HTML/assets, results route, agency bank catalog, API availability and WebSockets were verified.
The administrator identity and password hash matched before and after deployment; the 2 users and 7 tickets were preserved.

## Access and status

The private SSH key remains on the deployment computer at
`%USERPROFILE%\.ssh\loteria-merida-lightsail-rsa` and is not in this repository.
SSH is restricted in the Lightsail firewall to that computer's public IPv4 at deployment time.
If your public IP changes, update the port 22 source restriction in Lightsail.

```powershell
ssh -i "$env:USERPROFILE/.ssh/loteria-merida-lightsail-rsa" ubuntu@54.208.140.254
```

```bash
sudo systemctl status loteria nginx postgresql
sudo journalctl -u loteria -n 80 --no-pager
sudo certbot renew --dry-run
```

## Build and update

Build from the repository root using Node 22:

```bash
npm ci
npm run build -w @loteria/api
npm run build -w @loteria/web
```

Package only the compiled outputs, package manifests/lockfile, API sources/migrations and deployment files.
Exclude local `.env` files, `node_modules` and uploaded documents.
Keep `/etc/loteria.env`, the PostgreSQL data directory and `/var/lib/loteria` intact during updates.
Install Linux dependencies on the server, apply migrations, then restart `loteria`.
Do not rerun the demonstration seed during routine updates: it can reset game configuration.

For updates, upload the release archive and `update.sh` to `/tmp`, then run:

```bash
sudo bash /tmp/update.sh /tmp/RELEASE.tar.gz GIT_REVISION
```

`update.sh` installs dependencies in a separate release directory before stopping the API.
It saves PostgreSQL, environment and document backups under `/var/backups/loteria/`,
applies pending migrations, switches the application directory and checks API readiness.
On an application startup failure it restores the previous code; database migrations are not automatically reversed.
These backups remain on the same server and do not replace off-server backups.
When intentionally deploying the committed demonstration draw history, include `apps/api/data` in the
release archive and append `--import-history` to the update command. The repository importer only inserts
missing draws; it does not overwrite existing results. Routine updates do not regenerate simulated history.

Run `bootstrap.sh` explicitly with `sudo bash` on a fresh Ubuntu server. Lightsail can wrap user data with a POSIX shell, so a Bash script should be launched through a Bash wrapper rather than pasted directly as user data.
Run `install.sh HOSTNAME` only for the initial deployment after extracting the release to `/opt/loteria/app`.

## Data and costs

Database and uploaded documents persist on the instance disk. There is currently no automated off-server backup; create one before relying on this deployment for important data.
The instance base price is USD 7/month; snapshots, excess traffic, domains and other account resources are separate.
AWS confirmed that the active credits cover Amazon Lightsail. Check AWS Billing for current consumption and credit expiry.
Stopping a Lightsail instance does not stop its bundle charges. To end charges, delete the instance after backing up data and release its static IP when no longer attached.
