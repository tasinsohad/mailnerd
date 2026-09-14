# Deploying to a VPS

The app runs as a long-lived Node server in Docker, behind Caddy (automatic HTTPS), with its own
Redis for the server-setup queue. The database stays on Supabase.

Why not Vercel or another serverless host: server setup is a 20–40 minute SSH job with a live log
stream, and serverless functions are stopped after 5–13 minutes.

## What the VPS needs

|      | Minimum                        | Recommended      |
| ---- | ------------------------------ | ---------------- |
| CPU  | 2 vCPU                         | 2 vCPU           |
| RAM  | 2 GB, plus 2 GB swap           | 4 GB             |
| Disk | 20 GB                          | 40 GB            |
| OS   | Ubuntu 22.04 / 24.04, Debian 12 (x86-64) | Ubuntu 24.04 LTS |

- **RAM:** building the image peaks at about 1.6 GB; the running app idles at about 80 MB, plus
  Redis and Caddy. The build is the tight part, especially during an update while the old version
  keeps running, hence swap on a 2 GB server.
- **Not one of your Mailcow servers.** The setup script frees ports 25, 80 and 443 by stopping
  whatever holds them, which would take this app down.
- **Network:** a public IPv4 address. Inbound: 22 (SSH), 80 and 443. Outbound: 22 to your mail
  servers, 443 (Cloudflare, Supabase, Mailcow APIs, Docker Hub, GitHub) and 6543 (Supabase database
  pooler). This server does not need outbound port 25.
- **A hostname** for the app, such as `app.yourdomain.com`.

## First deploy

### 1. Point a hostname at the VPS

Create an A record: `app.yourdomain.com` → the VPS's IP address. If the domain is on Cloudflare, set
the record to **DNS only** (grey cloud): Cloudflare's proxy can cut the long-running connections that
carry live setup logs.

### 2. Install Docker

```bash
ssh root@YOUR_VPS_IP
curl -fsSL https://get.docker.com | sh

# Firewall (Ubuntu)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443
ufw enable
```

On a 2 GB server, add swap so the image build doesn't run out of memory:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 3. Get the code

```bash
git clone https://github.com/tasinsohad/mailnerd.git /opt/mailnerd
cd /opt/mailnerd
```

For a private repository, GitHub asks for your username and, as the password, a personal access
token (fine-grained, read-only access to this repository's contents).

### 4. Configure

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

| Variable | Value |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Your sign-in. The password must be at least 12 characters. |
| `SESSION_SECRET` | Output of `openssl rand -hex 32` |
| `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Same as your local `.env` |
| `ENCRYPTION_KEY` | **Copied exactly** from your local `.env`. A different key can't decrypt the SSH passwords and API keys already stored. |
| `DOMAIN` | `app.yourdomain.com` |

`REDIS_URL` is ignored here: Docker Compose runs Redis next to the app.

### 5. Start

```bash
docker compose up -d --build
```

The first build takes a few minutes. Then open `https://app.yourdomain.com` and sign in.

Caddy fetches the HTTPS certificate on the first visit. If the site doesn't load, run
`docker compose logs caddy`; the usual causes are DNS not pointing at the server yet, or port 80
being blocked.

## Day to day

| Task | Command |
| --- | --- |
| Follow app logs | `docker compose logs -f app` |
| See what's running | `docker compose ps` |
| Restart the app | `docker compose restart app` |
| Stop everything | `docker compose down` (queue data is kept) |

### Updating

```bash
cd /opt/mailnerd
git pull
docker compose up -d --build
```

Don't update while a server setup is running. Restarting the app interrupts it, and the queue then
runs that setup again from the start, which wipes and reinstalls Mailcow on that server.

### Changing the password

Change `ADMIN_PASSWORD` in `.env`, then run `docker compose up -d --force-recreate app`. Everyone
is signed out.

## Local development

`npm run dev` works as before, and sign-in applies there too: add `ADMIN_EMAIL`, `ADMIN_PASSWORD`
and `SESSION_SECRET` to your local `.env`.
