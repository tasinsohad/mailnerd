# Bulk External DNS Setup — Design

**Goal:** A Troubleshoot-page tool where the user adds a server (IP + SSH, like the existing external flow) and pastes domains/subdomains; for each, the missing essential mail DNS records (MX / SPF / DKIM / DMARC) are created on Cloudflare automatically. Idempotent — existing records are adopted, never duplicated.

## Flow

1. **Add server** (reuses the Troubleshoot connect fields): IP, SSH user, SSH password, optional Mailcow hostname + API key. If the Mailcow host/key aren't given, fetch them over SSH (`readMailcowConfigOverSsh`) exactly like `troubleshootServer`. The server yields `{ mailHost, serverIp, mailcowApiKey }`.
2. **Paste names**: a textarea, one domain/subdomain per line (apex `example.com` or subdomain `us1.example.com`). Deduped, trimmed, lowercased.
3. **Per name** (streamed to the live console via `runId`):
   - Resolve the Cloudflare zone via `getCfZoneIdByName` walking up labels (subdomain → registrable zone). Not in the user's CF account → result `zone-not-in-cloudflare` (skip).
   - Check which of MX / SPF / DKIM / DMARC already exist via DoH (same predicates as `checkDomainHealth`).
   - For each MISSING record, build the content and create it via `createCfDnsRecordResilient` (idempotent; adopts an existing match).
   - Result row: `{ name, created: string[], present: string[], failed: {type,error}[], zoneMissing?: bool }`.

## Record content (matches `generateDnsRecords`)

For pasted name `N` in zone `Z`, mail host `H` (server FQDN), server IP `IP`:
- **MX**: name `N`, `10 H`
- **SPF**: TXT name `N`, `v=spf1 ip4:IP -all`
- **DMARC**: TXT name `_dmarc.N`, `v=DMARC1; p=quarantine; sp=quarantine; aspf=r; adkim=r` (clean template — no system-specific rua)
- **DKIM**: TXT name `dkim._domainkey.N`, content = Mailcow `get/dkim/N` pubkey. If Mailcow has no key for `N` (domain not in Mailcow), DKIM is reported `skipped (no Mailcow key)` — not an error.

## Architecture / bundle safety

- New **server-only** module `src/server/bulk-dns.ts` exporting ONLY `bulkSetupDns` (a `createServerFn`) → stays a pure, stubbable server-fn module even though it imports ssh / cloudflare / mailcow (the Troubleshoot route imports it statically). Verify with the ssh2 build-grep gate.
- Reuses: `cloudflare.functions.ts` (`getCfZoneIdByName`, `fetchAllCfDnsRecords`, `findMatchingCfRecord`, `createCfDnsRecordResilient`, `isCfAlreadyExistsError`), `mailcow-helpers.ts` (`mailcowRequest`), `mailcow-key.ts` (`readMailcowConfigOverSsh`), `health-net.ts` (`doh`, `txtValue`), `console-bus.ts` (`ConsoleLog`).

## Input schema

```
{ ipAddress, sshUser, sshPassword, mailcowHostname?, mailcowApiKey?, fetchApiKey, names: string[], runId? }
```
Returns `{ mailHost, results: PerNameResult[], transcript }` or `{ error }`.

## UI (Troubleshoot page)

New collapsible section **"Bulk DNS setup"** below the existing troubleshoot form:
- Server block (reuse the existing connection fields, or a compact copy).
- Names textarea + count.
- "Check & create records" button → streams the shared `LiveConsole`, then renders a per-name result list (green created / grey already-present / amber zone-missing / red failed) with the record types per line.

## Out of scope (MVP)

Per-name mapping to *different* servers in one run — one server per run (run again for another server). Non-Cloudflare DNS providers. TLSA/autodiscover/autoconfig extras (only the four deliverability-essential records).
