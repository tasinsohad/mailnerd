# Cloudflare Redirects (domain / subdomain / job-bulk) — Design

- **Date:** 2026-07-02
- **Status:** Approved design, ready for implementation plan
- **Author:** brainstormed with the team

## Goal

Let users point the HTTP(S) traffic of a sending hostname at a destination URL, so a
domain/subdomain that exists only for mail doesn't serve an empty or suspicious page. Three
surfaces, one mechanism:

1. **Job-level bulk** — select a job, enter **one** destination URL, and every eligible
   hostname (apex + every subdomain) of every domain in the job redirects there.
2. **Domain (apex) level** — set / change / clear the redirect for `example.com` (and, mirrored,
   `www.example.com`).
3. **Subdomain level** — set / change / clear the redirect for a single subdomain
   (e.g. `team.example.com`), independently of the apex.

Each hostname redirects to exactly one destination ("single redirection").

## Behavior (confirmed)

- **301 permanent**, path and query **dropped** — all requests land on the target root.
- Apex redirect auto-mirrors **`www`** to the same target (`www` is not separately editable).
- Source hosts are matched exactly (no `include_subdomains` blanket), so subdomains stay
  independently controllable.

Concretely, per hostname:

```
source_url: <host>/     target_url: <destination>
status_code: 301        preserve_query_string: false
subpath_matching: true  preserve_path_suffix: false   include_subdomains: false
```

## Gating (confirmed)

A redirect can be set/changed for a domain only once that **domain has ≥ 1 created mailbox**
(`createdInboxCount > 0`) — the same rule that already gates CSV export (`canExport`). When a
domain unlocks, its **apex and all its subdomains** become eligible (whole-domain unlock).

- "All its subdomains" for job-bulk = the **distinct `plannedInboxes.subdomainFqdn` with
  ≥ 1 created mailbox** (a stored `password` marks a created mailbox), plus the apex.

## Mechanism: Cloudflare Bulk Redirects (account-level)

Chosen over per-zone Redirect Rules because it centralizes every domain's redirect in one place,
which maps directly to the "bulk add / change" requirement and scales past per-zone rule limits.

Components (created lazily on first use, then reused):

- **One account redirect List** (`kind: "redirect"`, name e.g. `smtp-forge-redirects`). Each
  redirected hostname is one **list item** (`{ redirect: { source_url, target_url, status_code,
  … } }`).
- **One account ruleset** in the `http_request_redirect` phase whose single rule references the
  list via `from_list` (`key: http.request.full_uri`).

Add / change / remove a redirect = create / update / delete the hostname's list item. **List item
writes are asynchronous** on Cloudflare's side (they return an `operation_id`); the code polls the
bulk-operation status endpoint until it completes before marking the row `active`.

> **Implementation-time verification:** the exact request/response JSON for lists, list items,
> bulk-operation polling, and the ruleset entrypoint must be confirmed against the live Cloudflare
> API docs before coding. Keep payloads at the "these flags" altitude until then.

### Do not clobber an existing account ruleset

The `http_request_redirect` phase has **one entrypoint ruleset per account**. Never blind-`PUT` a
fresh ruleset — that wipes any bulk redirects the user configured in the dashboard. Instead:
**GET the live entrypoint, add/update only our rule, PUT it back.** Cache the ruleset id on
`userSecrets` but reconcile against what's live. (Same "don't overwrite what you didn't create"
discipline as `unproxyDns`.)

## Assumptions & preflight (verify before/at build)

- **`cfAccountId` is required** (Bulk Redirects is account-scoped). Many domains already store it;
  the user's `userSecrets.cfAccountId` must be set. Missing → actionable error, no writes.
- **Token scope**: the CF token needs **Account-level Rulesets edit** and **Account Filter Lists
  edit**. Add an explicit capability preflight and fail with a clear message — don't trust a call
  to succeed (cf. the `mailcow-api-returns-200-on-error` lesson).
- **Capacity is not a blocker**: account URL-redirect limits are Free 10,000 / Pro 25,000 /
  Business 50,000 / Enterprise 1,000,000 (per account, highest plan on the account, as of
  2025-02). Worst realistic case here (~100 domains × ~17 hostnames ≈ 1,700 items) fits Free.
- **HTTPS depends on Universal SSL**: redirects fire *after* TLS termination, so
  `https://<host>` only redirects if Cloudflare has an edge cert for it. Universal SSL covers the
  apex and **first-level** subdomains (`team.example.com`) — which is exactly our sending
  subdomains — but **not** deeper labels. Document this; deeper subdomains would cert-error before
  redirecting.

## DNS coexistence

Cloudflare only intercepts **proxied** (orange-cloud) hostnames. Good news: the existing planner
already fits this.

- `generateDnsRecords` (src/lib/planning.ts:104–156) already creates the **apex `@`** and **every
  subdomain** as **proxied** A records → dummy `192.0.2.1`; only `mail` is grey-cloud. So the DNS
  shape redirects need is already the app's convention — there is **no** `@ → serverIP` record to
  reconcile.
- Apex SPF is `v=spf1 ip4:<serverIP> -all` (planning.ts:143) with **no `a` mechanism**, and the A
  records are already the dummy `192.0.2.1` regardless of proxy state, so proxy state does **not**
  affect mail or deliverability. Inbound uses MX (`mail.<domain>`); clients connect to
  `mail.<domain>` (grey-cloud). Mail is untouched.

The one gap: `unproxyDns` (src/server/pipeline.ts:510–517) un-proxies **every** proxied A/CNAME
except `mail.<domain>`, which would grey-out the apex/subdomain A records and stop redirects.

Fix:
- **On set redirect:** ensure the hostname's A record is **proxied** `192.0.2.1` (PATCH to
  `proxied: true`, or create if absent). For an apex redirect also ensure a **proxied `www`** A
  record.
- **Generalize `unproxyDns` step 3** to **skip any hostname that has an active redirect** (apex,
  `www`, and any redirected subdomain), so `mail.<domain>` still gets un-proxied and mail keeps
  flowing while redirected hosts stay orange.
- **On clear redirect:** delete the list item(s) and remove the proxied redirect A record(s) we
  added (restoring prior grey/dummy state).

## Data model

New `redirects` table, keyed by **hostname** (one row per redirected host):

```
redirects
  id            text pk
  userId        text  → users.id
  domainId      text  → domains.id           (parent domain, for scoping / gating)
  hostname      text  unique                 e.g. "example.com" or "team.example.com"
  isApex        boolean                       apex row also owns the www item
  targetUrl     text
  statusCode    integer default 301
  cfListItemId     text                        the Bulk Redirect list item id
  cfWwwListItemId  text  nullable              apex-only: the mirrored www item id
  status        text default 'pending'        'pending' | 'active' | 'error'
  lastError     text  nullable
  createdAt / updatedAt timestamptz
```

`userSecrets` additions (cache the shared account-level objects):

```
cfRedirectListId     text nullable
cfRedirectRulesetId  text nullable
```

Drizzle migration generated via `drizzle-kit`.

## Server code

**`src/server/cloudflare-redirects.ts`** (leaf helper, no server-fn wrappers — usable by pipeline
and server fns):

- `preflightRedirectCapability(secrets)` — verify token scope + `cfAccountId`.
- `ensureRedirectList(secrets, db, userId)` — get-or-create the account list; cache id.
- `ensureRedirectRuleset(secrets, db, userId, listName)` — get entrypoint, ensure our
  `from_list` rule present (append/update, never clobber); cache id.
- `upsertRedirectItem(secrets, source, target, opts)` / `deleteRedirectItem(secrets, itemId)` —
  list-item writes + `pollBulkOperation`.
- `ensureProxiedRedirectDns(secrets, zoneId, host)` / `removeProxiedRedirectDns(...)`.

**`src/server/redirects.ts`** (TanStack `createServerFn`, `requireAuth`, userId-scoped, secrets
stripped from responses):

- `getRedirect({ domainId })` — apex row + subdomain rows + eligible subdomain list.
- `setRedirect({ domainId, hostname, targetUrl })` — gated; apex path also mirrors www.
- `removeRedirect({ hostname })`.
- `setJobRedirect({ batchId, targetUrl })` — apply one target to apex + eligible subdomains of
  every domain in the batch; sequential with progress, like existing batch actions.

Each write validates `targetUrl` (`https?://`, absolute), persists `status`/`lastError` per
hostname (mirroring `dnsRecords` push tracking), and is **idempotent** (re-set updates the existing
item rather than duplicating).

## UI

- **Domain level** — add a "Redirect…" item to `DomainActionsMenu` (3-dot). Opens a small dialog to
  set/change/clear the apex target. Disabled with tooltip "Available once mailboxes are created"
  when `createdInboxCount === 0` (same treatment as Export CSV).
- **Subdomain level** — in the domain detail view (`_app.domains.$id.tsx`), a "Redirects" section
  listing the domain's eligible subdomains (from created mailboxes), each with an inline editable
  target + push status/error, plus the apex row.
- **Job-bulk** — a "Set redirect for all domains…" item in `JobActionsMenu` (job detail). One URL
  input → applies to apex + eligible subdomains across the job with the existing running-progress
  toast; per-hostname results surfaced.

All three show per-hostname `status`/`lastError` so Cloudflare async failures are visible, exactly
like DNS push.

## Edge cases & errors

- Missing `cfAccountId` / insufficient token scope → clear error, **no partial writes**.
- Invalid target URL → rejected client- and server-side.
- Cloudflare async op failure → row `status='error'`, `lastError` set; re-runnable.
- Re-running set on an existing hostname updates in place (idempotent).
- Clearing a redirect removes list item(s) **and** the proxied redirect A record(s) we added.
- `unproxyDns` re-runs (during provisioning/repair) must not disturb hosts with active redirects.

## Testing

- Unit: list-item payload construction (301 / drop-path / www-mirror → correct flags).
- Unit: `unproxyDns` skip logic — apex/www/redirected-subdomain stay proxied when a redirect
  exists; everything else still un-proxied; `mail` always grey.
- Unit: eligibility/gating predicate (whole-domain unlock; job-bulk hostname set = distinct
  `subdomainFqdn` with a created mailbox + apex).
- Cloudflare API mocked throughout.

## Out of scope (YAGNI)

- Per-zone Single Redirect Rules (not used; Bulk Redirects chosen).
- Redirects with preserved path/query, non-301 codes, per-path rules — single target root, 301
  only, for now.
- Redirecting hosts that have no created mailboxes.
- Managing redirects the user created directly in the Cloudflare dashboard (we only own our rule +
  our list items).
```
