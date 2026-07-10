# Design: Reliable Batch Domain Provisioning & Mailbox Creation

**Date:** 2026-06-28
**Status:** Approved (pending spec review)
**Scope:** Backend reliability/scale only. UI redesign is a separate, later spec.

## Problem

A "batch"/"job" contains multiple domains, each on its **own VPS** with its own Mailcow
install. Provisioning one domain takes ~20 min (apt → Docker → multi-GB Mailcow pull →
container start → mailbox creation). Today:

- The queue uses an **in-memory `setTimeout` fallback** (no `REDIS_URL`), which dies on
  restart, can't retry, and has no real concurrency control.
- Batch operations (recreate mailboxes / wipe) **loop sequentially in the browser** — the
  tab must stay open, and one failure can strand the rest.
- Mailbox-creation logic lives in a TanStack **server function** that the worker can't
  reuse, so the worker and the manual buttons run different code paths.

This must scale to **10–50 domains per batch**, creating mailboxes **perfectly**, with
**3 domains provisioning at once** and the rest queued.

## Goals

- Durable, restart-safe job queue with **concurrency = 3** (configurable); rest queued.
- One **idempotent per-domain pipeline** shared by the worker and the manual buttons.
- **Retry each domain 3×** (exponential backoff); on exhaustion mark it `failed` with the
  **actual error** surfaced in the UI; support **manual retry** (re-enqueue).
- **Domain-level live logs** (SSE, as today) + **batch-level status** the job page polls.
- No new infrastructure the user must operate: queue backed by **Upstash Redis** (already
  configured via `REDIS_URL`), worker runs **inside the app process**.

## Non-Goals (separate specs)

- UI redesign.
- Secrets-at-rest encryption; SSH-keys-over-passwords.
- SMTP/IMAP send-probe verification (existing "mailbox exists in Mailcow" verification stays).

## Architecture

```
Job page ──"Start pipeline"──► enqueue 1 BullMQ job per domain  (queue: "domain-pipeline")
                                          │
                          BullMQ worker (concurrency = 3, Upstash Redis)
                                          │  runs steps in order, idempotently
                       ┌──────────────────┴───────────────────┐
                       ▼                                       ▼
                 pipeline.ts step fns                   per-domain progress
        pushDns→provision→ensureMailDomains→            (domains.setupSteps JSON
        createMailboxes→syncDkim→verify                  + status + terminalLogs)
                       │                                       │
            domain-level live logs (SSE                batch page polls status
            channel server-log:<domainId>)             (~3s) for all domains
```

- **Queue backend:** BullMQ on **Upstash Redis** (`REDIS_URL=rediss://…`, TLS). Connection
  verified working (PING/SET/GET). When `REDIS_URL` is absent the app must **fail loudly**
  for batch actions (no silent in-memory degrade), with a clear "configure REDIS_URL" error.
- **Worker:** single worker, `concurrency = process.env.PROVISION_CONCURRENCY ?? 3`. Lives in
  the app process (the existing `globalForWorker` singleton in `queue.ts`).

## Components

### 1. `src/server/pipeline.ts` (new) — the shared, idempotent step module

Each step is a pure-ish function `(ctx) => Promise<void>` that takes `{ db, domain, log }`,
checks live state first, and **skips work already done**. Steps:

| Step | Action | Idempotency check |
|------|--------|-------------------|
| `pushDns` | Push planned DNS records to Cloudflare | skip records already `status:"active"` (current behavior) |
| `provision` | SSH install Docker + Mailcow (current `executeProvisionJob` body) | if Mailcow API already healthy on the host, skip the heavy install |
| `ensureMailDomains` | `add/domain` + `edit/domain` per subdomain | verify via `get/domain/all`; skip existing |
| `createMailboxes` | `add/mailbox` (+`password2`, correct quotas) | verify via `get/mailbox/all`; only create missing; only store passwords for ones created this run |
| `syncDkim` | fetch DKIM, upsert TXT to Cloudflare (quoted) | update existing record by `cfRecordId` |
| `verify` | confirm each mailbox exists in Mailcow | set per-inbox `active`/`failed` |

The existing logic in `setupMailcowDomain` (mailcow.ts) and `executeProvisionJob` (queue.ts)
is **moved/extracted** into these functions. `setupMailcowDomain`, `provisionServer`,
`fetchDkimAndSync`, `pushDnsToCloudflare` server functions become **thin wrappers** that call
the same pipeline functions (so manual per-step buttons and the worker share one code path).

### 2. `src/server/queue.ts` (refactor) — the pipeline job

- Queue renamed/kept as `"domain-pipeline"`; job data `{ domainId, steps?: string[] }`
  (`steps` lets a manual retry run a subset; default = all).
- Worker handler loads the domain, then runs the steps **in order**, updating progress after
  each. Per-step errors throw → BullMQ retries (`attempts: 3`, `backoff: { type:"exponential", delay: 30000 }`).
- On final failure (attempts exhausted): set `domain.status = "failed"` and persist the
  error; BullMQ keeps the failed job for inspection.
- Logs: each step calls `log(msg, status)` → existing `jobEvents.emit(channel, …)` + Redis
  pub/sub → **domain-level SSE** (unchanged). Throttled DB flush (already implemented).

### 3. Enqueue paths

- **Batch:** "Start Provisioning Pipeline" (job page) enqueues one job per domain in the
  batch. Browser does **not** loop; it just enqueues then watches.
- **Single domain / retry:** domain page buttons enqueue a job (optionally a subset of steps).
- Replace the current browser `for (const d of domains) await provisionServer(...)` loops
  (batch recreate / wipe) with **enqueue + poll**.

### 4. Progress & data model

- Reuse `domains.status` (`pending|queued|provisioning|configuring|ready|failed`) and the
  existing `domains.setupSteps` (jsonb) to store `{ currentStep, steps: { dns, provision,
  mailDomains, mailboxes, dkim, verify }, error, updatedAt }`.
- **No new tables.** (Optional: a `lastError` text column on `domains` for convenience;
  otherwise store in `setupSteps.error`.)
- **Batch page** polls `getBatchDetails` (~3 s) and renders a per-domain status row
  (queued / "Step 3/6: pulling images" / ready / failed + error + Retry button).
- **Domain page** keeps live SSE logs.

## Concurrency & rate limits

- Concurrency (3) protects the **app/worker** (N concurrent SSH sessions + log streams), not
  the target servers (separate VPSes). Configurable via `PROVISION_CONCURRENCY`.
- Let's Encrypt: each domain is a distinct registered domain → ~1 cert each; within limits.
  Cert preservation across re-provision (already implemented) prevents re-issue storms.
- Cloudflare API limits (1200 req/5 min) are not a concern at 10–50 domains.
- Upstash note: BullMQ polls Redis continuously; on the free tier a 24/7 dev server can use
  the command quota. Acceptable for intermittent batches; revisit if it bites.

## Failure handling

- `attempts: 3`, exponential backoff (30s, 60s, 120s).
- Transient (SSH drop, apt lock, image-pull timeout) → retried; idempotent steps resume
  without redoing finished work (e.g. skip the 20-min pull if Mailcow is already healthy).
- Permanent (mailbox rejected, DNS auth error) → after 3 attempts, `failed` + stored error.
- Manual **Retry** re-enqueues the domain's pipeline job.

## Testing

- Unit: each pipeline step's idempotency (given live-state stubs, it skips/does the right
  thing); `parseMailcowResult`, quota field mapping, password generator, `cfTxtContent`.
- Integration (local, against the dev Upstash + a test domain): enqueue a single domain job,
  assert it reaches `ready` and `verify` confirms mailboxes; kill the worker mid-run and
  confirm the job resumes on restart (durability).
- Manual: enqueue a batch of 4–5 with `PROVISION_CONCURRENCY=3`; confirm 3 run, others queue,
  and a deliberately-broken domain ends `failed` with its error + works on manual retry.

## Rollout / migration

1. Confirm `REDIS_URL` (done) → BullMQ active.
2. Extract `pipeline.ts`; switch server functions to call it (no behavior change yet).
3. Convert worker to the step-based pipeline job with retries + progress.
4. Switch batch/single enqueue paths; remove browser loops.
5. Add batch polling status UI hooks (minimal; full UI redesign is the next spec).
