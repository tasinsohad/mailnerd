# SMTP Mailbox Provisioning System

Automated SMTP mailbox provisioning with support for multiple VPS providers (Contabo auto-provisioning + any SSH-accessible VPS), Cloudflare DNS, and Mailcow Dockerized mail servers.

## Architecture

```
User → API (Next.js/Vercel) → Inngest Step Functions
                                  ├── Contabo API (auto VPS provisioning)
                                  ├── Cloudflare API (DNS)
                                  ├── SSH (Mailcow deployment, Postfix config)
                                  └── Mailcow REST API (domains, mailboxes)
                                  ↓
                             Supabase (PostgreSQL)
```

### Key Design Decisions

- **1 VPS = 1 IP slot** — Contabo provides 1 primary IPv4 per VPS. Multiple subdomains on the same VPS share the IP via Postfix transport maps.
- **Horizontal scaling** — New VPS provisioned only when existing nodes are saturated (`current_domain_count >= max_domains_per_node`).
- **Manual VPS mode** — Register any existing VPS (RackNerd, DartNode, OVHcloud, bare metal) by providing SSH credentials.
- **Async jobs** — Long-running provisioning (10–20+ min for Contabo) handled via Inngest durable step functions.

## Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project
- A [Cloudflare](https://cloudflare.com) zone for your domain
- [Inngest](https://inngest.com) account (free tier works)
- (Optional) Contabo account with API credentials enabled
- At least one VPS server (Contabo, RackNerd, etc.)

## Environment Setup

### 1. Generate Encryption Key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copy the output to `ENCRYPTION_KEY` in `.env`.

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

### 3. Supabase Setup

1. Go to your Supabase project SQL editor
2. Run `supabase/migrations/001_initial.sql` to create all tables

### 4. Cloudflare Setup

Create an API token with **Zone:DNS:Edit** permission for your zone. Get your Zone ID from the Cloudflare dashboard.

### 5. Contabo Setup (Optional)

1. Log in to Contabo Customer Control Panel
2. Create API credentials: **Account → API → OAuth2**
3. Note the Client ID and Client Secret
4. Your account email and password are used for grant_type=password auth

**Important Contabo Notes:**
- Port 25 is open by default — no support ticket needed
- Sending limit: ~25 emails/minute per VPS (~1,500/hr)
- Each VPS gets exactly 1 public IPv4 (no floating IP API)
- Provisioning takes 10–20 minutes

## Manual VPS Registration

Register any existing VPS via the API:

```bash
curl -X POST https://your-app.vercel.app/api/vps/register \
  -H "X-API-Key: your-api-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "ip": "203.0.113.42",
    "sshUsername": "root",
    "sshPrivateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
    "label": "My RackNerd US-East",
    "location": "US-East"
  }'
```

**Port 25 Check:** The system tests port 25 outbound connectivity. If blocked, you're warned but registration proceeds. Some providers (RackNerd, Vultr) block port 25 by default but will unblock it via support ticket.

If the VPS already has Mailcow installed:

```bash
curl -X POST https://your-app.vercel.app/api/vps/register \
  -H "X-API-Key: your-api-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "ip": "203.0.113.42",
    "sshPrivateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
    "mailcowAlreadyInstalled": true,
    "mailcowApiKey": "your-mailcow-api-key"
  }'
```

## Starting a Provisioning Job

```bash
curl -X POST https://your-app.vercel.app/api/provision \
  -H "X-API-Key: your-api-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "rootDomain": "example.com",
    "minSubdomains": 2,
    "maxSubdomains": 4,
    "minInboxes": 3,
    "maxInboxes": 6
  }'
```

Response:
```json
{
  "jobId": "uuid",
  "status": "pending",
  "totalSubdomains": 3,
  "totalMailboxes": 15,
  "estimatedMinutes": 25
}
```

## Polling Job Status

```bash
curl https://your-app.vercel.app/api/provision/{jobId} \
  -H "X-API-Key: your-api-secret"
```

## Local Development

### Install Dependencies

```bash
npm install
```

### Run Locally

```bash
npm run dev
```

This runs:
- `vercel dev` — local Vercel server on port 3000
- `inngest-cli dev` — local Inngest dev server for step functions

### Test Typecheck

```bash
npm run typecheck
```

## API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Health check |
| `/api/provision` | POST | X-API-Key | Start provisioning job |
| `/api/provision/[jobId]` | GET | X-API-Key | Poll job status |
| `/api/vps/register` | POST | X-API-Key | Register manual VPS |
| `/api/vps` | GET | X-API-Key | List VPS nodes |
| `/api/vps/[vpsId]` | DELETE | X-API-Key | Remove VPS node |
| `/api/inngest` | POST/GET | No | Inngest webhook |

## Project Structure

```
src/
├── lib/
│   ├── encryption.ts      # AES-256-GCM encrypt/decrypt
│   ├── planning.ts        # Subdomain + mailbox plan generation
│   ├── ssh.ts             # SSH/SFTP client wrapper
│   ├── contabo.ts         # Contabo REST API client
│   ├── cloudflare.ts      # Cloudflare DNS client
│   ├── mailcow.ts         # Mailcow REST API client
│   └── logger.ts          # Structured JSON logger
├── services/
│   ├── orchestrator.ts    # Inngest step function definitions
│   └── vps-registrar.ts   # Manual VPS registration logic
├── types/
│   └── index.ts           # TypeScript interfaces & error types
└── utils/
    ├── retry.ts           # Exponential backoff with jitter
    └── auth.ts            # X-API-Key middleware

pages/
└── api/
    ├── provision/
    │   ├── index.ts       # POST - start job
    │   └── [jobId].ts     # GET - poll job
    ├── vps/
    │   ├── register.ts    # POST - register VPS
    │   ├── index.ts       # GET - list VPS
    │   └── [vpsId].ts     # DELETE - remove VPS
    ├── inngest.ts         # Inngest webhook handler
    └── health.ts          # Health check
```

## Port 25 Notes by Provider

| Provider | Port 25 Status | Notes |
|----------|---------------|-------|
| **Contabo** | Open by default | ~25 emails/min limit |
| **RackNerd** | Blocked by default | Open via support ticket |
| **DartNode** | Blocked by default | Open via support ticket |
| **Vultr** | Blocked by default | Must enable in account settings |
| **OVHcloud** | Open by default | May have rate limits |
| **AWS EC2** | Blocked by default | Requires AWS Support request |
| **Hetzner** | Open by default | Monitor for abuse |

## Capacity Planning

Each VPS node has `max_domains_per_node` (default 10). When all nodes reach their capacity, new provisioning jobs will fail with:
> "No available VPS capacity. Please register a VPS via POST /api/vps/register or enable Contabo auto-provisioning."

## Security

- All secrets encrypted with AES-256-GCM before DB write
- No plaintext secrets in logs (redacted via `[REDACTED]`)
- API authentication via X-API-Key header
- Supabase RLS with service_role-only access
- SSH credentials never logged or exposed
