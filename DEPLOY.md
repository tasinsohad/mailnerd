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
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Your sign-in. The password must be at least 12 characters. Changing it later signs everyone out. |
| `SESSION_SECRET` | Output of `openssl rand -hex 32`. Changing it later signs everyone out. |
| `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Same as your local `.env` |
| `ENCRYPTION_KEY` | Copied from your local `.env`, if it has one. Despite the name, it doesn't protect stored credentials yet (see below). |
| `DOMAIN` | `app.yourdomain.com` |

`REDIS_URL` is ignored here: Docker Compose runs Redis next to the app.

**Stored credentials are plain text.** SSH passwords, Mailcow API keys and admin passwords, and the
Cloudflare API token are saved in the database unencrypted; nothing in the app encrypts them with
`ENCRYPTION_KEY` today. Anyone who can read the database can read them, so:

- Keep `DATABASE_URL` (it contains the database password) and `SUPABASE_SERVICE_ROLE_KEY` secret:
  only in `.env` on this server and on your own machine, never in the repository or a chat.
- Limit who can open the Supabase project, and use two-factor sign-in on those accounts.
- If either leaks, rotate the database password and the service-role key in Supabase, and change
  the SSH passwords on your mail servers.

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

First make sure no server setup is running (**Jobs** page) before rebuilding. Rebuilding restarts
the app, and restarting it mid-setup makes the queue retry that setup from the start, which wipes
and reinstalls Mailcow on that server.

```bash
cd /opt/mailnerd
git pull
docker compose up -d --build
```

### Changing the password

Check the **Jobs** page first, as when updating: this restarts the app. Change `ADMIN_PASSWORD` in
`.env`, then run `docker compose up -d --force-recreate app`. Everyone is signed out. Changing
`SESSION_SECRET` the same way also signs everyone out.

## Accounts

- **The admin** signs in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`. The admin's workspace holds everything
  created before accounts existed (the Nextus data). Changing `ADMIN_PASSWORD` signs the admin out; changing
  `SESSION_SECRET` signs everyone out.
- **Everyone else** signs up at `/signup`. A new account waits until the admin activates it on the **Users** page
  with a plan (7-day trial, 1/3/6 months, 1 year, a custom length, or an end date). When the plan ends the account
  is locked; its data stays and comes back when the plan is extended.
- **Forgotten password:** the admin uses **Reset password** on the Users page and passes on the temporary password.
- **Workspaces are private.** The admin can open any account's workspace from the switcher in the sidebar.
- Before any schema change, back up the database: `npx tsx scripts/backup-db.ts <folder outside the repo>`.
- `DB_POOL_MAX` (default 5) sets how many database connections the app uses.
- **Row Level Security** is on for every table, so Supabase's public anon key can't read them; the app connects as
  the table owner and isn't affected. To undo for one table: `ALTER TABLE public.<name> DISABLE ROW LEVEL SECURITY;`
- **Rolling back to a release before accounts:** that release finds the admin's data by the internal email
  `admin@smtpforge.local`. Before rolling back, run
  `update users set email = 'admin@smtpforge.local' where role = 'admin';` — otherwise it creates a new empty
  account and the Nextus data looks missing.

## Local development

`npm run dev` works as before, and sign-in applies there too: add `ADMIN_EMAIL`, `ADMIN_PASSWORD`
and `SESSION_SECRET` to your local `.env`.
