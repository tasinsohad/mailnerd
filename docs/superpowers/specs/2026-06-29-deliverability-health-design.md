# Design: Deliverability Health Dashboard

**Date:** 2026-06-29
**Status:** Approved

## Problem
Operators need to know whether their domains/mailboxes can actually deliver mail — DNS auth, IP reputation, TLS, PTR, Mailcow/mailbox state — and what to do when something's wrong. Today there's no single health view; issues only surface when delivery fails.

## Goals
- Per-**domain**, per-**job**, and **overall** health views.
- Indicators: A/mail-host, Cloudflare-proxy, MX, SPF, DKIM, DMARC, PTR/rDNS, blacklist (spam/IP reputation), TLS cert, Mailcow containers + mailbox active count.
- **On-demand** scanning (run when viewing / on "Re-check"; results cached/persisted). Not auto-on-startup.
- Every failing indicator carries a concrete remediation; where a fix maps to an existing action (Push DNS, Sync DKIM, Fix DNS, Recreate), surface a one-click button.

## Non-goals
- Auto-scan on dev-server start (chosen on-demand instead).
- Sending real probe emails / mail-tester scoring (future).

## Architecture
- **`src/server/health.ts`** — pure-ish engine. `checkDomainHealth(domain): Promise<DomainHealth>` runs all probes and returns:
  - `indicators: { id, label, status: "ok"|"warn"|"fail"|"skip", detail, fix }[]`
  - `status: "healthy"|"warning"|"critical"|"unknown"` (worst-of), `score` (0–100), `checkedAt`.
  - Probes use `node:dns/promises` (A, MX, TXT for SPF/DKIM/DMARC, reverse for PTR, DNSBL lookups), `node:tls` (cert issuer/expiry), and `mailcowRequest` (containers, get/dkim, get/mailbox/all). Each probe is independently try/caught so one failure never aborts the rest. Blacklist queries a small fixed DNSBL set with short timeouts.
- **Persistence:** add `health jsonb` + `healthCheckedAt timestamp` (nullable) to `domains` (drizzle schema + `npm run db:push`; additive, non-destructive).
- **Server functions (`src/server/health-actions.ts`):**
  - `runDomainHealth({ domainId })` → run + persist + return `DomainHealth`.
  - `runJobHealth({ batchId })` → run each domain in the batch (sequential), persist, return summary.
  - `runAllHealth()` → run every domain, persist, return summary.
  - Reads for rollups come from the persisted `domains.health` (no re-scan).

## UI
- **Domain page:** a "Deliverability health" card — overall status pill + score, each indicator as a row (status dot · label · detail · expandable fix, with a one-click action button when applicable). "Re-check" button + "last checked".
- **Job page / Jobs list:** a compact health summary (N healthy / warning / critical) + "Re-check job".
- **Overview:** a deliverability panel — domain counts by status, most common issues across all domains, "Re-check all". Reads persisted health.

## Remediation map (examples)
- Proxied mail host → "Run Fix DNS (un-proxy)" (button).
- DKIM missing/mismatch → "Run Sync DKIM" (button).
- SPF/DMARC/MX/A missing → "Run Push DNS" (button).
- PTR mismatch → "Set reverse DNS at your VPS provider to mail.<domain>" (manual).
- Blacklisted → "Request delisting at <RBL>; warm up the IP" (manual, link).
- TLS self-signed/expired → "Wait for ACME / ensure port 80 reachable" (manual).
- Containers down / mailboxes missing → "Re-provision / Recreate mailboxes" (button).

## Testing
- Unit: status roll-up (worst-of), DNSBL reverse-IP formatting, SPF/DKIM/DMARC TXT matching, score calc — pure functions in `health.ts`.
- Integration (local): `runDomainHealth` against the live test domains; confirm indicators reflect reality (e.g. biotechqc proxy/PTR flags) and persistence works.

## Constraints
- Do not break existing functionality (additive columns, new modules, new UI sections).
- DNS/RBL/TLS probes are runtime-only (the dev sandbox can't resolve DNS); verify on the user's machine.
