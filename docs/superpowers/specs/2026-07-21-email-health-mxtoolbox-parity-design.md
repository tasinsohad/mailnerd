# Email Health (mxtoolbox-parity) Design

**Goal:** Bring the deliverability health engine to mxtoolbox `emailhealth`-level coverage across all three surfaces — Domains card, Jobs pipeline, and external-SMTP Troubleshoot — by adding checks to the shared engine (so all three inherit them at once).

**Architecture:** All surfaces run the same `checkServerHealth` (server) / `checkDomainHealth` (domain) engine. New checks are added there; the planner and UI render the new indicators passively. Pure verdict helpers live in `health-checks.ts` and are unit-tested without network/SSH.

## Constraints / vantage point (honest)

We diagnose from **DoH (DNS)** and an **SSH session on the box** — not from an external IP like mxtoolbox. So:
- DNS-based checks (blacklists, MX/SPF/DMARC/NS/SOA) are fully accurate.
- SMTP banner / STARTTLS-on-25 are read over SSH against `localhost:25` — labeled as such.
- A true open-relay test needs an external source IP (serverless outbound :25 is usually blocked, and localhost is in `mynetworks` so it would falsely "relay"). This renders `skip` with a clear reason unless outbound :25 genuinely works.

## Area 1 — Blacklist expansion (tiered)

Replace the 3-entry `DNSBLS` with a curated, tiered constant in `health-net.ts`. Convention: a `127.0.0.x` A-record response = listed. Only lists that follow that convention and are actively maintained (no defunct / pay-to-delist / over-aggressive lists like UCEPROTECT L2/L3, no code-based reputation lists like hostkarma).

- **MAJOR (listed → `fail`):** `zen.spamhaus.org`, `b.barracudacentral.org`, `bl.spamcop.net`
- **SECONDARY (listed → `warn`):** `dnsbl.sorbs.net`, `dnsbl-1.uceprotect.net`, `psbl.surriel.com`, `all.spamrats.com`, `bl.mailspike.net`, `bl.blocklist.de`, `dnsbl.dronebl.org`, `db.wpbl.info`, `ix.dnsbl.manitu.net`, `spam.dnsbl.anonmails.de`, `truncate.gbudb.net`, `rbl.interserver.net`, `ips.backscatterer.org`

Verdict (`blacklistVerdict`, pure): listed on any MAJOR → `fail`; listed only on SECONDARY → `warn`; none → `ok`. Detail: `Listed on N of M: <names>`; guidance lists each hit with a delist link hint. Lookups run in parallel with a per-lookup timeout so ~17 queries don't serialize; a lookup error counts as "not listed" (never a false positive).

## Area 2 — DNS record quality (`checkSendingDns` + new)

- **MX** (`mx` detail expanded): warn if target is an IP literal (should be a hostname), or if the MX host has no A/AAAA record.
- **SPF** (`spf`): parse the single `v=spf1` record; count DNS-lookup mechanisms (`include`, `a`, `mx`, `ptr`, `exists`, `redirect`) → **warn if >10** (SPF permerror); warn on `+all`/`?all`; flag deprecated `ptr`. Fail on >1 SPF record.
- **DMARC** (`dmarc`): parse `p=`; **warn on `p=none`** (monitor-only); ok on `quarantine`/`reject`; note missing `rua`.
- **Nameservers** (new `nameservers`): resolve NS; warn if <2.
- **SOA** (new `soa`): resolve SOA on the apex; skip/ok — presence + serial sanity only (low weight).

New pure helpers in `health-checks.ts`: `spfLookupCount(record)`, `spfVerdict(records)`, `dmarcPolicyVerdict(record)`, `mxTargetVerdict(hosts, aLookups)`.

## Area 3 — SMTP banner + STARTTLS on :25 (SSH session)

In `checkOverSsh` (same session as queue/containers), run a portable bash `/dev/tcp` dialogue to `localhost:25`:
```
exec 3<>/dev/tcp/localhost/25; read banner <&3; printf 'EHLO healthcheck\r\n' >&3; ... read caps; printf 'QUIT\r\n' >&3
```
- New `smtpbanner`: `ok` if the `220` banner advertises a FQDN (not `localhost`/bare IP); warn otherwise.
- New `starttls25`: `ok` if EHLO capabilities include `STARTTLS`; warn/fail otherwise.
- Pure parser `parseSmtpDialogue(raw)` → `{ bannerHost, caps[] }`, unit-tested. If `/dev/tcp` is unavailable or :25 doesn't answer locally, both → `skip` with a reason.

## Area 4 — Open relay + timing (honest)

- **Open relay** (new `openrelay`): only meaningful from an external IP. Default `skip` — "can't test open relay from here (needs an external IP on port 25)". If a future external probe is wired, it does EHLO → `MAIL FROM:<probe@external>` → `RCPT TO:<probe@external-other>` and expects a `5xx` reject (relay refused). Never marks `fail` on a localhost-only test.
- **Timing** (new `smtptiming`): measured over SSH — connect + banner + `QUIT` round-trip to `localhost:25`, reported as **local** responsiveness (info/warn if very slow), explicitly not external latency.

## Types / planner / UI

- New `HealthAction` values: none required — new rows are informational/manual, except SPF/DMARC which already route to `pushDns`. `nameservers`/`soa`/`smtpbanner`/`starttls25`/`openrelay`/`smtptiming`/expanded `blacklist` carry `guidance` only.
- `sortByPriority` + `rollUp` already handle arbitrary indicators. The planner's existing `blacklist`/auth branches are unchanged; new manual rows surface via the existing manual list.
- No new UI components — the health card / job panel / troubleshoot page already render `Indicator[]` generically, including `guidance`.

## Testing

Pure verdict helpers get unit tests in `health-checks` test files: `blacklistVerdict`, `spfVerdict`/`spfLookupCount`, `dmarcPolicyVerdict`, `mxTargetVerdict`, `parseSmtpDialogue`. Network/SSH glue is thin and exercised via a live check.

## Out of scope

External-vantage probing infrastructure (a real outside-IP prober) — deferred; Area 4 is honest-`skip` until/unless that exists.
