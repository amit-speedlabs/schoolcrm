# Self-hosting on your own server

Runs the CRM, its Postgres database and Caddy (which gets a free HTTPS certificate automatically) with Docker Compose.
Tested with Ubuntu 22.04/24.04; any Linux server with Docker works. No demo data is loaded.

**Server size:** 1 vCPU and 1 GB RAM (2 GB is more comfortable), 10 GB disk. Open ports **80** and **443** in the
server's firewall / cloud security group.

## 1. Install Docker (once)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # then log out and back in
```

## 2. Get the code

```bash
git clone https://github.com/amit-speedlabs/schoolcrm.git
cd schoolcrm
```
The repo is private, so GitHub will ask you to sign in; use a personal access token as the password
(GitHub → Settings → Developer settings → Personal access tokens), or set up an SSH deploy key.

## 3. Configure

```bash
cp .env.selfhost.example .env
openssl rand -hex 24          # copy the output into POSTGRES_PASSWORD
nano .env
```
Fill in:
- `POSTGRES_PASSWORD`: the random value above.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`: your first login (created on first start only).
- **With a domain** (recommended): point the domain's DNS **A record** at the server's IP, then set
  `SITE_ADDRESS=crm.yourdomain.in` and `COOKIE_SECURE=true`. Caddy fetches the HTTPS certificate on first start.
- **Without a domain**: leave `SITE_ADDRESS=:80` and `COOKIE_SECURE=false`; the CRM is at `http://<server-ip>`.
  Logins then travel unencrypted, so use this only for a quick trial.

## 4. Start

```bash
docker compose up -d --build
docker compose ps              # app and db should say "healthy"
docker compose logs app        # should end with "GLF CRM listening"
```
Open `https://crm.yourdomain.in` (or `http://<server-ip>`) and sign in. Everything restarts automatically after a reboot.

## Updating to a new version

```bash
git pull
docker compose up -d --build
```
New database migrations are applied on start.

## Backups

The database lives in the Docker volume `pgdata`. Take a daily dump with cron (`crontab -e`):
```
0 2 * * * cd /home/ubuntu/schoolcrm && docker compose exec -T db pg_dump -U glf glf_crm | gzip > /home/ubuntu/backups/glf_crm_$(date +\%F).sql.gz
```
(create `/home/ubuntu/backups` first, adjust the paths, and copy backups off the server regularly).
Restore into an empty database with `gunzip -c file.sql.gz | docker compose exec -T db psql -U glf glf_crm`.

## Google Sheets

Follow [GOOGLE_SETUP.md](GOOGLE_SETUP.md), then put the key in `.env` as base64
(`base64 -w0 key.json` and paste the output into `GOOGLE_SERVICE_ACCOUNT_JSON`) and run `docker compose up -d`.

## Troubleshooting

- Site not reachable: check ports 80/443 are open and, with a domain, that its A record points at this server
  (`docker compose logs caddy` shows certificate errors).
- Can't log in over plain HTTP: make sure `COOKIE_SECURE=false` when `SITE_ADDRESS=:80`.
