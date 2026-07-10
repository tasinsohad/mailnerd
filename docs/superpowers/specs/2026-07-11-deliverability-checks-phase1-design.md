# Deliverability Checks — Phase 1 (domain + server engine)

**Date:** 2026-07-11
**Status:** Approved (design) — implementing
**Area:** Deliverability health engine, job & domain dashboards

## Scope

Expand the existing deliverability-health engine with the server/IP-level and DNS-auth checks
from the monitoring spec, viewable at **job** and **domain** level. Dashboard-only (no alerting),
SSH into each Mailcow VPS is allowed.

**In scope (new checks):** outbound port 25, submission ports 587/465, Postfix queue
depth/aging/deferral, DKIM key-match, forward-confirmed reverse DNS (FCrDNS). Plus splitting the
IP/VPS checks into a **deduped per-server** engine.

**Deferred to later phases:** historical logging + trends, 6h scheduling, alerting
(Slack/email/webhook), live-send + inbox-placement testing, rich per-server cards, bounce rate.

## Architecture

Today `checkDomainHealth` runs every check per-domain (both IP and DNS). Split into two engines
behind a shared pure-logic module:

- **`checkServerHealth(input)`** — VPS/IP-level indicators, run **once per unique IP** per job run.
  Owns: mail-host DNS, **outbound port 25** (SSH), **submission 587/465** (TLS), **Postfix queue**
  (SSH), **FCrDNS**, IP blacklist, TLS cert, Mailcow containers.
- **`checkDomainHealth(input)`** — DNS-auth per sending subdomain: MX, SPF, **DKIM key-match**,
  DMARC. (The IP-level indicators are removed from here — they move to the server engine.)

`checkServerHealth` and `checkDomainHealth` both return the existing `DomainHealth` shape
(`{status, score, checkedAt, indicators[]}`) so the UI and rollups stay uniform. Indicators gain a
numeric `priority` (see Ordering).

### Server identity & dedup

A job's domains are grouped by `ipAddress` (the server key). For each unique IP we run
`checkServerHealth` once, using one domain on that IP as the SSH/Mailcow representative
(mailcowHostname, sshUser, sshPassword). Result stored keyed by `(userId, ipAddress)`.

### Storage

New table `server_health`:

| column | type | notes |
| --- | --- | --- |
| id | text pk | uuid |
| userId | text → users.id | |
| ipAddress | text | the server key |
| mailcowHostname | text | representative mail host |
| health | jsonb | latest `DomainHealth`-shaped result |
| checkedAt | timestamptz | |

Unique `(userId, ipAddress)`. Domain health stays in `domains.health` (unchanged column).

## The checks

### Server-level (`checkServerHealth`)

- **Outbound port 25** — SSH into the VPS and test a TCP connection to
  `gmail-smtp-in.l.google.com:25` **and** `aspmx.l.google.com:25` via bash `/dev/tcp` with a
  timeout. Command always exits 0 and echoes `OPEN`/`BLOCKED` per host (so `executeCommand` doesn't
  throw). `fail` (CRITICAL) if either is blocked → fix: *"Port 25 blocked by the provider — open a
  support ticket to unblock, or configure a relayhost/smarthost in Mailcow → Configuration →
  Routing."* Highest alert priority.
- **Submission 587/465** — from the app, `tls.connect` to `mailHost:465` (implicit TLS) and a
  STARTTLS probe to `mailHost:587`. `fail` on handshake error / expired cert; `warn` on self-signed.
  Fix: *"Mailbox submission port unreachable — check firewall/ports 587,465 and the TLS cert."*
- **Postfix queue** — SSH `docker exec $(docker ps -qf name=postfix-mailcow) postqueue -p`
  (fallback `postqueue -p`). Pure parser returns `{count, oldestAgeMinutes, deferrals: {timeout,
  rejected, other}}`. `warn` if count > 50 **or** oldest age > 6h; classify the dominant deferral
  reason in the detail. Fix reflects the reason (connection timeout → likely port-25/relay issue;
  remote rejection → reputation/content).
- **FCrDNS** — PTR of the IP → hostname; forward-resolve that hostname (A) and confirm it contains
  the IP. `ok` only when both the PTR exists and it forward-confirms; `fail`/`warn` otherwise. Fix:
  *"Set reverse DNS for `<ip>` to `<mailHost>` in your VPS panel; ensure `<mailHost>` A-records
  back to `<ip>`."*
- **IP blacklist, TLS cert, Mailcow containers, mail-host DNS** — moved verbatim from the current
  `checkDomainHealth`.

### Domain-level (`checkDomainHealth`)

- **DKIM key-match** — for each sending subdomain, read the DNS `p=` value at
  `dkim._domainkey.<label>.<domain>` (or `dkim._domainkey.<domain>` for the apex) and compare it to
  Mailcow's signing key from `get/dkim/<domain>` (`pubkey`). `ok` when present **and** matching;
  `fail` when missing; `warn` when a key is published but doesn't match Mailcow's current key
  (rotated but not republished). Fix: *"Run Sync DKIM to publish Mailcow's current key."*
  (`action: syncDkim`.)
- **MX, SPF, DMARC** — unchanged from today.

## Ordering / priority

Each indicator carries `priority` (lower = more urgent), assigned by check id:

```
port25 = 10, blacklist = 20, ptr/fcrdns = 30, mx/spf/dkim/dmarc = 40,
queue = 50, submission = 55, tls = 60, mailcow/containers = 70, mailboxes = 80
```

`JobIssuesPanel` and `HealthCard` sort failing indicators by `priority` so port-25 blocks and new
blacklistings surface first — matching the spec's alert priority order (alerting itself deferred).

## UI

- **`HealthCard`** (domain detail) — two grouped sections: *Domain (DNS auth)* from the domain's
  own health, and *Server — `<ip>`* from the linked `server_health` row (fetched alongside the
  domain). Existing per-indicator "fix" buttons keep working via `health-fixes`.
- **Job dashboard** — `runJobHealth` checks every domain and every unique server; `JobHealthSummary`
  rolls up domain + server statuses into the existing counts. A compact **per-server status list**
  (IP → green/yellow/red + top issue) is added to the job VIEW so all servers in the job are visible
  at a glance. Rich per-server cards + history remain later phases.

## Data flow

```
runJobHealth(batchId)
  domains = domains in batch
  servers = unique(domains by ipAddress)               // dedup
  for each server: checkServerHealth() → upsert server_health(userId, ip)
  for each domain: checkDomainHealth() → update domains.health
  rollup counts include both domain.health and server_health
```

`runDomainHealth(domainId)` runs the domain's DNS checks and (re)checks its server, upserting both.

## Error handling

- Each indicator is probed independently; one failure never aborts the rest (existing pattern).
- SSH failures (unreachable/auth) degrade the SSH-based indicators to `fail` with a clear detail,
  never throw out of the engine.
- A missing IP or Mailcow creds → the dependent indicators are `skip`.

## Testing

Pure functions in `src/server/health-checks.ts`, unit-tested in `__tests__/health-checks.test.ts`:

- `parsePostfixQueue(output)` — count, oldest age, deferral classification across real
  `postqueue -p` samples (empty queue, active+deferred, connection-timeout vs 550-reject reasons).
- `dkimKeyMatch(dnsTxtValues, mailcowPubkey)` — present+match / present+mismatch / missing,
  tolerant of whitespace and `v=DKIM1;k=rsa;p=` wrappers.
- `classifyPort25(gmailVerdict, aspmxVerdict)` — ok / blocked / partial.
- `fcrdnsVerdict(ip, ptrHosts, forwardIps)` — confirmed / mismatch / missing.
- `sortByPriority(indicators)` — priority ordering.

Network/SSH orchestration stays thin over these pure cores.

## Files

- **New:** `src/server/health-checks.ts` (pure), `src/server/health-server.ts`
  (`checkServerHealth`), `src/server/__tests__/health-checks.test.ts`, a Drizzle migration for
  `server_health`.
- **Modify:** `src/server/health.ts` (trim to domain checks + DKIM-match; keep exported types),
  `src/server/health-actions.ts` (dedup servers, upsert server health, combined rollup, new
  `getServerHealth`/`server_health` reads), `src/lib/db/schema.ts` (`serverHealth` table),
  `src/components/HealthCard.tsx` (server section), `src/components/JobHealthSummary.tsx` + job
  route (per-server list).
- **Reuse:** `SSHManager`, existing DoH/blacklist/TLS helpers, `health-fixes.ts`, `mailcowRequest`.

## Out of scope

History/trends, scheduling, alerting, live-send/placement, bounce rate, dedicated per-server cards
UI — each a later phase.
